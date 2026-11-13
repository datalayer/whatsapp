import { WhatsAppLogger } from "./observability.js";
import { SolrClient } from "./solr/client.js";
import { SolrDeadLetters, runDeadLettersCli } from "./solr/dead-letters.js";
import { SolrWorkQueue } from "./solr/queue.js";
import { SolrRecords } from "./solr/records.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * against the service's Solr collection (`DATALAYER_SOLR_URL`,
 * `DATALAYER_SOLR_USERNAME`, `DATALAYER_SOLR_PASSWORD`,
 * `DATALAYER_WHATSAPP_SOLR_COLLECTION`), as DATALAYER_OPERATOR: the dead
 * jobs of the Solr queue, each named by its uid. `list` shows metadata and
 * each payload's hash, never a payload; `payload` shows one dead job's
 * (credentials still redacted) for a stated reason; `replay` puts a dead
 * job back to work. Each read and replay is kept with the operator's name
 * and audited.
 */
const missing = [
  "DATALAYER_SOLR_URL",
  "DATALAYER_SOLR_USERNAME",
  "DATALAYER_SOLR_PASSWORD",
].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(
    `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required.`,
  );
  process.exit(1);
}
const records = new SolrRecords(
  new SolrClient({
    collection: process.env.DATALAYER_WHATSAPP_SOLR_COLLECTION ?? "whatsapp",
    password: process.env.DATALAYER_SOLR_PASSWORD ?? "",
    url: process.env.DATALAYER_SOLR_URL ?? "",
    username: process.env.DATALAYER_SOLR_USERNAME ?? "",
  }),
);
process.exitCode = await runDeadLettersCli(
  new SolrDeadLetters(
    new SolrWorkQueue<unknown>(records),
    "whatsapp",
    new WhatsAppLogger(),
  ),
  process.argv.slice(2),
  process.env.DATALAYER_OPERATOR?.trim() ?? "",
);
