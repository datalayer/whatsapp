import { beforeAll, beforeEach } from "vitest";

import type { SolrRecords } from "../../src/solr/records.js";
import { SolrWhatsAppStore } from "../../src/solr-store.js";
import { MemoryStore, type WhatsAppStore } from "../../src/store.js";
import { solrTestUrl, testCollection } from "./solr.js";

/**
 * The stores a contract test runs against: memory always, and Solr when
 * `DATALAYER_SOLR_TEST_URL` names a SolrCloud with the platform's configset
 * (`test/support/solr.ts`): the test file's own throwaway collection,
 * `test_whatsapp_<name>`, emptied before each test (its lock documents
 * kept).
 */
export { solrTestUrl };

export type StoreCase = Readonly<{
  name: string;
  store: () => WhatsAppStore;
  /** The collection, for a test that reads what is kept; memory has none. */
  records: () => SolrRecords | undefined;
}>;

/** Register the hooks and answer the cases, for `describe.each`. */
export function storeCases(name: string): StoreCase[] {
  let records: SolrRecords | undefined;
  let memory = new MemoryStore();
  beforeAll(async () => {
    if (!solrTestUrl) return;
    records = await testCollection(`test_whatsapp_${name}`);
    await records.init();
  }, 60_000);
  beforeEach(async () => {
    memory = new MemoryStore();
    await records?.client.deleteWhere("*:* -type_s:lock");
  });
  return [
    { name: "memory", records: () => undefined, store: () => memory },
    ...(solrTestUrl
      ? [
          {
            name: "Solr",
            records: () => records,
            store: () => {
              if (!records) throw new Error("The collection is not ready.");
              return new SolrWhatsAppStore(records);
            },
          },
        ]
      : []),
  ];
}
