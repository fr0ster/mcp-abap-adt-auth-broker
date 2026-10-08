/**
 * A destination that lacks what its type needs.
 *
 * Thrown by `getProvider` before any provider is asked: a missing field is a
 * fault no renewal cures, so it surfaces where the consumer builds its
 * connector, not at the first `connect()`.
 *
 * **It carries names, never values.** `missingFields` holds store field names
 * (`authType`, `username`, `sncQop`) or broker option names
 * (`serviceKeyStore`, `provider`, `renewal`); the message is fixed wording plus
 * the destination's name and those names. A stored value — a password, a
 * token, even an `authType` that is not one of the four — never reaches it.
 *
 * **When a provider or a strategy caused the refusal, its error is carried**
 * as auth-errors read it (`readFailure`): `error` — kind, facts, the words
 * auth-errors rendered and the diagnostics it admitted, nothing more. There is
 * no `cause`: no message of any thrown value reaches the broker's error. The
 * message then ends with `: <error.reason>`, the rendered words, never copied.
 */

import type { IAuthProviderError } from '@mcp-abap-adt/interfaces-auth';

export class DestinationConfigError extends Error {
  readonly code = 'DESTINATION_CONFIG' as const;
  readonly destination: string;
  readonly missingFields: string[];
  /**
   * Present when the refusal was caused by a provider's or a strategy's
   * failure: that error as auth-errors read it (`readFailure`), its
   * diagnostics kept when it came from this copy of auth-errors. An own
   * property only when present.
   */
  declare readonly error?: IAuthProviderError | undefined;

  /**
   * @param destination The destination's name, as the caller passed it.
   * @param missingFields Field or option names only.
   * @param reason Fixed wording: what is wrong, never a stored value.
   * @param error The provider's or strategy's error, read by `readFailure`.
   */
  constructor(
    destination: string,
    missingFields: string[],
    reason: string,
    error?: IAuthProviderError,
  ) {
    const words = error === undefined ? reason : `${reason}: ${error.reason}`;
    super(
      `Destination "${destination}": ${words} (${missingFields.join(', ')})`,
    );
    this.name = 'DestinationConfigError';
    this.destination = destination;
    this.missingFields = [...missingFields];
    if (error !== undefined) this.error = error;
    Object.setPrototypeOf(this, DestinationConfigError.prototype);
  }
}

/** What `isDestinationConfigError` vouches for: the fields, by structure. */
export interface DestinationConfigErrorLike {
  readonly name: 'DestinationConfigError';
  readonly code: 'DESTINATION_CONFIG';
  readonly destination: string;
  readonly missingFields: readonly string[];
}

/** An own data property's value; `undefined` for an accessor or an absent key. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

/**
 * Whether a value is a `DestinationConfigError` — or its JSON copy, or one
 * of another installed copy of this package — by structure only: own data
 * properties `name === 'DestinationConfigError'`, `code === 'DESTINATION_CONFIG'`,
 * a string `destination` and an array of strings `missingFields`. No
 * `instanceof`, no getter invoked; total — a Proxy whose traps throw answers
 * false.
 */
export function isDestinationConfigError(
  value: unknown,
): value is DestinationConfigErrorLike {
  try {
    if (typeof value !== 'object' || value === null) return false;
    if (ownData(value, 'name') !== 'DestinationConfigError') return false;
    if (ownData(value, 'code') !== 'DESTINATION_CONFIG') return false;
    if (typeof ownData(value, 'destination') !== 'string') return false;
    const fields = ownData(value, 'missingFields');
    return (
      Array.isArray(fields) &&
      fields.every((field: unknown) => typeof field === 'string')
    );
  } catch {
    return false;
  }
}
