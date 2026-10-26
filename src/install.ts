import {
  DELIVERY_PATH,
  HostRefusedError,
  type DatalayerHostClient,
  type EncryptedSecret,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { externalIdOf } from "./domain.js";
import {
  META_CODES,
  MetaError,
  TOKEN_SCOPES,
  type BusinessNumber,
  type MetaPort,
  type TemplateState,
} from "./meta-port.js";
import type { Routes } from "./server.js";
import { installationData, type WhatsAppStore } from "./store.js";
import {
  BodyTooLargeError,
  newWebhookKey,
  rawBodyOf,
  verifyTokenOf,
  WEBHOOK_KEY,
} from "./verify.js";
import { WEBHOOK_FIELDS, WEBHOOK_PATH } from "./webhook.js";
import { TEMPLATES, type WindowKeeper } from "./window.js";

/**
 * Install with the application's own Meta app. Datalayer has no Meta app
 * and is not a Meta Tech Provider: each Datalayer application that answers
 * on WhatsApp has its own Meta app, created by its developer under their own
 * business portfolio, so that each application's number, webhook, quality
 * and billing stay its own. The application's Ship card makes the pending
 * installation at Datalayer (its one-use bind code), then asks
 * `POST /whatsapp/install/webhook` for the app's webhook address
 * (`/whatsapp/webhook/<key>`, a new unguessable key) and its verify token
 * (derived from the key with the service's own verify secret: nothing is
 * kept until the number is connected, and Meta's verification is answered
 * already). The developer puts both in the app, then the card posts the
 * bind code, the key, the app's id and secret and a system user token to
 * `POST /whatsapp/install`. Only the card's origin may post (CORS).
 *
 * The service checks the token with Meta's debug_token, asked with that
 * app's own token: it must be the app's, valid, with both WhatsApp
 * permissions. The account and the number are found from the token. Then,
 * server to server: the app subscribed to the account's webhooks, the
 * number registered with a PIN (the one given, or one the service makes)
 * unless it is on the Cloud API already (that would need the PIN it was
 * registered with), the three notice templates created, the installation
 * bound at Datalayer (`<waba_id>:<phone_number_id>`), where deliveries are
 * pushed registered, and the host key, the business token, the PIN, the
 * delivery secret and the app's secret kept encrypted; the app's secret
 * signs the webhooks of the installation's own address. A bind code that is
 * spent or expired stores nothing; a reinstall of the same number replaces
 * the old installation, which ends at Datalayer. The business's support
 * contact and privacy page are kept with the installation.
 */

/** Where the card posts the app's credentials, and the number is connected. */
export const INSTALL_PATH = "/whatsapp/install";
/** Where the card gets the app's webhook address and verify token. */
export const WEBHOOK_ADDRESS_PATH = "/whatsapp/install/webhook";
/** The most an install request carries. */
export const INSTALL_BODY_LIMIT = 16 * 1024;

const metaId = z.string().regex(/^\d{1,32}$/);

const supportSchema = z.string().trim().min(3).max(200);
const privacySchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname.includes(".");
    } catch {
      return false;
    }
  });

const webhookRequestSchema = z
  .object({
    /** A key the card was given before: the same address and verify token again. */
    key: z.string().regex(WEBHOOK_KEY).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    bind_code: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
    /** The key of the webhook address the business put in its app. */
    webhook_key: z.string().regex(WEBHOOK_KEY),
    app_id: metaId,
    app_secret: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
    /** A system user token of the app, with both WhatsApp permissions. */
    token: z.string().regex(/^[A-Za-z0-9_|.-]{20,4096}$/),
    /** Which number, when the token reaches several. */
    phone_number_id: metaId.optional(),
    /**
     * The WhatsApp business account, when the token's grants name none: Meta
     * leaves the account ids out of a system user's grant that covers every
     * account assigned to it.
     */
    waba_id: metaId.optional(),
    /** The number's own two-step verification PIN, when it has one already. */
    pin: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    support: supportSchema,
    privacy: privacySchema,
  })
  .strict();

export type InstallDependencies = Readonly<{
  /** The service's public address: where Datalayer pushes deliveries. */
  appUrl: string;
  /** Datalayer's web origin: the only one whose card may post. */
  webUrl: string;
  /** The service's own verify secret: each address's verify token is derived from it. */
  verifySecret: string;
  store: WhatsAppStore;
  cipher: SecretCipher;
  port: MetaPort;
  window: Pick<WindowKeeper, "created">;
  hosts: Pick<
    DatalayerHostClient,
    "bind" | "self" | "setWebhook" | "uninstalled"
  >;
  logger: Logger;
}>;

