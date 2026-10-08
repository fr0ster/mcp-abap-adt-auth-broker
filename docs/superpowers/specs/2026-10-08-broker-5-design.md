# auth-broker 5.0.0 and auth-broker-cli 3.0.0 — design spec

Answers [`../2026-10-08-broker-5-goal.md`](../2026-10-08-broker-5-goal.md).
Every item of the goal's *Holds throughout* (H1–H8 below, in its order) binds
this spec; §14 says how each is honoured. Where the spec would have to depart
from one, the goal changes first. Choices that neither the goal, the user's
standing rules nor the code dictate are marked **(D*n*)** where they are made,
and listed with their options and a recommendation in §15, *Decisions for the
user*. The design below is written as if each recommendation is taken.

Line and file references are to the broker worktree at `0b6b4b5`
(`packages/auth-broker/src/…`, `packages/auth-broker-cli/src/…`). Contracts
are the published ones: auth-providers 6.0.0, auth-stores 4.0.0,
interfaces-auth 7.5.0, interfaces-auth-sap 3.3.0, interfaces-auth-broker
1.3.0, auth-errors 2.1.1, connection 14.0.0.

## 0. Contents

1. Traceability: goal → sections
2. Versions and dependencies
3. Errors
4. Renewal
5. Session writes and the refresh state
6. A credential stays bound to its identity
7. Cancellation
8. Logging and debug output (library)
9. The library's public API, in one place
10. The CLI
11. Migration notes
12. Release order
13. Tests and measurements
14. Goal invariants: how each holds
15. Decisions for the user

## 1. Traceability: goal → sections

| Goal item | Answered in |
|---|---|
| Open 1 — where renewal and the persistence choice live; what a consumer giving neither gets | §4.1, §4.3, §5.4; D1, D2, D3 |
| Open 2 — refresh state across writes, failures, retries, restarts; relation to `refreshStatePersistence`; how the consumer states its choice | §5 |
| Open 3 — cancellation: `getProvider`'s signal, the token API, a cached provider after every caller left | §7 |
| Open 4 — the CLI's browser option per platform | §10.3; D13, D14, D15 |
| Open 5 — the broker's configuration errors: shape, what they carry | §3.2; D7 |
| Open 6 — the CLI's debug flag and the broker option behind it | §8.2, §10.7; D17 |
| Open 7 — versions, release order, migration notes | §2, §11, §12 |
| Success: failures reach the consumer as the provider made them | §3 |
| Success: renewal is chosen | §4 |
| Success: session writes follow the refresh state | §5.2–§5.3, §5.6 |
| Success: the consumer decides what a failed write means | §5.4 |
| Success: every wait can be cancelled by whoever waits | §7 |
| Success: the CLI ends a login only when the user does | §10.4 |
| Success: the CLI reaches what 6.0.0 offers | §10.3, §10.5 |
| Success: debug output is opt-in and safe | §8.2, §10.7 |
| Success: the CLI still writes the credentials it exists to write | §10.8 |
| Success: both packages install from the registry alone | §2, §12 |
| H3 — a credential stays bound to its identity | §6 |

## 2. Versions and dependencies

Both packages are majors: what every failure is changes class, two options
become required for token destinations, and the CLI's output and flags change.

**`@mcp-abap-adt/auth-broker` 5.0.0** (`packages/auth-broker/package.json`):

| Dependency | 4.1.0 | 5.0.0 |
|---|---|---|
| `@mcp-abap-adt/auth-providers` | `^5.3.0` | `^6.0.0` |
| `@mcp-abap-adt/auth-errors` | — | `^2.1.1` (new: `readFailure`, `classify`, `isAuthProviderFailure`, `AuthProviderFailure`, `authError`, `sharedAttempt`, `logFields`, `render`) |
| `@mcp-abap-adt/interfaces-auth` | `^3.2.0` | `^7.5.0` |
| `@mcp-abap-adt/interfaces-auth-broker` | `^1.2.0` | `^1.3.0` |
| `@mcp-abap-adt/interfaces-auth-sap` | `^2.0.0` | `^3.3.0` |
| `@mcp-abap-adt/interfaces-utils` | `^1.1.0` | `^1.1.0` |
| dev: `@mcp-abap-adt/auth-stores` | `^3.3.0` | `^4.0.0` |
| dev: `@mcp-abap-adt/connection` | `^10.0.3` | `^14.0.0` |
| dev: `@mcp-abap-adt/auth-mocks`, `logger` | `^0.3.0`, `^0.4.0` | unchanged |

**`@mcp-abap-adt/auth-broker-cli` 3.0.0**:

| Dependency | 2.1.0 | 3.0.0 |
|---|---|---|
| `@mcp-abap-adt/auth-broker` | `^4.1.0` | `^5.0.0` |
| `@mcp-abap-adt/auth-providers` | `^5.3.0` | `^6.0.0` |
| `@mcp-abap-adt/auth-stores` | `^3.3.0` | `^4.0.0` |
| `@mcp-abap-adt/auth-errors` | — | `^2.1.1` (new: `readFailure`, `isAuthProviderFailure`, `renderDiagnostics`) |
| `@mcp-abap-adt/interfaces-auth` | `^3.2.0` | `^7.5.0` |
| `@mcp-abap-adt/interfaces-utils` | `^1.1.0` | `^1.1.0` |
| `@mcp-abap-adt/logger` | `^0.4.0` | removed if D16 is taken (its `DefaultLogger` writes `info`/`debug` to stdout) |

`tools/check-graph.js` gets the new allowlist entries (`auth-errors` for both
packages). One copy of `interfaces-auth` and of `auth-errors` must resolve in
the workspace: `npm ls` of each shows one deduplicated version (a second copy
is exactly the case §3.1 must survive, but it must not be how the workspace
itself is installed). `tools/check-provider-shape.mjs` is copied
byte-identically from the published `@mcp-abap-adt/auth-errors` 2.1.1
`tools/` and run with `--rules 4,5,6` over both packages' `src` (the broker
implements no `IAuthProvider`, so rules 1–3 do not apply), with a test
comparing the copy to the installed original byte for byte.

## 3. Errors

### 3.1 What the broker relays, and how it reads a failure

- **A provider's failure passes as the same object.** Whatever a provider the
  broker built or was given throws from `getTokens()` / `refreshTokens()` —
  an `AuthProviderFailure` — `getToken()` / `refreshToken()` rethrow unchanged:
  the same object, so kind, facts, words and diagnostics are the provider's.
  The moments of a provider handed out by `getProvider` are never wrapped
  (§7.2), so their outcomes reach the connector as the provider made them.
- **The broker reads a failure only through auth-errors.** Where it must
  decide on a caught value it calls `readFailure(thrown, operation)` and reads
  `kind` / `facts`; where it must know whether a value is a failure,
  `isAuthProviderFailure(value)`. No `instanceof`, no `message`, no `name` of
  an error is read anywhere in `src` of either package (a source test, §13).
  A failure of another installed copy of auth-errors is therefore read the
  same way (its diagnostics dropped by `readFailure`, as auth-errors
  documents).
- **What 4.x decided by class, 5.0.0 decides by kind:**

| Site (4.1.0) | 4.1.0 | 5.0.0 |
|---|---|---|
| `destinations.ts:247-255`, SNC settings refused | `error instanceof ValidationError`, fields mapped through `SNC_FIELDS` | `readFailure(error, 'resolving-snc-library')`; `kind === 'configuration'` → `facts.fields` mapped through `SNC_FIELDS`, the error carried (§3.2); any other kind → carried with `missingFields: ['sncPartnerName','sncQop','sncLib','sncMyName']` restricted to those the means state |
| `destinations.ts:722-738`, validator construction | caught, fixed words | the same fixed words and `samlIdpCertificates`, the provider's error carried (`readFailure(error, 'validating-assertion')`) |
| `clientAuthentication.ts:77-80`, `:220-226` | the broker's copy of three certificate phrases, chosen by `CertificateMaterialError` flags | deleted; `resolveClientAuthentication` carries `readFailure(error, 'client-authentication-strategy')` (§3.2) |
| `SessionWriter.ts:40-46` `classLabel` | `error.constructor.name` | deleted; a failed write is logged with `logFields(classify(error, 'persisting-tokens'))` (§8.1) |
| `AuthBroker.ts:390-400` `checked` | `new Error('Token provider did not return authorization token …')` | `new AuthProviderFailure(authError['request-failed']({ operation: 'token-source', problem: 'no-access-token' }))` — "the token source returned no access_token" |
| `AuthBroker.ts:381-387` `errorCode` | reads `code` | unchanged: `STORE_ERROR_CODES.FILE_NOT_FOUND` on a store's error is the store contract's answer for absence, not a failure reading |

- **A provider's constructor that throws inside a build** (any row) becomes a
  `DestinationConfigError` naming the store fields its configuration facts
  name, mapped to store field names through each row's field map, and carrying
  the provider's error (§3.2). 4.x let a provider's `ValidationError` escape
  `getProvider` raw for rows other than SNC; a build now refuses one way.

### 3.2 `DestinationConfigError` (Open 5; D7)

Its shape stays a class of the broker's — the configuration facts of
interfaces-auth admit only `CONFIG_FIELDS`, which do not hold the store's field
names (`sncPartnerName`, `uaaClientId`) or the broker's options
(`serviceKeyStore`, `renewal`), so it cannot be an `AuthProviderFailure`
without a change to interfaces-auth, which is out of scope.

