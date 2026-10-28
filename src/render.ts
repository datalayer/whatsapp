import {
  answerParts,
  hostMayDecide,
  redact,
  renderApproval,
  type ApprovalPresentation,
  type AskQuestion,
  type TurnState,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import {
  PAP_SIGN_IN_WORDS,
  readPapSignIn,
  type PapSignInWaiting,
} from "@datalayer/agent-runtimes/lib/portable/signIn";

import { LIMITS, type Outgoing } from "./meta-port.js";

/**
 * What the number says, in WhatsApp's own forms and within its limits.
 *
 * - An answer is written whole (the Cloud API has no edit): Markdown becomes
 *   WhatsApp's `*bold*`, `_italic_`, `~strike~`, monospace and lists;
 *   tables of four columns or fewer become monospace, wider ones go to a
 *   document; links become a numbered footer. Up to 4,096 characters a
 *   message, split at paragraphs into at most four messages; an answer
 *   longer than that, or with a wide table, comes whole as a Markdown
 *   document after them.
 * - A question with three short options is reply buttons, with ten or fewer
 *   a list, otherwise words with numbered options.
 * - An approval is one card of 1,024 characters at most with *Approve*,
 *   *Reject* and *Show more*, then a second, confirming step; anything that
 *   does not fit, or that a host may not decide, is *Review in Datalayer*
 *   only.
 * - A personal agent's sign-in at a company (PAP) is a button to the
 *   company's page through Datalayer, or a code and the page to enter it;
 *   never a token.
 *
 * Anything a credential shows in is not written at all: the person is sent
 * to Datalayer (a message rests at Meta for 30 days).
 */

/** What the number says on its own account. */
export const WORDS = {
  busy: "An answer is running. Write `stop` to stop it, or wait for it.",
  paused: "Paused by the owner: this number does not answer for now.",
  failed:
    "The application could not answer just now. Nothing was charged twice; ask again in a moment.",
  endedEarly: "The answer ended before it said anything.",
  refusedByDatalayer:
    "Datalayer did not let this chat use the application. Write `status` to see why, or ask the business.",
  textOnly:
    "I read written messages only for now: write your question in words.",
  stillWorking: "Still working on it.",
  private:
    "The answer holds something that should not rest in a chat. Open it in Datalayer:",
  openLabel: "Open in Datalayer",
  reviewLabel: "Review in Datalayer",
  wholeAnswer: "The whole answer, as Markdown.",
  inDocument: "(The rest is in the document below.)",
  nothingHeld: "Nothing is waiting for you here.",
  noApplication: "No application answers on this number yet.",
  notAllowed: "That application is not one this number allows. Write `app`.",
  changed: "This changed — see the new request.",
  alreadyDecided: "Already decided.",
  decidedElsewhere: "Already decided elsewhere.",
  expired: "Expired: nothing was done.",
  notYours: "This request waits on someone else: nothing was done.",
  kept: "Kept: nothing was decided. The request still waits.",
  linkFirst:
    "Only a linked Datalayer account decides here. Write `link` first.",
} as const;

/** Whether a text holds a credential the kit's patterns know. */
export function secretBearing(text: string): boolean {
  return redact(text) !== text;
}

/**
 * Everything of a turn its messages could show: a credential in any of
 * them sends the whole answer to Datalayer.
 */
export function shownText(state: TurnState): string {
  return [
    state.answer,
    state.status,
    state.error ?? "",
    state.asking?.prompt ?? "",
    ...(state.asking?.options ?? []),
    ...state.files.flatMap((file) => [file.name, file.url]),
  ].join("\n");
}

/** Markdown's emphasis, headings and lists in WhatsApp's own marks; code kept. */
export function whatsappFormat(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push("```");
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n");
}

const BOLD = "\u0001";

function inline(line: string): string {
  // Inline code is kept as it is: split it out first.
  return line
    .split(/(`[^`\n]+`)/)
    .map((piece, index) => (index % 2 === 1 ? piece : marks(piece)))
    .join("");
}

function marks(text: string): string {
  let line = text;
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) line = `${BOLD}${heading[1]}${BOLD}`;
  line = line
    .replace(/^(\s*)[*+-]\s+/, "$1- ")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "_$1_")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~");
  return line.replaceAll(BOLD, "*");
}

/** The most columns a table keeps in a message; wider goes to the document. */
export const TABLE_COLUMNS = 4;
/** The most messages an answer takes; the rest goes to the document. */
export const ANSWER_MESSAGES = 4;

/** A table as monospace, its columns padded. */
export function monospaceTable(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join(" | ")
      .trimEnd();
  return [
    "```",
    line(columns),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map(line),
    "```",
  ].join("\n");
}

/** Split text at paragraphs, then lines, then hard, into pieces of `limit` at most. */
export function splitText(text: string, limit: number = LIMITS.text): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = (piece: string, joiner: string) => {
    if (!current) current = piece;
    else if (current.length + joiner.length + piece.length <= limit)
      current = `${current}${joiner}${piece}`;
    else {
      pieces.push(current);
      current = piece;
    }
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length <= limit) {
      push(paragraph, "\n\n");
      continue;
    }
    for (const line of paragraph.split("\n")) {
      if (line.length <= limit) {
        push(line, "\n");
        continue;
      }
      for (let at = 0; at < line.length; at += limit)
        push(line.slice(at, at + limit), "");
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** An answer as the number writes it: its messages, and a document when it needs one. */
export type RenderedAnswer = Readonly<{
  messages: string[];
  document?: Readonly<{ filename: string; text: string; caption: string }>;
}>;

export function renderAnswer(answer: string): RenderedAnswer {
  const parts = answerParts(answer);
  const citations = parts.filter((part) => part.kind === "citation");
  const numbered = new Map(citations.map((one, index) => [one.url, index + 1]));
  let wide = false;
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.kind === "text")
      blocks.push(
        whatsappFormat(
          part.text.replace(
            /\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]{1,2000})\)/g,
            (_, title: string, url: string) =>
              `${title} [${numbered.get(url)}]`,
          ),
        ),
      );
    else if (part.kind === "table") {
      if (part.columns.length <= TABLE_COLUMNS)
        blocks.push(monospaceTable(part.columns, part.rows));
      else {
        wide = true;
        blocks.push(
          `_A table of ${part.columns.length} columns: in the document below._`,
        );
      }
    }
  }
  if (citations.length)
    blocks.push(
      citations
        .map((one, index) => `[${index + 1}] ${one.title}: ${one.url}`)
        .join("\n"),
    );
  const text = blocks.join("\n\n").trim();
  const pieces = text ? splitText(text) : [];
  const over = pieces.length > ANSWER_MESSAGES;
  const messages = pieces.slice(0, ANSWER_MESSAGES);
  if (over) {
    const last = messages.length - 1;
    const tail = `\n\n${WORDS.inDocument}`;
    const kept = messages[last] ?? "";
    messages[last] =
      kept.length + tail.length <= LIMITS.text
        ? `${kept}${tail}`
        : `${kept.slice(0, LIMITS.text - tail.length)}${tail}`;
  }
  return {
    messages,
    ...(over || wide
      ? {
          document: {
            caption: WORDS.wholeAnswer,
            filename: "answer.md",
            text: answer,
          },
        }
      : {}),
  };
}

