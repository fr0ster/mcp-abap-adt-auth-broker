/**
 * The broker's writes of a destination's session secret: one plain queue per
 * destination.
 *
 * - **One at a time, in order.** The writes of one destination run one after
 *   another, in the order they were queued, each writing what it was given;
 *   an older write never runs after, and so never overwrites, a newer one.
 *   Destinations never wait on each other.
 * - **Each write's own outcome.** A submission resolves with what its own
 *   write came to — landed, or the store's error — never with another
 *   submission's: no write is folded into another, so no caller is told
 *   "landed" for a write that never ran.
 * - **A failed write stays pending.** The destination then has a pending
 *   write: the latest one that failed — every write is built from its
 *   build's logical state, so the latest is the one that must land. It is
 *   retried by the destination's next write, which carries the same state
 *   and, once it lands, clears it; or by `retry()` / `flush()`, which write
 *   the pending one again. **There is no retry timer:** nothing is retried on
 *   its own, and nothing is scheduled.
 * - **The store's contract:** `saveSession` settles — resolves or rejects. A
 *   store that never settles holds its destination's queue; avoiding that is
 *   the consumer's. The writer builds no machinery against it.
 * - **Failures are logged once each, with `logFields`** of auth-errors'
 *   classification (`persisting-tokens`) — never a message: the store holds
 *   tokens, and its errors are foreign text. Each failed attempt is one
 *   `warn` line, written here only: the row's persistence is given no logger.
 *   A retry that fails again is a new attempt, and its own line.
 * - **`flush()`** retries every pending write once, after everything queued
 *   before it, and rejects naming the destinations still pending.
 */

import { classify, logFields } from '@mcp-abap-adt/auth-errors';
import type { IAuthProviderError } from '@mcp-abap-adt/interfaces-auth';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';

/** A failed write, kept until a later write of the destination lands. */
interface Pending<T> {
  readonly write: T;
  error: unknown;
}

interface Queue<T> {
  /** The last write queued, settled or not: the next one runs after it. */
  tail: Promise<unknown>;
  /** The latest write that failed and no later write has replaced. */
  pending?: Pending<T> | undefined;
}

/** What one write came to: it landed, or the store's error. */
export type WriteOutcome =
  | { readonly landed: true }
  | { readonly landed: false; readonly error: unknown };

const LANDED: WriteOutcome = Object.freeze({ landed: true });

/**
 * One destination whose session write still fails, in `flush()`'s
 * `AggregateError`: the destination and the store's error as auth-errors
 * classifies it (`persisting-tokens`) — never the store's message.
 */
export class SessionWriteFailure extends Error {
  readonly destination: string;
  /** `classify(storeError, 'persisting-tokens')`. */
  readonly error: IAuthProviderError;

  constructor(destination: string, storeError: unknown) {
    const error = classify(storeError, 'persisting-tokens');
    super(`"${destination}": ${error.reason}`);
    this.name = 'SessionWriteFailure';
    this.destination = destination;
    this.error = error;
    Object.setPrototypeOf(this, SessionWriteFailure.prototype);
  }
}

/** `T`: what one write takes — the result, with what the broker writes beside it. */
export class SessionWriter<T> {
  private readonly queues = new Map<string, Queue<T>>();

  /**
   * @param write Writes one result for a destination; throws when the store
   *   does not take it.
   * @param logger The broker's quiet logger (`quietLogger`): a line never
   *   throws and never rejects, so what a write came to is the store's answer
   *   alone, and `submit` / `retry` never reject.
   */
  constructor(
    private readonly write: (destination: string, result: T) => Promise<void>,
    private readonly logger: ILogger,
  ) {}

  /**
   * Queue `result` for the destination, after every write queued before it.
   * Never rejects: resolves once this write has settled, with what it came
   * to. Landed: the destination's pending write, if any — an older one — is
   * replaced. Failed: this write is the destination's pending one.
   */
  submit(destination: string, result: T): Promise<WriteOutcome> {
    return this.enqueue(destination, async (queue) => {
      try {
        await this.write(destination, result);
      } catch (error) {
        queue.pending = { write: result, error };
        this.logFailure(destination, error);
        return Object.freeze({ landed: false, error });
      }
      // Every write queued before this one has settled: a pending write is
      // older, and this one carries the state it was built from.
      queue.pending = undefined;
      return LANDED;
    });
  }

  /**
   * Wait for every write of the destination queued before this call, then
   * write its pending write once more, if one is left. Never rejects:
   * resolves landed when, by its turn, nothing is pending — every write
   * queued before it landed, or the latest of them did, replacing a failed
   * older one — else with the attempt's own outcome. It writes the pending
   * write as its turn finds it: the latest that failed.
   */
  retry(destination: string): Promise<WriteOutcome> {
    return this.enqueue(destination, async (queue) => {
      const pending = queue.pending;
      if (pending === undefined) return LANDED;
      try {
        await this.write(destination, pending.write);
      } catch (error) {
        // Nothing else ran meanwhile: the queue runs one write at a time.
        pending.error = error;
        this.logFailure(destination, error);
        return Object.freeze({ landed: false, error });
      }
      queue.pending = undefined;
      return LANDED;
    });
  }

  /**
   * One more attempt for every pending write, each after everything queued
   * for its destination before it; resolves when all landed, rejects naming
   * the destinations still pending — one `SessionWriteFailure` per
   * destination, never the store's message. What still fails stays pending.
   */
  async flush(): Promise<void> {
    const destinations = [...this.queues.keys()];
    await Promise.all(destinations.map((d) => this.retry(d)));
    const failed: [string, Pending<T>][] = [];
    for (const destination of destinations) {
      const pending = this.queues.get(destination)?.pending;
      if (pending !== undefined) failed.push([destination, pending]);
    }
    if (failed.length > 0) {
      // The stores' own errors are not carried: their messages, causes and
      // properties are foreign text that may quote what was being written.
      throw new AggregateError(
        failed.map(
          ([destination, pending]) =>
            new SessionWriteFailure(destination, pending.error),
        ),
        `Session writes still failing for ${failed
          .map(([destination]) => `"${destination}"`)
          .join(
            ', ',
          )}; each stays pending until its destination's next write or flush()`,
      );
    }
  }

  /** Runs `job` after the destination's last queued write has settled. */
  private enqueue(
    destination: string,
    job: (queue: Queue<T>) => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    let queue = this.queues.get(destination);
    if (!queue) {
      queue = { tail: Promise.resolve() };
      this.queues.set(destination, queue);
    }
    const own = queue;
    // `job` never rejects; the tail is chained whatever the previous came to.
    const run = own.tail.then(
      () => job(own),
      () => job(own),
    );
    own.tail = run;
    return run;
  }

  private logFailure(destination: string, error: unknown): void {
    this.logger.warn(
      `[AuthBroker] Session write for ${destination} failed; it stays pending until the destination's next write or flush()`,
      logFields(classify(error, 'persisting-tokens')),
    );
  }
}