```ts
export class DestinationConfigError extends Error {
  readonly name: 'DestinationConfigError';
  readonly code: 'DESTINATION_CONFIG';
  readonly destination: string;
  /** Store field names or broker option names; never a value. */
  readonly missingFields: string[];
  /**
   * Present when the refusal was caused by a provider's or a strategy's
   * failure: that error as auth-errors read it (`readFailure`), minted, its
   * diagnostics kept when it came from this copy of auth-errors.
   */
  readonly error?: IAuthProviderError | undefined;
}

/** Structural: own data `name === 'DestinationConfigError'`, `code`, `destination`, `missingFields`. No `instanceof`. */
export function isDestinationConfigError(value: unknown): value is DestinationConfigErrorLike;
```

- **Message:** `Destination "<destination>": <reason> (<fields>)`, as 4.x.
  `reason` is the broker's fixed configuration wording (every row of the
  README's table keeps its words) — and when `error` is present, the fixed
  wording followed by `: ` and `error.reason` (the words auth-errors rendered,
  never copied): e.g. `the clientAuthentication strategy failed: the client
  certificate has expired`. `error.hint` is not in the message; a consumer
  reads it from `error`, and the CLI prints it (§10.9).
- **`error` carries what the provider's error carries, nothing more:** kind,
  facts, the rendered words and the admitted diagnostics. No `cause`, no
  message of any thrown value; a strategy's own error reaches it only as its
  classification (`unknown`, `client-authentication-strategy`, an allowlisted
  code at most).
- **Kept as the broker's own words:** `ClientUnavailableError`'s two reasons
  ("the destination has no client certificate / secret"), `CERTIFICATE_HINT`,
  and every row reason. They are the broker's configuration language, not a
  provider's; none copies a provider's words.
- **New rows** (fixed wording, names only):

| Case | `missingFields` |
|---|---|
| a token row built with no `renewal` option | `renewal` |
| a destination that writes a secret (a token row, or the token API) and no `onWriteFailure` option | `onWriteFailure` |
| a provider's constructor refused the configuration the row gave it | the store fields it names (row field maps), `error` carried |
| the token API with a consumer instance after the destination's identity changed (§6.3) | `provider` |

### 3.3 Failures the broker makes itself

Every one is an `AuthProviderFailure` minted by auth-errors — no new free
words:

