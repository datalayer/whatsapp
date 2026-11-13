import { solrDate, textOf, type SolrDoc } from "./solr/client.js";
import { CLAIM } from "./solr/queue.js";
import {
  lockKey,
  type Fields,
  type FindOptions,
  type SolrRecords,
} from "./solr/records.js";
import {
  STATUS_RANK,
  type ApprovalCardRow,
  type Asking,
  type Chat,
  type ChatKey,
  type Group,
  type GroupState,
  type Hold,
  type HoldKind,
  type Installation,
  type InstallationState,
  type MessageCategory,
  type Retained,
  RETENTION,
  type RunningTurn,
  type StatusRow,
  type StatusUpdate,
  type TemplateRow,
  type TurnClaim,
  type WhatsAppStore,
  wamidHash,
} from "./store.js";

/**
 * The store in the service's Solr collection (`whatsapp`), in production.
 * One record kind per thing kept (`type_s`), each under its natural key
 * (`key_s`, what its primary key was): a message's status by its id's
 * hash, a chat by number and person, a hold by chat, kind and reference, a
 * template by account and name, a month's count by number, month and
 * category, an installation by account and number, a card by chat and
 * approval, a group by number and the service's ref. The object itself is
 * kept whole in `record_stored`, its secrets as the callers encrypted them;
 * the dynamic fields are only what is searched, sorted or purged on.
 *
 * Every keyed write runs under its key's lock (`SolrRecords`): a counter, a
 * claim taken once, a turn taken only when free, a status that never steps
 * back are read and written under it. What Postgres' unique columns refused
 * (an installation's host and webhook key, a group's Meta id) is checked
 * under a lock on that value too. The queue's jobs and claims and the quota
 * counts are the shared Solr layer's, in the same collection: `forget`,
 * `retain` and `purgeInstallation` delete theirs here.
 */

const STATUS = "message_status";
const CHAT = "chat";
const HOLD = "hold";
const TEMPLATE = "template";
const COUNT = "message_count";
const INSTALLATION = "installation";
const CARD = "approval_card";
const GROUP = "group";
/** The shared layer's kinds (`solr/queue.ts`, `solr/quotas.ts`). */
const JOB = "job";
const USAGE = "usage";

/** The lock on a value Postgres kept unique, for a check-then-write under it. */
const uniqueLock = (what: string, value: string): string =>
  lockKey(`unique:${what}`, value);

const keyOf = (...parts: readonly string[]): string => JSON.stringify(parts);
const chatKeyOf = (key: ChatKey): string =>
  keyOf(key.phoneNumberId, key.userId);

/** The fields kept as dates in a record: read back as dates. */
const DATES = new Set([
  "at",
  "createdAt",
  "heldAt",
  "installedAt",
  "lastInboundAt",
  "lastNoticeAt",
  "removedAt",
  "shownAt",
  "until",
]);

/** A record as read from `record_stored`, its dates made dates again. */
function revive<T>(value: unknown): T {
  const walk = (one: unknown, key?: string): unknown => {
    if (typeof one === "string" && key !== undefined && DATES.has(key))
      return new Date(one);
    if (Array.isArray(one)) return one.map((item) => walk(item));
    if (one && typeof one === "object" && !(one instanceof Date))
      return Object.fromEntries(
        Object.entries(one).map(([name, item]) => [name, walk(item, name)]),
      );
    return one;
  };
  return walk(value) as T;
}

/** A pending write of a keyed record: the record and its searched fields. */
type Write<T> = { record: T; fields?: Fields };

const chatWrite = (chat: Chat): Write<Chat> => ({
  fields: {
    last_inbound_at_dt: chat.lastInboundAt,
    phone_number_id_s: chat.phoneNumberId,
    user_id_s: chat.userId,
    waba_id_s: chat.wabaId,
  },
  record: chat,
});

const installationWrite = (
  installation: Installation,
): Write<Installation> => ({
  fields: {
    host_uid_s: installation.hostUid,
    phone_number_id_s: installation.phoneNumberId,
    state_s: installation.state,
    waba_id_s: installation.wabaId,
    webhook_key_s: installation.app.webhookKey,
  },
  record: installation,
});

