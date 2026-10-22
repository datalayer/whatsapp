import { spawnSync } from "node:child_process";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The dead-letters bin on a throwaway PostgreSQL
 * (`DATALAYER_WHATSAPP_TEST_DATABASE_URL`, never a cluster's): a dead job
 * listed without its words, its payload read for a stated reason, replayed
 * back to work once; every read and replay kept with the operator's name;
 * refused without one.
 */
const DATABASE_URL = process.env.DATALAYER_WHATSAPP_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))("dead letters on PostgreSQL", () => {
  let database: pg.Pool;
  beforeAll(async () => {
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    expect(
      spawnSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL },
      }).status,
    ).toBe(0);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
  });

  const bin = (operator: string | undefined, ...args: string[]) =>
    spawnSync("node", ["--import", "tsx", "src/dead-letters-cli.ts", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL,
        ...(operator === undefined ? {} : { DATALAYER_OPERATOR: operator }),
      },
    });

  it("lists, reads for a reason and replays a dead job, each audited", async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO whatsapp_jobs (payload, state, attempts, last_error) VALUES
         ($1, 'dead', 5, 'Meta answered 131056'),
         ($2, 'ready', 0, NULL)
       RETURNING id::text`,
      [
        {
          kind: "message",
          text: "the words of a dead question",
          userId: "US.13491208655302741918",
          wamid: "wamid.DEAD",
        },
        { kind: "message", text: "a live one", wamid: "wamid.LIVE" },
      ],
    );
    const [dead, live] = rows.map((row) => row.id);
    if (!dead || !live) throw new Error("the jobs were not made");

    const refused = bin(undefined, "list");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("DATALAYER_OPERATOR is required");

    const list = bin("operator-ada", "list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("131056");
    expect(list.stdout).not.toContain("the words of a dead question");
    expect(list.stdout).not.toContain("a live one");

    const read = bin("operator-ada", "payload", dead, "why", "131056");
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("the words of a dead question");
    expect(bin("operator-ada", "payload", live, "not dead").status).not.toBe(0);

    expect(bin("operator-grace", "replay", dead).stdout).toContain(
      `Job ${dead} is back to work.`,
    );
    expect(bin("operator-grace", "replay", dead).stdout).toContain(
      `Job ${dead} is not a dead job.`,
    );
    const { rows: state } = await database.query<{ state: string }>(
      "SELECT state FROM whatsapp_jobs WHERE id = $1",
      [dead],
    );
    expect(state).toEqual([{ state: "ready" }]);

    const audit = await database.query<{ operator: string; what: string }>(
      `SELECT operator, 'read:' || reason AS what FROM whatsapp_payload_access
       UNION ALL
       SELECT operator, 'replay:' || replayed FROM whatsapp_job_replays
       ORDER BY what`,
    );
    expect(audit.rows).toEqual([
      { operator: "operator-ada", what: "read:why 131056" },
      { operator: "operator-grace", what: "replay:false" },
      { operator: "operator-grace", what: "replay:true" },
    ]);
  }, 60_000);
});
