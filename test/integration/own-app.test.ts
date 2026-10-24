import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALL_WORDS,
  installRoutes,
  OWN_APP_INSTALL_PATH,
  OWN_APP_WEBHOOK_PATH,
} from "../../src/install.js";
import { MetaError, OWN_APP_SCOPES } from "../../src/meta-port.js";
import { Metrics } from "../../src/observability.js";
import { removeInstallation } from "../../src/removal.js";
import { installationData } from "../../src/store.js";
import { verifyTokenOf } from "../../src/verify.js";
import {
  WEBHOOK_FIELDS,
  WEBHOOK_PATH,
  webhookRoutes,
  type WhatsAppJob,
} from "../../src/webhook.js";
import { WindowKeeper } from "../../src/window.js";
import { FakeHosts } from "../support/hosts.js";
import {
  APP_SECRET,
  capturingLogger,
  message,
  PHONE_NUMBER_ID,
  serve,
  sign,
  VERIFY_TOKEN,
  WABA,
  webhook,
} from "../support/meta.js";
import { RecordingQueue } from "../support/queue.js";
import { storeCases } from "../support/stores.js";
import {
  FakeClock,
  FakeMeta,
  OWN_APP_ID,
  testCipher,
} from "../support/worker.js";

/**
 * Connecting with the business's own Meta app (WA-48), on a real socket and
 * each store: the webhook address and its verify token answered before
 * anything is kept, Meta's verification answered on it, the token checked
 * with the app's own token (its app, valid, both permissions), the account
 * and number found from it, a registered number not registered again, the
 * app's secret encrypted, and each webhook of the address checked with that
 * app's secret alone and read for its own account only.
 */

const WEB = "https://datalayer.ai";
const APP = "https://whatsapp.datalayer.run";
/** The business's own app's secret and system user token: test values. */
// Built here, so that no secret scanner takes it for a credential.
const OWN_SECRET = `${"test".repeat(4)}${"0".repeat(16)}`;
const OWN_TOKEN = "EAAtest-only-system-user-token";

