import {
  HostRefusedError,
  type DatalayerHostClient,
  type HostSelf,
  type Logger,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { ChatKey, WhatsAppStore } from "./store.js";
import type { WindowKeeper } from "./window.js";

/**
 * The words a person writes to the number, alone in a message: `help`,
 * `status`, `app`, `start over`, `stop`, `link`, `unlink`, `forget`. A word is the
 * whole message, any case, any spacing around and between its words; inside
 * a sentence it is the sentence, and goes to the application. Each word
 * answers with what it did, or why it did nothing (no silent degradation).
 *
 * What a word answers is a `Reply`: text, a button opening a page, or a list
 * to choose from. The worker sends them as WhatsApp messages; a chat is
 * always inside its 24-hour window here, since the person just wrote.
 */

export const WORDS = [
  "help",
  "status",
  "app",
  "start over",
  "stop",
  "link",
  "unlink",
  "forget",
] as const;
export type Word = (typeof WORDS)[number];

/** What a list row's id starts with when it chooses an application. */
export const APP_CHOICE = "app:";

/** Something to say: text, a button opening a page, or a list to choose from. */
export type Reply =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "button"; text: string; label: string; url: string }>
  | Readonly<{
      kind: "list";
      text: string;
      label: string;
      rows: ReadonlyArray<
        Readonly<{ id: string; title: string; description?: string }>
      >;
    }>;

/**
 * Who is writing, as the worker found it: a person whose Datalayer account
 * is linked to their BSUID; a visitor, when the number's application admits
 * people without an account; or neither (`private`).
 */
export type Standing = "linked" | "visitor" | "private";

export type CommandContext = Readonly<{
  chat: ChatKey & Readonly<{ wabaId: string }>;
  /** The installation's key at ai-agents (decrypted by the worker). */
  hostKey: string;
  /** The name the person gave WhatsApp, shown when they link. */
  profileName?: string;
  standing: Standing;
  /** The business's name, as the disclosure line says it. */
  business: string;
  /** How to reach a person at the business: a phone, a mail address, a page. */
  support: string;
  /** The turn running in this chat, when one is. */
  turn?: Readonly<{ stop(): Promise<void> }>;
}>;

export type CommandDependencies = Readonly<{
  store: WhatsAppStore;
  window: WindowKeeper;
  hosts: Pick<DatalayerHostClient, "linkCode" | "self" | "unlink">;
  /** Datalayer's web origin, where a link is confirmed. */
  webUrl: string;
  logger: Logger;
}>;

/** WhatsApp's limits on a list: ten rows, titles of 24 characters. */
const LIST_ROWS = 10;
const ROW_TITLE = 24;

export const SAY = {
  notLinked:
    "This number's application is private. Write `link` to connect your Datalayer account.",
  linkedAlready:
    "Your Datalayer account is linked here already. `unlink` ends it.",
  linkFirst:
    "Only a linked Datalayer account chooses the application. Write `link` first.",
  visitorsTalkToDefault:
    "Visitors talk to this number's own application; choosing another takes a linked Datalayer account.",
  noApplication: "No application answers on this number yet.",
  notAllowed: "That application is not one this number allows. Write `app`.",
  stopFirst: "An answer is running. Write `stop` first, then `start over`.",
  stopBeforeSwitch:
    "An answer is running. Write `stop` first, then choose the application again.",
  stopped: "Stopped.",
  noticesStopped:
    "Nothing is running, so no more notices from this number after a day of silence. Your questions are still answered.",
  notLinkedHere: "No Datalayer account is linked here.",
  unlinked:
    "Your Datalayer account is unlinked from this number. `link` links it again. Your sign-ins at companies (Settings → Connections in Datalayer) are not changed: disconnect them there.",
  linkUnavailable:
    "Datalayer did not give a link just now. Nothing was changed; try again in a moment.",
} as const;

/** The word a message is, or nothing: the whole message, any case and spacing. */
export function wordOf(text: string | undefined): Word | undefined {
  if (text === undefined) return undefined;
  const said = text.trim().replace(/\s+/g, " ").toLowerCase();
  return (WORDS as readonly string[]).includes(said)
    ? (said as Word)
    : undefined;
}