/** What a list row or a button may say, cut to its limit. */
export function cut(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** What a pressed option's id starts with; its index follows. */
export const ASK_CHOICE = "ask:";

/**
 * A question the turn ends on: up to three short options as reply buttons,
 * up to ten as a list, otherwise words with numbered options (the person
 * answers in words). `undefined` for a question answered in Datalayer only
 * (a file, a form).
 */
export function renderQuestion(question: AskQuestion): Outgoing | undefined {
  if (question.kind === "file" || question.kind === "form") return undefined;
  const prompt = question.prompt.trim();
  const options = question.options ?? [];
  if (question.kind === "choice" && prompt.length <= LIMITS.interactiveBody) {
    if (
      options.length > 0 &&
      options.length <= LIMITS.buttons &&
      options.every((one) => one.length <= LIMITS.buttonTitle)
    )
      return {
        body: prompt,
        buttons: options.map((title, index) => ({
          id: `${ASK_CHOICE}${index}`,
          title,
        })),
        type: "buttons",
      };
    if (options.length > 0 && options.length <= LIMITS.listRows)
      return {
        body: prompt,
        label: "Choose",
        rows: options.map((title, index) => ({
          id: `${ASK_CHOICE}${index}`,
          title: cut(title, LIMITS.rowTitle),
          ...(title.length > LIMITS.rowTitle
            ? { description: cut(title, LIMITS.rowDescription) }
            : {}),
        })),
        type: "list",
      };
  }
  const listed = options.length
    ? `\n\n${options.map((one, index) => `${index + 1}. ${one}`).join("\n")}\n\nAnswer in your own words.`
    : "";
  return { text: cut(`${prompt}${listed}`, LIMITS.text), type: "text" };
}

/** The option a pressed button or row chose, or nothing. */
export function optionOf(
  replyId: string | undefined,
  options: readonly string[] | undefined,
): string | undefined {
  if (!replyId?.startsWith(ASK_CHOICE) || !options) return undefined;
  const index = Number(replyId.slice(ASK_CHOICE.length));
  return Number.isInteger(index) ? options[index] : undefined;
}

/** A button opening a page of Datalayer's, with a sentence above it. */
export function openButton(
  body: string,
  url: string,
  label: string = WORDS.openLabel,
): Outgoing {
  return {
    body: cut(body, LIMITS.interactiveBody),
    label,
    type: "cta",
    url,
  };
}

/** The progress message of a long turn, with its Stop button. */
export const STOP_ID = "turn:stop";
export function progressMessage(status: string): Outgoing {
  return {
    body: cut(
      status ? `${WORDS.stillWorking} ${status}` : WORDS.stillWorking,
      LIMITS.interactiveBody,
    ),
    buttons: [{ id: STOP_ID, title: "Stop" }],
    type: "buttons",
  };
}

// The approval card (§ approvals).

const ACTION_WORDS: Record<ApprovalPresentation["action_class"], string> = {
  delete: "delete something",
  execute: "run something",
  financial: "move money",
  publish: "publish something",
  read: "read something",
  send: "send something",
  unknown: "use a tool",
  write: "change something",
};

/** A pressed approval button's id: `ap:<choice>:<approval id>`. */
export const APPROVAL_PRESS = "ap:";
export const APPROVAL_CHOICES = [
  "approve",
  "reject",
  "more",
  "yes-approve",
  "yes-reject",
  "no",
] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

export function approvalPressId(
  choice: ApprovalChoice,
  approvalId: string,
): string {
  return `${APPROVAL_PRESS}${choice}:${approvalId}`;
}

/** The approval a pressed button names, and what was chosen. */
export function approvalPressOf(
  replyId: string | undefined,
): { choice: ApprovalChoice; approvalId: string } | undefined {
  if (!replyId?.startsWith(APPROVAL_PRESS)) return undefined;
  const rest = replyId.slice(APPROVAL_PRESS.length);
  const colon = rest.indexOf(":");
  const choice = rest.slice(0, colon) as ApprovalChoice;
  const approvalId = rest.slice(colon + 1);
  if (colon < 0 || !APPROVAL_CHOICES.includes(choice) || !approvalId)
    return undefined;
  return { approvalId, choice };
}

/** `pap_confirm`, as the gateway names it with or without a prefix. */
const PAP_CONFIRM = /(^|[_.:\-/])pap_confirm$/;
export const isPapConfirm = (toolName: string): boolean =>
  PAP_CONFIRM.test(toolName);

/** What is shown of an action: the renderer's fields, else the presentation's, else its arguments. */
export function shownFields(
  presentation: ApprovalPresentation,
): Array<{ label: string; value: string }> {
  const typed = renderApproval(presentation);
  if (typed.fields.length > 0) return [...typed.fields];
  if (presentation.fields.length > 0)
    return presentation.fields.map(({ label, value }) => ({ label, value }));
  return Object.entries(presentation.arguments).map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/** The company a PAP operation is at, as the presentation names it. */
function companyOf(presentation: ApprovalPresentation): string {
  const field = presentation.fields.find((one) =>
    /^(company|domain)$/i.test(one.name),
  );
  return field?.value || "the company";
}

/** The revision of a PAP operation, exactly as the presentation carries it. */
export function revisionOf(
  presentation: ApprovalPresentation,
): string | undefined {
  const value = presentation.arguments.revision;
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : undefined;
}

/** The card's age, in its footer. */
function ageOf(presentation: ApprovalPresentation, now: number): string {
  const created = presentation.created_at
    ? Date.parse(presentation.created_at)
    : Number.NaN;
  if (!Number.isFinite(created)) return "Waiting for your decision";
  const minutes = Math.max(0, Math.round((now - created) / 60_000));
  return minutes < 1
    ? "Asked just now"
    : minutes < 60
      ? `Asked ${minutes} min ago`
      : `Asked ${Math.round(minutes / 60)} h ago`;
}

/** The card's words: the application, the action, every material value whole. */
export function cardBody(
  presentation: ApprovalPresentation,
  appName: string,
): string {
  const fields = shownFields(presentation)
    .map(({ label, value }) => `*${label}:* ${value || "(empty)"}`)
    .join("\n");
  if (isPapConfirm(presentation.tool_name)) {
    const revision = revisionOf(presentation);
    return [
      `*${appName}* asks you to confirm an operation at ${companyOf(presentation)}${revision !== undefined ? `, exactly revision ${revision}` : ""}.`,
      fields,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    `*${appName}* asks to ${ACTION_WORDS[presentation.action_class]}: \`${presentation.tool_name}\``,
    fields,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The card for an approval: *Approve*, *Reject*, *Show more* when a host
 * may decide it (`hostMayDecide`), a renderer shows it whole
 * (`renderApproval`) and it fits 1,024 characters; else *Review in
 * Datalayer* only, through `reviewUrl`.
 */
export function approvalCard(
  presentation: ApprovalPresentation,
  input: Readonly<{
    appName: string;
    now: number;
    reviewUrl: () => Promise<string>;
  }>,
): Promise<{ message: Outgoing; decidable: boolean }> {
  const body = cardBody(presentation, input.appName);
  const footer = ageOf(presentation, input.now);
  const decidable =
    hostMayDecide(presentation) &&
    renderApproval(presentation).complete &&
    body.length <= LIMITS.interactiveBody;
  if (decidable)
    return Promise.resolve({
      decidable,
      message: {
        body,
        buttons: [
          {
            id: approvalPressId("approve", presentation.approval_id),
            title: "Approve",
          },
          {
            id: approvalPressId("reject", presentation.approval_id),
            title: "Reject",
          },
          {
            id: approvalPressId("more", presentation.approval_id),
            title: "Show more",
          },
        ],
        footer,
        type: "buttons",
      },
    });
  return input.reviewUrl().then((url) => ({
    decidable,
    message: {
      ...openButton(
        body.length <= LIMITS.interactiveBody
          ? body
          : `*${input.appName}* asks for your decision on \`${presentation.tool_name}\`. It does not fit a WhatsApp message: review it in Datalayer.`,
        url,
        WORDS.reviewLabel,
      ),
      footer,
    } as Outgoing,
  }));
}

/** The second step: the action named again, with *Yes* and *No*. */
export function confirmStep(
  presentation: ApprovalPresentation,
  approve: boolean,
): Outgoing {
  const fields = shownFields(presentation)
    .slice(0, 3)
    .map(({ label, value }) => `${label}: ${value}`)
    .join("; ");
  const what = isPapConfirm(presentation.tool_name)
    ? `confirm at ${companyOf(presentation)}, revision ${revisionOf(presentation) ?? "?"}`
    : `\`${presentation.tool_name}\``;
  const verb = approve ? "Approve" : "Reject";
  const tail = approve ? " This cannot be undone." : "";
  const room =
    LIMITS.interactiveBody - verb.length - what.length - tail.length - 8;
  return {
    body: `${verb}: ${what}${fields ? ` (${cut(fields, Math.max(0, room))})` : ""}?${tail}`,
    buttons: [
      {
        id: approvalPressId(
          approve ? "yes-approve" : "yes-reject",
          presentation.approval_id,
        ),
        title: approve ? "Yes, approve" : "Yes, reject",
      },
      { id: approvalPressId("no", presentation.approval_id), title: "No" },
    ],
    type: "buttons",
  };
}

/** What a decision became, said as a new message (there is no edit). */
export function decidedWords(
  status: string,
  byYou: boolean,
  at: number,
): string {
  const time = new Date(at).toISOString().slice(11, 16);
  switch (status) {
    case "approved":
      return byYou ? `Approved by you at ${time} UTC.` : WORDS.decidedElsewhere;
    case "rejected":
    case "denied":
      return byYou ? `Rejected by you at ${time} UTC.` : WORDS.decidedElsewhere;
    case "expired":
      return WORDS.expired;
    default:
      return WORDS.decidedElsewhere;
  }
}

/**
 * A personal agent's sign-in at a company (PAP), as the gateway's
 * `pap_sign_in` answered it: a button to the company's page (Direct, or
 * Datalayer's own page for Mediated), or the code to enter with a button to
 * the page (Device). The page is the gateway's, reached through IAM's
 * one-use start link: never a token of the person's. `undefined` for a
 * result that is not a sign-in waiting for the person.
 */
export function renderPapSignIn(result: unknown): Outgoing[] | undefined {
  const waiting = readPapSignIn(result);
  if (!waiting) return undefined;
  if ("refused" in waiting)
    return [{ text: PAP_SIGN_IN_WORDS.refused, type: "text" }];
  return renderSignIn(waiting);
}

/**
 * A sign-in the runtime's `sign-in` semantic event carries, read already by
 * `readPapSignIn` (WA-42): shown as {@link renderPapSignIn} shows it. A page
 * that is not https is refused here too, never shown.
 */
export function renderSignIn(waiting: PapSignInWaiting): Outgoing[] {
  if (!/^https:\/\//.test(waiting.open))
    return [{ text: PAP_SIGN_IN_WORDS.refused, type: "text" }];
  const name = waiting.organization
    ? `${waiting.organization.name} (${waiting.organization.domain})`
    : (waiting.company ?? waiting.host);
  const until = waiting.expiresAt
    ? ` Until ${new Date(waiting.expiresAt).toISOString().slice(11, 16)} UTC.`
    : "";
  const needs = waiting.needs?.length
    ? ` ${PAP_SIGN_IN_WORDS.needs(waiting.needs)}`
    : "";
  if (waiting.mode === "device")
    return [
      openButton(
        `Sign in to ${name}: ${PAP_SIGN_IN_WORDS.device}\n\n${PAP_SIGN_IN_WORDS.code}: *${waiting.code ?? ""}*${until}${needs}`,
        waiting.open,
        cut(`Open ${waiting.host}`, LIMITS.ctaLabel),
      ),
    ];
  const words =
    waiting.mode === "mediated"
      ? PAP_SIGN_IN_WORDS.mediated
      : "Open the company's page through Datalayer and sign in there; write here again once you are back.";
  return [
    openButton(
      `Sign in to ${name}. ${words}${until}${needs}`,
      waiting.open,
      cut(
        `Sign in to ${waiting.organization?.name ?? waiting.company ?? waiting.host}`,
        LIMITS.ctaLabel,
      ),
    ),
  ];
}
