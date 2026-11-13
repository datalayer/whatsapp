import {
  quotaEntries,
  DEFAULT_QUOTAS,
  windowOf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { documentOf, type SolrRecords } from "../../src/solr/records.js";
import { SolrWorkQueue } from "../../src/solr/queue.js";
import { SolrQuotaStore } from "../../src/solr/quotas.js";
import { RETENTION, wamidHash } from "../../src/store.js";
import type { WhatsAppJob } from "../../src/webhook.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { solrTestUrl, storeCases } from "../support/stores.js";

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

const CASES = storeCases("store");

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

  it("keeps a message's furthest status, never a step back, by its id's hash only", async () => {
    const store = cases.store();
    const at = new Date("2026-10-21T12:00:00Z");
    await store.applyStatus({
      at,
      phoneNumberId: "1",
      status: "read",
      wamid: "wamid.M1",
    });
    await store.applyStatus({
      at,
      phoneNumberId: "1",
      status: "delivered",
      wamid: "wamid.M1",
    });
    expect(await store.status("wamid.M1")).toEqual({
      at,
      phoneNumberId: "1",
      status: "read",
    });
    const records = cases.records();
    if (records) {
      const { docs } = await records.client.search({
        fq: ["type_s:message_status"],
      });
      expect(docs.map((doc) => doc.key_s)).toEqual([wamidHash("wamid.M1")]);
      expect(JSON.stringify(docs)).not.toContain("wamid.");
    }
    await store.applyStatus({
      at,
      errorCode: 131026,
      phoneNumberId: "1",
      status: "failed",
      wamid: "wamid.M1",
    });
    expect((await store.status("wamid.M1"))?.errorCode).toBe(131026);
    expect(await store.status("wamid.none")).toBeUndefined();
  });

  it("takes a turn once among racing claims, and a lease past its time is taken over", async () => {
    const store = cases.store();
    const chat = chatOf(ALICE);
    await store.recordInbound(chat, NOW);
    const until = new Date(NOW.getTime() + 60_000);
    const claims = await Promise.all(
      ["w1", "w2", "w3", "w4"].map(async (owner) =>
        store.claimTurn(chat, owner, until, NOW),
      ),
    );
    expect(claims.filter((one) => one.ok)).toHaveLength(1);
    const later = new Date(until.getTime() + 1);
    expect(await store.claimTurn(chat, "w5", later, later)).toEqual({
      ok: true,
    });
    expect((await store.chat(chat))?.turn).toEqual({
      owner: "w5",
      stop: false,
      until: later,
    });
  });

  it("holds a reference once and gives each hold out once to racing releases", async () => {
    const store = cases.store();
    const chat = chatOf(ALICE);
    expect(await store.hold(chat, "delivery", "dl-1", NOW)).toBe(true);
    expect(await store.hold(chat, "delivery", "dl-1", NOW)).toBe(false);
    await store.hold(chat, "link", "ln-1", new Date(NOW.getTime() + 1));
    const released = await Promise.all([
      store.releaseHolds(chat),
      store.releaseHolds(chat),
    ]);
    expect(released.flat().map((one) => one.ref)).toEqual(["dl-1", "ln-1"]);
    expect(await store.holds(chat)).toEqual([]);
  });

  it("counts each message once among racing counts, and refuses a group id another group holds", async () => {
    const store = cases.store();
    await Promise.all(
      Array.from({ length: 6 }, async () =>
        store.countMessage(PHONE_NUMBER_ID, "2026-10", "service"),
      ),
    );
    expect(await store.messageCounts(PHONE_NUMBER_ID, "2026-10")).toEqual({
      service: 6,
      utility: 0,
    });
    const group = {
      createdAt: NOW,
      phoneNumberId: PHONE_NUMBER_ID,
      state: "creating" as const,
      subject: "Desk",
      wabaId: WABA,
    };
    await store.saveGroup({ ...group, groupId: "g-1", ref: "r-1" });
    await store.saveGroup({ ...group, ref: "r-2" });
    await expect(
      store.updateGroup(PHONE_NUMBER_ID, "r-2", { groupId: "g-1" }),
    ).rejects.toThrow(/another row holds/);
    expect(
      await store.updateGroup(PHONE_NUMBER_ID, "r-2", { groupId: "g-2" }),
    ).toBe(true);
    expect((await store.group(PHONE_NUMBER_ID, "g-2"))?.ref).toBe("r-2");
  });
});

/**
 * What only the Solr collection keeps beside the store's records: the
 * queue's jobs and claims, the quota counts. Counted before and after, in
 * the test file's throwaway collection.
 */
