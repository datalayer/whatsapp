import { execFileSync } from "node:child_process";

import { hostTables } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresStore } from "../src/postgres-store.js";
import { wamidHash } from "../src/store.js";

/**
 * The migrations on a throwaway PostgreSQL
 * (`DATALAYER_WHATSAPP_TEST_DATABASE_URL`, never a cluster's): the shared
 * host tables under `whatsapp_`, then `migrations/`, applied twice to the
 * same end; and the store's statuses on them.
 */
const DATABASE_URL = process.env.DATALAYER_WHATSAPP_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))("migrate on PostgreSQL", () => {
  let database: pg.Pool;
  beforeAll(async () => {
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  });
  afterAll(async () => {
    await database?.end();
  });

  const migrate = () =>
    execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL },
    });

  it("makes the shared tables and the WhatsApp ones, and is idempotent", async () => {
    expect(migrate()).toContain("Applied the shared host tables");
    const tables = async () =>
      (
        await database.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        )
      ).rows.map((row) => row.table_name);
    const first = await tables();
    expect(first).toEqual(
      [
        ...hostTables("whatsapp"),
        "whatsapp_chat",
        "whatsapp_hold",
        "whatsapp_message_count",
        "whatsapp_message_status",
        "whatsapp_template",
      ].sort(),
    );
    migrate();
    expect(await tables()).toEqual(first);
  }, 60_000);

  it("keeps a message's furthest status and never steps back", async () => {
    const store = new PostgresStore(database);
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
    // The id is kept as its hash only.
    const { rows } = await database.query<{ wamid_hash: string }>(
      "SELECT wamid_hash FROM whatsapp_message_status",
    );
    expect(rows).toEqual([{ wamid_hash: wamidHash("wamid.M1") }]);
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
});
