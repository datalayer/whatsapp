import { readdir, readFile } from "node:fs/promises";

import { applyHostSchema } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";

import { TABLE_PREFIX } from "../src/tables.js";

// The shared host tables first (`hostSchemaSql("whatsapp")`: claims, jobs,
// usage, payload access, replays), then every WhatsApp migration in order;
// each is idempotent (IF NOT EXISTS) and re-applied every time (there is no
// ledger). Bundled as dist/migrate.js, run by the chart's migrate job
// (`node dist/migrate.js`); in development with `npm run migrate`.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to migrate.");
  process.exit(1);
}
if (process.argv.length > 2) {
  console.error("Usage: migrate");
  process.exit(1);
}
const database = new pg.Pool({
  application_name: "datalayer-whatsapp-migrate",
  connectionString: url,
  max: 1,
});
// Beside the bundle in the image (/app/migrations), beside scripts/ in the repo.
const folder = new URL("../migrations/", import.meta.url);
const client = await database.connect();
try {
  await applyHostSchema(client, TABLE_PREFIX);
  const files = (await readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files)
    await client.query(await readFile(new URL(name, folder), "utf8"));
  console.info(
    `Applied the shared host tables and ${files.length} WhatsApp database migrations.`,
  );
} finally {
  client.release();
  await database.end();
}
