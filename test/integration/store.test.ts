import {
  PostgresQuotaStore,
  PostgresWorkQueue,
  quotaEntries,
  DEFAULT_QUOTAS,
  windowOf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { RETENTION, wamidHash } from "../../src/store.js";
import type { WhatsAppJob } from "../../src/webhook.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { DATABASE_URL, storeCases } from "../support/stores.js";

/**
 * `forget` and retention, on each store: every row naming the person
 * deleted and nobody else's; claims and statuses never naming anyone; what
 * is past its keeping deleted, and nothing a moment younger.
 */

const BOB = "US.20000000000000000002";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 9, 22, 12));

const chatOf = (userId: string, phoneNumberId = PHONE_NUMBER_ID) => ({
  phoneNumberId,
  userId,
  wabaId: WABA,
});

const messageJob = (userId: string, wamid: string): WhatsAppJob => ({
  at: NOW.toISOString(),
  kind: "message",
  phoneNumberId: PHONE_NUMBER_ID,
  text: "the words of a question",
  type: "text",
  userId,
  wabaId: WABA,
  wamid,
});

const CASES = storeCases();

describe.each(CASES)("forget and retention on $name", (cases) => {
  it("forgets every chat and hold of the person, on every number, and no one else's", async () => {
    const store = cases.store();
    for (const userId of [ALICE, BOB]) {
      await store.recordInbound(chatOf(userId), NOW);
      await store.recordInbound(chatOf(userId, "another-number"), NOW);
      await store.hold(chatOf(userId), "delivery", "dl-1", NOW);
      await store.hold(chatOf(userId), "approval", "ap-1", NOW);
    }
    expect(await store.forget(ALICE)).toBe(4);
    expect(await store.chat(chatOf(ALICE))).toBeUndefined();
    expect(await store.chat(chatOf(ALICE, "another-number"))).toBeUndefined();
    expect(await store.holds(chatOf(ALICE))).toEqual([]);
    expect(await store.chat(chatOf(BOB))).toBeDefined();
    expect(await store.holds(chatOf(BOB))).toHaveLength(2);
    expect(await store.forget(ALICE)).toBe(0);
  });

  it("deletes chats and holds 30 days after the last message, statuses after 30 days, and nothing younger", async () => {
    const store = cases.store();
    const ago = (days: number, ms = 0) =>
      new Date(NOW.getTime() - days * DAY + ms);
    await store.recordInbound(chatOf(ALICE), ago(30, -1000));
    await store.hold(chatOf(ALICE), "delivery", "dl-old", ago(1));
    await store.recordInbound(chatOf(BOB), ago(30, 1000));
    await store.hold(chatOf(BOB), "delivery", "dl-young", ago(29));
    await store.applyStatus({
      at: ago(30, -1000),
      phoneNumberId: PHONE_NUMBER_ID,
      status: "read",
      wamid: "wamid.OLD",
    });
    await store.applyStatus({
      at: ago(30, 1000),
      phoneNumberId: PHONE_NUMBER_ID,
      status: "read",
      wamid: "wamid.YOUNG",
    });
    const retained = await store.retain(NOW);
    expect(retained).toMatchObject({ chats: 1, holds: 1, statuses: 1 });
    expect(await store.chat(chatOf(ALICE))).toBeUndefined();
    expect(await store.chat(chatOf(BOB))).toBeDefined();
    expect(await store.holds(chatOf(BOB))).toHaveLength(1);
    expect(await store.status("wamid.OLD")).toBeUndefined();
    expect(await store.status("wamid.YOUNG")).toBeDefined();
    expect(await store.retain(NOW)).toMatchObject({
      chats: 0,
      holds: 0,
      statuses: 0,
    });
  });
});

/**
 * The rows only PostgreSQL keeps: the queue's jobs and claims, the quota
 * counts. Counted before and after, on a throwaway database.
 */
