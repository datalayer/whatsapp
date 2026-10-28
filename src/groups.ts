import {
  HostRefusedError,
  resolveApplication,
  TurnState,
  type AskQuestion,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { PapSignInWaiting } from "@datalayer/agent-runtimes/lib/portable/signIn";
import { createHash } from "node:crypto";

import type { Person } from "./as-person.js";
import type { WhatsAppTurnRequest } from "./domain.js";
import type { Outgoing } from "./meta-port.js";
import {
  renderQuestion,
  renderSignIn,
  secretBearing,
  shownText,
  WORDS,
} from "./render.js";
import { forGroup, PART_SPACING_MS } from "./speaker.js";
import {
  wamidHash,
  type ChatKey,
  type Group,
  type Installation,
} from "./store.js";
import type { GroupJob, MessageJob } from "./webhook.js";
import type { Worker } from "./worker.js";

/**
 * Groups (WA-22): the conversations of a group the
 * number created from the application's Ship card. Meta's Groups API is
 * open to a number with Official Business Account status only; a group is
 * invite-only (its invite link), at most 8 people, and takes text, media and
 * templates but **no interactive message** (read 25 October 2026).
 *
 * In a group the application answers only when it is addressed: its name
 * or the business's written in the message, the number @-mentioned, or a
 * reply to one of the number's own messages. Then, as Datalayer's rules
 * say for a channel: nothing while the installation is paused, the group's
 * rule is off (the channel rule `deny`, set from the card) or the
 * application is kept to direct conversations (`direct_only`). The person
 * who asks must have linked their Datalayer account (visitors wait on
 * WA-03 and WA-10); told so in the group once a day. One session per group
 * (`hostSessionUid` over the account, the number and the group's id), each
 * turn run as the person who asked, quotas charged to them; one turn at a
 * time in a group. The answer's words and documents are written in the
 * group; what only a 1:1 chat takes — buttons, lists, a one-use link to
 * Datalayer, an approval's card — goes to the person's own chat, with a
 * short pointer in the group. The 1:1 words (`help`, `link`, `stop`…) are
 * not read in a group.
 */

/** What is said in a group. */
export const GROUP_WORDS = {
  disclosure: (application: string, business: string, support: string) =>
    `You're talking to ${application}, an application run by ${business} on Datalayer. Mention it or name it to ask; approvals and questions come in your own chat with ${business}. To reach a person: ${support}.`,
  linkFirst: (application: string, business: string) =>
    `${application} answers people who linked their Datalayer account. Write \`link\` to ${business} in your own chat with it first.`,
  busy: "An answer is running in this group: ask again once it is written.",
  inYourChat: (who: string, business: string) =>
    `${who}the rest is in your own chat with ${business}.`,
  writeFirst: (who: string, business: string) =>
    `${who}the rest needs your own chat with ${business}: write to it there, then ask again.`,
  approval: (who: string, business: string) =>
    `${who}an approval waits for you in your own chat with ${business}.`,
  signIn: (who: string, business: string) =>
    `${who}a sign-in waits for you in your own chat with ${business}.`,
  refused:
    "Datalayer did not let this group use the application. Ask the business.",
} as const;

/** A person's name as a pointer's start: `Alice, `, or nothing. */
const whoOf = (name: string | undefined): string => {
  const cut = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return cut ? `${cut}, ` : "";
};

/** Whether `text` names `name` as a word of its own, in any case. */
export function names(text: string, name: string): boolean {
  const wanted = name.trim();
  if (wanted.length < 2) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])@?${escaped}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

/**
 * A group message's question, without any @-mention's phone number (a
 * mention of the number, or of another participant, is written by WhatsApp
 * as `@` and their number): those never reach Datalayer.
 */
export function promptOf(text: string): string {
  return text.replace(/@\+?\d[\d\s-]{4,18}\d/g, "@someone").trim();
}

/** A person named in a claim's key by a hash, never as they are. */
const personKey = (userId: string): string =>
  createHash("sha256").update(userId).digest("hex").slice(0, 32);

export class GroupConversations {
  constructor(readonly worker: Worker) {}

  get deps() {
    return this.worker.deps;
  }

