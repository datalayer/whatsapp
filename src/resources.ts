import {
  MemoryWorkQueue,
  PostgresWorkQueue,
  type ReadinessChecks,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Config } from "./config.js";
import { createDatabase } from "./database.js";
import { PostgresStore } from "./postgres-store.js";
import { MemoryStore, type WhatsAppStore } from "./store.js";
import { TABLE_PREFIX } from "./tables.js";
import type { WhatsAppJob } from "./webhook.js";

export type Resources = Readonly<{
  queue: WorkQueue<WhatsAppJob>;
  store: WhatsAppStore;
  /** What `/readyz` asks: the store and the queue, never Meta or Datalayer. */
  checks: ReadinessChecks;
  close(): Promise<void>;
}>;

/**
 * The store and queue: PostgreSQL when `DATABASE_URL` is set (always in
 * production, which `readConfig` enforces), in memory in development and
 * tests only. The queue is the shared host kit's under the `whatsapp`
 * prefix: a message's claim and its job are kept in one transaction.
 */
export function createResources(config: Config): Resources {
  if (!config.DATABASE_URL) {
    const queue = new MemoryWorkQueue<WhatsAppJob>();
    return {
      checks: { queue: () => queue.ready() },
      close: () => queue.stop(),
      queue,
      store: new MemoryStore(),
    };
  }
  const database = createDatabase(config.DATABASE_URL);
  const queue = new PostgresWorkQueue<WhatsAppJob>(database, TABLE_PREFIX);
  return {
    checks: {
      database: async () => {
        await database.query("SELECT 1");
        return true;
      },
      queue: () => queue.ready(),
    },
    close: async () => {
      await queue.stop();
      await database.end();
    },
    queue,
    store: new PostgresStore(database),
  };
}