const groupWrite = (group: Group): Write<Group> => ({
  fields: {
    created_at_dt: group.createdAt,
    group_id_s: group.groupId,
    phone_number_id_s: group.phoneNumberId,
    ref_s: group.ref,
    waba_id_s: group.wabaId,
  },
  record: group,
});

/** `[* TO cut}`: everything strictly before `cut`. */
const before = (field: string, cut: Date): string =>
  `${field}:[* TO ${solrDate(cut)}}`;

/** The queue's jobs not being worked: the one running is the queue's to end. */
const IDLE_JOBS = "(*:* -state_s:processing)";

export class SolrWhatsAppStore implements WhatsAppStore {
  constructor(readonly records: SolrRecords) {}

  async applyStatus(update: StatusUpdate): Promise<void> {
    await this.#update<StatusRow>(STATUS, wamidHash(update.wamid), (kept) => {
      if (kept && STATUS_RANK[kept.status] >= STATUS_RANK[update.status])
        return undefined;
      return {
        fields: {
          phone_number_id_s: update.phoneNumberId,
          status_at_dt: update.at,
        },
        record: {
          at: update.at,
          phoneNumberId: update.phoneNumberId,
          status: update.status,
          ...(update.errorCode !== undefined
            ? { errorCode: update.errorCode }
            : {}),
        },
      };
    });
  }

  async status(wamid: string): Promise<StatusRow | undefined> {
    return this.#get<StatusRow>(STATUS, wamidHash(wamid));
  }

  async recordInbound(
    key: ChatKey & Readonly<{ wabaId: string }>,
    at: Date,
  ): Promise<Chat> {
    const chat = await this.#update<Chat>(CHAT, chatKeyOf(key), (kept) => {
      if (!kept)
        return chatWrite({
          disclosed: false,
          generation: 0,
          lastInboundAt: at,
          noticesStopped: false,
          phoneNumberId: key.phoneNumberId,
          userId: key.userId,
          wabaId: key.wabaId,
        });
      // Never back: Meta's webhooks arrive out of order.
      if (kept.lastInboundAt.getTime() >= at.getTime()) return undefined;
      return chatWrite({ ...kept, lastInboundAt: at });
    });
    if (!chat) throw new Error("recordInbound kept no chat.");
    return chat;
  }

  async chat(key: ChatKey): Promise<Chat | undefined> {
    return this.#get<Chat>(CHAT, chatKeyOf(key));
  }

  async startOver(key: ChatKey, applicationId?: string): Promise<number> {
    const chat = await this.#update<Chat>(CHAT, chatKeyOf(key), (kept) => {
      if (!kept)
        throw new Error("startOver names a chat the service never saw.");
      const {
        asking: _asking,
        sessionDeployment: _deployment,
        sessionUid: _session,
        ...rest
      } = kept;
      void [_asking, _deployment, _session];
      return chatWrite({
        ...rest,
        generation: kept.generation + 1,
        ...(applicationId !== undefined ? { applicationId } : {}),
      });
    });
    if (!chat) throw new Error("startOver kept no chat.");
    return chat.generation;
  }

  async hold(
    key: ChatKey,
    kind: HoldKind,
    ref: string,
    at: Date,
  ): Promise<boolean> {
    return this.records.create<Hold & ChatKey>(
      HOLD,
      keyOf(key.phoneNumberId, key.userId, kind, ref),
      {
        heldAt: at,
        kind,
        phoneNumberId: key.phoneNumberId,
        ref,
        userId: key.userId,
      },
      {
        held_at_dt: at,
        phone_number_id_s: key.phoneNumberId,
        user_id_s: key.userId,
      },
    );
  }

  async holds(key: ChatKey): Promise<Hold[]> {
    return (await this.#holdsOf(key)).map(({ record }) => record);
  }

  async releaseHolds(key: ChatKey): Promise<Hold[]> {
    // Under the chat's release lock: two workers releasing at once each
    // take a hold once (what one DELETE ... RETURNING was).
    return this.records.locked(
      [lockKey("hold-release", chatKeyOf(key))],
      async () => {
        const held = await this.#holdsOf(key);
        await this.records.client.deleteIds(held.map(({ id }) => id));
        return held.map(({ record }) => record);
      },
    );
  }

  async claimNotice(key: ChatKey, at: Date, notBefore: Date): Promise<boolean> {
    let claimed = false;
    await this.#update<Chat>(CHAT, chatKeyOf(key), (kept) => {
      if (!kept || kept.noticesStopped) return undefined;
      if (
        kept.lastNoticeAt &&
        kept.lastNoticeAt.getTime() > notBefore.getTime()
      )
        return undefined;
      claimed = true;
      return chatWrite({ ...kept, lastNoticeAt: at });
    });
    return claimed;
  }

  async stopNotices(key: ChatKey): Promise<boolean> {
    return this.#change(key, (chat) => ({ ...chat, noticesStopped: true }));
  }

  async setTemplate(
    wabaId: string,
    name: string,
    change: Readonly<{ status?: string; category?: string }>,
  ): Promise<void> {
    await this.#update<TemplateRow>(TEMPLATE, keyOf(wabaId, name), (kept) => {
      if (!kept && (!change.status || !change.category))
        throw new Error(
          `A new template ${name} needs its status and category.`,
        );
      return {
        fields: { name_s: name, waba_id_s: wabaId },
        record: {
          category: change.category ?? kept?.category ?? "",
          name,
          status: change.status ?? kept?.status ?? "",
        },
      };
    });
  }

  async templates(wabaId: string): Promise<TemplateRow[]> {
    return this.#find<TemplateRow>(
      TEMPLATE,
      { waba_id_s: wabaId },
      { sort: "name_s asc" },
    );
  }

  async countMessage(
    phoneNumberId: string,
    month: string,
    category: MessageCategory,
  ): Promise<void> {
    type Count = Readonly<{
      phoneNumberId: string;
      month: string;
      category: MessageCategory;
      sent: number;
    }>;
    await this.#update<Count>(
      COUNT,
      keyOf(phoneNumberId, month, category),
      (kept) => ({
        fields: {
          category_s: category,
          month_s: month,
          phone_number_id_s: phoneNumberId,
        },
        record: { category, month, phoneNumberId, sent: (kept?.sent ?? 0) + 1 },
      }),
    );
  }

  async messageCounts(
    phoneNumberId: string,
    month: string,
  ): Promise<Record<MessageCategory, number>> {
    const counts = await this.#find<{
      category: MessageCategory;
      sent: number;
    }>(COUNT, { month_s: month, phone_number_id_s: phoneNumberId });
    const of = (category: MessageCategory) =>
      counts.find((one) => one.category === category)?.sent ?? 0;
    return { service: of("service"), utility: of("utility") };
  }

  async forget(userId: string): Promise<number> {
    let count = 0;
    for (const kind of [HOLD, CARD, CHAT])
      count += await this.#purge(kind, { user_id_s: userId });
    // Their queued and dead jobs; the one being worked (this `forget` among
    // them) is deleted by the queue when it ends. A job's payload is kept,
    // not indexed: read here, the person's found among them.
    count += await this.#purgeJobs(
      (payload) => payload.kind === "message" && payload.userId === userId,
    );
    // Their quota counts on every number (`userQuotaKey`: user:<installation>:<BSUID>).
    count += await this.#purgeDocs(
      (
        await this.records.findStored<{ key: string }>(
          USAGE,
          {},
          { where: ["{!prefix f=usage_key_s}user:"] },
        )
      ).filter(({ record }) => record.key.endsWith(`:${userId}`)),
    );
    return count;
  }

  async retain(now: Date): Promise<Retained> {
    const cut = (ms: number) => new Date(now.getTime() - ms);
    const chatCut = cut(RETENTION.chatMs);
    const oldChats = await this.records.findStored<Chat>(
      CHAT,
      {},
      { where: [before("last_inbound_at_dt", chatCut)] },
    );
    // A hold past its keeping, or held by a chat that is.
    const holds = new Map<string, SolrDoc>();
    for (const one of await this.records.findStored(
      HOLD,
      {},
      { where: [before("held_at_dt", chatCut)] },
    ))
      holds.set(one.id, one.doc);
    for (const chat of oldChats)
      for (const one of await this.records.findStored(HOLD, {
        phone_number_id_s: textOf(chat.doc.phone_number_id_s),
        user_id_s: textOf(chat.doc.user_id_s),
      }))
        holds.set(one.id, one.doc);
    await this.records.client.deleteIds([...holds.keys()]);
    return {
      holds: holds.size,
      chats: await this.#purgeDocs(oldChats),
      statuses: await this.#purge(STATUS, {}, [
        before("status_at_dt", cut(RETENTION.statusMs)),
      ]),
      cards: await this.#purge(CARD, {}, [
        before("shown_at_dt", cut(RETENTION.cardMs)),
      ]),
      claims: await this.#purge(CLAIM, {}, [
        before("creation_ts_dt", cut(RETENTION.claimMs)),
      ]),
      deadJobs: await this.#purge(JOB, { state_s: "dead" }, [
        before("creation_ts_dt", cut(RETENTION.deadJobMs)),
      ]),
      // The kit's hourly windows (`windowOf`: the ISO hour) sort as text.
      usage: await this.#purge(USAGE, {}, [
        `usage_window_s:[* TO "${cut(RETENTION.usageMs).toISOString().slice(0, 13)}"}`,
      ]),
    };
  }

  async claimEvent(id: string): Promise<boolean> {
    return this.records.create(CLAIM, id, { eventId: id });
  }

  async releaseEvent(id: string): Promise<void> {
    await this.records.remove(CLAIM, id);
  }

  async saveInstallation(installation: Installation): Promise<void> {
    const key = keyOf(installation.wabaId, installation.phoneNumberId);
    const webhookKey = installation.app.webhookKey;
    await this.records.locked(
      [
        lockKey(INSTALLATION, key),
        uniqueLock("host", installation.hostUid),
        ...(webhookKey ? [uniqueLock("webhook-key", webhookKey)] : []),
      ],
      async () => {
        // What Postgres' unique host_uid and webhook_key refused.
        await this.#refuseTaken(
          INSTALLATION,
          { host_uid_s: installation.hostUid },
          key,
          "A host another installation holds.",
        );
        if (webhookKey)
          await this.#refuseTaken(
            INSTALLATION,
            { webhook_key_s: webhookKey },
            key,
            "A webhook key another installation holds.",
          );
        const {
          deliveryKey: _key,
          deliveryVersion: _version,
          ...rest
        } = installation;
        void [_key, _version];
        await this.#put(
          INSTALLATION,
          key,
          installationWrite({
            // The key and version describe the secret: never kept without it.
            ...(installation.deliverySecret ? installation : rest),
            installedAt: installation.installedAt ?? new Date(),
          }),
        );
      },
    );
  }

  async installation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<Installation | undefined> {
    return this.#get<Installation>(INSTALLATION, keyOf(wabaId, phoneNumberId));
  }

  async installationByHost(hostUid: string): Promise<Installation | undefined> {
    return (
      await this.#find<Installation>(
        INSTALLATION,
        { host_uid_s: hostUid },
        { rows: 1 },
      )
    )[0];
  }

  async installationByWebhookKey(
    key: string,
  ): Promise<Installation | undefined> {
    return (
      await this.#find<Installation>(
        INSTALLATION,
        { webhook_key_s: key },
        { rows: 1 },
      )
    )[0];
  }

  async installations(state?: InstallationState): Promise<Installation[]> {
    return this.#find<Installation>(
      INSTALLATION,
      { state_s: state },
      { sort: "waba_id_s asc, phone_number_id_s asc" },
    );
  }

  async setInstallationState(
    wabaId: string,
    phoneNumberId: string,
    state: "active" | "paused",
  ): Promise<boolean> {
    let changed = false;
    await this.#update<Installation>(
      INSTALLATION,
      keyOf(wabaId, phoneNumberId),
      (kept) => {
        if (!kept || kept.state === "removed") return undefined;
        changed = true;
        return installationWrite({ ...kept, state });
      },
    );
    return changed;
  }

  async removeInstallation(
    wabaId: string,
    phoneNumberId: string,
    at: Date,
  ): Promise<boolean> {
    let removed = false;
    await this.#update<Installation>(
      INSTALLATION,
      keyOf(wabaId, phoneNumberId),
      (kept) => {
        if (!kept || kept.state === "removed") return undefined;
        removed = true;
        const {
          businessToken: _token,
          deliveryKey: _key,
          deliverySecret: _secret,
          deliveryVersion: _version,
          pin: _pin,
          ...rest
        } = kept;
        void [_token, _key, _secret, _version, _pin];
        return installationWrite({
          ...rest,
          // The app's id stays; its secret and webhook address go.
          app: { appId: rest.app.appId },
          removedAt: at,
          state: "removed",
        });
      },
    );
    return removed;
  }

  async purgeInstallation(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<number> {
    const installation = `${wabaId}:${phoneNumberId}`;
    let count = 0;
    for (const kind of [HOLD, CHAT, CARD, STATUS, COUNT, GROUP])
      count += await this.#purge(kind, { phone_number_id_s: phoneNumberId });
    count += await this.#purgeJobs(
      (payload) => payload.phoneNumberId === phoneNumberId,
    );
    // The number's and its people's quota counts (`number:` and `user:<installation>:`).
    count += await this.#purge(USAGE, {
      usage_key_s: `number:${installation}`,
    });
    count += await this.#purge(USAGE, {}, [
      `{!prefix f=usage_key_s}user:${installation}:`,
    ]);
    count += await this.#purge(INSTALLATION, {
      key_s: keyOf(wabaId, phoneNumberId),
    });
    if ((await this.records.count(INSTALLATION, { waba_id_s: wabaId })) === 0)
      count += await this.#purge(TEMPLATE, { waba_id_s: wabaId });
    return count;
  }

  async markDisclosed(key: ChatKey): Promise<boolean> {
    return this.#change(key, (chat) =>
      chat.disclosed ? undefined : { ...chat, disclosed: true },
    );
  }

  async claimTurn(
    key: ChatKey,
    owner: string,
    until: Date,
    now: Date,
  ): Promise<TurnClaim> {
    let claim: TurnClaim | undefined;
    await this.#update<Chat>(CHAT, chatKeyOf(key), (kept) => {
      if (!kept)
        throw new Error("claimTurn names a chat the service never saw.");
      if (
        kept.turn &&
        kept.turn.owner !== owner &&
        kept.turn.until.getTime() > now.getTime()
      ) {
        claim = { ok: false, owner: kept.turn.owner };
        return undefined;
      }
      claim = { ok: true };
      return chatWrite({ ...kept, turn: { owner, stop: false, until } });
    });
    if (!claim) throw new Error("claimTurn decided nothing.");
    return claim;
  }

  async renewTurn(key: ChatKey, owner: string, until: Date): Promise<void> {
    await this.#change(key, (chat) =>
      chat.turn?.owner === owner
        ? { ...chat, turn: { ...chat.turn, until } }
        : undefined,
    );
  }

  async setTurnSession(
    key: ChatKey,
    owner: string,
    sessionUid: string,
    deploymentUid: string,
  ): Promise<void> {
    await this.#change(key, (chat) =>
      chat.turn?.owner === owner
        ? { ...chat, turn: { ...chat.turn, deploymentUid, sessionUid } }
        : undefined,
    );
  }

  async requestStop(key: ChatKey, now: Date): Promise<RunningTurn | undefined> {
    let stopped: RunningTurn | undefined;
    await this.#change(key, (chat) => {
      if (!chat.turn || chat.turn.until.getTime() <= now.getTime())
        return undefined;
      stopped = { ...chat.turn, stop: true };
      return { ...chat, turn: stopped };
    });
    return stopped;
  }

  async releaseTurn(key: ChatKey, owner: string): Promise<void> {
    await this.#change(key, (chat) => {
      if (chat.turn?.owner !== owner) return undefined;
      const { turn: _turn, ...rest } = chat;
      void _turn;
      return rest;
    });
  }

  async setSession(
    key: ChatKey,
    session: Readonly<{
      sessionUid: string;
      deploymentUid: string;
      unshown: boolean;
    }>,
  ): Promise<void> {
    await this.#change(key, (chat) => {
      const { unshownSessionUid: _unshown, ...rest } = chat;
      void _unshown;
      return {
        ...rest,
        sessionDeployment: session.deploymentUid,
        sessionUid: session.sessionUid,
        ...(session.unshown ? { unshownSessionUid: session.sessionUid } : {}),
      };
    });
  }

  async markShown(key: ChatKey, sessionUid: string): Promise<boolean> {
    return this.#change(key, (chat) => {
      if (chat.unshownSessionUid !== sessionUid) return undefined;
      const { unshownSessionUid: _unshown, ...rest } = chat;
      void _unshown;
      return rest;
    });
  }

  async setAsking(key: ChatKey, asking: Asking | undefined): Promise<void> {
    await this.#change(key, (chat) => {
      const { asking: _asking, ...rest } = chat;
      void _asking;
      return asking ? { ...rest, asking } : rest;
    });
  }

  async saveGroup(group: Group): Promise<void> {
    const key = keyOf(group.phoneNumberId, group.ref);
    await this.records.locked(
      [
        lockKey(GROUP, key),
        ...(group.groupId ? [uniqueLock("group-id", group.groupId)] : []),
      ],
      async () => {
        if (group.groupId)
          await this.#refuseTaken(
            GROUP,
            { group_id_s: group.groupId },
            key,
            "A group id another row holds.",
          );
        const { record, fields } = groupWrite(group);
        // A plain INSERT in Postgres: a second group under one ref is refused.
        if (!(await this.records.create(GROUP, key, record, fields)))
          throw new Error(
            `A group ${group.ref} of the number is kept already.`,
          );
      },
    );
  }

  async groups(phoneNumberId: string): Promise<Group[]> {
    return this.#find<Group>(
      GROUP,
      { phone_number_id_s: phoneNumberId },
      { sort: "created_at_dt asc, ref_s asc" },
    );
  }

  async group(
    phoneNumberId: string,
    groupId: string,
  ): Promise<Group | undefined> {
    return (
      await this.#find<Group>(
        GROUP,
        { group_id_s: groupId, phone_number_id_s: phoneNumberId },
        { rows: 1 },
      )
    )[0];
  }

  async updateGroup(
    phoneNumberId: string,
    ref: string,
    change: Readonly<{ groupId?: string; state?: GroupState }>,
  ): Promise<boolean> {
    const key = keyOf(phoneNumberId, ref);
    return this.records.locked(
      [
        lockKey(GROUP, key),
        ...(change.groupId !== undefined
          ? [uniqueLock("group-id", change.groupId)]
          : []),
      ],
      async () => {
        let changed = false;
        await this.#update<Group>(GROUP, key, async (kept) => {
          if (!kept) return undefined;
          if (change.groupId !== undefined)
            await this.#refuseTaken(
              GROUP,
              { group_id_s: change.groupId },
              key,
              "A group id another row holds.",
            );
          changed = true;
          return groupWrite({
            ...kept,
            ...(change.groupId !== undefined
              ? { groupId: change.groupId }
              : {}),
            ...(change.state !== undefined ? { state: change.state } : {}),
          });
        });
        return changed;
      },
    );
  }

  async deleteGroup(phoneNumberId: string, ref: string): Promise<boolean> {
    let deleted: Group | undefined;
    await this.#update<Group>(GROUP, keyOf(phoneNumberId, ref), (kept) => {
      deleted = kept;
      return kept ? null : undefined;
    });
    if (!deleted) return false;
    // Its chat (its session and turn) goes with it.
    if (deleted.groupId !== undefined)
      await this.records.remove(CHAT, keyOf(phoneNumberId, deleted.groupId));
    return true;
  }

  async saveCard(card: ApprovalCardRow): Promise<void> {
    await this.#put(
      CARD,
      keyOf(card.phoneNumberId, card.userId, card.approvalId),
      {
        fields: {
          phone_number_id_s: card.phoneNumberId,
          shown_at_dt: card.shownAt,
          user_id_s: card.userId,
        },
        record: card,
      },
    );
  }

  async card(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
  ): Promise<ApprovalCardRow | undefined> {
    return this.#get<ApprovalCardRow>(
      CARD,
      keyOf(phoneNumberId, userId, approvalId),
    );
  }

  async decideCard(
    phoneNumberId: string,
    userId: string,
    approvalId: string,
    status: string,
  ): Promise<void> {
    await this.#update<ApprovalCardRow>(
      CARD,
      keyOf(phoneNumberId, userId, approvalId),
      (kept) =>
        kept
          ? {
              fields: {
                phone_number_id_s: kept.phoneNumberId,
                shown_at_dt: kept.shownAt,
                user_id_s: kept.userId,
              },
              record: { ...kept, decidedStatus: status },
            }
          : undefined,
    );
  }

  // -- helpers ---------------------------------------------------------------

  async #get<T>(kind: string, key: string): Promise<T | undefined> {
    const raw = await this.records.get<unknown>(kind, key);
    return raw === undefined ? undefined : revive<T>(raw);
  }

  async #find<T>(
    kind: string,
    fields: Fields,
    options: FindOptions = {},
  ): Promise<T[]> {
    return (await this.records.find<unknown>(kind, fields, options)).map(
      (raw) => revive<T>(raw),
    );
  }

  async #put<T>(kind: string, key: string, write: Write<T>): Promise<void> {
    await this.records.put(kind, key, write.record, write.fields);
  }

  /** `SolrRecords.update`, the record read back with its dates. */
  async #update<T>(
    kind: string,
    key: string,
    change: (
      kept: T | undefined,
    ) => Write<T> | undefined | null | Promise<Write<T> | undefined | null>,
  ): Promise<T | undefined> {
    const after = await this.records.update<unknown>(kind, key, (raw) =>
      change(raw === undefined ? undefined : revive<T>(raw)),
    );
    return after === undefined ? undefined : revive<T>(after);
  }

  /** Change a kept chat: `false` when it is unknown or `change` keeps it as it is. */
  async #change(
    key: ChatKey,
    change: (chat: Chat) => Chat | undefined,
  ): Promise<boolean> {
    let changed = false;
    await this.#update<Chat>(CHAT, chatKeyOf(key), (kept) => {
      const next = kept ? change(kept) : undefined;
      if (!next) return undefined;
      changed = true;
      return chatWrite(next);
    });
    return changed;
  }

  async #holdsOf(key: ChatKey) {
    return (
      await this.records.findStored<unknown>(
        HOLD,
        { phone_number_id_s: key.phoneNumberId, user_id_s: key.userId },
        { sort: "held_at_dt asc, uid asc" },
      )
    ).map(({ id, record }) => {
      const { heldAt, kind, ref } = revive<Hold>(record);
      const hold: Hold = { heldAt, kind, ref };
      return { id, record: hold };
    });
  }

  /** Throw when another record of the kind than `key` has these fields. */
  async #refuseTaken(
    kind: string,
    fields: Fields,
    key: string,
    message: string,
  ): Promise<void> {
    const holders = await this.records.findStored(kind, fields, { rows: 2 });
    if (holders.some((one) => textOf(one.doc.key_s) !== key))
      throw new Error(message);
  }

  /** Delete the records of a kind with these fields: how many. */
  async #purge(
    kind: string,
    fields: Fields,
    where?: readonly string[],
  ): Promise<number> {
    return this.#purgeDocs(
      await this.records.findStored(kind, fields, { where }),
    );
  }

  async #purgeDocs(found: readonly { id: string }[]): Promise<number> {
    await this.records.client.deleteIds(found.map(({ id }) => id));
    return found.length;
  }

  /** Delete the queue's idle jobs whose payload `matches`: how many. */
  async #purgeJobs(
    matches: (payload: Readonly<Record<string, unknown>>) => boolean,
  ): Promise<number> {
    const jobs = await this.records.findStored(JOB, {}, { where: [IDLE_JOBS] });
    return this.#purgeDocs(
      jobs.filter(({ doc }) => {
        const payload: unknown = JSON.parse(textOf(doc.payload_stored, "null"));
        return (
          payload !== null &&
          typeof payload === "object" &&
          matches(payload as Record<string, unknown>)
        );
      }),
    );
  }
}
