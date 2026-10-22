import { execFileSync } from "node:child_process";

import { PostgresWorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresStore } from "../../src/postgres-store.js";
import { MemoryStore, wamidHash, type WhatsAppStore } from "../../src/store.js";
import { BODY_LIMIT } from "../../src/verify.js";
import {
  webhookRoutes,
  WEBHOOK_PATH,
  type WhatsAppJob,
} from "../../src/webhook.js";
import {
  ALICE,
  ALICE_PHONE,
  APP_SECRET,
  BUSINESS_PHONE,
  capturingLogger,
  message,
  PHONE_NUMBER_ID,
  serve,
  sign,
  VERIFY_TOKEN,
  WABA,
  webhook,
} from "../support/meta.js";
import { RecordingQueue } from "../support/queue.js";

/**
 * Meta's webhook on a real socket: the endpoint verification, the signature
 * over the raw body, the 3 MB cap, each message claimed once by its wamid,
 * statuses kept as each message's furthest, 200 at once, and 500 when
 * nothing could be persisted, so that Meta tries again.
 */

type Endpoint = Readonly<{
  url: string;
  post(body: string, signature?: string | null): Promise<Response>;
  lines: string[];
}>;

describe("the webhook on a real socket", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function endpoint(
    queue: RecordingQueue<WhatsAppJob>,
    store: WhatsAppStore = new MemoryStore(),
  ): Promise<Endpoint> {
    const { lines, logger } = capturingLogger();
    const served = await serve(
      webhookRoutes({
        appSecret: APP_SECRET,
        logger,
        queue,
        store,
        verifyToken: VERIFY_TOKEN,
      }),
    );
    close = served.close;
    return {
      lines,
      post: (body, signature = sign(body)) =>
        fetch(`${served.url}${WEBHOOK_PATH}`, {
          body,
          headers: {
            "content-type": "application/json",
            ...(signature === null ? {} : { "x-hub-signature-256": signature }),
          },
          method: "POST",
        }),
      url: served.url,
    };
  }

  it("answers Meta's verification with its challenge, and nothing else", async () => {
    const { url } = await endpoint(new RecordingQueue());
    const verify = (mode: string, token: string, challenge = "1158201444") =>
      fetch(
        `${url}${WEBHOOK_PATH}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${challenge}`,
      );
    const answered = await verify("subscribe", VERIFY_TOKEN);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toBe("1158201444");
    expect((await verify("subscribe", "another-verify-token")).status).toBe(
      403,
    );
    expect((await verify("unsubscribe", VERIFY_TOKEN)).status).toBe(403);
    expect((await verify("subscribe", VERIFY_TOKEN, "")).status).toBe(403);
    expect((await fetch(`${url}${WEBHOOK_PATH}`)).status).toBe(403);
  });

  it("claims a valid message once, without a phone number, and answers 200", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post, lines } = await endpoint(queue);
    const body = webhook({ messages: [message("wamid.A1")] });
    const answered = await post(body);
    expect(answered.status).toBe(200);
    expect(queue.items).toEqual([
      {
        item: {
          at: "2026-10-22T12:00:00.000Z",
          kind: "message",
          phoneNumberId: PHONE_NUMBER_ID,
          profileName: "Alice",
          text: "Hello",
          type: "text",
          userId: ALICE,
          wabaId: WABA,
          wamid: "wamid.A1",
        },
        key: `message:${wamidHash("wamid.A1")}`,
      },
    ]);
    const kept = JSON.stringify(queue.items) + lines.join("\n");
    expect(kept).not.toContain(ALICE_PHONE);
    expect(kept).not.toContain(BUSINESS_PHONE);
    expect(lines.join("\n")).not.toContain("Hello");
  });

  it("refuses a forged, an unsigned and a changed body with 401, keeping nothing", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post } = await endpoint(queue);
    const body = webhook({ messages: [message("wamid.F1")] });
    expect((await post(body, sign(body, "another-app-secret"))).status).toBe(
      401,
    );
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, "sha256=not-hex")).status).toBe(401);
    const changed = body.replace("Hello", "Pay Eve");
    expect((await post(changed, sign(body))).status).toBe(401);
    expect(queue.items).toEqual([]);
  });

  it("answers a replayed request 200 and claims nothing more", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post } = await endpoint(queue);
    const body = webhook({ messages: [message("wamid.R1")] });
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(queue.items.map(({ key }) => key)).toEqual([
      `message:${wamidHash("wamid.R1")}`,
    ]);
  });

  it("claims only the new message of a duplicate batch", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post, lines } = await endpoint(queue);
    expect(
      (await post(webhook({ messages: [message("wamid.D1")] }))).status,
    ).toBe(200);
    const batch = webhook({
      messages: [
        message("wamid.D1"),
        message("wamid.D2", { text: { body: "And then?" }, type: "text" }),
      ],
    });
    expect((await post(batch)).status).toBe(200);
    expect(queue.items.map(({ key }) => key)).toEqual([
      `message:${wamidHash("wamid.D1")}`,
      `message:${wamidHash("wamid.D2")}`,
    ]);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      claimed: 1,
      duplicates: 1,
      event: "webhook.received",
    });
  });

  it("refuses a body past 3 MB with 413 before reading it all, keeping nothing", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post } = await endpoint(queue);
    const padding = "x".repeat(BODY_LIMIT);
    const body = webhook({ messages: [message("wamid.O1")], padding });
    expect(Buffer.byteLength(body)).toBeGreaterThan(BODY_LIMIT);
    expect((await post(body)).status).toBe(413);
    expect(queue.items).toEqual([]);
    // Just under the cap is read, signed and taken.
    const under = webhook({
      messages: [message("wamid.O2")],
      padding: "x".repeat(BODY_LIMIT - 2048),
    });
    expect(Buffer.byteLength(under)).toBeLessThanOrEqual(BODY_LIMIT);
    expect((await post(under)).status).toBe(200);
    expect(queue.items.map(({ key }) => key)).toEqual([
      `message:${wamidHash("wamid.O2")}`,
    ]);
  });

  it("answers 500 when nothing could be persisted, and takes Meta's retry once", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post, lines } = await endpoint(queue);
    const body = webhook({ messages: [message("wamid.U1")] });
    queue.failures = 1;
    expect((await post(body)).status).toBe(500);
    expect(queue.items).toEqual([]);
    expect(lines.join("\n")).toContain("webhook.not_persisted");
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(queue.items.map(({ key }) => key)).toEqual([
      `message:${wamidHash("wamid.U1")}`,
    ]);
  });

  it("answers 500 when a status could not be kept", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const failing: WhatsAppStore = Object.assign(new MemoryStore(), {
      applyStatus: () => Promise.reject(new Error("The database is down.")),
    });
    const { post } = await endpoint(queue, failing);
    const body = webhook({
      statuses: [{ id: "wamid.S0", status: "sent", timestamp: "1792670400" }],
    });
    expect((await post(body)).status).toBe(500);
  });

  it("keeps each sent message's furthest status, out of order and repeated", async () => {
    const store = new MemoryStore();
    const { post } = await endpoint(new RecordingQueue(), store);
    const status = (status: string, timestamp: string, extra = {}) =>
      webhook({
        statuses: [
          {
            id: "wamid.S1",
            recipient_id: ALICE_PHONE,
            recipient_user_id: ALICE,
            status,
            timestamp,
            ...extra,
          },
        ],
      });
    expect((await post(status("delivered", "1792670402"))).status).toBe(200);
    expect((await post(status("sent", "1792670401"))).status).toBe(200);
    expect(await store.status("wamid.S1")).toMatchObject({
      phoneNumberId: PHONE_NUMBER_ID,
      status: "delivered",
    });
    expect((await post(status("read", "1792670403"))).status).toBe(200);
    expect((await store.status("wamid.S1"))?.status).toBe("read");
    expect(
      (
        await post(
          status("failed", "1792670404", { errors: [{ code: 131056 }] }),
        )
      ).status,
    ).toBe(200);
    expect(await store.status("wamid.S1")).toMatchObject({
      errorCode: 131056,
      status: "failed",
    });
    expect(JSON.stringify(await store.status("wamid.S1"))).not.toContain(
      ALICE_PHONE,
    );
  });

  it("hands account events to the worker once, without phone numbers, and sets calls aside", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post } = await endpoint(queue);
    const update = webhook(
      {
        event: "PARTNER_REMOVED",
        phone_number: BUSINESS_PHONE,
        waba_info: { waba_id: WABA },
      },
      "account_update",
    );
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.item).toEqual({
      field: "account_update",
      kind: "account",
      value: { event: "PARTNER_REMOVED", waba_info: { waba_id: WABA } },
      wabaId: WABA,
    });
    expect((await post(webhook({ calls: [] }, "calls"))).status).toBe(200);
    expect(queue.items).toHaveLength(1);
  });

  it("answers a signed body that is not Meta's webhook 400", async () => {
    const queue = new RecordingQueue<WhatsAppJob>();
    const { post } = await endpoint(queue);
    expect((await post("not json")).status).toBe(400);
    expect(
      (await post(JSON.stringify({ object: "page", entry: [] }))).status,
    ).toBe(400);
    expect(queue.items).toEqual([]);
  });
});

