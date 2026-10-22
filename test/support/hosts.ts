import type {
  DatalayerHostClient,
  HostSelf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * ai-agents' host routes as the commands use them, in memory: the
 * installation's deployments, links by BSUID, and one-use link codes. Every
 * call is recorded, for a test to count.
 */
export class FakeHosts
  implements Pick<DatalayerHostClient, "linkCode" | "self" | "unlink">
{
  readonly calls: string[] = [];
  readonly links = new Set<string>();
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

  async self(hostKey: string): Promise<HostSelf> {
    this.calls.push(`self:${hostKey}`);
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
    this.codes += 1;
    return { code: `dlhc_code${this.codes}`, expiresIn: 600 };
  }

  async unlink(hostKey: string, externalUserId: string): Promise<number> {
    this.calls.push(`unlink:${hostKey}:${externalUserId}`);
    return this.links.delete(externalUserId) ? 1 : 0;
  }
}
