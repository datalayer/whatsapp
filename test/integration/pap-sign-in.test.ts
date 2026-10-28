import type { SemanticEvent } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { PAP_SIGN_IN_WORDS } from "@datalayer/agent-runtimes/lib/portable/signIn";
import { describe, expect, it } from "vitest";

import { GROUP_WORDS } from "../../src/groups.js";
import type { MessageJob } from "../../src/webhook.js";
import { ALICE, PHONE_NUMBER_ID, WABA } from "../support/meta.js";
import { storeCases } from "../support/stores.js";
import { harness, type Harness } from "../support/worker.js";

/**
 * A company's sign-in in a WhatsApp turn (WA-42), on each store, with a
 * fake Meta and a fake agent: the runtime's `sign-in` semantic event shown
 * at once — Direct Sign-In as a button to the gateway's https start link,
 * Device Sign-In as the code with a button to the page — once per call, the
 * turn going on to its answer; a page that is not https refused; in a group,
 * the button only in the asker's own chat. No token, ticket or link in any
 * log line.
 */

const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE };
const GROUP = "Y2FwaV9ncm91cDoxNzA1NTU1MDEzOToxMjAzNjM0MDQ2OTQyMzM4MjAZD";
const START =
  "https://datalayer.ai/api/iam/v1/pap/start?ticket=one-use-ticket-0123456789";

const direct: SemanticEvent = {
  kind: "sign-in",
  signIn: {
    company: "manzanita.example",
    host: "datalayer.ai",
    mode: "direct",
    open: START,
  },
  toolCallId: "call-1",
  toolName: "pap_sign_in",
};

const device: SemanticEvent = {
  kind: "sign-in",
  signIn: {
    code: "WDJB-MJHT",
    host: "manzanita.example",
    mode: "device",
    open: "https://manzanita.example/device",
    organization: { domain: "manzanita.example", name: "Manzanita" },
  },
  toolCallId: "call-2",
  toolName: "pap_sign_in",
};

/** The number connected, Alice linked and told who answers, her window open. */
async function ready(h: Harness) {
  await h.connect();
  await h.store.recordInbound(
    { ...chat, wabaId: WABA },
    new Date(h.clock.now()),
  );
  await h.store.markDisclosed(chat);
}

describe.each(storeCases())("a PAP sign-in in a turn on $name", ({ store }) => {
  it("shows Direct Sign-In as a button to the start link at once, once per call, and the turn goes on", async () => {
    const h = harness(store());
    await ready(h);
    h.agent.script = [
      { id: "call-1", kind: "tool", name: "pap_sign_in", status: "complete" },
      direct,
      // The same call's event again: shown once.
      direct,
      { kind: "text", text: "Signed in: your balance is 42." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job("What is my balance at Manzanita?"));
    const sent = h.meta.sentTo("individual");
    expect(sent).toEqual([
      {
        body: "Sign in to manzanita.example. Open the company's page through Datalayer and sign in there; write here again once you are back.",
        label: "Sign in to manzanit…",
        type: "cta",
        url: START,
      },
      { text: "Signed in: your balance is 42.", type: "text" },
    ]);
    // Nothing of the link in the logs: the ticket is the person's alone.
    const logs = h.lines.join("\n");
    expect(logs).toContain("turn.sign_in");
    expect(logs).not.toContain("one-use-ticket");
    expect(logs).not.toContain("pap/start");
  });

  it("shows Device Sign-In as the code with a button to the company's page", async () => {
    const h = harness(store());
    await ready(h);
    h.agent.script = [
      device,
      { kind: "text", text: "Done." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const [first] = h.meta.sentTo("individual");
    expect(first).toMatchObject({
      label: "Open manzanita.exam…",
      type: "cta",
      url: "https://manzanita.example/device",
    });
    expect((first as { body: string }).body).toContain("*WDJB-MJHT*");
    expect((first as { body: string }).body).toContain(
      "Manzanita (manzanita.example)",
    );
    expect(h.lines.join("\n")).not.toContain("WDJB-MJHT");
  });

  it("refuses a page that is not https, showing no link", async () => {
    const h = harness(store());
    await ready(h);
    h.agent.script = [
      {
        ...direct,
        signIn: {
          host: "manzanita.example",
          mode: "direct",
          open: "http://manzanita.example/",
        },
      },
      { kind: "completion", text: "Could not sign in." },
    ];
    await h.worker.handle(h.job());
    const sent = h.meta.sentTo("individual");
    expect(sent[0]).toEqual({ text: PAP_SIGN_IN_WORDS.refused, type: "text" });
    expect(JSON.stringify(sent)).not.toContain("http://manzanita.example");
  });

  it("in a group, sends the button to the asker's own chat with a pointer in the group; never the link in the group", async () => {
    const h = harness(store());
    await ready(h);
    await h.store.saveGroup({
      createdAt: new Date(Date.UTC(2026, 9, 22)),
      groupId: GROUP,
      phoneNumberId: PHONE_NUMBER_ID,
      ref: "ref-0000000001",
      state: "active",
      subject: "Launch team",
      wabaId: WABA,
    });
    const ask = (text: string): MessageJob => h.job(text, { groupId: GROUP });
    h.agent.script = [
      direct,
      { kind: "text", text: "Signed in." },
      { kind: "completion" },
    ];
    await h.worker.handle(ask("Help Desk, my balance?"));
    const personal = h.meta.sentTo("individual");
    expect(personal).toEqual([
      expect.objectContaining({ type: "cta", url: START }),
    ]);
    const group = h.meta.sentTo("group");
    expect(group).toContainEqual({
      text: GROUP_WORDS.signIn("Alice, ", "Acme SRL"),
      type: "text",
    });
    expect(JSON.stringify(group)).not.toContain("one-use-ticket");
  });

  it("in a group, with the asker's own chat closed, tells them to write first and shows the link nowhere", async () => {
    const h = harness(store());
    await h.connect();
    await h.store.saveGroup({
      createdAt: new Date(Date.UTC(2026, 9, 22)),
      groupId: GROUP,
      phoneNumberId: PHONE_NUMBER_ID,
      ref: "ref-0000000001",
      state: "active",
      subject: "Launch team",
      wabaId: WABA,
    });
    h.agent.script = [
      direct,
      { kind: "text", text: "Not yet." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job("Help Desk, my balance?", { groupId: GROUP }));
    expect(h.meta.sentTo("individual")).toEqual([]);
    const group = h.meta.sentTo("group");
    expect(group).toContainEqual({
      text: GROUP_WORDS.writeFirst("Alice, ", "Acme SRL"),
      type: "text",
    });
    expect(JSON.stringify(group)).not.toContain("one-use-ticket");
  });
});
