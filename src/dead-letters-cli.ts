import {
  deadLetters,
  runDeadLettersCli,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { createDatabase } from "./database.js";
import { WhatsAppLogger } from "./observability.js";
import { TABLE_PREFIX } from "./tables.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * against DATABASE_URL, as DATALAYER_OPERATOR: the shared host kit's dead
 * letters over `whatsapp_jobs`. `list` shows metadata and each payload's
 * hash, never a payload; `payload` shows one dead job's (credentials still
 * redacted) for a stated reason; `replay` puts a dead job back to work. Each
 * read and replay is kept with the operator's name and audited.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const database = createDatabase(url);
try {
  process.exitCode = await runDeadLettersCli(
    deadLetters(database, TABLE_PREFIX, new WhatsAppLogger()),
    process.argv.slice(2),
    process.env.DATALAYER_OPERATOR?.trim() ?? "",
  );
} finally {
  await database.end();
}