  /** A message written in a group of the number. */
  async message(
    job: MessageJob & Readonly<{ groupId: string }>,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const { store, logger, clock } = this.deps;
    const group = await store.group(job.phoneNumberId, job.groupId);
    // A group the card did not create, or one Meta suspended: nothing said.
    if (!group || group.state !== "active") {
      logger.info("group.message_ignored", {
        reason: group ? group.state : "unknown-group",
      });
      return;
    }
    if (job.system || job.reaction || job.type === "reaction") return;
    const text = job.text ?? job.media?.caption ?? "";
    const self = await this.deps.hosts.self(hostKey);
    const appName = (uid: string | undefined) =>
      self.deployments.find((one) => one.uid === uid)?.appName ||
      "The application";
    const rule = self.channels.find((one) => one.id === job.groupId);
    const resolution = await resolveApplication({
      allowances: self.deployments.map((one) => ({
        applicationId: one.uid,
        channelPolicy: self.directOnly.includes(one.uid)
          ? ("direct-only" as const)
          : ("channels" as const),
        enabled: true,
        name: one.appName || one.uid,
      })),
      channel: async () =>
        rule
          ? {
              state: rule.state,
              ...(rule.deployment ? { applicationId: rule.deployment } : {}),
            }
          : undefined,
      defaultApplication: async () => self.defaultDeployment,
      next: async () => undefined,
      visibility: "channel",
    });
    const name = resolution.ok
      ? appName(resolution.applicationId)
      : appName(self.defaultDeployment);
    const ours = job.replyTo
      ? (await store.status(job.replyTo))?.phoneNumberId === job.phoneNumberId
      : false;
    const addressed =
      Boolean(job.mentioned) ||
      ours ||
      names(text, name) ||
      names(text, installation.businessName);
    if (!addressed) return;
    // Paused, the group off, the application kept to direct conversations:
    // the application says nothing in the group.
    if (installation.state === "paused" || self.paused || !resolution.ok) {
      logger.info("group.not_answered", {
        reason:
          installation.state === "paused" || self.paused
            ? "paused"
            : resolution.ok
              ? "allowed"
              : resolution.refusal,
      });
      return;
    }
    const sayHere = (messages: readonly Outgoing[], spacing = 0) =>
      this.worker.speaker.sayInGroup(
        installation,
        job.groupId,
        messages,
        spacing,
      );
    const link = await this.deps.hosts.linkState(hostKey, job.userId);
    if (!link.linked) {
      const day = new Date(clock.now()).toISOString().slice(0, 10);
      if (
        await store.claimEvent(
          `said:group-link:${job.phoneNumberId}:${wamidHash(job.groupId).slice(0, 24)}:${personKey(job.userId)}:${day}`,
        )
      )
        await sayHere([
          {
            text: GROUP_WORDS.linkFirst(name, installation.businessName),
            type: "text",
          },
        ]);
      return;
    }
    const prompt = promptOf(text);
    if (!prompt) return;
    await this.ask(job, installation, hostKey, group, {
      appName: name,
      applicationId: resolution.applicationId,
      principalUid: link.principalUid ?? "",
      prompt,
    });
  }

