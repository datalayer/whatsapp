import { describe, expect, it } from "vitest";

import { readConfig, SETTINGS } from "../src/config.js";
import { ENVIRONMENT } from "./support/environment.js";

describe("the settings", () => {
  it("reads a complete development environment", () => {
    const config = readConfig(ENVIRONMENT);
    expect(config.DATALAYER_WHATSAPP_ROLE).toBe("all");
    expect(config.PORT).toBe(3000);
    expect(SETTINGS).toContain("DATALAYER_WHATSAPP_VERIFY_SECRET");
    // Datalayer has no Meta app: no setting names one.
    for (const gone of [
      "DATALAYER_WHATSAPP_APP_ID",
      "DATALAYER_WHATSAPP_APP_SECRET",
      "DATALAYER_WHATSAPP_VERIFY_TOKEN",
    ])
      expect(SETTINGS).not.toContain(gone);
  });

  it("refuses by name a missing secret and a short verify secret", () => {
    const missing: Record<string, string | undefined> = { ...ENVIRONMENT };
    delete missing.DATALAYER_WHATSAPP_SECRET_KEY;
    expect(() => readConfig(missing)).toThrow(
      /DATALAYER_WHATSAPP_SECRET_KEY: missing/,
    );
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_VERIFY_SECRET: "short" }),
    ).toThrow(/DATALAYER_WHATSAPP_VERIFY_SECRET: at least 32 characters/);
  });

  it("keeps production, and every role apart, on Solr", () => {
    expect(() =>
      readConfig({ ...ENVIRONMENT, NODE_ENV: "production" }),
    ).toThrow(/DATALAYER_SOLR_URL: production keeps its work in Solr/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_ROLE: "ingress" }),
    ).toThrow(/the ingress role shares its durable queue in Solr/);
    expect(() =>
      readConfig({ ...ENVIRONMENT, DATALAYER_WHATSAPP_ROLE: "gateway" }),
    ).toThrow(/DATALAYER_WHATSAPP_ROLE/);
    expect(() =>
      readConfig({
        ...ENVIRONMENT,
        DATALAYER_SOLR_URL: "http://solr.example.test:8983/solr",
      }),
    ).toThrow(/DATALAYER_SOLR_PASSWORD: Solr is reached with its URL/);
    expect(() =>
      readConfig({
        ...ENVIRONMENT,
        DATALAYER_SOLR_PASSWORD: "test-only",
        DATALAYER_SOLR_URL: "http://solr.example.test:8983/",
        DATALAYER_SOLR_USERNAME: "solr",
      }),
    ).toThrow(/ending in \/solr/);
    const config = readConfig({
      ...ENVIRONMENT,
      DATALAYER_SOLR_PASSWORD: "test-only",
      DATALAYER_SOLR_URL: "http://solr.example.test:8983/solr",
      DATALAYER_SOLR_USERNAME: "solr",
      DATALAYER_WHATSAPP_ROLE: "worker",
      NODE_ENV: "production",
    });
    expect(config.DATALAYER_WHATSAPP_SOLR_COLLECTION).toBe("whatsapp");
    // PostgreSQL is gone: no setting names it.
    expect(SETTINGS).not.toContain("DATABASE_URL");
  });
});
