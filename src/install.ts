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
  BUSINESS_APP_SYNCS,
  META_CODES,
  MetaError,
  OWN_APP_SCOPES,
  type BusinessNumber,
  type MetaPort,
  type TemplateState,
} from "./meta-port.js";
import type { Routes } from "./server.js";
import { appOf, installationData, type WhatsAppStore } from "./store.js";
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
 * Install through Meta's Embedded Signup. The application's Ship card makes
 * the pending installation at Datalayer (its one-use bind code) and runs
 * Embedded Signup in the owner's browser, which answers the business
 * account, the number's id and a code; the card posts them with the bind
 * code to `POST /whatsapp/install`. The service then, server to server:
 * exchanges the code for the business token, checks the number is the
 * account's, subscribes Datalayer's app to the account's webhooks,
 * registers the number with a PIN it makes, creates the three notice
 * templates, binds the installation at Datalayer
 * (`<waba_id>:<phone_number_id>`), registers where deliveries are pushed,
 * and keeps the host key, the business token, the PIN and the delivery
 * secret encrypted. A bind code that is spent or expired stores nothing; a
 * reinstall of the same number replaces the old installation, which ends at
 * Datalayer. Only the card's origin may post (CORS).
 *
 * When the signup's window did not say the account or the number, the
 * service finds them from the business token: the account Meta's
 * debug_token says was granted last, and its only number (several, or
 * none, and nothing is kept). A number kept on the WhatsApp Business app
 * (Meta's coexistence, `coexistence: true`) is not registered again: its
 * contacts and history syncs are asked once instead, as Meta requires
 * within 24 hours; what Meta sends back is not kept. A number registered on
 * the Cloud API already is not registered again (that would need the PIN it
 * was registered with). The business's support contact and privacy page are
 * kept with the installation.
 *
 * Install with the business's own Meta app (WA-48), so that Datalayer need
 * not be a Meta Tech Provider: the card first asks
 * `POST /whatsapp/install/webhook` for the app's webhook address
 * (`/whatsapp/webhook/<key>`, a new unguessable key) and its verify token
 * (derived from the key: nothing is kept until the number is connected, and
 * Meta's verification is answered already). The business puts both in its
 * app, then the card posts the bind code, the key, the app's id and secret
 * and a system user token to `POST /whatsapp/install/own-app`. The service
 * checks the token with Meta's debug_token, asked with that app's own
 * token: it must be the app's, valid, with both WhatsApp permissions. The
 * account and the number are found from the token, then the steps are
 * Embedded Signup's. The app's secret is kept encrypted beside the token:
 * it signs the webhooks of the installation's own address.
 */

export const INSTALL_PATH = "/whatsapp/install";
/** Where the card gets the webhook address and verify token for the business's own app. */
export const OWN_APP_WEBHOOK_PATH = "/whatsapp/install/webhook";
/** Where the card posts the business's own app's credentials. */
export const OWN_APP_INSTALL_PATH = "/whatsapp/install/own-app";
/** The most an install request carries. */
export const INSTALL_BODY_LIMIT = 16 * 1024;

const metaId = z.string().regex(/^\d{1,32}$/);

const requestSchema = z
  .object({
    bind_code: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
    code: z.string().min(1).max(2048),
    /**
     * The business account and the number, as the signup's window said them.
     * Either may be missing (a number kept on the WhatsApp Business app is
     * answered with its account only, and Meta's window sometimes says
     * nothing): the service then finds them from the business token.
     */
    waba_id: metaId.optional(),
    phone_number_id: metaId.optional(),
    /** The number stays on the WhatsApp Business app (Meta's coexistence): never registered again. */
    coexistence: z.boolean().optional(),
    /** How a person reaches someone at the business: said in every chat. */
    support: z.string().trim().min(3).max(200),
    /** The business's privacy page, https: kept with the installation. */
    privacy: z
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
      }),
  })
  .strict();

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