describe.runIf(Boolean(solrTestUrl))(
  "forget and retention on the shared kinds",
  () => {
    const solr = CASES.find((one) => one.name === "Solr");
    const ready = () => {
      const records = solr?.records();
      const store = solr?.store();
      if (!records || !store) throw new Error("The collection is not ready.");
      return { records, store };
    };

    const jobsOf = async (records: SolrRecords) =>
      (await records.client.search({ fq: ["type_s:job"], rows: 100 })).docs.map(
        (doc) => ({
          doc,
          payload: JSON.parse(String(doc.payload_stored)) as Record<
            string,
            unknown
          >,
        }),
      );

    const naming = async (records: SolrRecords, userId: string) => ({
      chats: await records.count("chat", { user_id_s: userId }),
      holds: await records.count("hold", { user_id_s: userId }),
      jobs: (await jobsOf(records)).filter(
        (one) => one.payload.userId === userId,
      ).length,
      usage: (await records.find<{ key: string }>("usage")).filter((one) =>
        one.key.endsWith(userId),
      ).length,
      // Anything else naming them, anywhere.
      anywhere: (
        await records.client.search({
          fq: ["type_s:(claim OR message_status)"],
          rows: 100,
        })
      ).docs.filter((doc) => JSON.stringify(doc).includes(userId)).length,
    });

    it("counts every record naming the person before and after forget, and keeps the other person's", async () => {
      const { records, store } = ready();
      const queue = new SolrWorkQueue<WhatsAppJob>(records);
      const quotas = new SolrQuotaStore(records);
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
      for (const { doc, payload } of await jobsOf(records))
        if (String(payload.wamid).startsWith("wamid.D"))
          await records.client.add([
            {
              _version_: doc._version_,
              attempts_i: { set: 5 },
              id: doc.id,
              state_s: { set: "dead" },
            },
          ]);
      const both = { anywhere: 0, chats: 1, holds: 1, jobs: 2, usage: 1 };
      expect(await naming(records, ALICE)).toEqual(both);
      expect(await store.forget(ALICE)).toBe(5);
      expect(await naming(records, ALICE)).toEqual({
        anywhere: 0,
        chats: 0,
        holds: 0,
        jobs: 0,
        usage: 0,
      });
      expect(await naming(records, BOB)).toEqual(both);
      // The claims stay, by hash: a retried webhook is still refused.
      expect(await records.count("claim")).toBe(2);
    }, 60_000);

    it("forget leaves the job being worked to the queue", async () => {
      const { records, store } = ready();
      const queue = new SolrWorkQueue<WhatsAppJob>(records);
      await queue.enqueue(messageJob(ALICE, "wamid.RUN"));
      for (const { doc } of await jobsOf(records))
        await records.client.add([
          {
            _version_: doc._version_,
            id: doc.id,
            locked_dt: { set: new Date().toISOString() },
            state_s: { set: "processing" },
          },
        ]);
      expect(await store.forget(ALICE)).toBe(0);
    });

    it("deletes claims after 8 days, dead jobs after 14, quota counts after a day, and nothing younger", async () => {
      const { records, store } = ready();
      const at = (days: number, ms: number) =>
        new Date(NOW.getTime() - days * DAY + ms);
      const made = (
        kind: string,
        record: unknown,
        fields: Record<string, string | number>,
        createdAt: Date,
      ) => ({
        ...documentOf(kind, record, fields),
        creation_ts_dt: createdAt.toISOString(),
      });
      await records.client.add([
        made(
          "claim",
          { eventId: "ingress:message:old" },
          { key_s: "ingress:message:old" },
          at(RETENTION.claimMs / DAY, -1000),
        ),
        made(
          "claim",
          { eventId: "ingress:message:young" },
          { key_s: "ingress:message:young" },
          at(RETENTION.claimMs / DAY, 1000),
        ),
        ...[
          ["1", "dead", at(14, -1000)],
          ["2", "dead", at(14, 1000)],
          ["3", "ready", at(14, -1000)],
        ].map(([n, state, created]) =>
          made(
            "job",
            null,
            {
              attempts_i: 5,
              payload_stored: JSON.stringify({ n }),
              state_s: String(state),
            },
            created as Date,
          ),
        ),
        ...[windowOf(at(1, -60 * 60 * 1000)), windowOf(NOW)].map((period) =>
          made(
            "usage",
            { key: "user:x:US.1", period, used: 1 },
            {
              key_s: `${period}\u0000user:x:US.1`,
              usage_key_s: "user:x:US.1",
              usage_window_s: period,
              used_i: 1,
            },
            NOW,
          ),
        ),
      ]);
      expect(await store.retain(NOW)).toEqual({
        cards: 0,
        chats: 0,
        claims: 1,
        deadJobs: 1,
        holds: 0,
        statuses: 0,
        usage: 1,
      });
      expect(
        (await records.find<{ eventId: string }>("claim")).map(
          (one) => one.eventId,
        ),
      ).toEqual(["ingress:message:young"]);
      expect(
        (await jobsOf(records)).map((one) => one.payload.n).sort(),
      ).toEqual(["2", "3"]);
      expect(
        (await records.find<{ period: string }>("usage")).map(
          (one) => one.period,
        ),
      ).toEqual([windowOf(NOW)]);
    });
  },
);
