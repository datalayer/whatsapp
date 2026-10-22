import type {
  Logger,
  WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { Routes } from "./server.js";
import {
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
} from "./verify.js";

/**
 * Meta's webhooks for the numbers this service answers on.
 *
 * - `GET /whatsapp/webhook`: Meta's endpoint verification, answered its
 *   `hub.challenge` when `hub.verify_token` is ours, 403 otherwise.
 * - `POST /whatsapp/webhook`: the raw body read up to 3 MB (413 past it),
 *   its `X-Hub-Signature-256` checked (401), then every change normalized:
 *   each message claimed by its wamid and enqueued with its claim in one
 *   transaction, each status kept as the message's furthest, each account
 *   event claimed by its content; answered 200 at once. A duplicate (Meta
 *   retries for days, and says its retries may duplicate) claims nothing and
 *   is answered 200. Anything not persisted answers 500, so that Meta tries
 *   again; what was persisted before is claimed already, and stays once.
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

/** Field names under which Meta puts a phone number: never kept. */
const PHONE_FIELDS = new Set([
  "display_phone_number",
  "from",
  "new_wa_id",
  "phone_number",
  "recipient_id",
  "wa_id",
]);

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
export function normalize(body: unknown): Normalized {
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
          job: { kind: "account", field: change.field, value, wabaId },
          key: `account:${sha256(JSON.stringify([wabaId, change.field, value]))}`,
        });
      } else out.ignored.push(`field:${change.field}`);
    }
  }
  return out;
}

export type WebhookDependencies = Readonly<{
  appSecret: string;
  verifyToken: string;
  queue: WorkQueue<WhatsAppJob>;
  store: WhatsAppStore;
  logger: Logger;
}>;

/** `GET` and `POST /whatsapp/webhook`. */
export function webhookRoutes(dependencies: WebhookDependencies): Routes {
  return {
    [`GET ${WEBHOOK_PATH}`]: async (request, response) =>
      verification(dependencies, request, response),
    [`POST ${WEBHOOK_PATH}`]: async (request, response) =>
      receive(dependencies, request, response),
  };
}

function verification(
  dependencies: WebhookDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const challenge = query.get("hub.challenge") ?? "";
  if (
    query.get("hub.mode") === "subscribe" &&
    sameSecret(query.get("hub.verify_token") ?? "", dependencies.verifyToken) &&
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

async function receive(
  dependencies: WebhookDependencies,
  request: IncomingMessage,
  response: ServerResponse,
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
  if (!signedByMeta(request, rawBody, dependencies.appSecret)) {
    dependencies.logger.warn("webhook.unsigned", { size: rawBody.length });
    return send(401);
  }
  let normalized: Normalized;
  try {
    normalized = normalize(JSON.parse(rawBody.toString("utf8")) as unknown);
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
