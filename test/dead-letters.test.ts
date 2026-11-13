import { spawnSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { textOf } from "../src/solr/client.js";
import { documentOf, type SolrRecords } from "../src/solr/records.js";
import { solrTestUrl, testCollection } from "./support/solr.js";

/**
 * The dead-letters bin on the file's own throwaway Solr collection
 * (`DATALAYER_SOLR_TEST_URL`, never a cluster's): a dead job listed
 * without its words, its payload read for a stated reason, replayed back to
 * work once; every read and replay kept with the operator's name; refused
 * without one, and without Solr's settings.
 */
const COLLECTION = "test_whatsapp_dead_letters";

describe("the dead-letters bin", () => {
  it("refuses to start without Solr's settings", () => {
    const run = spawnSync(
      "node",
      ["--import", "tsx", "src/dead-letters-cli.ts", "list"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          DATALAYER_OPERATOR: "operator-ada",
        },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "DATALAYER_SOLR_URL, DATALAYER_SOLR_USERNAME, DATALAYER_SOLR_PASSWORD are required.",
    );
  });
});

describe.runIf(Boolean(solrTestUrl))("dead letters on Solr", () => {
  let records: SolrRecords;
  beforeAll(async () => {
    records = await testCollection(COLLECTION);
  }, 60_000);

  const bin = (operator: string | undefined, ...args: string[]) =>
    spawnSync("node", ["--import", "tsx", "src/dead-letters-cli.ts", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATALAYER_SOLR_PASSWORD:
          process.env.DATALAYER_SOLR_TEST_PASSWORD ?? "test-only",
        DATALAYER_SOLR_URL: solrTestUrl,
        DATALAYER_SOLR_USERNAME:
          process.env.DATALAYER_SOLR_TEST_USERNAME ?? "solr",
        DATALAYER_WHATSAPP_SOLR_COLLECTION: COLLECTION,
        ...(operator === undefined ? {} : { DATALAYER_OPERATOR: operator }),
      },
    });

  it("lists, reads for a reason and replays a dead job, each audited", async () => {
    const job = (payload: unknown, state: string, error?: string) =>
      documentOf("job", null, {
        attempts_i: state === "dead" ? 5 : 0,
        available_dt: new Date(),
        kind_s: "other",
        last_error_stored: error,
        payload_stored: JSON.stringify(payload),
        state_s: state,
      });
    const dead = job(
      {
        kind: "message",
        text: "the words of a dead question",
        userId: "US.13491208655302741918",
        wamid: "wamid.DEAD",
      },
      "dead",
      "Meta answered 131056",
    );
    const live = job(
      { kind: "message", text: "a live one", wamid: "wamid.LIVE" },
      "ready",
    );
    await records.client.add([dead, live]);
    const deadId = textOf(dead.uid);
    const liveId = textOf(live.uid);

    const refused = bin(undefined, "list");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("DATALAYER_OPERATOR is required");

    const list = bin("operator-ada", "list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("131056");
    expect(list.stdout).not.toContain("the words of a dead question");
    expect(list.stdout).not.toContain("a live one");

    const read = bin("operator-ada", "payload", deadId, "why", "131056");
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("the words of a dead question");
    expect(bin("operator-ada", "payload", liveId, "not dead").status).not.toBe(
      0,
    );

    expect(bin("operator-grace", "replay", deadId).stdout).toContain(
      `Job ${deadId} is back to work.`,
    );
    expect(bin("operator-grace", "replay", deadId).stdout).toContain(
      `Job ${deadId} is not a dead job.`,
    );
    const { docs } = await records.client.search({
      fq: ["type_s:job", `uid:${deadId}`],
    });
    expect(docs.map((doc) => doc.state_s)).toEqual(["ready"]);

    const reads = await records.find<{ operator: string; reason: string }>(
      "payload_access",
    );
    const replays = await records.find<{ operator: string; replayed: boolean }>(
      "job_replay",
    );
    expect([
      ...reads.map((one) => `${one.operator} read:${one.reason}`),
      ...replays.map((one) => `${one.operator} replay:${one.replayed}`),
    ]).toEqual([
      "operator-ada read:why 131056",
      "operator-grace replay:true",
      "operator-grace replay:false",
    ]);
  }, 60_000);
});
