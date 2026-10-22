import { describe, expect, it } from "vitest";

import {
  choiceOf,
  chooseApplication,
  disclosure,
  runWord,
  SAY,
  wordOf,
  WORDS,
  type CommandContext,
  type Reply,
  type Standing,
} from "../../src/commands.js";
import { Metrics } from "../../src/observability.js";
import { WindowKeeper } from "../../src/window.js";
import { FakeHosts } from "../support/hosts.js";
import {
  ALICE,
  capturingLogger,
  PHONE_NUMBER_ID,
  WABA,
} from "../support/meta.js";
import { storeCases } from "../support/stores.js";

/**
 * The words a person writes to the number, on each store: what each does,
 * and each one's refusals.
 */

describe("a word is the whole message", () => {
  it("reads every word in any case and spacing, and never inside a sentence", () => {
    for (const word of WORDS) {
      expect(wordOf(word)).toBe(word);
      expect(wordOf(`  ${word.toUpperCase()}  `)).toBe(word);
    }
    expect(wordOf("Start   Over")).toBe("start over");
    expect(wordOf("start\nover")).toBe("start over");
    expect(wordOf("please stop")).toBeUndefined();
    expect(wordOf("stop.")).toBeUndefined();
    expect(wordOf("help me with my invoice")).toBeUndefined();
    expect(wordOf("startover")).toBeUndefined();
    expect(wordOf("")).toBeUndefined();
    expect(wordOf(undefined)).toBeUndefined();
  });

  it("reads an application's list row, and nothing else, as a choice", () => {
    expect(choiceOf("app:dep-billing")).toBe("dep-billing");
    expect(choiceOf("app:")).toBeUndefined();
    expect(choiceOf("approve:ap-1")).toBeUndefined();
    expect(choiceOf(undefined)).toBeUndefined();
  });
});

const textOf = (replies: Reply[]): string =>
  replies.map((reply) => reply.text).join("\n");

