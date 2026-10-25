import type { EncryptedSecret } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHash } from "node:crypto";

/**
 * What the service keeps, behind one interface: PostgreSQL in production
 * (`postgres-store.ts`), memory in development and tests. Each later piece
 * of the service adds its rows here.
 */

/** What Meta says became of a message the number sent, in order. */
export const MESSAGE_STATUSES = [
  "sent",
  "delivered",
  "read",
  "played",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * A status's rank: a later status replaces an earlier one, never the
 * reverse (Meta sends them out of order and more than once). `failed` ends
 * a message whatever came before.
 */
export const STATUS_RANK: Readonly<Record<MessageStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
  failed: 5,
};

/** One status of one sent message, as the ingress reads it from a webhook. */
export type StatusUpdate = Readonly<{
  wamid: string;
  phoneNumberId: string;
  status: MessageStatus;
  /** When Meta says it happened. */
  at: Date;
  /** Meta's error code, for `failed`. */
  errorCode?: number;
}>;

/**
 * A message id as kept: its SHA-256. Meta's message ids have been seen to
 * embed the sender's or recipient's phone number, so a claim or a status
 * keeps the hash, never the id.
 */
export const wamidHash = (wamid: string): string =>
  createHash("sha256").update(wamid).digest("hex");

/** A sent message's furthest status, found by its id; the id itself is not kept. */
export type StatusRow = Readonly<{
  phoneNumberId: string;
  status: MessageStatus;
  at: Date;
  errorCode?: number;
}>;

/** A 1:1 chat: one person (their BSUID) and one business number. */
export type ChatKey = Readonly<{ phoneNumberId: string; userId: string }>;

/**
 * What the service keeps of a chat: when the person last wrote (the
 * 24-hour window), its session's generation (`start over` and a switch of
 * application open a new one), the application the person chose, and the
 * window's notices. Never a phone number, never a message.
 */
export type Chat = ChatKey &
  Readonly<{
    wabaId: string;
    lastInboundAt: Date;
    generation: number;
    /** The deployment the person chose with `app`; the installation's default otherwise. */
    applicationId?: string;
    /** `stop` with no turn running: no more notices to this person. */
    noticesStopped: boolean;
    /** The last notice sent outside the window. */
    lastNoticeAt?: Date;
    /** The session of the current generation, once a turn started it, and its deployment. */
    sessionUid?: string;
    sessionDeployment?: string;
    /** A session whose last answer is not shown yet: a `turn.completed` delivery shows it. */
    unshownSessionUid?: string;
    /** Whether the disclosure line was said in this chat. */
    disclosed: boolean;
    /** The question the last answer ended on, to answer a pressed option. */
    asking?: Asking;
    /** The turn running in this chat, while its lease holds. */
    turn?: RunningTurn;
  }>;

/** A question a turn ended on: its options, by the session that asked. */
export type Asking = Readonly<{ sessionUid: string; options: string[] }>;

/** The one turn a chat runs at a time: who works it, until when, and its session once started. */
export type RunningTurn = Readonly<{
  owner: string;
  until: Date;
  sessionUid?: string;
  deploymentUid?: string;
  /** Stop was asked (the word or the button). */
  stop: boolean;
}>;

/** A claim on a chat's turn: taken, or held by another owner. */
export type TurnClaim =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; owner: string }>;

export type InstallationState = "active" | "paused" | "removed";

/**
 * A connected business number, bound at Datalayer as
 * `<waba_id>:<phone_number_id>`. Every secret is encrypted, bound to the
 * installation (`installationData`); a removed one keeps no business token,
 * PIN or delivery secret.
 */
export type Installation = Readonly<{
  wabaId: string;
  phoneNumberId: string;
  hostUid: string;
  hostKey: EncryptedSecret;
  businessToken?: EncryptedSecret;
  pin?: EncryptedSecret;
  deliverySecret?: EncryptedSecret;
  /** The account the installation belongs to at Datalayer (its quota's organization). */
  organizationUid: string;
  /** The business's name as Meta verified it: what the disclosure line says. */
  businessName: string;
  /** How a person reaches someone at the business: a phone, a mail address, a page. */
  support: string;
  /** The business's privacy page (https), asked on the Ship card before connecting. */
  privacy: string;
  state: InstallationState;
  removedAt?: Date;
  /**
   * The application developer's own Meta app the number is connected with
   * (Datalayer has none): the app's id, the key of its webhook address
   * (`/whatsapp/webhook/<key>`) and its secret, which signs that address's
   * webhooks. The business token is the app's system user token. A removed
   * installation keeps the app's id only.
   */
  app: InstallationApp;
}>;

