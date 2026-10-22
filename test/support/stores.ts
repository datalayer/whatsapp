import { execFileSync } from "node:child_process";

import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { PostgresStore } from "../../src/postgres-store.js";
import { MemoryStore, type WhatsAppStore } from "../../src/store.js";

/**
 * The stores a contract test runs against: memory always, and PostgreSQL
 * when `DATALAYER_WHATSAPP_TEST_DATABASE_URL` names a throwaway database
 * (never a cluster's), its schema dropped, migrated, and its tables emptied
 * before each test.
 */
export const DATABASE_URL = process.env.DATALAYER_WHATSAPP_TEST_DATABASE_URL;

export type StoreCase = Readonly<{
  name: string;
  store: () => WhatsAppStore;
  /** The database, for a test that counts rows; memory has none. */
  database: () => pg.Pool | undefined;
}>;

/** Register the hooks and answer the cases, for `describe.each`. */
export function storeCases(): StoreCase[] {
  let database: pg.Pool | undefined;
  let memory = new MemoryStore();
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL },
    });
  }, 60_000);
  beforeEach(async () => {
    memory = new MemoryStore();
    if (!database) return;
    const { rows } = await database.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
    );
    await database.query(
      `TRUNCATE ${rows.map((row) => row.name).join(", ")} RESTART IDENTITY`,
    );
  });
  afterAll(async () => {
    await database?.end();
  });
  return [
    { database: () => undefined, name: "memory", store: () => memory },
    ...(DATABASE_URL
      ? [
          {
            database: () => database,
            name: "PostgreSQL",
            store: () => {
              if (!database) throw new Error("The database is not ready.");
              return new PostgresStore(database);
            },
          },
        ]
      : []),
  ];
}