describe.each(storeCases())("the words on $name", ({ store }) => {
  const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA };
  const setup = async (standing: Standing, turn?: () => Promise<void>) => {
    const hosts = new FakeHosts();
    const { lines, logger } = capturingLogger();
    const kept = store();
    await kept.recordInbound(chat, new Date("2026-10-22T12:00:00Z"));
    const context: CommandContext = {
      business: "Datalayer SRL",
      chat,
      hostKey: "dlhk_test-only-host-key",
      profileName: "Alice",
      standing,
      support: "support@example.com",
      ...(turn ? { turn: { stop: turn } } : {}),
    };
    const dependencies = {
      hosts,
      logger,
      store: kept,
      window: new WindowKeeper(
        kept,
        { now: () => Date.UTC(2026, 9, 22, 13) },
        new Metrics(logger),
      ),
      webUrl: "https://datalayer.example/",
    };
    return {
      choose: (uid: string) => chooseApplication(uid, context, dependencies),
      hosts,
      lines,
      run: (word: (typeof WORDS)[number]) =>
        runWord(word, context, dependencies),
      store: kept,
    };
  };

  it("help: the disclosure line, how to reach a person, and every word", async () => {
    const { run } = await setup("visitor");
    const said = textOf(await run("help"));
    expect(said).toContain(
      disclosure("Help Desk", "Datalayer SRL", "support@example.com"),
    );
    expect(said).toContain(
      "You're talking to Help Desk, an application run by Datalayer SRL on Datalayer. To reach a person: support@example.com.",
    );
    for (const word of WORDS) expect(said).toContain(`\`${word}\``);
  });

  it("help with no application on the number says so", async () => {
    const { hosts, run } = await setup("linked");
    hosts.self_ = { ...hosts.self_, defaultDeployment: undefined };
    expect(textOf(await run("help"))).toContain(SAY.noApplication);
  });

  it("status: the link, the application, a pause, a running answer", async () => {
    const linked = await setup("linked", async () => {});
    expect(textOf(await linked.run("status"))).toBe(
      "Your Datalayer account is linked here.\nThis chat talks to Help Desk.\nAn answer is running: `stop` stops it.",
    );
    const visitor = await setup("visitor");
    visitor.hosts.self_ = { ...visitor.hosts.self_, paused: true };
    expect(textOf(await visitor.run("status"))).toBe(
      "You're a visitor: nothing of you is kept beyond this conversation.\nThis chat talks to Help Desk.\nThe owner has paused this number.",
    );
    const stranger = await setup("private");
    expect(textOf(await stranger.run("status"))).toContain(
      "not linked: write `link`",
    );
  });

  it("app: a list for a linked person, the current one marked", async () => {
    const { run } = await setup("linked");
    expect(await run("app")).toEqual([
      {
        kind: "list",
        label: "Applications",
        rows: [
          { description: "Now", id: "app:dep-desk", title: "Help Desk" },
          { id: "app:dep-billing", title: "Billing" },
        ],
        text: "Choose the application this chat talks to. Choosing another starts a new conversation.",
      },
    ]);
  });

  it("app: refused to a visitor and to a person not linked", async () => {
    const visitor = await setup("visitor");
    expect(textOf(await visitor.run("app"))).toBe(SAY.visitorsTalkToDefault);
    expect(textOf(await visitor.choose("dep-billing"))).toBe(
      SAY.visitorsTalkToDefault,
    );
    const stranger = await setup("private");
    expect(textOf(await stranger.run("app"))).toBe(SAY.linkFirst);
    expect(textOf(await stranger.choose("dep-billing"))).toBe(SAY.linkFirst);
    expect((await visitor.store.chat(chat))?.generation).toBe(0);
  });

  it("app: one application is said, none is said, a long name is cut to WhatsApp's 24", async () => {
    const { hosts, run } = await setup("linked");
    hosts.self_ = {
      ...hosts.self_,
      deployments: [{ appName: "Help Desk", kept: false, uid: "dep-desk" }],
    };
    expect(textOf(await run("app"))).toBe(
      "Only Help Desk answers on this number.",
    );
    hosts.self_ = { ...hosts.self_, deployments: [] };
    expect(textOf(await run("app"))).toBe(SAY.noApplication);
    hosts.self_ = {
      ...hosts.self_,
      deployments: [
        { appName: "A".repeat(40), kept: false, uid: "dep-a" },
        { appName: "B", kept: false, uid: "dep-b" },
      ],
    };
    const [list] = await run("app");
    expect(list?.kind === "list" && list.rows[0]?.title).toBe(
      `${"A".repeat(23)}…`,
    );
  });

  it("app: more applications than a list shows fails loudly", async () => {
    const { hosts, run } = await setup("linked");
    hosts.self_ = {
      ...hosts.self_,
      deployments: Array.from({ length: 11 }, (_, n) => ({
        appName: `App ${n}`,
        kept: false,
        uid: `dep-${n}`,
      })),
    };
    await expect(run("app")).rejects.toThrow(/a WhatsApp list shows 10/);
  });

  it("choosing an application switches the chat in a new conversation, once", async () => {
    const { choose, run, store: kept } = await setup("linked");
    expect(textOf(await choose("dep-billing"))).toBe(
      "This chat now talks to Billing: a new conversation starts with your next message.",
    );
    expect(await kept.chat(chat)).toMatchObject({
      applicationId: "dep-billing",
      generation: 1,
    });
    expect(textOf(await choose("dep-billing"))).toBe(
      "This chat already talks to Billing.",
    );
    expect(textOf(await choose("dep-elsewhere"))).toBe(SAY.notAllowed);
    expect((await kept.chat(chat))?.generation).toBe(1);
    expect(textOf(await run("status"))).toContain("talks to Billing");
  });

  it("choosing while an answer runs is refused", async () => {
    const { choose, store: kept } = await setup("linked", async () => {});
    expect(textOf(await choose("dep-billing"))).toBe(SAY.stopBeforeSwitch);
    expect((await kept.chat(chat))?.generation).toBe(0);
  });

  it("start over: a new generation for a linked person and a visitor", async () => {
    for (const standing of ["linked", "visitor"] as const) {
      const { run, store: kept } = await setup(standing);
      const before = (await kept.chat(chat))?.generation ?? 0;
      expect(textOf(await run("start over"))).toBe(
        "Started over: your next message opens a new conversation.",
      );
      expect(textOf(await run("start over"))).toContain("Started over");
      expect((await kept.chat(chat))?.generation).toBe(before + 2);
    }
  });

  it("start over: refused to a person not linked, and while an answer runs", async () => {
    const stranger = await setup("private");
    expect(textOf(await stranger.run("start over"))).toBe(SAY.notLinked);
    const busy = await setup("linked", async () => {});
    expect(textOf(await busy.run("start over"))).toBe(SAY.stopFirst);
    expect((await busy.store.chat(chat))?.generation).toBe(0);
  });

  it("stop: the running answer stopped once, or nothing to stop", async () => {
    let stops = 0;
    const busy = await setup("visitor", async () => {
      stops += 1;
    });
    expect(textOf(await busy.run("stop"))).toBe(SAY.stopped);
    expect(stops).toBe(1);
    expect((await busy.store.chat(chat))?.noticesStopped).toBe(false);
  });

  it("stop with nothing running: no more notices, said in status", async () => {
    const idle = await setup("linked");
    expect(textOf(await idle.run("stop"))).toBe(SAY.noticesStopped);
    expect((await idle.store.chat(chat))?.noticesStopped).toBe(true);
    expect(textOf(await idle.run("status"))).toContain(
      "No notices after a day of silence",
    );
  });

  it("link: a one-use code as a button to Datalayer, for anyone not linked", async () => {
    for (const standing of ["visitor", "private"] as const) {
      const { hosts, run } = await setup(standing);
      expect(await run("link")).toEqual([
        {
          kind: "button",
          label: "Link",
          text: "Link your Datalayer account: sign in to Datalayer, check what it shows and confirm. The link works once, for 10 minutes.",
          url: "https://datalayer.example/hosts/link?code=dlhc_code1",
        },
      ]);
      expect(hosts.calls).toEqual([
        `linkCode:dlhk_test-only-host-key:${ALICE}:Alice`,
      ]);
    }
  });

  it("link: refused to a person already linked, without asking for a code", async () => {
    const { hosts, run } = await setup("linked");
    expect(textOf(await run("link"))).toBe(SAY.linkedAlready);
    expect(hosts.codes).toBe(0);
  });

  it("unlink: ends the link at Datalayer, audited by pseudonym", async () => {
    const { hosts, lines, run } = await setup("linked");
    hosts.links.add(ALICE);
    expect(textOf(await run("unlink"))).toBe(SAY.unlinked);
    expect(hosts.calls).toEqual([`unlink:dlhk_test-only-host-key:${ALICE}`]);
    const audit = lines.map((line) => JSON.parse(line) as { event: string });
    expect(audit.map((one) => one.event)).toEqual(["identity.unlinked"]);
    expect(lines.join("\n")).not.toContain(ALICE);
    // Already ended elsewhere: said, not hidden.
    expect(textOf(await run("unlink"))).toBe(SAY.notLinkedHere);
  });

  it("unlink: refused to a visitor and a person not linked, without a call", async () => {
    for (const standing of ["visitor", "private"] as const) {
      const { hosts, run } = await setup(standing);
      expect(textOf(await run("unlink"))).toBe(SAY.notLinkedHere);
      expect(hosts.calls).toEqual([]);
    }
  });

  it("forget: unlinked at Datalayer and every row naming the person deleted, for anyone", async () => {
    const linked = await setup("linked");
    linked.hosts.links.add(ALICE);
    await linked.store.hold(chat, "delivery", "dl-1", new Date());
    await linked.store.recordInbound(
      { ...chat, phoneNumberId: "another-number" },
      new Date(),
    );
    const said = textOf(await linked.run("forget"));
    expect(said).toBe(
      "Done: your Datalayer account is unlinked from this number, and 3 records naming you here are deleted. Your conversations stay in Datalayer under its record retention: delete them there. Meta keeps its own copy of the messages for up to 30 days.",
    );
    expect(linked.hosts.calls).toEqual([
      `unlink:dlhk_test-only-host-key:${ALICE}`,
    ]);
    expect(await linked.store.chat(chat)).toBeUndefined();
    expect(await linked.store.holds(chat)).toEqual([]);
    expect(linked.lines.join("\n")).not.toContain(ALICE);

    const visitor = await setup("visitor");
    expect(textOf(await visitor.run("forget"))).toMatch(
      /^Done: 1 record naming you here is deleted\./,
    );
    expect(await visitor.store.chat(chat)).toBeUndefined();
  });
});