- **Aborted waits** (§7): the failure `sharedAttempt` rejects a waiter with —
  `interactive-login`, `outcome: 'aborted'` ("the authorization was
  aborted"). This is the only failure a waiter of the broker's slots gets from
  `sharedAttempt` itself: every other outcome of a shared start is carried out
  of the slot as a value and rethrown as it was thrown (§7.1), so no error of
  §3.2, §3.4 or of a store passes through `classify` on its way.
- **A session write that did not land, where the consumer chose `'fail'`**
  (§5.4): `new AuthProviderFailure(classify(storeError, 'persisting-tokens'))`
  — "persisting the tokens failed (unknown error[, CODE])", the code only when
  it is allowlisted. For a provider the broker built, the provider itself
  answers this (the awaited report), and the broker relays it as it is (§3.1).
- **A token source that answered no token:** §3.1's table.

### 3.4 What is not an auth failure

- **A store's read failure** (anything but `FILE_NOT_FOUND`) reaches the caller
  as the store raised it — the consumer's own collaborator's error, returned
  to it, as in 4.x (H6, H8). The README says that the broker relays it
  unchanged and that its text is the store's. **(D8)**
- **The constructor's argument checks** (`AuthBroker: sessionStore is
  required`, …) stay plain `Error`s / `TypeError`s: a programming error of the
  consumer, naming option names only.
- **`flush()`** rejects with an `AggregateError` whose message keeps 4.x's
  words ("Session writes still failing for "<destination>", …; the broker keeps
  retrying them") and whose `errors` are one `SessionWriteFailure` per
  destination **(D9)**:

```ts
export class SessionWriteFailure extends Error {
  readonly name: 'SessionWriteFailure';
  readonly destination: string;
  /** classify(storeError, 'persisting-tokens'). */
  readonly error: IAuthProviderError;
  // message: `"<destination>": ${error.reason}`
}
```

## 4. Renewal

### 4.1 Where it lives (Open 1; D1)

```ts
/** Every grant that obtains a secret: DestinationGrant without 'none'. */
export type TokenGrant = Exclude<DestinationGrant, 'none'>;

interface AuthBrokerConfig {
  /**
   * How the provider the broker builds for a destination renews: called once
   * per build of every token row, with the destination and the grant it
   * states. Required for those rows: the broker has no default.
   */
  renewal?: ((destination: string, grant: TokenGrant) => IRenewalStrategy) | undefined;
}
```

It is a function of the destination, like every other collaborator option of
`AuthBrokerConfig` (`authorization`, `oidcAuthorization`, …): one shape covers
"the same for all" (`renewal: () => refreshThenLogin()`) and "per destination
or grant" (e.g. `refreshOnly()` for a headless destination,
`refreshThenLogin()` for `client_credentials`, whose grant has no refresh). It
is not read from the stores: no store field carries it, and the stores are out
of scope.

### 4.2 How it reaches the providers

- Every token row (`uaaProvider`, `oidcProvider`, `samlProvider`) calls
  `renewal(destination, grant)` once per build, after every other check of the
  row has passed and before the provider's constructor; the answer is passed
  as the provider's `renewal`, unchanged. The broker never wraps, inspects or
  calls it; whether it is usable is the provider's judgement (a provider
  refuses one whose `next` is not a function — `configuration`
  `required-fields-missing`, `renewal`), surfaced as a `DestinationConfigError`
  naming `renewal` and carrying that error (§3.1).
- A `renewal` that throws is a `DestinationConfigError(['renewal'])`, fixed
  words "the renewal option failed", carrying `readFailure(error,
  'renewal-strategy')`; nothing is built or cached.
- **Not called** for `basic`, `snc`, `jwt`/`none`, `saml`/`none` (no renewal),
  and never for the token API's consumer `provider` — an instance or a
  factory's result is the consumer's composition; it brings its own renewal.

### 4.3 A consumer that gives none (D2)

Refused, named: a token row's build throws `DestinationConfigError` with
`missingFields: ['renewal']` (together with every other missing field and
option of the row, in one error, as 4.x does), before any collaborator is
called and before anything is cached. `basic`/`snc`/`none` destinations build
without it. There is no default (H1): `refreshThenLogin()` is what 4.x did,
and the migration note says to pass it (§11.1).

## 5. Session writes and the refresh state

### 5.1 The persistence the broker builds (Open 1, Open 2)

For every token row, the broker builds the provider's `persistence` from
auth-providers' own strategy — no second implementation of the refresh state
(H5):

```ts
persistence: refreshStatePersistence(write, { onWriteFailure, logger })
```

- `onWriteFailure` is the consumer's `AuthBrokerConfig.onWriteFailure`,
  passed as given (§5.4).
- `write(tokens: PersistedTokens)` submits one session write for the
  destination to the broker's `SessionWriter` (§5.3) and resolves when that
  attempt landed, or rejects with the store's error when it did not — so
  `refreshStatePersistence` keeps its logical state (`held` / `cleared`) and its
  pending delivery, and the `SessionWriter` keeps the destination's latest
  pending write and retries it.
- `onTokens` is gone from every row (auth-providers 6.0.0 removed it). The
  broker's `failedWrites` `WeakMap` keyed by result object goes with it on this
  path: the awaited report is what makes the obtaining call fail.

A consumer cannot give the broker a persistence strategy of its own for the
providers the broker builds: the broker writes the binding beside the secret
(§6), and only its own write path knows it.

### 5.2 What one write is

`write(tokens)` becomes one `saveSession(destination, secret)` built from
`tokens` and from nothing else of the provider. auth-stores 4.0.0's
`saveSession` **merges**: a field left out keeps what is stored, whoever stored
it. So no write the broker makes leaves the refresh token or the binding to the
merge — every write states both, or (a credential-free write) states neither
binding field and clears the refresh token:

| `PersistedTokens` | Written |
|---|---|
| `tokenType: 'saml'` (`saml2_pure`) | `sessionCookies: authorizationToken`, `expiresAt`, **`refreshToken: ''`** — SAML has none, and a refresh token stored beside earlier cookies or a token is not this credential's |
| any other, `authorizationToken !== ''` | `authorizationToken`, `expiresAt`, and the refresh token by the rows below |
| `refreshToken: <string>` | that refresh token |
| `refreshToken: null` | `refreshToken: ''` — auth-stores 4.0.0's clearing operation; the stored one is never read |
| `refreshToken: undefined` | the stored refresh token **written explicitly as its value** when the session read at write time is bound to this build's identity (§6); **otherwise `refreshToken: ''`** — never omitted, so a refresh token obtained under other means can never end up beside this credential and its binding |
| beside every credential | `issuedFor` / `issuedBy` of the build's binding (§6), each written as `''` when the means lack its source — never left out, so no earlier binding survives the merge beside a new credential |
| `authorizationToken === ''` (a discard before any credential is held — a credential-free write) | **only `refreshToken: ''`**: no credential field, no `expiresAt`, no binding field. The stored credential, whatever identity it was obtained for, keeps its own binding — the write never re-labels it — and loses its refresh token, which the provider discarded |

Carrying a stored refresh token therefore never changes its binding: it is
written only beside the binding it was already bound to. Every other refresh
token in the store at write time is cleared by the write.

`expiresAt` is the report's (`ReportedCredential.expiresAt`, absolute); the
broker no longer derives one from `expiresIn` on this path. A destination the
key store states as `basic` or `snc` at write time is still not written (4.x,
`AuthBroker.ts:1261-1272`).

### 5.3 Failed writes, retries and order

`SessionWriter` keeps its 4.x rules — one pending write per destination, the
latest replacing an older one; attempts for one destination never overlapping;
a retry after 1 s doubling to 60 s on an `unref()`ed timer (a retry delay, not a
bound on anyone's wait: nobody waits on the timer, H4) — and gains two:

- **Generation.** Every build of a destination (§6) takes a generation from a
  per-destination counter; every submission carries its build's generation. A
  submission whose generation is older than the newest one already submitted
  for that destination is dropped, and a pending one is replaced only by a
  submission of the same or a newer generation. So a late write of a provider
  retired by a means change never overwrites what the provider built for the
  new means wrote (H3; goal "does not overwrite a newer one").
- **Within one generation, report order.** `refreshStatePersistence`
  serialises its reports per provider; the writer applies them in submission
  order and keeps only the latest pending. Since every write is built from the
  logical state, the latest pending write is always the one that must land: a
  failed `''` followed by a `credential` / `none` report is written again as
  `''` (state `cleared`); a failed new refresh token is written again with that
  token by the next report; a newer refresh token or a discard supersedes it.

**Not lost while the process lives:** a write that failed stays pending in the
writer until it lands or a newer one of the same or a newer generation replaces
it, whether or not another report comes; `flush()` gives each pending write one
more attempt and names the destinations still failing (§3.4).

### 5.4 What a failed write means: `onWriteFailure` (Open 2; D3)

```ts
interface AuthBrokerConfig {
  /**
   * What a session write that did not land means. Required for every
   * destination that writes a secret — a token row built by getProvider, and
   * every call of the token API; no default.
   */
  onWriteFailure?: 'fail' | 'continue' | undefined;
}
```

One choice for the broker, both paths (D3). Without it, a build of a token row
and every token API call throw `DestinationConfigError(['onWriteFailure'])`;
`basic` / `snc` / `none` destinations do not need it.

**`'fail'` — a call fails when a write it needs has not landed:**

1. **The call that obtained the credential.** For a provider the broker built,
   the report is awaited and `refreshStatePersistence` rethrows the write's
   failure, so `getTokens()` / `refreshTokens()` — and a moment — fail
   `unknown` `persisting-tokens` (the provider's classification); the token
   API relays that failure (§3.1). On the consumer path, the token API awaits
   its own submission and rejects with §3.3's failure.
2. **Every later broker call while a write is outstanding.** `getProvider`,
   `getToken` and `refreshToken` for a destination with a pending write first
   give that write one immediate attempt (cancelling its backoff timer) and
   wait for it, raced against the call's signal (§7.5); if it lands, the call
   proceeds; if not, the call rejects with §3.3's failure for that write. So no
   broker call reports success while a write is outstanding — the discard
   written by a detached report (an abort) included — and a discarded refresh
   token cannot outlive a restart unnoticed: until its `''` lands, every call
   for the destination fails, `flush()` rejects, and each failed attempt is a
   `warn` line (§8.1).
3. **Limit, stated (D4):** a provider already handed to a connector answers its
   moments from its own state; a moment that commits nothing (a valid cached
   token presented) is not gated on an earlier outstanding write. Every moment
   that renews is (point 1). The broker does not wrap providers to gate this.

**`'continue'` — best effort:** no call fails because of a write. The provider's
report never throws (`refreshStatePersistence`'s `'continue'`), the token API
returns the token, the writer retries on its own, `flush()` reports what is
still pending, and every failure is a `warn` line. The restart guarantees of
§5.6 hold for every write that landed, and the README says exactly that: a
refresh token discarded while its `''` write is pending at the moment the
process ends comes back from the store after a restart.

### 5.5 The token API with the consumer's provider

The consumer's provider has no broker-built persistence: the token API writes
every answer itself, cache hits included, through the same `SessionWriter`, as
4.x. Two changes, each forced by the goal:

- **The result's refresh token is authoritative (D5).** auth-providers 6.0.0
  returns from `getTokens()` / `refreshTokens()` the refresh token the provider
  holds, or `refreshToken: undefined`. So a result with a refresh token writes
  it; one without writes `refreshToken: ''` — explicitly, since the store
  merges. The stored refresh token is never carried into a consumer
  provider's write (4.x's `carry: 'any'` goes): a refresh token the consumer's
  provider discarded never comes back from the store, and one stored under
  other means never ends up beside the consumer provider's credential. The
  binding fields are written as §5.2 says (`''` for a source the means lack —
  an instance's `issuedBy`).
- **Seeds are bound-only** (§6.2): `carry: 'bound'` and `strategySeed`'s rule
  apply to every factory build, with or without a `clientAuthentication`
  strategy.

`onWriteFailure` governs this path as §5.4 says.

### 5.6 Across restarts

A new broker on the same stores seeds each token row only from a session bound
to its means (§6), with its refresh token only when it is non-empty. Hence:

| Before the restart | After it |
|---|---|
| R discarded (refused refresh, `sentRefreshToken: 'discard'`, `ifCut: 'discard'`) and its `''` write landed | no refresh token: the provider's renewal strategy decides (with `refreshThenLogin()`, a login) |
| the same, the `''` write still pending at exit | `'fail'`: noticed — every call failed and `flush()` rejected before exit; `'continue'`: R comes back (README) |
| a new R2 landed | R2 |
| a token-only result while R held (`none`, state `held`) | R (the stored one, bound) |
| a credential under other means (§6) | discarded, not seeded |

Remaining limit, auth-providers' own and restated in the README: a process that
dies between a discard and its report reaching the broker may present the
stored R once after a restart.

## 6. A credential stays bound to its identity (H3)

### 6.1 The identity

A build's identity is the binding the broker already computes
(`destinationBinding`, `bindingOf.ts`) — `issuedFor` (resource and SAP client)
and `issuedBy` (issuer and client) — together with the row (`authType`,
`grantType`) **(D6)**. Unchanged: one canonicalising function, both sides
canonicalised, a stored secret seeds only when both match.

### 6.2 Separate store reads

Every seed passes only a secret whose own read is bound to the identity: the
session read whose binding was checked is the one the refresh token comes from
(`strategyAuthorization`'s rule, today on the strategy path only, `AuthBroker.ts:358-374`),
and the connection seed carries the token, cookies and expiry only when that
read itself is bound (`strategySeed`). 5.0.0 applies both to every factory
build and every row; 4.x's unbound carry on the factory path without a
strategy (`composeAuthorization`, `AuthBroker.ts:341-356`) goes.

### 6.3 Cached providers

4.x cached a destination's provider for the broker's life, so means changed
under a running broker were "picked up by a new broker" — and a provider
holding a credential for the old resource could be handed out for the new one.
5.0.0 checks on every call:

- `getProvider` and the token API resolve a destination through one
  per-destination attempt (§7.1) that reads the means (and, for client rows,
  the client) and computes the identity. **The same identity:** the cached
  build is answered. **Another:** the cached build is retired — dropped from
  the cache, never handed out again; whoever already holds it keeps it (H6) —
  and a new build follows, with a new generation (§5.3), seeded only from a
  session bound to the new identity.
- **The consumer's factory** is rebuilt the same way.
- **The consumer's instance** cannot be rebuilt and its credential's identity is
  unknown to the broker: after the identity it was first used for changes, the
  token API refuses the destination (`DestinationConfigError(['provider'])`,
  "the destination's means changed since the provider instance was first used
  for it") until a new broker.

### 6.4 Delayed and retried writes

A write carries the binding fixed when its provider was built, never one
recomputed later (4.x); a retried write keeps it; a retired build's write is
dropped once a newer generation has written (§5.3). Because the store merges,
every write also states the refresh token — a value bound to the same identity,
or `''` — and every credential write states both binding fields; a
credential-free write states no binding at all (§5.2). So no write files a
credential under an identity other than the one it was obtained with, and no
write re-labels a credential another write left in the store.

**Every write path, audited:** the provider's credential report (§5.2), the
discard report with a credential held (§5.2: the held credential is rewritten
with its own build's binding — the same build that obtained it), the
credential-free discard (§5.2), `saml2_pure`'s cookies (§5.2), the token API
with the consumer's provider (§5.5), every retry (it replays the latest
submission whole, §5.3), and the CLI's `--cookie` hand-over (§10.8:
`sessionCookies`, the binding from `bindingOf`, each binding field `''` when
absent, and `refreshToken: ''`).

## 7. Cancellation (Open 3)

```ts
export interface BrokerCallOptions {
  /** This caller no longer needs the answer. No bound of the broker's own. */
  readonly signal?: AbortSignal | undefined;
}
getProvider(destination: string, options?: BrokerCallOptions): Promise<IAuthProvider>;
getToken(destination: string, options?: BrokerCallOptions): Promise<string>;
refreshToken(destination: string, options?: BrokerCallOptions): Promise<string>;
flush(options?: BrokerCallOptions): Promise<void>;
createTokenRefresher(destination: string, options?: BrokerCallOptions): ITokenRefresher; // D10
```

The waiter rules are auth-errors' `sharedAttempt` (H5); the broker implements
none of them.

### 7.1 The destination's resolution is a shared attempt

One `sharedAttempt<SlotOutcome<Resolved>>(...)` slot per destination. Every
`getProvider` and every token API call is a waiter: `join(start, signal)`.
`start` reads the means, compares the identity (§6.3) and answers the cached
build or builds; concurrent callers share one resolution.

**Only cancellation goes through `sharedAttempt`'s failure path.** auth-errors
2.1.1 rejects every waiter of a start that throws with a new
`AuthProviderFailure(classify(thrown, operation))`, never the thrown value — a
`DestinationConfigError` would lose `destination`, `missingFields` and its
carried `error`, and a store's own error would be replaced. So `start` never
throws: it catches everything its body throws and resolves a plain
discriminated outcome, which each waiter unwraps **outside** `join`:

```ts
/** A shared start's answer: never thenable — no `then` member, frozen. */
type SlotOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly thrown: unknown };

