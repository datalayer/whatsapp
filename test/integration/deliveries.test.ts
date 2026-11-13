import {
  DELIVERY_KEY_HEADER,
  DELIVERY_ROUTE,
  DeliveryPoller,
  DeliveryRenewal,
  deliveryRoute,
  deliverySignature,
  SHARED_SECRET_DELIVERIES_UNTIL,
  type HostDelivery,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import {
  deliverySecretKeeper,
  deliverySinkOf,
  type DeliveryQueueJob,
} from "../../src/deliveries.js";
import { installationData } from "../../src/store.js";
import { ALICE, PHONE_NUMBER_ID, serve, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import {
  harness,
  HOST_KEY,
  mailPresentation,
  type Harness,
} from "../support/worker.js";

/**
 * Datalayer's deliveries to a number, on each store: the kit's signed
 * webhook and outbox, each delivery handled once and acknowledged, shown in
 * the person's chat through the window keeper — inside the window as one
 * message, outside it held with one notice and shown on the reply; a
 * removed number's delivery unacknowledged and unshown.
 */

const HOUR = 60 * 60 * 1000;
const SECRET = "dlws_test-only-signing-secret";
const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };
const target = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };

function requested(id: string, uid = `dl-${id}`): HostDelivery {
  return {
    delivery: uid,
    event: "approval.requested",
    payload: {
      approval_id: id,
      deployment_uid: "dep-desk",
      presentation: "v1",
      session_uid: "whatsapp-s",
      target,
      tool_name: "send_email",
    },
  };
}

const job = (h: Harness, delivery: HostDelivery): DeliveryQueueJob => ({
  delivery,
  hostUid: `host-${PHONE_NUMBER_ID}`,
  kind: "delivery",
});

/** The number connected with its delivery secret, Alice's approval waiting. */
async function ready(h: Harness, at = h.clock.now()) {
  const kept = await h.connect({
    deliverySecret: h.cipher.encrypt(
      SECRET,
      installationData("delivery", WABA, PHONE_NUMBER_ID),
    ),
  });
  await h.store.recordInbound({ ...chat, wabaId: WABA }, new Date(at));
  for (const id of ["ap-1", "ap-2"])
    h.asPerson.approvals.set(id, {
      owner: ALICE,
      presentation: mailPresentation({ approval_id: id }),
    });
  return kept;
}

