import type { Clock } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import type { Metrics } from "./observability.js";
import type { NoticeTemplate } from "./window.js";

/**
 * Meta's Graph API, as the service uses it, behind one interface: messages
 * (text, reply buttons, lists, a button opening a page, documents, utility
 * templates, reactions), the read mark with the typing indicator, media
 * uploads, and what an install does (the code exchanged for the business
 * token, the number checked under its business account, the app
 * subscribed, the number registered, the templates created) and a removal
 * undoes. Nothing else in the service calls Meta; tests give a fake.
 *
 * Every call names the business token it acts with; the port never keeps
 * it, and never writes it, a phone number or a message into an error.
 */

/** A reply button: an id the press comes back with, a title of 20 characters at most. */
export type Button = Readonly<{ id: string; title: string }>;
/** A list row: an id, a title of 24 characters, a description of 72. */
export type Row = Readonly<{ id: string; title: string; description?: string }>;

/** One message the number sends to a person. */
export type Outgoing =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "buttons";
      body: string;
      footer?: string;
      buttons: readonly Button[];
    }>
  | Readonly<{
      type: "list";
      body: string;
      label: string;
      rows: readonly Row[];
    }>
  | Readonly<{
      type: "cta";
      body: string;
      label: string;
      url: string;
      footer?: string;
    }>
  | Readonly<{
      type: "document";
      mediaId: string;
      filename: string;
      caption?: string;
    }>
  | Readonly<{
      type: "template";
      name: string;
      language: string;
      parameters: readonly string[];
    }>
  | Readonly<{ type: "reaction"; messageId: string; emoji: string }>;

/** WhatsApp's limits on what the service sends. */
export const LIMITS = {
  text: 4096,
  /** An interactive message's body: the approval card's room. */
  interactiveBody: 1024,
  footer: 60,
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listLabel: 20,
  ctaLabel: 20,
  caption: 1024,
} as const;

/** What a template's creation answered: its status and category, as Meta keeps them. */
export type TemplateState = Readonly<{ status: string; category: string }>;

/** A number of a business account, by its id and verified name; never its phone number. */
export type BusinessNumber = Readonly<{ id: string; verifiedName: string }>;

/** An application developer's own Meta app: its id and its secret. */
export type MetaApp = Readonly<{ id: string; secret: string }>;

/** What Meta's debug_token says of an access token. */
export type TokenGrant = Readonly<{
  /** The app the token was made for. */
  appId: string;
  valid: boolean;
  /** Its permissions, as Meta names them. */
  scopes: readonly string[];
  /**
   * The business accounts its `whatsapp_business_management` permission
   * reaches, newest first (the granular scope's target ids).
   */
  accounts: readonly string[];
}>;

/** The two permissions the app's system user token needs. */
export const TOKEN_SCOPES = [
  "whatsapp_business_messaging",
  "whatsapp_business_management",
] as const;

/** Meta's error codes the service acts on. */
export const META_CODES = {
  /** The access token is invalid or was revoked: the installation is gone. */
  tokenRefused: 190,
  /** Too many messages to one person in a short time (the pair rate limit). */
  pairRateLimited: 131056,
  /** More than 24 hours since the person's last message: a template only. */
  outsideWindow: 131047,
  /** The template exists already in the account. */
  templateExists: 2388024,
  /** The number has a two-step verification PIN, and it is not the one given. */
  pinMismatch: 133005,
} as const;

/** What Meta refused, with its code: never the request's token or body. */
export class MetaError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
    /** The step Meta refused, in the service's words (no id, no token). */
    readonly what: string,
  ) {
    super(
      `${what}: Meta answered ${status}${code !== undefined ? ` (code ${code}${subcode !== undefined ? `/${subcode}` : ""})` : ""}.`,
    );
  }

  get tokenRefused(): boolean {
    return this.code === META_CODES.tokenRefused;
  }

  get pairRateLimited(): boolean {
    return this.code === META_CODES.pairRateLimited;
  }

  get outsideWindow(): boolean {
    return this.code === META_CODES.outsideWindow;
  }
}

