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
      stdio: "pipe",
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
        "whatsapp_approval_card",
        "whatsapp_chat",
        "whatsapp_group",
        "whatsapp_hold",
        "whatsapp_installation",
        "whatsapp_message_count",
        "whatsapp_message_status",
        "whatsapp_template",
      ].sort(),
    );
    migrate();
    expect(await tables()).toEqual(first);
  }, 60_000);

  it("refuses a number still connected through Datalayer's former Embedded Signup, then purges a removed one and drops the way", async () => {
    // The schema as 0.1.3 left it: each installation named its way.
    await database.query(`
      ALTER TABLE whatsapp_installation DROP CONSTRAINT whatsapp_installation_app_columns;
      ALTER TABLE whatsapp_installation ALTER COLUMN app_id DROP NOT NULL;
      ALTER TABLE whatsapp_installation ADD COLUMN way text NOT NULL DEFAULT 'embedded_signup';
      INSERT INTO whatsapp_installation (waba_id, phone_number_id, host_uid, host_key,
        organization_uid, business_name, support, privacy, state)
      VALUES ('1', '11', 'host-11', '{}', 'account-1', 'Acme', 'support@acme.example',
        'https://acme.example/privacy', 'active');
      INSERT INTO whatsapp_chat (phone_number_id, user_id, waba_id, last_inbound_at)
      VALUES ('11', 'US.1', '1', now());`);
    expect(migrate).toThrow(/still connected/);
    // Nothing was changed by the refused migration.
    expect(
      (await database.query("SELECT way FROM whatsapp_installation")).rows,
    ).toEqual([{ way: "embedded_signup" }]);
    await database.query(
      "UPDATE whatsapp_installation SET state = 'removed', removed_at = now()",
    );
    migrate();
    expect(
      (await database.query("SELECT * FROM whatsapp_installation")).rows,
    ).toEqual([]);
    expect((await database.query("SELECT * FROM whatsapp_chat")).rows).toEqual(
      [],
    );
    expect(
      (
        await database.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'whatsapp_installation' AND column_name = 'way'",
        )
      ).rows,
    ).toEqual([]);
    // Every installation names its app, and a kept one its secret and address.
    await expect(
      database.query(`INSERT INTO whatsapp_installation (waba_id, phone_number_id,
        host_uid, host_key, organization_uid, business_name, support, privacy, state)
        VALUES ('1', '12', 'host-12', '{}', 'account-1', 'Acme', 'support@acme.example',
        'https://acme.example/privacy', 'active')`),
    ).rejects.toThrow(/app_id/);
    await expect(
      database.query(`INSERT INTO whatsapp_installation (waba_id, phone_number_id,
        host_uid, host_key, organization_uid, business_name, support, privacy, state, app_id)
        VALUES ('1', '12', 'host-12', '{}', 'account-1', 'Acme', 'support@acme.example',
        'https://acme.example/privacy', 'active', '2')`),
    ).rejects.toThrow(/whatsapp_installation_app_columns/);
    migrate();
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
