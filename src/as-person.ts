import {
  hostSessionOf,
  lastAnswer,
  type ApprovalPresentation,
  type DatalayerHostClient,
  type HostKeyCredentials,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { transcribe, type Recording } from "./speech.js";

/**
 * Datalayer as one person of a chat: the installation's host key exchanged
 * for that person's fifteen-minute host token on one deployment, then an
 * approval read or decided, a session's last answer read, a one-use
 * *Open in Datalayer* code made, or a voice note heard, as them. A person who is not linked, or not
 * the one an approval waits on, is refused by Datalayer, never decided for
 * by the service. Tests give the worker a fake.
 */

/** Who acts: the installation's key, the person (their BSUID), the deployment. */
export type Person = Readonly<{
  hostKey: string;
  userId: string;
  deploymentUid: string;
}>;

export interface AsPerson {
  /** How an approval is shown, read as the person (404 when it is not theirs). */
  presentation(
    person: Person,
    approvalId: string,
  ): Promise<ApprovalPresentation>;
  /** Decide an approval as the person, on the very presentation shown (its digest). */
  decide(
    person: Person,
    approvalId: string,
    decision: Readonly<{ approve: boolean; digest: string }>,
  ): Promise<{ status: string }>;
  /** The session's last answer, read as the person: `undefined` when it has none. */
  lastAnswer(person: Person, sessionUid: string): Promise<string | undefined>;
  /**
   * *Open in Datalayer*: a one-use code for the person that opens one
   * session or approval after sign-in; the landing's path that redeems it.
   */
  handoff(
    person: Person,
    kind: "session" | "approval",
    target: string,
  ): Promise<string>;
  /** A voice note heard as the person by Datalayer's speech service (WA-18): its words. */
  hear(person: Person, recording: Recording): Promise<string>;
}

/** `AsPerson` over ai-agents' host routes and the session API. */
export function httpAsPerson<P>(
  credentials: Pick<HostKeyCredentials<P>, "exchangeFor">,
  hosts: Pick<DatalayerHostClient, "presentation" | "decide" | "handoff">,
  apiUrl: string,
  fetchImplementation: typeof fetch = fetch,
): AsPerson {
  const tokenOf = async (person: Person) =>
    credentials.exchangeFor({
      deploymentUid: person.deploymentUid,
      externalUserId: person.userId,
      hostKey: person.hostKey,
    });
  return {
    decide: async (person, approvalId, decision) =>
      hosts.decide((await tokenOf(person)).access_token, approvalId, decision),
    hear: async (person, recording) =>
      transcribe(
        fetchImplementation,
        apiUrl,
        (await tokenOf(person)).access_token,
        recording,
      ),
    handoff: async (person, kind, target) =>
      (await hosts.handoff((await tokenOf(person)).access_token, kind, target))
        .path,
    lastAnswer: async (person, sessionUid) => {
      const host = hostSessionOf(await tokenOf(person));
      const text = await lastAnswer(fetchImplementation, host, sessionUid);
      if (text === null)
        throw new Error("Datalayer did not answer the session's messages.");
      return text;
    },
    presentation: async (person, approvalId) =>
      hosts.presentation((await tokenOf(person)).access_token, approvalId),
  };
}