const ownAppRequestSchema = z
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
  /** The service's own verify token: each own app's is derived from it. */
  verifyToken: string;
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
  signup:
    "Meta did not confirm the signup: connect the number again from the Ship tab.",
  notTheAccounts:
    "That number is not one of the business account Meta answered.",
  noAccount:
    "Meta did not say which WhatsApp business account was shared: connect the number again from the Ship tab.",
  whichNumber:
    "Meta did not say which number was connected, and the business account has several or none: connect the number again from the Ship tab.",
  meta: "Meta refused a step of the install: nothing was kept. Try again from the Ship tab.",
  bind: "The install's code from Datalayer was used or expired: nothing was kept. Connect the number again from the Ship tab.",
  pinMismatch:
    "The number has a two-step verification PIN already, and Meta refused the one tried: enter the number's PIN on the card (with your own Meta app), or turn two-step verification off in WhatsApp Manager, then connect again.",
  // With the business's own Meta app (WA-48).
  appRefused:
    "Meta did not accept that app id and app secret together: copy both again from your app's Basic settings.",
  tokenNotTheApp:
    "That access token was made for another app: generate it for the app whose id and secret you entered.",
  tokenInvalid:
    "Meta says that access token is not valid any more: generate a new one.",
  tokenPermissions:
    "That access token lacks whatsapp_business_messaging or whatsapp_business_management: generate a new one with both.",
  ownAppNoAccount:
    "That access token reaches no WhatsApp business account: assign yours to the system user, then generate a new token.",
  ownAppNotTheNumber:
    "That phone number id is not one of the WhatsApp business accounts the access token reaches.",
  ownAppWhichNumber:
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
    [`OPTIONS ${INSTALL_PATH}`]: preflight,
    [`OPTIONS ${OWN_APP_WEBHOOK_PATH}`]: preflight,
    [`OPTIONS ${OWN_APP_INSTALL_PATH}`]: preflight,
    [`POST ${INSTALL_PATH}`]: async (request, response) => {
      const parsed = await read(request, response, requestSchema);
      if (parsed)
        outcome(request, response, await install(dependencies, parsed));
    },
    [`POST ${OWN_APP_WEBHOOK_PATH}`]: async (request, response) => {
      const parsed = await read(request, response, webhookRequestSchema);
      if (parsed)
        answer(
          request,
          response,
          200,
          ownAppWebhookOf(dependencies, parsed.key ?? newWebhookKey()),
        );
    },
    [`POST ${OWN_APP_INSTALL_PATH}`]: async (request, response) => {
      const parsed = await read(request, response, ownAppRequestSchema);
      if (parsed)
        outcome(request, response, await installOwnApp(dependencies, parsed));
    },
  };
}

/**
 * What a business puts in its own app's WhatsApp webhook settings: the
 * callback address, the verify token Meta must echo, and the fields to
 * subscribe. The key is not kept until a number is connected with it.
 */