export interface MetaPort {
  /** Send one message to a person (their BSUID): the sent message's id. */
  send(
    token: string,
    phoneNumberId: string,
    userId: string,
    message: Outgoing,
  ): Promise<string>;
  /** Mark the person's message read, with the typing indicator (25 seconds at most). */
  markRead(token: string, phoneNumberId: string, wamid: string): Promise<void>;
  /** Upload a file the number then sends: its media id. */
  upload(
    token: string,
    phoneNumberId: string,
    file: Readonly<{ bytes: Uint8Array; mimeType: string; filename: string }>,
  ): Promise<string>;
  /**
   * A system user token of the developer's own app, read by Meta's
   * debug_token with that app's own token (`<id>|<secret>`, as a bearer):
   * the app it belongs to, whether it is valid, its permissions and the
   * business accounts it reaches. Refused when the id and secret are not
   * an app's.
   */
  tokenOf(app: MetaApp, token: string): Promise<TokenGrant>;
  /**
   * Whether the number is registered on the Cloud API already (its
   * `platform_type` is `CLOUD_API`): it is then not registered again,
   * which would need the PIN it was registered with.
   */
  onCloudApi(token: string, phoneNumberId: string): Promise<boolean>;
  /** The numbers of a business account. */
  numbers(token: string, wabaId: string): Promise<BusinessNumber[]>;
  /** The token's app subscribed to the account's webhooks, or no longer. */
  subscribe(token: string, wabaId: string): Promise<void>;
  unsubscribe(token: string, wabaId: string): Promise<void>;
  /** The number registered for the Cloud API, with its two-step PIN. */
  register(token: string, phoneNumberId: string, pin: string): Promise<void>;
  /** A template created in the account; one that exists already is read. */
  createTemplate(
    token: string,
    wabaId: string,
    template: NoticeTemplate,
  ): Promise<TemplateState>;
}

/**
 * Where a message names its person. Since Meta's business-scoped user ids,
 * a message is addressed by the BSUID; the field is re-read in Meta's
 * reference before the first send.
 */
export const RECIPIENT_FIELD = "to";

/** The body Meta's `/messages` takes for one message. */
export function messageBody(
  userId: string,
  message: Outgoing,
): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    [RECIPIENT_FIELD]: userId,
  };
  switch (message.type) {
    case "text":
      return {
        ...base,
        text: { body: message.text, preview_url: true },
        type: "text",
      };
    case "buttons":
      return {
        ...base,
        interactive: {
          action: {
            buttons: message.buttons.map((one) => ({
              reply: { id: one.id, title: one.title },
              type: "reply",
            })),
          },
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          type: "button",
        },
        type: "interactive",
      };
    case "list":
      return {
        ...base,
        interactive: {
          action: {
            button: message.label,
            sections: [
              {
                rows: message.rows.map((one) => ({
                  id: one.id,
                  title: one.title,
                  ...(one.description ? { description: one.description } : {}),
                })),
                title: message.label,
              },
            ],
          },
          body: { text: message.body },
          type: "list",
        },
        type: "interactive",
      };
    case "cta":
      return {
        ...base,
        interactive: {
          action: {
            name: "cta_url",
            parameters: { display_text: message.label, url: message.url },
          },
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          type: "cta_url",
        },
        type: "interactive",
      };
    case "document":
      return {
        ...base,
        document: {
          filename: message.filename,
          id: message.mediaId,
          ...(message.caption ? { caption: message.caption } : {}),
        },
        type: "document",
      };
    case "template":
      return {
        ...base,
        template: {
          components: [
            {
              parameters: message.parameters.map((text) => ({
                text,
                type: "text",
              })),
              type: "body",
            },
          ],
          language: { code: message.language },
          name: message.name,
        },
        type: "template",
      };
    case "reaction":
      return {
        ...base,
        reaction: { emoji: message.emoji, message_id: message.messageId },
        type: "reaction",
      };
  }
}

