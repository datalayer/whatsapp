import type {
  Logger,
  SecretCipher,
  WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { PHONE_FIELDS } from "./observability.js";
import type { Routes } from "./server.js";
import {
  installationData,
  MESSAGE_STATUSES,
  type MessageStatus,
  type StatusUpdate,
  type WhatsAppStore,
  wamidHash,
} from "./store.js";
import {
  BodyTooLargeError,
  rawBodyOf,
  sameSecret,
  signedByMeta,
  verifyTokenOf,
  WEBHOOK_KEY,
} from "./verify.js";

/**
 * Meta's webhooks for the numbers this service answers on. Datalayer has no
 * Meta app: each application's developer connects the application's own,
 * and points it at the installation's own address, `/whatsapp/webhook/<key>`
 * (there is no shared address):
 *
 * - `GET /whatsapp/webhook/<key>`: Meta's endpoint verification, answered
 *   its `hub.challenge` when `hub.verify_token` is the one derived for the
 *   key (`verifyTokenOf`), before the number is connected too, since Meta
 *   verifies the address when it is saved; 403 otherwise.
 * - `POST /whatsapp/webhook/<key>`: 404 for a key no kept installation has;
 *   the raw body read up to 3 MB (413 past it), its `X-Hub-Signature-256`
 *   checked with that installation's own app secret alone (401 for any
 *   other); then only the entries of the installation's own business
 *   account are read, so that an app speaks for its own account and no
 *   other, and every change normalized: each message claimed by its wamid
 *   and enqueued with its claim in one transaction, each status kept as the
 *   message's furthest, each account event claimed by its content and the
 *   app it came through; answered 200 at once. A duplicate (Meta retries for
 *   days, says its retries may duplicate, and every app subscribed to a
 *   business account gets its webhooks) claims nothing and is answered 200.
 *   Anything not persisted answers 500, so that Meta tries again; what was
 *   persisted before is claimed already, and stays once.
 *
 * The ingress never calls Meta or Datalayer: the worker does. It drops every
 * phone number Meta sends (the sender's, a contact's, a status's recipient)
 * before anything is kept: a person is their business-scoped user id
 * (BSUID). The BSUID's field names are Meta's (`from_user_id` on a message,
 * `user_id` on a contact, `recipient_user_id` on a status), as read in Meta's
 * reference before the first deploy.
 */

export const WEBHOOK_PATH = "/whatsapp/webhook";

/** What a person's message becomes in the queue: no phone number, ever. */
export type MessageJob = Readonly<{
  kind: "message";
  wabaId: string;
  phoneNumberId: string;
  /** The person's business-scoped user id (BSUID): who wrote. */
  userId: string;
  wamid: string;
  /** When Meta says it was sent, ISO 8601. */
  at: string;
  /** Meta's message type: `text`, `audio`, `interactive`, `button`, `image`… */
  type: string;
  /** The name the person gave WhatsApp, when Meta sends it. */
  profileName?: string;
  /** What they wrote: a text's body, a quick-reply button's text. */
  text?: string;
  /** A pressed button or a picked row: its id and title. */
  reply?: Readonly<{ id: string; title: string }>;
  /** A voice note, an audio, an image, a video, a document or a sticker: Meta's media id. */
  media?: Readonly<{
    id: string;
    mimeType?: string;
    voice?: boolean;
    caption?: string;
    filename?: string;
  }>;
  /** A reaction to one of the number's messages. */
  reaction?: Readonly<{ wamid: string; emoji: string }>;
  /** The message this one answers, when the person replied to one. */
  replyTo?: string;
  /** A system message: its type, and the person's new BSUID when Meta gives one. */
  system?: Readonly<{ type: string; newUserId?: string }>;
}>;

/** An event about the business's account, number or templates, for the worker. */
export type AccountJob = Readonly<{
  kind: "account";
  field: string;
  wabaId: string;
  /** The Meta app whose address it came to: an access it ends is that app's. */
  appId: string;
  value: unknown;
}>;

export type WhatsAppJob = MessageJob | AccountJob;

/** The account fields the worker is handed; every other field is ignored. */
export const ACCOUNT_FIELDS = [
  "account_alerts",
  "account_update",
  "message_template_status_update",
  "phone_number_quality_update",
  "template_category_update",
] as const;

/**
 * The webhook fields each application's own Meta app subscribes: the
 * messages and their statuses, and the account's events.
 */
export const WEBHOOK_FIELDS = ["messages", ...ACCOUNT_FIELDS] as const;

const id = z.string().min(1).max(512);
const media = z
  .object({
    id,
    mime_type: z.string().optional(),
    voice: z.boolean().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
  })
  .loose();
const messageSchema = z
  .object({
    id,
    timestamp: z.string().regex(/^\d{1,12}$/),
    type: z.string().min(1).max(64),
    from_user_id: z.string().optional(),
    from: z.string().optional(),
    text: z.object({ body: z.string() }).loose().optional(),
    button: z
      .object({ payload: z.string().optional(), text: z.string() })
      .loose()
      .optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id, title: z.string() }).loose().optional(),
        list_reply: z.object({ id, title: z.string() }).loose().optional(),
      })
      .loose()
      .optional(),
    audio: media.optional(),
    document: media.optional(),
    image: media.optional(),
    sticker: media.optional(),
    video: media.optional(),
    reaction: z
      .object({ message_id: id, emoji: z.string().optional() })
      .loose()
      .optional(),
    context: z.object({ id: id.optional() }).loose().optional(),
    system: z
      .object({
        type: z.string(),
        user_id: z.string().optional(),
        new_user_id: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const statusSchema = z
  .object({
    id,
    status: z.string(),
    timestamp: z.string().regex(/^\d{1,12}$/),
    errors: z.array(z.object({ code: z.number().int() }).loose()).optional(),
  })
  .loose();
const messagesValueSchema = z
  .object({
    metadata: z.object({ phone_number_id: id }).loose(),
    contacts: z
      .array(
        z
          .object({
            wa_id: z.string().optional(),
            user_id: z.string().optional(),
            profile: z
              .object({ name: z.string().optional() })
              .loose()
              .optional(),
          })
          .loose(),
      )
      .optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  })
  .loose();
const webhookSchema = z
  .object({
    object: z.literal("whatsapp_business_account"),
    entry: z.array(
      z
        .object({
          id,
          changes: z.array(
            z.object({ field: z.string(), value: z.unknown() }).loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

/** What one webhook carries, normalized: what to claim, what to keep, what was set aside. */
export type Normalized = {
  jobs: { job: WhatsAppJob; key: string }[];
  statuses: StatusUpdate[];
  ignored: string[];
};

/** A copy of an account event's value without any phone number field. */
export function withoutPhoneNumbers(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value))
    return value.map((one) => withoutPhoneNumbers(one, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !PHONE_FIELDS.has(name))
        .map(([name, one]) => [name, withoutPhoneNumbers(one, depth + 1)]),
    );
  return value;
}

const isoOf = (seconds: string): string =>
  new Date(Number(seconds) * 1000).toISOString();

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function messageJob(
  wabaId: string,
  phoneNumberId: string,
  message: z.infer<typeof messageSchema>,
  contacts: z.infer<typeof messagesValueSchema>["contacts"],
): MessageJob | undefined {
  // The sender's contact: the one Meta names by the same wa_id, else the only one.
  const contact =
    contacts?.find((one) => one.wa_id && one.wa_id === message.from) ??
    (contacts?.length === 1 ? contacts[0] : undefined);
  const userId = message.from_user_id ?? contact?.user_id;
  if (!userId) return undefined;
  const reply =
    message.interactive?.button_reply ??
    message.interactive?.list_reply ??
    (message.button
      ? {
          id: message.button.payload ?? message.button.text,
          title: message.button.text,
        }
      : undefined);
  const mediaOf =
    message.audio ??
    message.image ??
    message.video ??
    message.document ??
    message.sticker;
  const text = message.text?.body ?? message.button?.text;
  const name = contact?.profile?.name;
  return {
    kind: "message",
    wabaId,
    phoneNumberId,
    userId,
    wamid: message.id,
    at: isoOf(message.timestamp),
    type: message.type,
    ...(name ? { profileName: name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(reply ? { reply: { id: reply.id, title: reply.title } } : {}),
    ...(mediaOf
      ? {
          media: {
            id: mediaOf.id,
            ...(mediaOf.mime_type ? { mimeType: mediaOf.mime_type } : {}),
            ...(mediaOf.voice !== undefined ? { voice: mediaOf.voice } : {}),
            ...(mediaOf.caption ? { caption: mediaOf.caption } : {}),
            ...(mediaOf.filename ? { filename: mediaOf.filename } : {}),
          },
        }
      : {}),
    ...(message.reaction
      ? {
          reaction: {
            wamid: message.reaction.message_id,
            emoji: message.reaction.emoji ?? "",
          },
        }
      : {}),
    ...(message.context?.id ? { replyTo: message.context.id } : {}),
    ...(message.system
      ? {
          system: {
            type: message.system.type,
            ...((message.system.new_user_id ?? message.system.user_id)
              ? {
                  newUserId: (message.system.new_user_id ??
                    message.system.user_id) as string,
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * A webhook's body, normalized: each message a job keyed by its wamid, each
 * status an update, each account event a job keyed by its content; `calls`
 * and fields this service does not subscribe to set aside. Throws on a body
 * that is not Meta's webhook shape.
 */
export function normalize(body: unknown, appId: string): Normalized {
  const parsed = webhookSchema.parse(body);
  const out: Normalized = { ignored: [], jobs: [], statuses: [] };
  for (const entry of parsed.entry) {
    const wabaId = entry.id;
    for (const change of entry.changes) {
      if (change.field === "messages") {
        const value = messagesValueSchema.parse(change.value);
        const phoneNumberId = value.metadata.phone_number_id;
        for (const message of value.messages ?? []) {
          const job = messageJob(
            wabaId,
            phoneNumberId,
            message,
            value.contacts,
          );
          // Claimed by the id's hash: the id may embed a phone number.
          if (job)
            out.jobs.push({ job, key: `message:${wamidHash(job.wamid)}` });
          else out.ignored.push("message_without_user_id");
        }
        for (const status of value.statuses ?? []) {
          if (
            !(MESSAGE_STATUSES as readonly string[]).includes(status.status)
          ) {
            out.ignored.push(`status:${status.status}`);
            continue;
          }
          const code = status.errors?.[0]?.code;
          out.statuses.push({
            at: new Date(Number(status.timestamp) * 1000),
            phoneNumberId,
            status: status.status as MessageStatus,
            wamid: status.id,
            ...(code !== undefined ? { errorCode: code } : {}),
          });
        }
      } else if ((ACCOUNT_FIELDS as readonly string[]).includes(change.field)) {
        const value = withoutPhoneNumbers(change.value);
        out.jobs.push({
          job: { kind: "account", field: change.field, value, wabaId, appId },
          key: `account:${sha256(JSON.stringify([appId, wabaId, change.field, value]))}`,
        });
      } else out.ignored.push(`field:${change.field}`);
    }
  }
  return out;
}

export type WebhookDependencies = Readonly<{
  /** What each address's verify token is derived from (`verifyTokenOf`). */
  verifySecret: string;
  /** What opens an installation's app secret. */
  cipher: Pick<SecretCipher, "decrypt">;
  queue: Pick<WorkQueue<WhatsAppJob>, "enqueue">;
  store: WhatsAppStore;
  logger: Logger;
}>;

/** The webhook key of a request on `/whatsapp/webhook/:key`, when it is one. */
const keyOf = (request: IncomingMessage): string | undefined => {
  const key = (request as IncomingMessage & { params?: Record<string, string> })
    .params?.key;
  return key && WEBHOOK_KEY.test(key) ? key : undefined;
};

/** `GET` and `POST /whatsapp/webhook/<key>`: each installation's own address. */
export function webhookRoutes(dependencies: WebhookDependencies): Routes {
  return {
    [`GET ${WEBHOOK_PATH}/:key`]: async (request, response) => {
      const key = keyOf(request);
      if (!key) return notFound(response);
      verification(
        dependencies,
        request,
        response,
        verifyTokenOf(dependencies.verifySecret, key),
      );
    },
    [`POST ${WEBHOOK_PATH}/:key`]: async (request, response) => {
      const key = keyOf(request);
      const installation = key
        ? await dependencies.store.installationByWebhookKey(key)
        : undefined;
      const sealed = installation?.app.appSecret;
      if (!installation || installation.state === "removed" || !sealed) {
        dependencies.logger.warn("webhook.unknown_address", {});
        request.resume();
        return notFound(response);
      }
      const appSecret = dependencies.cipher.decrypt(
        sealed,
        installationData(
          "app-secret",
          installation.wabaId,
          installation.phoneNumberId,
        ),
      );
      await receive(dependencies, request, response, {
        appId: installation.app.appId,
        appSecret,
        wabaId: installation.wabaId,
      });
    },
  };
}

function notFound(response: ServerResponse): void {
  response.writeHead(404);
  response.end();
}

function verification(
  dependencies: WebhookDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  verifyToken: string,
): void {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const challenge = query.get("hub.challenge") ?? "";
  if (
    query.get("hub.mode") === "subscribe" &&
    sameSecret(query.get("hub.verify_token") ?? "", verifyToken) &&
    /^[\x21-\x7e]{1,256}$/.test(challenge)
  ) {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(challenge);
    return;
  }
  dependencies.logger.warn("webhook.verification_refused", {});
  response.writeHead(403);
  response.end();
}

/**
 * A body's entries of one business account only: what an installation's app
 * may speak for. The rest is set aside, counted by the caller.
 */
export function onlyAccount(
  body: unknown,
  wabaId: string,
): { body: unknown; foreign: number } {
  if (!body || typeof body !== "object") return { body, foreign: 0 };
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return { body, foreign: 0 };
  const kept = entries.filter(
    (one: unknown) =>
      !!one &&
      typeof one === "object" &&
      (one as { id?: unknown }).id === wabaId,
  );
  return {
    body: { ...body, entry: kept },
    foreign: entries.length - kept.length,
  };
}

async function receive(
  dependencies: WebhookDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  /** The installation's app, and its account: only that account's entries are read. */
  through: Readonly<{ appId: string; appSecret: string; wabaId: string }>,
): Promise<void> {
  const send = (status: number) => {
    response.writeHead(status);
    response.end();
  };
  let rawBody: Buffer;
  try {
    rawBody = await rawBodyOf(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      // Kept no further: the rest drains, and the connection closes after the answer.
      response.writeHead(413, { connection: "close" });
      response.end();
      request.resume();
      return;
    }
    throw error;
  }
  if (!signedByMeta(request, rawBody, through.appSecret)) {
    dependencies.logger.warn("webhook.unsigned", { size: rawBody.length });
    return send(401);
  }
  let normalized: Normalized;
  try {
    const only = onlyAccount(
      JSON.parse(rawBody.toString("utf8")) as unknown,
      through.wabaId,
    );
    if (only.foreign)
      dependencies.logger.warn("webhook.foreign_account", {
        entries: only.foreign,
      });
    normalized = normalize(only.body, through.appId);
  } catch {
    dependencies.logger.error("webhook.malformed", { size: rawBody.length });
    return send(400);
  }
  let claimed = 0;
  try {
    for (const update of normalized.statuses)
      await dependencies.store.applyStatus(update);
    for (const { job, key } of normalized.jobs)
      if (await dependencies.queue.enqueue(job, key)) claimed += 1;
  } catch (error) {
    // Not persisted: Meta tries again, and what was claimed stays once.
    dependencies.logger.error("webhook.not_persisted", { error });
    return send(500);
  }
  dependencies.logger.info("webhook.received", {
    claimed,
    duplicates: normalized.jobs.length - claimed,
    ignored: normalized.ignored,
    statuses: normalized.statuses.length,
  });
  send(200);
}
