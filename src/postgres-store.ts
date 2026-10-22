import type { Queryable } from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  STATUS_RANK,
  type Chat,
  type ChatKey,
  type MessageStatus,
  type StatusRow,
  type StatusUpdate,
  type WhatsAppStore,
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

/** The store on PostgreSQL (`migrations/`), the service's in production. */
export class PostgresStore implements WhatsAppStore {
  constructor(readonly database: Queryable) {}

  async applyStatus(update: StatusUpdate): Promise<void> {
    // One statement: a concurrent, lower status loses to the row's rank.
    await this.database.query(
      `INSERT INTO whatsapp_message_status
         (wamid, phone_number_id, status, status_rank, error_code, status_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (wamid) DO UPDATE SET
         status = EXCLUDED.status,
         status_rank = EXCLUDED.status_rank,
         error_code = EXCLUDED.error_code,
         status_at = EXCLUDED.status_at,
         updated_at = now()
       WHERE whatsapp_message_status.status_rank < EXCLUDED.status_rank`,
      [
        update.wamid,
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
      wamid: string;
      phone_number_id: string;
      status: MessageStatus;
      error_code: number | null;
      status_at: Date;
    }>(
      `SELECT wamid, phone_number_id, status, error_code, status_at
         FROM whatsapp_message_status WHERE wamid = $1`,
      [wamid],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      at: row.status_at,
      phoneNumberId: row.phone_number_id,
      status: row.status,
      wamid: row.wamid,
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
}
