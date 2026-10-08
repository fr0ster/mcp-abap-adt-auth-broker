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
  words ("Session writes still failing for "<destination>", …") and whose `errors` are one `SessionWriteFailure` per
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
- `write(tokens: PersistedTokens)` queues one session write for the
  destination in the broker's `SessionWriter` (§5.3) and resolves when it
  landed, or rejects with the store's error when it did not — so
  `refreshStatePersistence` keeps its logical state (`held` / `cleared`) and its
  pending delivery, and the `SessionWriter` keeps the destination's failed
  write pending until a later write of the destination lands.
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
| `refreshToken: undefined` | **the refresh token this build owns, written explicitly as its value — or `refreshToken: ''` when it owns none.** Never read from the store at write time, never decided by comparing records (§6.2: a provider persists only refresh state it owns) — never omitted, so no refresh token of other means, or of a provider replaced in this process, ends up beside this credential |
| beside every credential | `issuedFor` of the build's binding, `''` when the means lack its source, and `issuedBy` — the build's version-2 record (§6.1), always present — never left out, so no earlier binding survives the merge beside a new credential |
| `authorizationToken === ''` (a discard before any credential is held — a credential-free write) | **only `refreshToken: ''`**: no credential field, no `expiresAt`, no binding field. The stored credential, whatever identity it was obtained for, keeps its own binding — the write never re-labels it — and loses its refresh token, which the provider discarded |

**The refresh token a build owns.** Each build keeps, in memory, the refresh
token it owns: at build, the one it was **seeded with** from the checked
session (§6.2) — none for a build that started with nothing: every replacement
after a change, every build of a binding that is not fully stated,
`token_exchange`, `client_credentials`; then each write updates it — a string
written makes it owned, `null` (a discard) makes it none. `undefined` writes
the owned one or `''`. So a refresh token is persisted only by the build that
obtained it or was seeded with it and has not discarded or replaced it since;
a session written by an earlier provider of the destination — even under an
identical record, as after a password or client-secret change within one
process — never lends its refresh token to a new one. A carried refresh token
therefore never changes its binding, and every other refresh token in the
store at write time is cleared by the write.

`expiresAt` is the report's (`ReportedCredential.expiresAt`, absolute); the
broker no longer derives one from `expiresIn` on this path. A destination the
key store states as `basic` or `snc` at write time is still not written (4.x,
`AuthBroker.ts:1261-1272`).

### 5.3 Session writes: one queue per destination (ruled 2026-10-08, D23)

The writer is a plain queue per destination. The consumer's store is a
collaborator with a contract (§11.1, README); the broker builds no machinery
against a store that breaks it.

- **One at a time, in order.** The writes of one destination run one after
  another, in the order they were queued; an older write never runs after, and
  so never overwrites, a newer one.
- **A retired build's late write is dropped** (H3). Every build takes a
  generation from a counter per (destination, path) (§7.1); a write queued by
  a build older than the newest build **of the same path** that has queued a
  write for the destination is dropped on arrival — never written. A build of
  the other path never retires this one: the row path's provider and the
  consumer path's provider both write while they live (the two-sources caveat,
  §5.5).
- **A failed write stays pending.** The destination then has a pending write:
  the latest state its build reported (every write is built from the logical
  state, §5.2, so the latest one is the one that must land). It is retried by
  the destination's next write — which, being built from the same logical
  state, carries it — or by `flush()`. There is no retry timer.
