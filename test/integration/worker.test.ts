import { describe, expect, it } from "vitest";

import { SAY } from "../../src/commands.js";
import { sessionUidOf } from "../../src/domain.js";
import { LIMITS } from "../../src/meta-port.js";
import { STOP_ID, WORDS } from "../../src/render.js";
import { PART_SPACING_MS } from "../../src/speaker.js";
import { wamidHash } from "../../src/store.js";
import { WAITING } from "../../src/worker.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import { BUSINESS_TOKEN, harness, HOST_KEY } from "../support/worker.js";

/**
 * The 1:1 turn, on each store, with a fake clock, a fake Meta and a fake
 * agent: the person's standing and application, the disclosure once, the
 * read mark with the typing indicator, the turn idempotent on the message
 * (named by its hash), the answer written whole within WhatsApp's limits,
 * Stop by the word and the button, a question answered by a button, a
 * credential sent to Datalayer only, quotas, a long turn's ⏳ and progress,
 * and a turn that outlives the window.
 */

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };

/** A paragraph of `length` characters. */
const paragraph = (length: number, letter: string) =>
  `${letter.repeat(length - 1)}.`;

describe.each(storeCases())("a turn on $name", ({ store }) => {
  it("answers a question whole: the disclosure once, read and typing once, the session continued", async () => {
    const h = harness(store());
    await h.connect();
    const first = h.job();
    await h.worker.handle(first);
    expect(h.meta.calls.filter((one) => one.method === "markRead")).toEqual([
      expect.objectContaining({ detail: first.wamid, token: BUSINESS_TOKEN }),
    ]);
    expect(h.meta.said()).toEqual([
      "You're talking to Help Desk, an application run by Acme SRL on Datalayer. To reach a person: support@acme.example. Write `help` for what I can do.",
      "Hello.",
    ]);
    const [request] = h.agent.started;
    expect(request).toMatchObject({
      applicationId: "dep-desk",
      externalEventId: `whatsapp:${wamidHash(first.wamid)}`,
      externalUserId: ALICE,
      principalId: `principal-${ALICE}`,
      prompt: "What changed this week?",
      sessionGeneration: 0,
    });
    expect(request?.sessionId).toBeUndefined();
    // The message is named by its id's hash: the id may embed a phone number.
    expect(h.agent.provenances[0]).toEqual({
      host_kind: "whatsapp",
      message_id: wamidHash(first.wamid),
      place: { id: ALICE, kind: "direct" },
      thread: sessionUidOf(
        { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
        0,
      ),
    });
    expect(JSON.stringify(h.agent.provenances[0])).not.toContain("wamid.");
    expect(h.metrics.total("turns")).toBe(1);

    h.clock.advance(60 * SECOND);
    await h.worker.handle(h.job("And last week?"));
    expect(h.meta.said()).toHaveLength(3);
    expect(h.agent.started[1]?.sessionId).toBe(
      sessionUidOf(
        { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
        0,
      ),
    );
    expect(await h.window.usage(PHONE_NUMBER_ID)).toMatchObject({
      service: 3,
      utility: 0,
    });
  });

  it("writes a 10,000-character answer as 4 messages 10 s apart and 1 document, no 131056", async () => {
    const h = harness(store());
    await h.connect();
    await h.store.recordInbound(
      { ...chat, wabaId: WABA },
      new Date(h.clock.now()),
    );
    await h.store.markDisclosed(chat);
    // Paragraphs no two of which fit one message: five pieces.
    const answer = [
      paragraph(1000, "a"),
      paragraph(3200, "b"),
      paragraph(1000, "c"),
      paragraph(3200, "d"),
      paragraph(1592, "e"),
    ].join("\n\n");
    expect(answer).toHaveLength(10_000);
    h.agent.script = [{ kind: "text", text: answer }, { kind: "completion" }];
    await h.worker.handle(h.job());
    const sends = h.meta.calls.filter((one) => one.method === "send");
    const texts = sends.filter((one) => one.message?.type === "text");
    expect(texts).toHaveLength(4);
    for (const one of texts)
      expect((one.message as { text: string }).text.length).toBeLessThanOrEqual(
        LIMITS.text,
      );
    expect(
      sends.filter((one) => one.message?.type === "document"),
    ).toHaveLength(1);
    // Each message of the answer 10 s after the one before.
    for (let index = 1; index < sends.length; index += 1)
      expect(sends[index]!.at - sends[index - 1]!.at).toBe(PART_SPACING_MS);
    const upload = h.meta.calls.find((one) => one.method === "upload");
    expect(upload?.detail).toEqual({
      filename: "answer.md",
      mimeType: "text/markdown",
      text: answer,
    });
    expect((texts[3]?.message as { text: string }).text).toContain(
      WORDS.inDocument,
    );
    // Then *Open in Datalayer*, one use, for the person.
    expect(sends.at(-1)?.message).toMatchObject({
      label: WORDS.openLabel,
      type: "cta",
      url: "https://datalayer.ai/hosts/open?code=dlho_one-use-1",
    });
    expect(h.metrics.total("pair_rate_limited")).toBe(0);
    expect(h.meta.calls).toHaveLength(1 + sends.length + 1);
  });

  it("stops a running turn by the word, once, as the person who asked", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.script = [
      { kind: "text", text: "Thinking" },
      { kind: "text", text: " more" },
      { kind: "completion" },
    ];
    h.agent.onStream = async () => {
      h.agent.onStream = undefined;
      await h.worker.handle(h.job("STOP "));
    };
    await h.worker.handle(h.job());
    const session = sessionUidOf(
      { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
      0,
    );
    expect(h.agent.stopped).toEqual([session]);
    expect(h.meta.said().filter((one) => one === SAY.stopped)).toHaveLength(1);
    expect(h.meta.said().join("\n")).not.toContain("Thinking");
    // Nothing waits: the chat's turn is released.
    expect((await h.store.chat(chat))?.turn).toBeUndefined();
  });

  it("stops a running turn by its Stop button", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.onStream = async () => {
      h.agent.onStream = undefined;
      await h.worker.handle(
        h.job(undefined, {
          reply: { id: STOP_ID, title: "Stop" },
          text: undefined,
          type: "interactive",
        }),
      );
    };
    await h.worker.handle(h.job());
    expect(h.agent.stopped).toHaveLength(1);
    expect(h.meta.said()).toContain(SAY.stopped);
    expect(h.meta.said()).not.toContain("Hello.");
  });

  it("asks a question with buttons, and a pressed button is the next prompt in the same session", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.script = [
      { kind: "text", text: "Two plans fit." },
      {
        kind: "ask",
        question: {
          kind: "choice",
          options: ["Basic", "Pro"],
          prompt: "Which plan?",
        },
      },
    ];
    await h.worker.handle(h.job());
    expect(h.meta.sent("buttons").at(-1)).toEqual({
      body: "Which plan?",
      buttons: [
        { id: "ask:0", title: "Basic" },
        { id: "ask:1", title: "Pro" },
      ],
      type: "buttons",
    });
    h.agent.script = [
      { kind: "text", text: "Pro it is." },
      { kind: "completion" },
    ];
    h.clock.advance(20 * SECOND);
    await h.worker.handle(
      h.job(undefined, {
        reply: { id: "ask:1", title: "Pro" },
        text: undefined,
        type: "interactive",
      }),
    );
    expect(h.agent.started[1]).toMatchObject({
      prompt: "Pro",
      sessionId:
        h.agent.started[0] &&
        sessionUidOf(
          { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
          0,
        ),
    });
    expect(h.meta.said().at(-1)).toBe("Pro it is.");
    expect((await h.store.chat(chat))?.asking).toBeUndefined();
  });

  it("sends an answer holding a credential to Datalayer only", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.script = [
      {
        kind: "text",
        text: "Use Bearer abcdefghijklmnopqrstuvwxyz to call it.",
      },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const after = h.meta.sent().slice(1);
    expect(after).toEqual([
      {
        body: WORDS.private,
        label: WORDS.openLabel,
        type: "cta",
        url: "https://datalayer.ai/hosts/open?code=dlho_one-use-1",
      },
    ]);
    expect(JSON.stringify(h.meta.calls)).not.toContain("abcdefghijklmnop");
    expect(h.asPerson.handoffs).toEqual([
      {
        kind: "session",
        target: sessionUidOf(
          { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
          0,
        ),
        userId: ALICE,
      },
    ]);
  });

  it("tells a person without a link how to link, once a day, and runs nothing", async () => {
    const h = harness(store());
    await h.connect();
    h.hosts.links.clear();
    await h.worker.handle(h.job());
    await h.worker.handle(h.job("Again?"));
    expect(h.meta.said()).toEqual([SAY.notLinked]);
    h.clock.advance(24 * HOUR);
    await h.worker.handle(h.job("Tomorrow?"));
    expect(h.meta.said()).toEqual([SAY.notLinked, SAY.notLinked]);
    expect(h.agent.started).toEqual([]);
  });

  it("answers the words without a turn: help, start over", async () => {
    const h = harness(store());
    await h.connect();
    await h.worker.handle(h.job(" Help "));
    expect(h.meta.said()[0]).toContain("You're talking to Help Desk");
    expect(h.meta.said()[0]).toContain("`start over`");
    await h.worker.handle(h.job());
    await h.worker.handle(h.job("start over"));
    await h.worker.handle(h.job("Fresh question"));
    expect(
      h.agent.started.map((one) => [one.sessionGeneration, one.sessionId]),
    ).toEqual([
      [0, undefined],
      [1, undefined],
    ]);
  });

  it("tells a second message that an answer runs", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.onStream = async () => {
      h.agent.onStream = undefined;
      await h.worker.handle(h.job("Another question"));
    };
    await h.worker.handle(h.job());
    expect(h.meta.said()).toContain(WORDS.busy);
    expect(h.agent.started).toHaveLength(1);
  });

  it("refuses a question past the person's quota, charged once per message", async () => {
    const h = harness(store(), {
      limits: {
        application: 100,
        installation: 100,
        organization: 100,
        user: 1,
      },
    });
    await h.connect();
    const first = h.job();
    await h.worker.handle(first);
    await h.worker.handle(first);
    expect(h.agent.started).toHaveLength(2);
    await h.worker.handle(h.job("One more"));
    expect(h.agent.started).toHaveLength(2);
    expect(h.meta.said().at(-1)).toMatch(/hour/i);
  });

  it("marks a long turn with ⏳ past the typing indicator, says it still works with Stop at 30 s, then removes ⏳", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.script = [
      { kind: "progress", label: "Reading the files" },
      { wait: 26 * SECOND },
      { kind: "progress", label: "Reading the files" },
      { wait: 5 * SECOND },
      { kind: "progress", label: "Writing" },
      { wait: 10 * SECOND },
      { kind: "progress", label: "Writing" },
      { kind: "text", text: "Done." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const reactions = h.meta.sent("reaction");
    expect(reactions.map((one) => (one as { emoji: string }).emoji)).toEqual([
      WAITING,
      "",
    ]);
    const progress = h.meta.sent("buttons");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      buttons: [{ id: STOP_ID, title: "Stop" }],
    });
    expect(h.meta.said().at(-1)).toBe("Done.");
  });

  it("ends a turn that outlived the window with a notice, and the reply brings the answer", async () => {
    const h = harness(store());
    await h.connect();
    h.agent.script = [
      { wait: 25 * HOUR },
      { kind: "text", text: "Late answer." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    expect(h.meta.said().at(-1)).toBe("template:datalayer_turn_done");
    expect(h.meta.said()).not.toContain("Late answer.");
    const session = sessionUidOf(
      { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA },
      0,
    );
    h.asPerson.answers.set(session, "Late answer.");
    h.clock.advance(HOUR);
    await h.worker.handle(
      h.job(undefined, {
        reply: { id: "Show me", title: "Show me" },
        text: "Show me",
        type: "button",
      }),
    );
    expect(h.meta.said().at(-1)).toBe("Late answer.");
    expect(h.agent.started).toHaveLength(1);
    expect(await h.window.usage(PHONE_NUMBER_ID)).toMatchObject({ utility: 1 });
  });

  it("says once a day that the owner paused the number", async () => {
    const h = harness(store());
    await h.connect({ state: "paused" });
    await h.worker.handle(h.job());
    await h.worker.handle(h.job("Hello?"));
    expect(h.meta.said()).toEqual([WORDS.paused]);
    expect(h.agent.started).toEqual([]);
  });

  it("drops a message of a number that is not connected", async () => {
    const h = harness(store());
    await h.worker.handle(h.job());
    expect(h.meta.calls).toEqual([]);
    expect(h.hosts.calls).toEqual([]);
  });

  it("runs a turn for the longest BSUID (131 characters) as the place and the session", async () => {
    const h = harness(store());
    await h.connect();
    const longest = `US.${"1".repeat(128)}`;
    expect(longest).toHaveLength(131);
    h.hosts.links.add(longest);
    await h.worker.handle(h.job(undefined, { userId: longest }));
    expect(h.agent.started[0]?.externalUserId).toBe(longest);
    const provenance = h.agent.provenances[0] as { place: { id: string } };
    expect(provenance.place).toEqual({ id: longest, kind: "direct" });
    expect(Buffer.byteLength(JSON.stringify(provenance))).toBeLessThanOrEqual(
      1024,
    );
    expect(
      h.meta.calls
        .filter((one) => one.method === "send")
        .every((one) => one.userId === longest),
    ).toBe(true);
    expect(h.hosts.calls).toContain(`linkState:${HOST_KEY}`);
  });
});
