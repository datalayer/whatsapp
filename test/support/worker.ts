import { randomBytes } from "node:crypto";

import {
  DEFAULT_QUOTAS,
  HostRefusedError,
  MemoryQuotaStore,
  SecretCipher,
  type AgentClient,
  type ApprovalPresentation,
  type Clock,
  type HostTurnRequest,
  type QuotaLimits,
  type SemanticEvent,
  type TurnStream,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { AsPerson, Person } from "../../src/as-person.js";
import { whatsappShape, type WhatsAppTurn } from "../../src/domain.js";
import {
  MetaError,
  checkLimits,
  type BusinessNumber,
  type MetaPort,
  type Outgoing,
  type TemplateState,
  TOKEN_SCOPES,
  type MetaApp,
  type TokenGrant,
  type GroupCreation,
  type MetaGroup,
  type NumberStanding,
  type OfficialRequest,
  type OfficialStatus,
  type RecipientType,
} from "../../src/meta-port.js";
import { Metrics } from "../../src/observability.js";
import {
  installationData,
  type Installation,
  type WhatsAppStore,
} from "../../src/store.js";
import type { MessageJob } from "../../src/webhook.js";
import { TEMPLATE_NAMES, WindowKeeper } from "../../src/window.js";
import { Worker } from "../../src/worker.js";
import { FakeHosts } from "./hosts.js";
import {
  ALICE,
  APP_SECRET,
  capturingLogger,
  PHONE_NUMBER_ID,
  WABA,
} from "./meta.js";

/** A clock tests move by hand; `sleep` moves it. */
export class FakeClock implements Clock {
  constructor(public at = Date.UTC(2026, 9, 22, 12, 0, 0)) {}
  now(): number {
    return this.at;
  }
  async sleep(milliseconds: number): Promise<void> {
    this.at += milliseconds;
  }
  advance(milliseconds: number): void {
    this.at += milliseconds;
  }
}

export const testCipher = (): SecretCipher =>
  new SecretCipher(randomBytes(32).toString("base64"), 1, "test key");

export const HOST_KEY = "dlhk_test-only-host-key";
export const BUSINESS_TOKEN = "EAAtest-only-business-token";
/** The application's own Meta app's id. */
export const APP_ID = "2000000000000002";
/** The key of a test installation's own webhook address (`/whatsapp/webhook/<key>`), one per number. */
export const webhookKeyOf = (phoneNumberId = PHONE_NUMBER_ID): string =>
  `wk-${phoneNumberId}`.padEnd(24, "0").slice(0, 24);

/** One call Meta's fake saw. */
export type MetaCall = Readonly<{
  method: string;
  token?: string;
  phoneNumberId?: string;
  userId?: string;
  message?: Outgoing;
  /** `group` for a message to a group. */
  recipientType?: RecipientType;
  at: number;
  detail?: unknown;
}>;

/**
 * Meta's Graph API in memory: every call recorded with the fake clock's
 * time, messages checked against WhatsApp's limits, and failures on demand
 * (`failNext`). Ids are made up.
 */
export class FakeMeta implements MetaPort {
  readonly calls: MetaCall[] = [];
  readonly failures: Array<{ method: string; error: Error }> = [];
  numbersOf: BusinessNumber[] = [
    { id: PHONE_NUMBER_ID, verifiedName: "Acme SRL" },
  ];
  templateStatus = "APPROVED";
  #sent = 0;

  constructor(readonly clock: FakeClock) {}

  failNext(method: string, error: Error): void {
    this.failures.push({ error, method });
  }

  #record(call: Omit<MetaCall, "at">): void {
    const failure = this.failures.findIndex(
      (one) => one.method === call.method,
    );
    this.calls.push({ ...call, at: this.clock.now() });
    if (failure >= 0) {
      const [taken] = this.failures.splice(failure, 1);
      if (taken) throw taken.error;
    }
  }

  /** What was sent, by type. */
  sent(type?: Outgoing["type"]): Outgoing[] {
    return this.calls
      .filter((one) => one.method === "send" && one.message)
      .map((one) => one.message as Outgoing)
      .filter((one) => !type || one.type === type);
  }

  /** The words of everything sent, in order. */
  said(): string[] {
    return this.sent().map((one) =>
      one.type === "text"
        ? one.text
        : "body" in one
          ? one.body
          : one.type === "template"
            ? `template:${one.name}`
            : one.type === "document"
              ? `document:${one.filename}`
              : `${one.type}:${one.emoji}`,
    );
  }

  /** What was sent to a group, or to people only. */
  sentTo(recipientType: RecipientType): Outgoing[] {
    return this.calls
      .filter(
        (one) =>
          one.method === "send" &&
          one.message &&
          (one.recipientType ?? "individual") === recipientType,
      )
      .map((one) => one.message as Outgoing);
  }

  async send(
    token: string,
    phoneNumberId: string,
    userId: string,
    message: Outgoing,
    recipientType: RecipientType = "individual",
  ): Promise<string> {
    checkLimits(message, recipientType);
    this.#record({
      message,
      method: "send",
      phoneNumberId,
      token,
      userId,
      ...(recipientType === "group" ? { recipientType } : {}),
    });
    this.#sent += 1;
    return `wamid.sent-${this.#sent}`;
  }

  async markRead(
    token: string,
    phoneNumberId: string,
    wamid: string,
  ): Promise<void> {
    this.#record({ detail: wamid, method: "markRead", phoneNumberId, token });
  }

  async upload(
    token: string,
    phoneNumberId: string,
    file: Readonly<{ bytes: Uint8Array; mimeType: string; filename: string }>,
  ): Promise<string> {
    this.#record({
      detail: {
        filename: file.filename,
        mimeType: file.mimeType,
        text: new TextDecoder().decode(file.bytes),
      },
      method: "upload",
      phoneNumberId,
      token,
    });
    return `media-${this.calls.length}`;
  }

  /** What debug_token says of the app's system user token. */
  tokenGrant: TokenGrant = {
    accounts: [WABA],
    appId: APP_ID,
    scopes: [...TOKEN_SCOPES],
    valid: true,
  };

  async tokenOf(app: MetaApp, token: string): Promise<TokenGrant> {
    this.#record({ detail: app.id, method: "tokenOf", token });
    return this.tokenGrant;
  }

  /** Whether the number is on the Cloud API already. */
  registered = false;

  async onCloudApi(token: string, phoneNumberId: string): Promise<boolean> {
    this.#record({ method: "onCloudApi", phoneNumberId, token });
    return this.registered;
  }

  async numbers(token: string, wabaId: string): Promise<BusinessNumber[]> {
    this.#record({ detail: wabaId, method: "numbers", token });
    return this.numbersOf;
  }

  async subscribe(token: string, wabaId: string): Promise<void> {
    this.#record({ detail: wabaId, method: "subscribe", token });
  }

  async unsubscribe(token: string, wabaId: string): Promise<void> {
    this.#record({ detail: wabaId, method: "unsubscribe", token });
  }

  async register(
    token: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    this.#record({ detail: pin, method: "register", phoneNumberId, token });
  }

  async createTemplate(
    token: string,
    wabaId: string,
    template: { name: string },
  ): Promise<TemplateState> {
    this.#record({ detail: template.name, method: "createTemplate", token });
    void wabaId;
    return { category: "UTILITY", status: this.templateStatus };
  }

  /** The number's Official Business Account, as Meta would answer it. */
  official: OfficialStatus = { status: "NOT_STARTED" };
  standingOf: NumberStanding = {
    businessVerification: "verified",
    nameStatus: "APPROVED",
  };
  readonly officialRequests: OfficialRequest[] = [];
  /** The number's groups at Meta, by id. */
  readonly metaGroups = new Map<string, MetaGroup & { link: string }>();
  /** Whether a creation answers the group's id at once (else only its request). */
  groupIdAtOnce = false;
  #groups = 0;

  async officialStatus(
    token: string,
    phoneNumberId: string,
  ): Promise<OfficialStatus> {
    this.#record({ method: "officialStatus", phoneNumberId, token });
    return this.official;
  }

  async requestOfficial(
    token: string,
    phoneNumberId: string,
    request: OfficialRequest,
  ): Promise<OfficialStatus> {
    this.#record({
      detail: request,
      method: "requestOfficial",
      phoneNumberId,
      token,
    });
    this.officialRequests.push(request);
    this.official = { status: "PENDING" };
    return this.official;
  }

  async standing(
    token: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<NumberStanding> {
    this.#record({ detail: wabaId, method: "standing", phoneNumberId, token });
    return this.standingOf;
  }

  async createGroup(
    token: string,
    phoneNumberId: string,
    subject: string,
  ): Promise<GroupCreation> {
    this.#record({
      detail: subject,
      method: "createGroup",
      phoneNumberId,
      token,
    });
    this.#groups += 1;
    const id = `Y2FwaV9ncm91cDp0ZXN0LWdyb3Vw${this.#groups}`;
    this.metaGroups.set(id, {
      id,
      link: `https://chat.whatsapp.com/TestLink${this.#groups}`,
      subject,
    });
    return this.groupIdAtOnce
      ? { groupId: id, requestId: `request-${this.#groups}` }
      : { requestId: `request-${this.#groups}` };
  }

  async groups(token: string, phoneNumberId: string): Promise<MetaGroup[]> {
    this.#record({ method: "groups", phoneNumberId, token });
    return [...this.metaGroups.values()].map(({ id, subject }) => ({
      id,
      subject,
    }));
  }

  async inviteLink(
    token: string,
    groupId: string,
    reset: boolean,
  ): Promise<string> {
    this.#record({ detail: { groupId, reset }, method: "inviteLink", token });
    const group = this.metaGroups.get(groupId);
    if (!group) throw new MetaError(400, 131041, undefined, "Group unknown");
    if (reset) group.link = `${group.link}r`;
    return group.link;
  }

  async deleteGroup(token: string, groupId: string): Promise<void> {
    this.#record({ detail: groupId, method: "deleteGroup", token });
    this.metaGroups.delete(groupId);
  }
}

