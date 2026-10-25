import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALL_PATH,
  INSTALL_WORDS,
  installRoutes,
  WEBHOOK_ADDRESS_PATH,
} from "../../src/install.js";
import { MetaError, TOKEN_SCOPES } from "../../src/meta-port.js";
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
import { TEMPLATE_NAMES, WindowKeeper } from "../../src/window.js";
import { FakeHosts } from "../support/hosts.js";
import {
  APP_SECRET,
  capturingLogger,
  message,
  PHONE_NUMBER_ID,
  serve,
  sign,
  VERIFY_SECRET,
  WABA,
  webhook,
} from "../support/meta.js";
import { RecordingQueue } from "../support/queue.js";
import { storeCases } from "../support/stores.js";
import { APP_ID, FakeClock, FakeMeta, testCipher } from "../support/worker.js";

/**
 * Connecting a number with the application's own Meta app (the one way:
 * Datalayer has none), on a real socket and each store: the webhook address
 * and its verify token answered before anything is kept, Meta's
 * verification answered on it, the token checked with the app's own token
 * (its app, valid, both permissions), the account and number found from it,
 * the app subscribed, a registered number not registered again, the
 * templates, the bind and the delivery address, every secret encrypted, and
 * each webhook of the address checked with that app's secret alone and read
 * for its own account only. Each refusal stores nothing; a reinstall
 * replaces the old installation.
 */

const WEB = "https://datalayer.ai";
const APP = "https://whatsapp.datalayer.run";
/** The application's own app's secret and system user token: test values. */
// Built here, so that no secret scanner takes it for a credential.
const OWN_SECRET = `${"test".repeat(4)}${"0".repeat(16)}`;
const OWN_TOKEN = "EAAtest-only-system-user-token";

