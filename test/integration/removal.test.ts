import { describe, expect, it } from "vitest";

import { purgeRemoved, PURGE_AFTER_MS, reconcile } from "../../src/removal.js";
import { approvalPressId } from "../../src/render.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import {
  harness,
  HOST_KEY,
  installation,
  mailPresentation,
  tokenRefused,
  type Harness,
} from "../support/worker.js";

/**
 * Disconnect and removal, on each store: Meta's `account_update`, a token
 * Meta refuses on use (190), a host key Datalayer refuses (the owner
 * disconnected it on the card; found on use and by the daily
 * reconciliation). The business token goes at once; late work does
 * nothing; the purge comes at 24 hours, not 23.
 */

const HOUR = 60 * 60 * 1000;
const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };

const removalOf = (h: Harness) => ({
  cipher: h.cipher,
  hosts: h.hosts,
  logger: h.worker.deps.logger,
  now: () => h.clock.now(),
  port: h.meta,
  store: h.store,
});

describe.each(storeCases())("removal on $name", ({ store, database }) => {
  it("removes every number of an account Meta says Datalayer left, the token destroyed", async () => {
    const h = harness(store());
    await h.connect();
    await h.worker.handle({
      field: "account_update",
      kind: "account",
      value: { event: "PARTNER_REMOVED" },
      wabaId: WABA,
    });
    const [removed] = await h.store.installations();
    expect(removed?.state).toBe("removed");
    expect(removed?.businessToken).toBeUndefined();
    expect(removed?.pin).toBeUndefined();
    expect(removed?.removedAt?.getTime()).toBe(h.clock.now());
    expect(h.hosts.uninstalledKeys).toEqual([HOST_KEY]);
    // Meta ended the access itself: nothing to undo there.
    expect(h.meta.calls).toEqual([]);
    expect(
      h.lines.some((line) =>
        line.includes('"reason":"removed:account-update"'),
      ),
    ).toBe(true);
    // Another event changes nothing.
    await h.worker.handle({
      field: "account_update",
      kind: "account",
      value: { event: "VERIFIED_ACCOUNT" },
      wabaId: WABA,
    });
    expect(h.hosts.uninstalledKeys).toHaveLength(1);
  });

  it("removes a number whose token Meta refuses on use (190)", async () => {
    const h = harness(store());
    await h.connect();
    h.meta.failNext("send", tokenRefused());
    await h.worker.handle(h.job());
    expect((await h.store.installations())[0]?.state).toBe("removed");
    expect(h.hosts.uninstalledKeys).toEqual([HOST_KEY]);
    expect(h.meta.calls.some((one) => one.method === "unsubscribe")).toBe(
      false,
    );
  });

  it("removes a number whose key Datalayer refuses (disconnected on the card), and takes the app off the account", async () => {
    const h = harness(store());
    await h.connect();
    h.hosts.refusedKeys.add(HOST_KEY);
    await h.worker.handle(h.job());
    expect((await h.store.installations())[0]?.state).toBe("removed");
    // Datalayer revoked it already.
    expect(h.hosts.uninstalledKeys).toEqual([]);
    expect(h.meta.calls.filter((one) => one.method !== "unsubscribe")).toEqual(
      [],
    );
    expect(
      h.meta.calls.filter((one) => one.method === "unsubscribe"),
    ).toHaveLength(1);
  });

  it("finds a disconnected number in the daily reconciliation, and keeps the app on an account with another number", async () => {
    const h = harness(store());
    await h.connect();
    const other = installation(h.cipher, {
      hostKey: h.cipher.encrypt("dlhk_other", `host-key:${WABA}:2000`),
      hostUid: "host-2000",
      phoneNumberId: "2000",
    });
    await h.store.saveInstallation(other);
    h.hosts.refusedKeys.add(HOST_KEY);
    expect(await reconcile(removalOf(h))).toBe(1);
    expect((await h.store.installation(WABA, PHONE_NUMBER_ID))?.state).toBe(
      "removed",
    );
    expect((await h.store.installation(WABA, "2000"))?.state).toBe("active");
    expect(h.meta.calls.some((one) => one.method === "unsubscribe")).toBe(
      false,
    );
    expect(await reconcile(removalOf(h))).toBe(0);
  });

  it("does nothing with late work: a queued message, a delivery, a press", async () => {
    const h = harness(store());
    const kept = await h.connect();
    await h.store.recordInbound(
      { ...chat, wabaId: WABA },
      new Date(h.clock.now()),
    );
    h.asPerson.approvals.set("ap-1", {
      owner: ALICE,
      presentation: mailPresentation(),
    });
    await h.store.saveCard({
      approvalId: "ap-1",
      deploymentUid: "dep-desk",
      digest: "a".repeat(64),
      phoneNumberId: PHONE_NUMBER_ID,
      shownAt: new Date(h.clock.now()),
      toolName: "send_email",
      userId: ALICE,
    });
    await h.worker.removed(kept, "account-update");
    const before = h.hosts.calls.length;
    await h.worker.handle(h.job());
    await h.worker.handle(
      h.job(undefined, {
        reply: {
          id: approvalPressId("yes-approve", "ap-1"),
          title: "Yes, approve",
        },
        text: undefined,
        type: "interactive",
      }),
    );
    await h.worker.handle({
      delivery: {
        delivery: "dl-1",
        event: "approval.requested",
        payload: {
          approval_id: "ap-1",
          deployment_uid: "dep-desk",
          presentation: "v1",
          session_uid: "whatsapp-x",
          target: { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE },
          tool_name: "send_email",
        },
      },
      hostUid: kept.hostUid,
      kind: "delivery",
    });
    expect(h.meta.calls).toEqual([]);
    expect(h.hosts.calls.length).toBe(before);
    // Unacknowledged: the delivery stays Datalayer's, unshown.
    expect(h.hosts.acknowledged).toEqual([]);
    expect(h.asPerson.decisions).toEqual([]);
    expect(h.agent.started).toEqual([]);
  });

  it("purges a removed number's rows at 24 hours, not 23", async () => {
    const h = harness(store());
    const kept = await h.connect();
    await h.worker.handle(h.job());
    await h.store.hold(
      chat,
      "delivery",
      "dep-desk s-1",
      new Date(h.clock.now()),
    );
    await h.worker.removed(kept, "token-refused");
    const removal = removalOf(h);
    h.clock.advance(23 * HOUR);
    expect(await purgeRemoved(removal)).toBe(0);
    expect(await h.store.chat(chat)).toBeDefined();
    h.clock.advance(PURGE_AFTER_MS - 23 * HOUR);
    expect(await purgeRemoved(removal)).toBe(1);
    expect(await h.store.installations()).toEqual([]);
    expect(await h.store.chat(chat)).toBeUndefined();
    expect(await h.store.holds(chat)).toEqual([]);
    expect(await h.store.templates(WABA)).toEqual([]);
    expect((await h.window.usage(PHONE_NUMBER_ID)).service).toBe(0);
    const pool = database();
    if (pool)
      for (const table of [
        "whatsapp_installation",
        "whatsapp_chat",
        "whatsapp_hold",
        "whatsapp_approval_card",
        "whatsapp_message_count",
        "whatsapp_template",
      ])
        expect(
          (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0],
        ).toEqual({ n: 0 });
    expect(h.lines.some((line) => line.includes('"reason":"purged"'))).toBe(
      true,
    );
  });
});