/** Meta's refusal of the business token (code 190). */
export const tokenRefused = (): MetaError =>
  new MetaError(401, 190, undefined, "Meta refused");

/** A turn's script: events, and waits that move the clock. */
export type Script = Array<SemanticEvent | { wait: number }>;

/**
 * The agent client: a scripted stream per turn, every request recorded, its
 * provenance and target built by the WhatsApp shape as the real client
 * builds them.
 */
export class FakeAgent implements AgentClient<WhatsAppTurn> {
  readonly started: HostTurnRequest<WhatsAppTurn>[] = [];
  readonly provenances: unknown[] = [];
  readonly stopped: string[] = [];
  script: Script = [{ kind: "text", text: "Hello." }, { kind: "completion" }];
  refuse?: Error;
  /** Called after a turn started and before its stream: a test waits there. */
  onStream?: () => Promise<void>;

  constructor(readonly clock: FakeClock) {}

  async startTurn(request: HostTurnRequest<WhatsAppTurn>): Promise<TurnStream> {
    this.started.push(request);
    if (this.refuse) throw this.refuse;
    const sessionId = request.sessionId ?? whatsappShape.sessionUidOf(request);
    this.provenances.push(whatsappShape.provenanceOf?.(request));
    const script = this.script;
    const clock = this.clock;
    const onStream = this.onStream;
    const stopped = this.stopped;
    const run: { id?: string } = {};
    return {
      run,
      sessionId,
      updates: (async function* () {
        await onStream?.();
        for (const step of script) {
          // A stopped run's stream just ends.
          if (stopped.includes(sessionId)) return;
          if ("wait" in step) {
            clock.advance(step.wait);
            continue;
          }
          run.id = "run-1";
          yield step;
        }
      })(),
    };
  }

