import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  externalIdOf,
  placeOf,
  targetOf,
  targetSchema,
  whatsappShape,
} from "../src/domain.js";
import { wamidHash } from "../src/store.js";

/**
 * The service's shapes against WhatsApp's forms of the host contracts, as
 * agent-runtimes ships them (`contracts.json`, byte-identical to
 * ai-agents' fixture): the installation's external id, the person as a
 * direct place (the longest BSUID, 131 characters, included), a group as a
 * channel, the provenance and the delivery target.
 */

const WHATSAPP = (
  JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve(
        "@datalayer/agent-runtimes/lib/portable/hosts/contracts.json",
      ),
      "utf8",
    ),
  ) as {
    whatsapp: {
      waba_id: string;
      phone_number_id: string;
      bind_request: { external_id: string };
      external_user_id: string;
      external_user_id_longest: string;
      direct: { place: { kind: string; id: string } };
      group: { id: string; place: { kind: string; id: string } };
      provenance: {
        host_kind: string;
        place: { kind: string; id: string };
        message_id: string;
      };
      target: { phoneNumberId: string; userId: string };
    };
  }
).whatsapp;

const turn = {
  phoneNumberId: WHATSAPP.phone_number_id,
  userId: WHATSAPP.external_user_id,
  wabaId: WHATSAPP.waba_id,
  wamid: WHATSAPP.provenance.message_id,
};

describe("WhatsApp's forms of the host contracts", () => {
  it("binds the installation as <waba_id>:<phone_number_id>", () => {
    expect(externalIdOf(WHATSAPP.waba_id, WHATSAPP.phone_number_id)).toBe(
      WHATSAPP.bind_request.external_id,
    );
  });

  it("names a group a channel", () => {
    expect(
      placeOf({ groupId: WHATSAPP.group.id, userId: turn.userId }),
    ).toEqual(WHATSAPP.group.place);
  });

  it("names a chat as a direct place by the BSUID, the longest one too", () => {
    expect(placeOf(turn)).toEqual(WHATSAPP.direct.place);
    expect(WHATSAPP.external_user_id_longest).toHaveLength(131);
    expect(placeOf({ userId: WHATSAPP.external_user_id_longest })).toEqual({
      id: WHATSAPP.external_user_id_longest,
      kind: "direct",
    });
  });

  it("sends the contract's provenance, the message named by its id's hash", () => {
    const request = {
      applicationId: "dep",
      externalEventId: "e",
      externalUserId: turn.userId,
      principalId: "p",
      prompt: "q",
      provenance: turn,
    };
    const provenance = whatsappShape.provenanceOf?.(request);
    expect(provenance).toMatchObject({
      host_kind: WHATSAPP.provenance.host_kind,
      place: WHATSAPP.provenance.place,
    });
    // The contract's keys, no thread: a chat's place names it.
    expect(Object.keys(provenance ?? {}).sort()).toEqual(
      Object.keys(WHATSAPP.provenance).sort(),
    );
    // Meta's message ids may embed a phone number: never sent as they are.
    expect(provenance?.message_id).toBe(
      wamidHash(WHATSAPP.provenance.message_id),
    );
    const longest = whatsappShape.provenanceOf?.({
      ...request,
      provenance: { ...turn, userId: WHATSAPP.external_user_id_longest },
    });
    expect(Buffer.byteLength(JSON.stringify(longest))).toBeLessThanOrEqual(
      1024,
    );
  });

  it("hands back the contract's delivery target, and takes it again", () => {
    expect(targetOf(turn)).toEqual(WHATSAPP.target);
    expect(targetSchema.parse(WHATSAPP.target)).toEqual(WHATSAPP.target);
    expect(
      targetSchema.safeParse({
        ...WHATSAPP.target,
        userId: WHATSAPP.external_user_id_longest,
      }).success,
    ).toBe(true);
  });
});
