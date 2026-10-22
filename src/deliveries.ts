import {
  receiveDelivery,
  type DatalayerHostClient,
  type DeliveryJob,
  type DeliverySink,
  type HostDelivery,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Approvals } from "./approvals.js";
import type { AsPerson, Person } from "./as-person.js";
import { targetSchema } from "./domain.js";
import { decidedWords } from "./render.js";
import { holdRef, PART_SPACING_MS, type Speaker } from "./speaker.js";
import {
  installationData,
  type ChatKey,
  type Installation,
  type WhatsAppStore,
} from "./store.js";
import type { WindowKeeper } from "./window.js";

/**
 * Datalayer's deliveries to a WhatsApp number: the kit's signed webhook and
 * outbox (`deliveryRoute`, `DeliveryPoller`, `receiveDelivery`: each
 * delivery handled once by its uid, then acknowledged), shown in the
 * person's chat through the window keeper — inside the 24-hour window at
 * once; outside it held by reference (the approval, or the session's
 * answer, both read again as the person when the window reopens) with one
 * notice. An approval is its card; a decision taken elsewhere is said; a
 * turn whose answer was not shown here (the worker lost it) is shown. A
 * removed number's deliveries are dropped unshown; a target this service
 * did not give, or another number's, shows nothing.
 */

/** The queue's job for one delivery of one installation. */
export type DeliveryQueueJob = DeliveryJob & Readonly<{ kind: "delivery" }>;

/** The store, as the kit's deliveries read it: a removed installation has no key. */
export function deliverySinkOf(
  store: WhatsAppStore,
  cipher: SecretCipher,
): DeliverySink {
  const keyOf = (installation: Installation) =>
    cipher.decrypt(
      installation.hostKey,
      installationData(
        "host-key",
        installation.wabaId,
        installation.phoneNumberId,
      ),
    );
  return {
    boundHosts: async () =>
      (await store.installations())
        .filter((one) => one.state !== "removed")
        .map((one) => ({ hostKey: keyOf(one), hostUid: one.hostUid })),
    deliverySecretOf: async (hostUid) => {
      const installation = await store.installationByHost(hostUid);
      return installation?.deliverySecret && installation.state !== "removed"
        ? cipher.decrypt(
            installation.deliverySecret,
            installationData(
              "delivery",
              installation.wabaId,
              installation.phoneNumberId,
            ),
          )
        : undefined;
    },
    hostKeyOf: async (hostUid) => {
      const installation = await store.installationByHost(hostUid);
      return installation && installation.state !== "removed"
        ? keyOf(installation)
        : undefined;
    },
  };
}

export type DeliveryDependencies = Readonly<{
  store: WhatsAppStore;
  cipher: SecretCipher;
  hosts: Pick<DatalayerHostClient, "acknowledge" | "self">;
  asPerson: AsPerson;
  speaker: Speaker;
  approvals: Approvals;
  window: WindowKeeper;
  clock: { now(): number };
  logger: Logger;
}>;

export class DeliveryHandler {
  constructor(readonly deps: DeliveryDependencies) {}

  /** One delivery of an installation, handled once, then acknowledged at Datalayer. */
  async receive(job: DeliveryJob): Promise<void> {
    const { store, cipher, hosts } = this.deps;
    await receiveDelivery(job, {
      claims: store,
      client: hosts,
      handle: async (delivery) => {
        const installation = await store.installationByHost(job.hostUid);
        if (installation && installation.state !== "removed")
          await this.handle(installation, delivery);
      },
      sink: deliverySinkOf(store, cipher),
    });
  }

  #person(
    installation: Installation,
    userId: string,
    deploymentUid: string,
  ): Person {
    return {
      deploymentUid,
      hostKey: this.deps.cipher.decrypt(
        installation.hostKey,
        installationData(
          "host-key",
          installation.wabaId,
          installation.phoneNumberId,
        ),
      ),
      userId,
    };
  }

  /** The application's name, as the installation allows it. */
  async appName(person: Person): Promise<string> {
    const self = await this.deps.hosts.self(person.hostKey);
    return (
      self.deployments.find((one) => one.uid === person.deploymentUid)
        ?.appName ?? "The application"
    );
  }

  async handle(
    installation: Installation,
    delivery: HostDelivery,
  ): Promise<void> {
    const target = targetSchema.safeParse(delivery.payload.target);
    if (
      !target.success ||
      target.data.phoneNumberId !== installation.phoneNumberId
    ) {
      this.deps.logger.warn("delivery.foreign_target", {
        delivery: delivery.delivery,
      });
      return;
    }
    const chat: ChatKey = {
      phoneNumberId: installation.phoneNumberId,
      userId: target.data.userId,
    };
    const person = this.#person(
      installation,
      target.data.userId,
      delivery.payload.deployment_uid,
    );
    switch (delivery.event) {
      case "approval.requested": {
        const appName = await this.appName(person);
        const id = delivery.payload.approval_id;
        await this.deps.speaker.reach(
          installation,
          chat,
          { kind: "approval", ref: holdRef(person.deploymentUid, id) },
          appName,
          () => this.deps.approvals.show(installation, person, id, appName),
        );
        return;
      }
      case "approval.decided": {
        const { approval_id: id, status } = delivery.payload;
        const card = await this.deps.store.card(
          chat.phoneNumberId,
          chat.userId,
          id,
        );
        // Decided here: said already. Never shown here: nothing to say.
        if (!card || card.decidedStatus) return;
        await this.deps.store.decideCard(
          chat.phoneNumberId,
          chat.userId,
          id,
          status,
        );
        // Said inside the window only; outside it, nothing is worth a notice.
        if (await this.deps.window.open(chat))
          await this.deps.speaker.say(installation, chat.userId, [
            {
              text: `${card.toolName}: ${decidedWords(status, false, this.deps.clock.now())}`,
              type: "text",
            },
          ]);
        return;
      }
      case "turn.completed": {
        const session = delivery.payload.session_uid;
        const kept = await this.deps.store.chat(chat);
        // Shown as it streamed, or by an earlier delivery: nothing more.
        if (kept?.unshownSessionUid !== session) return;
        const appName = await this.appName(person);
        await this.deps.speaker.reach(
          installation,
          chat,
          { kind: "delivery", ref: holdRef(person.deploymentUid, session) },
          appName,
          () => this.showAnswer(installation, chat, person, session),
        );
        return;
      }
    }
  }

  /** A session's last answer, shown once in the person's chat. */
  async showAnswer(
    installation: Installation,
    chat: ChatKey,
    person: Person,
    sessionUid: string,
  ): Promise<void> {
    const kept = await this.deps.store.chat(chat);
    if (kept?.unshownSessionUid !== sessionUid) return;
    const text = await this.deps.asPerson.lastAnswer(person, sessionUid);
    const messages = await this.deps.speaker.answer(
      installation,
      person,
      sessionUid,
      text ?? "",
    );
    if (!(await this.deps.store.markShown(chat, sessionUid))) return;
    await this.deps.speaker.say(
      installation,
      chat.userId,
      messages,
      PART_SPACING_MS,
    );
  }
}
