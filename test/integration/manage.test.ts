import { afterEach, describe, expect, it } from "vitest";

import {
  conditionsOf,
  MANAGE_PATH,
  MANAGE_WORDS,
  manageRoutes,
  ownerCheckOf,
  WHATSAPP_MANAGER_URL,
} from "../../src/manage.js";
import { MetaError } from "../../src/meta-port.js";
import { capturingLogger, PHONE_NUMBER_ID, serve } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import {
  BUSINESS_TOKEN,
  FakeClock,
  FakeMeta,
  installation,
  testCipher,
} from "../support/worker.js";

/**
 * What the Ship card manages on a connected number, on a real socket and
 * each store (WA-49, WA-22): only from Datalayer's origin, only for the
 * owner ai-agents says owns the installation (their Datalayer token shown
 * to ai-agents, never kept or logged); the Official Business Account's
 * status and conditions, and its request through Meta's API; the number's
 * groups created, their invite links read and reset, deleted.
 */

const WEB = "https://datalayer.ai";
const OWNER_TOKEN = "dl-test-only-owner-token-0001";
const HOST_UID = `host-${PHONE_NUMBER_ID}`;
const DAY = 24 * 60 * 60 * 1000;

describe("the Official Business Account's conditions", () => {
  it("says what the service can read of each, and leaves the rest to the business", () => {
    const cipher = testCipher();
    const now = Date.UTC(2026, 10, 25);
    const old = installation(cipher, { installedAt: new Date(now - 31 * DAY) });
    expect(
      conditionsOf(
        old,
        { businessVerification: "verified", nameStatus: "APPROVED" },
        now,
      ),
    ).toEqual([
      { id: "policy", state: "unknown" },
      { detail: "2026-10-25", id: "platform_days", state: "met" },
      { detail: "VERIFIED", id: "business_verified", state: "met" },
      { id: "two_step", state: "met" },
      { detail: "APPROVED", id: "display_name", state: "met" },
    ]);
    const { pin: _pin, ...withoutPin } = installation(cipher, {
      installedAt: new Date(now - 3 * DAY),
    });
    void _pin;
    expect(
      conditionsOf(
        withoutPin,
        { businessVerification: "PENDING", nameStatus: "PENDING_REVIEW" },
        now,
      ).map((one) => [one.id, one.state]),
    ).toEqual([
      ["policy", "unknown"],
      ["platform_days", "unknown"],
      ["business_verified", "not_met"],
      ["two_step", "unknown"],
      ["display_name", "not_met"],
    ]);
    expect(
      conditionsOf(old, {}, now).find((one) => one.id === "display_name")
        ?.state,
    ).toBe("unknown");
  });
});

describe("the owner check", () => {
  it("asks ai-agents with the person's own token, and takes only an active WhatsApp installation", async () => {
    const asked: Array<{ url: string; authorization: string | null }> = [];
    const answers = [
      { host: { kind: "whatsapp", state: "active", uid: "host-1" } },
      { host: { kind: "slack", state: "active", uid: "host-1" } },
      { host: { kind: "whatsapp", state: "revoked", uid: "host-1" } },
    ];
    const check = ownerCheckOf("https://prod1.datalayer.run/", (async (
      url: string,
      init: RequestInit,
    ) => {
      asked.push({
        authorization: new Headers(init.headers).get("authorization"),
        url,
      });
      const body = answers.shift();
      return new Response(JSON.stringify(body ?? {}), {
        status: body ? 200 : 404,
      });
    }) as typeof fetch);
    expect(await check(OWNER_TOKEN, "host-1")).toBe(true);
    expect(await check(OWNER_TOKEN, "host-1")).toBe(false);
    expect(await check(OWNER_TOKEN, "host-1")).toBe(false);
    expect(await check(OWNER_TOKEN, "host-1")).toBe(false);
    expect(asked[0]).toEqual({
      authorization: `Bearer ${OWNER_TOKEN}`,
      url: "https://prod1.datalayer.run/api/ai-agents/v1/apps/hosts/host-1",
    });
  });
});

