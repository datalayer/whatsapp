import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { WORDS } from "../../src/render.js";
import { SPEECH_WORDS } from "../../src/speech.js";
import type { MessageJob } from "../../src/webhook.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import { BUSINESS_TOKEN, harness, type Harness } from "../support/worker.js";

/**
 * Voice notes in (WA-18), on each store, with a fake Meta, a fake speech
 * service (as the person) and a fake agent: the note downloaded with the
 * business token, heard as the person on the application that answers, its
 * words quoted back and sent as the prompt; a refusal said in the speech
 * service's sentence, a note Meta no longer holds or one with no words said
 * plainly, and no turn then; nothing of the audio or the words in the logs.
 */

const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };
const OGG = "audio/ogg; codecs=opus";
const NOTE = "media-voice-1";

/** The number connected, Alice linked and told who answers, a voice note held at Meta. */
async function ready(h: Harness) {
  await h.connect();
  await h.store.recordInbound(
    { ...chat, wabaId: WABA },
    new Date(h.clock.now()),
  );
  await h.store.markDisclosed(chat);
  h.meta.media.set(NOTE, {
    bytes: new Uint8Array(4000).fill(7),
    mimeType: OGG,
  });
}

const voiceNote = (h: Harness, id = NOTE): MessageJob => {
  const { text: _text, ...job } = h.job("", {
    media: { id, mimeType: OGG, voice: true },
    type: "audio",
  });
  void _text;
  return job;
};

describe.each(storeCases())("a voice note on $name", ({ store }) => {
  it("is heard as the person on the answering application, quoted back, and asked", async () => {
    const h = harness(store());
    await ready(h);
    h.asPerson.heard = "What changed this week?";
    await h.worker.handle(voiceNote(h));
    expect(h.meta.calls.find((one) => one.method === "download")).toMatchObject(
      {
        detail: { mediaId: NOTE },
        token: BUSINESS_TOKEN,
      },
    );
    expect(h.asPerson.recordings).toEqual([
      { deploymentUid: "dep-desk", mimeType: OGG, size: 4000, userId: ALICE },
    ]);
    expect(h.meta.said()).toEqual([
      SPEECH_WORDS.heard("What changed this week?"),
      "Hello.",
    ]);
    expect(h.agent.started[0]?.prompt).toBe("What changed this week?");
    expect(h.metrics.total("voice_notes")).toBe(1);
    // Neither the words nor the media's id in the logs.
    const logs = h.lines.join("\n");
    expect(logs).not.toContain("What changed this week?");
    expect(logs).not.toContain(NOTE);
  });

  it("says the speech service's own sentence when it refuses, and starts no turn", async () => {
    const h = harness(store());
    await ready(h);
    const said =
      "A recording is heard up to 60 seconds at a time; this one is too large.";
    h.asPerson.heard = new HostRefusedError(422, said, "The voice note");
    await h.worker.handle(voiceNote(h));
    expect(h.meta.said()).toEqual([said]);
    expect(h.agent.started).toEqual([]);
  });

  it("says a note it could not download or hear plainly, and a note with no words", async () => {
    const h = harness(store());
    await ready(h);
    await h.worker.handle(voiceNote(h, "media-gone"));
    expect(h.meta.said()).toEqual([SPEECH_WORDS.notHeard]);
    h.clock.advance(60_000);
    h.asPerson.heard = new Error("socket hang up");
    await h.worker.handle(voiceNote(h));
    h.clock.advance(60_000);
    h.asPerson.heard = "";
    await h.worker.handle(voiceNote(h));
    expect(h.meta.said()).toEqual([
      SPEECH_WORDS.notHeard,
      SPEECH_WORDS.notHeard,
      SPEECH_WORDS.nothingHeard,
    ]);
    expect(h.agent.started).toEqual([]);
  });

  it("still reads an image without a caption as nothing to answer", async () => {
    const h = harness(store());
    await ready(h);
    const { text: _text, ...image } = h.job("", {
      media: { id: "media-image", mimeType: "image/jpeg" },
      type: "image",
    });
    void _text;
    await h.worker.handle(image);
    expect(h.meta.said()).toEqual([WORDS.textOnly]);
    expect(h.asPerson.recordings).toEqual([]);
  });
});
