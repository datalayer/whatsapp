import { describe, expect, it } from "vitest";

import {
  FREE_SERVICE_MESSAGES,
  TEMPLATE_NAMES,
  TEMPLATES,
  WindowKeeper,
} from "../../src/window.js";
import { Metrics } from "../../src/observability.js";
import {
  ALICE,
  capturingLogger,
  PHONE_NUMBER_ID,
  WABA,
} from "../support/meta.js";
import { storeCases } from "../support/stores.js";

/**
 * The 24-hour window on each store, with a fake clock: inside it said now,
 * outside it held with one notice per 24 hours, given back on the reply;
 * notices paused by a template Meta rejected or recategorized, and stopped
 * by the person; the month's messages counted.
 */

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 22, 12);

describe("the notice templates", () => {
  it("are three utility templates whose words name the application only", () => {
    expect(TEMPLATE_NAMES).toEqual([
      "datalayer_approval_waiting",
      "datalayer_turn_done",
      "datalayer_link_reminder",
    ]);
    for (const template of Object.values(TEMPLATES)) {
      expect(template.category).toBe("UTILITY");
      const [body, buttons] = template.components;
      expect(body.text.match(/\{\{\d+\}\}/g)).toEqual(["{{1}}"]);
      // Meta refuses a body that starts or ends with a variable (error 100, subcode 2388299).
      expect(body.text.trim()).not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}[.!?]?$/);
      expect(buttons.buttons).toHaveLength(1);
    }
    expect(TEMPLATES.delivery.components[0].text).toBe(
      "Your request to {{1}} is done. Reply to see the answer.",
    );
  });
});