describe.each(storeCases("deliveries"))("deliveries on $name", ({ store }) => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("takes a signed push on a real socket, queues it once, refuses a forged one", async () => {
    const h = harness(store());
    await ready(h);
    const queued: unknown[] = [];
    const served = await serve({
      [`POST ${DELIVERY_ROUTE}`]: deliveryRoute(
        deliverySinkOf(h.store, h.cipher),
        async (one) => {
          queued.push(one);
        },
      ),
    });
    close = served.close;
    const body = JSON.stringify(requested("ap-1"));
    const now = Math.floor(Date.now() / 1000);
    const push = (signature: string) =>
      fetch(`${served.url}/datalayer/deliveries/host-${PHONE_NUMBER_ID}`, {
        body,
        headers: {
          "content-type": "application/json",
          "x-datalayer-signature": signature,
          "x-datalayer-timestamp": String(now),
        },
        method: "POST",
      });
    expect(
      (await push(deliverySignature(SECRET, now, body))).status,
    ).toBeLessThan(300);
    expect((await push(deliverySignature("another", now, body))).status).toBe(
      401,
    );
    expect(queued).toEqual([
      { delivery: requested("ap-1"), hostUid: `host-${PHONE_NUMBER_ID}` },
    ]);
  });

  it("takes a push under Datalayer's own key only when it names the key kept, and a shared-secret one only until 31 December 2026", async () => {
    const h = harness(store());
    await ready(h);
    const host = `host-${PHONE_NUMBER_ID}`;
    const queued: unknown[] = [];
    const body = JSON.stringify(requested("ap-1"));
    const push = async (at: number, key?: string) => {
      const served = await serve({
        [`POST ${DELIVERY_ROUTE}`]: deliveryRoute(
          deliverySinkOf(h.store, h.cipher),
          async (one) => void queued.push(one),
          () => at,
        ),
      });
      try {
        const answered = await fetch(
          `${served.url}/datalayer/deliveries/${host}`,
          {
            body,
            headers: {
              "content-type": "application/json",
              "x-datalayer-signature": deliverySignature(SECRET, at, body),
              "x-datalayer-timestamp": String(at),
              ...(key ? { [DELIVERY_KEY_HEADER]: key } : {}),
            },
            method: "POST",
          },
        );
        return answered.status;
      } finally {
        await served.close();
      }
    };
    const before = SHARED_SECRET_DELIVERIES_UNTIL - 60;
    const after = SHARED_SECRET_DELIVERIES_UNTIL + 60;
    // Kept before the switch, without a key: until the window ends, then never.
    expect(await push(before)).toBe(200);
    expect(await push(after)).toBe(401);
    // Registered again: the push names the key kept, whatever the date.
    await deliverySecretKeeper(h.store, h.cipher)(host, {
      key: "ai-agents-host-deliveries-v1",
      secret: SECRET,
      version: 2,
    });
    expect(await push(after, "ai-agents-host-deliveries-v1")).toBe(200);
    expect(await push(after)).toBe(401);
    expect(await push(after, "ai-agents-host-deliveries-v2")).toBe(401);
    expect(queued).toHaveLength(2);
  });

  it("registers a webhook again when Datalayer asks, at the address it holds, and keeps the new secret, key and version encrypted where the old ones were", async () => {
    const h = harness(store());
    await ready(h);
    const host = `host-${PHONE_NUMBER_ID}`;
    const url = `https://whatsapp.example/datalayer/deliveries/${host}`;
    h.hosts.webhookKey = "ai-agents-host-deliveries-v1";
    h.hosts.self_ = {
      ...h.hosts.self_,
      delivery: { renew: true, url, version: 1 },
    };
    const renewal = new DeliveryRenewal(
      deliverySinkOf(h.store, h.cipher),
      h.hosts,
      deliverySecretKeeper(h.store, h.cipher),
      { warn: () => undefined },
    );
    expect(await renewal.renewOnce()).toBe(1);
    expect(h.hosts.webhooks.at(-1)).toBe(url);
    const version = h.hosts.webhooks.length;
    const kept = await h.store.installationByHost(host);
    expect(kept?.deliveryKey).toBe("ai-agents-host-deliveries-v1");
    expect(kept?.deliveryVersion).toBe(version);
    expect(JSON.stringify(kept?.deliverySecret)).not.toContain(SECRET);
    await expect(
      deliverySinkOf(h.store, h.cipher).deliverySecretOf(host),
    ).resolves.toEqual({
      key: "ai-agents-host-deliveries-v1",
      secret: SECRET,
      version,
    });
    // Datalayer has it now: nothing more to do.
    h.hosts.self_ = {
      ...h.hosts.self_,
      delivery: {
        key: "ai-agents-host-deliveries-v1",
        renew: false,
        url,
        version,
      },
    };
    expect(await renewal.renewOnce()).toBe(0);
    // Removed, the number keeps nothing of it.
    await h.store.removeInstallation(WABA, PHONE_NUMBER_ID, new Date());
    const removed = await h.store.installation(WABA, PHONE_NUMBER_ID);
    expect(removed?.deliveryKey).toBeUndefined();
    expect(removed?.deliveryVersion).toBeUndefined();
  });

  it("shows an approval inside the window as one card, acknowledged, once", async () => {
    const h = harness(store());
    await ready(h);
    await h.worker.handle(job(h, requested("ap-1")));
    await h.worker.handle(job(h, requested("ap-1")));
    expect(h.meta.sent()).toHaveLength(1);
    expect(h.meta.sent("buttons")).toHaveLength(1);
    expect(h.hosts.acknowledged).toEqual(["dl-ap-1", "dl-ap-1"]);
    expect(await h.store.card(PHONE_NUMBER_ID, ALICE, "ap-1")).toMatchObject({
      deploymentUid: "dep-desk",
      digest: "a".repeat(64),
    });
  });

  it("holds an approval outside the window with one notice, joins a second, shows both on the reply", async () => {
    const h = harness(store());
    await ready(h, h.clock.now() - 25 * HOUR);
    await h.worker.handle(job(h, requested("ap-1")));
    await h.worker.handle(job(h, requested("ap-2")));
    expect(h.meta.said()).toEqual(["template:datalayer_approval_waiting"]);
    expect(h.meta.sent("template")[0]).toEqual({
      language: "en",
      name: "datalayer_approval_waiting",
      parameters: ["Help Desk"],
      type: "template",
    });
    expect(h.hosts.acknowledged).toEqual(["dl-ap-1", "dl-ap-2"]);
    expect((await h.store.holds(chat)).map((one) => one.kind)).toEqual([
      "approval",
      "approval",
    ]);
    h.clock.advance(HOUR);
    await h.worker.handle(
      h.job("Show me", {
        reply: { id: "Show me", title: "Show me" },
        type: "button",
      }),
    );
    expect(h.meta.sent("buttons")).toHaveLength(2);
    expect(await h.store.holds(chat)).toEqual([]);
    expect(await h.window.usage(PHONE_NUMBER_ID)).toMatchObject({
      service: 2,
      utility: 1,
    });
  });

  it("leaves a removed number's delivery unacknowledged and unshown", async () => {
    const h = harness(store());
    const kept = await ready(h);
    await h.store.removeInstallation(
      WABA,
      PHONE_NUMBER_ID,
      new Date(h.clock.now()),
    );
    await h.worker.handle(job(h, requested("ap-1")));
    expect(h.meta.calls).toEqual([]);
    expect(h.hosts.acknowledged).toEqual([]);
    expect(await deliverySinkOf(h.store, h.cipher).boundHosts()).toEqual([]);
    void kept;
  });

  it("finishes a turn the worker could not show, once, and nothing it showed", async () => {
    const h = harness(store());
    await ready(h);
    await h.store.setSession(chat, {
      deploymentUid: "dep-desk",
      sessionUid: "whatsapp-unshown",
      unshown: true,
    });
    h.asPerson.answers.set("whatsapp-unshown", "The answer, at last.");
    const completed = (uid: string): HostDelivery => ({
      delivery: uid,
      event: "turn.completed",
      payload: {
        deployment_uid: "dep-desk",
        record_entry: "r-1",
        session_uid: "whatsapp-unshown",
        target,
      },
    });
    await h.worker.handle(job(h, completed("dl-c1")));
    await h.worker.handle(job(h, completed("dl-c2")));
    expect(h.meta.said()).toEqual(["The answer, at last."]);
    expect(h.hosts.acknowledged).toEqual(["dl-c1", "dl-c2"]);
  });

  it("says a decision taken elsewhere on a card shown here, inside the window", async () => {
    const h = harness(store());
    await ready(h);
    await h.worker.handle(job(h, requested("ap-1")));
    await h.worker.handle(
      job(h, {
        delivery: "dl-d",
        event: "approval.decided",
        payload: {
          approval_id: "ap-1",
          decided_by: "principal-alice",
          deployment_uid: "dep-desk",
          session_uid: "whatsapp-s",
          status: "approved",
          target,
        },
      }),
    );
    expect(h.meta.said().at(-1)).toBe("send_email: Already decided elsewhere.");
    expect(
      (await h.store.card(PHONE_NUMBER_ID, ALICE, "ap-1"))?.decidedStatus,
    ).toBe("approved");
  });

  it("shows nothing for a target it did not give", async () => {
    const h = harness(store());
    await ready(h);
    const foreign = requested("ap-1");
    await h.worker.handle(
      job(h, {
        ...foreign,
        payload: { ...foreign.payload, target: { channel: "C1" } },
      } as HostDelivery),
    );
    expect(h.meta.calls).toEqual([]);
    expect(h.hosts.acknowledged).toEqual(["dl-ap-1"]);
  });

  it("reads the outbox of every kept number when a push was missed", async () => {
    const h = harness(store());
    await ready(h);
    h.hosts.outboxes.set(HOST_KEY, [requested("ap-1")]);
    const queued: unknown[] = [];
    const poller = new DeliveryPoller(
      deliverySinkOf(h.store, h.cipher),
      h.hosts,
      async (one) => {
        queued.push(one);
      },
    );
    expect(await poller.pollOnce()).toBe(1);
    expect(queued).toEqual([
      { delivery: requested("ap-1"), hostUid: `host-${PHONE_NUMBER_ID}` },
    ]);
  });
});