const outcome = await slot.join(start, signal); // rejects only `aborted`
if (!outcome.ok) throw outcome.thrown;          // the very value the build threw
return outcome.value;
```

- `Resolved` is a plain record `{ provider, row, identity, generation }`; the
  outcome object and the record are plain frozen objects with no `then` member
  (sharedAttempt's start result must not be thenable — a provider instance is
  only ever a field of the record, never the outcome itself).
- Every waiter of one resolution rethrows the same `thrown` value: a
  `DestinationConfigError` (its class, `destination`, `missingFields`,
  `error`), a store's own read error (§3.4, D8), or a provider's
  `AuthProviderFailure`, each unchanged.
- A failed outcome is not cached: the slot is empty once the start settled, so
  the next call resolves again.

- One caller's abort rejects only its promise (`aborted`); the resolution runs
  on for the others.
- When every caller has aborted, the attempt leaves the slot at once (the
  doomed-join rule of `sharedAttempt`), so a caller arriving meanwhile starts a
  fresh resolution. **A build's commit is one step that runs only if its
  attempt was not aborted** — set the cache, take the generation; a build that
  completes after its attempt was aborted is not cached, never handed out, and
  — never having been asked for a token — writes nothing.
- A failed or aborted resolution is not kept: the next call resolves again.
- The attempt's signal reaches the one collaborator of a build that can wait
  on the network: the `clientAuthentication` strategy, through
  `ClientAuthenticationContext.signal` (additive, D11). Store reads take no
  signal (the store contract has none, out of scope): the caller is released
  at once; the read completes on its own and its result is dropped.

### 7.2 What `getProvider`'s signal attaches

Only a given signal is attached, and only to a provider that has parties: every
token provider (`BaseTokenProvider.attach`) and `SncLogonProvider.attach`. The
broker knows which it built from the row (no duck typing). The signal is
attached after the resolution, to the provider answered — built or from the
cache — so a login that provider starts later in a moment (`rejected()` above
all) is aborted once every session holding it has gone. The broker keeps no
`detach`: a session ends by aborting its signal, which releases its party.
`getProvider` without a signal attaches nothing. `BasicAuthProvider`,
`TokenAuthProvider`, `SamlAuthProvider` have nothing to cancel.

### 7.3 The token API never attaches

`getToken` / `refreshToken` reach the provider only through a private
`providerFor(destination, signal?)` — a waiter of §7.1's slot that never
attaches — and pass the call's signal to `getTokens({ signal })` /
`refreshTokens({ signal })`. The token API never calls `getProvider`. So a
token call can neither keep a later moment's login alive nor bound it.

### 7.4 A cached provider after every caller has gone

It stays cached, as in 4.x: callers leaving is not a reason to rebuild. Its
parties have all been released by their aborts, so, by auth-providers' rule, a
moment's login it starts later runs unbounded — the next caller that gave no
signal can log in on it; a caller that gives one is attached again (§7.2). A
login started for callers who have all gone is aborted by the provider (its
parties, or its waiters) — the broker keeps nothing alive.

### 7.5 Every other wait

- The `'fail'` gate of §5.4 (point 2) joins a per-destination `sharedAttempt`
  slot whose `start` is the writer's immediate attempt, resolving a
  `SlotOutcome` (§7.1); a write that did not land is `{ ok: true, value:
  { landed: false, error } }` and the waiter throws §3.3's failure for it
  outside `join`. The caller's signal releases the caller, the write runs on.
- `flush({ signal })` joins one broker-wide slot whose `start` resolves a
  `SlotOutcome<void>`; the `AggregateError` of §3.4 is its `thrown`, rethrown
  outside `join` as the same object (D9). An abort releases the caller, the
  attempts run on and the writer keeps retrying.
- Every slot of the broker uses this one pattern; no slot's `start` throws.
- The consumer path's factory build is §7.1's resolution; the consumer's
  provider gets the call's signal through `getTokens({ signal })`.
- `getAuthorizationConfig` / `getConnectionConfig` are store reads with no
  signal (stores take none), unchanged.

### 7.6 No bound of the broker's own (H4)

The broker sets no timeout, passes no `AbortSignal.timeout`, adds no signal of
its own to any call, and the `SessionWriter`'s retry timer bounds nobody's
wait. A consumer that wants a bound passes one.

## 8. Logging and debug output (library)

### 8.1 What the broker logs

Only through the `ILogger` it is given (none: nothing), never stdout:

- `debug` lines of fixed words with allowlisted values: the build
  (`{ authType, grant, seeded }`), the token API's method. The destination name
  (the consumer's own string) is the only free value, as in 4.x.
- `warn`: a stored secret bound elsewhere and discarded (4.x's line); a session
  write that failed — `[AuthBroker] Session write for <destination> failed; the
  write is retried in <ms> ms` with `logFields(classify(error,
  'persisting-tokens'))` and the attempt number; a retired build's write
  dropped (`debug`).
- `info`: a session secret saved, `{ credential: 'token' | 'cookies',
  hasRefreshToken, expiresAt }`, as 4.x.
- Never: a token, a refresh token, a store's or a provider's message, a URL, a
  client id, `state`.

### 8.2 `authDebug` (Open 6, library side)

```ts
interface AuthBrokerConfig {
  /** Passed to every token provider the broker builds; on only for `true` itself. */
  authDebug?: boolean | undefined;
}
```

- Every token row passes `authDebug: config.authDebug === true` (so absent,
  `false`, `'true'`, `1` are off). It is never read from the environment.
- It reaches only the providers the broker builds; a consumer's instance or
  factory result keeps its own setting.
- The broker's logger is passed to the providers it builds (4.x), so the
  provider's one debug line lands in the consumer's logger. With `authDebug`
  that line names the request's secrets in the provider's prepared form and
  never server text; without it no line carries a secret or server text (the
  provider's guarantees; the broker adds no line of its own carrying either).

## 9. The library's public API, in one place

```ts
export interface AuthBrokerConfig {
  sessionStore: ISessionStore;
  serviceKeyStore?: IServiceKeyStore | undefined;
  provider?: IRefreshableTokenProvider | TokenProviderFactory | undefined;
  authorization?: ((destination: string, grant: StrategyGrant) => IAuthorizationStrategy<string>) | undefined;
  oidcAuthorization?: ((destination: string) => IAuthorizationStrategy<OidcCallbackResult>) | undefined;
  deviceCodePresenter?: ((destination: string) => IDeviceCodePresenter) | undefined;
  samlCookies?: ((destination: string) => (samlResponse: string) => Promise<string>) | undefined;
  assertionReplayStore?: ((destination: string) => IAssertionReplayStore) | undefined;
  clientAuthentication?: ClientAuthenticationStrategy | undefined;
  renewal?: ((destination: string, grant: TokenGrant) => IRenewalStrategy) | undefined;   // new
  onWriteFailure?: 'fail' | 'continue' | undefined;                                        // new
  authDebug?: boolean | undefined;                                                         // new
}

export class AuthBroker {
  constructor(config: AuthBrokerConfig, logger?: ILogger);
  getProvider(destination: string, options?: BrokerCallOptions): Promise<IAuthProvider>;
  getToken(destination: string, options?: BrokerCallOptions): Promise<string>;
  refreshToken(destination: string, options?: BrokerCallOptions): Promise<string>;
  flush(options?: BrokerCallOptions): Promise<void>;
  createTokenRefresher(destination: string, options?: BrokerCallOptions): ITokenRefresher;
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>;   // unchanged
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;         // unchanged
}

export interface ClientAuthenticationContext {
  readonly destination: string;
  readonly grant: ClientAuthenticationGrant;
  readonly client: IAuthorizationConfig | null;
  readCertificate(): Promise<IClientCertificate | null>;
  /** The build's attempt: aborts when every caller waiting on the build has gone. */ // new
  readonly signal: AbortSignal;
}

export type TokenProviderFactory = (destination, authConfig, connConfig, client?) => IRefreshableTokenProvider;
// signature unchanged; authConfig.refreshToken and connConfig's secret fields carry only bound secrets (§6.2)