export type InstallationApp = Readonly<{
  appId: string;
  webhookKey?: string;
  appSecret?: EncryptedSecret;
}>;

/** What each secret of an installation is bound to (its associated data). */
export const installationData = (
  what: "host-key" | "business-token" | "pin" | "delivery" | "app-secret",
  wabaId: string,
  phoneNumberId: string,
): string => `${what}:${wabaId}:${phoneNumberId}`;

/** An approval card shown in a person's chat, and how it ended. */
export type ApprovalCardRow = Readonly<{
  phoneNumberId: string;
  userId: string;
  approvalId: string;
  deploymentUid: string;
  /** The presentation's digest, as shown: a decision is taken on it only. */
  digest: string;
  toolName: string;
  shownAt: Date;
  decidedStatus?: string;
}>;

/** What waits for the window to reopen: a reference, never content. */
export type HoldKind = "delivery" | "approval" | "link";
export type Hold = Readonly<{ kind: HoldKind; ref: string; heldAt: Date }>;

/** A notice template of a business account, as Meta last said it. */
export type TemplateRow = Readonly<{
  name: string;
  status: string;
  category: string;
}>;

/** What a number sent: free-form service messages, and utility templates. */
export type MessageCategory = "service" | "utility";

/** How long each kind of row is kept (`retain`). */
export const RETENTION = {
  /** A chat and what it holds: 30 days after the person's last message. */
  chatMs: 30 * 24 * 60 * 60 * 1000,
  /** An approval card. */
  cardMs: 30 * 24 * 60 * 60 * 1000,
  /** A sent message's status. */
  statusMs: 30 * 24 * 60 * 60 * 1000,
  /** A claim: Meta retries a webhook for 7 days, so a day more. */
  claimMs: 8 * 24 * 60 * 60 * 1000,
  /** A job that failed five times. */
  deadJobMs: 14 * 24 * 60 * 60 * 1000,
  /** Quota counts, which name a person: their hour, and a day. */
  usageMs: 24 * 60 * 60 * 1000,
} as const;

/** What `retain` deleted, by table. */
export type Retained = Record<string, number>;

export interface WhatsAppStore {
  /** Keep a message's furthest status; idempotent, and never a step back. */
  applyStatus(update: StatusUpdate): Promise<void>;
  status(wamid: string): Promise<StatusRow | undefined>;
  /**
   * A message from the person: the chat made if new, its last inbound time
   * moved forward (never back: Meta's webhooks arrive out of order).
   */
  recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat>;
  chat(key: ChatKey): Promise<Chat | undefined>;
  /**
   * A new generation of the chat's session: `start over`, or a switch to
   * `applicationId`. Answers the new generation; throws for a chat the
   * service never saw.
   */
  startOver(key: ChatKey, applicationId?: string): Promise<number>;
  /** Hold a reference for the chat; `false` when it is held already. */
  hold(key: ChatKey, kind: HoldKind, ref: string, at: Date): Promise<boolean>;
  /** What the chat holds, oldest first. */
  holds(key: ChatKey): Promise<Hold[]>;
  /** Take what the chat holds, oldest first: each hold given out once. */
  releaseHolds(key: ChatKey): Promise<Hold[]>;
  /**
   * Take the chat's notice: `true`, and the notice time set to `at`, only
   * when notices are not stopped and none was sent after `notBefore`.
   */
  claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean>;
  /** No more notices to this person on this number; `false` for an unknown chat. */
  stopNotices(key: ChatKey): Promise<boolean>;
  setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void>;
  templates(wabaId: string): Promise<TemplateRow[]>;
  countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void>;
  messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>>;
  /**
   * `forget`: every row naming the person (their BSUID) deleted, on every
   * number of the business — their chats, what those hold, their queued
   * and dead jobs (the one running now is deleted when it ends), their
   * quota counts. Claims and statuses never name them. Answers how many rows.
   */
  forget(userId: string): Promise<number>;
  /** Delete what is past its keeping (`RETENTION`), as of `now`. */
  retain(now: Date): Promise<Retained>;

