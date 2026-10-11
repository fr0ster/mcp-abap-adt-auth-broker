/**
 * What the CLI does when a session store refuses the stored session.
 *
 * auth-stores 5 refuses a stored session that is not of the store's format
 * (a token or cookies without both binding keys, an expiry that is not epoch
 * milliseconds, cookies that are not the writer's base64) with a
 * `StorageError` whose `reason` is `'record-format'`. The broker reads the
 * session before anything else and passes the refusal on as it is.
 *
 * A run over a session file (`--env`, or a session `--destination` finds)
 * then discards that session in its private work copy — the session keys
 * alone, through the store's own `deleteSession`, every means line kept byte
 * for byte — and logs in anew, once. The original is written only after the
 * login's secret is stored, as on any run.
 *
 * Everything here is recognised by structure (own data properties), never by
 * `instanceof` or a message: the store's message, and its `cause`, are never
 * read.
 */

import type { DestinationFiles } from './destination';

/** An own data property's value; `undefined` for an accessor or a throwing Proxy. */
function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a thrown value is a store's `StorageError`: own `code === 'STORAGE_ERROR'`. */
export function isStorageError(thrown: unknown): boolean {
  return ownData(thrown, 'code') === 'STORAGE_ERROR';
}

/** Whether a thrown value is a store's refusal of a record not of its format. */
export function isRecordFormatRefusal(thrown: unknown): boolean {
  return (
    isStorageError(thrown) && ownData(thrown, 'reason') === 'record-format'
  );
}

/** The fixed line a discarded session is announced with: the destination's name, no value of the record. */
export function discardLine(destination: string): string {
  return `⚠️  The stored session for "${destination}" is not in the store's format; logging in anew`;
}

/**
 * Discards the session of the run's private work copy: the store removes its
 * own keys — the token or cookies, the expiry, the refresh token and both
 * binding keys — and leaves every other line as it is. The original file is
 * never touched here.
 */
export async function discardSession(
  files: DestinationFiles,
  destination: string,
  write: (line: string) => void,
): Promise<void> {
  write(discardLine(destination));
  await files.sessionStore.deleteSession(destination);
}

/** The brand of `SessionStoreFailure`: module-private, so only this module sets it. */
const SESSION_STORE_FAILURE = Symbol('mcp-auth session store failure');

/**
 * A store's `StorageError` met by a run, carried to the printer with the
 * destination and the facts the CLI names — never the store's message or
 * cause.
 */
export class SessionStoreFailure {
  readonly [SESSION_STORE_FAILURE] = true;
  readonly destination: string;
  /** Whether the store refused the record as not of its format. */
  readonly recordFormat: boolean;
  /** The store's own `operation`, when it is `read` or `write`. */
  readonly operation: 'read' | 'write' | undefined;
  /** The thrown value, kept only for its allowlisted system code. */
  readonly thrown: unknown;

  constructor(destination: string, thrown: unknown) {
    this.destination = destination;
    this.recordFormat = isRecordFormatRefusal(thrown);
    const operation = ownData(thrown, 'operation');
    this.operation =
      operation === 'read' || operation === 'write' ? operation : undefined;
    this.thrown = thrown;
  }
}

/** Whether a caught value is a `SessionStoreFailure` — by its brand. */
export function isSessionStoreFailure(
  value: unknown,
): value is SessionStoreFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [SESSION_STORE_FAILURE]?: unknown })[SESSION_STORE_FAILURE] ===
      true
  );
}

/** A store's `StorageError` as the run's failure for `destination`; anything else as it is. */
export function asRunFailure(destination: string, thrown: unknown): unknown {
  return isStorageError(thrown)
    ? new SessionStoreFailure(destination, thrown)
    : thrown;
}
