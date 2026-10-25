import type {
  Logger,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { externalIdOf, GROUP_ID, HOST_KIND } from "./domain.js";
import {
  META_CODES,
  MetaError,
  type MetaPort,
  type NumberStanding,
  type OfficialStatus,
} from "./meta-port.js";
import type { Routes } from "./server.js";
import {
  installationData,
  type Group,
  type Installation,
  type WhatsAppStore,
} from "./store.js";
import { BodyTooLargeError, rawBodyOf } from "./verify.js";

/**
 * What the application's Ship card manages on a connected number (WA-49,
 * WA-22): the number's **Official Business Account** status, which Meta's
 * Groups API needs, with the conditions Meta sets and what the service can
 * read of each, and the request for it through Meta's API; then the
 * number's **groups**: created from the card, each one's invite link read
 * or reset at Meta, deleted.
 *
 * Every call comes from Datalayer's web origin only (CORS) and names the
 * installation by its uid at Datalayer (`host_uid`). The caller is the
 * person signed in to datalayer.ai: their Datalayer token, sent as a bearer,
 * is shown to ai-agents (`GET /apps/hosts/<host_uid>`), which answers the
 * installation only to its owner; it is never kept nor logged. The business
 * token stays in the service: the card sees statuses, subjects, ids and
 * invite links, nothing else.
 */

export const MANAGE_PATH = "/whatsapp/manage";
const BODY_LIMIT = 8 * 1024;

/** Where a business requests the Official Business Account by hand. */
export const WHATSAPP_MANAGER_URL =
  "https://business.facebook.com/latest/whatsapp_manager/";

/** Meta's statuses that let the number use the Groups API. */
export const OFFICIAL = "APPROVED";

/** The statuses from which a request may be sent (none running, or denied). */
const MAY_REQUEST = new Set([
  "NOT_STARTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
]);

/** How long Meta asks the platform to be used before an Official Business Account. */
export const PLATFORM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the card is told, each in one sentence. */
export const MANAGE_WORDS = {
  invalid: "That request is not one this service takes.",
  notOwner:
    "Only the owner of this WhatsApp connection, signed in to Datalayer, manages it.",
  notConnected: "This number is not connected any more.",
  meta: "Meta refused the step: nothing was changed. Try again in a moment.",
  notEligible:
    "Meta does not let this number make groups yet: it needs Meta's approval for groups (an Official Business Account) first.",
  groupLimit: "This number made as many groups as Meta allows (10,000).",
  creationPaused:
    "Meta paused group creation for this number's account, after too many marketing messages in the last seven days.",
  rateLimited:
    "Meta says this number changed its groups too often just now: try again in a few minutes.",
  groupUnknown:
    "Meta does not know this group any more: it was deleted, or the number left it.",
  suspended: "Meta suspended this group for WhatsApp's policies.",
  notReady: "This group is still being made at Meta: try again in a moment.",
  requestRunning:
    "A request is with Meta already: its answer comes in WhatsApp Manager and here.",
} as const;

/** Meta's conditions for an Official Business Account, as the service reads each. */
export type Condition = Readonly<{
  id:
    | "policy"
    | "platform_days"
    | "business_verified"
    | "two_step"
    | "display_name";
  /** `met`, `not_met`, or `unknown` when the service cannot read it (the business checks it). */
  state: "met" | "not_met" | "unknown";
  /** What Meta's or the service's own record says, when there is one. */
  detail?: string;
}>;

/** The conditions, from what Meta answered and what the installation keeps. */
export function conditionsOf(
  installation: Installation,
  standing: NumberStanding,
  now: number,
): Condition[] {
  const since = installation.installedAt?.getTime();
  const days =
    since === undefined ? undefined : Math.floor((now - since) / DAY_MS);
  const name = standing.nameStatus?.toUpperCase();
  const verified = standing.businessVerification?.toUpperCase();
  return [
    { id: "policy", state: "unknown" },
    {
      id: "platform_days",
      // Meta counts from the number's registration, which may be before it
      // was connected through Datalayer: under 30 days here is unknown, not a refusal.
      state: days !== undefined && days >= PLATFORM_DAYS ? "met" : "unknown",
      ...(since !== undefined
        ? { detail: new Date(since).toISOString().slice(0, 10) }
        : {}),
    },
    {
      id: "business_verified",
      state:
        verified === undefined
          ? "unknown"
          : verified === "VERIFIED"
            ? "met"
            : "not_met",
      ...(verified ? { detail: verified } : {}),
    },
    {
      id: "two_step",
      // Registered by the service with its PIN, or the business gave its PIN.
      state: installation.pin ? "met" : "unknown",
    },
    {
      id: "display_name",
      state:
        name === undefined
          ? "unknown"
          : name === "APPROVED" || name === "AVAILABLE_WITHOUT_REVIEW"
            ? "met"
            : "not_met",
      ...(name ? { detail: name } : {}),
    },
  ];
}

const hostUid = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const statusSchema = z.object({ host_uid: hostUid }).strict();
const requestSchema = z
  .object({
    host_uid: hostUid,
    website: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && url.hostname.includes(".");
        } catch {
          return false;
        }
      }),
    country: z.string().trim().min(2).max(64),
    language: z.string().trim().min(2).max(64).optional(),
    links: z.array(z.string().trim().url().max(2048)).min(5).max(10).optional(),
  })
  .strict();