describe.each(storeCases())("the card's management on $name", ({ store }) => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const setup = async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 25));
    const meta = new FakeMeta(clock);
    const cipher = testCipher();
    const kept = store();
    const { lines, logger } = capturingLogger();
    await kept.saveInstallation(installation(cipher));
    const owners: string[] = [];
    const served = await serve(
      manageRoutes({
        cipher,
        logger,
        now: () => clock.now(),
        owner: async (bearer, uid) => {
          owners.push(uid);
          return bearer === OWNER_TOKEN && uid === HOST_UID;
        },
        port: meta,
        store: kept,
        webUrl: WEB,
      }),
    );
    close = served.close;
    const post = async (
      path: string,
      body: Record<string, unknown>,
      options: { origin?: string; token?: string } = {},
    ) => {
      const response = await fetch(`${served.url}${MANAGE_PATH}${path}`, {
        body: JSON.stringify({ host_uid: HOST_UID, ...body }),
        headers: {
          "content-type": "application/json",
          origin: options.origin ?? WEB,
          ...(options.token === ""
            ? {}
            : { authorization: `Bearer ${options.token ?? OWNER_TOKEN}` }),
        },
        method: "POST",
      });
      return {
        body: (await response.json()) as Record<string, unknown>,
        response,
      };
    };
    return { clock, kept, lines, meta, owners, post, url: served.url };
  };

  it("answers only Datalayer's origin and the owner, and never logs their token", async () => {
    const t = await setup();
    const preflight = await fetch(`${t.url}${MANAGE_PATH}/groups`, {
      headers: { origin: WEB },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(
      (await t.post("/groups", {}, { origin: "https://evil.example" })).response
        .status,
    ).toBe(403);
    const stranger = await t.post(
      "/groups",
      {},
      { token: "dl-someone-else-token-0002" },
    );
    expect(stranger.response.status).toBe(403);
    expect(stranger.body).toEqual({ error: MANAGE_WORDS.notOwner });
    expect((await t.post("/groups", {}, { token: "" })).response.status).toBe(
      403,
    );
    expect((await t.post("/groups", { extra: 1 })).response.status).toBe(400);
    expect((await t.post("/groups", {})).response.status).toBe(200);
    expect(
      t.meta.calls.every((one) => !one.token || one.token === BUSINESS_TOKEN),
    ).toBe(true);
    expect(t.lines.join("\n")).not.toContain(OWNER_TOKEN);
  });

  it("reads the Official Business Account's status and conditions, and requests it through Meta", async () => {
    const t = await setup();
    const status = await t.post("/official", {});
    expect(status.body).toMatchObject({
      groups_allowed: false,
      manager_url: WHATSAPP_MANAGER_URL,
      may_request: true,
      status: "NOT_STARTED",
    });
    expect((status.body.conditions as unknown[]).length).toBe(5);
    // A request needs the business's website (https) and its country.
    expect(
      (
        await t.post("/official/request", {
          country: "BE",
          website: "http://acme.example",
        })
      ).response.status,
    ).toBe(400);
    const asked = await t.post("/official/request", {
      country: "Belgium",
      website: "https://acme.example",
    });
    expect(asked.body).toMatchObject({ may_request: false, status: "PENDING" });
    expect(t.meta.officialRequests).toEqual([
      { country: "Belgium", website: "https://acme.example" },
    ]);
    const again = await t.post("/official/request", {
      country: "Belgium",
      website: "https://acme.example",
    });
    expect(again.response.status).toBe(409);
    expect(again.body).toEqual({ error: MANAGE_WORDS.requestRunning });
    t.meta.official = { message: "Approved.", status: "APPROVED" };
    expect((await t.post("/official", {})).body).toMatchObject({
      groups_allowed: true,
      status: "APPROVED",
      status_message: "Approved.",
    });
  });

  it("creates a group, finds its id at Meta when the webhook did not come, gives and resets its invite link, deletes it", async () => {
    const t = await setup();
    const made = await t.post("/groups/create", { subject: "Launch team" });
    expect(made.body).toMatchObject({
      groups: [{ state: "active", subject: "Launch team" }],
      most_people: 8,
    });
    const [group] = made.body.groups as Array<{
      ref: string;
      group_id: string;
    }>;
    expect(group?.group_id).toMatch(/^Y2FwaV9ncm91cDp0ZXN0/);
    expect(t.meta.calls.filter((one) => one.method === "groups")).toHaveLength(
      1,
    );

    const link = await t.post("/groups/link", { group_id: group!.group_id });
    expect(link.body).toEqual({
      group_id: group!.group_id,
      invite_link: "https://chat.whatsapp.com/TestLink1",
    });
    const reset = await t.post("/groups/link", {
      group_id: group!.group_id,
      reset: true,
    });
    expect(reset.body.invite_link).toBe("https://chat.whatsapp.com/TestLink1r");
    // The link is never kept.
    expect(JSON.stringify(await t.kept.groups(PHONE_NUMBER_ID))).not.toContain(
      "chat.whatsapp.com",
    );

    const gone = await t.post("/groups/delete", { ref: group!.ref });
    expect(gone.body).toMatchObject({ groups: [] });
    expect(t.meta.metaGroups.size).toBe(0);
    expect(
      (await t.post("/groups/link", { group_id: group!.group_id })).response
        .status,
    ).toBe(404);
  });

  it("keeps a group Meta answered at once, and says Meta's refusals in the card's words", async () => {
    const t = await setup();
    t.meta.groupIdAtOnce = true;
    await t.post("/groups/create", { subject: "Board" });
    expect(t.meta.calls.filter((one) => one.method === "groups")).toHaveLength(
      0,
    );
    t.meta.failNext(
      "createGroup",
      new MetaError(400, 131215, undefined, "Not eligible"),
    );
    const refused = await t.post("/groups/create", { subject: "Another" });
    expect(refused.response.status).toBe(502);
    expect(refused.body).toEqual({ error: MANAGE_WORDS.notEligible });
    expect(await t.kept.groups(PHONE_NUMBER_ID)).toHaveLength(1);
    expect(
      (await t.post("/groups/create", { subject: "x".repeat(129) })).response
        .status,
    ).toBe(400);
  });

  it("refuses a removed number", async () => {
    const t = await setup();
    await t.kept.removeInstallation(
      (await t.kept.installationByHost(HOST_UID))!.wabaId,
      PHONE_NUMBER_ID,
      new Date(),
    );
    const refused = await t.post("/groups", {});
    expect(refused.response.status).toBe(404);
    expect(refused.body).toEqual({ error: MANAGE_WORDS.notConnected });
  });
});
