import type {
  ApprovalPresentation,
  HostDelivery,
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
 * Approvals in a person's chat, on each store: the card, the two steps,
 * the decision as the person on the digest shown, once; the oversized
 * action, someone else's press, a replayed press, an expired approval, a
 * request that changed since its card (a PAP operation's new revision);
 * *Show more* and *Review in Datalayer* as one-use links for the person.
 */

const BOB = "US.29481203948120394812";

/** The number connected, Alice in her window, her approval's card shown. */
async function shown(
  h: Harness,
  presentation: ApprovalPresentation = mailPresentation(),
): Promise<void> {
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
    delivery: `dl-${presentation.approval_id}`,
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

const press = (
  h: Harness,
  choice: ApprovalChoice,
  approvalId = "ap-1",
  userId = ALICE,
) =>
  h.worker.handle(
    h.job(undefined, {
      reply: { id: approvalPressId(choice, approvalId), title: choice },
      text: undefined,
      type: "interactive",
      userId,
    }),
  );

describe.each(storeCases())("approvals on $name", ({ store }) => {
  it("approves in two steps, on the digest shown, as the person", async () => {
    const h = harness(store());
    await shown(h);
    await press(h, "approve");
    expect(h.meta.sent().at(-1)).toMatchObject({
      buttons: [
        { id: "ap:yes-approve:ap-1", title: "Yes, approve" },
        { id: "ap:no:ap-1", title: "No" },
      ],
      type: "buttons",
    });
    expect(h.asPerson.decisions).toEqual([]);
    await press(h, "yes-approve");
    expect(h.asPerson.decisions).toEqual([
      {
        approvalId: "ap-1",
        approve: true,
        digest: "a".repeat(64),
        userId: ALICE,
      },
    ]);
    expect(h.meta.said().at(-1)).toBe("Approved by you at 12:00 UTC.");
    // A late press on the old card.
    await press(h, "approve");
    expect(h.meta.said().at(-1)).toBe(WORDS.alreadyDecided);
  });

  it("rejects in two steps, and No keeps the request waiting", async () => {
    const h = harness(store());
    await shown(h);
    await press(h, "reject");
    await press(h, "no");
    expect(h.meta.said().at(-1)).toBe(WORDS.kept);
    await press(h, "reject");
    await press(h, "yes-reject");
    expect(h.asPerson.decisions.map((one) => one.approve)).toEqual([false]);
    expect(h.meta.said().at(-1)).toBe("Rejected by you at 12:00 UTC.");
  });

  it("decides once when the same confirmation is pressed twice", async () => {
    const h = harness(store());
    await shown(h);
    await press(h, "approve");
    await press(h, "yes-approve");
    await press(h, "yes-approve");
    expect(h.asPerson.decisions).toHaveLength(1);
    expect(h.meta.said().at(-1)).toBe(WORDS.alreadyDecided);
  });

  it("refuses someone else's press: never decided for them", async () => {
    const h = harness(store());
    await shown(h);
    h.hosts.links.add(BOB);
    await press(h, "yes-approve", "ap-1", BOB);
    expect(h.meta.said().at(-1)).toBe(WORDS.notYours);
    expect(h.meta.calls.at(-1)?.userId).toBe(BOB);
    expect(h.asPerson.decisions).toEqual([]);
  });

  it("refuses a press from a person whose link ended", async () => {
    const h = harness(store());
    await shown(h);
    h.hosts.links.delete(ALICE);
    await press(h, "yes-approve");
    expect(h.meta.said().at(-1)).toBe(WORDS.linkFirst);
    expect(h.asPerson.decisions).toEqual([]);
  });

  it("says Expired for an approval that expired, and decides nothing", async () => {
    const h = harness(store());
    await shown(h);
    const kept = h.asPerson.approvals.get("ap-1")!;
    kept.presentation = { ...kept.presentation, status: "expired" };
    await press(h, "approve");
    expect(h.meta.said().at(-1)).toBe(WORDS.expired);
    await press(h, "yes-approve");
    expect(h.meta.said().at(-1)).toBe(WORDS.alreadyDecided);
    expect(h.asPerson.decisions).toEqual([]);
  });

  it("is Review in Datalayer only for an action that does not fit 1,024 characters", async () => {
    const h = harness(store());
    await shown(
      h,
      mailPresentation({
        arguments: {
          body: "x".repeat(1200),
          subject: "Long",
          to: "a@example.com",
        },
      }),
    );
    expect(h.meta.sent().at(-1)).toMatchObject({
      label: WORDS.reviewLabel,
      type: "cta",
      url: "https://datalayer.ai/hosts/open?code=dlho_one-use-1",
    });
    expect(h.asPerson.handoffs).toEqual([
      { kind: "approval", target: "ap-1", userId: ALICE },
    ]);
    expect(h.meta.sent("buttons")).toEqual([]);
  });

  it("opens the whole request in Datalayer with Show more, a new one-use link each time", async () => {
    const h = harness(store());
    await shown(h);
    await press(h, "more");
    await press(h, "more");
    const links = h.meta.sent("cta").map((one) => (one as { url: string }).url);
    expect(links).toEqual([
      "https://datalayer.ai/hosts/open?code=dlho_one-use-1",
      "https://datalayer.ai/hosts/open?code=dlho_one-use-2",
    ]);
  });

  it("sends the new card when the request changed since its card, and decides nothing on the old one", async () => {
    const h = harness(store());
    await shown(h);
    const kept = h.asPerson.approvals.get("ap-1")!;
    kept.presentation = { ...kept.presentation, digest: "b".repeat(64) };
    await press(h, "approve");
    expect(h.meta.said().slice(-2)[0]).toBe(WORDS.changed);
    expect(h.meta.sent("buttons").at(-1)).toMatchObject({
      buttons: [
        { id: "ap:approve:ap-1", title: "Approve" },
        expect.anything(),
        expect.anything(),
      ],
    });
    expect((await h.store.card(PHONE_NUMBER_ID, ALICE, "ap-1"))?.digest).toBe(
      "b".repeat(64),
    );
    expect(h.asPerson.decisions).toEqual([]);
  });

  it("shows a PAP operation with its exact revision, reviewed in Datalayer, and its new revision as a new card", async () => {
    const h = harness(store());
    const operation = mailPresentation({
      action_class: "write",
      arguments: { operation_ref: "op-7", revision: 3 },
      digest: "c".repeat(64),
      fields: [
        { label: "Company", name: "company", value: "manzanita.example" },
        {
          label: "Operation",
          name: "operation",
          value: "Book a table for 2 at 20:00",
        },
      ],
      tool_name: "pap_confirm",
    });
    await shown(h, operation);
    const card = h.meta.sent().at(-1) as { body: string; type: string };
    expect(card.type).toBe("cta");
    expect(card.body).toContain("exactly revision 3");
    const kept = h.asPerson.approvals.get("ap-1")!;
    kept.presentation = {
      ...kept.presentation,
      arguments: { operation_ref: "op-7", revision: 4 },
      digest: "d".repeat(64),
    };
    await press(h, "more");
    expect(h.meta.said().slice(-2)[0]).toBe(WORDS.changed);
    expect((h.meta.sent().at(-1) as { body: string }).body).toContain(
      "exactly revision 4",
    );
    expect(h.asPerson.decisions).toEqual([]);
  });
});
