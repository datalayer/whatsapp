import type {
  EncryptedSecret,
  Queryable,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  STATUS_RANK,
  type ApprovalCardRow,
  type Asking,
  type Installation,
  type InstallationState,
  type RunningTurn,
  type TurnClaim,
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
  session_uid: string | null;
  session_deployment: string | null;
  unshown_session_uid: string | null;
  disclosed: boolean;
  asking: Asking | null;
  turn_owner: string | null;
  turn_until: Date | null;
  turn_session: string | null;
  turn_deployment: string | null;
  turn_stop: boolean;
};

const CHAT_COLUMNS = `phone_number_id, user_id, waba_id, last_inbound_at, generation,
  application_id, notices_stopped, last_notice_at, session_uid, session_deployment,
  unshown_session_uid, disclosed, asking, turn_owner, turn_until, turn_session,
  turn_deployment, turn_stop`;

function turnOf(row: ChatRow): RunningTurn | undefined {
  if (row.turn_owner === null || row.turn_until === null) return undefined;
  return {
    owner: row.turn_owner,
    stop: row.turn_stop,
    until: row.turn_until,
    ...(row.turn_session !== null ? { sessionUid: row.turn_session } : {}),
    ...(row.turn_deployment !== null
      ? { deploymentUid: row.turn_deployment }
      : {}),
  };
}

function chatOf(row: ChatRow): Chat {
  const turn = turnOf(row);
  return {
    disclosed: row.disclosed,
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
    ...(row.session_uid !== null ? { sessionUid: row.session_uid } : {}),
    ...(row.session_deployment !== null
      ? { sessionDeployment: row.session_deployment }
      : {}),
    ...(row.unshown_session_uid !== null
      ? { unshownSessionUid: row.unshown_session_uid }
      : {}),
    ...(row.asking !== null ? { asking: row.asking } : {}),
    ...(turn ? { turn } : {}),
  };
}

type InstallationRow = {
  waba_id: string;
  phone_number_id: string;
  host_uid: string;
  host_key: EncryptedSecret;
  business_token: EncryptedSecret | null;
  pin: EncryptedSecret | null;
  delivery_secret: EncryptedSecret | null;
  organization_uid: string;
  business_name: string;
  support: string;
  privacy: string;
  state: InstallationState;
  removed_at: Date | null;
  way: "embedded_signup" | "own_app";
  app_id: string | null;
  app_secret: EncryptedSecret | null;
  webhook_key: string | null;
};

const INSTALLATION_COLUMNS = `waba_id, phone_number_id, host_uid, host_key, business_token,
  pin, delivery_secret, organization_uid, business_name, support, privacy, state, removed_at,
  way, app_id, app_secret, webhook_key`;

function installationOf(row: InstallationRow): Installation {
  return {
    businessName: row.business_name,
    hostKey: row.host_key,
    hostUid: row.host_uid,
    organizationUid: row.organization_uid,
    phoneNumberId: row.phone_number_id,
    state: row.state,
    privacy: row.privacy,
    support: row.support,
    wabaId: row.waba_id,
    ...(row.business_token ? { businessToken: row.business_token } : {}),
    ...(row.pin ? { pin: row.pin } : {}),
    ...(row.delivery_secret ? { deliverySecret: row.delivery_secret } : {}),
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
    ...(row.way === "own_app"
      ? {
          ownApp: {
            appId: row.app_id as string,
            ...(row.webhook_key ? { webhookKey: row.webhook_key } : {}),
            ...(row.app_secret ? { appSecret: row.app_secret } : {}),
          },
        }
      : {}),
  };
}

type CardRow = {
  phone_number_id: string;
  user_id: string;
  approval_id: string;
  deployment_uid: string;
  digest: string;
  tool_name: string;
  shown_at: Date;
  decided_status: string | null;
};

