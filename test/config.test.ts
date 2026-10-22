import { describe, expect, it } from "vitest";

import { readConfig, SETTINGS } from "../src/config.js";
import { ENVIRONMENT } from "./support/environment.js";

describe("the settings", () => {
  it("reads a complete development environment", () => {
    const config = readConfig(ENVIRONMENT);
    expect(config.DATALAYER_WHATSAPP_ROLE).toBe("all");
    expect(config.PORT).toBe(3000);
    expect(SETTINGS).toContain("DATALAYER_WHATSAPP_APP_SECRET");
  });

  it("refuses by name a missing secret and a short verify token", () => {
    const missing: Record<string, string | undefined> = { ...ENVIRONMENT };
    delete missing.DATALAYER_WHATSAPP_APP_SECRET;
    expect(() => readConfig(missing)).toThrow(
      /DATALAYER_WHATSAPP_APP_SECRET: missing/,
    );
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_VERIFY_TOKEN: "short" }),
    ).toThrow(/DATALAYER_WHATSAPP_VERIFY_TOKEN: at least 16 characters/);
  });

  it("keeps production, and every role apart, on PostgreSQL", () => {
    expect(() =>
      readConfig({ ...ENVIRONMENT, NODE_ENV: "production" }),
    ).toThrow(/production keeps its work in PostgreSQL/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_ROLE: "ingress" }),
    ).toThrow(/the ingress role shares its durable queue/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_ROLE: "gateway" }),
    ).toThrow(/DATALAYER_WHATSAPP_ROLE/);
  });
});
