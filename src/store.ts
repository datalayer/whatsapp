import { createHash } from "node:crypto";

/**
 * What the service keeps, behind one interface: PostgreSQL in production
 * (`postgres-store.ts`), memory in development and tests. Each later piece
 * of the service adds its rows here.
 */

/** What Meta says became of a message the number sent, in order. */
export const MESSAGE_STATUSES = [
  "sent",
  "delivered",
  "read",
  "played",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * A status's rank: a later status replaces an earlier one, never the
 * reverse (Meta sends them out of order and more than once). `failed` ends
 * a message whatever came before.
 */
export const STATUS_RANK: Readonly<Record<MessageStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
  failed: 5,
};

/** One status of one sent message, as the ingress reads it from a webhook. */
export type StatusUpdate = Readonly<{
  wamid: string;
  phoneNumberId: string;
  status: MessageStatus;
  /** When Meta says it happened. */
  at: Date;
  /** Meta's error code, for `failed`. */
  errorCode?: number;
}>;

/**
 * A message id as kept: its SHA-256. Meta's message ids have been seen to
 * embed the sender's or recipient's phone number, so a claim or a status
 * keeps the hash, never the id.
 */
export const wamidHash = (wamid: string): string =>
  createHash("sha256").update(wamid).digest("hex");

/** A sent message's furthest status, found by its id; the id itself is not kept. */
export type StatusRow = Readonly<{
  phoneNumberId: string;
  status: MessageStatus;
  at: Date;
  errorCode?: number;
}>;

/** A 1:1 chat: one person (their BSUID) and one business number. */
export type ChatKey = Readonly<{ phoneNumberId: string; userId: string }>;

/**
 * What the service keeps of a chat: when the person last wrote (the
 * 24-hour window), its session's generation (`start over` and a switch of
 * application open a new one), the application the person chose, and the
 * window's notices. Never a phone number, never a message.
 */
export type Chat = ChatKey &
  Readonly<{
    wabaId: string;
    lastInboundAt: Date;
    generation: number;
    /** The deployment the person chose with `app`; the installation's default otherwise. */
    applicationId?: string;
    /** `stop` with no turn running: no more notices to this person. */
    noticesStopped: boolean;
    /** The last notice sent outside the window. */
    lastNoticeAt?: Date;
  }>;

/** What waits for the window to reopen: a reference, never content. */
export type HoldKind = "delivery" | "approval" | "link";
export type Hold = Readonly<{ kind: HoldKind; ref: string; heldAt: Date }>;

/** A notice template of a business account, as Meta last said it. */
export type TemplateRow = Readonly<{
  name: string;
  status: string;
  category: string;
}>;

/** What a number sent: free-form service messages, and utility templates. */
export type MessageCategory = "service" | "utility";

/** How long each kind of row is kept (`retain`). */
export const RETENTION = {
  /** A chat and what it holds: 30 days after the person's last message. */
  chatMs: 30 * 24 * 60 * 60 * 1000,
  /** A sent message's status. */
  statusMs: 30 * 24 * 60 * 60 * 1000,
  /** A claim: Meta retries a webhook for 7 days, so a day more. */
  claimMs: 8 * 24 * 60 * 60 * 1000,
  /** A job that failed five times. */
  deadJobMs: 14 * 24 * 60 * 60 * 1000,
  /** Quota counts, which name a person: their hour, and a day. */
  usageMs: 24 * 60 * 60 * 1000,
} as const;

/** What `retain` deleted, by table. */
export type Retained = Record<string, number>;

export interface WhatsAppStore {
  /** Keep a message's furthest status; idempotent, and never a step back. */
  applyStatus(update: StatusUpdate): Promise<void>;
  status(wamid: string): Promise<StatusRow | undefined>;
  /**
   * A message from the person: the chat made if new, its last inbound time
   * moved forward (never back: Meta's webhooks arrive out of order).
   */
  recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat>;
  chat(key: ChatKey): Promise<Chat | undefined>;
  /**
   * A new generation of the chat's session: `start over`, or a switch to
   * `applicationId`. Answers the new generation; throws for a chat the
   * service never saw.
   */
  startOver(key: ChatKey, applicationId?: string): Promise<number>;
  /** Hold a reference for the chat; `false` when it is held already. */
  hold(key: ChatKey, kind: HoldKind, ref: string, at: Date): Promise<boolean>;
  /** What the chat holds, oldest first. */
  holds(key: ChatKey): Promise<Hold[]>;
  /** Take what the chat holds, oldest first: each hold given out once. */
  releaseHolds(key: ChatKey): Promise<Hold[]>;
  /**
   * Take the chat's notice: `true`, and the notice time set to `at`, only
   * when notices are not stopped and none was sent after `notBefore`.
   */
  claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean>;
  /** No more notices to this person on this number; `false` for an unknown chat. */
  stopNotices(key: ChatKey): Promise<boolean>;
  setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void>;
  templates(wabaId: string): Promise<TemplateRow[]>;
  countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void>;
  messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>>;
  /**
   * `forget`: every row naming the person (their BSUID) deleted, on every
   * number of the business — their chats, what those hold, their queued
   * and dead jobs (the one running now is deleted when it ends), their
   * quota counts. Claims and statuses never name them. Answers how many rows.
   */
  forget(userId: string): Promise<number>;
  /** Delete what is past its keeping (`RETENTION`), as of `now`. */
  retain(now: Date): Promise<Retained>;
}

const chatKeyOf = (key: ChatKey): string =>
  JSON.stringify([key.phoneNumberId, key.userId]);

