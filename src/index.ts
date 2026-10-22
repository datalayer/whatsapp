import { Logger } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { readConfig } from "./config.js";
import { createResources } from "./resources.js";
import { createHttpServer, type Routes } from "./server.js";
import { webhookRoutes, type WhatsAppJob } from "./webhook.js";

/**
 * Datalayer for WhatsApp: one process per role. Every role serves its
 * health; the ingress serves Meta's webhook, persisting before it answers;
 * the worker works the durable queue.
 */
const LOG_SALT =
  process.env.DATALAYER_WHATSAPP_LOG_SALT ?? "datalayer-whatsapp";
const config = readConfig();
const logger = new Logger(undefined, undefined, LOG_SALT);
const resources = createResources(config);
const { store, queue } = resources;
const role = config.DATALAYER_WHATSAPP_ROLE;

const routes: Routes =
  role === "worker"
    ? {}
    : webhookRoutes({
        appSecret: config.DATALAYER_WHATSAPP_APP_SECRET,
        logger,
        queue,
        store,
        verifyToken: config.DATALAYER_WHATSAPP_VERIFY_TOKEN,
      });

const server = createHttpServer(resources.checks, routes, (error) =>
  logger.error("http.failed", { error }),
).listen(config.PORT, () =>
  logger.info("service.started", {
    port: config.PORT,
    role,
    store: config.DATABASE_URL ? "postgres" : "memory",
  }),
);

/**
 * The worker's handling of one job. Turns, links and account events are not
 * handled yet: a job fails loudly, is retried and then dead-lettered with
 * its claim kept, never dropped in silence.
 */
async function handle(job: WhatsAppJob): Promise<void> {
  throw new Error(`No handler for a ${job.kind} job yet.`);
}

if (role === "worker" || role === "all") queue.start(handle);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  server.close();
  await resources.close();
  logger.info("service.stopped", { role });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