export function ownAppWebhookOf(
  dependencies: Pick<InstallDependencies, "appUrl" | "verifyToken">,
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
    verify_token: verifyTokenOf(dependencies.verifyToken, key),
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

/** The install through Embedded Signup, once the request is read. */
export async function install(
  dependencies: InstallDependencies,
  request: z.infer<typeof requestSchema>,
): Promise<InstallOutcome> {
  const { port, logger } = dependencies;
  let token: string;
  try {
    token = await port.exchangeCode(request.code);
  } catch (error) {
    logger.warn("install.code_refused", { error });
    return { error: INSTALL_WORDS.signup, ok: false };
  }
  let wabaId: string;
  let number: BusinessNumber | undefined;
  try {
    // The account: as the window said it, else the newest one the token was granted.
    const account =
      request.waba_id ?? (await port.grantedAccounts(token)).at(0);
    if (!account) return { error: INSTALL_WORDS.noAccount, ok: false };
    wabaId = account;
    const numbers = await port.numbers(token, wabaId);
    // The number: as the window said it, else the account's only one.
    number = request.phone_number_id
      ? numbers.find((one) => one.id === request.phone_number_id)
      : numbers.length === 1
        ? numbers[0]
        : undefined;
  } catch (error) {
    return metaRefused(logger, error);
  }
  if (!number)
    return {
      error: request.phone_number_id
        ? INSTALL_WORDS.notTheAccounts
        : INSTALL_WORDS.whichNumber,
      ok: false,
    };
  return connect(dependencies, {
    bindCode: request.bind_code,
    coexistence: request.coexistence === true,
    number,
    privacy: request.privacy,
    support: request.support,
    token,
    wabaId,
  });
}

/** How many business accounts a token's numbers are looked for in, at most. */
export const OWN_APP_ACCOUNTS = 20;

/** The install with the business's own Meta app (WA-48), once the request is read. */
export async function installOwnApp(
  dependencies: InstallDependencies,
  request: z.infer<typeof ownAppRequestSchema>,
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
  if (!OWN_APP_SCOPES.every((scope) => grant.scopes.includes(scope)))
    return { error: INSTALL_WORDS.tokenPermissions, ok: false };
  if (!grant.accounts.length)
    return { error: INSTALL_WORDS.ownAppNoAccount, ok: false };
  // The number: as the card said it, else the only one the token reaches.
  const reached: Array<{ wabaId: string; number: BusinessNumber }> = [];
  try {
    for (const account of grant.accounts.slice(0, OWN_APP_ACCOUNTS))
      for (const number of await port.numbers(token, account))
        reached.push({ number, wabaId: account });
  } catch (error) {
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
        ? INSTALL_WORDS.ownAppNotTheNumber
        : INSTALL_WORDS.ownAppWhichNumber,
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
    bindCode: request.bind_code,
    coexistence: false,
    number: found.number,
    ownApp: {
      appId: request.app_id,
      appSecret: request.app_secret,
      webhookKey: request.webhook_key,
    },
    ...(request.pin ? { pin: request.pin } : {}),
    privacy: request.privacy,
    support: request.support,
    token,
    wabaId: found.wabaId,
  });
}

/** A number found and its business token in hand: what both ways do next. */
type Connection = Readonly<{
  bindCode: string;
  token: string;
  wabaId: string;
  number: BusinessNumber;
  /** Kept on the WhatsApp Business app (Embedded Signup only): never registered. */
  coexistence: boolean;
  /** The number's own two-step PIN, when the business gave it. */
  pin?: string;
  support: string;
  privacy: string;
  ownApp?: Readonly<{ appId: string; appSecret: string; webhookKey: string }>;
}>;

/**
 * Subscribe the app, register the number (or ask a kept business app's
 * syncs), make the templates, bind at Datalayer, register the delivery
 * address, and keep it all encrypted. A refused step keeps nothing.
 */
async function connect(
  dependencies: InstallDependencies,
  connection: Connection,
): Promise<InstallOutcome> {
  const { port, store, cipher, hosts, logger } = dependencies;
  const { token, wabaId, ownApp } = connection;
  const phoneNumberId = connection.number.id;
  const name = connection.number.verifiedName || "The business";
  let pin: string | undefined;
  const templates: Array<[string, TemplateState]> = [];
  try {
    await port.subscribe(token, wabaId);
    if (connection.coexistence)
      // Kept on the WhatsApp Business app: registered already; Meta asks
      // for its contacts and history syncs once, within 24 hours.
      for (const kind of BUSINESS_APP_SYNCS)
        await port.syncBusinessApp(token, phoneNumberId, kind);
    else if (await port.onCloudApi(token, phoneNumberId))
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
    const app = appOf(ownApp ? { ownApp: { appId: ownApp.appId } } : {});
    const others = (await store.installations()).some(
      (one) =>
        one.wabaId === wabaId && one.state !== "removed" && appOf(one) === app,
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
    ...(ownApp
      ? {
          ownApp: {
            appId: ownApp.appId,
            appSecret: cipher.encrypt(
              ownApp.appSecret,
              installationData("app-secret", wabaId, phoneNumberId),
            ),
            webhookKey: ownApp.webhookKey,
          },
        }
      : {}),
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
    way: ownApp ? "own_app" : "embedded_signup",
  });
  return { hostUid: bound.hostUid, name, ok: true };
}
