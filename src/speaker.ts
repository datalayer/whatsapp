import type {
  AskQuestion,
  Clock,
  Logger,
  SecretCipher,
  TurnFile,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { AsPerson, Person } from "./as-person.js";
import type { MetaPort, Outgoing } from "./meta-port.js";
import {
  openButton,
  renderAnswer,
  renderQuestion,
  secretBearing,
  WORDS,
} from "./render.js";
import {
  installationData,
  type ChatKey,
  type HoldKind,
  type Installation,
} from "./store.js";
import type { WindowKeeper } from "./window.js";

/**
 * How the number speaks to one person: every message sent with the
 * installation's business token (decrypted only to send), counted as Meta's
 * meter counts it, the parts of one answer spaced apart; what is said
 * outside the 24-hour window held and noticed by the window keeper; an
 * answer made into its messages (`answer`), with *Open in Datalayer* as a
 * one-use link for the person.
 */

/** The spacing between the messages of one answer (Meta's pair rate limit). */
export const PART_SPACING_MS = 10_000;

/** What a hold refers to: a session's answer, or an approval, by the deployment that runs it. */
export const holdRef = (deploymentUid: string, id: string): string =>
  `${deploymentUid} ${id}`;
export function refOf(
  ref: string,
): { deploymentUid: string; id: string } | undefined {
  const [deploymentUid, id, ...rest] = ref.split(" ");
  return deploymentUid && id && rest.length === 0
    ? { deploymentUid, id }
    : undefined;
}

export type SpeakerDependencies = Readonly<{
  port: MetaPort;
  cipher: SecretCipher;
  window: WindowKeeper;
  asPerson: Pick<AsPerson, "handoff">;
  clock: Clock;
  logger: Logger;
  /** Datalayer's web origin: where *Open in Datalayer* leads. */
  webUrl: string;
}>;

export class Speaker {
  constructor(readonly deps: SpeakerDependencies) {}

  /** The installation's business token; none once it was removed. */
  token(installation: Installation): string {
    if (!installation.businessToken)
      throw new Error("A removed installation has no business token.");
    return this.deps.cipher.decrypt(
      installation.businessToken,
      installationData(
        "business-token",
        installation.wabaId,
        installation.phoneNumberId,
      ),
    );
  }

  /** Send messages to a person in order, `spacingMs` apart; each counted as a service message. */
  async say(
    installation: Installation,
    userId: string,
    messages: readonly Outgoing[],
    spacingMs = 0,
  ): Promise<void> {
    const token = this.token(installation);
    for (const [index, message] of messages.entries()) {
      if (index > 0 && spacingMs > 0) await this.deps.clock.sleep(spacingMs);
      await this.deps.port.send(
        token,
        installation.phoneNumberId,
        userId,
        message,
      );
      await this.deps.window.sent(installation.phoneNumberId, "service");
    }
  }

  /** The read mark and typing indicator; a failure is logged, never the turn's. */
  async markRead(installation: Installation, wamid: string): Promise<void> {
    try {
      await this.deps.port.markRead(
        this.token(installation),
        installation.phoneNumberId,
        wamid,
      );
    } catch (error) {
      this.deps.logger.warn("message.not_marked_read", { error });
    }
  }

  /** A reaction on the person's message (an empty emoji removes it); a failure is logged. */
  async react(
    installation: Installation,
    userId: string,
    wamid: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.deps.port.send(
        this.token(installation),
        installation.phoneNumberId,
        userId,
        { emoji, messageId: wamid, type: "reaction" },
      );
    } catch (error) {
      this.deps.logger.warn("reaction.not_changed", { error });
    }
  }

  /** A one-use *Open in Datalayer* link for the person. */
  async openUrl(
    person: Person,
    kind: "session" | "approval",
    target: string,
  ): Promise<string> {
    const path = await this.deps.asPerson.handoff(person, kind, target);
    return `${this.deps.webUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  /**
   * Something to say outside a turn (a delivery, an approval): said now
   * inside the window (`show`); outside it held by reference, with the
   * window's one notice. Answers what became of it.
   */
  async reach(
    installation: Installation,
    chat: ChatKey,
    held: Readonly<{ kind: HoldKind; ref: string }>,
    appName: string,
    show: () => Promise<void>,
  ): Promise<"now" | "notice" | "held" | "unreachable"> {
    const route = await this.deps.window.route(chat, held, appName);
    if (route.send === "now") await show();
    else if (route.send === "notice") {
      await this.deps.port.send(
        this.token(installation),
        installation.phoneNumberId,
        chat.userId,
        { type: "template", ...route.template },
      );
      await this.deps.window.sent(installation.phoneNumberId, "utility");
    }
    return route.send;
  }

  /**
   * An answer as its messages: the words (at most four messages), the
   * Markdown document when it needs one with *Open in Datalayer*, the
   * files it names, the question it ends on. Anything holding a credential
   * is *Open in Datalayer* only.
   */
  async answer(
    installation: Installation,
    person: Person,
    sessionUid: string,
    answer: string,
    extras: Readonly<{
      secret?: boolean;
      asking?: AskQuestion;
      files?: readonly TurnFile[];
    }> = {},
  ): Promise<Outgoing[]> {
    const open = () => this.openUrl(person, "session", sessionUid);
    const files = extras.files ?? [];
    const filesText = files.length
      ? `Files:\n${files.map((one) => `- ${one.name}: ${one.url}`).join("\n")}`
      : "";
    if (
      extras.secret ||
      secretBearing(
        [
          answer,
          filesText,
          extras.asking?.prompt ?? "",
          ...(extras.asking?.options ?? []),
        ].join("\n"),
      )
    )
      return [openButton(WORDS.private, await open())];
    const rendered = renderAnswer(answer);
    const messages: Outgoing[] = rendered.messages.map((text) => ({
      text,
      type: "text",
    }));
    if (rendered.document) {
      const mediaId = await this.deps.port.upload(
        this.token(installation),
        installation.phoneNumberId,
        {
          bytes: new TextEncoder().encode(rendered.document.text),
          filename: rendered.document.filename,
          mimeType: "text/markdown",
        },
      );
      messages.push({
        caption: rendered.document.caption,
        filename: rendered.document.filename,
        mediaId,
        type: "document",
      });
      messages.push(
        openButton("The answer is also in Datalayer.", await open()),
      );
    }
    if (filesText) messages.push({ text: filesText, type: "text" });
    if (extras.asking) {
      const question = renderQuestion(extras.asking);
      messages.push(question ?? openButton(extras.asking.prompt, await open()));
    }
    if (messages.length === 0)
      messages.push({ text: WORDS.endedEarly, type: "text" });
    return messages;
  }
}
