import type { HostDelivery } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { describe, expect, it } from "vitest";

import { sessionUidOf } from "../../src/domain.js";
import { GROUP_WORDS, names, promptOf } from "../../src/groups.js";
import { checkLimits } from "../../src/meta-port.js";
import { WORDS } from "../../src/render.js";
import { wamidHash, type Group } from "../../src/store.js";
import {
  normalize,
  type GroupJob,
  type MessageJob,
} from "../../src/webhook.js";
import {
  ALICE,
  ALICE_PHONE,
  BUSINESS_PHONE,
  PHONE_NUMBER_ID,
  WABA,
} from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import { APP_ID, harness, type Harness } from "../support/worker.js";

/**
 * Groups (WA-22), on each store, with a fake Meta, a fake Datalayer and a
 * fake agent: a group the card created answers when the application is
 * named or the number mentioned, as the person who asked, in one session per
 * group; says nothing when it is not addressed, when its rule is off or the
 * application is kept to direct conversations; tells an unlinked person once
 * a day to link; never sends an interactive message to a group, so buttons,
 * links to Datalayer, questions and approvals go to the person's own chat
 * with a pointer in the group. Meta's group events and the group messages
 * are read at the ingress without any phone number.
 */

const GROUP = "Y2FwaV9ncm91cDoxNzA1NTU1MDEzOToxMjAzNjM0MDQ2OTQyMzM4MjAZD";
const BOB = "US.20000000000000000002";

function aGroup(overrides: Partial<Group> = {}): Group {
  return {
    createdAt: new Date(Date.UTC(2026, 9, 22)),
    groupId: GROUP,
    phoneNumberId: PHONE_NUMBER_ID,
    ref: "ref-0000000001",
    state: "active",
    subject: "Launch team",
    wabaId: WABA,
    ...overrides,
  };
}

/** The number connected, Alice linked, the group made from the card. */
async function ready(h: Harness, group: Partial<Group> = {}) {
  const kept = await h.connect();
  await h.store.saveGroup(aGroup(group));
  return kept;
}

const inGroup = (
  h: Harness,
  text: string,
  overrides: Partial<MessageJob> = {},
): MessageJob => h.job(text, { groupId: GROUP, ...overrides });

const groupSaid = (h: Harness) =>
  h.meta
    .sentTo("group")
    .map((one) => (one.type === "text" ? one.text : one.type));
const personalSaid = (h: Harness) => h.meta.sentTo("individual");

describe("group words", () => {
  it("names the application as a word of its own, in any case, and keeps phone numbers out of the question", () => {
    expect(names("help desk, what changed?", "Help Desk")).toBe(true);
    expect(names("@Help Desk what changed?", "Help Desk")).toBe(true);
    expect(names("the helpdesking tool", "Help Desk")).toBe(false);
    expect(names("Helpdesker", "Helpdesk")).toBe(false);
    expect(promptOf("@15550009999 what did @+15550001234 send?")).toBe(
      "@someone what did @someone send?",
    );
  });

  it("refuses an interactive message to a group", () => {
    expect(() =>
      checkLimits(
        { body: "Choose", buttons: [{ id: "a", title: "A" }], type: "buttons" },
        "group",
      ),
    ).toThrow(/interactive/);
    expect(() =>
      checkLimits({ text: "Hello", type: "text" }, "group"),
    ).not.toThrow();
  });
});

