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

export type StatusRow = Readonly<{
  wamid: string;
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
}

const chatKeyOf = (key: ChatKey): string =>
  JSON.stringify([key.phoneNumberId, key.userId]);

/** The store in memory: development and tests only. */
export class MemoryStore implements WhatsAppStore {
  readonly #statuses = new Map<string, StatusRow>();
  readonly #chats = new Map<string, Chat>();

  async applyStatus(update: StatusUpdate): Promise<void> {
    const kept = this.#statuses.get(update.wamid);
    if (kept && STATUS_RANK[kept.status] >= STATUS_RANK[update.status]) return;
    this.#statuses.set(update.wamid, {
      at: update.at,
      phoneNumberId: update.phoneNumberId,
      status: update.status,
      wamid: update.wamid,
      ...(update.errorCode !== undefined
        ? { errorCode: update.errorCode }
        : {}),
    });
  }

  async status(wamid: string): Promise<StatusRow | undefined> {
    return this.#statuses.get(wamid);
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
}
