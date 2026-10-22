import { describe, expect, it } from "vitest";

import { normalize, withoutPhoneNumbers } from "../src/webhook.js";
import {
  ALICE,
  ALICE_PHONE,
  message,
  PHONE_NUMBER_ID,
  WABA,
  webhook,
} from "./support/meta.js";

/** What a webhook's body becomes before anything is kept. */
describe("normalize", () => {
  const one = (extra: Record<string, unknown>, value = {}) =>
    normalize(
      JSON.parse(
        webhook({ messages: [message("wamid.N1", extra)], ...value }),
      ) as unknown,
    );

  it("reads a pressed button, a picked row and a quick reply as the reply", () => {
    expect(
      one({
        interactive: {
          button_reply: { id: "approve:ap-1", title: "Approve" },
          type: "button_reply",
        },
        type: "interactive",
      }).jobs[0]?.job,
    ).toMatchObject({
      reply: { id: "approve:ap-1", title: "Approve" },
      type: "interactive",
    });
    expect(
      one({
        interactive: {
          list_reply: { description: "", id: "app:desk", title: "Desk" },
          type: "list_reply",
        },
        type: "interactive",
      }).jobs[0]?.job,
    ).toMatchObject({ reply: { id: "app:desk", title: "Desk" } });
    expect(
      one({ button: { payload: "show", text: "Show me" }, type: "button" })
        .jobs[0]?.job,
    ).toMatchObject({
      reply: { id: "show", title: "Show me" },
      text: "Show me",
    });
  });

  it("keeps a voice note's media id and its voice flag, not the audio", () => {
    expect(
      one({
        audio: {
          id: "1013859600285441",
          mime_type: "audio/ogg; codecs=opus",
          sha256: "abc",
          voice: true,
        },
        type: "audio",
      }).jobs[0]?.job,
    ).toMatchObject({
      media: {
        id: "1013859600285441",
        mimeType: "audio/ogg; codecs=opus",
        voice: true,
      },
      type: "audio",
    });
  });

  it("keeps a reply's context and a reaction by wamid", () => {
    expect(
      one({ context: { from: "15550009999", id: "wamid.OUT1" } }).jobs[0]?.job,
    ).toMatchObject({ replyTo: "wamid.OUT1" });
    expect(
      one({
        reaction: { emoji: "👍", message_id: "wamid.OUT2" },
        type: "reaction",
      }).jobs[0]?.job,
    ).toMatchObject({ reaction: { emoji: "👍", wamid: "wamid.OUT2" } });
  });

  it("keeps a system message's type and the new BSUID, never its body or numbers", () => {
    const { job } = one({
      system: {
        body: `User A changed from ${ALICE_PHONE} to 15550004321`,
        new_wa_id: "15550004321",
        type: "user_changed_number",
        user_id: "US.99999999999999999999",
      },
      type: "system",
    }).jobs[0] ?? { job: undefined };
    expect(job).toMatchObject({
      system: {
        newUserId: "US.99999999999999999999",
        type: "user_changed_number",
      },
    });
    expect(JSON.stringify(job)).not.toContain("15550004321");
    expect(JSON.stringify(job)).not.toContain(ALICE_PHONE);
  });

  it("takes the BSUID from the sender's contact when the message has none, and sets aside a message with neither", () => {
    const withoutOwn = { ...message("wamid.N2"), from_user_id: undefined };
    const fromContact = normalize(
      JSON.parse(webhook({ messages: [withoutOwn] })) as unknown,
    );
    expect(fromContact.jobs[0]?.job).toMatchObject({
      phoneNumberId: PHONE_NUMBER_ID,
      userId: ALICE,
      wabaId: WABA,
    });
    const nobody = normalize(
      JSON.parse(
        webhook({ contacts: [{ wa_id: ALICE_PHONE }], messages: [withoutOwn] }),
      ) as unknown,
    );
    expect(nobody.jobs).toEqual([]);
    expect(nobody.ignored).toEqual(["message_without_user_id"]);
  });

  it("sets aside a status it does not know, and a field it does not subscribe to", () => {
    const value = normalize(
      JSON.parse(
        webhook({
          statuses: [{ id: "wamid.X", status: "warning", timestamp: "1" }],
        }),
      ) as unknown,
    );
    expect(value.statuses).toEqual([]);
    expect(value.ignored).toEqual(["status:warning"]);
    expect(
      normalize(JSON.parse(webhook({}, "flows")) as unknown).ignored,
    ).toEqual(["field:flows"]);
  });

  it("refuses what is not a business account's webhook", () => {
    expect(() => normalize({ entry: [], object: "page" })).toThrow();
    expect(() =>
      normalize({
        entry: [{ changes: [{ field: "messages", value: {} }], id: WABA }],
        object: "whatsapp_business_account",
      }),
    ).toThrow();
  });

  it("drops every phone number field, however deep", () => {
    expect(
      withoutPhoneNumbers({
        display_phone_number: "1",
        nested: [{ keep: true, wa_id: "2" }],
        phone_number: "3",
      }),
    ).toEqual({ nested: [{ keep: true }] });
  });
});
