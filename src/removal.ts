import {
  HostRefusedError,
  type DatalayerHostClient,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import { externalIdOf } from "./domain.js";
import type { MetaPort } from "./meta-port.js";
import {
  installationData,
  type Installation,
  type WhatsAppStore,
} from "./store.js";

/**
 * Disconnect and removal. A number stops being answered when its owner
 * disconnects it in Datalayer (its host key is then refused: found on use,
 * and by the daily reconciliation), when the business removes Datalayer
 * from its account at Meta (`account_update`), or when Meta refuses the
 * business token (code 190) on use. Each path marks the installation
 * removed once — the business token and PIN destroyed at once — revokes it
 * at Datalayer (`DELETE /apps/hosts/self`), takes Datalayer's app off the
 * business account's webhooks when no other number of the account is kept,
 * and the purge deletes every row of the number 24 hours later. Late work
 * of a removed number (a queued message, a delivery, a press) does nothing.
 * The number stays the business's.
 */

/** The audited grace before a removed number's rows are deleted. */
export const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** `account_update` events that end Datalayer's access to a business account. */
export const REMOVAL_EVENTS: ReadonlySet<string> = new Set([
  "PARTNER_REMOVED",
  "PARTNER_APP_UNINSTALLED",
  "ACCOUNT_DELETED",
]);

export type RemovalReason =
  | "account-update"
  | "token-refused"
  | "host-key-refused"
  | "reconciliation";

export type RemovalDependencies = Readonly<{
  store: WhatsAppStore;
  port: Pick<MetaPort, "unsubscribe">;
  hosts: Pick<DatalayerHostClient, "uninstalled" | "self">;
  cipher: SecretCipher;
  logger: Logger;
  now: () => number;
}>;

/** Remove one number: `false` when it was unknown or removed already. */
export async function removeInstallation(
  dependencies: RemovalDependencies,
  installation: Installation,
  why: RemovalReason,
): Promise<boolean> {
  const { store, cipher, logger } = dependencies;
  const { wabaId, phoneNumberId } = installation;
  // Read before the row forgets it: the business token is destroyed below.
  const token =
    installation.businessToken &&
    cipher.decrypt(
      installation.businessToken,
      installationData("business-token", wabaId, phoneNumberId),
    );
  if (
    !(await store.removeInstallation(
      wabaId,
      phoneNumberId,
      new Date(dependencies.now()),
    ))
  )
    return false;
  const externalId = externalIdOf(wabaId, phoneNumberId);
  // Datalayer revoked it already when it refused the key.
  if (why !== "host-key-refused" && why !== "reconciliation")
    try {
      await dependencies.hosts.uninstalled(
        cipher.decrypt(
          installation.hostKey,
          installationData("host-key", wabaId, phoneNumberId),
        ),
      );
    } catch (error) {
      // Removed here whatever Datalayer said; the purge deletes the key.
      logger.warn("removal.revoke_failed", { error });
    }
  // Meta already ended the access, or refused the token: nothing to undo there.
  const others = (await store.installations()).some(
    (one) =>
      one.wabaId === wabaId &&
      one.phoneNumberId !== phoneNumberId &&
      one.state !== "removed",
  );
  if (token && why !== "account-update" && why !== "token-refused" && !others)
    try {
      await dependencies.port.unsubscribe(token, wabaId);
    } catch (error) {
      logger.warn("removal.unsubscribe_failed", { error });
    }
  logger.audit("admin.changed", {
    installation: externalId,
    reason: `removed:${why}`,
  });
  return true;
}

const accountUpdateSchema = z.object({ event: z.string() }).loose();

/**
 * Meta's `account_update` for a business account: an event that ends
 * Datalayer's access removes every number of the account. Answers how many.
 */
export async function accountUpdated(
  dependencies: RemovalDependencies,
  wabaId: string,
  value: unknown,
): Promise<number> {
  const update = accountUpdateSchema.safeParse(value);
  if (!update.success || !REMOVAL_EVENTS.has(update.data.event.toUpperCase()))
    return 0;
  let removed = 0;
  for (const installation of await dependencies.store.installations())
    if (
      installation.wabaId === wabaId &&
      installation.state !== "removed" &&
      (await removeInstallation(dependencies, installation, "account-update"))
    )
      removed += 1;
  return removed;
}

/**
 * The daily reconciliation: every kept number whose host key Datalayer
 * refuses (its owner disconnected it) is removed. Answers how many were.
 */
export async function reconcile(
  dependencies: RemovalDependencies,
): Promise<number> {
  let removed = 0;
  for (const installation of await dependencies.store.installations()) {
    if (installation.state === "removed") continue;
    try {
      await dependencies.hosts.self(
        dependencies.cipher.decrypt(
          installation.hostKey,
          installationData(
            "host-key",
            installation.wabaId,
            installation.phoneNumberId,
          ),
        ),
      );
    } catch (error) {
      if (
        error instanceof HostRefusedError &&
        (error.status === 401 || error.status === 403)
      ) {
        if (
          await removeInstallation(dependencies, installation, "reconciliation")
        )
          removed += 1;
        continue;
      }
      dependencies.logger.warn("removal.reconcile_failed", { error });
    }
  }
  return removed;
}

/** Delete the rows of numbers removed 24 hours ago or more: how many numbers. */
export async function purgeRemoved(
  dependencies: Pick<RemovalDependencies, "store" | "logger" | "now">,
): Promise<number> {
  const before = dependencies.now() - PURGE_AFTER_MS;
  let purged = 0;
  for (const installation of await dependencies.store.installations("removed"))
    if (installation.removedAt && installation.removedAt.getTime() <= before) {
      const rows = await dependencies.store.purgeInstallation(
        installation.wabaId,
        installation.phoneNumberId,
      );
      dependencies.logger.audit("admin.changed", {
        installation: externalIdOf(
          installation.wabaId,
          installation.phoneNumberId,
        ),
        reason: "purged",
        rows,
      });
      purged += 1;
    }
  return purged;
}