  /** A claim taken once (`false` when it was), in the kit's claims table. */
  claimEvent(id: string): Promise<boolean>;
  releaseEvent(id: string): Promise<void>;

  /** Keep an installation: a reinstall of the same number replaces it, removed or not. */
  saveInstallation(installation: Installation): Promise<void>;
  installation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<Installation | undefined>;
  installationByHost(hostUid: string): Promise<Installation | undefined>;
  /** The installation a webhook address names (`/whatsapp/webhook/<key>`). */
  installationByWebhookKey(key: string): Promise<Installation | undefined>;
  installations(state?: InstallationState): Promise<Installation[]>;
  /** Pause or resume: `false` for an unknown or removed installation. */
  setInstallationState(
    wabaId: string,
    phoneNumberId: string,
    state: "active" | "paused",
  ): Promise<boolean>;
  /**
   * Removed at `at`, its business token, PIN and delivery secret dropped at
   * once: `false` when it is unknown or was removed already.
   */
  removeInstallation(
    wabaId: string,
    phoneNumberId: string,
    at: Date,
  ): Promise<boolean>;
  /**
   * Every row of a number deleted: the installation, its chats and what
   * they hold, its cards, statuses, counts, queued jobs and quota counts;
   * the account's templates when no other number of it is kept. Answers how many rows.
   */
  purgeInstallation(wabaId: string, phoneNumberId: string): Promise<number>;

  /** The disclosure line is said once per chat: `true` the first time. */
  markDisclosed(key: ChatKey): Promise<boolean>;
  /** Take the chat's turn until `until`; a lease past `now` is taken over. */
  claimTurn(
    key: ChatKey,
    owner: string,
    until: Date,
    now: Date,
  ): Promise<TurnClaim>;
  renewTurn(key: ChatKey, owner: string, until: Date): Promise<void>;
  setTurnSession(
    key: ChatKey,
    owner: string,
    sessionUid: string,
    deploymentUid: string,
  ): Promise<void>;
  /** Stop asked of the running turn: the turn, or nothing when none runs at `now`. */
  requestStop(key: ChatKey, now: Date): Promise<RunningTurn | undefined>;
  releaseTurn(key: ChatKey, owner: string): Promise<void>;
  /** The chat's session for this generation; `unshown` until its answer is shown. */
  setSession(
    key: ChatKey,
    session: Readonly<{
      sessionUid: string;
      deploymentUid: string;
      unshown: boolean;
    }>,
  ): Promise<void>;
  /** The session's answer is shown: `true` only for the one who marks it first. */
  markShown(key: ChatKey, sessionUid: string): Promise<boolean>;
  setAsking(key: ChatKey, asking: Asking | undefined): Promise<void>;

  /** A card shown; shown again (a new digest) it replaces the old one. */
  saveCard(card: ApprovalCardRow): Promise<void>;
  card(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
  ): Promise<ApprovalCardRow | undefined>;
  decideCard(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
    status: string,
  ): Promise<void>;
}

const chatKeyOf = (key: ChatKey): string =>
  JSON.stringify([key.phoneNumberId, key.userId]);

/** The store in memory: development and tests only. */
export class MemoryStore implements WhatsAppStore {
  readonly #statuses = new Map<string, StatusRow>();
  readonly #chats = new Map<string, Chat>();
  readonly #holds = new Map<string, (Hold & ChatKey)[]>();
  readonly #templates = new Map<string, Map<string, TemplateRow>>();
  readonly #counts = new Map<string, number>();
  readonly #claims = new Map<string, Date>();
  readonly #installations = new Map<string, Installation>();
  readonly #cards = new Map<string, ApprovalCardRow>();
  /** Quota counts and queued jobs live in the kit's stores: memory keeps none here. */