export { DestinationConfigError, isDestinationConfigError, SessionWriteFailure };
export type { BrokerCallOptions, TokenGrant };
// re-exported types updated to interfaces-auth 7: IRenewalStrategy added beside ITokenRefresher, IClientAuthentication
```

Unchanged: `bindingOf`, `fromServiceKeyCertificate()`, `fromServiceKeySecret({
encoding })` (their words stay; `fromServiceKeyCertificate` relies on
`tlsMaterial()` throwing an `AuthProviderFailure` of kind `client-certificate`,
carried by the guard, §3.2), the store contracts, `StrategyGrant`,
`TokenProviderClient`. The collaborator options keep their shapes; a strategy
passed to them must honour `AuthorizationRequest.signal` (auth-providers 6.0.0).

## 10. The CLI

### 10.1 What the CLI states as a consumer of the broker

Every command builds its broker with explicit choices, in its own code (H1):

- `renewal: () => refreshThenLogin()` for every grant — a user at a terminal
  can log in; `--env` with a refresh token refreshes first, as 2.x. **(D20)**
- `onWriteFailure: 'fail'` — a command exits 1 and writes no output unless the
  secret landed; it calls `flush()` before copying the output, as 2.x. **(D20)**
- `authDebug: true` only with `--auth-debug` (§10.7).
- every collaborator the grant needs (`buildCollaborators`), each honouring the
  login's signal.

### 10.2 `mcp-auth` on `getProvider` (D12)

`runMcpAuth` drops its own provider factory and `withPlaceholderUrl`: having
written the destination's means (`jwt` / `authorization_code` or
`client_credentials`, the client or its certificate paths), it calls
`broker.getToken(destination, { signal })` without a `provider` option, so the
provider is the broker's UAA row — the same composition `mcp-sso` and
`generate-env` use (H5: one implementation of the row). `--client-auth` maps to
the broker's `clientAuthentication` strategy as in 2.1.0. A session in the
`--env` file seeds the login only when it is bound to the destination's means
(§6); an unbound one is discarded with the broker's `warn` line and a login
follows.

### 10.3 `--browser` (Open 4; D13, D14, D15)

The flag keeps its 2.x names and default; the CLI maps each to an `IBrowser` by
`process.platform`, explicitly, in one table of its own (`browserFor(name,
platform)`), shown in `--help`:

| `--browser` | `linux` | `darwin` | `win32` |
|---|---|---|---|
| `auto` (default), `system` | `linuxDefaultBrowser()` | `macDefaultBrowser()` | `windowsDefaultBrowser()` |
| `chrome` | `linuxBrowser('google-chrome')` | `macBrowser('Google Chrome')` | `windowsBrowser('chrome')` |
| `edge` | `linuxBrowser('microsoft-edge')` | `macBrowser('Microsoft Edge')` | `windowsBrowser('msedge')` |
| `firefox` | `linuxBrowser('firefox')` | `macBrowser('Firefox')` | `windowsBrowser('firefox')` |
| `none`, `headless` | no browser: the URL is shown on stderr | the same | the same |

- `--browser-program <program>` (new, D14): `linuxBrowser(program)` /
  `macBrowser(program)` / `windowsBrowser(program)` on the platform above — an
  executable on `PATH` or an absolute path (Linux), an application name
  (macOS), a program name or path (Windows), passed as given. It excludes
  `--browser`.
- **Any other platform** (`freebsd`, `aix`, …): a named browser or
  `--browser-program` is a usage error naming the flag ("`--browser <name>` has
  no launcher on this platform; use `--browser none`"), before anything is read
  or written; `none` / `headless` work everywhere. Nothing is guessed.
- The same mapping serves `mcp-sso --browser`, the `browser` field of an
  `mcp-sso --config` file (a string, mapped by the same function; an unknown
  value refused naming `browser`), and `generate-env` (2.x hard-coded
  `'system'`: it takes `--browser` too, default `auto`).
- A launch that fails does not end the login (auth-providers 6.0.0): the URL is
  shown on stderr and the callback keeps waiting.

### 10.4 A login ends only when the user ends it

- **No bound.** `INTERACTIVE_LOGIN_TIMEOUT_MS` (`mcp-auth.ts:40`,
  `generate-env-from-service-key.ts:44`, `mcpSsoConfig.ts:40`) is removed, not
  turned into `AbortSignal.timeout`; no `timeoutMs` is passed anywhere.
- **One interrupt per run.** Each command creates one `AbortController` for the
  run. While the run lives, `SIGINT` and `SIGTERM` abort it; the run's signal
  is passed to every wait the run has: `getProvider(destination, { signal })`,
  `getTokens({ signal })` / `getToken(destination, { signal })`, the
  strategies' own `signal` option, `readManualInput`, the SAML cookie paste and
  the IdP-initiated paste, `flush({ signal })`. The abort ends the login
  `aborted`; the callback socket is released by the strategy before its
  `authorize` settles (auth-providers' rule); the command prints the failure's
  words (§10.9) on stderr, removes its work directory, writes no output and
  exits 130 (`SIGINT`) or 143 (`SIGTERM`), without a stack trace **(D18)**.
- **`workDir.ts`'s signal handlers** become this one interrupt: the first
  signal aborts the run (cleanup follows its settling); a second signal exits at
  once, removing the work directory (D18). `SIGHUP` keeps 2.x's immediate exit
  (129). After the run, every listener it added is removed:
  `process.listenerCount('SIGINT' | 'SIGTERM')` returns to its value before.
- **`mcp-auth`'s subcommands** (`oidc`, `saml2-pure`, `saml2-bearer`) spawn
  `mcp-sso` with inherited stdio, as 2.x; the child owns the interrupt (the
  terminal delivers the signal to both), and the parent exits with the child's
  status.

### 10.5 The compositions, `state` and PKCE, and the manual SAML ACS

- **Compositions.** The CLI's strategies are auth-providers 6.0.0's named
  compositions: `browserCallbackStrategy({ browser, port, signal })`
  (`mcp-auth`, `generate-env`), `oidcCallbackStrategy` and
  `samlCallbackStrategy` (`mcp-sso` browser flows), `manualPasscodeStrategy({
  read })`, `manualSamlResponseStrategy({ redirectUri, read })`,
  `staticCodeStrategy` (`--code`, `--passcode`, `--assertion`). Every
  listener is loopback-only, so `--redirect-port` keeps its meaning and a
  remote user tunnels (the providers' SSH hint).
- **`state` and PKCE** come with the providers: every UAA authorization-code
  login (`mcp-auth`, `generate-env`) carries `state` and an S256 challenge;
  every OIDC authorization-code login (`mcp-sso oidc --flow browser`) carries
  `state` and PKCE. A code handed over with `--code` has neither by nature (no
  URL is built); `--help` says so.
- **The manual SAML login always declares its ACS.** `--assertion-flow manual`
  and the IdP-initiated paste take the ACS from, in this order: `--acs-url`,
  the SP metadata (`--saml-metadata`, or `<uaa.url>/saml/metadata` with
  `--service-key`), an `acsUrl` in `--config`. None: a usage error naming
  `--acs-url`, before anything is read or written. The 2.x fallback
  `http://localhost:<port>/callback` (`mcpSsoConfig.ts:782-783`, and the
  `--acs-url` help line) is gone. The IdP-initiated strategy stays the CLI's
  own (no URL exists to show), now honouring `AuthorizationRequest.signal` and
  returning the declared ACS as its `redirectUri`.
- **Device code.** `consoleDeviceCodePresenter()` is given no logger, so the
  code is always shown on stderr (2.x passed `mcp-sso`'s logger, which is off
  unless an environment variable turns it on — a user could not see the code).

### 10.6 Flags, by command

| Flag | `mcp-auth` | `mcp-sso` | `generate-env` | 3.0.0 |
|---|---|---|---|---|
| `--browser <name>` | ✓ | ✓ | new | mapped per platform (§10.3) |
| `--browser-program <program>` | new | new | new | §10.3 |
| `--auth-debug` | new | new | new | §10.7 |
| `--verbose` | new | new | new | §10.7 (D17) |
| `--acs-url <url>` | (passed to `mcp-sso`) | required for a manual SAML login unless metadata or `--config` states it | — | §10.5 |
| `--redirect-port`, `--client-auth`, `--basic-encoding`, `--cert-path`, `--key-path`, every other 2.1.0 flag | unchanged | unchanged | unchanged | |
| `DEBUG_SSO`, `DEBUG_AUTH_SSO`, `DEBUG` (environment) | — | read | — | no longer read (D17) |

### 10.7 Debug output (Open 6, CLI side; D17)

- **`--auth-debug`** sets the broker's `authDebug: true` and nothing else
  beyond what it needs to be seen: it implies `--verbose`.
- **`--verbose`** gives the broker (and so the providers it builds) the CLI's
  logger at `debug`; without it the logger is at `warn`. The CLI's logger writes
  every level to stderr.
- **Nothing from the environment.** No environment variable turns on either,
  or changes the log level; `DEBUG_AUTH_PROVIDERS` and its kin change nothing.
- Without `--auth-debug` no line the CLI or a provider writes carries a secret
  or server text; with it, only the provider's debug line carries the secrets
  it names, prepared, and never server text.

### 10.8 What the CLI writes where

- **Files.** The output file the user named (`--output`), `.env` or JSON, holds
  the means and the secret as 2.x — the token or cookies, the refresh token,
  their expiry and binding, the client secret or the certificate paths and
  `certurl` — written only after `flush()` reported the secret stored. The
  private work directory (`mkdtemp`, mode 0700) holds the run's copy and is
  removed on every exit. `generate-env` writes only the session file it names.
  Nothing else is written. A certificate and key are never copied (2.1.0).
