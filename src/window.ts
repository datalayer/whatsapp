import type { Clock } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import approvalWaiting from "../templates/datalayer_approval_waiting.json" with { type: "json" };
import linkReminder from "../templates/datalayer_link_reminder.json" with { type: "json" };
import turnDone from "../templates/datalayer_turn_done.json" with { type: "json" };
import type { Metrics } from "./observability.js";
import type {
  ChatKey,
  Hold,
  HoldKind,
  MessageCategory,
  WhatsAppStore,
} from "./store.js";

/**
 * The 24-hour customer service window, kept by design. Each message from
 * the person opens it for 24 hours; inside it the number says anything,
 * interactive messages included. Outside it only an approved template may
 * be sent: what would have been said is **held** (by reference, never its
 * content), and at most one notice goes to the person per 24 hours, a later
 * event joining the held ones without a second notice. The notice is one of
 * three utility templates naming the application only; the person's reply
 * reopens the window, and what was held is given back to be said then.
 *
 * No notice when the person wrote `stop` (with no answer running), nor for
 * a business account whose notice templates are not all approved as
 * utility: a rejected, paused, disabled or recategorized template pauses
 * every notice of that account. Never a marketing template; never the
 * answer's words in one.
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta's free tier: service messages a business number sends free each month. */
export const FREE_SERVICE_MESSAGES = 1000;

const templateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.literal("en"),
    category: z.literal("UTILITY"),
    components: z.tuple([
      z
        .object({
          type: z.literal("BODY"),
          // The application's name, and nothing of what it said.
          text: z
            .string()
            .max(1024)
            .refine(
              (text) => (text.match(/\{\{\d+\}\}/g) ?? []).join() === "{{1}}",
              "one parameter, the application's name",
            ),
          example: z.object({ body_text: z.tuple([z.tuple([z.string()])]) }),
        })
        .strict(),
      z
        .object({
          type: z.literal("BUTTONS"),
          buttons: z.tuple([
            z
              .object({
                type: z.literal("QUICK_REPLY"),
                text: z.string().min(1).max(25),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();

export type NoticeTemplate = z.infer<typeof templateSchema>;

/**
 * The notice for each kind of held thing, as created in each business
 * account at install (`templates/`, checked here when the service starts).
 */
export const TEMPLATES: Readonly<Record<HoldKind, NoticeTemplate>> = {
  approval: templateSchema.parse(approvalWaiting),
  delivery: templateSchema.parse(turnDone),
  link: templateSchema.parse(linkReminder),
};

export const TEMPLATE_NAMES = Object.values(TEMPLATES).map((one) => one.name);

/** What to do with something to say to a person. */
export type Route =
  /** Inside the window: say it now. */
  | Readonly<{ send: "now" }>
  /** Outside it: held, and this notice to send (a utility template). */
  | Readonly<{
      send: "notice";
      template: Readonly<{
        name: string;
        language: string;
        /** The body's one parameter: the application's name. */
        parameters: readonly [string];
      }>;
    }>
  /**
   * Outside it: held, no notice — one was sent within 24 hours (`joined`),
   * the person wrote `stop` (`stopped`), or the account's templates are not
   * all approved as utility (`paused`).
   */
  | Readonly<{ send: "held"; why: "joined" | "stopped" | "paused" }>
  /** No chat is kept for the person (never wrote, or kept past 30 days): nothing can reach them. */
  | Readonly<{ send: "unreachable" }>;

/** A template's status or category as Meta's webhooks say it. */
const statusUpdateSchema = z
  .object({
    event: z.string().min(1).max(64),
    message_template_name: z.string().min(1).max(512),
  })
  .loose();
const categoryUpdateSchema = z
  .object({
    message_template_name: z.string().min(1).max(512),
    new_category: z.string().min(1).max(64),
  })
  .loose();

/** The account fields that change a template, as the ingress hands them to the worker. */
export const TEMPLATE_FIELDS = [
  "message_template_status_update",
  "template_category_update",
] as const;

const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

export class WindowKeeper {
  constructor(
    readonly store: WhatsAppStore,
    readonly clock: Pick<Clock, "now">,
    readonly metrics: Metrics,
  ) {}

  /**
   * A message from the person: the window opens for 24 hours, and what was
   * held is given back, oldest first, to be said now.
   */
  async received(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Hold[]> {
    await this.store.recordInbound(key, at);
    return this.store.releaseHolds(key);
  }

  /** Whether the window is open now for this chat. */
  async open(key: ChatKey): Promise<boolean> {
    const chat = await this.store.chat(key);
    return Boolean(
      chat && this.clock.now() - chat.lastInboundAt.getTime() < WINDOW_MS,
    );
  }

  /**
   * Where something to say goes: now inside the window; outside it held,
   * with at most one notice per person per 24 hours.
   */
  async route(
    key: ChatKey,
    held: Readonly<{ kind: HoldKind; ref: string }>,
    application: string,
  ): Promise<Route> {
    const chat = await this.store.chat(key);
    if (!chat) return { send: "unreachable" };
    const now = this.clock.now();
    if (now - chat.lastInboundAt.getTime() < WINDOW_MS) {
      this.metrics.count("window", { kind: held.kind, window: "inside" });
      return { send: "now" };
    }
    this.metrics.count("window", { kind: held.kind, window: "outside" });
    if (await this.store.hold(key, held.kind, held.ref, new Date(now)))
      this.metrics.count("holds", { kind: held.kind });
    if (chat.noticesStopped) return { send: "held", why: "stopped" };
    if (await this.paused(chat.wabaId)) return { send: "held", why: "paused" };
    if (
      !(await this.store.claimNotice(
        key,
        new Date(now),
        new Date(now - WINDOW_MS),
      ))
    )
      return { send: "held", why: "joined" };
    const template = TEMPLATES[held.kind];
    this.metrics.count("notices", { template: template.name });
    return {
      send: "notice",
      template: {
        language: template.language,
        name: template.name,
        parameters: [application],
      },
    };
  }

  /** `stop` with no answer running: no more notices to this person. */
  async stop(key: ChatKey): Promise<boolean> {
    return this.store.stopNotices(key);
  }

  /** Whether the account's notices are paused: a template missing, not approved, or not utility. */
  async paused(wabaId: string): Promise<boolean> {
    const kept = new Map(
      (await this.store.templates(wabaId)).map((one) => [one.name, one]),
    );
    return TEMPLATE_NAMES.some((name) => {
      const one = kept.get(name);
      return !one || one.status !== "APPROVED" || one.category !== "UTILITY";
    });
  }

  /** The templates as created in an account at install, with Meta's answer. */
  async created(
    wabaId: string,
    name: string,
    status: string,
    category: string,
  ): Promise<void> {
    if (!TEMPLATE_NAMES.includes(name))
      throw new Error(`${name} is not one of the service's templates.`);
    await this.store.setTemplate(wabaId, name, { category, status });
  }

  /**
   * Meta's word on a template (`message_template_status_update`,
   * `template_category_update`): kept for the service's own templates,
   * other templates of the account ignored. Answers whether it was ours.
   */
  async templateChanged(
    wabaId: string,
    field: (typeof TEMPLATE_FIELDS)[number],
    value: unknown,
  ): Promise<boolean> {
    if (field === "message_template_status_update") {
      const update = statusUpdateSchema.parse(value);
      if (!TEMPLATE_NAMES.includes(update.message_template_name)) return false;
      await this.store.setTemplate(wabaId, update.message_template_name, {
        status: update.event.toUpperCase(),
      });
      return true;
    }
    const update = categoryUpdateSchema.parse(value);
    if (!TEMPLATE_NAMES.includes(update.message_template_name)) return false;
    await this.store.setTemplate(wabaId, update.message_template_name, {
      category: update.new_category.toUpperCase(),
    });
    return true;
  }

  /** A message the number sent: counted by month and category, as Meta's meter counts it. */
  async sent(phoneNumberId: string, category: MessageCategory): Promise<void> {
    this.metrics.count("messages", { category });
    await this.store.countMessage(
      phoneNumberId,
      monthOf(new Date(this.clock.now())),
      category,
    );
  }

  /** This month's messages of a number, and what is left of the free tier. */
  async usage(phoneNumberId: string): Promise<
    Readonly<{
      month: string;
      service: number;
      utility: number;
      freeServiceLeft: number;
    }>
  > {
    const month = monthOf(new Date(this.clock.now()));
    const counts = await this.store.messageCounts(phoneNumberId, month);
    return {
      ...counts,
      freeServiceLeft: Math.max(0, FREE_SERVICE_MESSAGES - counts.service),
      month,
    };
  }
}