  async applyStatus(update: StatusUpdate): Promise<void> {
    const kept = this.#statuses.get(wamidHash(update.wamid));
    if (kept && STATUS_RANK[kept.status] >= STATUS_RANK[update.status]) return;
    this.#statuses.set(wamidHash(update.wamid), {
      at: update.at,
      phoneNumberId: update.phoneNumberId,
      status: update.status,
      ...(update.errorCode !== undefined
        ? { errorCode: update.errorCode }
        : {}),
    });
  }

  async status(wamid: string): Promise<StatusRow | undefined> {
    return this.#statuses.get(wamidHash(wamid));
  }

  async recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat> {
    const kept = this.#chats.get(chatKeyOf(key));
    const chat: Chat = kept
      ? {
          ...kept,
          lastInboundAt:
            kept.lastInboundAt.getTime() >= at.getTime()
              ? kept.lastInboundAt
              : at,
        }
      : {
          disclosed: false,
          generation: 0,
          lastInboundAt: at,
          noticesStopped: false,
          phoneNumberId: key.phoneNumberId,
          userId: key.userId,
          wabaId: key.wabaId,
        };
    this.#chats.set(chatKeyOf(key), chat);
    return chat;
  }

  async chat(key: ChatKey): Promise<Chat | undefined> {
    return this.#chats.get(chatKeyOf(key));
  }

  async startOver(key: ChatKey, applicationId?: string): Promise<number> {
    const kept = this.#chats.get(chatKeyOf(key));
    if (!kept) throw new Error("startOver names a chat the service never saw.");
    const generation = kept.generation + 1;
    const {
      asking: _asking,
      sessionDeployment: _deployment,
      sessionUid: _session,
      ...rest
    } = kept;
    void [_asking, _deployment, _session];
    this.#chats.set(chatKeyOf(key), {
      ...rest,
      generation,
      ...(applicationId !== undefined ? { applicationId } : {}),
    });
    return generation;
  }

  async hold(
    key: ChatKey,
    kind: HoldKind,
    ref: string,
    at: Date,
  ): Promise<boolean> {
    const held = this.#holds.get(chatKeyOf(key)) ?? [];
    if (held.some((one) => one.kind === kind && one.ref === ref)) return false;
    held.push({ ...key, heldAt: at, kind, ref });
    this.#holds.set(chatKeyOf(key), held);
    return true;
  }

  async holds(key: ChatKey): Promise<Hold[]> {
    return (this.#holds.get(chatKeyOf(key)) ?? []).map(
      ({ heldAt, kind, ref }) => ({ heldAt, kind, ref }),
    );
  }

  async releaseHolds(key: ChatKey): Promise<Hold[]> {
    const held = await this.holds(key);
    this.#holds.delete(chatKeyOf(key));
    return held;
  }

  async claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean> {
    const chat = this.#chats.get(chatKeyOf(key));
    if (!chat || chat.noticesStopped) return false;
    if (chat.lastNoticeAt && chat.lastNoticeAt.getTime() > notBefore.getTime())
      return false;
    this.#chats.set(chatKeyOf(key), { ...chat, lastNoticeAt: at });
    return true;
  }

  async stopNotices(key: ChatKey): Promise<boolean> {
    const chat = this.#chats.get(chatKeyOf(key));
    if (!chat) return false;
    this.#chats.set(chatKeyOf(key), { ...chat, noticesStopped: true });
    return true;
  }

  async setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void> {
    const account =
      this.#templates.get(wabaId) ?? new Map<string, TemplateRow>();
    const kept = account.get(name);
    if (!kept && (!change.status || !change.category))
      throw new Error(`A new template ${name} needs its status and category.`);
    account.set(name, {
      category: change.category ?? kept?.category ?? "",
      name,
      status: change.status ?? kept?.status ?? "",
    });
    this.#templates.set(wabaId, account);
  }

  async templates(wabaId: string): Promise<TemplateRow[]> {
    return [...(this.#templates.get(wabaId)?.values() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void> {
    const key = JSON.stringify([phoneNumberId, month, category]);
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  async messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>> {
    const of = (category: MessageCategory) =>
      this.#counts.get(JSON.stringify([phoneNumberId, month, category])) ?? 0;
    return { service: of("service"), utility: of("utility") };
  }

  async forget(userId: string): Promise<number> {
    let count = 0;
    for (const [key, chat] of this.#chats)
      if (chat.userId === userId) {
        this.#chats.delete(key);
        count += 1;
      }
    for (const [key, held] of this.#holds)
      if (held[0]?.userId === userId) {
        this.#holds.delete(key);
        count += held.length;
      }
    for (const [key, card] of this.#cards)
      if (card.userId === userId) {
        this.#cards.delete(key);
        count += 1;
      }
    return count;
  }

  async retain(now: Date): Promise<Retained> {
    const before = (ms: number) => now.getTime() - ms;
    const out: Retained = { chats: 0, holds: 0, statuses: 0 };
    for (const [key, chat] of this.#chats)
      if (chat.lastInboundAt.getTime() < before(RETENTION.chatMs)) {
        this.#chats.delete(key);
        out.chats = (out.chats ?? 0) + 1;
        out.holds = (out.holds ?? 0) + (this.#holds.get(key)?.length ?? 0);
        this.#holds.delete(key);
      }
    for (const [key, held] of this.#holds) {
      const kept = held.filter(
        (one) => one.heldAt.getTime() >= before(RETENTION.chatMs),
      );
      out.holds = (out.holds ?? 0) + held.length - kept.length;
      if (kept.length) this.#holds.set(key, kept);
      else this.#holds.delete(key);
    }
    for (const [key, status] of this.#statuses)
      if (status.at.getTime() < before(RETENTION.statusMs)) {
        this.#statuses.delete(key);
        out.statuses = (out.statuses ?? 0) + 1;
      }
    out.cards = 0;
    for (const [key, card] of this.#cards)
      if (card.shownAt.getTime() < before(RETENTION.cardMs)) {
        this.#cards.delete(key);
        out.cards += 1;
      }
    out.claims = 0;
    for (const [id, at] of this.#claims)
      if (at.getTime() < before(RETENTION.claimMs)) {
        this.#claims.delete(id);
        out.claims += 1;
      }
    return out;
  }

  async claimEvent(id: string): Promise<boolean> {
    if (this.#claims.has(id)) return false;
    this.#claims.set(id, new Date());
    return true;
  }

  async releaseEvent(id: string): Promise<void> {
    this.#claims.delete(id);
  }

  async saveInstallation(installation: Installation): Promise<void> {
    this.#installations.set(
      JSON.stringify([installation.wabaId, installation.phoneNumberId]),
      installation,
    );
  }

  async installation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<Installation | undefined> {
    return this.#installations.get(JSON.stringify([wabaId, phoneNumberId]));
  }

  async installationByHost(hostUid: string): Promise<Installation | undefined> {
    return [...this.#installations.values()].find(
      (one) => one.hostUid === hostUid,
    );
  }

  async installationByWebhookKey(
    key: string,
  ): Promise<Installation | undefined> {
    return [...this.#installations.values()].find(
      (one) => one.app.webhookKey === key,
    );
  }

  async installations(state?: InstallationState): Promise<Installation[]> {
    return [...this.#installations.values()].filter(
      (one) => !state || one.state === state,
    );
  }

  async setInstallationState(
    wabaId: string,
    phoneNumberId: string,
    state: "active" | "paused",
  ): Promise<boolean> {
    const kept = await this.installation(wabaId, phoneNumberId);
    if (!kept || kept.state === "removed") return false;
    await this.saveInstallation({ ...kept, state });
    return true;
  }

  async removeInstallation(
    wabaId: string,
    phoneNumberId: string,
    at: Date,
  ): Promise<boolean> {
    const kept = await this.installation(wabaId, phoneNumberId);
    if (!kept || kept.state === "removed") return false;
    const {
      businessToken: _token,
      deliverySecret: _secret,
      pin: _pin,
      ...rest
    } = kept;
    void [_token, _secret, _pin];
    await this.saveInstallation({
      ...rest,
      // The app's id stays; its secret and webhook address go.
      app: { appId: rest.app.appId },
      removedAt: at,
      state: "removed",
    });
    return true;
  }

  async purgeInstallation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<number> {
    let count = 0;
    if (this.#installations.delete(JSON.stringify([wabaId, phoneNumberId])))
      count += 1;
    for (const [key, chat] of this.#chats)
      if (chat.phoneNumberId === phoneNumberId) {
        this.#chats.delete(key);
        count += 1;
      }
    for (const [key, held] of this.#holds)
      if (held[0]?.phoneNumberId === phoneNumberId) {
        this.#holds.delete(key);
        count += held.length;
      }
    for (const [key, card] of this.#cards)
      if (card.phoneNumberId === phoneNumberId) {
        this.#cards.delete(key);
        count += 1;
      }
    for (const [key, status] of this.#statuses)
      if (status.phoneNumberId === phoneNumberId) {
        this.#statuses.delete(key);
        count += 1;
      }
    for (const key of this.#counts.keys())
      if ((JSON.parse(key) as string[])[0] === phoneNumberId) {
        this.#counts.delete(key);
        count += 1;
      }
    if (
      ![...this.#installations.values()].some((one) => one.wabaId === wabaId)
    ) {
      count += this.#templates.get(wabaId)?.size ?? 0;
      this.#templates.delete(wabaId);
    }
    return count;
  }

  #update(key: ChatKey, change: (chat: Chat) => Chat | undefined): boolean {
    const kept = this.#chats.get(chatKeyOf(key));
    if (!kept) return false;
    const changed = change(kept);
    if (!changed) return false;
    this.#chats.set(chatKeyOf(key), changed);
    return true;
  }

  async markDisclosed(key: ChatKey): Promise<boolean> {
    return this.#update(key, (chat) =>
      chat.disclosed ? undefined : { ...chat, disclosed: true },
    );
  }

  async claimTurn(
    key: ChatKey,
    owner: string,
    until: Date,
    now: Date,
  ): Promise<TurnClaim> {
    const kept = this.#chats.get(chatKeyOf(key));
    if (!kept) throw new Error("claimTurn names a chat the service never saw.");
    if (
      kept.turn &&
      kept.turn.owner !== owner &&
      kept.turn.until.getTime() > now.getTime()
    )
      return { ok: false, owner: kept.turn.owner };
    this.#chats.set(chatKeyOf(key), {
      ...kept,
      turn: { owner, stop: false, until },
    });
    return { ok: true };
  }

  async renewTurn(key: ChatKey, owner: string, until: Date): Promise<void> {
    this.#update(key, (chat) =>
      chat.turn?.owner === owner
        ? { ...chat, turn: { ...chat.turn, until } }
        : undefined,
    );
  }

  async setTurnSession(
    key: ChatKey,
    owner: string,
    sessionUid: string,
    deploymentUid: string,
  ): Promise<void> {
    this.#update(key, (chat) =>
      chat.turn?.owner === owner
        ? { ...chat, turn: { ...chat.turn, deploymentUid, sessionUid } }
        : undefined,
    );
  }

  async requestStop(key: ChatKey, now: Date): Promise<RunningTurn | undefined> {
    const kept = this.#chats.get(chatKeyOf(key));
    const turn = kept?.turn;
    if (!kept || !turn || turn.until.getTime() <= now.getTime())
      return undefined;
    const stopped = { ...turn, stop: true };
    this.#chats.set(chatKeyOf(key), { ...kept, turn: stopped });
    return stopped;
  }

  async releaseTurn(key: ChatKey, owner: string): Promise<void> {
    this.#update(key, (chat) => {
      if (chat.turn?.owner !== owner) return undefined;
      const { turn: _turn, ...rest } = chat;
      void _turn;
      return rest;
    });
  }

  async setSession(
    key: ChatKey,
    session: Readonly<{
      sessionUid: string;
      deploymentUid: string;
      unshown: boolean;
    }>,
  ): Promise<void> {
    this.#update(key, (chat) => {
      const { unshownSessionUid: _unshown, ...rest } = chat;
      void _unshown;
      return {
        ...rest,
        sessionDeployment: session.deploymentUid,
        sessionUid: session.sessionUid,
        ...(session.unshown ? { unshownSessionUid: session.sessionUid } : {}),
      };
    });
  }

  async markShown(key: ChatKey, sessionUid: string): Promise<boolean> {
    return this.#update(key, (chat) => {
      if (chat.unshownSessionUid !== sessionUid) return undefined;
      const { unshownSessionUid: _unshown, ...rest } = chat;
      void _unshown;
      return rest;
    });
  }

  async setAsking(key: ChatKey, asking: Asking | undefined): Promise<void> {
    this.#update(key, (chat) => {
      const { asking: _asking, ...rest } = chat;
      void _asking;
      return asking ? { ...rest, asking } : rest;
    });
  }

  async saveCard(card: ApprovalCardRow): Promise<void> {
    this.#cards.set(
      JSON.stringify([card.phoneNumberId, card.userId, card.approvalId]),
      card,
    );
  }

  async card(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
  ): Promise<ApprovalCardRow | undefined> {
    return this.#cards.get(JSON.stringify([phoneNumberId, userId, approvalId]));
  }

  async decideCard(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
    status: string,
  ): Promise<void> {
    const kept = await this.card(phoneNumberId, userId, approvalId);
    if (kept) await this.saveCard({ ...kept, decidedStatus: status });
  }
}