/** What the card is answered: connected, or why not in one sentence. */
export const INSTALL_WORDS = {
  invalid: "The install request is not one this service takes.",
  meta: "Meta refused a step of the install: nothing was kept. Try again from the Ship tab.",
  bind: "The install's code from Datalayer was used or expired: nothing was kept. Connect the number again from the Ship tab.",
  pinMismatch:
    "The number has a two-step verification PIN already, and Meta refused the one tried: enter the number's PIN on the card, or turn two-step verification off in WhatsApp Manager, then connect again.",
  appRefused:
    "Meta did not accept that app id and app secret together: copy both again from your app's Basic settings.",
  tokenNotTheApp:
    "That access token was made for another app: generate it for the app whose id and secret you entered.",
  tokenInvalid:
    "Meta says that access token is not valid any more: generate a new one.",
  tokenPermissions:
    "That access token lacks whatsapp_business_messaging or whatsapp_business_management: generate a new one with both.",
  noAccount:
    "Meta does not say which WhatsApp business account that access token reaches: enter the account's id on the card (WhatsApp Manager, Account tools, or the asset_id in its address), then connect again.",
  notTheAccount:
    "That WhatsApp business account id is not one the access token reaches: check it in WhatsApp Manager, or assign the account to the system user and generate a new token.",
  notTheNumber:
    "That phone number id is not one of the WhatsApp business accounts the access token reaches.",
  whichNumber:
    "The access token reaches several numbers, or none: enter the phone number id of the one to connect.",
  webhookTaken:
    "That webhook address is already another number's: show a new address on the card, put it in your app, and connect again.",
} as const;

/** A two-step verification PIN of six digits. */
export const newPin = (): string =>
  Array.from({ length: 6 }, () => String(randomInt(10))).join("");