  async stopTurn(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }
}

/** A mail approval a host may decide, as ai-agents presents it (presentation v1). */
export function mailPresentation(
  overrides: Partial<ApprovalPresentation> = {},
): ApprovalPresentation {
  return {
    action_class: "send",
    approval_id: "ap-1",
    arguments: {
      body: "We go with option B.",
      subject: "Launch decision",
      to: "release@example.com",
    },
    complete: true,
    created_at: "2026-10-22T11:58:00Z",
    digest: "a".repeat(64),
    expires_at: null,
    fields: [],
    host_may_decide: true,
    owner_uid: "principal-alice",
    reasons: [],
    secret_fields: [],
    session_uid: "whatsapp-0000000000000000000000000000000000000000",
    status: "pending",
    tool_name: "send_email",
    version: 1,
    ...overrides,
  };
}

/**
 * Datalayer as one person: approvals by id (each with its owner's BSUID),
 * decisions taken, sessions' last answers, one-use handoffs. Someone else's
 * approval is refused (404), as Datalayer refuses it.
 */
export class FakeAsPerson implements AsPerson {
  readonly approvals = new Map<
    string,
    { owner: string; presentation: ApprovalPresentation }
  >();
  readonly decisions: Array<{
    approvalId: string;
    approve: boolean;
    digest: string;
    userId: string;
  }> = [];
  readonly answers = new Map<string, string>();
  readonly handoffs: Array<{ kind: string; target: string; userId: string }> =
    [];

