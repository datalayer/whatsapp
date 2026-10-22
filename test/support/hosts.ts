import {
  HostRefusedError,
  type BoundHost,
  type DatalayerHostClient,
  type HostSelf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * ai-agents' host routes as the service uses them, in memory: the
 * installation's deployments, links by BSUID, one-use link codes, binds,
 * the delivery address, acknowledgements and revocations. Every call is
 * recorded, for a test to count; a key in `refusedKeys` is refused (401),
 * as a disconnected installation's is.
 */
export class FakeHosts
  implements
    Pick<
      DatalayerHostClient,
      | "linkCode"
      | "self"
      | "unlink"
      | "linkState"
      | "acknowledge"
      | "uninstalled"
      | "bind"
      | "setWebhook"
    >
{
  readonly calls: string[] = [];
  readonly links = new Set<string>();
  readonly acknowledged: string[] = [];
  readonly uninstalledKeys: string[] = [];
  readonly refusedKeys = new Set<string>();
  /** Bind codes that were spent or expired. */
  readonly spentCodes = new Set<string>();
  readonly binds: Array<{ code: string; externalId: string; name?: string }> =
    [];
  readonly webhooks: string[] = [];
  codes = 0;
  self_: HostSelf = {
    accountUid: "account-1",
    channels: [],
    defaultDeployment: "dep-desk",
    deployments: [
      { appName: "Help Desk", kept: false, uid: "dep-desk" },
      { appName: "Billing", kept: false, uid: "dep-billing" },
    ],
    directOnly: [],
    paused: false,
    uid: "host-1",
  };

  #key(hostKey: string): void {
    if (this.refusedKeys.has(hostKey))
      throw new HostRefusedError(401, "unknown host", "Datalayer");
  }

  async self(hostKey: string): Promise<HostSelf> {
    this.calls.push(`self:${hostKey}`);
    this.#key(hostKey);
    return this.self_;
  }

  async linkCode(
    hostKey: string,
    externalUserId: string,
    externalUserName?: string,
  ): Promise<{ code: string; expiresIn: number }> {
    this.calls.push(
      `linkCode:${hostKey}:${externalUserId}:${externalUserName ?? ""}`,
    );
    this.#key(hostKey);
    this.codes += 1;
    return { code: `dlhc_code${this.codes}`, expiresIn: 600 };
  }

  async unlink(hostKey: string, externalUserId: string): Promise<number> {
    this.calls.push(`unlink:${hostKey}:${externalUserId}`);
    this.#key(hostKey);
    return this.links.delete(externalUserId) ? 1 : 0;
  }

  async linkState(
    hostKey: string,
    externalUserId: string,
  ): Promise<{ linked: boolean; principalUid?: string }> {
    this.calls.push(`linkState:${hostKey}`);
    this.#key(hostKey);
    return this.links.has(externalUserId)
      ? { linked: true, principalUid: `principal-${externalUserId}` }
      : { linked: false };
  }

  async acknowledge(hostKey: string, deliveryUid: string): Promise<void> {
    this.#key(hostKey);
    this.acknowledged.push(deliveryUid);
  }

  async uninstalled(hostKey: string): Promise<void> {
    this.uninstalledKeys.push(hostKey);
  }

  async bind(input: {
    code: string;
    externalId: string;
    name?: string;
  }): Promise<BoundHost> {
    this.binds.push(input);
    if (this.spentCodes.has(input.code))
      throw new HostRefusedError(
        400,
        "The code was used or expired.",
        "Datalayer did not bind",
      );
    this.spentCodes.add(input.code);
    return {
      defaultDeployment: "dep-desk",
      hostKey: `dlhk_bound-${this.binds.length}`,
      hostUid: `host-bound-${this.binds.length}`,
      ...(input.name ? { name: input.name } : {}),
    };
  }

  async setWebhook(
    hostKey: string,
    url: string,
  ): Promise<{ signingSecret: string; version: number }> {
    this.#key(hostKey);
    this.webhooks.push(url);
    return { signingSecret: "dlws_test-only-signing-secret", version: 1 };
  }
}