/**
 * The same ingress on PostgreSQL (`DATALAYER_WHATSAPP_TEST_DATABASE_URL`, a
 * throwaway database, never a cluster's): the claim and its job in one
 * transaction, a replay and a duplicate claiming nothing, the statuses'
 * rank held by one statement.
 */
const DATABASE_URL = process.env.DATALAYER_WHATSAPP_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))("the webhook on PostgreSQL", () => {
  let database: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL },
    });
  }, 60_000);
  afterAll(async () => {
    await close?.();
    await database?.end();
  });

  it("claims each message once and keeps its job with its claim", async () => {
    const queue = new PostgresWorkQueue<WhatsAppJob>(database, "whatsapp");
    const store = new PostgresStore(database);
    const served = await serve(
      webhookRoutes({
        appSecret: APP_SECRET,
        logger: capturingLogger().logger,
        queue,
        store,
        verifyToken: VERIFY_TOKEN,
      }),
    );
    close = served.close;
    const post = (body: string) =>
      fetch(`${served.url}${WEBHOOK_PATH}`, {
        body,
        headers: { "x-hub-signature-256": sign(body) },
        method: "POST",
      });
    const first = webhook({ messages: [message("wamid.P1")] });
    expect((await post(first)).status).toBe(200);
    expect((await post(first)).status).toBe(200);
    expect(
      (
        await post(
          webhook({
            messages: [
              message("wamid.P1"),
              message("wamid.P2", { text: { body: "Then?" }, type: "text" }),
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const jobs = await database.query<{ payload: WhatsAppJob }>(
      "SELECT payload FROM whatsapp_jobs ORDER BY id",
    );
    expect(
      jobs.rows.map(
        ({ payload }) => payload.kind === "message" && payload.wamid,
      ),
    ).toEqual(["wamid.P1", "wamid.P2"]);
    expect(JSON.stringify(jobs.rows)).not.toContain(ALICE_PHONE);
    const claims = await database.query<{ event_id: string }>(
      "SELECT event_id FROM whatsapp_event_claims ORDER BY event_id",
    );
    expect(claims.rows.map(({ event_id }) => event_id)).toEqual([
      ...[
        `ingress:message:${wamidHash("wamid.P1")}`,
        `ingress:message:${wamidHash("wamid.P2")}`,
      ].sort(),
    ]);
    expect(JSON.stringify(claims.rows)).not.toContain("wamid.");
    for (const [status, timestamp] of [
      ["read", "1792670403"],
      ["delivered", "1792670402"],
    ] as const)
      expect(
        (
          await post(
            webhook({ statuses: [{ id: "wamid.P9", status, timestamp }] }),
          )
        ).status,
      ).toBe(200);
    expect((await store.status("wamid.P9"))?.status).toBe("read");
  }, 30_000);
});