/** The deployment a list row chose, or nothing when the row is not a choice. */
export function choiceOf(replyId: string | undefined): string | undefined {
  if (!replyId?.startsWith(APP_CHOICE)) return undefined;
  const uid = replyId.slice(APP_CHOICE.length);
  return uid ? uid : undefined;
}

/**
 * What answers in every chat before the first answer, and in `help`: who is
 * talking, whose it is, and how to reach a person (WhatsApp's policy asks
 * for a prompt, clear way to one).
 */
export function disclosure(
  application: string | undefined,
  business: string,
  support: string,
): string {
  const who = application
    ? `You're talking to ${application}, an application run by ${business} on Datalayer.`
    : `This is ${business}'s number on Datalayer. ${SAY.noApplication}`;
  return `${who} To reach a person: ${support}. Write \`help\` for what I can do.`;
}

const HELP: Readonly<Record<Word, string>> = {
  help: "what answers here, and these words",
  status: "your link, the application, what runs",
  app: "choose the application (linked accounts)",
  "start over": "a new conversation from here",
  stop: "stop the running answer; with none, no more notices",
  link: "link your Datalayer account",
  unlink: "unlink it",
  forget: "unlink, and delete everything this number keeps of you",
};

const installationOf = (context: CommandContext): string =>
  `${context.chat.wabaId}:${context.chat.phoneNumberId}`;

const nameOf = (self: HostSelf, uid: string | undefined): string | undefined =>
  uid ? self.deployments.find((one) => one.uid === uid)?.appName : undefined;

/** The deployment this chat talks to: the person's choice, else the number's default. */
async function currentOf(
  context: CommandContext,
  dependencies: CommandDependencies,
  self: HostSelf,
): Promise<string | undefined> {
  const chat = await dependencies.store.chat(context.chat);
  const chosen = chat?.applicationId;
  if (chosen && self.deployments.some((one) => one.uid === chosen))
    return chosen;
  return self.defaultDeployment;
}

const text = (said: string): Reply => ({ kind: "text", text: said });

