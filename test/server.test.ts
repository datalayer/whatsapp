import { afterEach, describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";
import { createResources } from "../src/resources.js";
import { ENVIRONMENT } from "./support/environment.js";
import { serve } from "./support/meta.js";

describe("health and readiness", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("answers /healthz while the store is down, and /readyz only when it answers", async () => {
    let up = false;
    const served = await serve({}, { store: async () => up });
    close = served.close;
    expect((await fetch(`${served.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${served.url}/readyz`)).status).toBe(503);
    up = true;
    expect(await (await fetch(`${served.url}/readyz`)).json()).toEqual({
      checks: { store: true },
      ready: true,
    });
  });

  it("answers 404 to a route it does not serve", async () => {
    const served = await serve({});
    close = served.close;
    expect(
      (await fetch(`${served.url}/whatsapp/anything`, { method: "POST" }))
        .status,
    ).toBe(404);
  });

  it("runs in memory in development: the queue is ready", async () => {
    const resources = createResources(readConfig(ENVIRONMENT));
    try {
      expect(await resources.checks.queue?.()).toBe(true);
    } finally {
      await resources.close();
    }
  });
});