describe("the ingress, for groups", () => {
  const body = (value: Record<string, unknown>, field = "messages") => ({
    entry: [{ changes: [{ field, value }], id: WABA }],
    object: "whatsapp_business_account",
  });

  it("reads a group message with its group and the mention, never a phone number", () => {
    const normalized = normalize(
      body({
        contacts: [
          { profile: { name: "Alice" }, user_id: ALICE, wa_id: ALICE_PHONE },
        ],
        messages: [
          {
            from: ALICE_PHONE,
            from_user_id: ALICE,
            group_id: GROUP,
            id: "wamid.group-1",
            text: { body: `@${BUSINESS_PHONE} what changed?` },
            timestamp: "1792670400",
            type: "text",
          },
        ],
        metadata: {
          display_phone_number: BUSINESS_PHONE,
          phone_number_id: PHONE_NUMBER_ID,
        },
      }),
      APP_ID,
    );
    const [one] = normalized.jobs;
    expect(one?.job).toMatchObject({
      groupId: GROUP,
      mentioned: true,
      userId: ALICE,
    });
    expect(JSON.stringify(one?.job)).not.toContain(`"${ALICE_PHONE}"`);
    expect(JSON.stringify(one?.job)).not.toContain('15550001234"');
  });

  it("reads Meta's group events without the participants or the invite link", () => {
    const normalized = normalize(
      body(
        {
          groups: [
            {
              group_id: GROUP,
              invite_link: "https://chat.whatsapp.com/SecretLink",
              join_approval_mode: "auto_approve",
              request_id: "request-1",
              subject: "Launch team",
              timestamp: "1792670400",
              type: "group_create",
            },
          ],
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: BUSINESS_PHONE,
            phone_number_id: PHONE_NUMBER_ID,
          },
        },
        "group_lifecycle_update",
      ),
      APP_ID,
    );
    const job = normalized.jobs[0]?.job as GroupJob;
    expect(job).toEqual({
      events: [
        {
          failed: false,
          groupId: GROUP,
          requestId: "request-1",
          subject: "Launch team",
          type: "group_create",
        },
      ],
      field: "group_lifecycle_update",
      kind: "group",
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA,
    });
    const joined = normalize(
      body(
        {
          groups: [
            {
              added_participants: [{ wa_id: ALICE_PHONE }],
              group_id: GROUP,
              reason: "invite_link",
              timestamp: "1792670400",
              type: "group_participants_add",
            },
          ],
          metadata: { phone_number_id: PHONE_NUMBER_ID },
        },
        "group_participants_update",
      ),
      APP_ID,
    );
    expect(JSON.stringify(joined.jobs)).not.toContain(ALICE_PHONE);
    expect((joined.jobs[0]?.job as GroupJob).events[0]?.participants).toBe(1);
  });
});