/** Do what a word says, as this person in this chat, and answer what was done. */
export async function runWord(
  word: Word,
  context: CommandContext,
  dependencies: CommandDependencies,
): Promise<Reply[]> {
  const { hosts, logger, store } = dependencies;
  switch (word) {
    case "help": {
      const self = await hosts.self(context.hostKey);
      const application = nameOf(
        self,
        await currentOf(context, dependencies, self),
      );
      const words = WORDS.map((one) => `• \`${one}\`: ${HELP[one]}`);
      return [
        text(
          `${disclosure(application, context.business, context.support)}\n\nWrite one of these words alone in a message:\n${words.join("\n")}`,
        ),
      ];
    }
    case "status": {
      const self = await hosts.self(context.hostKey);
      const application = nameOf(
        self,
        await currentOf(context, dependencies, self),
      );
      const lines = [
        context.standing === "linked"
          ? "Your Datalayer account is linked here."
          : context.standing === "visitor"
            ? "You're a visitor: nothing of you is kept beyond this conversation."
            : "Your Datalayer account is not linked: write `link`.",
        application ? `This chat talks to ${application}.` : SAY.noApplication,
        ...(self.paused ? ["The owner has paused this number."] : []),
        ...((await store.chat(context.chat))?.noticesStopped
          ? ["No notices after a day of silence: you wrote `stop`."]
          : []),
        context.turn ? "An answer is running: `stop` stops it." : "",
      ].filter(Boolean);
      return [text(lines.join("\n"))];
    }
    case "app": {
      if (context.standing === "visitor")
        return [text(SAY.visitorsTalkToDefault)];
      if (context.standing !== "linked") return [text(SAY.linkFirst)];
      const self = await hosts.self(context.hostKey);
      const current = await currentOf(context, dependencies, self);
      if (self.deployments.length === 0) return [text(SAY.noApplication)];
      if (self.deployments.length === 1)
        return [
          text(`Only ${self.deployments[0]?.appName} answers on this number.`),
        ];
      if (self.deployments.length > LIST_ROWS)
        throw new Error(
          `The number allows ${self.deployments.length} applications; a WhatsApp list shows ${LIST_ROWS}.`,
        );
      return [
        {
          kind: "list",
          label: "Applications",
          rows: self.deployments.map((one) => ({
            id: `${APP_CHOICE}${one.uid}`,
            title:
              one.appName.length > ROW_TITLE
                ? `${one.appName.slice(0, ROW_TITLE - 1)}…`
                : one.appName,
            ...(one.uid === current ? { description: "Now" } : {}),
          })),
          text: "Choose the application this chat talks to. Choosing another starts a new conversation.",
        },
      ];
    }
    case "start over": {
      if (context.standing === "private") return [text(SAY.notLinked)];
      if (context.turn) return [text(SAY.stopFirst)];
      await store.startOver(context.chat);
      return [
        text("Started over: your next message opens a new conversation."),
      ];
    }
    case "stop": {
      // With no answer running, `stop` is WhatsApp's opt-out: no notices.
      if (!context.turn) {
        await dependencies.window.stop(context.chat);
        return [text(SAY.noticesStopped)];
      }
      await context.turn.stop();
      return [text(SAY.stopped)];
    }
    case "link": {
      if (context.standing === "linked") return [text(SAY.linkedAlready)];
      let code: { code: string; expiresIn: number };
      try {
        code = await hosts.linkCode(
          context.hostKey,
          context.chat.userId,
          context.profileName,
        );
      } catch (error) {
        // A key Datalayer no longer knows is a removed installation, not a
        // moment's refusal: it fails loudly.
        if (
          !(error instanceof HostRefusedError) ||
          error.status === 401 ||
          error.status === 403
        )
          throw error;
        logger.warn("link.code_refused", { error, status: error.status });
        return [text(SAY.linkUnavailable)];
      }
      const minutes = Math.max(1, Math.round(code.expiresIn / 60));
      return [
        {
          kind: "button",
          label: "Link",
          text: `Link your Datalayer account: sign in to Datalayer, check what it shows and confirm. The link works once, for ${minutes} minutes.`,
          url: `${dependencies.webUrl.replace(/\/+$/, "")}/hosts/link?code=${encodeURIComponent(code.code)}`,
        },
      ];
    }
    case "forget": {
      // Unlinked at Datalayer whatever the standing (a link made elsewhere
      // ends too), then every row naming the person here deleted.
      const revoked = await hosts.unlink(context.hostKey, context.chat.userId);
      if (revoked)
        logger.audit("identity.unlinked", {
          installation: installationOf(context),
          reason: "forget",
          user: context.chat.userId,
        });
      const deleted = await store.forget(context.chat.userId);
      logger.info("person.forgotten", { rows: deleted });
      return [
        text(
          `Done: ${revoked ? "your Datalayer account is unlinked from this number, and " : ""}${deleted} record${deleted === 1 ? "" : "s"} naming you here ${deleted === 1 ? "is" : "are"} deleted. Your conversations stay in Datalayer under its record retention: delete them there. Meta keeps its own copy of the messages for up to 30 days. Your sign-ins at companies (Settings → Connections in Datalayer) are not changed: disconnect them there.`,
        ),
      ];
    }
    case "unlink": {
      if (context.standing !== "linked") return [text(SAY.notLinkedHere)];
      const revoked = await hosts.unlink(context.hostKey, context.chat.userId);
      logger.audit("identity.unlinked", {
        installation: installationOf(context),
        user: context.chat.userId,
      });
      return [text(revoked ? SAY.unlinked : SAY.notLinkedHere)];
    }
  }
}

/** A list row pressed after `app`: the chat switched to that application, in a new conversation. */
export async function chooseApplication(
  deploymentUid: string,
  context: CommandContext,
  dependencies: CommandDependencies,
): Promise<Reply[]> {
  if (context.standing === "visitor") return [text(SAY.visitorsTalkToDefault)];
  if (context.standing !== "linked") return [text(SAY.linkFirst)];
  const self = await dependencies.hosts.self(context.hostKey);
  const chosen = self.deployments.find((one) => one.uid === deploymentUid);
  if (!chosen) return [text(SAY.notAllowed)];
  if ((await currentOf(context, dependencies, self)) === chosen.uid)
    return [text(`This chat already talks to ${chosen.appName}.`)];
  if (context.turn) return [text(SAY.stopBeforeSwitch)];
  await dependencies.store.startOver(context.chat, chosen.uid);
  return [
    text(
      `This chat now talks to ${chosen.appName}: a new conversation starts with your next message.`,
    ),
  ];
}