describe.each(storeCases())(
  "the own app's way on $name",
  ({ store, database }) => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    const setup = async () => {
      const clock = new FakeClock();
      const meta = new FakeMeta(clock);
      const hosts = new FakeHosts();
      const cipher = testCipher();
      const kept = store();
      const queue = new RecordingQueue<WhatsAppJob>();
      const { lines, logger } = capturingLogger();
      const window = new WindowKeeper(kept, clock, new Metrics(logger));
      const served = await serve({
        ...webhookRoutes({
          appSecret: APP_SECRET,
          cipher,
          logger,
          queue,
          store: kept,
          verifyToken: VERIFY_TOKEN,
        }),
        ...installRoutes({
          appUrl: APP,
          cipher,
          hosts,
          logger,
          port: meta,
          store: kept,
          verifyToken: VERIFY_TOKEN,
          webUrl: WEB,
          window,
        }),
      });
      close = served.close;
      const post = (path: string, body: unknown, origin = WEB) =>
        fetch(`${served.url}${path}`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        });
      const address = async (key?: string) =>
        (await (
          await post(OWN_APP_WEBHOOK_PATH, key ? { key } : {})
        ).json()) as {
          key: string;
          callback_url: string;
          verify_token: string;
          fields: string[];
        };
      const deliver = (key: string, body: string, secret = OWN_SECRET) =>
        fetch(`${served.url}${WEBHOOK_PATH}/${key}`, {
          body,
          headers: { "x-hub-signature-256": sign(body, secret) },
          method: "POST",
        });
      return {
        address,
        cipher,
        deliver,
        hosts,
        kept,
        lines,
        logger,
        meta,
        post,
        queue,
        served,
      };
    };
    const request = (key: string, extra: Record<string, unknown> = {}) => ({
      app_id: OWN_APP_ID,
      app_secret: OWN_SECRET,
      bind_code: "dlhb_bind-code-1",
      privacy: "https://acme.example/privacy",
      support: "support@acme.example",
      token: OWN_TOKEN,
      webhook_key: key,
      ...extra,
    });

    it("gives the app's webhook address and verify token, keeps nothing, and answers Meta's verification on it", async () => {
      const { address, kept, served } = await setup();
      const given = await address();
      expect(given.key).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(given.callback_url).toBe(`${APP}${WEBHOOK_PATH}/${given.key}`);
      expect(given.verify_token).toBe(verifyTokenOf(VERIFY_TOKEN, given.key));
      expect(given.verify_token).not.toBe(VERIFY_TOKEN);
      expect(given.fields).toEqual([...WEBHOOK_FIELDS]);
      expect(given.fields).toHaveLength(6);
      // The same key again: the same address, for a page opened again.
      expect(await address(given.key)).toEqual(given);
      expect((await address()).key).not.toBe(given.key);
      expect(await kept.installations()).toEqual([]);
      const verify = (key: string, token: string) =>
        fetch(
          `${served.url}${WEBHOOK_PATH}/${key}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=42`,
        );
      const answered = await verify(given.key, given.verify_token);
      expect(answered.status).toBe(200);
      expect(await answered.text()).toBe("42");
      // Datalayer's own verify token is not this address's.
      expect((await verify(given.key, VERIFY_TOKEN)).status).toBe(403);
      expect((await verify("not-a-key", given.verify_token)).status).toBe(404);
    });

    it("connects a number with the business's own app: the token checked with the app's own, every secret encrypted", async () => {
      const { address, cipher, hosts, kept, meta, post, lines } = await setup();
      const { key } = await address();
      const response = await post(OWN_APP_INSTALL_PATH, request(key));
      expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
      expect(await response.json()).toEqual({
        connected: true,
        name: "Acme SRL",
      });
      expect(meta.calls.map((one) => one.method)).toEqual([
        "tokenOf",
        "numbers",
        "subscribe",
        "onCloudApi",
        "register",
        "createTemplate",
        "createTemplate",
        "createTemplate",
      ]);
      expect(meta.calls[0]).toMatchObject({
        detail: OWN_APP_ID,
        token: OWN_TOKEN,
      });
      expect(
        meta.calls
          .filter((one) => one.method !== "tokenOf")
          .map((c) => c.token),
      ).toEqual(Array(7).fill(OWN_TOKEN));
      expect(hosts.binds[0]?.externalId).toBe(`${WABA}:${PHONE_NUMBER_ID}`);
      const [installation] = await kept.installations();
      expect(installation?.ownApp?.appId).toBe(OWN_APP_ID);
      expect(installation?.ownApp?.webhookKey).toBe(key);
      expect(
        cipher.decrypt(
          installation!.ownApp!.appSecret!,
          installationData("app-secret", WABA, PHONE_NUMBER_ID),
        ),
      ).toBe(OWN_SECRET);
      expect(
        cipher.decrypt(
          installation!.businessToken!,
          installationData("business-token", WABA, PHONE_NUMBER_ID),
        ),
      ).toBe(OWN_TOKEN);
      const raw = database()
        ? JSON.stringify(
            (await database()!.query("SELECT * FROM whatsapp_installation"))
              .rows,
          )
        : JSON.stringify(installation);
      expect(raw).not.toContain(OWN_SECRET);
      expect(raw).not.toContain(OWN_TOKEN);
      expect(lines.join("\n")).not.toContain(OWN_SECRET);
      expect(lines.join("\n")).not.toContain(OWN_TOKEN);
      if (database())
        expect(
          (
            await database()!.query(
              "SELECT way, app_id FROM whatsapp_installation",
            )
          ).rows,
        ).toEqual([{ app_id: OWN_APP_ID, way: "own_app" }]);
    });

    it("does not register a number on the Cloud API already, and keeps the PIN only when given", async () => {
      const { address, kept, meta, post } = await setup();
      meta.registered = true;
      const { key } = await address();
      expect((await post(OWN_APP_INSTALL_PATH, request(key))).status).toBe(200);
      expect(meta.calls.some((one) => one.method === "register")).toBe(false);
      expect((await kept.installations())[0]?.pin).toBeUndefined();
      meta.registered = false;
      expect(
        (
          await post(
            OWN_APP_INSTALL_PATH,
            request(key, { bind_code: "dlhb_bind-code-2", pin: "246813" }),
          )
        ).status,
      ).toBe(200);
      expect(meta.calls.find((one) => one.method === "register")?.detail).toBe(
        "246813",
      );
    });

    it("says a PIN Meta refuses, and keeps nothing", async () => {
      const { address, hosts, kept, lines, meta, post } = await setup();
      meta.failNext("register", new MetaError(400, 133005, undefined, "x"));
      const { key } = await address();
      expect(
        await (await post(OWN_APP_INSTALL_PATH, request(key))).json(),
      ).toEqual({ error: INSTALL_WORDS.pinMismatch });
      expect(hosts.binds).toEqual([]);
      expect(await kept.installations()).toEqual([]);
      expect(lines.join("\n")).toContain('"meta_error":133005');
    });

    it("refuses an app Meta does not know, a token of another app, an invalid one, one without both permissions", async () => {
      const { address, kept, meta, post } = await setup();
      const { key } = await address();
      const said = async () =>
        (await (await post(OWN_APP_INSTALL_PATH, request(key))).json()) as {
          error?: string;
        };
      meta.failNext("tokenOf", new MetaError(400, 101, undefined, "x"));
      expect((await said()).error).toBe(INSTALL_WORDS.appRefused);
      meta.tokenGrant = { ...meta.tokenGrant, appId: "3000000000000003" };
      expect((await said()).error).toBe(INSTALL_WORDS.tokenNotTheApp);
      meta.tokenGrant = { ...meta.tokenGrant, appId: OWN_APP_ID, valid: false };
      expect((await said()).error).toBe(INSTALL_WORDS.tokenInvalid);
      meta.tokenGrant = {
        ...meta.tokenGrant,
        scopes: [OWN_APP_SCOPES[0]],
        valid: true,
      };
      expect((await said()).error).toBe(INSTALL_WORDS.tokenPermissions);
      meta.tokenGrant = {
        ...meta.tokenGrant,
        accounts: [],
        scopes: [...OWN_APP_SCOPES],
      };
      expect((await said()).error).toBe(INSTALL_WORDS.ownAppNoAccount);
      expect(meta.calls.some((one) => one.method === "subscribe")).toBe(false);
      expect(await kept.installations()).toEqual([]);
    });

    it("finds the number across the token's accounts, or asks which", async () => {
      const { address, kept, meta, post } = await setup();
      const { key } = await address();
      meta.tokenGrant = { ...meta.tokenGrant, accounts: [WABA, "777"] };
      expect(
        await (await post(OWN_APP_INSTALL_PATH, request(key))).json(),
      ).toEqual({ error: INSTALL_WORDS.ownAppWhichNumber });
      expect(
        await (
          await post(
            OWN_APP_INSTALL_PATH,
            request(key, { phone_number_id: "999" }),
          )
        ).json(),
      ).toEqual({ error: INSTALL_WORDS.ownAppNotTheNumber });
      expect(await kept.installations()).toEqual([]);
      meta.tokenGrant = { ...meta.tokenGrant, accounts: [WABA] };
      expect(
        (
          await post(
            OWN_APP_INSTALL_PATH,
            request(key, { phone_number_id: PHONE_NUMBER_ID }),
          )
        ).status,
      ).toBe(200);
    });

    it("refuses an address another number has, a post from elsewhere, and a malformed request", async () => {
      const { address, kept, meta, post } = await setup();
      const { key } = await address();
      expect((await post(OWN_APP_INSTALL_PATH, request(key))).status).toBe(200);
      meta.numbersOf = [{ id: "555", verifiedName: "Acme SRL" }];
      expect(
        await (
          await post(
            OWN_APP_INSTALL_PATH,
            request(key, { bind_code: "dlhb_bind-code-2" }),
          )
        ).json(),
      ).toEqual({ error: INSTALL_WORDS.webhookTaken });
      expect(
        (await post(OWN_APP_INSTALL_PATH, request(key), "https://evil.example"))
          .status,
      ).toBe(403);
      expect(
        (await post(OWN_APP_INSTALL_PATH, request(key, { extra: 1 }))).status,
      ).toBe(400);
      expect((await post(OWN_APP_INSTALL_PATH, request("short"))).status).toBe(
        400,
      );
      expect((await post(OWN_APP_WEBHOOK_PATH, { key: "short" })).status).toBe(
        400,
      );
      expect(await kept.installations()).toHaveLength(1);
    });

    it("reads the address's webhooks with the app's own secret only, for its own account only", async () => {
      const { address, deliver, lines, post, queue } = await setup();
      const { key } = await address();
      const body = webhook({ messages: [message("wamid.O1")] });
      // Not connected yet: no installation has the address.
      expect((await deliver(key, body)).status).toBe(404);
      expect((await post(OWN_APP_INSTALL_PATH, request(key))).status).toBe(200);
      expect((await deliver(key, body, APP_SECRET)).status).toBe(401);
      expect((await deliver(key, body, "another-app-secret")).status).toBe(401);
      expect(queue.items).toEqual([]);
      expect((await deliver(key, body)).status).toBe(200);
      expect(queue.items.map((one) => one.key)).toHaveLength(1);
      // Another account's entry, signed by this app: set aside.
      const foreign = body.replace(`"id":"${WABA}"`, '"id":"888"');
      expect((await deliver(key, foreign)).status).toBe(200);
      expect(queue.items).toHaveLength(1);
      expect(lines.join("\n")).toContain("webhook.foreign_account");
    });

    it("ends the address and leaves the app's subscription when the number is removed", async () => {
      const { address, cipher, deliver, hosts, kept, logger, meta, post } =
        await setup();
      const { key } = await address();
      expect((await post(OWN_APP_INSTALL_PATH, request(key))).status).toBe(200);
      const [installation] = await kept.installations();
      expect(
        await removeInstallation(
          {
            cipher,
            hosts,
            logger,
            now: () => Date.now(),
            port: meta,
            store: kept,
          },
          installation!,
          "host-key-refused",
        ),
      ).toBe(true);
      expect(meta.calls.at(-1)).toMatchObject({
        detail: WABA,
        method: "unsubscribe",
        token: OWN_TOKEN,
      });
      const [removed] = await kept.installations();
      expect(removed?.ownApp).toEqual({ appId: OWN_APP_ID });
      const body = webhook({ messages: [message("wamid.O2")] });
      expect((await deliver(key, body)).status).toBe(404);
      // The address may be used again.
      expect(
        (
          await post(
            OWN_APP_INSTALL_PATH,
            request(key, { bind_code: "dlhb_bind-code-2" }),
          )
        ).status,
      ).toBe(200);
    });
  },
);
