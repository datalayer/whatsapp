import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  HttpMetaPort,
  messageBody,
  MetaError,
  PAIR_RETRY_MS,
} from "../../src/meta-port.js";
import { Metrics } from "../../src/observability.js";
import { TEMPLATES } from "../../src/window.js";
import {
  ALICE,
  capturingLogger,
  PHONE_NUMBER_ID,
  WABA,
} from "../support/meta.js";
import { FakeClock } from "../support/worker.js";

/**
 * The Graph API port on a real socket, against a stand-in that answers as
 * Meta does: the messages' bodies, the business token as a bearer, the pair
 * rate limit retried and counted, a refused token, the signup's code, the
 * account's numbers without their phone numbers, a template that exists.
 */

const TOKEN = "EAAtest-only-token";

type Seen = { method: string; path: string; auth?: string; body: string };

async function graph(
  answers: Array<{ status: number; body: unknown }>,
): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      seen.push({
        body,
        method: request.method ?? "",
        path: request.url ?? "",
        ...(request.headers.authorization
          ? { auth: request.headers.authorization }
          : {}),
      });
      const answer = answers.shift() ?? { body: {}, status: 200 };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    seen,
    url: `http://127.0.0.1:${port}/v23.0`,
  };
}

describe("the Graph API port", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const setup = async (answers: Array<{ status: number; body: unknown }>) => {
    const served = await graph(answers);
    close = served.close;
    const clock = new FakeClock();
    const metrics = new Metrics(capturingLogger().logger);
    const port = new HttpMetaPort({
      clock,
      graphUrl: served.url,
      metrics,
    });
    return { clock, metrics, port, seen: served.seen };
  };

  const rateLimited = {
    body: { error: { code: 131056, message: "pair rate limit" } },
    status: 400,
  };
  const sent = { body: { messages: [{ id: "wamid.out" }] }, status: 200 };

  it("sends a message as Meta takes it, with the business token as bearer", async () => {
    const { port, seen } = await setup([sent]);
    expect(
      await port.send(TOKEN, PHONE_NUMBER_ID, ALICE, {
        text: "Hello.",
        type: "text",
      }),
    ).toBe("wamid.out");
    expect(seen).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: JSON.stringify(
          messageBody(ALICE, { text: "Hello.", type: "text" }),
        ),
        method: "POST",
        path: `/v23.0/${PHONE_NUMBER_ID}/messages`,
      },
    ]);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      messaging_product: "whatsapp",
      to: ALICE,
      type: "text",
    });
  });

  it("waits and tries again on the pair rate limit, counted, then gives up", async () => {
    const once = await setup([rateLimited, rateLimited, sent]);
    const before = once.clock.now();
    await once.port.send(TOKEN, PHONE_NUMBER_ID, ALICE, {
      text: "Hi",
      type: "text",
    });
    expect(once.clock.now() - before).toBe(PAIR_RETRY_MS + 2 * PAIR_RETRY_MS);
    expect(once.metrics.total("pair_rate_limited")).toBe(2);
    await close?.();
    const always = await setup([rateLimited, rateLimited, rateLimited]);
    await expect(
      always.port.send(TOKEN, PHONE_NUMBER_ID, ALICE, {
        text: "Hi",
        type: "text",
      }),
    ).rejects.toMatchObject({ code: 131056, pairRateLimited: true });
  });

  it("says a refused token by its code, never the token", async () => {
    const { port } = await setup([
      { body: { error: { code: 190, message: "Invalid OAuth" } }, status: 401 },
    ]);
    const error = await port
      .send(TOKEN, PHONE_NUMBER_ID, ALICE, { text: "Hi", type: "text" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MetaError);
    expect((error as MetaError).tokenRefused).toBe(true);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("refuses a message beyond WhatsApp's limits before calling Meta", async () => {
    const { port, seen } = await setup([]);
    await expect(
      port.send(TOKEN, PHONE_NUMBER_ID, ALICE, {
        body: "x",
        buttons: [
          { id: "1", title: "a" },
          { id: "2", title: "b" },
          { id: "3", title: "c" },
          { id: "4", title: "d" },
        ],
        type: "buttons",
      }),
    ).rejects.toThrow(/beyond its limits: buttons/);
    expect(seen).toEqual([]);
  });

  it("reads numbers without their phone numbers, reads a template that exists", async () => {
    const { port, seen } = await setup([
      {
        body: { data: [{ id: PHONE_NUMBER_ID, verified_name: "Acme SRL" }] },
        status: 200,
      },
      {
        body: { error: { code: 100, error_subcode: 2388024 } },
        status: 400,
      },
      {
        body: {
          data: [{ category: "UTILITY", name: "x", status: "APPROVED" }],
        },
        status: 200,
      },
    ]);
    expect(await port.numbers(TOKEN, WABA)).toEqual([
      { id: PHONE_NUMBER_ID, verifiedName: "Acme SRL" },
    ]);
    expect(await port.createTemplate(TOKEN, WABA, TEMPLATES.delivery)).toEqual({
      category: "UTILITY",
      status: "APPROVED",
    });
    expect(seen[0]!.path).toBe(
      `/v23.0/${WABA}/phone_numbers?fields=id%2Cverified_name`,
    );
    expect(JSON.parse(seen[1]!.body)).toEqual(TEMPLATES.delivery);
    expect(seen[2]!.path).toContain("name=datalayer_turn_done");
  });

  it("finds the token's business accounts with the app's own token, newest first, ids only", async () => {
    const { port, seen } = await setup([
      {
        body: {
          data: {
            app_id: "1000000000000001",
            granular_scopes: [
              { scope: "business_management" },
              {
                scope: "whatsapp_business_management",
                target_ids: [WABA, "555", "not-an-id"],
              },
              { scope: "whatsapp_business_messaging", target_ids: ["999"] },
            ],
            is_valid: true,
          },
        },
        status: 200,
      },
      { body: { data: { granular_scopes: [] } }, status: 200 },
    ]);
    const app = { id: "1000000000000001", secret: "test-only-app-secret" };
    expect((await port.tokenOf(app, TOKEN)).accounts).toEqual([WABA, "555"]);
    expect(await port.tokenOf(app, TOKEN)).toEqual({
      accounts: [],
      appId: "",
      scopes: [],
      valid: false,
    });
    const debug = new URL(`http://x${seen[0]!.path}`);
    expect(debug.pathname).toBe("/v23.0/debug_token");
    expect(debug.searchParams.get("input_token")).toBe(TOKEN);
    // The app's token in the header, never the secret in the address.
    expect(seen[0]!.auth).toBe("Bearer 1000000000000001|test-only-app-secret");
    expect(seen[0]!.path).not.toContain("test-only-app-secret");
  });

  it("reads the app's system user token with that app's own token, and whether a number is on the Cloud API", async () => {
    const { port, seen } = await setup([
      {
        body: {
          data: {
            app_id: "2000000000000002",
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: [WABA],
              },
            ],
            is_valid: true,
            scopes: [
              "whatsapp_business_messaging",
              "whatsapp_business_management",
            ],
          },
        },
        status: 200,
      },
      {
        body: { id: PHONE_NUMBER_ID, platform_type: "CLOUD_API" },
        status: 200,
      },
      {
        body: { id: PHONE_NUMBER_ID, platform_type: "NOT_APPLICABLE" },
        status: 200,
      },
      { body: { error: { code: 190 } }, status: 400 },
    ]);
    const own = { id: "2000000000000002", secret: "own-test-only-secret" };
    expect(await port.tokenOf(own, TOKEN)).toEqual({
      accounts: [WABA],
      appId: "2000000000000002",
      scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
      valid: true,
    });
    expect(seen[0]!.auth).toBe("Bearer 2000000000000002|own-test-only-secret");
    expect(seen[0]!.path).not.toContain("own-test-only-secret");
    expect(await port.onCloudApi(TOKEN, PHONE_NUMBER_ID)).toBe(true);
    expect(new URL(`http://x${seen[1]!.path}`).searchParams.get("fields")).toBe(
      "platform_type",
    );
    expect(seen[1]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(await port.onCloudApi(TOKEN, PHONE_NUMBER_ID)).toBe(false);
    await expect(port.tokenOf(own, TOKEN)).rejects.toMatchObject({
      code: 190,
      what: "The app's token was not read",
    });
  });

  it("reads and requests the Official Business Account, and reads what it can of its conditions", async () => {
    const { port, seen } = await setup([
      {
        body: {
          id: PHONE_NUMBER_ID,
          oba_status: "NOT_STARTED",
          status_message: "No request.",
        },
        status: 200,
      },
      {
        body: { success: true, updated_status: { oba_status: "PENDING" } },
        status: 200,
      },
      { body: { id: PHONE_NUMBER_ID, name_status: "APPROVED" }, status: 200 },
      { body: { error: { code: 100 } }, status: 400 },
      { body: { error: { code: 190 } }, status: 401 },
    ]);
    expect(await port.officialStatus(TOKEN, PHONE_NUMBER_ID)).toEqual({
      message: "No request.",
      status: "NOT_STARTED",
    });
    expect(seen[0]!.path).toContain(
      `/${PHONE_NUMBER_ID}/official_business_account`,
    );
    expect(
      await port.requestOfficial(TOKEN, PHONE_NUMBER_ID, {
        country: "Belgium",
        website: "https://acme.example",
      }),
    ).toEqual({ status: "PENDING" });
    expect(seen[1]!.method).toBe("POST");
    expect(JSON.parse(seen[1]!.body)).toEqual({
      business_website_url: "https://acme.example",
      primary_country_of_operation: "Belgium",
    });
    // The account's verification unreadable: left out, not a failure.
    expect(await port.standing(TOKEN, WABA, PHONE_NUMBER_ID)).toEqual({
      nameStatus: "APPROVED",
    });
    // A refused token is still the installation's end.
    await expect(
      port.standing(TOKEN, WABA, PHONE_NUMBER_ID),
    ).rejects.toMatchObject({
      code: 190,
    });
  });

  it("creates, lists, links and deletes groups, and sends to a group as a group", async () => {
    const GROUP = "Y2FwaV9ncm91cDoxNzA1NTU1MDEzOToxMjAzNjM0MDQ2OTQyMzM4MjAZD";
    const { port, seen } = await setup([
      { body: { request_id: "request-1" }, status: 200 },
      {
        body: {
          data: {
            groups: [{ created_at: "1", id: GROUP, subject: "Launch team" }],
          },
        },
        status: 200,
      },
      {
        body: { invite_link: "https://chat.whatsapp.com/AbCd1234" },
        status: 200,
      },
      {
        body: { invite_link: "https://chat.whatsapp.com/EfGh5678" },
        status: 200,
      },
      { body: { success: true }, status: 200 },
      { body: { messages: [{ id: "wamid.group-sent" }] }, status: 200 },
    ]);
    expect(
      await port.createGroup(TOKEN, PHONE_NUMBER_ID, "Launch team"),
    ).toEqual({
      requestId: "request-1",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      messaging_product: "whatsapp",
      subject: "Launch team",
    });
    expect(await port.groups(TOKEN, PHONE_NUMBER_ID)).toEqual([
      { id: GROUP, subject: "Launch team" },
    ]);
    expect(await port.inviteLink(TOKEN, GROUP, false)).toBe(
      "https://chat.whatsapp.com/AbCd1234",
    );
    expect(seen[2]!.method).toBe("GET");
    expect(await port.inviteLink(TOKEN, GROUP, true)).toBe(
      "https://chat.whatsapp.com/EfGh5678",
    );
    expect(seen[3]!.method).toBe("POST");
    await port.deleteGroup(TOKEN, GROUP);
    expect(seen[4]!.method).toBe("DELETE");
    expect(
      await port.send(
        TOKEN,
        PHONE_NUMBER_ID,
        GROUP,
        { text: "Hi", type: "text" },
        "group",
      ),
    ).toBe("wamid.group-sent");
    expect(JSON.parse(seen[5]!.body)).toMatchObject({
      recipient_type: "group",
      to: GROUP,
    });
    await expect(
      port.send(
        TOKEN,
        PHONE_NUMBER_ID,
        GROUP,
        { body: "b", label: "Open", type: "cta", url: "https://x.example" },
        "group",
      ),
    ).rejects.toThrow(/interactive/);
    expect(messageBody(ALICE, { text: "Hi", type: "text" })).toMatchObject({
      recipient_type: "individual",
    });
  });
});
