import type { Queryable } from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  STATUS_RANK,
  type Chat,
  type ChatKey,
  type Hold,
  type HoldKind,
  type MessageCategory,
  type MessageStatus,
  type Retained,
  RETENTION,
  type TemplateRow,
  type StatusRow,
  type StatusUpdate,
  type WhatsAppStore,
  wamidHash,
} from "./store.js";

type ChatRow = {
  phone_number_id: string;
  user_id: string;
  waba_id: string;
  last_inbound_at: Date;
  generation: number;
  application_id: string | null;
  notices_stopped: boolean;
  last_notice_at: Date | null;
};

const CHAT_COLUMNS = `phone_number_id, user_id, waba_id, last_inbound_at, generation,
  application_id, notices_stopped, last_notice_at`;

function chatOf(row: ChatRow): Chat {
  return {
    generation: row.generation,
    lastInboundAt: row.last_inbound_at,
    noticesStopped: row.notices_stopped,
    phoneNumberId: row.phone_number_id,
    userId: row.user_id,
    wabaId: row.waba_id,
    ...(row.application_id !== null
      ? { applicationId: row.application_id }
      : {}),
    ...(row.last_notice_at !== null
      ? { lastNoticeAt: row.last_notice_at }
      : {}),
  };
}

type HoldRow = { kind: HoldKind; ref: string; held_at: Date };

const holdOf = (row: HoldRow): Hold => ({
  heldAt: row.held_at,
  kind: row.kind,
  ref: row.ref,
});

/** The store on PostgreSQL (`migrations/`), the service's in production. */
export class PostgresStore implements WhatsAppStore {
  constructor(readonly database: Queryable) {}

  async applyStatus(update: StatusUpdate): Promise<void> {
    // One statement: a concurrent, lower status loses to the row's rank.
    await this.database.query(
      `INSERT INTO whatsapp_message_status
         (wamid_hash, phone_number_id, status, status_rank, error_code, status_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (wamid_hash) DO UPDATE SET
         status = EXCLUDED.status,
         status_rank = EXCLUDED.status_rank,
         error_code = EXCLUDED.error_code,
         status_at = EXCLUDED.status_at,
         updated_at = now()
       WHERE whatsapp_message_status.status_rank < EXCLUDED.status_rank`,
      [
        wamidHash(update.wamid),
        update.phoneNumberId,
        update.status,
        STATUS_RANK[update.status],
        update.errorCode ?? null,
        update.at,
      ],
    );
  }

  async status(wamid: string): Promise<StatusRow | undefined> {
    const { rows } = await this.database.query<{
      phone_number_id: string;
      status: MessageStatus;
      error_code: number | null;
      status_at: Date;
    }>(
      `SELECT phone_number_id, status, error_code, status_at
         FROM whatsapp_message_status WHERE wamid_hash = $1`,
      [wamidHash(wamid)],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      at: row.status_at,
      phoneNumberId: row.phone_number_id,
      status: row.status,
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    };
  }

  async recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat> {
    const { rows } = await this.database.query<ChatRow>(
      `INSERT INTO whatsapp_chat (phone_number_id, user_id, waba_id, last_inbound_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number_id, user_id) DO UPDATE SET
         last_inbound_at = GREATEST(whatsapp_chat.last_inbound_at, EXCLUDED.last_inbound_at),
         updated_at = now()
       RETURNING ${CHAT_COLUMNS}`,
      [key.phoneNumberId, key.userId, key.wabaId, at],
    );
    const row = rows[0];
    if (!row) throw new Error("recordInbound answered no row");
    return chatOf(row);
  }

  async chat(key: ChatKey): Promise<Chat | undefined> {
    const { rows } = await this.database.query<ChatRow>(
      `SELECT ${CHAT_COLUMNS} FROM whatsapp_chat
        WHERE phone_number_id = $1 AND user_id = $2`,
      [key.phoneNumberId, key.userId],
    );
    return rows[0] ? chatOf(rows[0]) : undefined;
  }

