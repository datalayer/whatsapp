import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Meta's signed webhooks: the raw body kept as it arrived, and
 * `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of that raw body with
 * the app's secret, compared in constant time. Meta's signature carries no
 * timestamp: a replayed request is answered by the claims, not here.
 */

/** The most a webhook carries: Meta sends JSON up to 3 MB. */
export const BODY_LIMIT = 3 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("The request is too large.");
  }
}

/**
 * The request's raw body, refused past `limit`: what is past it is not kept,
 * and the request is paused there, so that the caller answers 413 and lets
 * the rest drain (`request.resume()`) without closing the socket under its
 * own answer.
 */
export function rawBodyOf(
  request: IncomingMessage,
  limit = BODY_LIMIT,
): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    return Promise.reject(new BodyTooLargeError());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      request.off("data", onData);
      request.off("end", onEnd);
      request.pause();
      reject(new BodyTooLargeError());
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", reject);
  });
}

/** `sha256=` and the hex HMAC-SHA256 of the raw body: Meta's signature. */
export function signatureOf(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Whether the request's `X-Hub-Signature-256` is the raw body's, with this secret. */
export function signedByMeta(
  request: IncomingMessage,
  rawBody: Buffer,
  secret: string,
): boolean {
  const header = request.headers["x-hub-signature-256"];
  const given = Array.isArray(header) ? header[0] : header;
  if (!given || !/^sha256=[0-9a-f]{64}$/i.test(given)) return false;
  const expected = Buffer.from(signatureOf(secret, rawBody));
  const received = Buffer.from(given.toLowerCase());
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** Whether two strings are equal, in time that does not tell where they differ. */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHmac("sha256", "compare").update(given).digest();
  const b = createHmac("sha256", "compare").update(expected).digest();
  return timingSafeEqual(a, b);
}
