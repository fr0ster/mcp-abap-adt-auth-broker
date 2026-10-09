# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package (5.0.0) and its command, `@mcp-abap-adt/auth-broker-cli` (3.0.0).

## Overview

For a destination name, `auth-broker` builds the `IAuthProvider` the destination states — from the means in its service key store and the secret in its session store — for a `@mcp-abap-adt/connection` 14 connector, and stores back every secret that provider obtains or renews, bound to the identity it was obtained under. The token API (`getToken`, `refreshToken`, `createTokenRefresher`) serves a consumer that wants a token and nothing else, on that same provider or on one the consumer injects. Storage is the stores'; token acquisition, refresh and how a login is conducted are the providers' and their collaborators'; when to renew is the consumer's `renewal` strategy's, and what a failed write means its `onWriteFailure`.

Supported destinations (`authType` / `grantType`):
- **`basic`**, **`snc`** — a user and password; passwordless RFC logon through an SNC product
- **`jwt`** — the UAA grants (`authorization_code`, `client_credentials`, `passcode`), the OIDC grants (`oidc_authorization_code`, `device_code`, `password`, `token_exchange`), or `none` (a token handed over)
- **`saml`** — `saml2_pure` (session cookies), `saml2_bearer` (a token), or `none` (cookies handed over)

## Repository Layout

An npm workspace in the layout of `mcp-abap-adt-interfaces`:

```
/                          private root: package.json (workspaces, scripts), package-lock.json,
                           tsconfig.base.json, biome.json, .npmrc (hoisted, deduplicated), tools/, docs/
packages/auth-broker/      @mcp-abap-adt/auth-broker — the library (src/, its tests,
                           tests/test-config.yaml.template, tests/stand/: UAA and Keycloak
                           in Docker; tests/live/x509/: the x509 live check's scripts)
packages/auth-broker-cli/  @mcp-abap-adt/auth-broker-cli — the mcp-auth command (src/, its tests)
packages/*/tools/__fixtures__/  each package's shape-check fixtures (rule4.ts, rule5.ts, rule6.ts):
                           test data of its shape-check test, outside the build and Biome
tools/                     check-graph.js, check-packed.js, publish-changed.js,
                           test-publish-changed.js, version-stats.sh
```

- The `workspaces` array lists the library first: it is the dependency order and the publish
  order. The CLI depends on the library by its published name and version range (`^5.0.0`);
  inside the workspace npm links it (the development lockfile only).
- Each package builds with `tsc -b tsconfig.build.json` (tests excluded); the CLI's references
  the library's. `npm run build` at the root builds both.
- `tools/check-graph.js` holds the dependency rules: the library's runtime imports only the
  contract packages (`interfaces-auth`, `interfaces-auth-sap`, `interfaces-auth-broker`,
  `interfaces-utils`), `auth-providers` and `auth-errors` — never `auth-stores`; the CLI's adds
  the library, `auth-stores`, `@xmldom/xmldom` and `dotenv`.
- Releases are tagged per package, `<dir>-v<version>` (`auth-broker-v5.0.0`,
  `auth-broker-cli-v3.0.0`); `npm run release:publish` publishes exactly the versions the
  registry lacks, broker first, and refuses one without its tag.

## Core Principles

- **The consumer composes; nobody guesses.** How a token provider renews (`renewal`) and what a
  session write that did not land means (`onWriteFailure`) are the consumer's statements, with
  no default; so are every interactive strategy, the device-code presenter, the SAML cookie
  function, the replay store and how a client authenticates. The CLI states its own choices in
  its own code.
- **Interface-only communication.** The broker talks to `ISessionStore`, `IServiceKeyStore`,
  `IAuthProvider` and `IRefreshableTokenProvider`. `getProvider` constructs auth-providers
  classes by name, from what the destination states, and hands them out as `IAuthProvider`.
- **Means and secret are split by store.** The service key store holds the means, the session
  store the secret and what it is bound to. Each is read for its own role only.
- **The destination states its provider.** `authType`, and `grantType` for `jwt` / `saml`,
  choose it — never which other fields are present.
- **The provider decides.** Whether the cached token is still good, refresh, re-login and how a
  login is conducted are the provider's, under the renewal strategy it is given.
- **One implementation of each rule.** Waiting and cancellation are auth-errors'
  `sharedAttempt`; reading a failure is auth-errors' `readFailure` / `classify`; the refresh
  state of a provider's writes is auth-providers' `refreshStatePersistence`; `mcp-auth`'s login
  is the broker's own UAA row.

## Core Components

### AuthBroker

`AuthBroker` orchestrates, nothing more:

