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
  MetaError,
  type MetaPort,
  type TemplateState,
} from "./meta-port.js";
import type { Routes } from "./server.js";
import { installationData, type WhatsAppStore } from "./store.js";
import { BodyTooLargeError, rawBodyOf } from "./verify.js";
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
 * within 24 hours; what Meta sends back is not kept. The business's
 * support contact and privacy page are kept with the installation.
 */

export const INSTALL_PATH = "/whatsapp/install";
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

export type InstallDependencies = Readonly<{
  /** The service's public address: where Datalayer pushes deliveries. */
  appUrl: string;
  /** Datalayer's web origin: the only one whose card may post. */
  webUrl: string;
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
  return {
    [`OPTIONS ${INSTALL_PATH}`]: async (request, response) => {
      response.writeHead(request.headers.origin === origin ? 204 : 403, {
        ...cors(request),
      });
      response.end();
    },
    [`POST ${INSTALL_PATH}`]: async (request, response) => {
      if (
        request.headers.origin !== undefined &&
        request.headers.origin !== origin
      )
        return answer(request, response, 403, { error: INSTALL_WORDS.invalid });
      let raw: Buffer;
      try {
        raw = await rawBodyOf(request, INSTALL_BODY_LIMIT);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        request.resume();
        return answer(request, response, 413, { error: INSTALL_WORDS.invalid });
      }
      let parsed;
      try {
        parsed = requestSchema.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        return answer(request, response, 400, { error: INSTALL_WORDS.invalid });
      }
      const outcome = await install(dependencies, parsed);
      return answer(
        request,
        response,
        outcome.ok ? 200 : 400,
        outcome.ok
          ? { connected: true, name: outcome.name }
          : { error: outcome.error },
      );
    },
  };
}

export type InstallOutcome =
  | Readonly<{ ok: true; name: string; hostUid: string }>
  | Readonly<{ ok: false; error: string }>;

/** The install itself, once the request is read. */
export async function install(
  dependencies: InstallDependencies,
  request: z.infer<typeof requestSchema>,
): Promise<InstallOutcome> {
  const { port, store, cipher, hosts, logger } = dependencies;
  let token: string;
  try {
    token = await port.exchangeCode(request.code);
  } catch (error) {
    logger.warn("install.code_refused", { error });
    return { error: INSTALL_WORDS.signup, ok: false };
  }
  const coexistence = request.coexistence === true;
  let wabaId: string;
  let phoneNumberId: string;
  let name: string;
  const pin = coexistence ? undefined : newPin();
  const templates: Array<[string, TemplateState]> = [];
  try {
    // The account: as the window said it, else the newest one the token was granted.
    const account =
      request.waba_id ?? (await port.grantedAccounts(token)).at(0);
    if (!account) return { error: INSTALL_WORDS.noAccount, ok: false };
    wabaId = account;
    const numbers = await port.numbers(token, wabaId);
    // The number: as the window said it, else the account's only one.
    const number = request.phone_number_id
      ? numbers.find((one) => one.id === request.phone_number_id)
      : numbers.length === 1
        ? numbers[0]
        : undefined;
    if (!number)
      return {
        error: request.phone_number_id
          ? INSTALL_WORDS.notTheAccounts
          : INSTALL_WORDS.whichNumber,
        ok: false,
      };
    phoneNumberId = number.id;
    name = number.verifiedName || "The business";
    await port.subscribe(token, wabaId);
    if (pin === undefined)
      // Kept on the WhatsApp Business app: registered already; Meta asks
      // for its contacts and history syncs once, within 24 hours.
      for (const kind of BUSINESS_APP_SYNCS)
        await port.syncBusinessApp(token, phoneNumberId, kind);
    else await port.register(token, phoneNumberId, pin);
    for (const template of Object.values(TEMPLATES))
      templates.push([
        template.name,
        await port.createTemplate(token, wabaId, template),
      ]);
  } catch (error) {
    if (!(error instanceof MetaError)) throw error;
    // Which step, and Meta's own codes: the error's message is redacted by
    // the kit's logger (its field name), these are not and carry nothing private.
    logger.warn("install.meta_refused", {
      step: error.what,
      status: error.status,
      meta_error: error.code,
      meta_subcode: error.subcode,
    });
    return { error: INSTALL_WORDS.meta, ok: false };
  }
  const externalId = externalIdOf(wabaId, phoneNumberId);
  let bound;
  try {
    bound = await hosts.bind({ code: request.bind_code, externalId, name });
  } catch (error) {
    if (!(error instanceof HostRefusedError)) throw error;
    logger.warn("install.bind_refused", { status: error.status });
    // Nothing kept: the app leaves the account unless another number of it is kept.
    const others = (await store.installations()).some(
      (one) => one.wabaId === wabaId && one.state !== "removed",
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
    privacy: request.privacy,
    state: "active",
    support: request.support,
    wabaId,
    ...(deliverySecret ? { deliverySecret } : {}),
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
