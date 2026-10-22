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

export interface WhatsAppStore {
  /** Keep a message's furthest status; idempotent, and never a step back. */
  applyStatus(update: StatusUpdate): Promise<void>;
  status(wamid: string): Promise<StatusRow | undefined>;
}

/** The store in memory: development and tests only. */
export class MemoryStore implements WhatsAppStore {
  readonly #statuses = new Map<string, StatusRow>();

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
}
