import {
  hostMayDecide,
  HostRefusedError,
  type ApprovalPresentation,
  type Clock,
  type Logger,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { AsPerson, Person } from "./as-person.js";
import type { Standing } from "./commands.js";
import type { Outgoing } from "./meta-port.js";
import {
  approvalCard,
  cardBody,
  confirmStep,
  decidedWords,
  openButton,
  WORDS,
  type ApprovalChoice,
} from "./render.js";
import type { Speaker } from "./speaker.js";
import type { Installation, WhatsAppStore } from "./store.js";

/**
 * Approvals in a person's chat: the card, then two steps, as a person
 * confirms a consequential action in a modal elsewhere. *Approve* or
 * *Reject* answers a second message naming the action again with *Yes* and
 * *No*; *Yes* decides at Datalayer as the person, on the digest the card
 * showed, once (claimed by the approval). A card that changed since it was
 * shown answers *This changed* and the new card; one decided, expired or
 * not the presser's answers so; a late press on an old card answers
 * *Already decided*. There is no edit: each outcome is a new message. Only
 * a linked person's own approvals reach their chat; a visitor never decides.
 * What may be decided here is what Datalayer's presentation and the kit's
 * renderers allow: mail, and since 28 October 2026 a company's `pap_confirm`
 * on its exact revision (WA-43) — a press on a revision the company has
 * since changed decides nothing and the new revision's card is sent.
 */

export type ApprovalDependencies = Readonly<{
  store: WhatsAppStore;
  speaker: Speaker;
  asPerson: AsPerson;
  clock: Pick<Clock, "now">;
  logger: Logger;
}>;

const text = (said: string): Outgoing => ({ text: said, type: "text" });

/** A refusal of the person by Datalayer: the approval is not theirs. */
const notTheirs = (error: unknown): boolean =>
  error instanceof HostRefusedError && [403, 404].includes(error.status);

export class Approvals {
  constructor(readonly deps: ApprovalDependencies) {}

  /** The card for one approval, in the person's chat, kept with the digest it shows. */
  async show(
    installation: Installation,
    person: Person,
    approvalId: string,
    appName: string,
  ): Promise<void> {
    let presentation: ApprovalPresentation;
    try {
      presentation = await this.deps.asPerson.presentation(person, approvalId);
    } catch (error) {
      if (!notTheirs(error)) throw error;
      this.deps.logger.warn("approval.not_theirs", {});
      return;
    }
    if (presentation.status !== "pending") return;
    await this.#card(installation, person, presentation, appName);
  }

  async #card(
    installation: Installation,
    person: Person,
    presentation: ApprovalPresentation,
    appName: string,
  ): Promise<Outgoing> {
    const card = await approvalCard(presentation, {
      appName,
      now: this.deps.clock.now(),
      reviewUrl: () =>
        this.deps.speaker.openUrl(person, "approval", presentation.approval_id),
    });
    await this.deps.speaker.say(installation, person.userId, [card.message]);
    await this.deps.store.saveCard({
      approvalId: presentation.approval_id,
      deploymentUid: person.deploymentUid,
      digest: presentation.digest,
      phoneNumberId: installation.phoneNumberId,
      shownAt: new Date(this.deps.clock.now()),
      toolName: presentation.tool_name,
      userId: person.userId,
    });
    return card.message;
  }

  /** A press on a card or its second step: what to say back. */
  async press(
    installation: Installation,
    hostKey: string,
    userId: string,
    standing: Standing,
    press: Readonly<{ choice: ApprovalChoice; approvalId: string }>,
    appName: string,
  ): Promise<Outgoing[]> {
    const { store, asPerson, clock } = this.deps;
    if (standing !== "linked") return [text(WORDS.linkFirst)];
    const card = await store.card(
      installation.phoneNumberId,
      userId,
      press.approvalId,
    );
    // Never shown to this person here: not theirs to press.
    if (!card) return [text(WORDS.notYours)];
    if (card.decidedStatus) return [text(WORDS.alreadyDecided)];
    if (press.choice === "no") return [text(WORDS.kept)];
    const person: Person = {
      deploymentUid: card.deploymentUid,
      hostKey,
      userId,
    };
    let presentation: ApprovalPresentation;
    try {
      presentation = await asPerson.presentation(person, press.approvalId);
    } catch (error) {
      if (notTheirs(error)) return [text(WORDS.notYours)];
      throw error;
    }
    if (presentation.status !== "pending") {
      await store.decideCard(
        installation.phoneNumberId,
        userId,
        press.approvalId,
        presentation.status,
      );
      return [text(decidedWords(presentation.status, false, clock.now()))];
    }
    if (presentation.digest !== card.digest) {
      // The request changed since its card (a PAP operation's new
      // revision): the old card decides nothing; the new one is shown.
      await this.deps.speaker.say(installation, userId, [text(WORDS.changed)]);
      await this.#card(installation, person, presentation, appName);
      return [];
    }
    if (press.choice === "more")
      return [
        openButton(
          cardBody(presentation, appName),
          await this.deps.speaker.openUrl(person, "approval", press.approvalId),
          WORDS.reviewLabel,
        ),
      ];
    if (!hostMayDecide(presentation))
      return [
        openButton(
          cardBody(presentation, appName),
          await this.deps.speaker.openUrl(person, "approval", press.approvalId),
          WORDS.reviewLabel,
        ),
      ];
    if (press.choice === "approve" || press.choice === "reject")
      return [confirmStep(presentation, press.choice === "approve")];
    return this.#decide(installation, person, presentation, card.digest, press);
  }

  async #decide(
    installation: Installation,
    person: Person,
    presentation: ApprovalPresentation,
    digest: string,
    press: Readonly<{ choice: ApprovalChoice; approvalId: string }>,
  ): Promise<Outgoing[]> {
    const { store, asPerson, clock, logger } = this.deps;
    const claim = `decision:${installation.phoneNumberId}:${press.approvalId}`;
    if (!(await store.claimEvent(claim))) return [text(WORDS.alreadyDecided)];
    let decided = false;
    try {
      let status: string;
      try {
        ({ status } = await asPerson.decide(person, press.approvalId, {
          approve: press.choice === "yes-approve",
          digest,
        }));
      } catch (error) {
        if (error instanceof HostRefusedError) {
          if (error.status === 404) return [text(WORDS.notYours)];
          if (error.status === 403 || error.status === 409)
            return [text(WORDS.changed)];
        }
        throw error;
      }
      decided = true;
      await store.decideCard(
        installation.phoneNumberId,
        person.userId,
        press.approvalId,
        status,
      );
      // The decision itself is audited at Datalayer, as the person.
      logger.info("approval.decided", {
        status,
        tool: presentation.tool_name,
      });
      return [text(decidedWords(status, true, clock.now()))];
    } finally {
      if (!decided) await store.releaseEvent(claim);
    }
  }
}
