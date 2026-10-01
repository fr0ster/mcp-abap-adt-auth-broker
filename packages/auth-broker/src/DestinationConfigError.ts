/**
 * A destination that lacks what its type needs (spec §4.4).
 *
 * Thrown by `getProvider` before any provider is asked: a missing field is a
 * fault no renewal cures, so it surfaces where the consumer builds its
 * connector, not at the first `connect()`.
 *
 * **It carries names, never values.** `missingFields` holds store field names
 * (`authType`, `username`, `sncQop`) or broker option names
 * (`serviceKeyStore`, `provider`); the message is fixed wording plus the
 * destination's name and those names. A stored value — a password, a token,
 * even an `authType` that is not one of the four — never reaches it. There is
 * no `cause`: a provider's own error quotes the value it refused (`qop … got
 * '7'`), so it is not carried; its field names are mapped instead.
 */
export class DestinationConfigError extends Error {
  readonly code = 'DESTINATION_CONFIG' as const;
  readonly destination: string;
  readonly missingFields: string[];

  /**
   * @param destination The destination's name, as the caller passed it.
   * @param missingFields Field or option names only.
   * @param reason Fixed wording: what is wrong, never a stored value.
   */
  constructor(destination: string, missingFields: string[], reason: string) {
    super(
      `Destination "${destination}": ${reason} (${missingFields.join(', ')})`,
    );
    this.name = 'DestinationConfigError';
    this.destination = destination;
    this.missingFields = [...missingFields];
    Object.setPrototypeOf(this, DestinationConfigError.prototype);
  }
}