/** The store in memory: development and tests only. */
export class MemoryStore implements WhatsAppStore {
  readonly #statuses = new Map<string, StatusRow>();
  readonly #chats = new Map<string, Chat>();
  readonly #holds = new Map<string, (Hold & ChatKey)[]>();
  readonly #templates = new Map<string, Map<string, TemplateRow>>();
  readonly #counts = new Map<string, number>();

  async applyStatus(update: StatusUpdate): Promise<void> {
    const kept = this.#statuses.get(wamidHash(update.wamid));
    if (kept && STATUS_RANK[kept.status] >= STATUS_RANK[update.status]) return;
    this.#statuses.set(wamidHash(update.wamid), {
      at: update.at,
      phoneNumberId: update.phoneNumberId,
      status: update.status,
      ...(update.errorCode !== undefined
        ? { errorCode: update.errorCode }
        : {}),
    });
  }

  async status(wamid: string): Promise<StatusRow | undefined> {
    return this.#statuses.get(wamidHash(wamid));
  }

  async recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat> {
    const kept = this.#chats.get(chatKeyOf(key));
    const chat: Chat = kept
      ? {
          ...kept,
          lastInboundAt:
            kept.lastInboundAt.getTime() >= at.getTime()
              ? kept.lastInboundAt
              : at,
        }
      : {
          generation: 0,
          lastInboundAt: at,
          noticesStopped: false,
          phoneNumberId: key.phoneNumberId,
          userId: key.userId,
          wabaId: key.wabaId,
        };
    this.#chats.set(chatKeyOf(key), chat);
    return chat;
  }

  async chat(key: ChatKey): Promise<Chat | undefined> {
    return this.#chats.get(chatKeyOf(key));
  }

  async startOver(key: ChatKey, applicationId?: string): Promise<number> {
    const kept = this.#chats.get(chatKeyOf(key));
    if (!kept) throw new Error("startOver names a chat the service never saw.");
    const generation = kept.generation + 1;
    this.#chats.set(chatKeyOf(key), {
      ...kept,
      generation,
      ...(applicationId !== undefined ? { applicationId } : {}),
    });
    return generation;
  }

  async hold(
    key: ChatKey,
    kind: HoldKind,
    ref: string,
    at: Date,
  ): Promise<boolean> {
    const held = this.#holds.get(chatKeyOf(key)) ?? [];
    if (held.some((one) => one.kind === kind && one.ref === ref)) return false;
    held.push({ ...key, heldAt: at, kind, ref });
    this.#holds.set(chatKeyOf(key), held);
    return true;
  }

  async holds(key: ChatKey): Promise<Hold[]> {
    return (this.#holds.get(chatKeyOf(key)) ?? []).map(
      ({ heldAt, kind, ref }) => ({ heldAt, kind, ref }),
    );
  }

  async releaseHolds(key: ChatKey): Promise<Hold[]> {
    const held = await this.holds(key);
    this.#holds.delete(chatKeyOf(key));
    return held;
  }

  async claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean> {
    const chat = this.#chats.get(chatKeyOf(key));
    if (!chat || chat.noticesStopped) return false;
    if (chat.lastNoticeAt && chat.lastNoticeAt.getTime() > notBefore.getTime())
      return false;
    this.#chats.set(chatKeyOf(key), { ...chat, lastNoticeAt: at });
    return true;
  }

  async stopNotices(key: ChatKey): Promise<boolean> {
    const chat = this.#chats.get(chatKeyOf(key));
    if (!chat) return false;
    this.#chats.set(chatKeyOf(key), { ...chat, noticesStopped: true });
    return true;
  }

  async setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void> {
    const account =
      this.#templates.get(wabaId) ?? new Map<string, TemplateRow>();
    const kept = account.get(name);
    if (!kept && (!change.status || !change.category))
      throw new Error(`A new template ${name} needs its status and category.`);
    account.set(name, {
      category: change.category ?? kept?.category ?? "",
      name,
      status: change.status ?? kept?.status ?? "",
    });
    this.#templates.set(wabaId, account);
  }

  async templates(wabaId: string): Promise<TemplateRow[]> {
    return [...(this.#templates.get(wabaId)?.values() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void> {
    const key = JSON.stringify([phoneNumberId, month, category]);
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  async messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>> {
    const of = (category: MessageCategory) =>
      this.#counts.get(JSON.stringify([phoneNumberId, month, category])) ?? 0;
    return { service: of("service"), utility: of("utility") };
  }

  async forget(userId: string): Promise<number> {
    let count = 0;
    for (const [key, chat] of this.#chats)
      if (chat.userId === userId) {
        this.#chats.delete(key);
        count += 1;
      }
    for (const [key, held] of this.#holds)
      if (held[0]?.userId === userId) {
        this.#holds.delete(key);
        count += held.length;
      }
    return count;
  }

  async retain(now: Date): Promise<Retained> {
    const before = (ms: number) => now.getTime() - ms;
    const out: Retained = { chats: 0, holds: 0, statuses: 0 };
    for (const [key, chat] of this.#chats)
      if (chat.lastInboundAt.getTime() < before(RETENTION.chatMs)) {
        this.#chats.delete(key);
        out.chats = (out.chats ?? 0) + 1;
        out.holds = (out.holds ?? 0) + (this.#holds.get(key)?.length ?? 0);
        this.#holds.delete(key);
      }
    for (const [key, held] of this.#holds) {
      const kept = held.filter(
        (one) => one.heldAt.getTime() >= before(RETENTION.chatMs),
      );
      out.holds = (out.holds ?? 0) + held.length - kept.length;
      if (kept.length) this.#holds.set(key, kept);
      else this.#holds.delete(key);
    }
    for (const [key, status] of this.#statuses)
      if (status.at.getTime() < before(RETENTION.statusMs)) {
        this.#statuses.delete(key);
        out.statuses = (out.statuses ?? 0) + 1;
      }
    return out;
  }
}