  /** The group's turn, once the question is the application's to answer. */
  async ask(
    job: MessageJob & Readonly<{ groupId: string }>,
    installation: Installation,
    hostKey: string,
    group: Group,
    turn: Readonly<{
      appName: string;
      applicationId: string;
      principalUid: string;
      prompt: string;
    }>,
  ): Promise<void> {
    const { store, clock, logger } = this.deps;
    const speaker = this.worker.speaker;
    const sayHere = (messages: readonly Outgoing[], spacing = 0) =>
      speaker.sayInGroup(installation, job.groupId, messages, spacing);
    // The group's conversation: a chat row named by the group's id.
    const chat: ChatKey & Readonly<{ wabaId: string }> = {
      phoneNumberId: job.phoneNumberId,
      userId: job.groupId,
      wabaId: job.wabaId,
    };
    const kept = await store.recordInbound(chat, new Date(job.at));
    if (await store.markDisclosed(chat))
      await sayHere([
        {
          text: GROUP_WORDS.disclosure(
            turn.appName,
            installation.businessName,
            installation.support,
          ),
          type: "text",
        },
      ]);
    const owner = `${wamidHash(job.wamid).slice(0, 24)}:${this.worker.instance}`;
    const claim = await store.claimTurn(
      chat,
      owner,
      new Date(clock.now() + 5 * 60 * 1000),
      new Date(clock.now()),
    );
    if (!claim.ok) {
      if (claim.owner.startsWith(`${owner.split(":")[0]}:`)) return;
      return sayHere([{ text: GROUP_WORDS.busy, type: "text" }]);
    }
    try {
      const refused = await this.worker.charge(
        job,
        installation,
        turn.applicationId,
      );
      if (refused) return await sayHere([{ text: refused, type: "text" }]);
      await speaker.markRead(installation, job.wamid);
      const same =
        Boolean(kept.sessionUid) &&
        kept.sessionDeployment === turn.applicationId;
      const request: WhatsAppTurnRequest = {
        applicationId: turn.applicationId,
        externalEventId: `whatsapp:${wamidHash(job.wamid)}`,
        externalUserId: job.userId,
        principalId: turn.principalUid,
        prompt: turn.prompt,
        provenance: {
          groupId: job.groupId,
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
          logger.warn("group.turn_refused", { status: error.status });
          return await sayHere([
            {
              text: [401, 403, 404].includes(error.status)
                ? GROUP_WORDS.refused
                : secretBearing(error.detail)
                  ? WORDS.failed
                  : error.detail,
              type: "text",
            },
          ]);
        }
        logger.error("group.turn_failed", { error });
        return await sayHere([{ text: WORDS.failed, type: "text" }]);
      }
      this.deps.metrics.count("turns");
      const sessionId = stream.sessionId;
      await store.setSession(chat, {
        deploymentUid: turn.applicationId,
        sessionUid: sessionId,
        unshown: true,
      });
      await store.setTurnSession(chat, owner, sessionId, turn.applicationId);
      const state = new TurnState();
      let secret = false;
      let lastRenew = clock.now();
      const signIns = new Set<string>();
      for await (const event of stream.updates) {
        state.apply(event);
        if (!secret && secretBearing(shownText(state))) secret = true;
        // A company's sign-in (WA-42) is the asker's alone: never in the group.
        if (event.kind === "sign-in" && !signIns.has(event.toolCallId)) {
          signIns.add(event.toolCallId);
          logger.info("group.sign_in", { mode: event.signIn.mode });
          await this.signIn(
            installation,
            job.groupId,
            job.userId,
            job.profileName,
            event.signIn,
          );
        }
        if (state.ended) break;
        if (clock.now() - lastRenew >= 60 * 1000) {
          lastRenew = clock.now();
          await store.renewTurn(
            chat,
            owner,
            new Date(lastRenew + 5 * 60 * 1000),
          );
        }
      }
      if (!state.ended)
        state.apply({ kind: "error", message: WORDS.endedEarly });
      // A question ends the turn as well as a completion does.
      if (state.ending === "stop" || state.ending === "error") {
        await store.markShown(chat, sessionId);
        if (state.ending === "error")
          await sayHere([{ text: WORDS.failed, type: "text" }]);
        return;
      }
      const person: Person = {
        deploymentUid: turn.applicationId,
        hostKey,
        userId: job.userId,
      };
      const messages = await speaker.answer(
        installation,
        person,
        sessionId,
        state.answer,
        { files: state.files, secret },
      );
      if (!(await store.markShown(chat, sessionId))) return;
      await this.show(
        installation,
        job.groupId,
        job.userId,
        job.profileName,
        messages,
        {
          ...(state.asking ? { asking: state.asking } : {}),
          sessionUid: sessionId,
        },
      );
    } finally {
      await store.releaseTurn(chat, owner);
    }
  }

