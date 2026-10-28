import {
  HostRefusedError,
  quotaEntries,
  quotaWords,
  resetOf,
  resolveApplication,
  TurnState,
  windowOf,
  type AgentClient,
  type ApplicationRefusal,
  type Clock,
  type DatalayerHostClient,
  type HostSelf,
  type Logger,
  type QuotaLimits,
  type QuotaStore,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHash, randomBytes } from "node:crypto";

import { Approvals } from "./approvals.js";
import type { AsPerson, Person } from "./as-person.js";
import {
  choiceOf,
  chooseApplication,
  disclosure,
  runWord,
  SAY,
  wordOf,
  type CommandContext,
  type Reply,
  type Standing,
} from "./commands.js";
import { DeliveryHandler, type DeliveryQueueJob } from "./deliveries.js";
import { GroupConversations } from "./groups.js";
import {
  externalIdOf,
  type WhatsAppTurn,
  type WhatsAppTurnRequest,
} from "./domain.js";
import { MetaError, type MetaPort, type Outgoing } from "./meta-port.js";
import type { Metrics } from "./observability.js";
import {
  accountUpdated,
  removeInstallation,
  type RemovalReason,
} from "./removal.js";
import {
  approvalPressOf,
  optionOf,
  progressMessage,
  renderSignIn,
  secretBearing,
  shownText,
  STOP_ID,
  WORDS,
} from "./render.js";
import { holdRef, PART_SPACING_MS, refOf, Speaker } from "./speaker.js";
import { isRecording, MAX_VOICE_BYTES, SPEECH_WORDS } from "./speech.js";
import {
  installationData,
  wamidHash,
  type Chat,
  type ChatKey,
  type Hold,
  type Installation,
  type WhatsAppStore,
} from "./store.js";
import type {
  AccountJob,
  GroupJob,
  MessageJob,
  WhatsAppJob,
} from "./webhook.js";
import { TEMPLATE_FIELDS, type WindowKeeper } from "./window.js";

/**
 * The worker: what the ingress persisted, answered. A person's message in
 * a 1:1 chat — the number connected, the window reopened (and what it held
 * given back), the person's standing (their link at Datalayer), a word or a
 * press handled, the application (the chat's, else the person's choice,
 * else the number's default; allowed by the installation), quotas per
 * person, number, organization and application, the read mark with the
 * typing indicator, the turn started or continued as the speaker
 * (idempotent on the message), its stream reduced into the kit's
 * `TurnState`, and the answer written whole. Also Meta's account events
 * and Datalayer's deliveries.
 */

/** How long a chat's turn claim holds without renewal. */
export const TURN_LEASE_MS = 5 * 60 * 1000;
/** How often a running turn renews its claim. */
export const TURN_RENEW_MS = 60 * 1000;
/** How long WhatsApp shows the typing indicator: past it, ⏳ on the message. */
export const TYPING_MS = 25 * 1000;
/** When a running turn first says it still works, with Stop. */
export const PROGRESS_AFTER_MS = 30 * 1000;
/** At most one progress message a minute after that. */
export const PROGRESS_EVERY_MS = 60 * 1000;
/** The reaction on a message while a long turn answers it. */
export const WAITING = "⏳";

export type WorkerDependencies = Readonly<{
  store: WhatsAppStore;
  port: MetaPort;
  cipher: SecretCipher;
  window: WindowKeeper;
  hosts: Pick<
    DatalayerHostClient,
    "self" | "linkState" | "linkCode" | "unlink" | "acknowledge" | "uninstalled"
  >;
  agent: AgentClient<WhatsAppTurn>;
  asPerson: AsPerson;
  quotas: QuotaStore;
  limits: QuotaLimits;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  /** Datalayer's web origin: links confirmed, sessions opened. */
  webUrl: string;
  /** This worker process: two copies of one job never both run a turn. */
  instance?: string;
}>;

const text = (said: string): Outgoing => ({ text: said, type: "text" });

/** A word's reply as a WhatsApp message. */
export function outgoingOf(reply: Reply): Outgoing {
  switch (reply.kind) {
    case "text":
      return text(reply.text);
    case "button":
      return {
        body: reply.text,
        label: reply.label,
        type: "cta",
        url: reply.url,
      };
    case "list":
      return {
        body: reply.text,
        label: reply.label,
        rows: reply.rows,
        type: "list",
      };
  }
}