- **No detached writes from a call's point of view.** Every write a call
  causes is awaited by that call: `getToken` / `refreshToken` / `getProvider`
  through the provider's awaited report or their own write (§5.5), and a
  connection request whose renewal produced a credential through the
  provider's awaited report — the moment (`authorize()`, `rejected()`,
  `prepare()`) does not answer before the write settled. A report the provider
  makes after every caller has left (a discard at an abort, a late refresh
  result — auth-providers' detached report) has nobody left to await it: it is
  queued like any other, and its failure leaves the destination's write
  pending (§5.4).
- **Every wait races its owner's signal** (H4). A caller waiting for its write,
  or for the queue ahead of it, is released at once by its own signal with
  auth-errors' `aborted` failure — never with success — and the write runs on,
  landing or failing on its own (§7.5).
- **The store's contract** (README, §11.1): `saveSession` settles — resolves or
  rejects. A store that never settles holds its destination's queue; avoiding
  that is the consumer's. Each waiting caller is still released by its own
  signal.

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

**`'fail'`:**

1. **The call whose write did not land fails** — `unknown`,
   `persisting-tokens`: for a provider the broker built, the provider's
   awaited report fails its `getTokens()` / `refreshTokens()` or its moment,
   and the token API relays that failure (§3.1); on the consumer path the
   token API rejects with §3.3's failure.
2. **While the destination's last write is pending, its `'fail'` calls are
   refused until a write lands.** `getProvider`, `getToken` and
   `refreshToken` ask "is the destination's last write pending" **twice: on
   entry, and once more right before they return success** — a write an
   already-held provider queued meanwhile (a discard its store rejected, say)
   is caught by the second check. Each time the answer is yes, the call
   retries that write (it is the destination's next write, queued like any
   other, awaited and raced against the call's signal): it lands → the call
   goes on (on entry) or returns (at the end); it fails → the call rejects
   with §3.3's failure. That is the whole rule.
3. **Limit, stated (D4):** a provider already handed to a connector answers its
   moments from its own state; a moment that commits nothing (a valid cached
   token presented) is not refused because of a pending write. Every moment
   that renews writes, and awaits its write (point 1).

**`'continue'`:** no call fails because of a write. A failed write is logged
(`warn`, `logFields` only), stays pending and is retried by the next write or
`flush()`; the call goes on. The restart guarantees of §5.6 hold for every
write that landed, and the README says exactly that: a refresh token discarded
while its `''` write is pending at the moment the process ends comes back from
the store after a restart.

### 5.5 The token API with the consumer's provider

The consumer's provider has no broker-built persistence: the token API writes
every answer itself, cache hits included, through the same `SessionWriter`, as
4.x. Three changes, each forced by the goal:

- **The call awaits its own write, and may abandon the wait.** 4.x awaited
  `writer.submit` directly, so no signal could release a caller stuck in a
  `saveSession` or queued behind another write. 5.0.0 queues the call's write
  (§5.3) and awaits it raced against the call's signal: an abort releases the
  caller at once with `aborted` — never with success — under either policy,
  and the write runs on. Without an abort: under `'fail'` a write that did not
  land rejects the call (§5.4); under `'continue'` the call returns the token
  once its write settled, whatever it came to.

- **The result's refresh token is authoritative (D5).** auth-providers 6.0.0
  returns from `getTokens()` / `refreshTokens()` the refresh token the provider
  holds, or `refreshToken: undefined`. So a result with a refresh token writes
  it; one without writes `refreshToken: ''` — explicitly, since the store
  merges. The stored refresh token is never carried into a consumer
  provider's write (4.x's `carry: 'any'` goes): a refresh token the consumer's
  provider discarded never comes back from the store, and one stored under
  other means never ends up beside the consumer provider's credential. The
  binding fields are written as §5.2 says: `issuedFor`, and the `issuedBy`
  record with the row `provider/…` (§6.1) — so a session the consumer's
  provider wrote is never seeded into a provider `getProvider` builds, nor the
  reverse (4.x achieved one direction by writing no `issuedBy` for an
  instance).
- **Never seeded from the store** (ruled 2026-10-08: the package does not
  guess what the consumer composes). The broker cannot know what a factory
  reads from what it is handed — it may build a `password` provider from
  `connConfig`, so a record of client and `uaaUrl` cannot say whose credential
  a stored session is. So the consumer path — factory **and** instance — is
  never fully stated (§6.1): the factory is handed the means and the client,
  **never a stored secret** (no token, cookies, expiry or refresh token in
  `authConfig`, `connConfig` or the fourth argument), and the broker never
  carries a stored refresh token into this path's writes — it writes what the
  provider returned, `''` when it returned none (owned refresh state, §5.2). A
  consumer whose provider must resume after a restart composes that itself:
  its provider's own seed and persistence.

**Its own path.** The consumer's provider is resolved, cached and identified on
the consumer path (§7.1): its own slot, its own cache entry, its own
identity (the means it was handed, the client of the `provider/…` record) and
binding. `getProvider` never uses it and never shares its resolution — a
destination with a `provider` option and a `getProvider` caller has two
providers, each writing the same session with its own record (4.x's "two
token sources" caveat, kept in the README: use one path per destination). Its
writes keep the `provider/…` record, so the row path never seeds from them;
the consumer path itself seeds from nothing.

`onWriteFailure` governs this path as §5.4 says.

### 5.6 Across restarts

A new broker on the same stores seeds each token row only from a session bound
to its means (§6), with its refresh token only when it is non-empty. Hence:

| Before the restart | After it |
|---|---|
| R discarded (refused refresh, `sentRefreshToken: 'discard'`, `ifCut: 'discard'`) and its `''` write landed | no refresh token: the provider's renewal strategy decides (with `refreshThenLogin()`, a login) |
| the same, the `''` write still pending at exit | `'fail'`: noticed — every call failed and `flush()` rejected before exit; `'continue'`: R comes back (README) |
| a new R2 landed | R2 |
| a token-only result while R held (`none`, state `held`) | R — the one that build owned (seeded with it, or obtained it) |
| a credential under other means (§6) | discarded, not seeded |

Remaining limit, auth-providers' own and restated in the README: a process that
dies between a discard and its report reaching the broker may present the
stored R once after a restart.

## 6. A credential stays bound to its identity (H3)

### 6.1 The identity, and how it is persisted (D21)

A build's identity is the resource (`serviceUrl` and SAP client), the issuer
and client, **and the row** (`authType`, `grantType`) **(D6)**. 4.x persisted
only the first two: `destinationBinding` / `boundHere` encode and compare
resource, issuer and client, and auth-stores 4.0.0's `SessionSecret` holds no
other binding field than `issuedFor` and `issuedBy` (both kept "as given";
written and cleared with the credential; not kept when no credential is
held). So a destination switched from `authorization_code` to
`client_credentials` with the same resource and UAA client would accept the
user's token and refresh token as the application's — in one broker's life
and after a restart alike, since nothing stored names the grant. 5.0.0
persists the row inside the two strings the store already holds; no store
field is added.

**`issuedFor`** is unchanged: the 4.x canonical resource URI (`serviceUrl`
with `sap-client`), absent when the means state no `serviceUrl`.

**`issuedBy`** becomes a versioned record the broker writes and only the
broker produces. **It holds, exactly as the provider receives them, every
means value the row hands its provider that addresses a server** — where a
credential is sent, or where the login or the assertion goes:

```
issuedBy = "mcp-abap-adt-binding/2;" row ";" fields
fields   = enc(clientId) ";" enc(uaaUrl) ";" enc(oidcIssuerUrl) ";"
           enc(oidcTokenEndpoint) ";" enc(oidcAuthorizationEndpoint) ";"
           enc(oidcDeviceAuthorizationEndpoint) ";" enc(oidcAudience) ";"
           enc(samlIdpSsoUrl) ";" enc(samlAcsUrl) ";" enc(samlTokenUrl) ";"
           enc(certUrl) ";" trust                   always twelve fields, in this order
trust    = lower-case hex SHA-256 of the row's trust input (below), or "" for a
           row that has none
enc(x)   = encodeURIComponent(x) of the exact string the row hands the provider,
           or "" when the row hands it none
row      = authType "/" grantType                   a row getProvider builds:
                                                    jwt/authorization_code, jwt/client_credentials,
                                                    jwt/passcode, jwt/oidc_authorization_code,
                                                    jwt/device_code, jwt/password, jwt/token_exchange,
                                                    saml/saml2_pure, saml/saml2_bearer,
                                                    jwt/none, saml/none
         | "provider/" authType "/" grantType       the token API's consumer provider, the means'
         | "provider/-"                              row when stated, "-" when they state none
```

Which fields each row fills — the values `destinations.ts` hands its
provider, no others:

| Row | Fields filled (exact strings) |
|---|---|
| `jwt` / `authorization_code`, `client_credentials`, `passcode` (`uaaProvider`, `:381-430`) | `clientId`, `uaaUrl`; `certUrl` when the build read the certificate client for the `clientAuthentication` strategy |
| `jwt` / `oidc_authorization_code`, `device_code`, `password`, `token_exchange` (`oidcProvider`, `:555-616`) | `clientId`, `oidcIssuerUrl`, `oidcTokenEndpoint`; `oidcAuthorizationEndpoint` (`oidc_authorization_code`); `oidcDeviceAuthorizationEndpoint` (`device_code`); `oidcAudience` (`token_exchange`); `certUrl` as above |
| `saml` / `saml2_pure` (`samlProvider`, `:739-767`) | `samlIdpSsoUrl`, `samlAcsUrl` |
| `saml` / `saml2_bearer` (`:739-781`) | `clientId`, `uaaUrl`, `samlIdpSsoUrl`, `samlAcsUrl`, `samlTokenUrl`; `certUrl` as above |
| `jwt` / `none` (`handedOverBinding`) | `clientId`, `uaaUrl`, `oidcIssuerUrl` as the means state them |
| `saml` / `none` | `samlAcsUrl` |
| `provider/…` (the consumer factory) | `clientId`, `uaaUrl` of the client the factory was handed; the instance: none |

- **No canonicalisation of what a credential is sent to.** Each field is the
  string the provider gets, byte for byte (after `stated()`'s rule that `''`
  is absent). Any difference — a trailing `/`, a case change, a query, a port
  written out — is a different record: a new provider, unseeded, one login
  (§6.2). Nothing aliases two endpoints a server may route differently.
- **The client is in the record** for every row that authenticates one
  (`clientId`), with every server address it is used with; 4.x's
  `client_id`-in-issuer binding is kept in strength, and made exact.
- **`certUrl`** is the certificate client's, as the store answered it, when the
  build read it (its token endpoint is `<certUrl>/oauth/token`). An endpoint
  a consumer's own `clientAuthentication` strategy answers is that strategy's
  composition (H6) and is not recorded.
- **Values that address no server are not in it** — scopes, `samlSpEntityId`,
  `samlIdpEntityId`, `samlRelayState`, user, subject and actor tokens: a change
  of them does not change where a credential goes. (`samlIdpEntityId` and the
  certificates decide trust, checked by the validator on every assertion.)
- **`issuedFor` alone stays canonical** (4.x's resource URI), because the
  resource identity is compared with sessions and `bindingOf` values written by
  every 4.x-era consumer and by auth-stores' legacy composition; the
  credential is sent there by the connector, not by the provider.
- **Version 2**, since no released broker has written a version-2 record.

**The trust field.** A session obtained under other trust must not seed a
provider built under new trust (a removed, compromised IdP certificate; another
expected IdP). The record's twelfth field is a digest of the row's **non-secret
values that decide what is accepted or whose credential it is**:

| Row | Trust input, in this order |
|---|---|
| `saml2_pure`, `saml2_bearer` | `samlIdpCertificates` (the array as the means state it, order kept), `samlIdpEntityId`, `samlSpEntityId`, `samlClockSkewMs`, `samlIdpInitiated`; for `saml2_bearer` also `clientCertificate` |
| OIDC rows | `oidcScopes`; `username` (`password`: whose credential it is); `oidcSubjectTokenType`, `oidcActorTokenType` (`token_exchange`); `clientCertificate` |
| UAA rows | `clientCertificate` |
| `none` rows, the consumer path | none: the field is `""` |

`clientCertificate` is the certificate client's public certificate PEM, as the
store answered it, when the build read it for the `clientAuthentication`
strategy — never its key. The validator a row uses is decided by its grant,
already in the record.

- **Serialisation for hashing**, deterministic and never parsed back: the
  UTF-8 bytes of `"mcp-abap-adt-binding/2/trust\n"` followed by
  `JSON.stringify` of an array of `[name, value]` pairs in the row's fixed
  order — each value a string, an array of strings, a number, a boolean, or
  `null` for an absent one, exactly as the means state it (no trimming, no
  canonicalisation). `JSON.stringify` of arrays and primitives has one output,
  so equal inputs give equal bytes. The digest is `createHash('sha256')`
  (`node:crypto`), hex, lower case.
- **No secret goes into it**, nor into any other field: not the password, the
  client secret, a private key, a subject or actor token. A hash of a secret
  in a session file can be checked offline against guesses — a password or a
  short client secret falls to that — and it still identifies the secret. So
  secrets take part only in the in-memory identity (§6.2). The consequence,
  stated: after a restart, a session obtained under a previous password or
  client secret of the **same** user or client may seed (the secret is not the
  identity; a revoked credential is refused by the server and renewed through
  the renewal strategy); within one process a secret change always makes a new
  provider.
- **A row whose identity is a secret never seeds:** `token_exchange` — its
  subject (and actor) token decides whose credential it obtains, and cannot be
  recorded. It is not fully stated (below) and obtains a fresh token after
  every restart (a token request, no user interaction).
- **Credentials obtained under previous trust never seed a provider built
  under new trust**: a different digest is a different record (decided).

**Fully stated, and what is not.** A binding is **fully stated** when its
record holds the client the row authenticates and every server address its
provider sends a credential to — the token, the refresh token, the code, the
client's authentication, the assertion. Per row (the table above):

| Row | Fully stated when the record holds |
|---|---|
| UAA rows | `clientId` and `uaaUrl` (the token endpoint is `<uaaUrl>/oauth/token`); and `certUrl` when the build read the certificate client |
| OIDC rows | `clientId`; the token endpoint — `oidcTokenEndpoint`, or `oidcIssuerUrl` from which it is discovered; for `oidc_authorization_code` the authorization endpoint (`oidcAuthorizationEndpoint`, or the issuer); for `device_code` the device endpoint (`oidcDeviceAuthorizationEndpoint`, or the issuer); `certUrl` as above |
| `saml2_bearer` | `clientId`, `samlIdpSsoUrl`, and the token endpoint — `samlTokenUrl`, or `uaaUrl`; `samlAcsUrl` when stated; `certUrl` as above |
| `saml2_pure` | `samlIdpSsoUrl` and `samlAcsUrl` (the system that sets the cookies) |
| the consumer factory | never: the broker cannot know what the factory composes from what it is handed (ruled 2026-10-08) |
| the consumer instance | never: it is handed no client |
| `token_exchange` | never: its subject is a secret the record cannot hold |

A fully stated binding may be seeded from — and, through the refresh token it
was seeded with, carry (§5.2) — a session whose record equals it exactly. **An issuer-less OIDC row with
explicit endpoints and a client is therefore fully stated** (ruled
2026-10-08, relaxing round 3's rule now that the record is exact): its record
names its client and every endpoint it sends a credential to, so a session
written under the same exact means is reused after a restart, and any switch of
client or endpoint is a different record. **A binding missing the client or an
address its credential goes to is never seeded and never carried** — decided
from the broker's own computed binding, never from the stored string; its
record is still written (and §5.2 writes `refreshToken: ''`), and such a
destination logs in after every restart. The earlier rule that an endpoint
"with no canonical form" binds nothing is dropped: an exact string is always
recorded exactly. The `none` rows keep 4.x's rule for a handed-over credential
(§6.5): the record is compared by exact equality — that check presents a
credential the consumer handed over, it seeds no renewal.

- **Deterministic.** `authType` and `grantType` are values of their closed
  lists (checked by `statedAuthType` / `statedGrant` before any binding is
  computed), so neither holds `;` or `/`; every field is
  `encodeURIComponent`-encoded, so it holds no `;`, `#`, `=`, space or line
  break, and the twelve fields are always present — unambiguous without being
  parsed — and the string round-trips through every auth-stores session store,
  the `.env` files included.
- **Never parsed.** The broker computes the expected `issuedBy` for a build
  with the same one function (`destinationBinding`, behind `bindingOf`) and
  compares it with the stored string by exact equality. The stored string is
  not split, matched or canonicalised; `issuedFor` keeps its 4.x
  canonicalisation on both sides. No regular expression is involved.
- **Every row now always has `issuedBy`** — at least its row — so a
  credential is always bound to its row, even where 4.x wrote no `issuedBy`
  (`saml2_pure`, the consumer instance, means without an issuer).
- **A stored binding without the record is unbound.** Every 4.x session (its
  `issuedBy` a bare URI, or absent), every pre-3.1 file whose binding
  auth-stores composes from `SAP_URL` / `SAP_UAA_URL`, and any string not
  produced by the version-2 function: never equal, so never seeded, never
  carried (§5.2), and refused for a `none` row (§6.5). A later format is
  `mcp-abap-adt-binding/3;…`, unequal to this one by construction.
- **`bindingOf(means, client)`** (public, signature unchanged) returns this
  `issuedBy` for the row the means state — `authType` and `grantType` read from
  `means` — so a consumer handing over a credential writes exactly what
  `getProvider` compares; for means stating no `jwt` / `saml` type or no grant
  it still returns `{}`.
- **`boundHere`** answers false when the expected binding is not fully stated
  (above); otherwise it compares `issuedFor` as 4.x
  (canonical, the strategy path's `unstatedResourceMatches`) and `issuedBy` by
  exact equality with the expected record; a session with no `issuedBy` is
  never bound.

### 6.2 One rule: a provider is never changed — changed means get a new one

**A provider is never changed or re-seeded in place.** The broker builds a
destination's provider once and hands that one out while nothing it was built
from has changed. Two identities, one rule:

- **The build identity (in memory)** is **everything the build read** to make
  the provider: every value of the means, the client and the certificate client
  the row's builder reads — trust (certificates, IdP and SP entity ids, clock
  skew, `samlIdpInitiated`), scopes, audience, user, password, client secret,
  subject and actor tokens, certificate and key material, endpoints and
  addresses — recorded by the build through one recording accessor, so the
  set of fields is the row's own and cannot drift from the builder. Each value
  is kept as given and compared exactly (arrays element by element, an absent
  value distinct from `''`). Secrets take part **only here**: held in memory
  beside the provider, which holds them anyway, never logged, never persisted,
  never hashed into anything persisted. Every call of `getProvider` and of the
  token API re-reads the means (§7.1) — and, for a build that read it, the
  certificate client — and compares.
- **The persisted identity** is `issuedFor` and the complete `issuedBy` record
  of §6.1 — the client, every server address, and the trust digest — what a
  stored session is compared with.

The broker's own options (`renewal`, `authorization`, `onWriteFailure`, …) are
fixed for the broker's life and so cannot change under a provider; what a
collaborator option returns is part of the build it was called for, and is
called again for a new build.

- **Unchanged build identity:** the cached provider is answered, as it is.
- **Anything really changed** — any value the build read, by a single
  character (trust, a secret, an address, the row): the broker builds a **new provider**. The old one is dropped from
  the cache and never handed out again for that destination; whoever already
  holds it keeps it (H6), and its late writes are dropped once the new build
  has written (§5.3).
- **A new provider for changed means starts with nothing** — nothing from the
  old provider (no token, refresh token, pinned material or state is carried
  across) and nothing from a session written under other means: it logs in.
- **A provider may start from a stored session only when its persisted
  identity equals the session's stored binding** — `issuedFor` and the exact
  `issuedBy` record, trust digest included — and the binding is fully stated (§6.1: the client and
  every address its credential goes to): the
  case of a restart, or a first build, with unchanged means. Then the token,
  cookies and expiry come from that same read (`strategySeed`), and the refresh
  token from that same read whose binding was checked
  (`strategyAuthorization`), never from another read. This is the row path
  only: the consumer path is never seeded (§5.5), so 4.x's seeding of the
  factory (`composeAuthorization`, `AuthBroker.ts:341-356`, and the strategy
  path's bound seed) goes.

**A provider persists only refresh state it owns** (§5.2). Carrying a
refresh token is a property of the build, not of record equality: a write may
keep a refresh token only when this build was itself seeded with it from the
checked session, or obtained it, and still holds it — no discard, no newer
one since. A build that started with nothing writes `refreshToken: ''` unless
it obtained a new one; it never inherits one from the store, whatever the
store's record says.

### 6.3 Who the rule applies to

- **`getProvider`'s providers and the token API without a `provider`
  option** (the row path): as §6.2, through the row path's resolution (§7.1),
  so a change is seen at the next call — 4.x cached a destination's provider for the
  broker's life and "picked up" a change only in a new broker.
- **The consumer's factory** (the consumer path, its own resolution and cache
  entry): the same rebuild rule — its in-memory identity is everything the
  broker hands the factory (the means and the client); a change makes the
  broker call the factory again, and the new provider starts with nothing. It
  is **never seeded from the store**, after a restart or otherwise (§5.5). A
  change seen on one path rebuilds that path's provider only.
- **The consumer's instance** cannot be rebuilt, and the identity of the
  credential it holds is unknown to the broker: after the identity it was first
  used for changes, the token API refuses the destination
  (`DestinationConfigError(['provider'])`, "the destination's means changed
  since the provider instance was first used for it") until a new broker.

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
`sessionCookies`, the binding from 5.0.0's `bindingOf` (the version-2 record, row `saml/none`), `issuedFor` `''` when
absent, and `refreshToken: ''`).

### 6.5 Handed-over credentials (`none` rows)

`handedOverProvider` refuses a session whose `issuedFor` is not the
destination's resource (4.x) **and, now always, one whose `issuedBy` is not
the expected record** (4.x compared `issuedBy` only when the means stated an
issuer; the record now always carries the row). A token or cookies handed over
with 4.x's `bindingOf` — or by the CLI 2.x `--cookie` — is refused
(`DestinationConfigError`, `issuedBy`) until it is written again with 5.0.0's
`bindingOf`.

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

One `sharedAttempt<SlotOutcome<Resolved>>(...)` slot **and one cache entry per
(destination, path)**, two paths, as 4.x's separate `built` and
`consumerBuilt` caches:

- **the row path** — `getProvider`, and the token API when no `provider`
  option is given: the provider the destination's row states, its binding
  record with the row `authType/grantType`;
- **the consumer path** — the token API when a `provider` option (a factory
  or an instance) is given: the consumer's provider, its binding record with
  the row `provider/…` (§5.5, §6.1).

Every call is a waiter of its own path's slot: `join(start, signal)`. `start`
reads the means, compares that path's identity (§6.3) and answers that path's
cached build or builds; concurrent callers **of the same path** share one
resolution. The two paths never share a resolution, a provider, an identity or
a binding: with a `provider` option configured, a concurrent `getProvider` and
`getToken` for one destination resolve independently and get different
providers. Only the destination's session write queue (§5.3) is shared by
both paths.

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

- Every wait on the write queue — a call awaiting its own write (§5.5), the
  retry of a pending write before a `'fail'` call (§5.4, point 2) — is one
  waiter of its own `sharedAttempt` slot, using §7.1's outcome pattern: the
  caller's signal releases that caller only (`aborted`); the write runs on.
- `flush({ signal })` joins one broker-wide slot whose `start` resolves a
  `SlotOutcome<void>`; the `AggregateError` of §3.4 is its `thrown`, rethrown
  outside `join` as the same object (D9). An abort releases the caller; the
  attempts run on, and a write still failing stays pending.
- Every slot of the broker uses this one pattern; no slot's `start` throws.
- The consumer path's factory build is §7.1's resolution; the consumer's
  provider gets the call's signal through `getTokens({ signal })`.
- `getAuthorizationConfig` / `getConnectionConfig` are store reads with no
  signal (stores take none), unchanged.

### 7.6 No bound of the broker's own (H4)

The broker sets no timeout, passes no `AbortSignal.timeout`, adds no signal of
its own to any call, and the `SessionWriter` has no timer at all; nothing bounds anybody's
wait. A consumer that wants a bound passes one.

## 8. Logging and debug output (library)

### 8.1 What the broker logs

Only through the `ILogger` it is given (none: nothing), never stdout:

- `debug` lines of fixed words with allowlisted values: the build
  (`{ authType, grant, seeded }`), the token API's method. The destination name
  (the consumer's own string) is the only free value, as in 4.x.
- `warn`: a stored secret bound elsewhere and discarded (4.x's line); a session
  write that failed — `[AuthBroker] Session write for <destination> failed; it
  stays pending until the destination's next write or flush()` with
  `logFields(classify(error, 'persisting-tokens'))`; a retired build's write
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
// signature unchanged; it is handed the means and the client only — no stored token, cookies,
// expiry or refresh token in authConfig, connConfig or the fourth argument (§5.5)

export { DestinationConfigError, isDestinationConfigError, SessionWriteFailure };
export type { BrokerCallOptions, TokenGrant };
// re-exported types updated to interfaces-auth 7: IRenewalStrategy added beside ITokenRefresher, IClientAuthentication
```

`bindingOf(means, client)` keeps its signature and now returns the version-2 `issuedBy` record (§6.1). Unchanged: `fromServiceKeyCertificate()`, `fromServiceKeySecret({
encoding })` (their words stay; `fromServiceKeyCertificate` relies on
`tlsMaterial()` throwing an `AuthProviderFailure` of kind `client-certificate`,
carried by the guard, §3.2), the store contracts, `StrategyGrant`,
`TokenProviderClient`. The collaborator options keep their shapes; a strategy
passed to them must honour `AuthorizationRequest.signal` (auth-providers 6.0.0).

## 10. The CLI

**One command (D24, ruled by the user 2026-10-08).** CLI 3.0.0 ships one bin,
`mcp-auth`; the `mcp-sso` bin is removed — in SAP, "SSO" reads as SNC or
Kerberos, which it never did, and SNC has no secret for a credential CLI to
write. Everything `mcp-sso` did is an `mcp-auth` subcommand with the same
flags (§11.2's table):

| `mcp-auth` subcommand | What it runs | 2.x `mcp-sso` form |
|---|---|---|
| (none) / `auth-code` | UAA authorization code or `--credential` client credentials | — (already `mcp-auth`) |
| `oidc --flow browser\|device\|password\|token_exchange` | the OIDC grants; `--passcode` the UAA passcode grant; `--code` a code obtained elsewhere | `mcp-sso oidc --flow …`, `mcp-sso --protocol oidc --flow …` |
| `saml2-pure` | SAML → session cookies; `--cookie` hands over cookies | `mcp-sso saml2 --flow pure …`, `mcp-sso --protocol saml2 --flow pure …` |
| `saml2-bearer` | SAML assertion → OAuth token | `mcp-sso bearer …`, `mcp-sso saml2 --flow bearer …`, `mcp-sso --protocol saml2 --flow bearer …` |

- `--config <file>` is a flag of the subcommand its protocol and flow name
  (`mcp-auth oidc --config f`, `mcp-auth saml2-pure --config f`, `mcp-auth
  saml2-bearer --config f`); a file whose `protocol` / `flow` names another
  subcommand is a usage error naming `--config`. `--protocol` is not accepted:
  the subcommand is the protocol and flow.
- `saml2-bearer` no longer requires `--dev` (`mcp-sso bearer` never did);
  `--dev` is still accepted, has no effect, and `--help` says so (D24).
- The subcommands are `mcp-auth`'s own code paths: one process, one
  interrupt, one work directory (§10.4). The internal modules
  (`mcpSsoConfig.ts`, `runMcpSso.ts`, `samlMetadata.ts`) may keep their names;
  the argument parser takes an argument array and reads no `process.argv`.

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
provider is the broker's UAA row — the same composition the other subcommands and
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
- The same mapping, and the same default `auto`, serve **every flow that
  opens a browser** — `mcp-auth` (authorization code), `mcp-auth oidc --flow
  browser`, `mcp-auth saml2-pure` and `saml2-bearer` with the browser assertion
  flow — the `browser` field of a `--config` file (a string, mapped by the same
  function; an unknown value refused naming `browser`), and `generate-env`
  (2.x hard-coded `'system'`: it takes `--browser` too, default `auto`).
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
- **`mcp-auth`'s subcommands** (`oidc`, `saml2-pure`, `saml2-bearer`) run in
  `mcp-auth`'s own process — 2.x spawned the `mcp-sso` bin with `spawnSync`,
  so a `SIGTERM` to the parent's PID alone left the child's unbounded login
  running with its port and work directory. With one command there is no
  child: a signal to `mcp-auth` ends whatever login it runs.

### 10.5 The compositions, `state` and PKCE, and the manual SAML ACS

- **Compositions.** The CLI's strategies are auth-providers 6.0.0's named
  compositions: `browserCallbackStrategy({ browser, port, signal })`
  (`mcp-auth`, `generate-env`), `oidcCallbackStrategy` and
  `samlCallbackStrategy` (`mcp-auth oidc` / `saml2-*` browser flows), `manualPasscodeStrategy({
  read })`, `manualSamlResponseStrategy({ redirectUri, read })`,
  `staticCodeStrategy` (`--code`, `--passcode`, `--assertion`). Every
  listener is loopback-only, so `--redirect-port` keeps its meaning and a
  remote user tunnels (the providers' SSH hint).
- **`state` and PKCE** come with the providers: every UAA authorization-code
  login (`mcp-auth`, `generate-env`) carries `state` and an S256 challenge;
  every OIDC authorization-code login (`mcp-auth oidc --flow browser`) carries
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
  code is always shown on stderr (2.x passed the `mcp-sso` logger, which is off
  unless an environment variable turns it on — a user could not see the code).

### 10.6 Flags, by command

| Flag | `mcp-auth` (no subcommand / `auth-code`) | `mcp-auth oidc`, `saml2-pure`, `saml2-bearer` | `generate-env` | 3.0.0 |
|---|---|---|---|---|
| `--browser <name>` (default `auto`) | ✓ | ✓ (2.x `mcp-sso`'s) | new | mapped per platform (§10.3) |
| `--browser-program <program>` | new | new | new | §10.3 |
| `--auth-debug` | new | new | new | §10.7 |
| `--verbose` | new | new | new | §10.7 (D17) |
| `--acs-url <url>` | — | required for a manual SAML login unless metadata or `--config` states it | — | §10.5 |
| `--config <file>` | — | the subcommand's own; its protocol and flow must match | — | §10 (D24) |
| `--protocol` | — | removed: the subcommand is the protocol | — | D24 |
| `--dev` | — | accepted by `saml2-bearer`, no effect | — | D24 |
| `--redirect-port`, `--client-auth`, `--basic-encoding`, `--cert-path`, `--key-path`, every other 2.1.0 flag of `mcp-auth` or `mcp-sso` | unchanged | unchanged | unchanged | |
| `DEBUG_SSO`, `DEBUG_AUTH_SSO`, `DEBUG` (environment) | — | no longer read (2.x `mcp-sso` read them) | — | D17 |

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
  place the URL appears, `state` included, is the provider's prompt that sends
  the user there, on stderr: the goal's H2 exception for the login itself
  (D19). It never reaches a log line, an error or a diagnostic.

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
| the token API with a consumer `provider`: a call waited for its session write however long the store took | the wait races the call's `signal`: an abort releases the caller (`aborted`) while the write runs on |
| a failed session write was retried on a timer (1 s doubling to 60 s) | no timer: it stays pending and is retried by the destination's next write or `flush()` — call `flush()` on shutdown. Under `'fail'` the destination's calls are refused while it is pending |
| a store whose `saveSession` never settled kept being retried | **the store's contract:** `saveSession` must settle (resolve or reject). One that never settles holds that destination's write queue; each waiting caller is released by its own signal |
| `flush()`'s `AggregateError.errors`: `Error("<dest>": <class>)` | `SessionWriteFailure` (`destination`, `error`) |
| `getProvider(d)`, `getToken(d)`, `refreshToken(d)` | unchanged calls; each also takes `{ signal }` — the server ties a session's close to `getProvider`'s and each request's cancellation to the token API's |
| providers' 30 s / 300 s login timeouts | none: a login waits until it ends or a signal aborts; bound it with your own signal or strategy option |
| collaborator strategies of 5.x (`browserCallbackStrategy({ browser: 'system', timeoutMs })`, `openUrl`) | 6.0.0's: `browser` an `IBrowser`, `signal` instead of `timeoutMs`, `redirectUri` required for the manual ones; a strategy of yours must honour `AuthorizationRequest.signal` |
| a stored session bound by `issuedFor` / `issuedBy` (issuer and client) | the binding also names the row: `issuedBy` is a versioned record (§6.1). **Every session written before 5.0.0 reads as unbound once**: for each token destination the stored token and refresh token are discarded (one `warn` line) and the provider's first renewal is a **login, not a refresh** — interactive for `authorization_code`, `passcode`, `oidc_authorization_code`, `device_code` and the SAML grants; a token request for `client_credentials`, `password`, `token_exchange`. A headless consumer must run that login once per destination after upgrading. A handed-over credential (`none`) is refused naming `issuedBy` until written again with 5.0.0's `bindingOf`. A switch of grant with unchanged resource and client no longer reuses the other grant's credential |
| SAML trust (`samlIdpCertificates`, `samlIdpEntityId`, `samlSpEntityId`, `samlClockSkewMs`, `samlIdpInitiated`), OIDC scopes, the `password` grant's user, the certificate client's certificate, changed | the destination **logs in once** — within a running broker and after a restart; 4.x kept the cached provider and its session, accepting assertions under the trust it was built with |
| any other value a build reads changed (a password, a client secret, a subject token, an option of the means) | within a running broker: a new provider, **one login**; after a restart, only a change the record holds (above) forces a login — a secret is not persisted in any form |
| a `token_exchange` destination | obtains a fresh token after every restart (one token request, no interaction): its subject is a secret and cannot bind a stored session |
| a server address the destination states changed (`uaaUrl`, `oidcIssuerUrl`, the three OIDC endpoints, `oidcAudience`, `samlIdpSsoUrl`, `samlAcsUrl`, `samlTokenUrl`, a certificate client's `certUrl`) or its client id | the stored token and refresh token are not reused: the destination **logs in once** after the change (4.x refreshed with the old refresh token at the new address, or kept its token). **Even a cosmetic change counts** — a trailing `/`, a case change, a port written out: the strings are compared exactly, so editing an endpoint's spelling costs one login |
| an OIDC destination with explicit endpoints only (no `oidcIssuerUrl`, no `uaaUrl`) — 4.x never seeded its session | **now reused after a restart** when its means are unchanged, byte for byte: its record names its client and every endpoint (§6.1). Only a destination whose means lack the client the row authenticates, or an address its credential goes to (table in §6.1), is never seeded and logs in after every restart |
| means changed under a running broker were picked up by a new broker | picked up at the next call: a changed identity (resource, SAP client, issuer, client, row) rebuilds the destination's provider, unseeded from a session bound elsewhere; an instance `provider` is refused for that destination until a new broker |
| the token API's factory seeded with whatever the session held (`authConfig.refreshToken`, `connConfig`'s token and expiry, the fourth argument's `refreshToken`) | **handed no stored secret at all**: the means and the client only. A factory that relied on being handed the stored session to resume after a restart must compose that itself — give its provider its own persistence (e.g. `refreshStatePersistence` over a store of yours) and its own seed — or use `getProvider`'s path, whose providers the broker seeds from a matching record. The broker still writes what the provider returns, with the `provider/…` record |
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
| `DEBUG_SSO=true` etc. for the `mcp-sso` log | `--verbose`; `--auth-debug` for the providers' debug line, with prepared secrets |
| error output: a message and a stack trace | `reason — hint`, then the diagnostics line; no stack trace |
| an `--env` session refreshed with its refresh token | a session written by CLI 2.x (or earlier) is not bound under 3.0.0's binding record: the first run after upgrading discards it with a warning and **logs in** (no refresh); later runs refresh as before |
| `mcp-sso … --cookie` sessions written by 2.x | refused naming `issuedBy` by 3.0.0: run `mcp-auth saml2-pure … --cookie` again |
| the `mcp-sso` command | **gone in 3.0.0**: every form is an `mcp-auth` subcommand with the same flags (table below) |
| `mcp-auth oidc` / `saml2-pure` / `saml2-bearer` started a second process (`mcp-sso`) | they run in `mcp-auth`'s process; a signal to it ends the login, frees the port and removes the work directory |
| `mcp-auth saml2-bearer` required `--dev` | it does not; `--dev` is accepted and has no effect |

**`mcp-sso` → `mcp-auth`:**

| 2.x | 3.0.0 |
|---|---|
| `mcp-sso oidc --flow <browser\|device\|password\|token_exchange> …` | `mcp-auth oidc --flow <…> …` |
| `mcp-sso --protocol oidc --flow <flow> …` | `mcp-auth oidc --flow <flow> …` |
| `mcp-sso oidc … --passcode <p>` (the UAA passcode grant) | `mcp-auth oidc … --passcode <p>` |
| `mcp-sso oidc --flow browser … --code <c>` | `mcp-auth oidc --flow browser … --code <c>` |
| `mcp-sso saml2 --flow pure …` / `--protocol saml2 --flow pure …` | `mcp-auth saml2-pure …` |
| `mcp-sso saml2 --flow pure … --cookie "<cookies>"` | `mcp-auth saml2-pure … --cookie "<cookies>"` |
| `mcp-sso bearer …` / `saml2 --flow bearer …` / `--protocol saml2 --flow bearer …` | `mcp-auth saml2-bearer …` |
| `mcp-sso --config <file> …` (protocol and flow in the file) | `mcp-auth <the subcommand the file names> --config <file> …` |
| `mcp-sso --version`, `help` | `mcp-auth --version`, `mcp-auth <subcommand> --help` |
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
   `auth-errors`; `mcp-auth --version` prints 3.0.0, `mcp-sso` is not
   installed (no such bin), and `mcp-auth <subcommand> --help` answers for
   every subcommand; a
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
- The same with the `''` write failing once, then landing as the
  destination's next write; and with the fallback login itself failing — R
  still cleared.
- Refresh cut after dispatch (real socket, withheld response, `ifCut:
  'discard'`): `''` lands; restart → no R; the late R2 released afterwards with
  nothing newer committed → R2 written.
- Failed `''` → a token-only `credential` report → the retried write lands →
  restart finds no R. **[break: build a retry from the single result instead of
  the latest submission]**
- New R after a pending `''` wins (stored R new).
- `credential`, `none` while `held`, for a build seeded with R: R written as
  its value, the binding unchanged; the same for a build that obtained R itself
  earlier.
- **A provider persists only refresh state it owns.** A UAA row seeded with
  R_old; its client secret (and separately an OIDC `password` row's password)
  changes within one process → the next resolution builds a new provider that
  starts with nothing → its login returns a token and no refresh token → the
  resulting store state holds the new token and **no** R_old (`loadSession`) →
  restart (fresh broker, same files, record unchanged): R_old is sent to no
  token endpoint (asserted at the endpoint), and with no refresh token stored
  the provider logs in. Also: a replacement after a trust change, and a
  `client_credentials` result, write `''`. **[break: carry by record equality
  (re-read the stored session at write time) → red]**
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
- **A changed grant with the same resource, issuer and client.** A
  destination stating `jwt` / `authorization_code` logs in (user token T_u,
  refresh token R_u, both in the store with the `jwt/authorization_code`
  record); the means are switched to `jwt` / `client_credentials` with
  identical `serviceUrl`, `sapClient`, `uaaUrl` and client id. (1) **Within one
  broker's life:** the next `getProvider` / `getToken` builds a new provider;
  the token endpoint receives a `client_credentials` request and never T_u or
  R_u; the resulting store state holds the application token, the
  `jwt/client_credentials` record and no refresh token. (2) **After a
  restart** (a fresh broker on the same files, the switch made between the two
  runs): the same assertions. (3) The reverse switch (`client_credentials` →
  `authorization_code`): the stored application token is not seeded — the
  first renewal goes to the authorization strategy, and no stored token is
  presented. **[break: drop the row from the `issuedBy` comparison]**
  **[break: compare `issuedFor` only]**
- **An issuer-less OIDC destination: client switch and endpoint switch.** A
  `jwt` / `device_code` (and separately `password`) destination stating
  explicit endpoints only — no `oidcIssuerUrl`, no `uaaUrl` — logs in with
  client A against token endpoint E1 (token T_A, refresh token R_A). Then, (1)
  the client id is switched to B, and (2) separately the token endpoint to E2,
  resource and grant unchanged. **Within one broker's life:** the next call
  builds a new provider; T_A is presented nowhere (asserted on the resource
  side of the local server) and R_A reaches no token endpoint (asserted on E1
  and E2). **After a restart** (fresh broker, same files), with either
  switch: the same. **After a restart with the exact same means** (no switch):
  the destination **is** seeded — T_A is presented, and its first renewal
  sends R_A to E1 (asserted at E1). **[break: never seed an issuer-less row →
  the unchanged-means case red]** **[break: leave an endpoint out of the
  record → a switch case red]**
- **A row that is not fully stated is never seeded.** The rows that build
  without being fully stated (every other row refuses at build without its
  client and addresses, §3.2): `saml2_pure` without `samlAcsUrl`; the token
  API's consumer instance; the consumer factory (never, §5.5).
  After a restart with unchanged means each logs in, the stored token or
  cookies are presented nowhere and the stored refresh token is sent nowhere;
  the resulting store state holds no refresh token.
  **[break: seed a binding that is not fully stated → red]**
- **An issuer-bearing OIDC row: token-endpoint switch.** `jwt` /
  `oidc_authorization_code` (and `password`) stating `oidcIssuerUrl`, the client
  and an explicit `oidcTokenEndpoint` E1 logs in (T1, R1); `oidcTokenEndpoint`
  is switched to E2, everything else unchanged. **Within one broker's life**
  and **after a restart** (fresh broker, same files): T1 is presented nowhere,
  R1 never reaches E2 and is not sent to E1 again (asserted at both local
  endpoints); the resulting store state holds the new record with E2 and no R1.
  The same for the authorization and device-authorization endpoints, one case
  each. **[break: drop an endpoint field from the record → red]**
- **A SAML bearer row: `samlTokenUrl` switch.** `saml` / `saml2_bearer`
  obtains T1, R1 at `samlTokenUrl` S1; switched to S2: within one process and
  after a restart, T1 is not presented and R1 never reaches S2 (asserted at both
  endpoints).
- **A certificate client's `certUrl` switch** on the `clientAuthentication`
  strategy path: the same assertions.
- **A removed signing certificate.** A SAML destination (`saml2_pure`, and
  `saml2_bearer`) trusting certificates C1 and C2 logs in with an assertion
  signed by C1; C1 is removed from `samlIdpCertificates`, endpoints and
  everything else unchanged. **Within one broker:** the next resolution builds
  a new provider (not the cached one), the stored session is not seeded, and an
  assertion signed by C1 handed to the new login is refused (`saml-assertion`);
  one signed by C2 is accepted. **After a restart** (fresh broker, same files):
  the old session does not seed (its record's trust digest differs) — the
  stored token or cookies are presented nowhere, the refresh token is sent
  nowhere. **[break: leave trust out of the build identity → the in-process
  case red]** **[break: leave the trust digest out of the record → the restart
  case red]**
- **Another expected IdP.** `samlIdpEntityId` changed, all else unchanged: the
  same assertions, within one broker and after a restart.
- **Another user.** An OIDC `password` row whose `username` changes: within
  one broker and after a restart the old user's token and refresh token are
  never presented or sent.
- **A secret changed.** The password of a `password` row, and separately the
  client secret of a UAA row, changed: within one process the next resolution
  builds a new provider that starts with nothing (the old token not presented,
  the old refresh token not sent); the session file and every log line hold no
  trace of either secret, its length or a hash of it (asserted on the file's
  bytes against the secret and its SHA-256 / SHA-1 / MD5 hex and base64).
- **`token_exchange` never seeds:** after a restart with unchanged means, it
  requests a fresh token; the stored one is presented nowhere.
- **The trust digest is deterministic:** the same inputs give the same field
  across processes; each trust input changed alone (one certificate, its order,
  an entity id, the clock skew, `samlIdpInitiated`, a scope, the username)
  gives another.
- **A trailing slash is a different endpoint.** `oidcTokenEndpoint`
  `…/token` → `…/token/`, the two paths served by distinct handlers of the
  local server: within one broker's life and after a restart, T1 is presented
  nowhere and R1 reaches neither handler after the switch (asserted per
  handler). **[break: canonicalise an endpoint field → red]**
- **An IdP switch.** `saml2_bearer` (and `saml2_pure`) with `samlIdpSsoUrl`
  switched, `samlAcsUrl`, client and `samlTokenUrl` unchanged: within one
  process and after a restart the stored token is not presented and R1 is not
  sent (asserted at the token endpoint); the login goes to the new IdP.
  **[break: omit `samlIdpSsoUrl` from the record → red]**
- **The record round-trips byte for byte**, every one of its twelve fields
  populated (with `/`, `?`, `&`, `=`, `%`, `;`, `#` and a space in the raw
  values), through each session store of **the published, installed
  `@mcp-abap-adt/auth-stores` 4.0.0** — `AbapSessionStore`,
  `XsuaaSessionStore`, `EnvFileSessionStore` files and the in-memory `Safe*`
  stores — read back by a new store instance; no encoded field holds `;`.
- **A client switch keeps 4.x's strength:** a UAA row switched to another
  client id with the same `uaaUrl` (and an OIDC row with the same
  `oidcIssuerUrl`) is not seeded, within one process and after a restart.
- **A 4.x-format binding reads as unbound.** A session file written by
  auth-broker 4.1.0's binding (`issuedBy` a bare canonical URI, and one with
  no `issuedBy`) with matching resource, issuer and client: a token row is not
  seeded and logs in (asserted at the token endpoint: no refresh token sent),
  one `warn` line names the destination; a `none` row is refused naming
  `issuedBy`; `bindingOf` of 5.0.0 for the same means produces a record that
  the round-trip through `AbapSessionStore` / `XsuaaSessionStore` /
  `EnvFileSessionStore` files returns byte-for-byte equal, and that
  `getProvider` accepts.
- **A credential-free discard over another identity's session.** The store
  holds T0 / R_old bound to A; a provider of identity B discards before any
  credential: the resulting state keeps T0 with binding A (unchanged), no
  refresh token; a restarted broker for B does not seed T0. **[break: write the
  build's binding on a credential-free write]**
- A discard before any credential over a session of the same identity: the
  session keeps its access token and binding, has no refresh token.
- `saml2_pure`: cookies written as `sessionCookies`, `refreshToken: ''` — a
  refresh token stored before is gone from the resulting state.
- **In-order writes:** three writes of one destination queued while the first
  is held run one at a time, in order (the test's store records the
  sequence); writes of two destinations do not wait on each other.
  **[break: start a write before the previous one settled → red]**
- **A retired build's write is dropped:** after a means change, the old
  provider's late report is never written (the store records no such
  `saveSession`), and the new build's session stays. **[break: drop the
  generation check → red]**
- **A failed write is retried by the next one:** a failing `''` write, then a
  token-only report of the same build → the next write carries `''` and lands;
  restart finds no R. And `flush()` alone retries a pending write.
- **`'fail'`:** a failing store makes the obtaining `getToken()` fail
  `unknown` `persisting-tokens` with `code` (EACCES); while the write is
  pending, every `getProvider` / `getToken` / `refreshToken` of that
  destination retries it first and is refused while it fails, and proceeds
  once it lands; a pending write left by a detached report (a discard at an
  abort) refuses the next call the same way; another destination is
  unaffected. **[break: let a call proceed while the destination's write is
  pending → red]**
- **`'continue'`:** the same store → every call succeeds, one `warn` line per
  failed write carrying `logFields` only; the write is retried by the next one.
- **The check before success.** An already-held provider's discard write is
  rejected by the store while (1) a `getProvider` call awaits its resolution
  (a held store read), and (2) separately, a `getToken` answered from the
  provider's cache is suspended before it returns: under `'fail'` each call
  retries the pending write and, the store still rejecting, is refused
  (`unknown`, `persisting-tokens`); with the store accepting the retry, each
  succeeds and the store holds no refresh token. Under `'continue'` each
  succeeds and the failure is one `warn` line. **[break: check only on entry
  → the `'fail'` cases red]**
- **An abort releases the caller, the write runs on:** a call's
  `saveSession` is held (and separately: queued behind another held write);
  the caller's signal aborts → the call rejects `aborted` at once under both
  policies, never with success; when the store is released the write lands
  (`loadSession` shows it). **[break: await the write without racing the
  signal → red]**
- **`flush()`** retries every pending write once, resolves when all landed,
  rejects with the `AggregateError` of `SessionWriteFailure`s naming each
  destination still failing; `flush({ signal })` releases its caller on abort.
- No `onWriteFailure`: a token row and the token API refused naming it;
  `basic` built.
- Consumer factory path: a result without a refresh token writes `''`; the
  factory is handed no stored token, cookies, expiry or refresh token, even
  with a session whose record matches. **[break: carry the stored token]**
- **The consumer path is never seeded.** A factory composing an OIDC `password`
  provider from `connConfig` obtains Alice's token and refresh token; restart
  (fresh broker, same files) with (1) `username` changed to Bob, resource,
  client and grant unchanged, and (2) separately the token endpoint changed,
  and (3) nothing changed: in every case the factory's arguments hold no
  stored token or refresh token, the new provider presents neither, and the
  token endpoint never receives Alice's refresh token. **[break: seed the
  factory from a matching record → red]**
- No line and no error holds a token, a refresh token or a store message
  marker.

**Two paths, two providers (§7.1, §5.5)**
- With a consumer `provider` factory configured, a concurrent `getProvider`
  and `getToken` for one destination, in both arrival orders: the factory is
  called once and `getProvider`'s row builder once; `getProvider` returns the
  row's provider and the token API uses the factory's — two distinct
  instances; a write from each carries its own record (`jwt/authorization_code`
  vs `provider/jwt/authorization_code`), recorded by the test's store, through
  its own persistence path (the row provider's awaited report; the token
  API's own write). The same with an instance. A means change rebuilds each
  path's provider at its own next call. **[break: one slot per destination →
  one caller gets the other path's provider → red]**
- A build of one path never drops the other path's writes (both land, in
  queue order).

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
- `flush({ signal })` and a `'fail'` call retrying a pending write release
  their caller on abort; the write goes on.
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
  — `mcp-auth` browser login, `mcp-auth oidc` browser, SAML browser, manual SAML
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
- `SIGTERM` ends a subcommand's login: `mcp-auth oidc …` and `mcp-auth
  saml2-pure …` waiting on a login, `SIGTERM` to the process → `aborted`,
  exit 143, the callback port bound by the test afterwards, the work
  directory removed, the output file untouched; the same with `SIGINT` (130).
- Every 2.x `mcp-sso` form of §11.2's table, given as its `mcp-auth` form,
  yields the same options as 2.1.0's `mcp-sso` parse of the original
  (`--protocol` refused naming it; a `--config` file naming another
  subcommand refused naming `--config`; `saml2-bearer` with and without
  `--dev` alike); the parser reads no `process.argv`. **[break: require
  `--dev` for `saml2-bearer` again → red]**
- The package's `bin` holds only `mcp-auth` (`check:packed`: `mcp-sso` is not
  installed; `mcp-auth <subcommand> --help` answers for every subcommand).
- Manual SAML with no ACS from any source: refused naming `--acs-url`, nothing
  read or written; with each source the strategy's `redirectUri` is that ACS;
  the IdP-initiated paste returns it. **[break: restore the localhost
  fallback]**
- `mcp-auth` against the local token endpoint: the authorization URL the
  strategy is handed carries `state` and an S256 `code_challenge`, the token
  request a `code_verifier`; a callback without the `state` is refused.
- Output streams: stdout of every command run is empty except `help` /
  `--version`; neither stream holds a token, refresh token, client secret,
  server-text marker, and neither holds `state` or the authorization URL
  outside the provider's login prompt on stderr — the one place both appear
  (D19); no log line, error or diagnostic holds them, whatever the logger.
  **[break: print the URL preview again]** **[break: send the provider's URL
  prompt through the logger]**
- `printFailure`: a failure with and without diagnostics; one from a second
  auth-errors copy prints the same reason — hint; a `DestinationConfigError`
  carrying an error prints its hint and diagnostics; no stack trace in any
  case.
- `--auth-debug` hands `authDebug: true` to the broker in `mcp-auth`,
  every `mcp-auth` subcommand and `generate-env`; without it, not; environment variables alone
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
  or the Keycloak stand by hand), `mcp-auth saml2-pure --assertion-flow
  manual` and `mcp-auth saml2-bearer --idp-initiated`.
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
- **H3 A credential stays bound.** §6: the identity — resource, SAP client,
  issuer, client and row — is persisted in `issuedFor` and a versioned
  `issuedBy` record, compared exactly, so a credential obtained for one grant
  is never used for another, in one process or after a restart, and a 4.x
  binding is never trusted (§6.1, §6.5); a binding that does not hold the
  client and every address its credential goes to is never seeded or carried
  (an issuer-less OIDC row with explicit endpoints and a client does hold
  them, and may be seeded only from an exactly equal record), and the
  persisted record holds the client and every server address the row hands its
  provider, as exact strings, and a digest of the non-secret trust values, so
  any change of them — a trailing slash, a removed certificate included —
  never reuses a credential after a restart; within one process a provider is
  rebuilt, starting with nothing, when anything its build read changes, secrets
  included, held in memory only (§6.1–§6.3). No secret and no hash of one is
  persisted.
  One rule (§6.2): a provider is never changed or re-seeded in place; when the
  means really change, a new provider is built that starts with nothing and
  logs in, and only a provider whose complete identity equals the stored
  binding starts from that session. It is checked on every call;
  seeds are bound-only; writes carry their build's binding and generation; and
  since auth-stores merges, every write states the refresh token (a value bound
  to the same identity, or `''`) and every credential write both binding
  fields, while a credential-free write states no binding — so no refresh
  token of other means survives beside a new credential, and no write
  re-labels a stored one (§5.2, §5.5, §6.4).
  A provider persists only refresh state it owns: a write carries a refresh
  token only when that build was seeded with it or obtained it and still holds
  it, so a replacement provider never inherits a refresh token from the store
  (§5.2, §6.2). Writes of a destination run one at a time, in
  order, so an older write never overwrites a newer one, and a retired build's
  late write is dropped (§5.3). Under `'fail'`, the call whose write did not
  land fails, and the destination's calls — checked on entry and again right
  before they return success — are refused while its last write is pending
  (§5.4), so no call succeeds over a discard the store rejected. The row path and the consumer path are resolved,
  cached and identified separately (§7.1), so no caller is handed the other
  path's provider or binding. The consumer path is never seeded from the store:
  the broker cannot know what a consumer's provider composes, so it hands it no
  stored secret (§5.5).
- **H4 No built-in timeouts.** §7.6, §10.4; the writer has no timer — a
  failed write is retried by the next write or `flush()` — and every wait on
  the queue ends when the write settles or its owner aborts; the CLI's
  subcommands run in-process, so one interrupt ends them.
- **H5 One implementation of each rule.** `sharedAttempt` (§7) — for the
  waiter and cancellation rules only; its results carried as plain outcomes so
  the broker's own errors pass unchanged — `readFailure` /
  `classify` (§3), `refreshStatePersistence` (§5.1), the broker's UAA row for
  `mcp-auth` (§10.2). Each wait on a session write is one waiter of its own
  slot, so one caller's abort releases only that caller.
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
contract; (c) adds an API for little gain. Ruled since (2026-10-08): the
consumer path is never seeded from the store either (§5.5); a consumer that
wants its provider to resume composes its own seed and persistence.

**D6 — What "the means changed" compares, and the instance case.**
The re-check on every call is dictated by H3; its granularity is not:
**Ruled, on the user's rule — a provider is never changed; when anything
really changes, a new one:** the in-memory build identity is everything the
build read, secrets included; the persisted identity is the binding with the
row, the client, every server address as exact strings and the trust digest
(§6.1, §6.2, D21). The consumer path has an in-memory identity (what the
factory is handed) but no persisted one: it is never seeded (§5.5). The
options below are kept for the record:
(a) the binding plus the row (`authType`, `grantType`);
(b) every means field
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
(H8), and the mapping is the CLI's explicit statement. With one command
(D24) the same names and table serve every subcommand.

**D14 — `--browser-program <program>`.**
(a) Add it (the launcher's program per platform, as given); (b) do not.
*Recommended: (a)* — replaces 5.x's candidate list (`google-chrome-stable`,
`chromium`) without the CLI guessing.

**D15 — `--browser`'s default.**
(a) `auto` — open the platform's default browser, as 2.x; (b) `none` — show
the URL only. *Recommended: (a)* — 2.x behaviour, stated in help; a failed
launch still shows the URL. **Decided by the user (2026-10-08):** `auto` is
the default for every flow that opens a browser — with one command (D24) the
2.x `mcp-sso` default no longer exists as a separate question.

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

**D19 — The authorization URL on the terminal. Decided (user, 2026-10-08):
(a), and the goal's H2 now states the exception.** The provider's prompt that
sends the user to the URL (`showUrl`, the browser fallback), `state` included,
stays on stderr — it is the login itself, the only way to finish with
`--browser none` — and the CLI prints no URL of its own; neither reaches a log
line, an error or a diagnostic. Rejected: (b) the CLI showing the URL through
`consumerPresentation` in a form of its own; (c) no URL at all, `--browser
none` removed.

**D20 — The CLI's own choices for the broker.**
(a) `renewal: () => refreshThenLogin()` and `onWriteFailure: 'fail'` for every
command; (b) `refreshOnly()` for `--env` runs (never a login when a refresh
token exists). *Recommended: (a)* — 2.x's steps, and a command must know its
secret landed before it writes the output.

**D21 — Where the row is persisted in the session's binding.**
The store holds two binding strings and nothing else; the row must go into
one of them (H3). (a) A versioned record in `issuedBy`:
`mcp-abap-adt-binding/2;<authType>/<grantType>;<eleven exact, encoded address fields>;<trust digest>`,
compared by exact equality (§6.1); (b) extra query parameters on the issuer URI
(`…?client_id=x&grant_type=…`), canonicalised by `URL` — no `issuedBy` exists
for rows without an issuer (`saml2_pure`, means without one), so the row would
be lost exactly there; (c) the record in `issuedFor` — absent whenever the
means state no `serviceUrl` (an XSUAA destination), the same gap. And for 4.x
sessions: (i) read as unbound — one login per destination after upgrading
(§11); (ii) accept a 4.x binding once, assuming the row the means state now —
a guess the standing rules forbid, and exactly the grant switch H3 must catch.
*Recommended: (a) and (i).* Ruled, not open (2026-10-08, relaxing round 3's
rule): a binding is fully stated when its record holds the client the row
authenticates and every server address its provider sends a credential to
(§6.1's table); only such a binding is seeded or carried, from an exactly equal
record — an issuer-less OIDC row with explicit endpoints and a client
included; one missing the client or such an address never is.
**Decided by the user (2026-10-08): the record carries every server address
the row hands its provider** (option iv), with the user's principle "when
something really changes, make a new provider": the client id, `uaaUrl`,
`oidcIssuerUrl`, the three OIDC endpoints, `oidcAudience`, `samlIdpSsoUrl`,
`samlAcsUrl`, `samlTokenUrl` and the certificate client's `certUrl` — each the
**exact string** the provider receives, **not canonicalised** (a canonical form
aliased `…/token` and `…/token/`, which a server may route differently),
`encodeURIComponent`-encoded, absent ones empty, eleven address fields in a fixed
order (§6.1). Only `issuedFor`, the resource, stays canonical. **And a
twelfth field, the trust digest** (ruled on the same principle): SHA-256 hex
over the row's non-secret trust and validation values, serialised as §6.1
defines; no secret, and no hash of one, is ever persisted; credentials obtained
under previous trust never seed a provider built under new trust.

**D22 — What the trust digest covers beyond SAML trust.**
The SAML trust values (certificates, entity ids, clock skew, IdP-initiated) and
the certificate client's public certificate are dictated by the ruling. Real
alternatives remain for the rest: (a) also `oidcScopes`, the `password`
grant's `username` and the token-exchange token types — values that decide
whose credential it is or what it may do; (b) SAML trust and the certificate
only — a scope or user change is then seen only within one process (the
in-memory identity), and after a restart another user's session could seed a
`password` row. *Recommended: (a)* — a user change is an identity change (H3);
a scope change costs one login. Leaving endpoints out of the record
(4.x's strength) was rejected: within one process a rebuild for an endpoint
change would still be seeded from the session matching the shorter record, and
refresh-first renewal would send R, obtained at the old endpoint, to the new
one.

**D23 — The session-write model. Ruled by the user, 2026-10-08.**
"If the consumer messes something up, nobody does anything — read the
instructions": the package does not build machinery against its consumer's
own collaborators misbehaving; it states the contract they must meet. So the
writer is a plain per-destination queue (§5.3): writes in order, a retired
build's late write dropped, a failed write pending until the next write or
`flush()`, `'fail'` refusing a destination's calls while its last write is
pending, every wait raced against its owner's signal, and the store's contract
— `saveSession` settles — in the docs. The revision, supersession, coverage
and re-evaluation model of earlier drafts, built for a second renewal of the
same destination while the first write hangs in the consumer's own store, is
removed.

**D24 — One command: `mcp-auth`. Ruled by the user, 2026-10-08.**
CLI 3.0.0 removes the `mcp-sso` bin: its name misleads (in SAP, "SSO" reads
as SNC or Kerberos, which it never did; SNC has no secret, so a credential CLI
has nothing to write for it). Every `mcp-sso` form is an `mcp-auth`
subcommand with the same flags (§10, §11.2); `package.json` `bin` keeps only
`mcp-auth`. Two consequences the ruling leaves to choose, with the
recommendation the spec is written with: `--config` belongs to the subcommand
its protocol names, and a mismatch is refused (rather than a protocol-less
`mcp-auth --config`); `saml2-bearer` no longer requires `--dev` — `mcp-sso
bearer` never did — and `--dev` stays accepted with no effect, so 2.x
scripts keep working (rather than refusing it).