- **stdout** (D16): only what was asked for — `help` and `--version`.
- **stderr:** progress lines (the destination's name, the flow, the paths of
  the user's own files), the providers' prompts (the authorization URL a user
  must open, the passcode page, the device code), the manual-input prompts
  (`readManualInput`'s readline output moves to stderr), log lines (§10.7), and
  failures (§10.9).
- **Never in what the CLI prints:** a token, a refresh token, a secret, a
  store's or a server's text, `state`, or an authorization URL of the CLI's own
  — `runMcpAuth.ts:386-393`'s "Authorization URL" preview is removed. The one
  place the URL appears is the provider's prompt that sends the user there, on
  stderr (D19).

### 10.9 Failures, as printed

One function for every command (`printFailure`), never `message` of a foreign
value and never a stack:

- `isAuthProviderFailure(thrown)` → `readFailure(thrown, operation)`; print
  `❌ <reason>` or `❌ <reason> — <hint>`, then `renderDiagnostics(error)` on
  its own line when it is not empty. A failure of another copy of auth-errors
  prints the same (its diagnostics dropped).
- `isDestinationConfigError(thrown)` → its message (names only), then, when it
  carries `error`, that error's hint and diagnostics as above.
- the CLI's own usage errors — fixed words, branded by a module-private symbol
  (no `instanceof`) — their message;
- anything else → `readFailure(thrown, 'unfamiliar-error')`'s words.

`flushed()` prints each `SessionWriteFailure`'s message (rendered words). An
aborted login prints "the authorization was aborted".

## 11. Migration notes

### 11.1 For a 4.x broker consumer

| 4.x | 5.0.0 — what to do |
|---|---|
| `@mcp-abap-adt/auth-providers` 5, `interfaces-auth` 3, `auth-stores` 3 | auth-providers `^6.0.0`, interfaces-auth `^7.5.0`, auth-errors `^2.1.1`, auth-stores `^4.0.0`; one copy of each contract (`npm ls`) |
| token rows renewed by the provider's built-in rule | pass `renewal: () => refreshThenLogin()` — 4.x's steps; without `renewal` a token row is refused (`missingFields: ['renewal']`) |
| a `getProvider` provider's failed write never failed the authentication; the token API threw the store's error | pass `onWriteFailure`: `'continue'` keeps 4.x's connector behaviour (best effort); `'fail'` keeps 4.x's token-API behaviour and extends it to the connector and to every later call while the write is outstanding (§5.4). Without it a destination that writes a secret is refused |
| errors of the token API: auth-providers 5.x classes (`ValidationError`, `BrowserAuthError`, `RefreshError`, …) | `AuthProviderFailure`: read with `readFailure(error, operation)` and `matchKind` (auth-errors); auth-providers' "Migrating to 6.0.0" table maps each class to its kind |
| the token API's failed write: the store's own error | `AuthProviderFailure`, `unknown`, `persisting-tokens` (with an allowlisted `code`), only with `'fail'` |
| "Token provider did not return authorization token …" (`Error`) | `request-failed`, `no-access-token`, operation `token-source` |
| `error instanceof DestinationConfigError` | `isDestinationConfigError(error)`; `error.error` is the provider's error when one caused it; its message adds `: <the provider's reason>` there |
| a provider's `ValidationError` thrown raw by `getProvider` (rows other than SNC) | `DestinationConfigError` naming the store fields, the provider's error in `error` |
| the certificate words of `clientAuthentication` (`incomplete` / `expired` / `could not be used`) | `error.reason` of the carried `client-certificate` error; the `DestinationConfigError` reason reads `the clientAuthentication strategy failed: <reason>` |
| `flush()`'s `AggregateError.errors`: `Error("<dest>": <class>)` | `SessionWriteFailure` (`destination`, `error`) |
| `getProvider(d)`, `getToken(d)`, `refreshToken(d)` | unchanged calls; each also takes `{ signal }` — the server ties a session's close to `getProvider`'s and each request's cancellation to the token API's |
| providers' 30 s / 300 s login timeouts | none: a login waits until it ends or a signal aborts; bound it with your own signal or strategy option |
| collaborator strategies of 5.x (`browserCallbackStrategy({ browser: 'system', timeoutMs })`, `openUrl`) | 6.0.0's: `browser` an `IBrowser`, `signal` instead of `timeoutMs`, `redirectUri` required for the manual ones; a strategy of yours must honour `AuthorizationRequest.signal` |
| means changed under a running broker were picked up by a new broker | picked up at the next call: a changed identity (resource, SAP client, issuer, client, row) rebuilds the destination's provider, unseeded from a session bound elsewhere; an instance `provider` is refused for that destination until a new broker |
| the token API's factory seeded with whatever the session held | seeded only with secrets bound to the destination; an unbound session seeds nothing and the provider logs in |
| a consumer provider's result without a refresh token kept the stored one | it clears it (`refreshToken: ''`): 6.0.0 providers return the refresh token they hold |
| `onTokens` of the built providers | `persistence` (internal; nothing to do) |
| `DEBUG_*` environment variables | the broker reads none; `authDebug: true` for the providers' debug line |

### 11.2 For a CLI 2.x user

| 2.x | 3.0.0 — what to do |
|---|---|
| a login ended after five minutes | it waits until it finishes; end it with Ctrl+C (exit 130) or `SIGTERM` (exit 143); the port is released |
| `--browser chrome|edge|firefox|system|auto` | same names, mapped to the platform's launcher (table §10.3); on an unlisted platform use `none`; `--browser-program` names another program; Linux no longer gets `DISPLAY=:0` or a list of candidate Chrome executables — pass `--browser-program google-chrome-stable` (or `chromium`) where `google-chrome` is not installed |
| manual SAML without `--acs-url` used `http://localhost:<port>/callback` | state the ACS: `--acs-url`, `--saml-metadata`, `--service-key`'s metadata, or `acsUrl` in `--config` |
| progress and prompts on stdout | on stderr; stdout carries only `help` and `--version` |
| "🔗 Authorization URL: …" preview of `mcp-auth` | gone; the URL is shown by the login's own prompt (stderr) |
| `DEBUG_SSO=true` etc. for `mcp-sso`'s log | `--verbose`; `--auth-debug` for the providers' debug line, with prepared secrets |
| error output: a message and a stack trace | `reason — hint`, then the diagnostics line; no stack trace |
| an `--env` session without `SAP_ISSUED_FOR` / `SAP_ISSUED_BY` (written before 2.0) refreshed with its refresh token | it is not bound to the destination: discarded with a warning, and a login follows |
| a callback reachable from another machine | loopback only (auth-providers 6.0.0): tunnel the port (`ssh -L`) |

## 12. Release order

1. **auth-broker 5.0.0**, from the workspace PR; its `package.json` declares only
   semver ranges, all resolving on npm (§2).
2. **auth-broker-cli 3.0.0**, from the same PR, after 5.0.0 is on the registry:
   its `@mcp-abap-adt/auth-broker` range is `^5.0.0` — never `file:`, `link:` or
   `workspace:`. The workspace link between the two exists only in the
   development lockfile (the standing exception for packages of one
   repository).
3. `release:publish` publishes the versions the registry lacks in workspace
   order (broker, then CLI) after one `npm run check`, on the tags
   `auth-broker-v5.0.0` and `auth-broker-cli-v3.0.0`.
4. Before tagging: the lockfile has no `"link": true` other than the workspace
   sibling, and every third-party resolution is from the registry. After
   publishing: a clean install of both from the registry in an empty directory
   outside the repository; `npm ls` shows one `interfaces-auth` and one
   `auth-errors`; `mcp-auth --version` and `mcp-sso --version` print 3.0.0; a
   smoke script builds a broker over auth-stores 4.0.0, gets a `basic`
   provider and a refused token-API call, and prints `kind`.
5. READMEs, CLAUDE.md, `docs/` and both CHANGELOGs describe 5.0.0 / 3.0.0
   (the user's release rule); the migration notes of §11 are in each README;
   the goal, this spec and the plan are deleted from `docs/superpowers/`
   before the release, their open follow-ups moved to the PR description.

## 13. Tests and measurements

Every rule below has a test; each test marked **[break]** is shown to be
load-bearing — the rule broken deliberately, the test red, the break reverted —
and each break changes one conjunct (assert on a fragment only that rule
produces). Ports are asserted by binding them, never by a log line. A rejection
expectation is attached before it is triggered.

### 13.1 Library

**Errors (§3)**
- A provider failure of each kind thrown by `getTokens()` reaches
  `getToken()` / `refreshToken()` as the same object (identity), for a built
  provider and a consumer's. **[break: wrap it]**
- A failure built by a second copy of auth-errors loaded from another path:
  relayed; `isAuthProviderFailure` true; `readFailure` gives the same kind and
  facts. **[break: relay through `instanceof`]**
- `fromServiceKeyCertificate()` with incomplete, unusable and expired PEM:
  `DestinationConfigError.error` deep-equals the provider's
  `client-certificate` error with that `problem`; the message holds
  `render(error)`'s reason; `missingFields` is `['clientAuthentication']`.
- SNC with an invalid `sncQop`: `missingFields: ['sncQop']`, `error.kind ===
  'configuration'`. **[break: match `instanceof ValidationError`]**
- An unreadable SAML certificate: `samlIdpCertificates`, the validator's error
  carried.
- A consumer provider answering no token: `request-failed` `no-access-token`.
- A store read failure reaches the caller as the store raised it.
- Source tests over both packages' `src`: no `instanceof` on any value of an
  error, no read of `.message` / `.name` / `.stack` of a caught value, none of
  the three copied certificate phrases. **[break: re-add one phrase]**
- `isDestinationConfigError` true for the class and its JSON copy, false for
  look-alikes missing a field.
- **Error identity through the shared slots (§7.1, §7.5).** With two
  concurrent waiters of one resolution: a `DestinationConfigError` thrown in
  the build reaches both as that object — `instanceof DestinationConfigError`
  (in the test only), its `destination`, `missingFields` and carried `error`
  intact; a store's read error reaches both as the store's own object
  (identity); a provider's `AuthProviderFailure` from a build likewise.
  `flush()`'s rejection is the `AggregateError` itself, its `errors`
  `SessionWriteFailure`s. A waiter that aborts still gets auth-errors'
  `aborted` failure (`readFailure(…).kind === 'interactive-login'`, `outcome:
  'aborted'`). The start's outcome has no `then` (a test reads the resolved
  record). **[break: let `start` throw]**

**Renewal (§4)**
- Each token row's provider receives the very strategy `renewal(destination,
  grant)` returned, called once per build with that grant; `refreshOnly()`
  passed → a renewal never calls the `authorization` strategy.
- No `renewal`: a token row refused naming `renewal` (with every other missing
  field in one error), no collaborator called, nothing cached; `basic`, `snc`,
  `none` built without it. **[break: default to `refreshThenLogin()`]**
- A throwing `renewal` → `DestinationConfigError(['renewal'])`, nothing cached.

**Session writes and refresh state (§5), end to end over auth-stores 4.0.0's
`EnvDestinationStore` + `AbapSessionStore` files, real providers, the local token
endpoint**
- Refused refresh → token-only login → a fresh broker on the same files finds
  no refresh token and logs in. **[break: write `undefined` for `null`]**
- The same with the `''` write failing once, then landing by the writer's retry
  (fake timers); and with the fallback login itself failing — R still cleared.
- Refresh cut after dispatch (real socket, withheld response, `ifCut:
  'discard'`): `''` lands; restart → no R; the late R2 released afterwards with
  nothing newer committed → R2 written.
- Failed `''` → a token-only `credential` report → the retried write lands →
  restart finds no R. **[break: build a retry from the single result instead of
  the latest submission]**
- New R after a pending `''` wins (stored R new).
- `credential`, `none` while `held`: the stored bound R kept (written as its
  value, the binding unchanged).
- **A pre-existing session bound to other means.** The store holds token T0
  and R_old bound to identity A; the means now state identity B. For each path
  — a token-only login of a built provider (`authorization_code` returning no
  refresh token, `client_credentials`), `saml2_pure` cookies, a consumer
  factory's and a consumer instance's token-only result, the CLI's `--cookie`
  — the test inspects the **resulting store state** (`loadSession`, not the
  submitted write): no R_old, the binding B (or `''` where B lacks a source);
  then a **restart** (a fresh broker on the same files): its provider is not
  seeded with R_old, and its first renewal sends no refresh token (asserted on
  the token endpoint). **[break: omit `refreshToken` instead of writing `''`
  on the `undefined` branch]** **[break: leave a binding field out instead of
  `''`]**
- **A credential-free discard over another identity's session.** The store
  holds T0 / R_old bound to A; a provider of identity B discards before any
  credential: the resulting state keeps T0 with binding A (unchanged), no
  refresh token; a restarted broker for B does not seed T0. **[break: write the
  build's binding on a credential-free write]**
- A discard before any credential over a session of the same identity: the
  session keeps its access token and binding, has no refresh token.
- `saml2_pure`: cookies written as `sessionCookies`, `refreshToken: ''` — a
  refresh token stored before is gone from the resulting state.
- Write order: a deferred older write completing after a newer one never
  overwrites it; a retired build's write is dropped once the newer generation
  wrote. **[break: drop the generation tag]**
- `'fail'`: a failing store makes the obtaining `getToken()` fail `unknown`
  `persisting-tokens` with `code` (EACCES); the retry continues; a later
  `getToken()` / `getProvider()` while the write is outstanding gives it one
  attempt and fails while it fails, succeeds once it lands; a detached discard
  whose write fails makes the next `getToken()` fail. `flush()` rejects with a
  `SessionWriteFailure` naming the destination. **[break: answer a call
  without checking the outstanding write]**
- `'continue'`: the same store → every call succeeds, one `warn` line per
  failed attempt carrying `logFields` only, `flush()` rejects.
- No `onWriteFailure`: a token row and the token API refused naming it;
  `basic` built.
- Consumer factory path: a result without a refresh token writes `''`; a
  session not bound to the destination seeds the factory with no refresh token
  and no token. **[break: carry the stored token]**
- No line and no error holds a token, a refresh token or a store message
  marker.

**Binding across cached providers (§6)**
- `serviceUrl`, `sapClient`, `uaaUrl`, client id, `grantType` each changed
  between two `getProvider` calls → a new instance, not seeded from the session
  bound to the old means; unchanged means → the same instance (one assertion
  per field). **[break: compare one field fewer]**
- The consumer factory rebuilt on the same changes; a consumer instance refused
  naming `provider` after a change.

**Cancellation (§7)** — on strategies that wait until aborted, ports asserted
- Two `getProvider` callers, one aborts → it rejects `aborted`, the other gets
  the provider; both abort → nothing cached, the next call builds.
  **[break: cache an aborted build]**
- Doomed build: all callers abort while the build's store read is held → a new
  caller builds afresh and gets its own provider; the first build's late
  completion is not cached and writes nothing. **[break: remove the attempt
  from the slot only on settle]**
- A provider from `getProvider(…, { signal })` whose `rejected()` starts a
  login: aborted by that signal (strategy signal aborted, port bound
  afterwards); not while another `getProvider` caller's signal is live; a cache
  hit with a signal attaches too. **[break: skip `attach` on a cache hit]**
- `getProvider` without a signal attaches nothing.
- Immortal-party regression: a `getToken` without a signal, then two signalled
  sessions, a `rejected()` login, both sessions close → the login aborts, the
  port is free. **[break: route the token API through `getProvider`]**
- After all sessions closed, an unsignalled `getProvider` (cache hit) handed to
  a connection whose `rejected()` logs in → gets a token. Mixed connections: the
  signalled one closes, the unsignalled one's next renewal gets a token.
- `getToken(…, { signal })` aborted → `aborted`; a concurrent unsignalled
  `getToken` gets the token.
- The `clientAuthentication` context's signal aborts when every build waiter
  aborted.
- `flush({ signal })` and the `'fail'` gate release their caller on abort; the
  write goes on.
- Every `sharedAttempt` waiter's listener is removed: each signal's listener
  count returns to its baseline.
- Source tests: nothing in the token API calls `getProvider`; no
  `AbortSignal.timeout`, no `timeoutMs`, no `setTimeout` bounding a wait in
  `src`. **[break: re-add a five-minute `AbortSignal.timeout`]**

**Debug and logging (§8)**
- A built provider receives `authDebug: true` only for `authDebug === true`
  (absent, `false`, `'true'`, `1` → off); a consumer's provider keeps its own.
  **[break: read an environment variable as a fallback]**
- With `DEBUG_AUTH_PROVIDERS=true` and every other `DEBUG*` variable set and no
  option, nothing changes.
- A token endpoint answering `400` with an `error_description` marker: the
  marker is in no log line, error or diagnostic, with `authDebug` off and on;
  with it on, the debug line holds `sent` with prepared secrets only.

**Gates:** the shape check (rules 4, 5, 6) clean, its copy byte-identical to
the published one; `check:graph`, `check:packed`, `check:publish`, the strict
compiler, `lint:check`; the broker stand (`npm run test:stand`) on 6.0.0
providers, each suite constructing `renewal` and `onWriteFailure` explicitly.

### 13.2 CLI

- `browserFor(name, platform)`: every cell of §10.3's table, for each of
  `linux`, `darwin`, `win32`; any other platform refuses each name and
  `--browser-program` before anything is written; `none` / `headless` give no
  browser; the `--config` `browser` field maps the same.
  **[break: fall back to a default browser on an unknown platform]**
- `SIGINT`, and separately `SIGTERM`, delivered while each kind of login waits
  — `mcp-auth` browser login, `mcp-sso` OIDC browser, SAML browser, manual SAML
  paste, passcode paste, device code, `generate-env` — aborts it: "the
  authorization was aborted" on stderr, exit 130 / 143, no stack trace, the
  callback port bound by the test afterwards, the work directory gone, the
  output untouched; afterwards `process.listenerCount('SIGINT' | 'SIGTERM')`
  equals its value before the run. **[break: leave `SIGINT` unwired in one
  command]**
- No bound: a login given no signal keeps waiting past 300 s (fake timers), the
  callback port still held; the test then aborts it. Source test: no
  `INTERACTIVE_LOGIN_TIMEOUT_MS`, `AbortSignal.timeout`, `timeoutMs` or
  `setTimeout` on a login path in the CLI.
- A second signal exits at once and removes the work directory.
- `mcp-auth oidc …` (delegation) interrupted: the child aborts, the port is
  free, the parent exits with the child's status.
- Manual SAML with no ACS from any source: refused naming `--acs-url`, nothing
  read or written; with each source the strategy's `redirectUri` is that ACS;
  the IdP-initiated paste returns it. **[break: restore the localhost
  fallback]**
- `mcp-auth` against the local token endpoint: the authorization URL the
  strategy is handed carries `state` and an S256 `code_challenge`, the token
  request a `code_verifier`; a callback without the `state` is refused.
- Output streams: stdout of every command run is empty except `help` /
  `--version`; neither stream holds a token, refresh token, client secret,
  `state` or a server-text marker; stderr holds the authorization URL only in
  the provider's prompt (D19). **[break: print the URL preview again]**
- `printFailure`: a failure with and without diagnostics; one from a second
  auth-errors copy prints the same reason — hint; a `DestinationConfigError`
  carrying an error prints its hint and diagnostics; no stack trace in any
  case.
- `--auth-debug` hands `authDebug: true` to the broker in `mcp-auth`,
  `mcp-sso` and `generate-env`; without it, not; environment variables alone
  change nothing; without the flag a `400` with an `error_description` marker
  leaves no marker on either stream. **[break: drop the flag's wiring in one
  command]**
- The output file (`.env` and JSON) of every 2.1.0 case holds the same tokens,
  refresh token, client and certificate paths as 2.1.0's (no PEM); a failed or
  interrupted run leaves it as it was.
- The device code is shown on stderr with no logger enabled.

### 13.3 What only a live system or a real browser can show

Recorded with date and result before the release; none runs in CI.

- **The CLI's interactive login in a real browser, per platform:** `mcp-auth
  --type xsuaa` (authorization code, `state` + PKCE) against the XSUAA trial on
  Linux (`auto` → `xdg-open`, `chrome`, `firefox`, `--browser-program
  chromium`), macOS (`auto`, `chrome`) and Windows 11 (`auto` → `rundll32`,
  `edge` → PowerShell `Start-Process`): token obtained, the `.env` opens ADT
  (`getProvider` → connection 14).
- **Ctrl+C at a real terminal** during each of those logins: exit 130, the
  port free (bound again by hand), no output file.
- **`--browser none`** over SSH with a tunnel: the URL prompt on stderr, the
  login completes through the tunnel.
- **Manual SAML with a declared ACS** against a real identity provider (IAS
  or the Keycloak stand by hand), `mcp-sso saml2 --flow pure --assertion-flow
  manual` and `bearer --idp-initiated`.
- **Device code** at a real terminal (Keycloak stand): the code visible on
  stderr.
- **Restart after a refused refresh** against the XSUAA trial with a revoked
  refresh token: the next run logs in, the file holds no refresh token.
- **`npm run test:live:x509`** and **`npm run test:live`** (basic/SNC/jwt over
  connection 14) re-run on 5.0.0.

## 14. Goal invariants: how each holds

- **H1 The consumer composes; nobody guesses.** `renewal` and `onWriteFailure`
  have no defaults (§4.3, §5.4); the broker's choices for providers —
  `refreshStatePersistence`, `authDebug === true`, which signal is attached —
  are written in its code; the CLI's choices — `refreshThenLogin()`, `'fail'`,
  the browser table by `process.platform`, refusal on an unknown platform — are
  in the CLI's code and help (§10.1, §10.3).
- **H2 Nothing goes out that should not.** Errors carry minted facts or names
  (§3); logs carry fixed words and `logFields` (§8.1); `authDebug` is the only
  channel for prepared secrets and only when set (§8.2, §10.7); the CLI writes
  credentials only to the output file and its private work directory (§10.8),
  prints no URL, `state` or token of its own, and nothing but help and version
  to stdout (§10.8).
- **H3 A credential stays bound.** §6: the identity is checked on every call;
  seeds are bound-only; writes carry their build's binding and generation; and
  since auth-stores merges, every write states the refresh token (a value bound
  to the same identity, or `''`) and every credential write both binding
  fields, while a credential-free write states no binding — so no refresh
  token of other means survives beside a new credential, and no write
  re-labels a stored one (§5.2, §5.5, §6.4).
- **H4 No built-in timeouts.** §7.6, §10.4; the writer's retry delay bounds no
  wait.
- **H5 One implementation of each rule.** `sharedAttempt` (§7) — for the
  waiter and cancellation rules only; its results carried as plain outcomes so
  the broker's own errors pass unchanged — `readFailure` /
  `classify` (§3), `refreshStatePersistence` (§5.1), the broker's UAA row for
  `mcp-auth` (§10.2).
- **H6 Whoever holds an instance holds its rights.** Retired providers are
  not taken from their holders (§6.3); store errors are returned to the store's
  owner as the same objects, through the shared slots too (§3.4, §7.1);
  moments are not wrapped (§5.4, D4).
- **H7 Registry only.** §2, §12.
- **H8 What works today keeps working, or the note says what to do.** §11; no
  migration loosens H2 or H3.

## 15. Decisions for the user

Each is a choice the goal, the rules and the code leave open. The
recommendation is what the spec above is written with.

**D1 — The shape and place of `renewal`.**
(a) A function of the destination and grant in `AuthBrokerConfig` (like every
other collaborator option); (b) one `IRenewalStrategy` for the whole broker;
(c) either form, told apart by `typeof`. Per-destination store fields are out
of scope. *Recommended: (a)* — one shape, covers both needs, matches the other
collaborators.

**D2 — What a consumer that gives no `renewal` / `onWriteFailure` gets.**
(a) A `DestinationConfigError` naming the option when a destination needs it
(token rows; any write); (b) a constructor refusal for every broker, even one
serving only `basic`/`snc`; (c) a 4.x-compatible default. *Recommended: (a)* —
no default (H1), and a broker that never writes a secret is not forced to state
a write policy. (c) contradicts the standing rule.

**D3 — One `onWriteFailure` or one per path.**
(a) One option for `getProvider`'s providers and the token API; (b) two
(`getProvider` best effort, the token API failing — exactly 4.x's split).
*Recommended: (a)* — the goal speaks of one decision; the migration note says
how each 4.x half maps.

**D4 — How far `'fail'` gates.**
(a) Every broker call and every renewal; a moment that commits nothing is not
gated (stated limit); (b) the broker also wraps every provider it hands out, so
every moment checks for an outstanding write. *Recommended: (a)* — (b) changes
the provider's identity (its `attach`, its type), duplicates the moments rule,
and gates a request that needs no write.

**D5 — The consumer provider's refresh token on the token API.**
(a) The result is authoritative: none → `refreshToken: ''`, written
explicitly (the store merges); (b) keep 4.x's
carry of the stored one and state that the "discarded never comes back"
guarantee covers only broker-built providers — not available as stated,
since on a merging store a carry under changed means leaves a refresh token of
other means beside the new binding (H3), so (b) would need (a)'s `''` there
anyway; (c) hand the factory a
broker-built persistence strategy to compose into its provider. *Recommended:
(a)* — it holds the goal for every path and matches 6.0.0's `getTokens()`
contract; (c) adds an API for little gain.

**D6 — What "the means changed" compares, and the instance case.**
The re-check on every call is dictated by H3; its granularity is not:
(a) the binding plus the row (`authType`, `grantType`); (b) every means field
the row reads (scopes, endpoints, trust, user and password); (c) the binding
only. For a consumer instance after a change: (i) refuse the destination until
a new broker; (ii) keep 4.x (binding fixed at first use). *Recommended: (a) and
(i)* — (a) is exactly the goal's identity plus what decides the provider class;
(ii) would file the instance's cached token under the new identity.

**D7 — `DestinationConfigError`'s shape.**
(a) Keep the class, add `error?: IAuthProviderError` and a structural
`isDestinationConfigError`; (b) make it an `AuthProviderFailure` of kind
`configuration` — needs interfaces-auth's `CONFIG_FIELDS` to admit store field
and broker option names (out of scope). *Recommended: (a).*

**D8 — A store's read failure.**
(a) Relayed as the store raised it (the consumer's own collaborator, 4.x);
(b) classified (`unknown`, an operation, an allowlisted code). *Recommended:
(a)* — whoever holds the store holds its errors (H6); the CLI never prints a
foreign message anyway (§10.9). (b) needs an operation `interfaces-auth` does
not list for store reads. (a) holds through the shared resolution only because
its start resolves an outcome instead of throwing (§7.1): `sharedAttempt`
would otherwise classify the store's error.

**D9 — `flush()`'s rejection.**
(a) `AggregateError` of `SessionWriteFailure { destination, error }`;
(b) `AggregateError` of `AuthProviderFailure`s (the destination lost);
(c) keep 4.x's `Error("<dest>": <class>)`. *Recommended: (a)* — the
destination stays, the words are auth-errors'; (c) reads a class name (H5).
Whichever is taken, `flush()` rejects with that object itself: its shared slot
carries it out as an outcome and rethrows it outside `join` (§7.5).

**D10 — `createTokenRefresher` and cancellation.**
(a) `createTokenRefresher(destination, { signal })`, every call of the
refresher a waiter with that signal; (b) unchanged, no signal (the goal names
only the three calls). *Recommended: (a)* — additive; a refresher held by a
session can then end with it.

**D11 — `ClientAuthenticationContext.signal`.**
(a) Added: the build attempt's signal, so a strategy waiting on the network
(`tlsMaterial()` of a loader) ends when every build waiter left; (b) not
added. *Recommended: (a)* — additive, and the only build collaborator that can
wait.

**D12 — `mcp-auth` on `getProvider` or on its own factory.**
(a) The broker's UAA row (drop the factory and the placeholder URL); (b) keep
the factory, composing `renewal` and `authDebug` itself. *Recommended: (a)* —
one composition of the row (H5); cost: an `--env` session without binding no
longer refreshes (H3 requires that anyway).

**D13 — `--browser`'s names.**
(a) Keep 2.x's names, mapped per `process.platform` by §10.3's table, refused on
other platforms; (b) new names (`default`, `program:<x>`); (c) only
`--browser-program`. *Recommended: (a)* — every 2.x invocation keeps working
(H8), and the mapping is the CLI's explicit statement.

**D14 — `--browser-program <program>`.**
(a) Add it (the launcher's program per platform, as given); (b) do not.
*Recommended: (a)* — replaces 5.x's candidate list (`google-chrome-stable`,
`chromium`) without the CLI guessing.

**D15 — `--browser`'s default.**
(a) `auto` — open the platform's default browser, as 2.x; (b) `none` — show
the URL only. *Recommended: (a)* — 2.x behaviour, stated in help; a failed
launch still shows the URL.

**D16 — The CLI's stdout.**
(a) Only `help` and `--version` on stdout; progress, prompts and logs on
stderr, with a CLI logger writing every level to stderr (and
`@mcp-abap-adt/logger` dropped); (b) keep progress on stdout (a terminal
command has no stdio transport). *Recommended: (a)* — H2's stdout rule holds
without arguing where the CLI runs, and a script can read stdout cleanly.

**D17 — The CLI's log switches.**
(a) `--verbose` (debug logger) and `--auth-debug` (implies `--verbose`, sets
`authDebug`), no environment variables read; (b) `--auth-debug` alone, both
effects; (c) keep the `DEBUG_SSO` environment switch for the log level.
*Recommended: (a)* — verbosity without exposing prepared secrets; "never from
the environment" applied to all of the CLI's logging.

**D18 — How the CLI ends on a signal.**
(a) Exit 130 (`SIGINT`) / 143 (`SIGTERM`) after the aborted login settled, a
second signal exiting at once; (b) exit 1 on any abort, no second-signal
shortcut. *Recommended: (a)* — the codes `workDir.ts` already uses; a second
Ctrl+C is the user's own bound if a consumer strategy does not settle.

**D19 — The authorization URL on the terminal.**
H2 forbids an authorization URL in what the CLI prints. (a) The provider's
prompt that sends the user to the URL (`showUrl`, the browser fallback) stays
on stderr — it is the login itself, the only way to finish with `--browser
none` — and the CLI prints no URL of its own; (b) the CLI shows the URL only
through `consumerPresentation` in a form of its own choosing; (c) no URL at
all, `--browser none` removed. *Recommended: (a)* — confirm this reading of H2.

**D20 — The CLI's own choices for the broker.**
(a) `renewal: () => refreshThenLogin()` and `onWriteFailure: 'fail'` for every
command; (b) `refreshOnly()` for `--env` runs (never a login when a refresh
token exists). *Recommended: (a)* — 2.x's steps, and a command must know its
secret landed before it writes the output.