const REFUSALS: Readonly<Record<ApplicationRefusal, string>> = {
  "channel-denied": WORDS.notAllowed,
  "direct-only": WORDS.notAllowed,
  "no-application": WORDS.noApplication,
  "not-allowed": WORDS.notAllowed,
};

/** A person named in a claim's key by a hash, never as they are. */
const personKey = (userId: string): string =>
  createHash("sha256").update(userId).digest("hex").slice(0, 32);

export class Worker {
  readonly instance: string;
  readonly speaker: Speaker;
  readonly approvals: Approvals;
  readonly deliveries: DeliveryHandler;
  readonly groups: GroupConversations;

  constructor(readonly deps: WorkerDependencies) {
    this.instance = deps.instance ?? randomBytes(6).toString("hex");
    this.speaker = new Speaker({
      asPerson: deps.asPerson,
      cipher: deps.cipher,
      clock: deps.clock,
      logger: deps.logger,
      port: deps.port,
      webUrl: deps.webUrl,
      window: deps.window,
    });
    this.approvals = new Approvals({
      asPerson: deps.asPerson,
      clock: deps.clock,
      logger: deps.logger,
      speaker: this.speaker,
      store: deps.store,
    });
    this.deliveries = new DeliveryHandler({
      approvals: this.approvals,
      asPerson: deps.asPerson,
      cipher: deps.cipher,
      clock: deps.clock,
      hosts: deps.hosts,
      logger: deps.logger,
      speaker: this.speaker,
      store: deps.store,
      window: deps.window,
    });
    this.groups = new GroupConversations(this);
    this.deliveries.groups = this.groups;
  }