describe.each(storeCases())("groups on $name", ({ store }) => {
  it("keeps a group, gives it its id, and forgets it with its conversation", async () => {
    const kept = store();
    await kept.saveGroup(
      aGroup({ groupId: undefined, requestId: "request-1", state: "creating" }),
    );
    expect(await kept.group(PHONE_NUMBER_ID, GROUP)).toBeUndefined();
    expect(
      await kept.updateGroup(PHONE_NUMBER_ID, "ref-0000000001", {
        groupId: GROUP,
        state: "active",
      }),
    ).toBe(true);
    expect(await kept.group(PHONE_NUMBER_ID, GROUP)).toMatchObject({
      requestId: "request-1",
      state: "active",
      subject: "Launch team",
    });
    await kept.recordInbound(
      { phoneNumberId: PHONE_NUMBER_ID, userId: GROUP, wabaId: WABA },
      new Date(),
    );
    expect(await kept.deleteGroup(PHONE_NUMBER_ID, "ref-0000000001")).toBe(
      true,
    );
    expect(await kept.groups(PHONE_NUMBER_ID)).toEqual([]);
    expect(
      await kept.chat({ phoneNumberId: PHONE_NUMBER_ID, userId: GROUP }),
    ).toBeUndefined();
    expect(await kept.deleteGroup(PHONE_NUMBER_ID, "ref-0000000001")).toBe(
      false,
    );
  });

  it("answers in the group when named, as the person who asked, in the group's one session", async () => {
    const h = harness(store());
    await ready(h);
    const first = inGroup(h, "Help Desk, what changed this week?");
    await h.worker.handle(first);
    expect(groupSaid(h)).toEqual([
      GROUP_WORDS.disclosure("Help Desk", "Acme SRL", "support@acme.example"),
      "Hello.",
    ]);
    expect(personalSaid(h)).toEqual([]);
    const [request] = h.agent.started;
    expect(request).toMatchObject({
      applicationId: "dep-desk",
      externalUserId: ALICE,
      principalId: `principal-${ALICE}`,
      prompt: "Help Desk, what changed this week?",
    });
    const session = sessionUidOf(
      {
        groupId: GROUP,
        phoneNumberId: PHONE_NUMBER_ID,
        userId: ALICE,
        wabaId: WABA,
      },
      0,
    );
    expect(h.agent.provenances[0]).toEqual({
      host_kind: "whatsapp",
      message_id: wamidHash(first.wamid),
      place: { id: GROUP, kind: "channel" },
      thread: session,
    });
    // The group's 1:1 window is not Alice's: her own chat was not opened.
    expect(
      await h.store.chat({ phoneNumberId: PHONE_NUMBER_ID, userId: ALICE }),
    ).toBeUndefined();

    // Bob, linked too, continues the group's session as himself.
    h.hosts.links.add(BOB);
    await h.worker.handle(
      inGroup(h, "@15550009999 and last week?", {
        mentioned: true,
        userId: BOB,
      }),
    );
    expect(h.agent.started[1]).toMatchObject({
      externalUserId: BOB,
      principalId: `principal-${BOB}`,
      prompt: "@someone and last week?",
      sessionId: session,
    });
    expect(groupSaid(h)).toHaveLength(3);
  });

  it("says nothing when not addressed, in a group it did not make, or a suspended one", async () => {
    const h = harness(store());
    await ready(h);
    await h.worker.handle(inGroup(h, "Lunch at noon?"));
    await h.worker.handle(
      inGroup(h, "Help Desk?", { groupId: "Y2FwaV9ncm91cDpvdGhlcg" }),
    );
    await h.store.updateGroup(PHONE_NUMBER_ID, "ref-0000000001", {
      state: "suspended",
    });
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    expect(h.meta.sentTo("group")).toEqual([]);
    expect(h.agent.started).toEqual([]);
  });

  it("answers a reply to one of its own messages", async () => {
    const h = harness(store());
    await ready(h);
    await h.store.applyStatus({
      at: new Date(),
      phoneNumberId: PHONE_NUMBER_ID,
      status: "sent",
      wamid: "wamid.sent-earlier",
    });
    await h.worker.handle(
      inGroup(h, "and then?", { replyTo: "wamid.sent-earlier" }),
    );
    expect(h.agent.started).toHaveLength(1);
  });

  it("says nothing when the group is off, the application kept to direct chats, or the number paused", async () => {
    const h = harness(store());
    await ready(h);
    h.hosts.self_ = {
      ...h.hosts.self_,
      channels: [{ deployment: "", id: GROUP, state: "deny" }],
    };
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    h.hosts.self_ = {
      ...h.hosts.self_,
      channels: [],
      directOnly: ["dep-desk"],
    };
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    h.hosts.self_ = { ...h.hosts.self_, directOnly: [], paused: true };
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    expect(h.meta.sentTo("group")).toEqual([]);
    expect(h.agent.started).toEqual([]);
    // On again: answered.
    h.hosts.self_ = {
      ...h.hosts.self_,
      channels: [{ deployment: "", id: GROUP, state: "allow" }],
      paused: false,
    };
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    expect(h.agent.started).toHaveLength(1);
  });

  it("answers as the group's own application when its rule names one", async () => {
    const h = harness(store());
    await ready(h);
    h.hosts.self_ = {
      ...h.hosts.self_,
      channels: [{ deployment: "dep-billing", id: GROUP, state: "allow" }],
    };
    await h.worker.handle(inGroup(h, "Billing, the last invoice?"));
    expect(h.agent.started[0]?.applicationId).toBe("dep-billing");
  });

  it("tells an unlinked person once a day, in the group, to link first", async () => {
    const h = harness(store());
    await ready(h);
    h.hosts.links.delete(ALICE);
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    await h.worker.handle(inGroup(h, "Help Desk, hello again"));
    expect(groupSaid(h)).toEqual([
      GROUP_WORDS.linkFirst("Help Desk", "Acme SRL"),
    ]);
    h.clock.advance(25 * 60 * 60 * 1000);
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    expect(groupSaid(h)).toHaveLength(2);
    expect(h.agent.started).toEqual([]);
  });

  it("sends what only a 1:1 chat takes to the person's own chat, with a pointer in the group", async () => {
    const h = harness(store());
    await ready(h);
    // Alice wrote to the number herself: her own chat's window is open.
    await h.store.recordInbound(
      { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
      new Date(h.clock.now()),
    );
    h.agent.script = [
      { kind: "text", text: "a".repeat(20_000) },
      { kind: "completion" },
    ];
    await h.worker.handle(inGroup(h, "Help Desk, the whole report?"));
    const group = h.meta.sentTo("group");
    expect(group.some((one) => one.type === "document")).toBe(true);
    expect(group.at(-1)).toEqual({
      text: GROUP_WORDS.inYourChat("Alice, ", "Acme SRL"),
      type: "text",
    });
    expect(
      group.every((one) => !["buttons", "list", "cta"].includes(one.type)),
    ).toBe(true);
    expect(personalSaid(h).map((one) => one.type)).toEqual(["cta"]);
    expect(
      h.meta.calls.find((one) => one.message?.type === "cta")?.userId,
    ).toBe(ALICE);
  });

  it("keeps an answer holding a credential out of the group, and says where it is", async () => {
    const h = harness(store());
    await ready(h);
    h.agent.script = [
      {
        kind: "text",
        text: "Use Bearer abcdefghijklmnopqrstuvwxyz to call it.",
      },
      { kind: "completion" },
    ];
    await h.worker.handle(inGroup(h, "Help Desk, the key?"));
    // Her own chat is closed: told to write there first.
    expect(groupSaid(h)).toEqual([
      GROUP_WORDS.disclosure("Help Desk", "Acme SRL", "support@acme.example"),
      GROUP_WORDS.writeFirst("Alice, ", "Acme SRL"),
    ]);
    expect(personalSaid(h)).toEqual([]);
    expect(JSON.stringify(h.meta.calls)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("asks a question with buttons in the person's own chat, and a press answers in the group", async () => {
    const h = harness(store());
    await ready(h);
    await h.store.recordInbound(
      { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
      new Date(h.clock.now()),
    );
    h.agent.script = [
      { kind: "text", text: "Which one?" },
      {
        kind: "ask",
        question: {
          kind: "choice",
          options: ["Option A", "Option B"],
          prompt: "Which one?",
        },
      },
      { kind: "completion" },
    ] as never;
    await h.worker.handle(inGroup(h, "Help Desk, plan the launch"));
    expect(personalSaid(h).map((one) => one.type)).toEqual(["buttons"]);
    const own = await h.store.chat({
      phoneNumberId: PHONE_NUMBER_ID,
      userId: ALICE,
    });
    expect(own?.asking).toMatchObject({
      groupId: GROUP,
      options: ["Option A", "Option B"],
    });
    h.agent.script = [
      { kind: "text", text: "B it is." },
      { kind: "completion" },
    ];
    const before = groupSaid(h).length;
    await h.worker.handle(
      h.job(undefined, {
        reply: { id: "ask:1", title: "Option B" },
        text: undefined,
        type: "interactive",
      }),
    );
    expect(h.agent.started[1]?.prompt).toBe("Option B");
    expect(h.agent.started[1]?.provenance.groupId).toBe(GROUP);
    expect(groupSaid(h).slice(before)).toEqual(["B it is."]);
  });

  it("shows a group turn's answer from its delivery in the group, and an approval in the person's chat with a pointer", async () => {
    const h = harness(store());
    const kept = await ready(h);
    const session = sessionUidOf(
      {
        groupId: GROUP,
        phoneNumberId: PHONE_NUMBER_ID,
        userId: ALICE,
        wabaId: WABA,
      },
      0,
    );
    const chat = {
      phoneNumberId: PHONE_NUMBER_ID,
      userId: GROUP,
      wabaId: WABA,
    };
    await h.store.recordInbound(chat, new Date(h.clock.now()));
    await h.store.setSession(chat, {
      deploymentUid: "dep-desk",
      sessionUid: session,
      unshown: true,
    });
    h.asPerson.answers.set(session, "Done, late.");
    const target = {
      groupId: GROUP,
      phoneNumberId: PHONE_NUMBER_ID,
      userId: ALICE,
    };
    const completed: HostDelivery = {
      delivery: "dl-1",
      event: "turn.completed",
      payload: {
        deployment_uid: "dep-desk",
        record_entry: "entry-1",
        session_uid: session,
        target,
      },
    };
    await h.worker.deliveries.handle(kept, completed);
    await h.worker.deliveries.handle(kept, completed);
    expect(groupSaid(h)).toEqual(["Done, late."]);

    await h.store.recordInbound(
      { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
      new Date(h.clock.now()),
    );
    const { mailPresentation } = await import("../support/worker.js");
    h.asPerson.approvals.set("ap-1", {
      owner: ALICE,
      presentation: mailPresentation(),
    });
    const requested = {
      delivery: "dl-2",
      event: "approval.requested",
      payload: {
        approval_id: "ap-1",
        deployment_uid: "dep-desk",
        presentation: "v1",
        session_uid: session,
        target,
        tool_name: "send_email",
      },
    } as HostDelivery;
    await h.worker.deliveries.handle(kept, requested);
    await h.worker.deliveries.handle(kept, requested);
    expect(groupSaid(h).slice(1)).toEqual([
      GROUP_WORDS.approval("", "Acme SRL"),
    ]);
    expect(personalSaid(h).map((one) => one.type)).toContain("buttons");
  });

  it("follows Meta's group events: created by its request, suspended, cleared, deleted", async () => {
    const h = harness(store());
    await h.connect();
    await h.store.saveGroup(
      aGroup({ groupId: undefined, requestId: "request-7", state: "creating" }),
    );
    const event = (
      events: GroupJob["events"],
      field = "group_lifecycle_update",
    ): GroupJob => ({
      events,
      field,
      kind: "group",
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA,
    });
    await h.worker.handle(
      event([
        {
          failed: false,
          groupId: GROUP,
          requestId: "request-7",
          type: "group_create",
        },
      ]),
    );
    expect((await h.store.group(PHONE_NUMBER_ID, GROUP))?.state).toBe("active");
    await h.worker.handle(
      event(
        [{ failed: false, groupId: GROUP, type: "group_suspend" }],
        "group_status_update",
      ),
    );
    expect((await h.store.group(PHONE_NUMBER_ID, GROUP))?.state).toBe(
      "suspended",
    );
    await h.worker.handle(
      event(
        [{ failed: false, groupId: GROUP, type: "group_suspend_cleared" }],
        "group_status_update",
      ),
    );
    expect((await h.store.group(PHONE_NUMBER_ID, GROUP))?.state).toBe("active");
    await h.worker.handle(
      event([{ failed: false, groupId: GROUP, type: "group_delete" }]),
    );
    expect(await h.store.groups(PHONE_NUMBER_ID)).toEqual([]);

    await h.store.saveGroup(
      aGroup({
        groupId: undefined,
        ref: "ref-0000000002",
        requestId: "request-8",
        state: "creating",
      }),
    );
    await h.worker.handle(
      event([
        {
          errorCode: 131215,
          failed: true,
          requestId: "request-8",
          type: "group_create",
        },
      ]),
    );
    expect((await h.store.groups(PHONE_NUMBER_ID))[0]?.state).toBe("failed");
  });

  it("refuses the group turn in Datalayer's words, and says a failure", async () => {
    const h = harness(store());
    await ready(h);
    const { HostRefusedError } = await import(
      "@datalayer/agent-runtimes/lib/portable/hosts"
    );
    h.agent.refuse = new HostRefusedError(403, "off here", "Datalayer");
    await h.worker.handle(inGroup(h, "Help Desk, hello"));
    expect(groupSaid(h).at(-1)).toBe(GROUP_WORDS.refused);
    h.agent.refuse = new Error("boom");
    await h.worker.handle(inGroup(h, "Help Desk, hello again"));
    expect(groupSaid(h).at(-1)).toBe(WORDS.failed);
  });
});