const createSchema = z
  .object({ host_uid: hostUid, subject: z.string().trim().min(1).max(128) })
  .strict();
const linkSchema = z
  .object({
    host_uid: hostUid,
    group_id: z.string().regex(GROUP_ID),
    reset: z.boolean().optional(),
  })
  .strict();
const deleteSchema = z
  .object({ host_uid: hostUid, ref: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) })
  .strict();

/** Asks ai-agents whether the bearer owns the installation; never keeps the bearer. */
export type OwnerCheck = (bearer: string, hostUid: string) => Promise<boolean>;

/**
 * The installation's owner, as ai-agents knows them: `GET
 * /api/ai-agents/v1/apps/hosts/<uid>` with the person's own token answers
 * the installation only to its owner (404 to anyone else), and it must be
 * this service's kind.
 */
export function ownerCheckOf(
  apiUrl: string,
  fetchImplementation: typeof fetch = fetch,
): OwnerCheck {
  return async (bearer, uid) => {
    const response = await fetchImplementation(
      `${apiUrl.replace(/\/+$/, "")}/api/ai-agents/v1/apps/hosts/${encodeURIComponent(uid)}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as {
      host?: { uid?: unknown; kind?: unknown; state?: unknown };
    };
    return (
      body.host?.uid === uid &&
      body.host.kind === HOST_KIND &&
      body.host.state === "active"
    );
  };
}

export type ManageDependencies = Readonly<{
  /** Datalayer's web origin: the only one whose card may call. */
  webUrl: string;
  store: WhatsAppStore;
  cipher: Pick<SecretCipher, "decrypt">;
  port: MetaPort;
  owner: OwnerCheck;
  logger: Logger;
  now: () => number;
}>;

/** A group as the card sees it. */
export type GroupView = Readonly<{
  ref: string;
  group_id?: string;
  subject: string;
  state: Group["state"];
  created_at: string;
}>;

const viewOf = (group: Group): GroupView => ({
  created_at: group.createdAt.toISOString(),
  ref: group.ref,
  state: group.state,
  subject: group.subject,
  ...(group.groupId ? { group_id: group.groupId } : {}),
});

/** Thrown inside a route: answered with its status and sentence. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Meta's refusal, in the card's words. */
function wordsOf(error: MetaError): string {
  switch (error.code) {
    case META_CODES.groupsNotEligible:
      return MANAGE_WORDS.notEligible;
    case META_CODES.groupLimit:
      return MANAGE_WORDS.groupLimit;
    case META_CODES.groupCreationPaused:
      return MANAGE_WORDS.creationPaused;
    case META_CODES.groupRateLimited:
      return MANAGE_WORDS.rateLimited;
    case META_CODES.groupUnknown:
      return MANAGE_WORDS.groupUnknown;
    case META_CODES.groupSuspended:
      return MANAGE_WORDS.suspended;
    default:
      return MANAGE_WORDS.meta;
  }
}

export function manageRoutes(dependencies: ManageDependencies): Routes {
  const { store, logger } = dependencies;
  const origin = new URL(dependencies.webUrl).origin;
  const cors = (request: IncomingMessage): Record<string, string> =>
    request.headers.origin === origin
      ? {
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": origin,
          "access-control-max-age": "600",
          vary: "origin",
        }
      : { vary: "origin" };
  const answer = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ) => {
    response.writeHead(status, {
      ...cors(request),
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  };
  const preflight: Routes[string] = async (request, response) => {
    response.writeHead(
      request.headers.origin === origin ? 204 : 403,
      cors(request),
    );
    response.end();
  };

  /** The body as `schema` takes it, the caller proved the owner, the installation. */
  const authorized = async <T extends { host_uid: string }>(
    request: IncomingMessage,
    schema: z.ZodType<T>,
  ): Promise<{ body: T; installation: Installation; token: string }> => {
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== origin
    )
      throw new Refusal(403, MANAGE_WORDS.invalid);
    let raw: Buffer;
    try {
      raw = await rawBodyOf(request, BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      request.resume();
      throw new Refusal(413, MANAGE_WORDS.invalid);
    }
    let body: T;
    try {
      body = schema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new Refusal(400, MANAGE_WORDS.invalid);
    }
    const bearer = /^Bearer ([\x21-\x7e]{16,8192})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!bearer || !(await dependencies.owner(bearer, body.host_uid)))
      throw new Refusal(403, MANAGE_WORDS.notOwner);
    const installation = await store.installationByHost(body.host_uid);
    if (
      !installation ||
      installation.state === "removed" ||
      !installation.businessToken
    )
      throw new Refusal(404, MANAGE_WORDS.notConnected);
    const token = dependencies.cipher.decrypt(
      installation.businessToken,
      installationData(
        "business-token",
        installation.wabaId,
        installation.phoneNumberId,
      ),
    );
    return { body, installation, token };
  };

  /** A route: refusals and Meta's answered in one sentence, the rest thrown. */
  const route =
    (
      work: (request: IncomingMessage) => Promise<Record<string, unknown>>,
    ): Routes[string] =>
    async (request, response) => {
      try {
        answer(request, response, 200, await work(request));
      } catch (error) {
        if (error instanceof Refusal)
          return answer(request, response, error.status, {
            error: error.message,
          });
        if (error instanceof MetaError) {
          logger.warn("manage.meta_refused", {
            meta_error: error.code,
            meta_subcode: error.subcode,
            status: error.status,
            step: error.what,
          });
          return answer(request, response, 502, { error: wordsOf(error) });
        }
        throw error;
      }
    };

  const official = async (
    installation: Installation,
    token: string,
    status?: OfficialStatus,
  ) => {
    const now =
      status ??
      (await dependencies.port.officialStatus(
        token,
        installation.phoneNumberId,
      ));
    const standing = await dependencies.port.standing(
      token,
      installation.wabaId,
      installation.phoneNumberId,
    );
    return {
      conditions: conditionsOf(installation, standing, dependencies.now()),
      groups_allowed: now.status === OFFICIAL,
      manager_url: WHATSAPP_MANAGER_URL,
      may_request: MAY_REQUEST.has(now.status),
      status: now.status,
      ...(now.message ? { status_message: now.message } : {}),
    };
  };

  /**
   * The number's groups; any still being made matched with Meta's list by
   * its subject, for a creation webhook that did not come.
   */
  const groups = async (installation: Installation, token: string) => {
    let kept = await store.groups(installation.phoneNumberId);
    if (kept.some((one) => one.state === "creating")) {
      const known = new Set(
        kept.flatMap((one) => (one.groupId ? [one.groupId] : [])),
      );
      const atMeta = (
        await dependencies.port.groups(token, installation.phoneNumberId)
      ).filter((one) => !known.has(one.id));
      for (const making of kept.filter((one) => one.state === "creating")) {
        const found = atMeta.findIndex((one) => one.subject === making.subject);
        if (found < 0) continue;
        const [one] = atMeta.splice(found, 1);
        await store.updateGroup(installation.phoneNumberId, making.ref, {
          groupId: one!.id,
          state: "active",
        });
      }
      kept = await store.groups(installation.phoneNumberId);
    }
    return { groups: kept.map(viewOf), most_people: 8 };
  };

  const activeGroup = async (installation: Installation, groupId: string) => {
    const group = await store.group(installation.phoneNumberId, groupId);
    if (!group) throw new Refusal(404, MANAGE_WORDS.groupUnknown);
    if (group.state === "suspended")
      throw new Refusal(409, MANAGE_WORDS.suspended);
    if (group.state !== "active") throw new Refusal(409, MANAGE_WORDS.notReady);
    return group;
  };

  const paths = {
    official: `${MANAGE_PATH}/official`,
    officialRequest: `${MANAGE_PATH}/official/request`,
    groups: `${MANAGE_PATH}/groups`,
    create: `${MANAGE_PATH}/groups/create`,
    link: `${MANAGE_PATH}/groups/link`,
    remove: `${MANAGE_PATH}/groups/delete`,
  };
  const routes: Record<string, Routes[string]> = {
    [`POST ${paths.official}`]: route(async (request) => {
      const { installation, token } = await authorized(request, statusSchema);
      return official(installation, token);
    }),
    [`POST ${paths.officialRequest}`]: route(async (request) => {
      const { body, installation, token } = await authorized(
        request,
        requestSchema,
      );
      const now = await dependencies.port.officialStatus(
        token,
        installation.phoneNumberId,
      );
      if (!MAY_REQUEST.has(now.status))
        throw new Refusal(409, MANAGE_WORDS.requestRunning);
      const asked = await dependencies.port.requestOfficial(
        token,
        installation.phoneNumberId,
        {
          country: body.country,
          website: body.website,
          ...(body.language ? { language: body.language } : {}),
          ...(body.links ? { links: body.links } : {}),
        },
      );
      logger.audit("admin.changed", {
        installation: externalIdOf(
          installation.wabaId,
          installation.phoneNumberId,
        ),
        reason: "official-business-account-requested",
      });
      return official(installation, token, asked);
    }),
    [`POST ${paths.groups}`]: route(async (request) => {
      const { installation, token } = await authorized(request, statusSchema);
      return groups(installation, token);
    }),
    [`POST ${paths.create}`]: route(async (request) => {
      const { body, installation, token } = await authorized(
        request,
        createSchema,
      );
      const made = await dependencies.port.createGroup(
        token,
        installation.phoneNumberId,
        body.subject,
      );
      await store.saveGroup({
        createdAt: new Date(dependencies.now()),
        phoneNumberId: installation.phoneNumberId,
        ref: randomBytes(12).toString("base64url"),
        state: made.groupId ? "active" : "creating",
        subject: body.subject,
        wabaId: installation.wabaId,
        ...(made.groupId ? { groupId: made.groupId } : {}),
        ...(made.requestId ? { requestId: made.requestId } : {}),
      });
      logger.audit("admin.changed", {
        installation: externalIdOf(
          installation.wabaId,
          installation.phoneNumberId,
        ),
        reason: "group-created",
      });
      return groups(installation, token);
    }),
    [`POST ${paths.link}`]: route(async (request) => {
      const { body, installation, token } = await authorized(
        request,
        linkSchema,
      );
      const group = await activeGroup(installation, body.group_id);
      const link = await dependencies.port.inviteLink(
        token,
        group.groupId!,
        body.reset === true,
      );
      if (body.reset)
        logger.audit("admin.changed", {
          installation: externalIdOf(
            installation.wabaId,
            installation.phoneNumberId,
          ),
          reason: "group-link-reset",
        });
      return { group_id: group.groupId, invite_link: link };
    }),
    [`POST ${paths.remove}`]: route(async (request) => {
      const { body, installation, token } = await authorized(
        request,
        deleteSchema,
      );
      const group = (await store.groups(installation.phoneNumberId)).find(
        (one) => one.ref === body.ref,
      );
      if (!group) throw new Refusal(404, MANAGE_WORDS.groupUnknown);
      if (group.groupId)
        try {
          await dependencies.port.deleteGroup(token, group.groupId);
        } catch (error) {
          // Gone at Meta already: forgotten here too.
          if (
            !(
              error instanceof MetaError &&
              error.code === META_CODES.groupUnknown
            )
          )
            throw error;
        }
      await store.deleteGroup(installation.phoneNumberId, group.ref);
      logger.audit("admin.changed", {
        installation: externalIdOf(
          installation.wabaId,
          installation.phoneNumberId,
        ),
        reason: "group-deleted",
      });
      return groups(installation, token);
    }),
  };
  for (const path of Object.values(paths))
    routes[`OPTIONS ${path}`] = preflight;
  return routes;
}