  async handle(job: WhatsAppJob | DeliveryQueueJob): Promise<void> {
    switch (job.kind) {
      case "message":
        return this.message(job);
      case "account":
        return this.account(job);
      case "group":
        return this.group(job);
      case "delivery":
        return this.#guarded(
          await this.deps.store.installationByHost(job.hostUid),
          () => this.deliveries.receive(job),
        );
    }
  }

  /** Remove a number: the token Meta refused, the key Datalayer refused, Meta's word. */
  removed(installation: Installation, why: RemovalReason): Promise<boolean> {
    return removeInstallation(
      {
        cipher: this.deps.cipher,
        hosts: this.deps.hosts,
        logger: this.deps.logger,
        now: () => this.deps.clock.now(),
        port: this.deps.port,
        store: this.deps.store,
      },
      installation,
      why,
    );
  }

  /** Work for one number: Meta refusing its token, or Datalayer its key, removes it. */
  async #guarded(
    installation: Installation | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (installation && error instanceof MetaError && error.tokenRefused) {
        await this.removed(installation, "token-refused");
        return;
      }
      if (
        installation &&
        error instanceof HostRefusedError &&
        error.status === 401
      ) {
        await this.removed(installation, "host-key-refused");
        return;
      }
      throw error;
    }
  }

  /** An event of a business account: a template's status, or the account's access ended. */
  async account(job: AccountJob): Promise<void> {
    const { logger } = this.deps;
    if ((TEMPLATE_FIELDS as readonly string[]).includes(job.field)) {
      try {
        const ours = await this.deps.window.templateChanged(
          job.wabaId,
          job.field as (typeof TEMPLATE_FIELDS)[number],
          job.value,
        );
        logger.info("account.template", { field: job.field, ours });
      } catch (error) {
        logger.warn("account.template_unread", { error, field: job.field });
      }
      return;
    }
    if (job.field === "account_update") {
      const removed = await accountUpdated(
        {
          cipher: this.deps.cipher,
          hosts: this.deps.hosts,
          logger,
          now: () => this.deps.clock.now(),
          port: this.deps.port,
          store: this.deps.store,
        },
        job.wabaId,
        job.appId,
        job.value,
      );
      logger.info("account.updated", { removed });
      return;
    }
    // Quality, limits and alerts are shown on the card in a later step.
    logger.info("account.event", { field: job.field });
  }

  /** An event of the number's groups: created, deleted, suspended. */
  async group(job: GroupJob): Promise<void> {
    const installation = await this.deps.store.installation(
      job.wabaId,
      job.phoneNumberId,
    );
    await this.#guarded(installation, () => this.groups.event(job));
  }

  async message(job: MessageJob): Promise<void> {
    const installation = await this.deps.store.installation(
      job.wabaId,
      job.phoneNumberId,
    );
    // Late work of a removed number does nothing.
    if (!installation || installation.state === "removed") {
      this.deps.logger.info("message.dropped", {
        reason: installation ? "removed" : "not-connected",
      });
      return;
    }
    await this.#guarded(installation, () => this.#message(job, installation));
  }

  #hostKey(installation: Installation): string {
    return this.deps.cipher.decrypt(
      installation.hostKey,
      installationData(
        "host-key",
        installation.wabaId,
        installation.phoneNumberId,
      ),
    );
  }

  async #message(job: MessageJob, installation: Installation): Promise<void> {
    const { store, clock, logger } = this.deps;
    // A group's message opens no 1:1 window: the group answers itself.
    if (job.groupId !== undefined)
      return this.groups.message(
        { ...job, groupId: job.groupId },
        installation,
        this.#hostKey(installation),
      );
    const chat = {
      phoneNumberId: job.phoneNumberId,
      userId: job.userId,
      wabaId: job.wabaId,
    };
    const hostKey = this.#hostKey(installation);
    const say = (messages: readonly Outgoing[]) =>
      this.speaker.say(installation, job.userId, messages);
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    // Said once a day to a person, whatever they write.
    const once = async (what: string, said: string) => {
      if (
        await store.claimEvent(
          `said:${what}:${job.phoneNumberId}:${personKey(job.userId)}:${day}`,
        )
      )
        await say([text(said)]);
    };

    // The person wrote: the window opens, and what it held is said first.
    const released = await this.deps.window.received(chat, new Date(job.at));
    if (job.system || job.reaction || job.type === "reaction") {
      logger.info("message.ignored", { type: job.type });
      return;
    }
    if (installation.state === "paused") return once("paused", WORDS.paused);
    const link = await this.deps.hosts.linkState(hostKey, job.userId);
    const standing: Standing = link.linked ? "linked" : "private";
    if (released.length && standing === "linked")
      await this.#release(installation, hostKey, chat, released);
    // A notice's button only reopens the window.
    if (job.type === "button" && !wordOf(job.text)) {
      if (!released.length) await say([text(WORDS.nothingHeld)]);
      return;
    }

    const press = approvalPressOf(job.reply?.id);
    if (press) {
      const card = await store.card(
        job.phoneNumberId,
        job.userId,
        press.approvalId,
      );
      const self = await this.deps.hosts.self(hostKey);
      const appName =
        self.deployments.find((one) => one.uid === card?.deploymentUid)
          ?.appName ?? "The application";
      return say(
        await this.approvals.press(
          installation,
          hostKey,
          job.userId,
          standing,
          press,
          appName,
        ),
      );
    }

    const kept = await store.chat(chat);
    const running =
      kept?.turn && kept.turn.until.getTime() > clock.now()
        ? kept.turn
        : undefined;
    const context: CommandContext = {
      business: installation.businessName,
      chat,
      hostKey,
      standing,
      support: installation.support,
      ...(job.profileName ? { profileName: job.profileName } : {}),
      ...(running
        ? {
            turn: {
              stop: () => this.#stop(chat, link.principalUid ?? "", job.wamid),
            },
          }
        : {}),
    };
    const commands = {
      hosts: this.deps.hosts,
      logger,
      store,
      webUrl: this.deps.webUrl,
      window: this.deps.window,
    };
    const word =
      job.reply?.id === STOP_ID ? ("stop" as const) : wordOf(job.text);
    if (word)
      return say((await runWord(word, context, commands)).map(outgoingOf));
    const chosen = choiceOf(job.reply?.id);
    if (chosen)
      return say(
        (await chooseApplication(chosen, context, commands)).map(outgoingOf),
      );

    // Visitors need Datalayer's visitor exchange: a person without a link
    // is told, once a day, how to link.
    if (standing !== "linked") return once("private", SAY.notLinked);
    const prompt = (
      optionOf(job.reply?.id, kept?.asking?.options) ??
      job.reply?.title ??
      job.text ??
      job.media?.caption ??
      ""
    ).trim();
    // A voice note is heard once the application is known (WA-18).
    const voice =
      !prompt && isRecording(job.media, job.type) ? job.media : undefined;
    if (!prompt && !voice) return say([text(WORDS.textOnly)]);
    // An option of a question asked in a group: answered in the group.
    const pressed = optionOf(job.reply?.id, kept?.asking?.options);
    if (pressed !== undefined && kept?.asking?.groupId) {
      const groupId = kept.asking.groupId;
      await store.setAsking(chat, undefined);
      const { reply: _reply, ...rest } = job;
      void _reply;
      return this.groups.message(
        { ...rest, groupId, mentioned: true, text: pressed },
        installation,
        hostKey,
      );
    }
    await this.#ask(
      job,
      installation,
      hostKey,
      chat,
      link.principalUid ?? "",
      prompt,
      voice?.id,
    );
  }

  /**
   * A voice note heard as the person (WA-18): downloaded from Meta at once,
   * heard by Datalayer's speech service with the person's host token, the
   * audio dropped; the words quoted back and returned as the prompt.
   * `undefined` once the person was told it could not be heard.
   */
  async #hear(
    installation: Installation,
    person: Person,
    mediaId: string,
  ): Promise<string | undefined> {
    const { logger, metrics } = this.deps;
    const say = (said: string) =>
      this.speaker.say(installation, person.userId, [text(said)]);
    let recording;
    try {
      recording = await this.deps.port.download(
        this.speaker.token(installation),
        mediaId,
        MAX_VOICE_BYTES,
      );
    } catch (error) {
      if (error instanceof MetaError && error.tokenRefused) throw error;
      logger.warn("voice.not_downloaded", {
        status: error instanceof MetaError ? error.status : 0,
      });
      await say(SPEECH_WORDS.notHeard);
      return undefined;
    }
    let words: string;
    try {
      words = await this.deps.asPerson.hear(person, recording);
    } catch (error) {
      if (error instanceof HostRefusedError) {
        // The speech service's own sentence: a recording too long, a limit spent.
        logger.warn("voice.refused", { status: error.status });
        await say(
          error.detail && !secretBearing(error.detail)
            ? error.detail
            : SPEECH_WORDS.notHeard,
        );
      } else {
        logger.error("voice.failed", { error });
        await say(SPEECH_WORDS.notHeard);
      }
      return undefined;
    } finally {
      recording = undefined;
    }
    if (!words) {
      await say(SPEECH_WORDS.nothingHeard);
      return undefined;
    }
    metrics.count("voice_notes");
    await say(SPEECH_WORDS.heard(words));
    return words;
  }

  /** What the window held, said now: approvals' cards, answers not shown yet. */
  async #release(
    installation: Installation,
    hostKey: string,
    chat: ChatKey,
    holds: readonly Hold[],
  ): Promise<void> {
    for (const hold of holds) {
      const ref = refOf(hold.ref);
      if (!ref) continue;
      const person: Person = {
        deploymentUid: ref.deploymentUid,
        hostKey,
        userId: chat.userId,
      };
      try {
        if (hold.kind === "approval")
          await this.approvals.show(
            installation,
            person,
            ref.id,
            await this.deliveries.appName(person),
          );
        else if (hold.kind === "delivery")
          await this.deliveries.showAnswer(installation, chat, person, ref.id);
      } catch (error) {
        if (error instanceof MetaError && error.tokenRefused) throw error;
        // One held thing failing never keeps the others, nor the message, back.
        this.deps.logger.error("hold.not_shown", { error, kind: hold.kind });
      }
    }
  }

  /** `stop` or the Stop button: the running turn stopped as the person who asked. */
  async #stop(
    chat: ChatKey & Readonly<{ wabaId: string }>,
    principalUid: string,
    wamid: string,
  ): Promise<void> {
    const turn = await this.deps.store.requestStop(
      chat,
      new Date(this.deps.clock.now()),
    );
    // Asked before the session started: the turn stops itself once it has one.
    if (!turn?.sessionUid || !turn.deploymentUid) return;
    await this.deps.agent.stopTurn(turn.sessionUid, {
      applicationId: turn.deploymentUid,
      externalEventId: `whatsapp:stop:${wamidHash(wamid)}`,
      externalUserId: chat.userId,
      principalId: principalUid,
      prompt: "",
      provenance: { ...chat, wamid },
      sessionId: turn.sessionUid,
    });
  }

  async #ask(
    job: MessageJob,
    installation: Installation,
    hostKey: string,
    chat: ChatKey & Readonly<{ wabaId: string }>,
    principalUid: string,
    prompt: string,
    voiceMediaId?: string,
  ): Promise<void> {
    const { store, clock } = this.deps;
    const say = (messages: readonly Outgoing[]) =>
      this.speaker.say(installation, job.userId, messages);
    const self = await this.deps.hosts.self(hostKey);
    if (self.paused) {
      if (
        await store.claimEvent(
          `said:paused:${job.phoneNumberId}:${personKey(job.userId)}:${new Date(clock.now()).toISOString().slice(0, 10)}`,
        )
      )
        await say([text(WORDS.paused)]);
      return;
    }
    const kept = (await store.chat(chat)) as Chat;
    const resolution = await resolveApplication({
      allowances: self.deployments.map((one) => ({
        applicationId: one.uid,
        channelPolicy: "channels" as const,
        enabled: true,
        name: one.appName || one.uid,
      })),
      channel: async () => undefined,
      defaultApplication: async () => self.defaultDeployment,
      next: async () => kept.applicationId,
      ...(kept.sessionUid && kept.sessionDeployment
        ? { threadApplication: kept.sessionDeployment }
        : {}),
      visibility: "direct",
    });
    if (!resolution.ok) return say([text(REFUSALS[resolution.refusal])]);
    const appName = nameOf(self, resolution.applicationId);
    if (await store.markDisclosed(chat))
      await say([
        text(
          disclosure(appName, installation.businessName, installation.support),
        ),
      ]);

    // One turn per chat, claimed insert-first: another copy of this very
    // message says nothing; another message is told one runs.
    const owner = `${wamidHash(job.wamid).slice(0, 24)}:${this.instance}`;
    const claim = await store.claimTurn(
      chat,
      owner,
      new Date(clock.now() + TURN_LEASE_MS),
      new Date(clock.now()),
    );
    if (!claim.ok) {
      if (claim.owner.startsWith(`${owner.split(":")[0]}:`)) return;
      return say([text(WORDS.busy)]);
    }
    try {
      const refused = await this.charge(
        job,
        installation,
        resolution.applicationId,
      );
      if (refused) return await say([text(refused)]);
      await this.speaker.markRead(installation, job.wamid);
      const asked = voiceMediaId
        ? await this.#hear(
            installation,
            {
              deploymentUid: resolution.applicationId,
              hostKey,
              userId: job.userId,
            },
            voiceMediaId,
          )
        : prompt;
      if (asked === undefined) return;
      await this.#turn(job, installation, hostKey, chat, kept, {
        appName,
        applicationId: resolution.applicationId,
        owner,
        principalUid,
        prompt: asked,
      });
    } finally {
      await store.releaseTurn(chat, owner);
    }
  }

  /**
   * The person's, the number's, the organization's and the application's
   * quota for this message, once: what is said when one is spent. Claimed
   * by the message before it is taken, so a retried job goes on uncharged.
   */
  async charge(
    job: MessageJob,
    installation: Installation,
    applicationId: string,
  ): Promise<string | undefined> {
    const { store, clock } = this.deps;
    const charge = `quota:${wamidHash(job.wamid)}`;
    if (!(await store.claimEvent(charge))) return undefined;
    const now = new Date(clock.now());
    let taken;
    try {
      taken = await this.deps.quotas.takeQuota(
        quotaEntries(
          this.deps.limits,
          {
            applicationId,
            externalUserId: job.userId,
            installation: externalIdOf(job.wabaId, job.phoneNumberId),
            organizationId: installation.organizationUid,
          },
          "number",
        ),
        windowOf(now),
      );
    } catch (error) {
      await store.releaseEvent(charge);
      throw error;
    }
    if (taken.ok) return undefined;
    return quotaWords(
      {
        limit: taken.entry.limit,
        ok: false,
        resetsAt: resetOf(now),
        scope: taken.entry.scope,
      },
      "this number",
    );
  }

  async #turn(
    job: MessageJob,
    installation: Installation,
    hostKey: string,
    chat: ChatKey & Readonly<{ wabaId: string }>,
    kept: Chat,
    turn: Readonly<{
      appName: string;
      applicationId: string;
      owner: string;
      principalUid: string;
      prompt: string;
    }>,
  ): Promise<void> {
    const { store, clock, logger, metrics } = this.deps;
    const say = (messages: readonly Outgoing[], spacing = 0) =>
      this.speaker.say(installation, job.userId, messages, spacing);
    const same =
      Boolean(kept.sessionUid) && kept.sessionDeployment === turn.applicationId;
    const request: WhatsAppTurnRequest = {
      applicationId: turn.applicationId,
      // Idempotent on the message, named by its id's hash.
      externalEventId: `whatsapp:${wamidHash(job.wamid)}`,
      externalUserId: job.userId,
      principalId: turn.principalUid,
      prompt: turn.prompt,
      provenance: {
        phoneNumberId: job.phoneNumberId,
        userId: job.userId,
        wabaId: job.wabaId,
        wamid: job.wamid,
      },
      sessionGeneration: kept.generation,
      ...(same && kept.sessionUid ? { sessionId: kept.sessionUid } : {}),
    };
    let stream;
    try {
      stream = await this.deps.agent.startTurn(request);
    } catch (error) {
      if (error instanceof HostRefusedError) {
        if ([401, 403, 404].includes(error.status)) {
          logger.audit("identity.refused", {
            installation: externalIdOf(job.wabaId, job.phoneNumberId),
            reason: String(error.status),
            user: job.userId,
          });
          return say([text(WORDS.refusedByDatalayer)]);
        }
        // The runtime's own reason, said to the person: a spent limit, a pause.
        logger.warn("turn.refused", { status: error.status });
        return say([
          text(secretBearing(error.detail) ? WORDS.failed : error.detail),
        ]);
      }
      logger.error("turn.failed", { error });
      return say([text(WORDS.failed)]);
    }
    metrics.count("turns");
    const sessionId = stream.sessionId;
    // Unshown until shown here: a `turn.completed` delivery finishes a
    // turn the worker could not.
    await store.setSession(chat, {
      deploymentUid: turn.applicationId,
      sessionUid: sessionId,
      unshown: true,
    });
    await store.setTurnSession(chat, turn.owner, sessionId, turn.applicationId);
    await store.setAsking(chat, undefined);
    // Stop asked before the session existed.
    if ((await store.chat(chat))?.turn?.stop)
      await this.deps.agent.stopTurn(sessionId, request);

    const state = new TurnState();
    const started = clock.now();
    let secret = false;
    let reacted = false;
    let lastProgress: number | undefined;
    let lastRenew = started;
    const signIns = new Set<string>();
    for await (const event of stream.updates) {
      state.apply(event);
      if (!secret && secretBearing(shownText(state))) secret = true;
      // A company's sign-in (WA-42): its button or code at once, once per
      // call; the turn goes on, and the next answer knows the account.
      if (event.kind === "sign-in" && !signIns.has(event.toolCallId)) {
        signIns.add(event.toolCallId);
        logger.info("turn.sign_in", { mode: event.signIn.mode });
        await say(renderSignIn(event.signIn));
      }
      if (state.ended) break;
      const now = clock.now();
      if (now - lastRenew >= TURN_RENEW_MS) {
        await store.renewTurn(chat, turn.owner, new Date(now + TURN_LEASE_MS));
        lastRenew = now;
      }
      if (!reacted && now - started >= TYPING_MS) {
        reacted = true;
        await this.speaker.react(installation, job.userId, job.wamid, WAITING);
      }
      if (
        now - started >= PROGRESS_AFTER_MS &&
        (lastProgress === undefined || now - lastProgress >= PROGRESS_EVERY_MS)
      ) {
        lastProgress = now;
        await say([progressMessage(secret ? "" : state.status)]);
      }
    }
    if (!state.ended) {
      // After Stop the run stream just ends; any other end without an
      // answer is a failure.
      const held = (await store.chat(chat))?.turn;
      state.apply(
        held?.stop
          ? { kind: "stop" }
          : { kind: "error", message: WORDS.endedEarly },
      );
    }
    if (reacted)
      await this.speaker.react(installation, job.userId, job.wamid, "");

    // Stopped: the stop said so, once.
    if (state.ending === "stop") {
      await store.markShown(chat, sessionId);
      return;
    }
    if (state.ending === "error") {
      await store.markShown(chat, sessionId);
      return say([text(WORDS.failed)]);
    }
    const person: Person = {
      deploymentUid: turn.applicationId,
      hostKey,
      userId: job.userId,
    };
    // A turn that outlived the window ends with a notice, not the answer.
    await this.speaker.reach(
      installation,
      chat,
      { kind: "delivery", ref: holdRef(turn.applicationId, sessionId) },
      turn.appName,
      async () => {
        const messages = await this.speaker.answer(
          installation,
          person,
          sessionId,
          state.answer,
          {
            ...(state.asking ? { asking: state.asking } : {}),
            files: state.files,
            secret,
          },
        );
        // A delivery that showed it first wins: said once.
        if (!(await store.markShown(chat, sessionId))) return;
        await say(messages, PART_SPACING_MS);
        if (state.asking?.options?.length)
          await store.setAsking(chat, {
            options: [...state.asking.options],
            sessionUid: sessionId,
          });
      },
    );
  }
}

/** A deployment's application name, as the installation allows it. */
function nameOf(self: HostSelf, uid: string): string {
  return (
    self.deployments.find((one) => one.uid === uid)?.appName ||
    "The application"
  );
}
