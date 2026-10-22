import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DatalayerHostClient } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import { runWord, SAY, type CommandContext } from "../../src/commands.js";
import { MemoryStore } from "../../src/store.js";
import { Metrics } from "../../src/observability.js";
import { WindowKeeper } from "../../src/window.js";
import {
  ALICE,
  ALICE_PHONE,
  capturingLogger,
  PHONE_NUMBER_ID,
  WABA,
} from "../support/meta.js";

/**
 * `link` and `unlink` through the shared host client against ai-agents'
 * routes on a real socket (a stand-in that answers as ai-agents does): the
 * one-use code asked for the BSUID with the installation's key, the button
 * to Datalayer's confirmation page, a refusal said, and the link ended.
 */

const HOST_KEY = "dlhk_test-only-host-key";

type Seen = Readonly<{
  method: string;
  path: string;
  hostKey?: string;
  body: string;
}>;

/** ai-agents' link routes: one-use codes, links by BSUID, refusals on demand. */
async function aiAgents(): Promise<{
  url: string;
  seen: Seen[];
  links: Set<string>;
  refuse: { status: number; detail: string } | undefined;
  close(): Promise<void>;
}> {
  const state = {
    links: new Set<string>(),
    refuse: undefined as { status: number; detail: string } | undefined,
    seen: [] as Seen[],
  };
  let codes = 0;
  const read = async (request: IncomingMessage): Promise<string> => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    return body;
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await read(request);
      const path = request.url ?? "";
      const hostKey = request.headers["x-datalayer-host-key"];
      state.seen.push({
        body,
        method: request.method ?? "",
        path,
        ...(typeof hostKey === "string" ? { hostKey } : {}),
      });
      const answer = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (hostKey !== HOST_KEY) return answer(401, { detail: "unknown host" });
      if (state.refuse)
        return answer(state.refuse.status, { detail: state.refuse.detail });
      const prefix = "/api/ai-agents/v1/apps/hosts/self";
      if (request.method === "POST" && path === `${prefix}/link-codes`) {
        codes += 1;
        // The contract's keys (contracts.json `link_code`).
        return answer(200, {
          code: `dlhc_one-use-${codes}`,
          confirm: "POST /api/ai-agents/v1/apps/hosts/links",
          expires_in: 600,
          success: true,
        });
      }
      if (request.method === "DELETE" && path.startsWith(`${prefix}/links/`)) {
        const user = decodeURIComponent(path.slice(`${prefix}/links/`.length));
        return answer(200, {
          revoked: state.links.delete(user) ? 1 : 0,
          success: true,
        });
      }
      answer(404, { detail: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${port}`,
  });
}

describe("link and unlink against ai-agents' routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const setup = async (
    standing: CommandContext["standing"],
    hostKey = HOST_KEY,
  ) => {
    const server = await aiAgents();
    close = server.close;
    const { lines, logger } = capturingLogger();
    const store = new MemoryStore();
    const chat = {
      phoneNumberId: PHONE_NUMBER_ID,
      userId: ALICE,
      wabaId: WABA,
    };
    await store.recordInbound(chat, new Date("2026-10-22T12:00:00Z"));
    const context: CommandContext = {
      business: "Datalayer SRL",
      chat,
      hostKey,
      profileName: "Alice",
      standing,
      support: "support@example.com",
    };
    const dependencies = {
      hosts: new DatalayerHostClient(server.url),
      logger,
      store,
      webUrl: "https://datalayer.example",
      window: new WindowKeeper(
        store,
        { now: () => Date.now() },
        new Metrics(logger),
      ),
    };
    return {
      lines,
      run: (word: "link" | "unlink") => runWord(word, context, dependencies),
      server,
    };
  };

  it("asks a one-use code for the BSUID, never a phone number, and answers a button to Datalayer", async () => {
    const { run, server } = await setup("private");
    expect(await run("link")).toEqual([
      {
        kind: "button",
        label: "Link",
        text: "Link your Datalayer account: sign in to Datalayer, check what it shows and confirm. The link works once, for 10 minutes.",
        url: "https://datalayer.example/hosts/link?code=dlhc_one-use-1",
      },
    ]);
    expect(server.seen).toEqual([
      {
        body: JSON.stringify({
          external_user_id: ALICE,
          external_user_name: "Alice",
        }),
        hostKey: HOST_KEY,
        method: "POST",
        path: "/api/ai-agents/v1/apps/hosts/self/link-codes",
      },
    ]);
    expect(JSON.stringify(server.seen)).not.toContain(ALICE_PHONE);
    // A second `link` is a new code: each is spent once, at Datalayer.
    const [again] = await run("link");
    expect(again?.kind === "button" && again.url).toContain("dlhc_one-use-2");
  });

  it("says a refusal, and logs it without the host key or the person", async () => {
    const { lines, run, server } = await setup("visitor");
    server.refuse = { detail: "The installation is paused.", status: 409 };
    expect(await run("link")).toEqual([
      { kind: "text", text: SAY.linkUnavailable },
    ]);
    const logged = lines.join("\n");
    expect(logged).toContain("link.code_refused");
    expect(logged).not.toContain(HOST_KEY);
    expect(logged).not.toContain(ALICE);
  });

  it("fails loudly when ai-agents does not know the installation's key", async () => {
    const { run, server } = await setup(
      "private",
      "dlhk_not-this-installation",
    );
    await expect(run("link")).rejects.toThrow(/did not answer a link code/);
    expect(server.seen).toHaveLength(1);
  });

  it("ends the link by the BSUID, encoded in the path", async () => {
    const { run, server } = await setup("linked");
    server.links.add(ALICE);
    expect(await run("unlink")).toEqual([{ kind: "text", text: SAY.unlinked }]);
    expect(server.seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `DELETE /api/ai-agents/v1/apps/hosts/self/links/${encodeURIComponent(ALICE)}`,
    ]);
    expect(await run("unlink")).toEqual([
      { kind: "text", text: SAY.notLinkedHere },
    ]);
  });
});