const cardOf = (row: CardRow): ApprovalCardRow => ({
  approvalId: row.approval_id,
  deploymentUid: row.deployment_uid,
  digest: row.digest,
  phoneNumberId: row.phone_number_id,
  shownAt: row.shown_at,
  toolName: row.tool_name,
  userId: row.user_id,
  ...(row.decided_status !== null ? { decidedStatus: row.decided_status } : {}),
});

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
         session_uid = NULL,
         session_deployment = NULL,
         asking = NULL,
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
    count += await deleted(
      "DELETE FROM whatsapp_approval_card WHERE user_id = $1",
      [userId],
    );
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
      cards: await deleted(
        "DELETE FROM whatsapp_approval_card WHERE shown_at < $1",
        [before(RETENTION.cardMs)],
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

  async claimEvent(id: string): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `INSERT INTO whatsapp_event_claims (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING`,
      [id],
    );
    return rowCount === 1;
  }

  async releaseEvent(id: string): Promise<void> {
    await this.database.query(
      "DELETE FROM whatsapp_event_claims WHERE event_id = $1",
      [id],
    );
  }

  async saveInstallation(installation: Installation): Promise<void> {
    await this.database.query(
      `INSERT INTO whatsapp_installation (${INSTALLATION_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (waba_id, phone_number_id) DO UPDATE SET
         host_uid = EXCLUDED.host_uid,
         host_key = EXCLUDED.host_key,
         business_token = EXCLUDED.business_token,
         pin = EXCLUDED.pin,
         delivery_secret = EXCLUDED.delivery_secret,
         organization_uid = EXCLUDED.organization_uid,
         business_name = EXCLUDED.business_name,
         support = EXCLUDED.support,
         privacy = EXCLUDED.privacy,
         state = EXCLUDED.state,
         removed_at = EXCLUDED.removed_at,
         way = EXCLUDED.way,
         app_id = EXCLUDED.app_id,
         app_secret = EXCLUDED.app_secret,
         webhook_key = EXCLUDED.webhook_key,
         installed_at = now(),
         updated_at = now()`,
      [
        installation.wabaId,
        installation.phoneNumberId,
        installation.hostUid,
        JSON.stringify(installation.hostKey),
        installation.businessToken
          ? JSON.stringify(installation.businessToken)
          : null,
        installation.pin ? JSON.stringify(installation.pin) : null,
        installation.deliverySecret
          ? JSON.stringify(installation.deliverySecret)
          : null,
        installation.organizationUid,
        installation.businessName,
        installation.support,
        installation.privacy,
        installation.state,
        installation.removedAt ?? null,
        installation.ownApp ? "own_app" : "embedded_signup",
        installation.ownApp?.appId ?? null,
        installation.ownApp?.appSecret
          ? JSON.stringify(installation.ownApp.appSecret)
          : null,
        installation.ownApp?.webhookKey ?? null,
      ],
    );
  }

  async installation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<Installation | undefined> {
    const { rows } = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM whatsapp_installation
        WHERE waba_id = $1 AND phone_number_id = $2`,
      [wabaId, phoneNumberId],
    );
    return rows[0] ? installationOf(rows[0]) : undefined;
  }

  async installationByHost(hostUid: string): Promise<Installation | undefined> {
    const { rows } = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM whatsapp_installation WHERE host_uid = $1`,
      [hostUid],
    );
    return rows[0] ? installationOf(rows[0]) : undefined;
  }

  async installationByWebhookKey(
    key: string,
  ): Promise<Installation | undefined> {
    const { rows } = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM whatsapp_installation WHERE webhook_key = $1`,
      [key],
    );
    return rows[0] ? installationOf(rows[0]) : undefined;
  }

  async installations(state?: InstallationState): Promise<Installation[]> {
    const { rows } = await this.database.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS} FROM whatsapp_installation
        WHERE $1::text IS NULL OR state = $1 ORDER BY waba_id, phone_number_id`,
      [state ?? null],
    );
    return rows.map(installationOf);
  }

  async setInstallationState(
    wabaId: string,
    phoneNumberId: string,
    state: "active" | "paused",
  ): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_installation SET state = $3, updated_at = now()
        WHERE waba_id = $1 AND phone_number_id = $2 AND state <> 'removed'`,
      [wabaId, phoneNumberId, state],
    );
    return rowCount === 1;
  }

  async removeInstallation(
    wabaId: string,
    phoneNumberId: string,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_installation SET
         state = 'removed', removed_at = $3,
         business_token = NULL, pin = NULL, delivery_secret = NULL,
         app_secret = NULL, webhook_key = NULL,
         updated_at = now()
       WHERE waba_id = $1 AND phone_number_id = $2 AND state <> 'removed'`,
      [wabaId, phoneNumberId, at],
    );
    return rowCount === 1;
  }

  async purgeInstallation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<number> {
    const deleted = async (sql: string, values: unknown[]) =>
      (await this.database.query(sql, values)).rowCount ?? 0;
    const installation = `${wabaId}:${phoneNumberId}`;
    let count = 0;
    for (const table of [
      "whatsapp_hold",
      "whatsapp_chat",
      "whatsapp_approval_card",
      "whatsapp_message_status",
      "whatsapp_message_count",
    ])
      count += await deleted(
        `DELETE FROM ${table} WHERE phone_number_id = $1`,
        [phoneNumberId],
      );
    count += await deleted(
      `DELETE FROM whatsapp_jobs
        WHERE payload->>'phoneNumberId' = $1 AND state <> 'processing'`,
      [phoneNumberId],
    );
    // The number's and its people's quota counts (`number:` and `user:<installation>:`).
    count += await deleted(
      `DELETE FROM whatsapp_usage
        WHERE usage_key = 'number:' || $1 OR starts_with(usage_key, 'user:' || $1 || ':')`,
      [installation],
    );
    count += await deleted(
      `DELETE FROM whatsapp_installation WHERE waba_id = $1 AND phone_number_id = $2`,
      [wabaId, phoneNumberId],
    );
    count += await deleted(
      `DELETE FROM whatsapp_template WHERE waba_id = $1 AND NOT EXISTS (
         SELECT 1 FROM whatsapp_installation WHERE waba_id = $1)`,
      [wabaId],
    );
    return count;
  }

  async markDisclosed(key: ChatKey): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_chat SET disclosed = true, updated_at = now()
        WHERE phone_number_id = $1 AND user_id = $2 AND NOT disclosed`,
      [key.phoneNumberId, key.userId],
    );
    return rowCount === 1;
  }

  async claimTurn(
    key: ChatKey,
    owner: string,
    until: Date,
    now: Date,
  ): Promise<TurnClaim> {
    // One statement: of two claims at once, one wins the row.
    const { rows } = await this.database.query<{
      turn_owner: string | null;
      taken: boolean;
    }>(
      `WITH taken AS (
         UPDATE whatsapp_chat SET
           turn_owner = $3, turn_until = $4, turn_session = NULL,
           turn_deployment = NULL, turn_stop = false, updated_at = now()
         WHERE phone_number_id = $1 AND user_id = $2
           AND (turn_owner IS NULL OR turn_owner = $3 OR turn_until <= $5)
         RETURNING turn_owner)
       SELECT turn_owner, true AS taken FROM taken
       UNION ALL
       SELECT turn_owner, false AS taken FROM whatsapp_chat
        WHERE phone_number_id = $1 AND user_id = $2
          AND NOT EXISTS (SELECT 1 FROM taken)`,
      [key.phoneNumberId, key.userId, owner, until, now],
    );
    const row = rows[0];
    if (!row) throw new Error("claimTurn names a chat the service never saw.");
    return row.taken
      ? { ok: true }
      : { ok: false, owner: row.turn_owner ?? "" };
  }

  async renewTurn(key: ChatKey, owner: string, until: Date): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_chat SET turn_until = $4
        WHERE phone_number_id = $1 AND user_id = $2 AND turn_owner = $3`,
      [key.phoneNumberId, key.userId, owner, until],
    );
  }

  async setTurnSession(
    key: ChatKey,
    owner: string,
    sessionUid: string,
    deploymentUid: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_chat SET turn_session = $4, turn_deployment = $5
        WHERE phone_number_id = $1 AND user_id = $2 AND turn_owner = $3`,
      [key.phoneNumberId, key.userId, owner, sessionUid, deploymentUid],
    );
  }

  async requestStop(key: ChatKey, now: Date): Promise<RunningTurn | undefined> {
    const { rows } = await this.database.query<ChatRow>(
      `UPDATE whatsapp_chat SET turn_stop = true
        WHERE phone_number_id = $1 AND user_id = $2
          AND turn_owner IS NOT NULL AND turn_until > $3
        RETURNING ${CHAT_COLUMNS}`,
      [key.phoneNumberId, key.userId, now],
    );
    return rows[0] ? turnOf(rows[0]) : undefined;
  }

  async releaseTurn(key: ChatKey, owner: string): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_chat SET
         turn_owner = NULL, turn_until = NULL, turn_session = NULL,
         turn_deployment = NULL, turn_stop = false
       WHERE phone_number_id = $1 AND user_id = $2 AND turn_owner = $3`,
      [key.phoneNumberId, key.userId, owner],
    );
  }

  async setSession(
    key: ChatKey,
    session: Readonly<{
      sessionUid: string;
      deploymentUid: string;
      unshown: boolean;
    }>,
  ): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_chat SET
         session_uid = $3, session_deployment = $4,
         unshown_session_uid = CASE WHEN $5 THEN $3 ELSE NULL END,
         updated_at = now()
       WHERE phone_number_id = $1 AND user_id = $2`,
      [
        key.phoneNumberId,
        key.userId,
        session.sessionUid,
        session.deploymentUid,
        session.unshown,
      ],
    );
  }

  async markShown(key: ChatKey, sessionUid: string): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `UPDATE whatsapp_chat SET unshown_session_uid = NULL
        WHERE phone_number_id = $1 AND user_id = $2 AND unshown_session_uid = $3`,
      [key.phoneNumberId, key.userId, sessionUid],
    );
    return rowCount === 1;
  }

  async setAsking(key: ChatKey, asking: Asking | undefined): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_chat SET asking = $3
        WHERE phone_number_id = $1 AND user_id = $2`,
      [key.phoneNumberId, key.userId, asking ? JSON.stringify(asking) : null],
    );
  }

  async saveCard(card: ApprovalCardRow): Promise<void> {
    await this.database.query(
      `INSERT INTO whatsapp_approval_card
         (phone_number_id, user_id, approval_id, deployment_uid, digest, tool_name, shown_at, decided_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (phone_number_id, user_id, approval_id) DO UPDATE SET
         deployment_uid = EXCLUDED.deployment_uid, digest = EXCLUDED.digest,
         tool_name = EXCLUDED.tool_name, shown_at = EXCLUDED.shown_at,
         decided_status = EXCLUDED.decided_status`,
      [
        card.phoneNumberId,
        card.userId,
        card.approvalId,
        card.deploymentUid,
        card.digest,
        card.toolName,
        card.shownAt,
        card.decidedStatus ?? null,
      ],
    );
  }

  async card(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
  ): Promise<ApprovalCardRow | undefined> {
    const { rows } = await this.database.query<CardRow>(
      `SELECT phone_number_id, user_id, approval_id, deployment_uid, digest,
              tool_name, shown_at, decided_status
         FROM whatsapp_approval_card
        WHERE phone_number_id = $1 AND user_id = $2 AND approval_id = $3`,
      [phoneNumberId, userId, approvalId],
    );
    return rows[0] ? cardOf(rows[0]) : undefined;
  }

  async decideCard(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
    status: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE whatsapp_approval_card SET decided_status = $4
        WHERE phone_number_id = $1 AND user_id = $2 AND approval_id = $3`,
      [phoneNumberId, userId, approvalId, status],
    );
  }
}
