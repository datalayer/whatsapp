import {
  MemoryQuotaStore,
  MemoryWorkQueue,
  PostgresQuotaStore,
  PostgresWorkQueue,
  SecretCipher,
  type QuotaStore,
  type ReadinessChecks,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Config } from "./config.js";
import { createDatabase } from "./database.js";
import { PostgresStore } from "./postgres-store.js";
import { MemoryStore, type WhatsAppStore } from "./store.js";
import { TABLE_PREFIX } from "./tables.js";
import type { DeliveryQueueJob } from "./deliveries.js";
import type { WhatsAppJob } from "./webhook.js";

export type Job = WhatsAppJob | DeliveryQueueJob;

export type Resources = Readonly<{
  queue: WorkQueue<Job>;
  /**
   * The queues the worker works, each one job at a time on the same table
   * (claimed with SKIP LOCKED): a word such as `stop` is worked while its
   * chat's turn runs. In memory, the one queue.
   */
  workers: readonly WorkQueue<Job>[];
  store: WhatsAppStore;
  quotas: QuotaStore;
  cipher: SecretCipher;
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
  const cipher = new SecretCipher(
    config.DATALAYER_WHATSAPP_SECRET_KEY,
    config.DATALAYER_WHATSAPP_SECRET_KEY_VERSION,
    "DATALAYER_WHATSAPP_SECRET_KEY",
  );
  if (!config.DATABASE_URL) {
    const queue = new MemoryWorkQueue<Job>();
    return {
      checks: { queue: () => queue.ready() },
      cipher,
      close: () => queue.stop(),
      queue,
      quotas: new MemoryQuotaStore(),
      store: new MemoryStore(),
      workers: [queue],
    };
  }
  const database = createDatabase(config.DATABASE_URL);
  const queue = new PostgresWorkQueue<Job>(database, TABLE_PREFIX);
  const workers = Array.from(
    { length: config.DATALAYER_WHATSAPP_WORKERS },
    () => new PostgresWorkQueue<Job>(database, TABLE_PREFIX),
  );
  return {
    cipher,
    quotas: new PostgresQuotaStore(database, { tablePrefix: TABLE_PREFIX }),
    workers,
    checks: {
      database: async () => {
        await database.query("SELECT 1");
        return true;
      },
      queue: () => queue.ready(),
    },
    close: async () => {
      await queue.stop();
      for (const worker of workers) await worker.stop();
      await database.end();
    },
    queue,
    store: new PostgresStore(database),
  };
}
