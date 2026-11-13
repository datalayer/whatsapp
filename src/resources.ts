import {
  MemoryQuotaStore,
  MemoryWorkQueue,
  SecretCipher,
  type QuotaStore,
  type ReadinessChecks,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Config } from "./config.js";
import type { DeliveryQueueJob } from "./deliveries.js";
import { SolrClient } from "./solr/client.js";
import { SolrWorkQueue } from "./solr/queue.js";
import { SolrQuotaStore } from "./solr/quotas.js";
import { SolrRecords } from "./solr/records.js";
import { SolrWhatsAppStore } from "./solr-store.js";
import { MemoryStore, type WhatsAppStore } from "./store.js";
import type { WhatsAppJob } from "./webhook.js";

export type Job = WhatsAppJob | DeliveryQueueJob;

export type Resources = Readonly<{
  queue: WorkQueue<Job>;
  /**
   * The queues the worker works, each one job at a time over the same
   * collection (a job claimed by its `_version_`): a word such as `stop` is
   * worked while its chat's turn runs. In memory, the one queue.
   */
  workers: readonly WorkQueue<Job>[];
  store: WhatsAppStore;
  quotas: QuotaStore;
  cipher: SecretCipher;
  /** What `/readyz` asks: the store and the queue, never Meta or Datalayer. */
  checks: ReadinessChecks;
  /** What runs once before the service serves: the Solr collection's lock documents. */
  start(): Promise<void>;
  close(): Promise<void>;
}>;

/**
 * The store, queue and quota counts: the service's Solr collection when
 * `DATALAYER_SOLR_URL` is set (always in production and for every role but
 * `all`, which `readConfig` enforces), in memory in development and tests
 * only. A message's claim and its job are written under the claim's lock.
 */
export function createResources(config: Config): Resources {
  const cipher = new SecretCipher(
    config.DATALAYER_WHATSAPP_SECRET_KEY,
    config.DATALAYER_WHATSAPP_SECRET_KEY_VERSION,
    "DATALAYER_WHATSAPP_SECRET_KEY",
  );
  if (!config.DATALAYER_SOLR_URL) {
    const queue = new MemoryWorkQueue<Job>();
    return {
      checks: { queue: () => queue.ready() },
      cipher,
      close: () => queue.stop(),
      queue,
      quotas: new MemoryQuotaStore(),
      start: async () => {},
      store: new MemoryStore(),
      workers: [queue],
    };
  }
  const client = new SolrClient({
    collection: config.DATALAYER_WHATSAPP_SOLR_COLLECTION,
    password: required(config.DATALAYER_SOLR_PASSWORD),
    url: config.DATALAYER_SOLR_URL,
    username: required(config.DATALAYER_SOLR_USERNAME),
  });
  const records = new SolrRecords(client);
  const queue = new SolrWorkQueue<Job>(records);
  const workers = Array.from(
    { length: config.DATALAYER_WHATSAPP_WORKERS },
    () => new SolrWorkQueue<Job>(records),
  );
  return {
    checks: {
      queue: () => queue.ready(),
      solr: () => client.ready(),
    },
    cipher,
    close: async () => {
      await queue.stop();
      for (const worker of workers) await worker.stop();
    },
    queue,
    quotas: new SolrQuotaStore(records),
    start: () => records.init(),
    store: new SolrWhatsAppStore(records),
    workers,
  };
}

/** A setting `readConfig` already required beside the Solr URL. */
function required(value: string | undefined): string {
  if (!value) throw new Error("Solr's credentials are required with its URL.");
  return value;
}
