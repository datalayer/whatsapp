import type { WorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * A queue that keeps what it is given and runs nothing: what the ingress
 * enqueued, under which key, for a test to read. Its claims behave as the
 * durable queue's (a second job under a key is refused); `failures` makes
 * the next enqueues throw, as a database that is down would.
 */
export class RecordingQueue<T> implements WorkQueue<T> {
  readonly items: { item: T; key?: string }[] = [];
  readonly #keys = new Set<string>();
  failures = 0;

  async enqueue(item: T, idempotencyKey?: string): Promise<boolean> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("The database is down.");
    }
    if (idempotencyKey) {
      if (this.#keys.has(idempotencyKey)) return false;
      this.#keys.add(idempotencyKey);
    }
    this.items.push({
      item,
      ...(idempotencyKey ? { key: idempotencyKey } : {}),
    });
    return true;
  }

  async ready(): Promise<boolean> {
    return true;
  }

  start(): void {}

  async stop(): Promise<void> {}
}