describe.runIf(Boolean(DATABASE_URL))(
  "forget and retention on the shared tables",
  () => {
    const postgres = CASES.find((one) => one.name === "PostgreSQL");

    const naming = async (userId: string) => {
      const database = postgres?.database();
      if (!database) throw new Error("The database is not ready.");
      const count = async (sql: string) =>
        Number(
          (await database.query<{ n: string }>(sql, [userId])).rows[0]?.n ?? 0,
        );
      return {
        chats: await count(
          "SELECT count(*) AS n FROM whatsapp_chat WHERE user_id = $1",
        ),
        holds: await count(
          "SELECT count(*) AS n FROM whatsapp_hold WHERE user_id = $1",
        ),
        jobs: await count(
          "SELECT count(*) AS n FROM whatsapp_jobs WHERE payload->>'userId' = $1",
        ),
        usage: await count(
          "SELECT count(*) AS n FROM whatsapp_usage WHERE usage_key LIKE '%' || $1",
        ),
        // Anything else naming them, anywhere.
        anywhere: await count(
          `SELECT
           (SELECT count(*) FROM whatsapp_event_claims WHERE event_id LIKE '%' || $1 || '%') +
           (SELECT count(*) FROM whatsapp_message_status WHERE wamid_hash LIKE '%' || $1 || '%') AS n`,
        ),
      };
    };

    it("counts every row naming the person before and after forget, and keeps the other person's", async () => {
      const database = postgres?.database();
      const store = postgres?.store();
      if (!database || !store) throw new Error("The database is not ready.");
      const queue = new PostgresWorkQueue<WhatsAppJob>(database, "whatsapp");
      const quotas = new PostgresQuotaStore(database, {
        tablePrefix: "whatsapp",
      });
      for (const [n, userId] of [ALICE, BOB].entries()) {
        await store.recordInbound(chatOf(userId), NOW);
        await store.hold(chatOf(userId), "delivery", "dl-1", NOW);
        await queue.enqueue(
          messageJob(userId, `wamid.Q${n}`),
          `message:${wamidHash(`wamid.Q${n}`)}`,
        );
        await queue.enqueue(messageJob(userId, `wamid.D${n}`));
        await quotas.takeQuota(
          quotaEntries(
            DEFAULT_QUOTAS,
            {
              applicationId: "dep-desk",
              externalUserId: userId,
              installation: `${WABA}:${PHONE_NUMBER_ID}`,
            },
            "number",
          ),
          windowOf(NOW),
        );
      }
      await database.query(
        "UPDATE whatsapp_jobs SET state = 'dead', attempts = 5 WHERE payload->>'wamid' LIKE 'wamid.D%'",
      );
      expect(await naming(ALICE)).toEqual({
        anywhere: 0,
        chats: 1,
        holds: 1,
        jobs: 2,
        usage: 1,
      });
      expect(await store.forget(ALICE)).toBe(5);
      expect(await naming(ALICE)).toEqual({
        anywhere: 0,
        chats: 0,
        holds: 0,
        jobs: 0,
        usage: 0,
      });
      expect(await naming(BOB)).toEqual({
        anywhere: 0,
        chats: 1,
        holds: 1,
        jobs: 2,
        usage: 1,
      });
      // The claims stay, by hash: a retried webhook is still refused.
      const { rows } = await database.query<{ n: string }>(
        "SELECT count(*) AS n FROM whatsapp_event_claims",
      );
      expect(Number(rows[0]?.n)).toBe(2);
    });

    it("forget leaves the job being worked to the queue", async () => {
      const database = postgres?.database();
      const store = postgres?.store();
      if (!database || !store) throw new Error("The database is not ready.");
      const queue = new PostgresWorkQueue<WhatsAppJob>(database, "whatsapp");
      await queue.enqueue(messageJob(ALICE, "wamid.RUN"));
      await database.query(
        "UPDATE whatsapp_jobs SET state = 'processing', locked_at = now()",
      );
      expect(await store.forget(ALICE)).toBe(0);
    });

    it("deletes claims after 8 days, dead jobs after 14, quota counts after a day, and nothing younger", async () => {
      const database = postgres?.database();
      const store = postgres?.store();
      if (!database || !store) throw new Error("The database is not ready.");
      const at = (days: number, ms: number) =>
        new Date(NOW.getTime() - days * DAY + ms);
      await database.query(
        `INSERT INTO whatsapp_event_claims (event_id, claimed_at) VALUES
         ('ingress:message:old', $1), ('ingress:message:young', $2)`,
        [at(RETENTION.claimMs / DAY, -1000), at(RETENTION.claimMs / DAY, 1000)],
      );
      await database.query(
        `INSERT INTO whatsapp_jobs (payload, state, attempts, created_at) VALUES
         ('{"n": 1}', 'dead', 5, $1), ('{"n": 2}', 'dead', 5, $2),
         ('{"n": 3}', 'ready', 0, $1)`,
        [at(14, -1000), at(14, 1000)],
      );
      await database.query(
        `INSERT INTO whatsapp_usage (usage_key, usage_window, used) VALUES
         ('user:x:US.1', $1, 1), ('user:x:US.1', $2, 1)`,
        [windowOf(at(1, -60 * 60 * 1000)), windowOf(NOW)],
      );
      expect(await store.retain(NOW)).toEqual({
        cards: 0,
        chats: 0,
        claims: 1,
        deadJobs: 1,
        holds: 0,
        statuses: 0,
        usage: 1,
      });
      const left = async (sql: string) =>
        (await database.query<{ v: string }>(sql)).rows.map((row) => row.v);
      expect(
        await left("SELECT event_id AS v FROM whatsapp_event_claims"),
      ).toEqual(["ingress:message:young"]);
      expect(
        await left("SELECT payload->>'n' AS v FROM whatsapp_jobs ORDER BY id"),
      ).toEqual(["2", "3"]);
      expect(
        await left("SELECT usage_window AS v FROM whatsapp_usage"),
      ).toEqual([windowOf(NOW)]);
    });
  },
);
