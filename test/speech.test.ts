import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { HttpMetaPort, MetaError } from "../src/meta-port.js";
import { Metrics } from "../src/observability.js";
import {
  isRecording,
  MAX_VOICE_BYTES,
  transcribe,
  TRANSCRIPTIONS_PATH,
} from "../src/speech.js";
import { capturingLogger } from "./support/meta.js";
import { FakeClock } from "./support/worker.js";

/**
 * Voice notes' two calls (WA-18): Meta's media read and downloaded at once
 * with the business token, refused past its size; Datalayer's speech
 * service asked with the person's host token, its refusal kept in its own
 * sentence.
 */

type Call = { url: string; init?: RequestInit };

function fakeFetch(answers: Array<() => Response>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ init, url: String(url) });
      const answer = answers.shift();
      if (!answer) throw new Error("unexpected call");
      return answer();
    }) as typeof fetch,
  };
}

const portOver = (fetchImplementation: typeof fetch) =>
  new HttpMetaPort({
    clock: new FakeClock(),
    fetchImplementation,
    graphUrl: "https://graph.facebook.com/v23.0",
    metrics: new Metrics(capturingLogger().logger),
  });

describe("a voice note's download from Meta", () => {
  it("reads the media's address and downloads it at once with the business token", async () => {
    const { calls, fetch } = fakeFetch([
      () =>
        Response.json({
          file_size: 4,
          id: "m1",
          mime_type: "audio/ogg; codecs=opus",
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=m1",
        }),
      () => new Response(new Uint8Array([1, 2, 3, 4])),
    ]);
    const got = await portOver(fetch).download(
      "EAAtoken",
      "m1",
      MAX_VOICE_BYTES,
    );
    expect(got.mimeType).toBe("audio/ogg; codecs=opus");
    expect([...got.bytes]).toEqual([1, 2, 3, 4]);
    expect(calls.map((one) => one.url)).toEqual([
      "https://graph.facebook.com/v23.0/m1",
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=m1",
    ]);
    for (const one of calls)
      expect((one.init?.headers as Record<string, string>).authorization).toBe(
        "Bearer EAAtoken",
      );
  });

  it("refuses a file past the limit, said or found, and an address that is not https", async () => {
    const big = fakeFetch([
      () =>
        Response.json({
          file_size: 99,
          mime_type: "audio/ogg",
          url: "https://lookaside.fbsbx.com/x",
        }),
    ]);
    await expect(portOver(big.fetch).download("t", "m1", 10)).rejects.toThrow(
      MetaError,
    );
    expect(big.calls).toHaveLength(1);
    const unsaid = fakeFetch([
      () =>
        Response.json({
          mime_type: "audio/ogg",
          url: "https://lookaside.fbsbx.com/x",
        }),
      () => new Response(new Uint8Array(11)),
    ]);
    await expect(
      portOver(unsaid.fetch).download("t", "m1", 10),
    ).rejects.toThrow(/too large/);
    const plain = fakeFetch([
      () =>
        Response.json({ mime_type: "audio/ogg", url: "http://example.com/x" }),
    ]);
    await expect(portOver(plain.fetch).download("t", "m1", 10)).rejects.toThrow(
      MetaError,
    );
    expect(plain.calls).toHaveLength(1);
  });
});

describe("a voice note heard by Datalayer's speech service", () => {
  it("posts the recording as its type with the person's host token, and reads the words", async () => {
    const { calls, fetch } = fakeFetch([
      () =>
        Response.json({
          duration_s: 2,
          language: "en",
          text: " Hello there. ",
        }),
    ]);
    const words = await transcribe(
      fetch,
      "https://datalayer.ai/",
      "host-token",
      {
        bytes: new Uint8Array([9, 9]),
        mimeType: "audio/ogg; codecs=opus",
      },
    );
    expect(words).toBe("Hello there.");
    expect(calls[0]?.url).toBe(`https://datalayer.ai${TRANSCRIPTIONS_PATH}`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer host-token",
      "content-type": "audio/ogg; codecs=opus",
    });
  });

  it("keeps a refusal's sentence, and refuses an answer without words", async () => {
    const said =
      "A recording is heard up to 60 seconds at a time; this one is too large.";
    const refused = fakeFetch([
      () => Response.json({ detail: said }, { status: 422 }),
    ]);
    const error = await transcribe(refused.fetch, "https://datalayer.ai", "t", {
      bytes: new Uint8Array(1),
      mimeType: "audio/ogg",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostRefusedError);
    expect((error as HostRefusedError).status).toBe(422);
    expect((error as HostRefusedError).detail).toBe(said);
    const odd = fakeFetch([() => Response.json({})]);
    await expect(
      transcribe(odd.fetch, "https://datalayer.ai", "t", {
        bytes: new Uint8Array(1),
        mimeType: "audio/ogg",
      }),
    ).rejects.toThrow(/did not say what it heard/);
  });

  it("hears a voice note or an audio with its type, nothing else", () => {
    expect(isRecording({ mimeType: "audio/ogg", voice: true }, "audio")).toBe(
      true,
    );
    expect(isRecording({ mimeType: "audio/mpeg" }, "audio")).toBe(true);
    expect(isRecording({ mimeType: "image/jpeg" }, "image")).toBe(false);
    expect(isRecording({ voice: true }, "audio")).toBe(false);
    expect(isRecording(undefined, "audio")).toBe(false);
  });
});