  /**
   * A sign-in asked in a group's turn: its button or code in the asker's own
   * chat while its window is open, with a pointer in the group; else the
   * group is told to write to the number first. Its link is never posted in
   * the group.
   */
  async signIn(
    installation: Installation,
    groupId: string,
    userId: string,
    profileName: string | undefined,
    waiting: PapSignInWaiting,
  ): Promise<void> {
    const speaker = this.worker.speaker;
    const own: ChatKey = { phoneNumberId: installation.phoneNumberId, userId };
    const who = whoOf(profileName);
    if (!(await this.deps.window.open(own))) {
      await speaker.sayInGroup(installation, groupId, [
        {
          text: GROUP_WORDS.writeFirst(who, installation.businessName),
          type: "text",
        },
      ]);
      return;
    }
    await speaker.say(installation, userId, renderSignIn(waiting));
    await speaker.sayInGroup(installation, groupId, [
      {
        text: GROUP_WORDS.signIn(who, installation.businessName),
        type: "text",
      },
    ]);
  }

  /**
   * An answer in a group: its words and documents there; what only a 1:1
   * chat takes in the person's own chat while its window is open, with a
   * pointer in the group; a question the same way (its words in the group
   * when the person's chat is closed).
   */
  async show(
    installation: Installation,
    groupId: string,
    userId: string,
    profileName: string | undefined,
    messages: readonly Outgoing[],
    extras: Readonly<{
      asking?: AskQuestion;
      sessionUid: string;
    }>,
  ): Promise<void> {
    const speaker = this.worker.speaker;
    const { store } = this.deps;
    const own: ChatKey = { phoneNumberId: installation.phoneNumberId, userId };
    const open = await this.deps.window.open(own);
    const parts = forGroup(messages);
    const question = extras.asking ? renderQuestion(extras.asking) : undefined;
    const personal = [...parts.personal];
    const inGroup = [...parts.group];
    if (question) {
      if (question.type === "text") inGroup.push(question);
      else personal.push(question);
    }
    const who = whoOf(profileName);
    if (personal.length)
      inGroup.push({
        text: open
          ? GROUP_WORDS.inYourChat(who, installation.businessName)
          : GROUP_WORDS.writeFirst(who, installation.businessName),
        type: "text",
      });
    if (!inGroup.length) inGroup.push({ text: WORDS.endedEarly, type: "text" });
    await speaker.sayInGroup(installation, groupId, inGroup, PART_SPACING_MS);
    if (personal.length && open) {
      await speaker.say(installation, userId, personal);
      if (
        question &&
        question.type !== "text" &&
        extras.asking?.options?.length
      )
        await store.setAsking(own, {
          groupId,
          options: [...extras.asking.options],
          sessionUid: extras.sessionUid,
        });
    }
  }

  /** What Meta says became of the number's groups. */
  async event(job: GroupJob): Promise<void> {
    const { store, logger } = this.deps;
    const installation = await store.installation(
      job.wabaId,
      job.phoneNumberId,
    );
    if (!installation || installation.state === "removed") return;
    const groups = await store.groups(job.phoneNumberId);
    for (const event of job.events) {
      const byId = event.groupId
        ? groups.find((one) => one.groupId === event.groupId)
        : undefined;
      if (event.type === "group_create") {
        // Matched by Meta's request, else by the subject of a group being made.
        const made =
          byId ??
          groups.find(
            (one) => event.requestId && one.requestId === event.requestId,
          ) ??
          groups.find(
            (one) => one.state === "creating" && one.subject === event.subject,
          );
        if (!made) {
          logger.info("group.unknown", { type: event.type });
          continue;
        }
        if (event.failed || !event.groupId)
          await store.updateGroup(job.phoneNumberId, made.ref, {
            state: "failed",
          });
        else
          await store.updateGroup(job.phoneNumberId, made.ref, {
            groupId: event.groupId,
            state: "active",
          });
        logger.info("group.created", { failed: event.failed });
      } else if (event.type === "group_delete" && byId && !event.failed) {
        await store.deleteGroup(job.phoneNumberId, byId.ref);
        logger.info("group.deleted", {});
      } else if (event.type === "group_suspend" && byId) {
        await store.updateGroup(job.phoneNumberId, byId.ref, {
          state: "suspended",
        });
        logger.warn("group.suspended", {});
      } else if (event.type === "group_suspend_cleared" && byId) {
        await store.updateGroup(job.phoneNumberId, byId.ref, {
          state: "active",
        });
        logger.info("group.suspension_cleared", {});
      } else
        logger.info("group.event", {
          participants: event.participants ?? 0,
          type: event.type,
        });
    }
  }
}