/** Throws when a message breaks one of WhatsApp's limits: the renderer keeps to them. */
export function checkLimits(message: Outgoing): void {
  const fail = (what: string) => {
    throw new Error(`A WhatsApp message beyond its limits: ${what}.`);
  };
  switch (message.type) {
    case "text":
      if (!message.text || message.text.length > LIMITS.text) fail("text");
      return;
    case "buttons":
      if (message.body.length > LIMITS.interactiveBody) fail("body");
      if (!message.buttons.length || message.buttons.length > LIMITS.buttons)
        fail("buttons");
      if (message.buttons.some((one) => one.title.length > LIMITS.buttonTitle))
        fail("button title");
      if ((message.footer?.length ?? 0) > LIMITS.footer) fail("footer");
      return;
    case "list":
      if (message.body.length > LIMITS.interactiveBody) fail("body");
      if (!message.rows.length || message.rows.length > LIMITS.listRows)
        fail("rows");
      if (message.rows.some((one) => one.title.length > LIMITS.rowTitle))
        fail("row title");
      if (
        message.rows.some(
          (one) => (one.description?.length ?? 0) > LIMITS.rowDescription,
        )
      )
        fail("row description");
      if (message.label.length > LIMITS.listLabel) fail("list label");
      return;
    case "cta":
      if (message.body.length > LIMITS.interactiveBody) fail("body");
      if (message.label.length > LIMITS.ctaLabel) fail("button label");
      if (!message.url.startsWith("https://")) fail("a page that is not https");
      if ((message.footer?.length ?? 0) > LIMITS.footer) fail("footer");
      return;
    case "document":
      if ((message.caption?.length ?? 0) > LIMITS.caption) fail("caption");
      return;
    default:
      return;
  }
}

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.number().int().optional(),
        error_subcode: z.number().int().optional(),
      })
      .loose(),
  })
  .loose();

/** How long the port waits before trying a message to the same person again, per try. */
export const PAIR_RETRY_MS = 6000;
/** How many times a message refused by the pair rate limit is tried again. */
export const PAIR_RETRIES = 2;

export type HttpMetaPortOptions = Readonly<{
  /** `https://graph.facebook.com/v23.0`: the Graph API and its version. */
  graphUrl: string;
  clock: Pick<Clock, "sleep">;
  metrics: Metrics;
  fetchImplementation?: typeof fetch;
}>;