describe.each(storeCases())("the window on $name", ({ store }) => {
  const chat = { phoneNumberId: PHONE_NUMBER_ID, userId: ALICE, wabaId: WABA };
  const setup = async (templates = true) => {
    const clock = { at: START, now: () => clock.at };
    const metrics = new Metrics(capturingLogger().logger);
    const keeper = new WindowKeeper(store(), clock, metrics);
    if (templates)
      for (const name of TEMPLATE_NAMES)
        await keeper.created(WABA, name, "APPROVED", "UTILITY");
    await keeper.received(chat, new Date(START));
    return { clock, keeper, kept: keeper.store, metrics };
  };
  const notice = (name: string) => ({
    send: "notice",
    template: { language: "en", name, parameters: ["Help Desk"] },
  });

  it("says a delivery now at 23 hours, holds it at 25 with one notice, and gives it back on the reply", async () => {
    const { clock, keeper, kept } = await setup();
    clock.at = START + 23 * HOUR;
    expect(await keeper.open(chat)).toBe(true);
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-1" }, "Help Desk"),
    ).toEqual({ send: "now" });
    expect(await kept.holds(chat)).toEqual([]);

    clock.at = START + 25 * HOUR;
    expect(await keeper.open(chat)).toBe(false);
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-2" }, "Help Desk"),
    ).toEqual(notice("datalayer_turn_done"));
    expect((await kept.holds(chat)).map((one) => one.ref)).toEqual(["dl-2"]);

    // The reply (the notice's button is a message) reopens the window.
    clock.at = START + 26 * HOUR;
    const given = await keeper.received(chat, new Date(clock.at));
    expect(given.map(({ kind, ref }) => ({ kind, ref }))).toEqual([
      { kind: "delivery", ref: "dl-2" },
    ]);
    expect(await kept.holds(chat)).toEqual([]);
    expect(await keeper.received(chat, new Date(clock.at))).toEqual([]);
    expect(await keeper.open(chat)).toBe(true);
  });

  it("counts sends inside and outside the window, holds and notices", async () => {
    const { clock, keeper, metrics } = await setup();
    await keeper.route(chat, { kind: "delivery", ref: "dl-1" }, "Help Desk");
    clock.at = START + 25 * HOUR;
    await keeper.route(chat, { kind: "delivery", ref: "dl-2" }, "Help Desk");
    await keeper.route(chat, { kind: "approval", ref: "ap-1" }, "Help Desk");
    await keeper.route(chat, { kind: "approval", ref: "ap-1" }, "Help Desk");
    expect(
      metrics.total("window", { kind: "delivery", window: "inside" }),
    ).toBe(1);
    expect(
      metrics.total("window", { kind: "approval", window: "outside" }),
    ).toBe(2);
    expect(metrics.total("holds", { kind: "approval" })).toBe(1);
    expect(metrics.total("notices", { template: "datalayer_turn_done" })).toBe(
      1,
    );
  });

  it("joins a second event to the first notice, and notices again only after 24 hours", async () => {
    const { clock, keeper, kept } = await setup();
    clock.at = START + 25 * HOUR;
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-1" }, "Help Desk"),
    ).toEqual(notice("datalayer_turn_done"));
    clock.at = START + 30 * HOUR;
    expect(
      await keeper.route(chat, { kind: "approval", ref: "ap-1" }, "Help Desk"),
    ).toEqual({ send: "held", why: "joined" });
    // The same reference again is held once.
    expect(
      await keeper.route(chat, { kind: "approval", ref: "ap-1" }, "Help Desk"),
    ).toEqual({ send: "held", why: "joined" });
    clock.at = START + 48 * HOUR;
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-2" }, "Help Desk"),
    ).toEqual({ send: "held", why: "joined" });
    clock.at = START + 49 * HOUR;
    expect(
      await keeper.route(chat, { kind: "approval", ref: "ap-2" }, "Help Desk"),
    ).toEqual(notice("datalayer_approval_waiting"));
    expect(
      (await kept.holds(chat)).map(({ kind, ref }) => `${kind}:${ref}`),
    ).toEqual([
      "delivery:dl-1",
      "approval:ap-1",
      "delivery:dl-2",
      "approval:ap-2",
    ]);
    expect(
      (await keeper.received(chat, new Date(clock.at))).map((one) => one.ref),
    ).toEqual(["dl-1", "ap-1", "dl-2", "ap-2"]);
  });

  it("pauses every notice of the account while a template is rejected or recategorized", async () => {
    const { clock, keeper, kept } = await setup();
    clock.at = START + 25 * HOUR;
    expect(
      await keeper.templateChanged(WABA, "message_template_status_update", {
        event: "REJECTED",
        message_template_id: 1,
        message_template_language: "en",
        message_template_name: "datalayer_link_reminder",
        reason: "INCORRECT_CATEGORY",
      }),
    ).toBe(true);
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-1" }, "Help Desk"),
    ).toEqual({ send: "held", why: "paused" });
    expect(
      await keeper.templateChanged(WABA, "message_template_status_update", {
        event: "APPROVED",
        message_template_name: "datalayer_link_reminder",
      }),
    ).toBe(true);
    expect(
      await keeper.templateChanged(WABA, "template_category_update", {
        message_template_name: "datalayer_turn_done",
        new_category: "MARKETING",
        previous_category: "UTILITY",
      }),
    ).toBe(true);
    expect(await keeper.paused(WABA)).toBe(true);
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-2" }, "Help Desk"),
    ).toEqual({ send: "held", why: "paused" });
    await keeper.templateChanged(WABA, "template_category_update", {
      message_template_name: "datalayer_turn_done",
      new_category: "UTILITY",
    });
    expect(await keeper.paused(WABA)).toBe(false);
    // Held while paused: given back with the next, which notices.
    expect(
      await keeper.route(chat, { kind: "delivery", ref: "dl-3" }, "Help Desk"),
    ).toEqual(notice("datalayer_turn_done"));
    expect((await kept.holds(chat)).map((one) => one.ref)).toEqual([
      "dl-1",
      "dl-2",
      "dl-3",
    ]);
    // Another template of the business is not this service's to watch.
    expect(
      await keeper.templateChanged(WABA, "message_template_status_update", {
        event: "REJECTED",
        message_template_name: "summer_sale",
      }),
    ).toBe(false);
    expect(await keeper.paused(WABA)).toBe(false);
  });

  it("pauses notices of an account whose templates were never created", async () => {
    const { clock, keeper } = await setup(false);
    clock.at = START + 25 * HOUR;
    expect(
      await keeper.route(chat, { kind: "link", ref: "link" }, "Help Desk"),
    ).toEqual({ send: "held", why: "paused" });
    await expect(
      keeper.created(WABA, "summer_sale", "APPROVED", "MARKETING"),
    ).rejects.toThrow(/not one of the service's templates/);
  });

  it("sends no notice to a person who wrote stop, and still holds", async () => {
    const { clock, keeper, kept } = await setup();
    expect(await keeper.stop(chat)).toBe(true);
    clock.at = START + 25 * HOUR;
    expect(
      await keeper.route(chat, { kind: "approval", ref: "ap-1" }, "Help Desk"),
    ).toEqual({ send: "held", why: "stopped" });
    expect((await kept.holds(chat)).map((one) => one.ref)).toEqual(["ap-1"]);
    expect(
      await keeper.stop({ phoneNumberId: PHONE_NUMBER_ID, userId: "US.0" }),
    ).toBe(false);
  });

  it("reaches no one whose chat is not kept, and holds nothing for them", async () => {
    const { keeper, kept } = await setup();
    const stranger = { phoneNumberId: PHONE_NUMBER_ID, userId: "US.99" };
    expect(
      await keeper.route(
        stranger,
        { kind: "delivery", ref: "dl-1" },
        "Help Desk",
      ),
    ).toEqual({ send: "unreachable" });
    expect(await kept.holds(stranger)).toEqual([]);
  });

  it("never moves the window back on a late webhook", async () => {
    const { clock, keeper } = await setup();
    await keeper.received(chat, new Date(START - 30 * HOUR));
    clock.at = START + 23 * HOUR;
    expect(await keeper.open(chat)).toBe(true);
  });

  it("counts the month's messages by category against the free tier", async () => {
    const { clock, keeper } = await setup();
    for (let n = 0; n < 3; n++) await keeper.sent(PHONE_NUMBER_ID, "service");
    await keeper.sent(PHONE_NUMBER_ID, "utility");
    expect(await keeper.usage(PHONE_NUMBER_ID)).toEqual({
      freeServiceLeft: FREE_SERVICE_MESSAGES - 3,
      month: "2026-10",
      service: 3,
      utility: 1,
    });
    clock.at = Date.UTC(2026, 10, 1);
    expect(await keeper.usage(PHONE_NUMBER_ID)).toEqual({
      freeServiceLeft: FREE_SERVICE_MESSAGES,
      month: "2026-11",
      service: 0,
      utility: 0,
    });
  });
});
