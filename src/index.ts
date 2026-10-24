import {
  DatalayerHostClient,
  DEFAULT_QUOTAS,
  DELIVERY_ROUTE,
  DeliveryPoller,
  deliveryRoute,
  HostKeyCredentials,
  HttpAgentClient,
  systemClock,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { httpAsPerson } from "./as-person.js";
import { readConfig } from "./config.js";
import { deliverySinkOf } from "./deliveries.js";
import { whatsappShape, type WhatsAppTurn } from "./domain.js";
import { installRoutes } from "./install.js";
import { HttpMetaPort } from "./meta-port.js";
import { Metrics, WhatsAppLogger } from "./observability.js";
import { purgeRemoved, reconcile } from "./removal.js";
import { createResources, type Job } from "./resources.js";
import { createHttpServer, type Routes } from "./server.js";
import { installationData } from "./store.js";
import { webhookRoutes } from "./webhook.js";
import { WindowKeeper } from "./window.js";
import { Worker } from "./worker.js";

/**
 * Datalayer for WhatsApp: one process per role. Every role serves its
 * health; the ingress serves Meta's webhook, the install and Datalayer's
 * signed deliveries, persisting before it answers; the worker works the
 * durable queue: turns, words, approvals, deliveries, account events, the
 * outbox, removals and retention.
 */
const config = readConfig();
const logger = new WhatsAppLogger();
const metrics = new Metrics(logger);
const resources = createResources(config);
const { store, queue, cipher } = resources;
const role = config.DATALAYER_WHATSAPP_ROLE;

const port = new HttpMetaPort({
  appId: config.DATALAYER_WHATSAPP_APP_ID,
  appSecret: config.DATALAYER_WHATSAPP_APP_SECRET,
  clock: systemClock,
  graphUrl: config.DATALAYER_WHATSAPP_GRAPH_URL,
  metrics,
});
const window = new WindowKeeper(store, systemClock, metrics);
const hosts = new DatalayerHostClient(config.DATALAYER_API_URL);
const hostKeyFor = async (request: { provenance: WhatsAppTurn }) => {
  const { wabaId, phoneNumberId } = request.provenance;
  const installation = await store.installation(wabaId, phoneNumberId);
  if (!installation || installation.state === "removed") return undefined;
  return cipher.decrypt(
    installation.hostKey,
    installationData("host-key", wabaId, phoneNumberId),
  );
};
const credentials = new HostKeyCredentials(
  config.DATALAYER_API_URL,
  hostKeyFor,
  whatsappShape,
);
const agent = new HttpAgentClient<WhatsAppTurn>(
  config.DATALAYER_API_URL,
  credentials,
  whatsappShape,
  fetch,
  hostKeyFor,
);
const asPerson = httpAsPerson(credentials, hosts);
// Each delivery queued once by its uid; handled from the queue.
const enqueueDelivery = async (job: {
  delivery: Extract<Job, { kind: "delivery" }>["delivery"];
  hostUid: string;
}): Promise<void> => {
  await queue.enqueue(
    { ...job, kind: "delivery" },
    `delivery:${job.hostUid}:${job.delivery.delivery}`,
  );
};

const routes: Routes =
  role === "worker"
    ? {}
    : {
        ...webhookRoutes({
          appSecret: config.DATALAYER_WHATSAPP_APP_SECRET,
          cipher,
          logger,
          queue,
          store,
          verifyToken: config.DATALAYER_WHATSAPP_VERIFY_TOKEN,
        }),
        ...installRoutes({
          appUrl: config.DATALAYER_WHATSAPP_APP_URL,
          cipher,
          hosts,
          logger,
          port,
          store,
          verifyToken: config.DATALAYER_WHATSAPP_VERIFY_TOKEN,
          webUrl: config.DATALAYER_WEB_URL,
          window,
        }),
        [`POST ${DELIVERY_ROUTE}`]: deliveryRoute(
          deliverySinkOf(store, cipher),
          enqueueDelivery,
        ),
      };

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
 * Retention, hourly, on the worker: chats and holds 30 days after the
 * person's last message, statuses and cards after 30 days, claims after 8,
 * dead jobs after 14, quota counts after a day (`RETENTION`); and removed
 * numbers purged 24 hours after their removal.
 */
const HOUR_MS = 60 * 60 * 1000;
const removal = {
  cipher,
  hosts,
  logger,
  now: () => Date.now(),
  port,
  store,
};
const hourly = (): void => {
  store.retain(new Date()).then(
    (deleted) => logger.info("retention.done", deleted),
    (error: unknown) => logger.error("retention.failed", { error }),
  );
  purgeRemoved(removal).then(
    (purged) =>
      purged ? logger.info("removal.purged", { purged }) : undefined,
    (error: unknown) => logger.error("removal.purge_failed", { error }),
  );
};
const daily = (): void => {
  reconcile(removal).then(
    (removed) => logger.info("removal.reconciled", { removed }),
    (error: unknown) => logger.error("removal.reconcile_failed", { error }),
  );
};
const timers: NodeJS.Timeout[] = [];
let stopPoller = (): void => {};
if (role === "worker" || role === "all") {
  const worker = new Worker({
    agent,
    asPerson,
    cipher,
    clock: systemClock,
    hosts,
    limits: DEFAULT_QUOTAS,
    logger,
    metrics,
    port,
    quotas: resources.quotas,
    store,
    webUrl: config.DATALAYER_WEB_URL,
    window,
  });
  for (const one of resources.workers) one.start((job) => worker.handle(job));
  // The outbox: what a push missed, or every delivery when none is registered.
  const poller = new DeliveryPoller(
    deliverySinkOf(store, cipher),
    hosts,
    enqueueDelivery,
    {
      warn: (message: string) =>
        logger.warn("delivery.outbox_unread", { message }),
    },
  );
  poller.start(config.DATALAYER_DELIVERY_POLL_SECONDS);
  stopPoller = () => poller.stop();
  hourly();
  timers.push(setInterval(hourly, HOUR_MS), setInterval(daily, 24 * HOUR_MS));
  for (const timer of timers) timer.unref();
}

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  timers.forEach(clearInterval);
  stopPoller();
  server.close();
  await resources.close();
  logger.info("service.stopped", { role });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