- **Two resolution paths per destination**, each with its own `sharedAttempt` slot, cache entry,
  build identity, binding and generation counter: the **row path** — `getProvider`, and the
  token API without a `provider` option — and the **consumer path** — the token API with one.
  Concurrent callers of one path share one resolution. Only the destination's write queue is
  shared by both.
- **A provider is never changed.** Every call re-reads what the path's provider was built from
  (`StoreReads`, each source at most once per call) and compares everything the build read
  (`IdentityRecorder` / `BuildIdentity`, `src/buildIdentity.ts`), secrets included, held in
  memory only. Unchanged: the cached provider. Changed: a new build, which starts with nothing;
  the old provider stays with whoever holds it, and its late writes are dropped once the new one
  has written.
- **Asks the provider once** — `getTokens({ signal })` for `getToken()`,
  `refreshTokens({ signal })` for `refreshToken()` — with no retry and no fallback of its own.
- **Writes what a provider obtains through one path**: `SessionWriter`, one queue per
  destination — the row path's providers through their persistence, the consumer path through
  the token API's own write after every answer.

### `getProvider`

`getProvider(destination, { signal? })` builds the `IAuthProvider` a `connection` 14 connector
takes:

- reads the means from the service key store (`getConnectionConfig`); none, or no `authType`, is
  a `DestinationConfigError` — whatever the session holds;
- `basic` → `BasicAuthProvider(username, password)`; `snc` →
  `SncLogonProvider.forSecureLoginClient(…)` from the four SNC fields — neither reads the
  session;
- `jwt` / `saml` need a `grantType` from the allowed pairs; `none` reads the session
  (`loadSession`) and hands over its token (`TokenAuthProvider.fixed`) or cookies
  (`SamlAuthProvider`), refusing a binding that is not exactly the destination's;
- the UAA rows → `AuthorizationCodeProvider`, `ClientCredentialsProvider`,
  `UaaPasscodeProvider`, with the client from the key store (`getAuthorizationConfig`);
- the OIDC rows → `OidcBrowserProvider`, `OidcDeviceFlowProvider`, `OidcPasswordProvider`,
  `OidcTokenExchangeProvider` (`oidcProvider`): the client id and secret (`''` a public client),
  `oidcIssuerUrl` or the row's explicit endpoints, the scopes, the user or the subject and actor
  tokens; the consumer's `oidcAuthorization(d)` / `deviceCodePresenter(d)`;
- the SAML rows → `Saml2PureProvider`, `Saml2BearerProvider` (`samlProvider`): the broker
  composes the validator — `createSignedResponseValidator` for pure,
  `createSignedAssertionValidator` for bearer — from `samlIdpCertificates`, `samlClockSkewMs` and
  the consumer's `assertionReplayStore(d)`, and passes `samlIdpEntityId` as the expected issuer;