describe.each(storeCases())("the install on $name", ({ store, database }) => {
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
        cipher,
        logger,
        queue,
        store: kept,
        verifySecret: VERIFY_SECRET,
      }),
      ...installRoutes({
        appUrl: APP,
        cipher,
        hosts,
        logger,
        port: meta,
        store: kept,
        verifySecret: VERIFY_SECRET,
        webUrl: WEB,
        window,
      }),
    });
    close = served.close;
    const post = (
      path: string,
      body: unknown,
      origin: string | undefined = WEB,
    ) =>
      fetch(`${served.url}${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        method: "POST",
      });
    const address = async (key?: string) =>
      (await (await post(WEBHOOK_ADDRESS_PATH, key ? { key } : {})).json()) as {
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
      window,
    };
  };
  const request = (key: string, extra: Record<string, unknown> = {}) => ({
    app_id: APP_ID,
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
    expect(given.verify_token).toBe(verifyTokenOf(VERIFY_SECRET, given.key));
    expect(given.verify_token).not.toBe(VERIFY_SECRET);
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
    // The service's verify secret is not this address's verify token.
    expect((await verify(given.key, VERIFY_SECRET)).status).toBe(403);
    // There is no shared address.
    expect(
      (
        await fetch(
          `${served.url}${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(given.verify_token)}&hub.challenge=42`,
        )
      ).status,
    ).toBe(404);
    expect((await verify("not-a-key", given.verify_token)).status).toBe(404);
  });

  it("connects a number: the token checked with the app's own, Meta's steps, the bind, the delivery address, every secret encrypted", async () => {
    const { address, cipher, hosts, kept, meta, post, lines } = await setup();
    const { key } = await address();
    const response = await post(INSTALL_PATH, request(key));
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
      detail: APP_ID,
      token: OWN_TOKEN,
    });
    expect(
      meta.calls.filter((one) => one.method !== "tokenOf").map((c) => c.token),
    ).toEqual(Array(7).fill(OWN_TOKEN));
    const pin = meta.calls.find((one) => one.method === "register")?.detail;
    expect(pin).toMatch(/^\d{6}$/);
    expect(hosts.binds).toEqual([
      {
        code: "dlhb_bind-code-1",
        externalId: `${WABA}:${PHONE_NUMBER_ID}`,
        name: "Acme SRL",
      },
    ]);
    expect(hosts.webhooks).toEqual([
      `${APP}/datalayer/deliveries/host-bound-1`,
    ]);
    const [installation] = await kept.installations();
    expect(installation).toMatchObject({
      businessName: "Acme SRL",
      hostUid: "host-bound-1",
      organizationUid: "account-1",
      phoneNumberId: PHONE_NUMBER_ID,
      privacy: "https://acme.example/privacy",
      state: "active",
      support: "support@acme.example",
      wabaId: WABA,
    });
    expect(installation?.app.appId).toBe(APP_ID);
    expect(installation?.app.webhookKey).toBe(key);
    const open = (
      what: Parameters<typeof installationData>[0],
      value: unknown,
    ) =>
      cipher.decrypt(
        value as never,
        installationData(what, WABA, PHONE_NUMBER_ID),
      );
    expect(open("host-key", installation?.hostKey)).toBe("dlhk_bound-1");
    expect(open("pin", installation?.pin)).toBe(pin);
    expect(open("delivery", installation?.deliverySecret)).toBe(
      "dlws_test-only-signing-secret",
    );
    expect(
      cipher.decrypt(
        installation!.app.appSecret!,
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
          (await database()!.query("SELECT * FROM whatsapp_installation")).rows,
        )
      : JSON.stringify(installation);
    for (const secret of [
      OWN_SECRET,
      OWN_TOKEN,
      "dlhk_bound-1",
      String(pin),
      "dlws_test-only",
    ])
      expect(raw).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(OWN_SECRET);
    expect(lines.join("\n")).not.toContain(OWN_TOKEN);
    if (database())
      expect(
        (await database()!.query("SELECT app_id FROM whatsapp_installation"))
          .rows,
      ).toEqual([{ app_id: APP_ID }]);
    expect((await kept.templates(WABA)).map((one) => one.name).sort()).toEqual(
      [...TEMPLATE_NAMES].sort(),
    );
  });

  it("stores nothing for a spent or expired bind code, and takes the app off the account", async () => {
    const { address, hosts, kept, meta, post } = await setup();
    hosts.spentCodes.add("dlhb_bind-code-1");
    const { key } = await address();
    const response = await post(INSTALL_PATH, request(key));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INSTALL_WORDS.bind });
    expect(await kept.installations()).toEqual([]);
    expect(await kept.templates(WABA)).toEqual([]);
    expect(meta.calls.at(-1)).toMatchObject({
      detail: WABA,
      method: "unsubscribe",
      token: OWN_TOKEN,
    });
    expect(hosts.webhooks).toEqual([]);
  });

  it("stores nothing when Meta refuses a step", async () => {
    const { address, hosts, kept, meta, post } = await setup();
    const { key } = await address();
    meta.failNext("register", new MetaError(400, 133016, undefined, "x"));
    expect(await (await post(INSTALL_PATH, request(key))).json()).toEqual({
      error: INSTALL_WORDS.meta,
    });
    meta.failNext("numbers", new MetaError(500, 1, undefined, "x"));
    expect(await (await post(INSTALL_PATH, request(key))).json()).toEqual({
      error: INSTALL_WORDS.meta,
    });
    expect(hosts.binds).toEqual([]);
    expect(await kept.installations()).toEqual([]);
  });

  it("replaces the old installation when the same number is connected again, and reconnects a removed one", async () => {
    const { address, hosts, kept, post } = await setup();
    const { key } = await address();
    expect((await post(INSTALL_PATH, request(key))).status).toBe(200);
    expect(
      (
        await post(
          INSTALL_PATH,
          request(key, { bind_code: "dlhb_bind-code-2" }),
        )
      ).status,
    ).toBe(200);
    const all = await kept.installations();
    expect(all).toHaveLength(1);
    expect(all[0]?.hostUid).toBe("host-bound-2");
    // The first one ends at Datalayer.
    expect(hosts.uninstalledKeys).toEqual(["dlhk_bound-1"]);
    await kept.removeInstallation(WABA, PHONE_NUMBER_ID, new Date());
    expect((await kept.installations())[0]?.businessToken).toBeUndefined();
    expect(
      (
        await post(
          INSTALL_PATH,
          request(key, { bind_code: "dlhb_bind-code-3" }),
        )
      ).status,
    ).toBe(200);
    const [again] = await kept.installations();
    expect(again?.state).toBe("active");
    expect(again?.businessToken).toBeDefined();
    expect(again?.removedAt).toBeUndefined();
    expect(again?.app.webhookKey).toBe(key);
  });

  it("answers the card's preflight from its origin only, and refuses a connection without an https privacy page", async () => {
    const { address, kept, meta, post, served } = await setup();
    for (const path of [INSTALL_PATH, WEBHOOK_ADDRESS_PATH]) {
      const preflight = await fetch(`${served.url}${path}`, {
        headers: { origin: WEB },
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toBe(
        "POST",
      );
      const elsewhere = await fetch(`${served.url}${path}`, {
        headers: { origin: "https://evil.example" },
        method: "OPTIONS",
      });
      expect(elsewhere.status).toBe(403);
      expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();
    }
    const { key } = await address();
    const { privacy: _privacy, ...without } = request(key);
    void _privacy;
    expect((await post(INSTALL_PATH, without)).status).toBe(400);
    for (const privacy of [
      "http://acme.example/privacy",
      "acme.example/privacy",
      "https://localhost/privacy",
    ])
      expect((await post(INSTALL_PATH, request(key, { privacy }))).status).toBe(
        400,
      );
    // Embedded Signup's request is not one this service takes any more.
    expect(
      (
        await post(INSTALL_PATH, {
          bind_code: "dlhb_bind-code-1",
          code: "signup-code",
          phone_number_id: PHONE_NUMBER_ID,
          privacy: "https://acme.example/privacy",
          support: "support@acme.example",
          waba_id: WABA,
        })
      ).status,
    ).toBe(400);
    expect(meta.calls).toEqual([]);
    expect(await kept.installations()).toEqual([]);
  });

  it("does not register a number on the Cloud API already, and keeps the PIN only when given", async () => {
    const { address, kept, meta, post } = await setup();
    meta.registered = true;
    const { key } = await address();
    expect((await post(INSTALL_PATH, request(key))).status).toBe(200);
    expect(meta.calls.some((one) => one.method === "register")).toBe(false);
    expect((await kept.installations())[0]?.pin).toBeUndefined();
    meta.registered = false;
    expect(
      (
        await post(
          INSTALL_PATH,
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
    expect(await (await post(INSTALL_PATH, request(key))).json()).toEqual({
      error: INSTALL_WORDS.pinMismatch,
    });
    expect(hosts.binds).toEqual([]);
    expect(await kept.installations()).toEqual([]);
    expect(lines.join("\n")).toContain('"meta_error":133005');
  });

  it("refuses an app Meta does not know, a token of another app, an invalid one, one without both permissions", async () => {
    const { address, kept, meta, post } = await setup();
    const { key } = await address();
    const said = async () =>
      (await (await post(INSTALL_PATH, request(key))).json()) as {
        error?: string;
      };
    meta.failNext("tokenOf", new MetaError(400, 101, undefined, "x"));
    expect((await said()).error).toBe(INSTALL_WORDS.appRefused);
    meta.tokenGrant = { ...meta.tokenGrant, appId: "3000000000000003" };
    expect((await said()).error).toBe(INSTALL_WORDS.tokenNotTheApp);
    meta.tokenGrant = { ...meta.tokenGrant, appId: APP_ID, valid: false };
    expect((await said()).error).toBe(INSTALL_WORDS.tokenInvalid);
    meta.tokenGrant = {
      ...meta.tokenGrant,
      scopes: [TOKEN_SCOPES[0]],
      valid: true,
    };
    expect((await said()).error).toBe(INSTALL_WORDS.tokenPermissions);
    meta.tokenGrant = {
      ...meta.tokenGrant,
      accounts: [],
      scopes: [...TOKEN_SCOPES],
    };
    expect((await said()).error).toBe(INSTALL_WORDS.noAccount);
    expect(meta.calls.some((one) => one.method === "subscribe")).toBe(false);
    expect(await kept.installations()).toEqual([]);
  });

  it("finds the number across the token's accounts, or asks which", async () => {
    const { address, kept, meta, post } = await setup();
    const { key } = await address();
    meta.tokenGrant = { ...meta.tokenGrant, accounts: [WABA, "777"] };
    expect(await (await post(INSTALL_PATH, request(key))).json()).toEqual({
      error: INSTALL_WORDS.whichNumber,
    });
    expect(
      await (
        await post(INSTALL_PATH, request(key, { phone_number_id: "999" }))
      ).json(),
    ).toEqual({ error: INSTALL_WORDS.notTheNumber });
    expect(await kept.installations()).toEqual([]);
    meta.tokenGrant = { ...meta.tokenGrant, accounts: [WABA] };
    expect(
      (
        await post(
          INSTALL_PATH,
          request(key, { phone_number_id: PHONE_NUMBER_ID }),
        )
      ).status,
    ).toBe(200);
  });

  it("refuses an address another number has, a post from elsewhere, and a malformed request", async () => {
    const { address, kept, meta, post } = await setup();
    const { key } = await address();
    expect((await post(INSTALL_PATH, request(key))).status).toBe(200);
    meta.numbersOf = [{ id: "555", verifiedName: "Acme SRL" }];
    expect(
      await (
        await post(
          INSTALL_PATH,
          request(key, { bind_code: "dlhb_bind-code-2" }),
        )
      ).json(),
    ).toEqual({ error: INSTALL_WORDS.webhookTaken });
    expect(
      (await post(INSTALL_PATH, request(key), "https://evil.example")).status,
    ).toBe(403);
    expect((await post(INSTALL_PATH, request(key, { extra: 1 }))).status).toBe(
      400,
    );
    expect((await post(INSTALL_PATH, request("short"))).status).toBe(400);
    expect((await post(WEBHOOK_ADDRESS_PATH, { key: "short" })).status).toBe(
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
    expect((await post(INSTALL_PATH, request(key))).status).toBe(200);
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
    expect((await post(INSTALL_PATH, request(key))).status).toBe(200);
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
    expect(removed?.app).toEqual({ appId: APP_ID });
    const body = webhook({ messages: [message("wamid.O2")] });
    expect((await deliver(key, body)).status).toBe(404);
    // The address may be used again.
    expect(
      (
        await post(
          INSTALL_PATH,
          request(key, { bind_code: "dlhb_bind-code-2" }),
        )
      ).status,
    ).toBe(200);
  });
});
