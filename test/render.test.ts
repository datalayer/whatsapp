import { describe, expect, it } from "vitest";

import { checkLimits, LIMITS } from "../src/meta-port.js";
import {
  approvalCard,
  approvalPressOf,
  confirmStep,
  monospaceTable,
  optionOf,
  renderAnswer,
  renderPapSignIn,
  renderQuestion,
  secretBearing,
  splitText,
  whatsappFormat,
  WORDS,
} from "../src/render.js";
import { mailPresentation } from "./support/worker.js";

/** WhatsApp's forms, within its limits, from the kit's semantic answer. */

describe("an answer in WhatsApp's marks", () => {
  it("turns Markdown's emphasis, headings and lists into WhatsApp's, code kept", () => {
    expect(
      whatsappFormat(
        [
          "## Plan",
          "**Bold**, *italic*, __also bold__ and ~~gone~~.",
          "* one",
          "- two",
          "Keep `a*b*c` as code.",
          "```",
          "**not bold** in code",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "*Plan*",
        "*Bold*, _italic_, *also bold* and ~gone~.",
        "- one",
        "- two",
        "Keep `a*b*c` as code.",
        "```",
        "**not bold** in code",
        "```",
      ].join("\n"),
    );
  });

  it("makes links a numbered footer and narrow tables monospace", () => {
    const rendered = renderAnswer(
      [
        "See [the guide](https://datalayer.ai/docs) and [the guide](https://datalayer.ai/docs).",
        "",
        "| Plan | Price |",
        "| --- | --- |",
        "| Pro | 10 |",
      ].join("\n"),
    );
    expect(rendered.document).toBeUndefined();
    expect(rendered.messages).toEqual([
      [
        "See the guide [1] and the guide [1].",
        "",
        "```",
        "Plan | Price",
        "-----+------",
        "Pro  | 10",
        "```",
        "",
        "[1] the guide: https://datalayer.ai/docs",
      ].join("\n"),
    ]);
  });

  it("sends a table wider than four columns to the document, the answer whole", () => {
    const answer = [
      "| a | b | c | d | e |",
      "| --- | --- | --- | --- | --- |",
      "| 1 | 2 | 3 | 4 | 5 |",
    ].join("\n");
    const rendered = renderAnswer(answer);
    expect(rendered.messages).toEqual([
      "_A table of 5 columns: in the document below._",
    ]);
    expect(rendered.document).toEqual({
      caption: WORDS.wholeAnswer,
      filename: "answer.md",
      text: answer,
    });
  });

  it("splits at paragraphs, then lines, then hard, never past 4,096", () => {
    expect(splitText("a\n\nb", 10)).toEqual(["a\n\nb"]);
    expect(splitText("aaaa\n\nbbbb", 6)).toEqual(["aaaa", "bbbb"]);
    expect(splitText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    for (const piece of splitText("x".repeat(9000)))
      expect(piece.length).toBeLessThanOrEqual(LIMITS.text);
  });

  it("lines up a table's columns", () => {
    expect(monospaceTable(["k", "value"], [["long key", "1"]])).toBe(
      "```\nk        | value\n---------+------\nlong key | 1\n```",
    );
  });

  it("knows a credential when it sees one", () => {
    expect(secretBearing("Bearer abcdefghijklmnop")).toBe(true);
    expect(secretBearing("Nothing to hide.")).toBe(false);
  });
});

describe("a question", () => {
  it("is buttons up to three short options, a list up to ten, words beyond", () => {
    expect(
      renderQuestion({ kind: "choice", options: ["Yes", "No"], prompt: "Go?" }),
    ).toMatchObject({ type: "buttons" });
    const list = renderQuestion({
      kind: "choice",
      options: [
        "Basic",
        "Pro",
        "Team",
        "A much longer option than a row's title",
      ],
      prompt: "Which?",
    });
    expect(list).toMatchObject({ label: "Choose", type: "list" });
    if (list) checkLimits(list);
    const many = Array.from({ length: 11 }, (_, index) => `Option ${index}`);
    expect(
      renderQuestion({ kind: "choice", options: many, prompt: "Which?" }),
    ).toMatchObject({ type: "text" });
    expect(renderQuestion({ kind: "text", prompt: "Your name?" })).toEqual({
      text: "Your name?",
      type: "text",
    });
    expect(
      renderQuestion({ kind: "form", prompt: "Fill this" }),
    ).toBeUndefined();
  });

  it("reads the option a pressed button chose", () => {
    expect(optionOf("ask:1", ["a", "b"])).toBe("b");
    expect(optionOf("ask:9", ["a", "b"])).toBeUndefined();
    expect(optionOf("app:dep", ["a"])).toBeUndefined();
  });
});

describe("the approval card", () => {
  const review = async () => "https://datalayer.ai/hosts/open?code=dlho_x";

  it("offers Approve, Reject and Show more for mail it shows whole, within 1,024 characters", async () => {
    const card = await approvalCard(mailPresentation(), {
      appName: "Help Desk",
      now: Date.parse("2026-10-22T12:00:00Z"),
      reviewUrl: review,
    });
    expect(card.decidable).toBe(true);
    expect(card.message).toEqual({
      body: [
        "*Help Desk* asks to send something: `send_email`",
        "",
        "*To:* release@example.com",
        "*Subject:* Launch decision",
        "*Body:* We go with option B.",
      ].join("\n"),
      buttons: [
        { id: "ap:approve:ap-1", title: "Approve" },
        { id: "ap:reject:ap-1", title: "Reject" },
        { id: "ap:more:ap-1", title: "Show more" },
      ],
      footer: "Asked 2 min ago",
      type: "buttons",
    });
    checkLimits(card.message);
  });

  it("is Review in Datalayer only when it does not fit, or a host may not decide it", async () => {
    const long = await approvalCard(
      mailPresentation({
        arguments: {
          body: "x".repeat(1100),
          subject: "Long",
          to: "a@example.com",
        },
      }),
      { appName: "Help Desk", now: 0, reviewUrl: review },
    );
    expect(long.decidable).toBe(false);
    expect(long.message).toMatchObject({
      label: WORDS.reviewLabel,
      type: "cta",
    });
    checkLimits(long.message);
    const write = await approvalCard(
      mailPresentation({ action_class: "write", tool_name: "update_row" }),
      { appName: "Help Desk", now: 0, reviewUrl: review },
    );
    expect(write.message).toMatchObject({ type: "cta" });
  });

  it("names the action again in its second step", () => {
    const step = confirmStep(mailPresentation(), true);
    expect(step).toMatchObject({
      buttons: [
        { id: "ap:yes-approve:ap-1", title: "Yes, approve" },
        { id: "ap:no:ap-1", title: "No" },
      ],
      type: "buttons",
    });
    expect((step as { body: string }).body).toMatch(
      /^Approve: `send_email` \(To: release@example.com; Subject: Launch decision; Body: We go with option B.\)\? This cannot be undone.$/,
    );
    expect(approvalPressOf("ap:yes-approve:ap-1")).toEqual({
      approvalId: "ap-1",
      choice: "yes-approve",
    });
    expect(approvalPressOf("ap:maybe:ap-1")).toBeUndefined();
  });

  it("shows a PAP operation with its exact revision and the company, reviewed in Datalayer under the kit's renderers", async () => {
    const card = await approvalCard(
      mailPresentation({
        action_class: "write",
        arguments: { operation_ref: "op-7", revision: 3 },
        fields: [
          { label: "Company", name: "company", value: "manzanita.example" },
          {
            label: "Operation",
            name: "operation",
            value: "Book a table for 2 at 20:00",
          },
        ],
        tool_name: "pap_confirm",
      }),
      { appName: "Concierge", now: 0, reviewUrl: review },
    );
    expect(card.decidable).toBe(false);
    expect((card.message as { body: string }).body).toContain(
      "*Concierge* asks you to confirm an operation at manzanita.example, exactly revision 3.",
    );
    expect(card.message).toMatchObject({
      label: WORDS.reviewLabel,
      type: "cta",
    });
  });
});

describe("a PAP sign-in", () => {
  it("is a button to the company's page through Datalayer, never a token", () => {
    const messages = renderPapSignIn({
      company: "manzanita.example",
      expires_at: "2026-10-22T12:10:00Z",
      host: "datalayer.ai",
      mode: "direct",
      open: "https://datalayer.ai/api/iam/v1/pap/start?ticket=one-use",
      status: "waiting_for_the_person",
    });
    expect(messages).toEqual([
      {
        body: "Sign in to manzanita.example. Open the company's page through Datalayer and sign in there; write here again once you are back. Until 12:10 UTC.",
        label: "Sign in to manzanit…",
        type: "cta",
        url: "https://datalayer.ai/api/iam/v1/pap/start?ticket=one-use",
      },
    ]);
    for (const one of messages ?? []) checkLimits(one);
  });

  it("is the code and the page to enter it, for a Device Sign-In", () => {
    const [message] =
      renderPapSignIn({
        code: "WDJB-MJHT",
        host: "manzanita.example",
        mode: "device",
        open: "https://manzanita.example/device",
        organization_domain: "manzanita.example",
        organization_name: "Manzanita",
        status: "waiting_for_the_person",
      }) ?? [];
    expect(message).toMatchObject({
      label: "Open manzanita.exam…",
      type: "cta",
      url: "https://manzanita.example/device",
    });
    expect((message as { body: string }).body).toContain("*WDJB-MJHT*");
  });

  it("refuses a page that is not https, and ignores what is not a waiting sign-in", () => {
    expect(
      renderPapSignIn({
        host: "x",
        mode: "direct",
        open: "http://manzanita.example/",
        status: "waiting_for_the_person",
      }),
    ).toEqual([
      {
        text: "This sign-in link cannot be opened safely, so it is not shown.",
        type: "text",
      },
    ]);
    expect(renderPapSignIn({ status: "signed_in" })).toBeUndefined();
  });
});
