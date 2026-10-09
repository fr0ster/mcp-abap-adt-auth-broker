/**
 * The one way the broker logs: the consumer's `ILogger` behind a
 * wrapper whose every method never throws and never leaves an unhandled
 * rejection.
 *
 * The logger is the consumer's code. A method that throws, a method or a
 * getter for one that throws, or a method that answers a rejecting promise
 * (an async logger) changes nothing the broker does: a log line is never an
 * outcome. Without the wrapper a throwing `info` after a store took a write
 * would turn the landed write into a failed, pending one, and a throwing
 * `warn` would reject a `submit` that must never reject.
 *
 * Every argument reaches the consumer's method as given — the same count,
 * the same values — so a logger sees exactly what the broker wrote. Logging
 * stays fire-and-forget: an answer is never awaited, only adopted with a
 * no-op rejection handler.
 */

import type { ILogger } from '@mcp-abap-adt/interfaces-utils';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const ignore = (): void => {};

/**
 * Adopts what a log method answered, the way an `await` would — a native
 * promise, a subclass or any thenable — through a promise this module makes,
 * and handles its rejection. A `then` (or a getter for one) that throws is a
 * rejection like any other. Never throws.
 */
function settleQuietly(answer: unknown): void {
  if (
    (answer === null || typeof answer !== 'object') &&
    typeof answer !== 'function'
  ) {
    return;
  }
  try {
    new Promise<unknown>((resolve) => resolve(answer)).then(ignore, ignore);
  } catch {
    // Nothing a logger answers is the broker's outcome.
  }
}

/**
 * The consumer's logger, every method guarded; none given, a logger that
 * writes nothing.
 */
export function quietLogger(logger: ILogger | undefined): ILogger {
  const quiet = {} as ILogger;
  for (const level of LEVELS) {
    quiet[level] = (...args: [message: string, meta?: unknown]): void => {
      if (logger === undefined) return;
      try {
        const method: unknown = logger[level];
        if (typeof method !== 'function') return;
        settleQuietly(Reflect.apply(method, logger, args));
      } catch {
        // A log line is never an outcome.
      }
    };
  }
  return Object.freeze(quiet);
}
