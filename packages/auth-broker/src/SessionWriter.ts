/**
 * The broker's writes of a destination's session secret, retried until the
 * store takes them (spec §6, H3).
 *
 * A store failure is the storage's or a broker bug, never the token's, so it
 * does not fail the authentication: the result stays pending for its
 * destination and the writer tries again on its own — it does not wait for the
 * provider to be called again, since a request may be the process's last.
 *
 * - **One pending result per destination, the latest.** A newer result
 *   replaces the one waiting; an older one is never written after it.
 * - **Attempts for one destination never overlap.** Each runs after the
 *   previous one has settled.
 * - **A growing delay:** one second after the first failure, doubling, capped
 *   at one minute; reset once a write lands. The timer is `unref()`ed, so a
 *   pending write never keeps a process alive.
 * - **Failures are logged by class name** — never a message: the store holds
 *   tokens, and its errors are foreign text.
 * - **`flush()`** gives every pending result one more attempt and rejects,
 *   naming the destinations, if any is still not written.
 */

import type { ILogger } from '@mcp-abap-adt/interfaces-utils';

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

interface Queue<T> {
  /** The result waiting to be written; undefined once written. */
  pending?: T;
  /** The last attempt, settled or not: the next one runs after it. */
  tail: Promise<void>;
  /** Consecutive failures since the last write that landed. */
  failures: number;
  lastError?: unknown;
  timer?: NodeJS.Timeout;
}

/** A thrown value's class, for a log line: never its message. */
export function classLabel(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor?.name || 'Error';
  }
  return typeof error;
}

/** `T`: what one write takes — the result, with what the broker writes beside it. */
export class SessionWriter<T> {
  private readonly queues = new Map<string, Queue<T>>();

  /**
   * @param write Writes one result for a destination; throws when the store
   *   does not take it.
   */
  constructor(
    private readonly write: (destination: string, result: T) => Promise<void>,
    private readonly logger: ILogger,
  ) {}

  /**
   * Take a new result for the destination and try to write it now. Never
   * throws: resolves once this attempt has settled, written or left pending.
   */
  async submit(destination: string, result: T): Promise<void> {
    const queue = this.queueOf(destination);
    queue.pending = result;
    this.cancelTimer(queue);
    await this.attempt(destination, queue);
  }

  /**
   * One more attempt for every pending result; resolves when all are written,
   * rejects naming the destinations still pending — each failure as its
   * destination and its error's class only, never the store's message. The
   * retries go on after a rejection.
   */
  async flush(): Promise<void> {
    const queues = [...this.queues];
    await Promise.all(
      queues.map(([destination, queue]) => {
        if (queue.pending === undefined) return queue.tail;
        this.cancelTimer(queue);
        return this.attempt(destination, queue);
      }),
    );
    const failed = queues.filter(([, queue]) => queue.pending !== undefined);
    if (failed.length > 0) {
      // The stores' own errors are not carried: their messages, causes and
      // properties are foreign text that may quote what was being written.
      throw new AggregateError(
        failed.map(
          ([destination, queue]) =>
            new Error(`"${destination}": ${classLabel(queue.lastError)}`),
        ),
        `Session writes still failing for ${failed
          .map(([destination]) => `"${destination}"`)
          .join(', ')}; the broker keeps retrying them`,
      );
    }
  }

  private queueOf(destination: string): Queue<T> {
    let queue = this.queues.get(destination);
    if (!queue) {
      queue = { tail: Promise.resolve(), failures: 0 };
      this.queues.set(destination, queue);
    }
    return queue;
  }

  /** Runs after the destination's previous attempt; never rejects. */
  private attempt(destination: string, queue: Queue<T>): Promise<void> {
    const run = queue.tail.then(() => this.writePending(destination, queue));
    queue.tail = run;
    return run;
  }

  private async writePending(
    destination: string,
    queue: Queue<T>,
  ): Promise<void> {
    const result = queue.pending;
    if (result === undefined) return;
    try {
      await this.write(destination, result);
    } catch (error) {
      queue.failures += 1;
      queue.lastError = error;
      const delay = Math.min(
        FIRST_DELAY_MS * 2 ** (queue.failures - 1),
        MAX_DELAY_MS,
      );
      this.logger.warn(
        `[AuthBroker] Session write for ${destination} failed; the token stands, the write is retried in ${delay} ms`,
        { error: classLabel(error), attempt: queue.failures },
      );
      this.schedule(destination, queue, delay);
      return;
    }
    queue.failures = 0;
    queue.lastError = undefined;
    // A newer result that arrived meanwhile stays pending: its own attempt is
    // queued after this one.
    if (queue.pending === result) {
      queue.pending = undefined;
      this.cancelTimer(queue);
    }
  }

  private schedule(destination: string, queue: Queue<T>, delay: number): void {
    this.cancelTimer(queue);
    const timer = setTimeout(() => {
      queue.timer = undefined;
      void this.attempt(destination, queue);
    }, delay);
    timer.unref();
    queue.timer = timer;
  }

  private cancelTimer(queue: Queue<T>): void {
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = undefined;
    }
  }
}
