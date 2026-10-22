import {
  hostSessionUid,
  type HostShape,
  type HostTurnRequest,
  type Place,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import { wamidHash } from "./store.js";

/**
 * What is WhatsApp's own in a turn: the installation's external id, the
 * chat's session uid, the place Datalayer checks its rules against, the
 * delivery target and the provenance sent with the turn. The rest is the
 * shared host kit's.
 */

/** The host kind Datalayer knows WhatsApp by. */
export const HOST_KIND = "whatsapp";

/** A 1:1 chat's turn: the business number, the person (their BSUID) and their message. */
export type WhatsAppTurn = Readonly<{
  wabaId: string;
  phoneNumberId: string;
  userId: string;
  /** The person's message, as Meta named it: sent to Datalayer as its hash only. */
  wamid: string;
}>;

export type WhatsAppTurnRequest = HostTurnRequest<WhatsAppTurn>;

/** The installation's external id at Datalayer: `<waba_id>:<phone_number_id>`. */
export function externalIdOf(wabaId: string, phoneNumberId: string): string {
  return `${wabaId}:${phoneNumberId}`;
}

/**
 * The longest place id a runtime takes: a BSUID runs to 131 characters (a
 * country code, a period and up to 128), which a runtime's session API
 * admits from agent-runtimes 1.5.84 (255 characters), the version pinned.
 */
export const PLACE_ID_LIMIT = 255;

/** A 1:1 chat is a direct place, named by the person's BSUID. */
export function placeOf(turn: Pick<WhatsAppTurn, "userId">): Place {
  if (turn.userId.length > PLACE_ID_LIMIT)
    throw new Error("A BSUID longer than any place id a runtime takes.");
  return { id: turn.userId, kind: "direct" };
}

/** `whatsapp-<40 hex>` over the business account, the number and the person. */
export function sessionUidOf(
  turn: Pick<WhatsAppTurn, "wabaId" | "phoneNumberId" | "userId">,
  generation?: number,
): string {
  return hostSessionUid(
    HOST_KIND,
    [turn.wabaId, turn.phoneNumberId, turn.userId],
    generation,
  );
}

/**
 * The delivery target handed back with every delivery: the number and the
 * person, validated again when it comes back (`targetSchema`).
 */
export const targetSchema = z
  .object({
    phoneNumberId: z.string().regex(/^\d{1,32}$/),
    userId: z.string().regex(/^[\x21-\x7e]{1,255}$/),
  })
  .strict();
export type DeliveryTarget = z.infer<typeof targetSchema>;

export function targetOf(turn: WhatsAppTurn): DeliveryTarget {
  return { phoneNumberId: turn.phoneNumberId, userId: turn.userId };
}

/** The `HostShape` injected into the shared agent client. */
export const whatsappShape: HostShape<WhatsAppTurn> = {
  notBound:
    "This number is not connected to Datalayer. Its owner connects it from the application's Ship tab in Datalayer.",
  placeOf: (request) => placeOf(request.provenance),
  // On the turn itself, at most 1 KiB. Meta's message ids have been seen to
  // embed a phone number: the message is named by its id's hash.
  provenanceOf: (request) => ({
    host_kind: HOST_KIND,
    message_id: wamidHash(request.provenance.wamid),
    place: placeOf(request.provenance),
    thread: sessionUidOf(request.provenance, request.sessionGeneration),
  }),
  sessionUidOf: (request) =>
    sessionUidOf(request.provenance, request.sessionGeneration),
  targetOf: (request) => targetOf(request.provenance),
};