  #of(person: Person, approvalId: string) {
    const kept = this.approvals.get(approvalId);
    if (!kept || kept.owner !== person.userId)
      throw new HostRefusedError(404, "not found", "The approval");
    return kept;
  }

  async presentation(
    person: Person,
    approvalId: string,
  ): Promise<ApprovalPresentation> {
    return this.#of(person, approvalId).presentation;
  }

  async decide(
    person: Person,
    approvalId: string,
    decision: Readonly<{ approve: boolean; digest: string }>,
  ): Promise<{ status: string }> {
    const kept = this.#of(person, approvalId);
    if (kept.presentation.digest !== decision.digest)
      throw new HostRefusedError(409, "changed", "The decision");
    const status = decision.approve ? "approved" : "rejected";
    this.decisions.push({ approvalId, ...decision, userId: person.userId });
    kept.presentation = { ...kept.presentation, status };
    return { status };
  }

  async lastAnswer(
    person: Person,
    sessionUid: string,
  ): Promise<string | undefined> {
    void person;
    return this.answers.get(sessionUid);
  }

  async handoff(
    person: Person,
    kind: "session" | "approval",
    target: string,
  ): Promise<string> {
    this.handoffs.push({ kind, target, userId: person.userId });
    return `/hosts/open?code=dlho_one-use-${this.handoffs.length}`;
  }
}

/** A connected number, as the install keeps it. */
export function installation(
  cipher: SecretCipher,
  overrides: Partial<Installation> = {},
): Installation {
  const wabaId = overrides.wabaId ?? WABA;
  const phoneNumberId = overrides.phoneNumberId ?? PHONE_NUMBER_ID;
  return {
    businessName: "Acme SRL",
    businessToken: cipher.encrypt(
      BUSINESS_TOKEN,
      installationData("business-token", wabaId, phoneNumberId),
    ),
    hostKey: cipher.encrypt(
      HOST_KEY,
      installationData("host-key", wabaId, phoneNumberId),
    ),
    hostUid: `host-${phoneNumberId}`,
    organizationUid: "account-1",
    phoneNumberId,
    pin: cipher.encrypt(
      "123456",
      installationData("pin", wabaId, phoneNumberId),
    ),
    privacy: "https://acme.example/privacy",
    state: "active",
    support: "support@acme.example",
    wabaId,
    app: {
      appId: APP_ID,
      appSecret: cipher.encrypt(
        APP_SECRET,
        installationData("app-secret", wabaId, phoneNumberId),
      ),
      webhookKey: webhookKeyOf(phoneNumberId),
    },
    ...overrides,
  };
}

export type Harness = Readonly<{
  clock: FakeClock;
  meta: FakeMeta;
  hosts: FakeHosts;
  agent: FakeAgent;
  asPerson: FakeAsPerson;
  store: WhatsAppStore;
  cipher: SecretCipher;
  quotas: MemoryQuotaStore;
  window: WindowKeeper;
  metrics: Metrics;
  lines: string[];
  worker: Worker;
  /** A message from Alice (or `userId`), as the ingress queued it. */
  job(text?: string, overrides?: Partial<MessageJob>): MessageJob;
  /** The number connected, its templates approved, Alice linked. */
  connect(overrides?: Partial<Installation>): Promise<Installation>;
}>;

export function harness(
  store: WhatsAppStore,
  options: Readonly<{ limits?: QuotaLimits; instance?: string }> = {},
): Harness {
  const clock = new FakeClock();
  const meta = new FakeMeta(clock);
  const hosts = new FakeHosts();
  const agent = new FakeAgent(clock);
  const asPerson = new FakeAsPerson();
  const cipher = testCipher();
  const quotas = new MemoryQuotaStore();
  const { lines, logger } = capturingLogger();
  const metrics = new Metrics(logger);
  const window = new WindowKeeper(store, clock, metrics);
  const worker = new Worker({
    agent,
    asPerson,
    cipher,
    clock,
    hosts,
    ...(options.instance ? { instance: options.instance } : {}),
    limits: options.limits ?? DEFAULT_QUOTAS,
    logger,
    metrics,
    port: meta,
    quotas,
    store,
    webUrl: "https://datalayer.ai",
    window,
  });
  let n = 0;
  return {
    agent,
    asPerson,
    cipher,
    clock,
    connect: async (overrides = {}) => {
      const kept = installation(cipher, overrides);
      await store.saveInstallation(kept);
      for (const name of TEMPLATE_NAMES)
        await window.created(kept.wabaId, name, "APPROVED", "UTILITY");
      hosts.links.add(ALICE);
      return kept;
    },
    hosts,
    job: (text = "What changed this week?", overrides = {}) => {
      n += 1;
      return {
        at: new Date(clock.now()).toISOString(),
        kind: "message",
        phoneNumberId: PHONE_NUMBER_ID,
        profileName: "Alice",
        text,
        type: "text",
        userId: ALICE,
        wabaId: WABA,
        wamid: `wamid.HBgLMTU1NTAwMDEyMzQVAgASGBQ${n}`,
        ...overrides,
      };
    },
    lines,
    meta,
    metrics,
    quotas,
    store,
    window,
    worker,
  };
}
