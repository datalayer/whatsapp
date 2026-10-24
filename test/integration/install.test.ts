import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALL_PATH,
  INSTALL_WORDS,
  installRoutes,
} from "../../src/install.js";
import { MetaError } from "../../src/meta-port.js";
import { Metrics } from "../../src/observability.js";
import { installationData } from "../../src/store.js";
import { TEMPLATE_NAMES, WindowKeeper } from "../../src/window.js";
import { FakeHosts } from "../support/hosts.js";
import {
  capturingLogger,
  PHONE_NUMBER_ID,
  serve,
  VERIFY_TOKEN,
  WABA,
} from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import {
  BUSINESS_TOKEN,
  FakeClock,
  FakeMeta,
  testCipher,
} from "../support/worker.js";

/**
 * Install through Embedded Signup, on a real socket and each store: the
 * card's post with the one-use bind code; the code exchanged, the number
 * checked, the app subscribed, the number registered, the templates made,
 * the bind, the delivery address; every secret encrypted. Each refusal
 * stores nothing; a reinstall replaces the old installation.
 */

const WEB = "https://datalayer.ai";
const APP = "https://whatsapp.datalayer.run";

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
    const { lines, logger } = capturingLogger();
    const window = new WindowKeeper(kept, clock, new Metrics(logger));
    const served = await serve(
      installRoutes({
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
    );
    close = served.close;
    const post = (body: unknown, origin: string | undefined = WEB) =>
      fetch(`${served.url}${INSTALL_PATH}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        method: "POST",
      });
    return { cipher, hosts, kept, lines, meta, post, served, window };
  };
  const request = (bind = "dlhb_bind-code-1") => ({
    bind_code: bind,
    code: "signup-code",
    phone_number_id: PHONE_NUMBER_ID,
    privacy: "https://acme.example/privacy",
    support: "support@acme.example",
    waba_id: WABA,
  });

  it("connects a number: Meta's steps, the bind, the delivery address, every secret encrypted", async () => {
    const { cipher, hosts, kept, meta, post } = await setup();
    const response = await post(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(await response.json()).toEqual({
      connected: true,
      name: "Acme SRL",
    });
    expect(meta.calls.map((one) => one.method)).toEqual([
      "exchangeCode",
      "numbers",
      "subscribe",
      "onCloudApi",
      "register",
      "createTemplate",
      "createTemplate",
      "createTemplate",
    ]);
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
    const open = (
      what: Parameters<typeof installationData>[0],
      value: unknown,
    ) =>
      cipher.decrypt(
        value as never,
        installationData(what, WABA, PHONE_NUMBER_ID),
      );
    expect(open("business-token", installation?.businessToken)).toBe(
      BUSINESS_TOKEN,
    );
    expect(open("host-key", installation?.hostKey)).toBe("dlhk_bound-1");
    expect(open("pin", installation?.pin)).toBe(pin);
    expect(open("delivery", installation?.deliverySecret)).toBe(
      "dlws_test-only-signing-secret",
    );
    // Nothing in clear, in the store as it is kept.
    const raw = database()
      ? JSON.stringify(
          (await database()!.query("SELECT * FROM whatsapp_installation")).rows,
        )
      : JSON.stringify(installation);
    for (const secret of [
      BUSINESS_TOKEN,
      "dlhk_bound-1",
      String(pin),
      "dlws_test-only",
    ])
      expect(raw).not.toContain(secret);
    expect((await kept.templates(WABA)).map((one) => one.name).sort()).toEqual(
      [...TEMPLATE_NAMES].sort(),
    );
  });

  it("stores nothing for a spent or expired bind code, and takes the app off the account", async () => {
    const { hosts, kept, meta, post } = await setup();
    hosts.spentCodes.add("dlhb_bind-code-1");
    const response = await post(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INSTALL_WORDS.bind });
    expect(await kept.installations()).toEqual([]);
    expect(await kept.templates(WABA)).toEqual([]);
    expect(meta.calls.at(-1)).toMatchObject({
      detail: WABA,
      method: "unsubscribe",
    });
    expect(hosts.webhooks).toEqual([]);
  });

  it("stores nothing when Meta refuses the code, the number or a step", async () => {
    const refused = await setup();
    refused.meta.failNext(
      "exchangeCode",
      new MetaError(400, 100, undefined, "x"),
    );
    expect(await (await refused.post(request())).json()).toEqual({
      error: INSTALL_WORDS.signup,
    });
    refused.meta.numbersOf = [{ id: "999", verifiedName: "Other" }];
    expect(await (await refused.post(request())).json()).toEqual({
      error: INSTALL_WORDS.notTheAccounts,
    });
    refused.meta.numbersOf = [
      { id: PHONE_NUMBER_ID, verifiedName: "Acme SRL" },
    ];
    refused.meta.failNext(
      "register",
      new MetaError(400, 133016, undefined, "x"),
    );
    expect(await (await refused.post(request())).json()).toEqual({
      error: INSTALL_WORDS.meta,
    });
    // A PIN set on the number already: said so.
    refused.meta.failNext(
      "register",
      new MetaError(400, 133005, undefined, "x"),
    );
    expect(await (await refused.post(request())).json()).toEqual({
      error: INSTALL_WORDS.pinMismatch,
    });
    expect(refused.hosts.binds).toEqual([]);
    expect(await refused.kept.installations()).toEqual([]);
  });

  it("does not register again a number on the Cloud API already, and keeps no PIN for it", async () => {
    const { kept, meta, post } = await setup();
    meta.registered = true;
    expect((await post(request())).status).toBe(200);
    expect(meta.calls.some((one) => one.method === "register")).toBe(false);
    expect(meta.calls.some((one) => one.method === "onCloudApi")).toBe(true);
    const [installation] = await kept.installations();
    expect(installation?.pin).toBeUndefined();
    expect(installation?.ownApp).toBeUndefined();
  });

  it("replaces the old installation when the same number is connected again", async () => {
    const { hosts, kept, post } = await setup();
    expect((await post(request("dlhb_bind-code-1"))).status).toBe(200);
    expect((await post(request("dlhb_bind-code-2"))).status).toBe(200);
    const all = await kept.installations();
    expect(all).toHaveLength(1);
    expect(all[0]?.hostUid).toBe("host-bound-2");
    // The first one ends at Datalayer.
    expect(hosts.uninstalledKeys).toEqual(["dlhk_bound-1"]);
  });

  it("reconnects a removed number", async () => {
    const { kept, post } = await setup();
    expect((await post(request("dlhb_bind-code-1"))).status).toBe(200);
    await kept.removeInstallation(WABA, PHONE_NUMBER_ID, new Date());
    expect((await kept.installations())[0]?.businessToken).toBeUndefined();
    expect((await post(request("dlhb_bind-code-2"))).status).toBe(200);
    const [again] = await kept.installations();
    expect(again?.state).toBe("active");
    expect(again?.businessToken).toBeDefined();
    expect(again?.removedAt).toBeUndefined();
  });

  it("takes posts from the card's origin only, and refuses a malformed request", async () => {
    const { kept, meta, post, served } = await setup();
    expect((await post(request(), "https://evil.example")).status).toBe(403);
    expect((await post({ ...request(), extra: 1 })).status).toBe(400);
    expect((await post({ ...request(), waba_id: "not-digits" })).status).toBe(
      400,
    );
    const preflight = await fetch(`${served.url}${INSTALL_PATH}`, {
      headers: { origin: WEB },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    const elsewhere = await fetch(`${served.url}${INSTALL_PATH}`, {
      headers: { origin: "https://evil.example" },
      method: "OPTIONS",
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();
    expect(meta.calls).toEqual([]);
    expect(await kept.installations()).toEqual([]);
  });

  it("finds the account and the number from the business token when the signup's window said neither", async () => {
    const { hosts, kept, meta, post } = await setup();
    meta.grantedOf = [WABA, "777"];
    const { waba_id: _waba, phone_number_id: _number, ...bare } = request();
    void _waba;
    void _number;
    const response = await post(bare);
    expect(await response.json()).toEqual({
      connected: true,
      name: "Acme SRL",
    });
    expect(meta.calls.slice(0, 3).map((one) => one.method)).toEqual([
      "exchangeCode",
      "grantedAccounts",
      "numbers",
    ]);
    expect(meta.calls.find((one) => one.method === "numbers")?.detail).toBe(
      WABA,
    );
    expect(hosts.binds[0]?.externalId).toBe(`${WABA}:${PHONE_NUMBER_ID}`);
    expect((await kept.installations())[0]?.phoneNumberId).toBe(
      PHONE_NUMBER_ID,
    );
  });

  it("keeps nothing when the token names no account, or the account has several numbers and none was said", async () => {
    const { hosts, kept, meta, post } = await setup();
    const { waba_id: _waba, phone_number_id: _number, ...bare } = request();
    void _waba;
    void _number;
    meta.grantedOf = [];
    expect(await (await post(bare)).json()).toEqual({
      error: INSTALL_WORDS.noAccount,
    });
    meta.grantedOf = [WABA];
    meta.numbersOf = [
      { id: PHONE_NUMBER_ID, verifiedName: "Acme SRL" },
      { id: "999", verifiedName: "Acme SRL" },
    ];
    expect(await (await post(bare)).json()).toEqual({
      error: INSTALL_WORDS.whichNumber,
    });
    meta.numbersOf = [];
    expect(await (await post({ ...bare, waba_id: WABA })).json()).toEqual({
      error: INSTALL_WORDS.whichNumber,
    });
    // The number said, the account found: one of several is enough.
    meta.numbersOf = [
      { id: "999", verifiedName: "Other" },
      { id: PHONE_NUMBER_ID, verifiedName: "Acme SRL" },
    ];
    expect(hosts.binds).toEqual([]);
    expect(await kept.installations()).toEqual([]);
    expect(
      (await post({ ...bare, phone_number_id: PHONE_NUMBER_ID })).status,
    ).toBe(200);
    expect(meta.calls.some((one) => one.method === "subscribe")).toBe(true);
  });

  it("connects a number kept on the WhatsApp Business app without registering it: its two syncs asked once, no PIN kept", async () => {
    const { kept, meta, post } = await setup();
    const { phone_number_id: _number, ...signedUp } = request();
    void _number;
    const response = await post({ ...signedUp, coexistence: true });
    expect(await response.json()).toEqual({
      connected: true,
      name: "Acme SRL",
    });
    expect(meta.calls.map((one) => one.method)).toEqual([
      "exchangeCode",
      "numbers",
      "subscribe",
      "syncBusinessApp",
      "syncBusinessApp",
      "createTemplate",
      "createTemplate",
      "createTemplate",
    ]);
    expect(
      meta.calls
        .filter((one) => one.method === "syncBusinessApp")
        .map((one) => [one.phoneNumberId, one.detail]),
    ).toEqual([
      [PHONE_NUMBER_ID, "smb_app_state_sync"],
      [PHONE_NUMBER_ID, "history"],
    ]);
    const [installation] = await kept.installations();
    expect(installation?.state).toBe("active");
    expect(installation?.pin).toBeUndefined();
  });

  it("refuses a connection without an https privacy page", async () => {
    const { kept, meta, post } = await setup();
    const { privacy: _privacy, ...without } = request();
    void _privacy;
    expect((await post(without)).status).toBe(400);
    for (const privacy of [
      "http://acme.example/privacy",
      "acme.example/privacy",
      "https://localhost/privacy",
    ])
      expect((await post({ ...request(), privacy })).status).toBe(400);
    expect(meta.calls).toEqual([]);
    expect(await kept.installations()).toEqual([]);
  });
});
