import {
  renderApproval,
  type ApprovalPresentation,
  type HostDelivery,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import {
  approvalPressId,
  WORDS,
  type ApprovalChoice,
} from "../../src/render.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import { harness, mailPresentation, type Harness } from "../support/worker.js";

/**
 * A company's operation confirmed from WhatsApp (WA-43, decided by the user
 * 28 October 2026: `pap_confirm` may be decided from a host). On each store:
 * the card names the company and the operation's exact revision and offers
 * Approve and Reject; the two steps decide it at Datalayer as the linked
 * person, on the digest of that revision; a press on a revision the company
 * has since changed decides nothing and the new revision's card is sent; a
 * decision Datalayer finds stale says so. The person is the linked one:
 * the gateway records the approval under the person's pairwise id at the
 * company (`approved_by`), never their BSUID or Datalayer uid.
 */

const PAP_ARGS = {
  class: "write",
  company: "manzanita.example",
  digest: "d".repeat(64),
  key: "k-1",
  only_the_person: false,
  operation_ref: "op-7",
  revision: 3,
  session: { ref: "s-ref", signed_in: true },
  summary: "Book a table for two at 20:00.",
  terms: { party: 2, price: "0 EUR" },
};

/** A `pap_confirm` as ai-agents presents it since WA-43: a host may decide it. */
function papPresentation(
  revision = 3,
  overrides: Partial<ApprovalPresentation> = {},
): ApprovalPresentation {
  return mailPresentation({
    action_class: "unknown",
    arguments: { ...PAP_ARGS, revision },
    complete: true,
    digest: String(revision).repeat(64).slice(0, 64),
    fields: [
      { label: "Company", name: "company", value: "manzanita.example" },
      {
        label: "Summary",
        name: "summary",
        value: "Book a table for two at 20:00.",
      },
    ],
    host_may_decide: true,
    reasons: [],
    tool_name: "pap_confirm",
    ...overrides,
  });
}

async function shown(h: Harness, presentation: ApprovalPresentation) {
  await h.connect();
  await h.store.recordInbound(
    { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
    new Date(h.clock.now()),
  );
  h.asPerson.approvals.set(presentation.approval_id, {
    owner: ALICE,
    presentation,
  });
  const delivery: HostDelivery = {
    delivery: `dl-${presentation.approval_id}-${presentation.digest.slice(0, 4)}`,
    event: "approval.requested",
    payload: {
      approval_id: presentation.approval_id,
      deployment_uid: "dep-desk",
      presentation: "v1",
      session_uid: presentation.session_uid,
      target: { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE },
      tool_name: presentation.tool_name,
    },
  };
  await h.worker.handle({
    delivery,
    hostUid: `host-${PHONE_NUMBER_ID}`,
    kind: "delivery",
  });
}

const press = (h: Harness, choice: ApprovalChoice) =>
  h.worker.handle(
    h.job(undefined, {
      reply: { id: approvalPressId(choice, "ap-1"), title: choice },
      text: undefined,
      type: "interactive",
    }),
  );

type Card = { body: string; type: string; buttons?: Array<{ id: string }> };
const last = (h: Harness) => h.meta.sent().at(-1) as Card;

/**
 * Whether the hosts kit renders `pap_confirm` (agent-runtimes after 1.5.89):
 * before it, the card stays *Review in Datalayer* and the cases deciding it
 * from the chat are skipped, said here, never passed.
 */
const KIT_DECIDES_PAP = renderApproval(papPresentation()).complete;

describe.each(storeCases())("a PAP operation on $name", ({ store }) => {
  it.skipIf(!KIT_DECIDES_PAP)(
    "is confirmed from the chat in two steps, on its exact revision, as the linked person",
    async () => {
      const h = harness(store());
      await shown(h, papPresentation());
      const card = last(h);
      expect(card.type).toBe("buttons");
      expect(card.body).toContain(
        "asks you to confirm an operation at manzanita.example, exactly revision 3.",
      );
      expect(card.body).toContain("*Revision:* 3");
      expect(card.body).toContain("*price:* 0 EUR");
      await press(h, "approve");
      const step = last(h);
      expect(step.body).toMatch(
        /^Approve: confirm at manzanita\.example, revision 3/,
      );
      expect(step.buttons?.map((one) => one.id)).toEqual([
        approvalPressId("yes-approve", "ap-1"),
        approvalPressId("no", "ap-1"),
      ]);
      await press(h, "yes-approve");
      // Decided at Datalayer as the linked person, on the revision shown.
      expect(h.asPerson.decisions).toEqual([
        {
          approvalId: "ap-1",
          approve: true,
          digest: "3".repeat(64),
          userId: ALICE,
        },
      ]);
      expect(h.meta.said().at(-1)).toMatch(
        /^Approved by you at \d\d:\d\d UTC\.$/,
      );
      // Nothing of who the person is at Datalayer or at the company is said.
      const said = h.meta.said().join("\n");
      expect(said).not.toContain(`principal-${ALICE}`);
      expect(said).not.toContain(ALICE);
    },
  );

  it.skipIf(!KIT_DECIDES_PAP)(
    "refuses a press on a revision the company changed, and sends the new revision's card",
    async () => {
      const h = harness(store());
      await shown(h, papPresentation(3));
      // The company proposes revision 4 before the person answers.
      h.asPerson.approvals.get("ap-1")!.presentation = papPresentation(4);
      await press(h, "approve");
      expect(h.meta.said().slice(-2)[0]).toBe(WORDS.changed);
      expect(last(h).body).toContain("exactly revision 4");
      expect(h.asPerson.decisions).toEqual([]);
      // The new card decides revision 4, and only it.
      await press(h, "approve");
      await press(h, "yes-approve");
      expect(h.asPerson.decisions).toEqual([
        {
          approvalId: "ap-1",
          approve: true,
          digest: "4".repeat(64),
          userId: ALICE,
        },
      ]);
    },
  );

  it.skipIf(!KIT_DECIDES_PAP)(
    "says This changed when Datalayer finds the revision stale at the decision",
    async () => {
      const h = harness(store());
      await shown(h, papPresentation(3));
      await press(h, "approve");
      // Between the second step and the decision, Datalayer's digest moved on.
      const kept = h.asPerson.approvals.get("ap-1")!;
      const original = kept.presentation;
      let reads = 0;
      Object.defineProperty(kept, "presentation", {
        configurable: true,
        get: () => (reads++ === 0 ? original : papPresentation(5)),
        set: () => {},
      });
      await press(h, "yes-approve");
      expect(h.meta.said().at(-1)).toBe(WORDS.changed);
      expect(h.asPerson.decisions).toEqual([]);
    },
  );

  it("stays Review in Datalayer for a pap_confirm Datalayer does not let a host decide", async () => {
    const h = harness(store());
    await shown(
      h,
      papPresentation(3, {
        host_may_decide: false,
        reasons: ["It does not say revision: it is decided in Datalayer."],
      }),
    );
    expect(last(h).type).toBe("cta");
    await press(h, "yes-approve");
    expect(h.asPerson.decisions).toEqual([]);
  });
});