- every token row first checks every field and option it needs — `renewal` and
  `onWriteFailure` among them — naming every one missing in one `DestinationConfigError`, before
  any collaborator is called; then resolves the `clientAuthentication` strategy when given;
  computes its binding; reads the session (first build only) and keeps it only when it is bound
  here; calls `renewal(destination, grant)`; and constructs the provider with the renewal, the
  persistence (`refreshStatePersistence` over the broker's write, with `onWriteFailure`), the
  broker's logger and `authDebug`. A constructor that throws is a `DestinationConfigError`
  naming the store fields its configuration facts name, carrying the failure;
- with a `clientAuthentication` strategy, every row whose client authenticates resolves it with
  the destination, the grant, the key store's secret client, a lazy, memoised
  `readCertificate()` and the build's signal; its answer goes to the provider as
  `clientAuthentication`, with no secret; the row's client is its identity (`clientIdentity`).
  Whatever the strategy throws becomes a `DestinationConfigError` naming `clientAuthentication`,
  carrying the failure as auth-errors reads it;
- **the build's commit** — the cache set, the generation taken — is one step that runs only if
  the attempt was not aborted: a build every caller left is never cached and writes nothing;
- with a signal, attaches it to the token or SNC provider answered (`attach`), so a login the
  provider starts later in a moment is aborted once every holder's signal aborted.

### The binding (`src/binding.ts`, `src/bindingOf.ts`)

A stored secret is used only by a provider built from exactly the identity it was obtained
under. The session keeps two strings beside the secret:

- **`issuedFor`** — the resource, `serviceUrl` with `sap-client`, canonical (scheme and host
  lower-cased by `URL`, the port explicit, no trailing `/`, one parameter re-encoded), compared
  canonicalised on both sides;
- **`issuedBy`** — a versioned record, `mcp-abap-adt-binding/2;<row>;<eleven address
  fields>;<trust>`: the row (`authType/grantType`, or `provider/…`), the exact string of every
  server address the row hands its provider (`encodeURIComponent`-encoded, never canonicalised),
  and the SHA-256 of the row's non-secret trust input. Compared by exact equality, never parsed;
  no secret and no hash of one.

A build is seeded only at the destination's first build in the broker, only when its binding is
**fully stated** (the record holds the client the row authenticates and every address its
provider sends a credential to) and the stored strings equal it — `boundHere`. Otherwise the
stored secret, refresh token included, is not used (`boundOrDiscarded`: a value-free `warn`
line, or `debug` for a binding that can never be seeded) and the provider obtains a new one. The
`none` rows refuse a mismatch naming `issuedFor` / `issuedBy`. On the `clientAuthentication`
strategy path a resource neither side states matches (`strategyBinding`), and the record holds
the certificate client's `certUrl` and, in the trust digest, its certificate. Every session
written before 5.0.0 — a bare-URI `issuedBy`, or none — reads as unbound. `bindingOf(means,
client)` gives a consumer handing over a credential exactly the binding `getProvider` compares.

### Persistence (`SessionWriter`)

Every token provider `getProvider` builds reports to `refreshStatePersistence`, which writes
through the broker before the provider answers — so a renewal inside a connector is stored
before the connector resends. One report is one `saveSession` of the secret alone, every field
stated (auth-stores 4 merges): the token or cookies, `expiresAt`, the refresh token the build
owns (`ownedAfter`) or `''`, `issuedFor` (`''` when absent) and `issuedBy`; `saml2_pure`'s
cookies write `refreshToken: ''`; a refresh token discarded before any credential writes only
`refreshToken: ''`. No means field is ever written; a destination the key store states as
`basic` or `snc` at write time is not written.

`SessionWriter` (`src/SessionWriter.ts`) is a plain queue per destination: writes run one at a
time, in order; each submission resolves with its own outcome and never rejects; a failed write
is the destination's pending write until a later write lands, or `retry` / `flush()` writes it
again. There is no timer. `submit` drops a write of a build older than the newest build of the
same path that has written. Each failed attempt is one `warn` line with auth-errors'
`logFields`. `flush()` retries every pending write once and rejects with an `AggregateError` of
`SessionWriteFailure`s (`destination`, `error`: the store's error classified
`persisting-tokens`).

**`onWriteFailure`.** `'fail'`: the call whose write did not land fails (the provider's awaited
report fails its call or moment; the consumer path's own write rejects the call), and every
`getProvider` / `getToken` / `refreshToken` of the destination calls `settlePending` on entry
and right before success: `writer.retry(destination)` waits for every write queued before it
and writes the pending one again; still failing, the call rejects
`classify(error, 'persisting-tokens')`. `'continue'`: logged, the call goes on. A moment of a
provider already handed out that commits nothing is not refused.

### Cancellation

Every wait is a waiter of an auth-errors `sharedAttempt` slot — a resolution, a wait on the
write queue (`waitFor`), `flush()`. A slot's `start` never throws: it resolves a frozen
`SlotOutcome` (`{ ok, value }` or `{ ok: false, thrown }`) that each waiter unwraps outside
`join`, so a `DestinationConfigError`, a store's error or a provider's failure reaches every
waiter as the same object, and the only failure `sharedAttempt` itself gives is `aborted`
(`interactive-login`). One caller's abort releases that caller alone; when every caller of an
attempt aborted, the attempt leaves the slot at once. `stillWanted` refuses success to a caller
whose signal aborted after its last wait. The broker sets no timeout, adds no signal of its own
and has no timer; the token API never attaches its signal to a provider.

### Stores

Each store has one role (contracts from `@mcp-abap-adt/interfaces-auth-broker` 1.3):

- `IServiceKeyStore` answers the means — `getConnectionConfig` and `getAuthorizationConfig`, and
  optionally `getClientCertificate`. It is read-only: the broker never writes means.
- `ISessionStore` holds the secret — `loadSession` / `saveSession` of the token or cookies,
  `expiresAt`, the refresh token, `issuedFor` and `issuedBy`. Its contract: `saveSession`
  settles, the two binding strings are kept byte for byte, and `refreshToken: ''` clears.

Concrete stores live in `@mcp-abap-adt/auth-stores` 4; the library never imports it, and any
implementation of the contracts serves.

### Providers

Providers live in `@mcp-abap-adt/auth-providers` 6, a runtime dependency: `getProvider`
constructs the one a destination states and hands it out as `IAuthProvider`; the token providers
among them also implement `IRefreshableTokenProvider`, which is what the token API asks. A
consumer's own `provider` is any `IRefreshableTokenProvider`. `getTokens()` answers the cache
while valid, else renews as its renewal strategy says; `refreshTokens()` always obtains a new
token.

## Authentication Flow

**`getToken(destination, { signal? })`**

1. With a `provider` option and no `onWriteFailure`: `DestinationConfigError`
   (`onWriteFailure`).
2. Under `'fail'`, `settlePending` (above).
3. Read the destination's `authType` from the key store: `basic` or `snc` →
   `DestinationConfigError` (`authType`) before any provider is asked.
4. **No `provider` option (row path):** a `none` destination → `DestinationConfigError`
   (`provider`); else resolve the row path's provider — the same one `getProvider` hands out,
   through a waiter that never attaches — and call `getTokens({ signal })`. The provider's
   persistence wrote anything new before it answered; its failure is relayed as the same object.
5. **A `provider` option (consumer path):** resolve the consumer path's provider (a factory
   handed the means and the client, never a stored secret; an instance as given) and call
   `getTokens({ signal })`; queue the result's write — the secret alone, the result's refresh
   token or `''`, the `provider/…` binding fixed when the provider was taken into use — and wait
   for it raced against the signal. Under `'fail'` a write that did not land rejects the call.
6. A result with no token → `AuthProviderFailure` (`request-failed`, `no-access-token`).
7. Under `'fail'`, `settlePending` again; a signal aborted by now refuses success; else the
   token.

**`refreshToken(destination, { signal? })`** is the same with `refreshTokens()` — a new token,
never the cached one; on the row path a renewal in flight (a connector's `rejected()`) is
joined.

**Headless processes** give the broker `renewal: () => refreshOnly()` or collaborators that
refuse; then `prepare()` / `rejected()` answer Oops and the token API rejects with the
provider's failure when a login is needed.

## Secrets

Everything the broker writes is the secret alone, in one `saveSession` (see *Persistence*);
`setConnectionConfig` and `setAuthorizationConfig` are never called, so no `serviceUrl`,
`authType` or client reaches a session. No secret, and no hash of one, is persisted in the
binding. The broker logs no part of any token, no store's or provider's message, no URL and no
client id; `authDebug` (an option, never the environment) lets only the providers' own debug
line name the request's secrets in their prepared form.

## Error Handling

- A provider's failure (`AuthProviderFailure`) propagates as the same object. The broker reads a
  caught value only through auth-errors (`readFailure`, `isAuthProviderFailure`, `classify`) —
  never `instanceof`, `message` or `name`.
- The broker's own failures are minted by auth-errors: `aborted`; `unknown` /
  `persisting-tokens` under `'fail'`; `request-failed` / `no-access-token`.
- A destination that lacks what its type needs: `DestinationConfigError` (`code:
  'DESTINATION_CONFIG'`, `destination`, `missingFields` — names only — and `error` when a
  provider's or a strategy's failure caused it), recognised structurally by
  `isDestinationConfigError`.
- Store reads: `null` or `FILE_NOT_FOUND` is absence; any other store failure reaches the caller
  as the store raised it, also through the shared resolution.
- `flush()`: an `AggregateError` of `SessionWriteFailure`s.

## The CLI

`mcp-auth` (`packages/auth-broker-cli`) is one bin with four subcommands — `auth-code` (the
default), `oidc`, `saml2-pure`, `saml2-bearer` — all in one process. A run takes exactly one
source (`--service-key`: always a new login; `--env <path>`: the session file, reused, refreshed
or logged in by the broker and written back; `--destination <name>`: the destination folder from
`--destination-dir`, `AUTH_BROKER_PATH` or the standard folder). It writes the destination's
means through `EnvDestinationStore.setDestination`, then logs in through the broker —
`getToken` on the UAA row for `auth-code`, `getProvider` and its provider's
`getTokens({ signal })` for the others and `generate-env` — with
`renewal: () => refreshThenLogin()`, `onWriteFailure: 'fail'`, `authDebug` only with
`--auth-debug`, and every collaborator the grant needs; works on a copy in a private directory;
and copies the output only after `flush()`. One `AbortController` per run ends every wait on
`SIGINT` / `SIGTERM` (exit 130 / 143); there is no login time limit. stdout carries only `help`
and `--version`; everything else goes to stderr; a failure is printed in auth-errors' or the
broker's words, never a foreign message or a stack.

## Responsibilities Split

- **AuthBroker**: orchestration, the binding, and persistence.
- **Stores**: the means (read-only to the broker) and the secret.
- **Providers**: token lifecycle, OAuth/SAML flows, how a login is conducted.
- **The consumer**: the stores, the collaborators, `renewal`, `onWriteFailure`, and the signals.