export function installRoutes(dependencies: InstallDependencies): Routes {
  const origin = new URL(dependencies.webUrl).origin;
  const cors = (request: IncomingMessage): Record<string, string> =>
    request.headers.origin === origin
      ? {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": origin,
          "access-control-max-age": "600",
          vary: "origin",
        }
      : { vary: "origin" };
  const answer = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ) => {
    response.writeHead(status, {
      ...cors(request),
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  };
  const preflight: Routes[string] = async (request, response) => {
    response.writeHead(request.headers.origin === origin ? 204 : 403, {
      ...cors(request),
    });
    response.end();
  };
  /** The request's body as `schema` takes it, or `undefined` once answered. */
  const read = async <T>(
    request: IncomingMessage,
    response: ServerResponse,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> => {
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== origin
    ) {
      answer(request, response, 403, { error: INSTALL_WORDS.invalid });
      return undefined;
    }
    let raw: Buffer;
    try {
      raw = await rawBodyOf(request, INSTALL_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      request.resume();
      answer(request, response, 413, { error: INSTALL_WORDS.invalid });
      return undefined;
    }
    try {
      return schema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      answer(request, response, 400, { error: INSTALL_WORDS.invalid });
      return undefined;
    }
  };
  const outcome = (
    request: IncomingMessage,
    response: ServerResponse,
    done: InstallOutcome,
  ) =>
    answer(
      request,
      response,
      done.ok ? 200 : 400,
      done.ok ? { connected: true, name: done.name } : { error: done.error },
    );
  return {
    [`OPTIONS ${WEBHOOK_ADDRESS_PATH}`]: preflight,
    [`OPTIONS ${INSTALL_PATH}`]: preflight,
    [`POST ${WEBHOOK_ADDRESS_PATH}`]: async (request, response) => {
      const parsed = await read(request, response, webhookRequestSchema);
      if (parsed)
        answer(
          request,
          response,
          200,
          webhookAddressOf(dependencies, parsed.key ?? newWebhookKey()),
        );
    },
    [`POST ${INSTALL_PATH}`]: async (request, response) => {
      const parsed = await read(request, response, requestSchema);
      if (parsed)
        outcome(request, response, await install(dependencies, parsed));
    },
  };
}

/**
 * What the developer puts in the app's WhatsApp webhook settings: the
 * callback address, the verify token Meta must echo, and the fields to
 * subscribe. The key is not kept until a number is connected with it.
 */
export function webhookAddressOf(
  dependencies: Pick<InstallDependencies, "appUrl" | "verifySecret">,
  key: string,
): {
  key: string;
  callback_url: string;
  verify_token: string;
  fields: string[];
} {
  return {
    callback_url: `${dependencies.appUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}/${key}`,
    fields: [...WEBHOOK_FIELDS],
    key,
    verify_token: verifyTokenOf(dependencies.verifySecret, key),
  };
}

export type InstallOutcome =
  | Readonly<{ ok: true; name: string; hostUid: string }>
  | Readonly<{ ok: false; error: string }>;

/** A refused Meta step, logged by its step and Meta's codes: nothing is kept. */
function metaRefused(
  logger: Logger,
  error: unknown,
  words: string = INSTALL_WORDS.meta,
): InstallOutcome {
  if (!(error instanceof MetaError)) throw error;
  // Which step, and Meta's own codes: the error's message is redacted by
  // the kit's logger (its field name), these are not and carry nothing private.
  logger.warn("install.meta_refused", {
    step: error.what,
    status: error.status,
    meta_error: error.code,
    meta_subcode: error.subcode,
  });
  return { error: words, ok: false };
}

/** How many business accounts a token's numbers are looked for in, at most. */
export const TOKEN_ACCOUNTS = 20;

/** The install, once the request is read. */
export async function install(
  dependencies: InstallDependencies,
  request: z.infer<typeof requestSchema>,
): Promise<InstallOutcome> {
  const { port, logger, store } = dependencies;
  const app = { id: request.app_id, secret: request.app_secret };
  const { token } = request;
  let grant;
  try {
    grant = await port.tokenOf(app, token);
  } catch (error) {
    return metaRefused(logger, error, INSTALL_WORDS.appRefused);
  }
  if (grant.appId !== request.app_id)
    return { error: INSTALL_WORDS.tokenNotTheApp, ok: false };
  if (!grant.valid) return { error: INSTALL_WORDS.tokenInvalid, ok: false };
  if (!TOKEN_SCOPES.every((scope) => grant.scopes.includes(scope)))
    return { error: INSTALL_WORDS.tokenPermissions, ok: false };
  // The accounts: as the grant names them; when it names none (a system user's
  // grant over every account assigned to it), the one the card names, which
  // listing its numbers with the token then proves the token reaches.
  if (
    request.waba_id &&
    grant.accounts.length &&
    !grant.accounts.includes(request.waba_id)
  )
    return { error: INSTALL_WORDS.notTheAccount, ok: false };
  const accounts = request.waba_id ? [request.waba_id] : grant.accounts;
  if (!accounts.length) {
    logger.warn("install.no_account_named", { granted: grant.scopes.length });
    return { error: INSTALL_WORDS.noAccount, ok: false };
  }
  // The number: as the card said it, else the only one the token reaches.
  const reached: Array<{ wabaId: string; number: BusinessNumber }> = [];
  try {
    for (const account of accounts.slice(0, TOKEN_ACCOUNTS))
      for (const number of await port.numbers(token, account))
        reached.push({ number, wabaId: account });
  } catch (error) {
    if (request.waba_id && !grant.accounts.length)
      // Meta refused the typed account to this token: said as such, and logged.
      return metaRefused(logger, error, INSTALL_WORDS.notTheAccount);
    return metaRefused(logger, error);
  }
  const found = request.phone_number_id
    ? reached.find((one) => one.number.id === request.phone_number_id)
    : reached.length === 1
      ? reached[0]
      : undefined;
  if (!found)
    return {
      error: request.phone_number_id
        ? INSTALL_WORDS.notTheNumber
        : INSTALL_WORDS.whichNumber,
      ok: false,
    };
  // One webhook address, one number.
  const holder = await store.installationByWebhookKey(request.webhook_key);
  if (
    holder &&
    (holder.wabaId !== found.wabaId || holder.phoneNumberId !== found.number.id)
  )
    return { error: INSTALL_WORDS.webhookTaken, ok: false };
  return connect(dependencies, {
    app: {
      appId: request.app_id,
      appSecret: request.app_secret,
      webhookKey: request.webhook_key,
    },
    bindCode: request.bind_code,
    number: found.number,
    ...(request.pin ? { pin: request.pin } : {}),
    privacy: request.privacy,
    support: request.support,
    token,
    wabaId: found.wabaId,
  });
}

/** A number found and its business token in hand: what is done next. */
type Connection = Readonly<{
  bindCode: string;
  token: string;
  wabaId: string;
  number: BusinessNumber;
  /** The number's own two-step PIN, when the business gave it. */
  pin?: string;
  support: string;
  privacy: string;
  app: Readonly<{ appId: string; appSecret: string; webhookKey: string }>;
}>;

/**
 * Subscribe the app, register the number, make the templates, bind at
 * Datalayer, register the delivery address, and keep it all encrypted. A
 * refused step keeps nothing.
 */
async function connect(
  dependencies: InstallDependencies,
  connection: Connection,
): Promise<InstallOutcome> {
  const { port, store, cipher, hosts, logger } = dependencies;
  const { token, wabaId, app } = connection;
  const phoneNumberId = connection.number.id;
  const name = connection.number.verifiedName || "The business";
  let pin: string | undefined;
  const templates: Array<[string, TemplateState]> = [];
  try {
    await port.subscribe(token, wabaId);
    if (await port.onCloudApi(token, phoneNumberId))
      // Registered on the Cloud API already: registering again would need
      // its PIN; the one the business gave, if any, is kept.
      pin = connection.pin;
    else {
      pin = connection.pin ?? newPin();
      await port.register(token, phoneNumberId, pin);
    }
    for (const template of Object.values(TEMPLATES))
      templates.push([
        template.name,
        await port.createTemplate(token, wabaId, template),
      ]);
  } catch (error) {
    return metaRefused(
      logger,
      error,
      error instanceof MetaError && error.code === META_CODES.pinMismatch
        ? INSTALL_WORDS.pinMismatch
        : INSTALL_WORDS.meta,
    );
  }
  const externalId = externalIdOf(wabaId, phoneNumberId);
  let bound;
  try {
    bound = await hosts.bind({ code: connection.bindCode, externalId, name });
  } catch (error) {
    if (!(error instanceof HostRefusedError)) throw error;
    logger.warn("install.bind_refused", { status: error.status });
    // Nothing kept: the app leaves the account unless another number of it is kept through it.
    const others = (await store.installations()).some(
      (one) =>
        one.wabaId === wabaId &&
        one.state !== "removed" &&
        one.app.appId === app.appId,
    );
    if (!others)
      await port
        .unsubscribe(token, wabaId)
        .catch((failure: unknown) =>
          logger.warn("install.unsubscribe_failed", { error: failure }),
        );
    return { error: INSTALL_WORDS.bind, ok: false };
  }
  const self = await hosts.self(bound.hostKey);
  // Where Datalayer pushes this number's deliveries; refused or unreachable,
  // the worker reads the outbox instead.
  let deliverySecret: EncryptedSecret | undefined;
  try {
    const { signingSecret } = await hosts.setWebhook(
      bound.hostKey,
      `${dependencies.appUrl.replace(/\/+$/, "")}${DELIVERY_PATH}/${encodeURIComponent(bound.hostUid)}`,
    );
    deliverySecret = cipher.encrypt(
      signingSecret,
      installationData("delivery", wabaId, phoneNumberId),
    );
  } catch (error) {
    logger.warn("install.delivery_not_registered", { error });
  }
  // A reinstall: the old installation ends at Datalayer.
  const before = await store.installation(wabaId, phoneNumberId);
  if (before && before.state !== "removed" && before.hostUid !== bound.hostUid)
    await hosts
      .uninstalled(
        cipher.decrypt(
          before.hostKey,
          installationData("host-key", wabaId, phoneNumberId),
        ),
      )
      .catch((error: unknown) =>
        logger.warn("install.previous_not_ended", { error }),
      );
  await store.saveInstallation({
    businessName: name,
    businessToken: cipher.encrypt(
      token,
      installationData("business-token", wabaId, phoneNumberId),
    ),
    hostKey: cipher.encrypt(
      bound.hostKey,
      installationData("host-key", wabaId, phoneNumberId),
    ),
    hostUid: bound.hostUid,
    organizationUid: self.accountUid,
    phoneNumberId,
    ...(pin === undefined
      ? {}
      : {
          pin: cipher.encrypt(
            pin,
            installationData("pin", wabaId, phoneNumberId),
          ),
        }),
    privacy: connection.privacy,
    state: "active",
    support: connection.support,
    wabaId,
    ...(deliverySecret ? { deliverySecret } : {}),
    app: {
      appId: app.appId,
      appSecret: cipher.encrypt(
        app.appSecret,
        installationData("app-secret", wabaId, phoneNumberId),
      ),
      webhookKey: app.webhookKey,
    },
  });
  for (const [template, state] of templates)
    await dependencies.window.created(
      wabaId,
      template,
      state.status,
      state.category,
    );
  logger.audit("admin.changed", {
    installation: externalId,
    reason: before ? "reinstalled" : "installed",
  });
  return { hostUid: bound.hostUid, name, ok: true };
}