/** The Graph API over HTTPS. */
export class HttpMetaPort implements MetaPort {
  readonly #options: HttpMetaPortOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HttpMetaPortOptions) {
    this.#options = options;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async #call<T>(
    what: string,
    path: string,
    init: Readonly<{
      method?: string;
      token?: string;
      json?: unknown;
      form?: FormData;
      query?: Record<string, string>;
    }>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${this.#options.graphUrl.replace(/\/+$/, "")}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {}))
      url.searchParams.set(name, value);
    const response = await this.#fetch(url, {
      method: init.method ?? (init.json || init.form ? "POST" : "GET"),
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.json ? { "content-type": "application/json" } : {}),
      },
      ...(init.json ? { body: JSON.stringify(init.json) } : {}),
      ...(init.form ? { body: init.form } : {}),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      throw new MetaError(
        response.status,
        parsed.success ? parsed.data.error.code : undefined,
        parsed.success ? parsed.data.error.error_subcode : undefined,
        what,
      );
    }
    return schema.parse(body);
  }

  async send(
    token: string,
    phoneNumberId: string,
    userId: string,
    message: Outgoing,
  ): Promise<string> {
    checkLimits(message);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const sent = await this.#call(
          "The message was not sent",
          `/${encodeURIComponent(phoneNumberId)}/messages`,
          { json: messageBody(userId, message), token },
          z
            .object({ messages: z.array(z.object({ id: z.string() })).min(1) })
            .loose(),
        );
        return sent.messages[0]!.id;
      } catch (error) {
        if (
          !(error instanceof MetaError && error.pairRateLimited) ||
          attempt >= PAIR_RETRIES
        )
          throw error;
        this.#options.metrics.count("pair_rate_limited");
        await this.#options.clock.sleep(PAIR_RETRY_MS * (attempt + 1));
      }
    }
  }

  async markRead(
    token: string,
    phoneNumberId: string,
    wamid: string,
  ): Promise<void> {
    await this.#call(
      "The message was not marked read",
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        json: {
          message_id: wamid,
          messaging_product: "whatsapp",
          status: "read",
          typing_indicator: { type: "text" },
        },
        token,
      },
      z.unknown(),
    );
  }

  async upload(
    token: string,
    phoneNumberId: string,
    file: Readonly<{ bytes: Uint8Array; mimeType: string; filename: string }>,
  ): Promise<string> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", file.mimeType);
    form.set(
      "file",
      new Blob([file.bytes], { type: file.mimeType }),
      file.filename,
    );
    const uploaded = await this.#call(
      "The file was not uploaded",
      `/${encodeURIComponent(phoneNumberId)}/media`,
      { form, token },
      z.object({ id: z.string().min(1) }).loose(),
    );
    return uploaded.id;
  }

  /** Meta's debug_token for `token`, asked with the app's own token (`<id>|<secret>`). */
  async tokenOf(app: MetaApp, token: string): Promise<TokenGrant> {
    const answered = await this.#call(
      "The app's token was not read",
      "/debug_token",
      {
        query: { input_token: token },
        // The app's own token in the header, never its secret in the address.
        token: `${app.id}|${app.secret}`,
      },
      z
        .object({
          data: z
            .object({
              app_id: z.string().optional(),
              is_valid: z.boolean().optional(),
              scopes: z.array(z.string()).optional(),
              granular_scopes: z
                .array(
                  z
                    .object({
                      scope: z.string(),
                      target_ids: z.array(z.string()).optional(),
                    })
                    .loose(),
                )
                .optional(),
            })
            .loose(),
        })
        .loose(),
    );
    const management = (answered.data.granular_scopes ?? []).find(
      (one) => one.scope === "whatsapp_business_management",
    );
    return {
      accounts: (management?.target_ids ?? []).filter((id) =>
        /^\d{1,32}$/.test(id),
      ),
      appId: answered.data.app_id ?? "",
      scopes: answered.data.scopes ?? [],
      valid: answered.data.is_valid === true,
    };
  }

  async onCloudApi(token: string, phoneNumberId: string): Promise<boolean> {
    const answered = await this.#call(
      "The number's registration was not read",
      `/${encodeURIComponent(phoneNumberId)}`,
      { query: { fields: "platform_type" }, token },
      z.object({ platform_type: z.string().optional() }).loose(),
    );
    return answered.platform_type === "CLOUD_API";
  }

  async numbers(token: string, wabaId: string): Promise<BusinessNumber[]> {
    const answered = await this.#call(
      "The business account's numbers were not read",
      `/${encodeURIComponent(wabaId)}/phone_numbers`,
      // Only the id and the verified name: never the number itself.
      { query: { fields: "id,verified_name" }, token },
      z
        .object({
          data: z.array(
            z
              .object({ id: z.string(), verified_name: z.string().optional() })
              .loose(),
          ),
        })
        .loose(),
    );
    return answered.data.map((one) => ({
      id: one.id,
      verifiedName: one.verified_name ?? "",
    }));
  }

  async subscribe(token: string, wabaId: string): Promise<void> {
    await this.#call(
      "The app was not subscribed to the business account",
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { method: "POST", token },
      z.unknown(),
    );
  }

  async unsubscribe(token: string, wabaId: string): Promise<void> {
    await this.#call(
      "The app was not unsubscribed from the business account",
      `/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { method: "DELETE", token },
      z.unknown(),
    );
  }

  async register(
    token: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    await this.#call(
      "The number was not registered",
      `/${encodeURIComponent(phoneNumberId)}/register`,
      { json: { messaging_product: "whatsapp", pin }, token },
      z.unknown(),
    );
  }

  async createTemplate(
    token: string,
    wabaId: string,
    template: NoticeTemplate,
  ): Promise<TemplateState> {
    const state = z
      .object({ status: z.string(), category: z.string() })
      .loose();
    try {
      const created = await this.#call(
        "The template was not created",
        `/${encodeURIComponent(wabaId)}/message_templates`,
        { json: template, token },
        state,
      );
      return { category: created.category, status: created.status };
    } catch (error) {
      if (
        !(
          error instanceof MetaError &&
          error.subcode === META_CODES.templateExists
        )
      )
        throw error;
    }
    const kept = await this.#call(
      "The template was not read",
      `/${encodeURIComponent(wabaId)}/message_templates`,
      {
        query: { fields: "name,status,category", name: template.name },
        token,
      },
      z.object({ data: z.array(state).min(1) }).loose(),
    );
    const one = kept.data[0]!;
    return { category: one.category, status: one.status };
  }
}