  async startOver(key: ChatKey, applicationId?: string): Promise<number> {
    const { rows } = await this.database.query<{ generation: number }>(
      `UPDATE whatsapp_chat SET
         generation = generation + 1,
         application_id = COALESCE($3, application_id),
         updated_at = now()
       WHERE phone_number_id = $1 AND user_id = $2
       RETURNING generation`,
      [key.phoneNumberId, key.userId, applicationId ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error("startOver names a chat the service never saw.");
    return row.generation;
  }

  async hold(
    key: ChatKey,
    kind: HoldKind,
    ref: string,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `INSERT INTO whatsapp_hold (phone_number_id, user_id, kind, ref, held_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone_number_id, user_id, kind, ref) DO NOTHING`,
      [key.phoneNumberId, key.userId, kind, ref, at],
    );
    return rowCount === 1;
  }

  async holds(key: ChatKey): Promise<Hold[]> {
    const { rows } = await this.database.query<HoldRow>(
      `SELECT kind, ref, held_at FROM whatsapp_hold
        WHERE phone_number_id = $1 AND user_id = $2 ORDER BY held_at, id`,
      [key.phoneNumberId, key.userId],
    );
    return rows.map(holdOf);
  }

  async releaseHolds(key: ChatKey): Promise<Hold[]> {
    // One statement: two workers releasing at once each take a hold once.
    const { rows } = await this.database.query<HoldRow & { id: string }>(
      `DELETE FROM whatsapp_hold
        WHERE phone_number_id = $1 AND user_id = $2
        RETURNING id, kind, ref, held_at`,
      [key.phoneNumberId, key.userId],
    );
    return rows
      .sort(
        (a, b) =>
          a.held_at.getTime() - b.held_at.getTime() ||
          Number(a.id) - Number(b.id),
      )
      .map(holdOf);
  }

  async claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_chat SET last_notice_at = $3, updated_at = now()
        WHERE phone_number_id = $1 AND user_id = $2
          AND NOT notices_stopped
          AND (last_notice_at IS NULL OR last_notice_at <= $4)`,
      [key.phoneNumberId, key.userId, at, notBefore],
    );
    return rowCount === 1;
  }

  async stopNotices(key: ChatKey): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_chat SET notices_stopped = true, updated_at = now()
        WHERE phone_number_id = $1 AND user_id = $2`,
      [key.phoneNumberId, key.userId],
    );
    return rowCount === 1;
  }

  async setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_template SET
         status = COALESCE($3, status),
         category = COALESCE($4, category),
         updated_at = now()
       WHERE waba_id = $1 AND name = $2`,
      [wabaId, name, change.status ?? null, change.category ?? null],
    );
    if (rowCount === 1) return;
    if (!change.status || !change.category)
      throw new Error(`A new template ${name} needs its status and category.`);
    await this.database.query(
      `INSERT INTO whatsapp_template (waba_id, name, status, category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (waba_id, name) DO UPDATE SET
         status = EXCLUDED.status, category = EXCLUDED.category, updated_at = now()`,
      [wabaId, name, change.status, change.category],
    );
  }

  async templates(wabaId: string): Promise<TemplateRow[]> {
    const { rows } = await this.database.query<TemplateRow>(
      `SELECT name, status, category FROM whatsapp_template
        WHERE waba_id = $1 ORDER BY name`,
      [wabaId],
    );
    return rows.map(({ category, name, status }) => ({
      category,
      name,
      status,
    }));
  }

  async countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO whatsapp_message_count (phone_number_id, month, category, sent)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (phone_number_id, month, category) DO UPDATE SET
         sent = whatsapp_message_count.sent + 1`,
      [phoneNumberId, month, category],
    );
  }

  async messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>> {
    const { rows } = await this.database.query<{
      category: MessageCategory;
      sent: number;
    }>(
      `SELECT category, sent FROM whatsapp_message_count
        WHERE phone_number_id = $1 AND month = $2`,
      [phoneNumberId, month],
    );
    const of = (category: MessageCategory) =>
      rows.find((row) => row.category === category)?.sent ?? 0;
    return { service: of("service"), utility: of("utility") };
  }

  async forget(userId: string): Promise<number> {
    const deleted = async (sql: string, values: unknown[]) =>
      (await this.database.query(sql, values)).rowCount ?? 0;
    let count = 0;
    count += await deleted("DELETE FROM whatsapp_hold WHERE user_id = $1", [
      userId,
    ]);
    count += await deleted("DELETE FROM whatsapp_chat WHERE user_id = $1", [
      userId,
    ]);
    // Their queued and dead jobs; the one being worked (this `forget` among
    // them) is deleted by the queue when it ends.
    count += await deleted(
      `DELETE FROM whatsapp_jobs
        WHERE payload->>'kind' = 'message' AND payload->>'userId' = $1
          AND state <> 'processing'`,
      [userId],
    );
    // Their quota counts on every number (`userQuotaKey`: user:<installation>:<BSUID>).
    count += await deleted(
      `DELETE FROM whatsapp_usage
        WHERE starts_with(usage_key, 'user:')
          AND right(usage_key, length($1) + 1) = ':' || $1`,
      [userId],
    );
    return count;
  }

  async retain(now: Date): Promise<Retained> {
    const before = (ms: number) => new Date(now.getTime() - ms);
    const deleted = async (sql: string, values: unknown[]) =>
      (await this.database.query(sql, values)).rowCount ?? 0;
    const cut = before(RETENTION.chatMs);
    return {
      holds: await deleted(
        `DELETE FROM whatsapp_hold h WHERE h.held_at < $1 OR EXISTS (
           SELECT 1 FROM whatsapp_chat c
            WHERE c.phone_number_id = h.phone_number_id AND c.user_id = h.user_id
              AND c.last_inbound_at < $1)`,
        [cut],
      ),
      chats: await deleted(
        "DELETE FROM whatsapp_chat WHERE last_inbound_at < $1",
        [cut],
      ),
      statuses: await deleted(
        "DELETE FROM whatsapp_message_status WHERE status_at < $1",
        [before(RETENTION.statusMs)],
      ),
      claims: await deleted(
        "DELETE FROM whatsapp_event_claims WHERE claimed_at < $1",
        [before(RETENTION.claimMs)],
      ),
      deadJobs: await deleted(
        "DELETE FROM whatsapp_jobs WHERE state = 'dead' AND created_at < $1",
        [before(RETENTION.deadJobMs)],
      ),
      // The kit's hourly windows (`windowOf`: the ISO hour) sort as text.
      usage: await deleted(
        "DELETE FROM whatsapp_usage WHERE usage_window < $1",
        [before(RETENTION.usageMs).toISOString().slice(0, 13)],
      ),
    };
  }
}
