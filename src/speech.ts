import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * Voice notes in (WA-18). A voice note is downloaded from Meta at once
 * (its download address lives five minutes), sent to Datalayer's speech
 * service as the person the chat's user linked — the installation's host
 * key exchanged for their host token, so the seconds heard are metered on
 * them, under their own limits — and dropped: neither the audio nor the
 * words are logged or kept here. The transcript becomes the turn's prompt,
 * quoted back first so the person sees what was understood. The speech
 * service hears up to 60 seconds at a time and says so in its own sentence.
 */

/** Where Datalayer's speech service hears a recording. */
export const TRANSCRIPTIONS_PATH = "/api/ai-agents/v1/speech/transcriptions";

/** The largest voice note downloaded: Meta's limit for audio, 16 MB. */
export const MAX_VOICE_BYTES = 16 * 1024 * 1024;

/** A recording as Meta gave it. */
export type Recording = Readonly<{ bytes: Uint8Array; mimeType: string }>;

/** What a voice note's turn says. */
export const SPEECH_WORDS = {
  /** The transcript, quoted before the answer. */
  heard: (transcript: string) => `I heard: “${transcript}”`,
  notHeard:
    "I could not hear that voice note just now: write your question in words, or record it again.",
  nothingHeard:
    "I heard no words in that voice note: write your question, or record it again.",
} as const;

/** Whether a message is a voice note (or an audio) the worker can hear. */
export function isRecording(
  media: Readonly<{ mimeType?: string; voice?: boolean }> | undefined,
  type: string,
): boolean {
  return Boolean(
    media && (type === "audio" || media.voice === true) && !!media.mimeType,
  );
}

/**
 * Hear a recording with the person's host token: its words, trimmed. A
 * refusal of the speech service is a `HostRefusedError` with its sentence.
 */
export async function transcribe(
  fetchImplementation: typeof fetch,
  apiUrl: string,
  token: string,
  recording: Recording,
): Promise<string> {
  const response = await fetchImplementation(
    `${apiUrl.replace(/\/+$/, "")}${TRANSCRIPTIONS_PATH}`,
    {
      body: recording.bytes,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": recording.mimeType,
      },
      method: "POST",
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
    text?: unknown;
  };
  if (!response.ok)
    throw new HostRefusedError(
      response.status,
      typeof body.detail === "string" ? body.detail : "",
      "The voice note",
    );
  if (typeof body.text !== "string")
    throw new Error("The speech service did not say what it heard.");
  return body.text.trim();
}
