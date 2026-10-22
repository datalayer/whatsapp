import { pseudonym } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import {
  LOG_SALT,
  Metrics,
  scrub,
  traceAttributes,
} from "../src/observability.js";
import { normalize } from "../src/webhook.js";
import {
  ALICE,
  ALICE_PHONE,
  BUSINESS_PHONE,
  capturingLogger,
  message,
  PHONE_NUMBER_ID,
  WABA,
  webhook,
} from "./support/meta.js";

/**
 * Redacted logs: whatever a line carries — a field, an error, a nested
 * value, a whole webhook — it never shows a phone number, a BSUID in clear,
 * or what a person wrote.
 */

const BODY = "Please refund invoice 42 to my card";
const PHONES = [
  ALICE_PHONE,
  `+${ALICE_PHONE}`,
  "+32 470 12 34 56",
  "+1 (555) 000-1234",
  "0470.12.34.56",
];

describe("redacted logs", () => {
  it("never writes a phone number, a BSUID or a message body", () => {
    const { lines, logger } = capturingLogger();
    logger.info("anything", {
      from: ALICE_PHONE,
      wa_id: Number(ALICE_PHONE),
      note: `failed for ${PHONES.join(" and ")}`,
      user: ALICE,
      nested: { deeper: [{ recipient: `to ${ALICE} at +${ALICE_PHONE}` }] },
      text: BODY,
      body: BODY,
      message: BODY,
    });
    logger.warn("refused", { error: new Error(`131026 for ${ALICE_PHONE}`) });
    logger.error("failed", {
      error: new Error(`could not reach ${ALICE}: ${BODY}`),
    });
    logger.audit("identity.unlinked", {
      installation: `${WABA}:${PHONE_NUMBER_ID}`,
      reason: `asked from ${ALICE_PHONE}`,
      user: ALICE,
    });
    const written = lines.join("\n");
    for (const phone of [...PHONES, BUSINESS_PHONE])
      expect(written).not.toContain(phone);
    expect(written).not.toContain("470");
    expect(written).not.toContain(ALICE);
    expect(written).not.toContain("refund");
    expect(written).not.toContain(WABA);
    // A person's lines can still be followed: the same pseudonym each time.
    expect(written).toContain(`user:${pseudonym(ALICE, LOG_SALT)}`);
    expect(written).toContain(pseudonym(ALICE, LOG_SALT));
  });

  it("writes a whole webhook, as normalized, without a phone number or the words", () => {
    const { lines, logger } = capturingLogger();
    const normalized = normalize(
      JSON.parse(
        webhook({
          messages: [
            message("wamid.L1", { text: { body: BODY }, type: "text" }),
          ],
        }),
      ),
    );
    logger.info("debug.webhook", { normalized, raw: JSON.parse(webhook({})) });
    const written = lines.join("\n");
    expect(written).not.toContain(ALICE_PHONE);
    expect(written).not.toContain(BUSINESS_PHONE);
    expect(written).not.toContain(ALICE);
    expect(written).not.toContain("refund");
  });

  it("keeps times, small counts and words that are not numbers", () => {
    expect(
      scrub({
        at: "2026-10-22T12:00:00.000Z",
        claimed: 3,
        size: 2_048,
        status: "131056",
        event: "webhook.received",
      }),
    ).toEqual({
      at: "2026-10-22T12:00:00.000Z",
      claimed: 3,
      event: "webhook.received",
      size: 2_048,
      status: "131056",
    });
  });
});

describe("pseudonymous traces and counters", () => {
  it("names a number and a person by pseudonym only", () => {
    const attributes = traceAttributes({
      phoneNumberId: PHONE_NUMBER_ID,
      userId: ALICE,
      wabaId: WABA,
    });
    expect(attributes).toEqual({
      "datalayer.whatsapp.installation": pseudonym(
        `${WABA}:${PHONE_NUMBER_ID}`,
        LOG_SALT,
      ),
      "datalayer.whatsapp.user": pseudonym(ALICE, LOG_SALT),
    });
    expect(JSON.stringify(attributes)).not.toContain(PHONE_NUMBER_ID);
  });

  it("counts by name and labels, each count a metric line", () => {
    const { lines, logger } = capturingLogger();
    const metrics = new Metrics(logger);
    metrics.count("messages", { category: "service" });
    metrics.count("messages", { category: "service" });
    metrics.count("messages", { category: "utility" });
    metrics.count("pair_rate_limited");
    expect(metrics.total("messages", { category: "service" })).toBe(2);
    expect(metrics.total("messages", { category: "utility" })).toBe(1);
    expect(metrics.total("pair_rate_limited")).toBe(1);
    expect(metrics.total("turns")).toBe(0);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      category: "service",
      event: "metric",
      metric: "messages",
      count: 1,
    });
  });
});
