import type { Queryable } from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  STATUS_RANK,
  type MessageStatus,
  type StatusRow,
  type StatusUpdate,
  type WhatsAppStore,
} from "./store.js";

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
}
