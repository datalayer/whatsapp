import {
  Logger,
  pseudonym,
  type LogSink,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * WhatsApp's side of the shared observability. The hosts kit's `Logger`
 * already redacts credentials by shape and words by field name (`text`,
 * `body`, `message`, `prompt`…); WhatsApp adds what only it carries: phone
 * numbers and business-scoped user ids (BSUIDs), wherever they appear in a
 * line — a field, an error's message, a nested value. A phone number becomes
 * `[phone]`; a BSUID becomes its pseudonym, so that one person's lines can
 * still be followed without naming them. Spans name ids by pseudonym only;
 * counters are log lines (`metric`) until the service runs beside the
 * plane's OTEL collector, as the kit's `LogTracer` spans are.
 */

/** What WhatsApp's pseudonyms are salted with. */
export const LOG_SALT =
  process.env.DATALAYER_WHATSAPP_LOG_SALT ?? "datalayer-whatsapp";

export const PHONE = "[phone]";

/** Meta's field names that carry a phone number. */
export const PHONE_FIELDS: ReadonlySet<string> = new Set([
  "display_phone_number",
  "from",
  "new_wa_id",
  "phone_number",
  "recipient_id",
  "wa_id",
]);

/** A BSUID: a country code, a period, then Meta's id (up to 131 characters). */
const BSUID = /\b[A-Z]{2}\.[A-Za-z0-9]{8,128}\b/g;
/**
 * A phone number in any writing: eight to fifteen digits, a `+`, and up to
 * two spaces, dashes, dots or brackets between digits, not inside a longer word.
 * Long numeric ids (a number's id, a business account's) match too and are
 * redacted with them: the service logs ids by pseudonym, never as they are.
 */
const PHONE_NUMBER = /(?<![\w+])\+?\(?\d(?:[ .()-]{0,2}\d){7,14}(?![\w])/g;

/** A copy of a value without a phone number or a BSUID in clear. */
export function scrub(value: unknown, salt = LOG_SALT, depth = 0): unknown {
  if (depth > 8) return "[deep]";
  if (typeof value === "string")
    return value
      .replace(BSUID, (id) => `user:${pseudonym(id, salt)}`)
      .replace(PHONE_NUMBER, PHONE);
  if (typeof value === "number" && Number.isInteger(value) && value >= 1e7)
    return PHONE;
  if (Array.isArray(value))
    return value.map((one) => scrub(one, salt, depth + 1));
  if (value instanceof Error)
    return { message: scrub(value.message, salt, depth + 1), name: value.name };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, one]) => [
        name,
        PHONE_FIELDS.has(name) ? PHONE : scrub(one, salt, depth + 1),
      ]),
    );
  return value;
}

/** The kit's logger, its every field scrubbed of phone numbers and BSUIDs first. */
export class WhatsAppLogger extends Logger {
  constructor(sink?: LogSink, clock?: () => Date, salt = LOG_SALT) {
    super(sink, clock, salt);
  }

  #scrub(fields: Record<string, unknown>): Record<string, unknown> {
    return scrub(fields, this.salt) as Record<string, unknown>;
  }

  override info(event: string, fields: Record<string, unknown> = {}): void {
    super.info(event, this.#scrub(fields));
  }

  override warn(event: string, fields: Record<string, unknown> = {}): void {
    super.warn(event, this.#scrub(fields));
  }

  override error(event: string, fields: Record<string, unknown> = {}): void {
    super.error(event, this.#scrub(fields));
  }

  /** The kit pseudonymizes who and where; the rest is scrubbed. */
  override audit(
    event: Parameters<Logger["audit"]>[0],
    fields: Parameters<Logger["audit"]>[1],
  ): void {
    const { by, installation, user, ...rest } = fields;
    super.audit(event, {
      ...this.#scrub(rest),
      installation,
      ...(user ? { user } : {}),
      ...(by ? { by } : {}),
    });
  }
}

/** The pseudonymous attributes of a WhatsApp chat, for a span. */
export function traceAttributes(
  key: Readonly<{ wabaId: string; phoneNumberId: string; userId?: string }>,
  salt = LOG_SALT,
): Record<string, string> {
  return {
    "datalayer.whatsapp.installation": pseudonym(
      `${key.wabaId}:${key.phoneNumberId}`,
      salt,
    ),
    ...(key.userId
      ? { "datalayer.whatsapp.user": pseudonym(key.userId, salt) }
      : {}),
  };
}

/**
 * What the service counts: turns, messages sent by category (`service`,
 * `utility`), notices, holds, Meta's pair rate limit met (131056) and
 * retried, and sends inside or outside the 24-hour window.
 */
export const METRICS = [
  "turns",
  "messages",
  "notices",
  "holds",
  "pair_rate_limited",
  "voice_notes",
  "window",
] as const;
export type MetricName = (typeof METRICS)[number];

/** Counters, each count a `metric` log line, and their totals since start. */
export class Metrics {
  readonly #totals = new Map<string, number>();

  constructor(readonly logger: Logger) {}

  count(
    name: MetricName,
    labels: Readonly<Record<string, string>> = {},
    value = 1,
  ): void {
    const key = JSON.stringify([name, Object.entries(labels).sort()]);
    this.#totals.set(key, (this.#totals.get(key) ?? 0) + value);
    this.logger.info("metric", { ...labels, count: value, metric: name });
  }

  total(name: MetricName, labels: Readonly<Record<string, string>> = {}) {
    return (
      this.#totals.get(JSON.stringify([name, Object.entries(labels).sort()])) ??
      0
    );
  }
}
