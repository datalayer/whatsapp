import type { AddressInfo } from "node:net";

import { WhatsAppLogger } from "../../src/observability.js";
import { createHttpServer, type Routes } from "../../src/server.js";
import { signatureOf } from "../../src/verify.js";

/**
 * Meta's side for tests: webhook bodies shaped as the Cloud API sends them,
 * signed with a test app secret. Ids are made up; the phone numbers are in
 * a range no real person holds, and are there to prove they are dropped.
 */

export const APP_SECRET = "test-only-not-an-app-secret";
export const VERIFY_TOKEN = "test-only-verify-token";
export const WABA = "102290129340398";
export const PHONE_NUMBER_ID = "106540352242922";
export const ALICE = "US.13491208655302741918";
/** A phone number that must never be kept. */
export const ALICE_PHONE = "15550001234";
export const BUSINESS_PHONE = "15550009999";

/** The signature Meta would send for this body. */
export const sign = (body: string, secret = APP_SECRET): string =>
  signatureOf(secret, body);

/** One inbound message, as Meta's `messages` field carries it. */
export function message(
  wamid: string,
  extra: Record<string, unknown> = { text: { body: "Hello" }, type: "text" },
): Record<string, unknown> {
  return {
    from: ALICE_PHONE,
    from_user_id: ALICE,
    id: wamid,
    timestamp: "1792670400",
    type: "text",
    ...extra,
  };
}

/** A webhook body: one entry of the business account, one `messages` change. */
export function webhook(
  value: Record<string, unknown>,
  field = "messages",
): string {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            field,
            value:
              field === "messages"
                ? {
                    contacts: [
                      {
                        profile: { name: "Alice" },
                        user_id: ALICE,
                        wa_id: ALICE_PHONE,
                      },
                    ],
                    messaging_product: "whatsapp",
                    metadata: {
                      display_phone_number: BUSINESS_PHONE,
                      phone_number_id: PHONE_NUMBER_ID,
                    },
                    ...value,
                  }
                : value,
          },
        ],
        id: WABA,
      },
    ],
    object: "whatsapp_business_account",
  });
}

/** A logger that keeps its lines, for a test to read. */
export function capturingLogger(): { logger: WhatsAppLogger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: new WhatsAppLogger((line) => lines.push(line)) };
}

/** The routes served on a real socket on 127.0.0.1, and how to close it. */
export async function serve(
  routes: Routes,
  checks: Record<string, () => Promise<boolean>> = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpServer(checks, routes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${port}`,
  };
}
