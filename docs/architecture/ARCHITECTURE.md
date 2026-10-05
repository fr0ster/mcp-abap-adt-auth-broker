# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package (4.1.0) and its commands, `@mcp-abap-adt/auth-broker-cli` (2.1.0).

## Overview

For a destination name, `auth-broker` builds the `IAuthProvider` the destination states — from the means in its service key store and the secret in its session store — for a `@mcp-abap-adt/connection` 10 connector, and stores back every secret that provider obtains or renews. The token API (`getToken`, `refreshToken`, `createTokenRefresher`) serves a consumer that wants a token and nothing else, on that same provider or on one the consumer injects. Storage is the stores'; token acquisition, refresh and how a login is conducted are the providers' and their collaborators'.

Supported destinations (`authType` / `grantType`):
- **`basic`**, **`snc`** — a user and password; passwordless RFC logon through an SNC product
- **`jwt`** — the UAA grants (`authorization_code`, `client_credentials`, `passcode`), the OIDC grants (`oidc_authorization_code`, `device_code`, `password`, `token_exchange`), or `none` (a token handed over)
- **`saml`** — `saml2_pure` (session cookies), `saml2_bearer` (a token), or `none` (cookies handed over)

## Repository Layout

An npm workspace in the layout of `mcp-abap-adt-interfaces`:

```
/                          private root: package.json (workspaces, scripts), package-lock.json,
                           tsconfig.base.json, biome.json, tools/, docs/
packages/auth-broker/      @mcp-abap-adt/auth-broker — the library (src/, its tests,
                           tests/test-config.yaml.template, tests/stand/: UAA and
                           Keycloak in Docker for the UAA, OIDC and SAML grants' suites)
packages/auth-broker-cli/  @mcp-abap-adt/auth-broker-cli — mcp-auth and mcp-sso (src/, its tests,
                           the Keycloak and CAP stands under tests/)
tools/                     check-graph.js, check-packed.js, publish-changed.js,
                           test-publish-changed.js, version-stats.sh
```

- The `workspaces` array lists the library first: it is the dependency order
  and the publish order. The CLI depends on the library by its published name
  and version range; inside the workspace npm links it.
- Each package builds with `tsc -b tsconfig.build.json` (tests excluded); the
  CLI's references the library's. `npm run build` at the root builds both.
- `tools/check-graph.js` holds the dependency rules: the library's runtime
  imports only the contract packages (`interfaces-auth`, `interfaces-auth-sap`,
  `interfaces-auth-broker`, `interfaces-utils`) and `auth-providers` — never
  `auth-stores`; the CLI's, the library, the stores, the providers, the
  contracts and the logger.
- Releases are tagged per package, `<dir>-v<version>` (`auth-broker-v4.1.0`,
  `auth-broker-cli-v2.1.0`); `npm run release:publish` publishes exactly the
  versions the registry lacks, and refuses one without its tag.

## Core Principles

- **Interface-only communication**: The broker only talks to `ISessionStore`, `IServiceKeyStore`, and `IRefreshableTokenProvider` interfaces. `getProvider` constructs auth-providers classes by name, from what the destination states, and hands them out as `IAuthProvider`.
- **Means and secret are split by store**: the service key store holds the means (`authType`, `grantType`, the client, basic's user and password, the SNC, OIDC and SAML fields, `serviceUrl`), the session store the secret (token or cookies, `expiresAt`, refresh token). `getProvider` and the broker's `getConnectionConfig` / `getAuthorizationConfig` read each from its own store only.
- **The destination states its provider**: `authType`, and `grantType` for `jwt` / `saml`, choose it — never which other fields are present.
- **Dependency inversion**: Implementations live in `@mcp-abap-adt/auth-stores` and `@mcp-abap-adt/auth-providers`.
- **The provider decides**: Providers own the token lifecycle — whether the cached token is still good, refresh, re-login — and how a login is conducted (their authorization strategy). The broker does not repeat or override any of it.

## Core Components

### AuthBroker

`AuthBroker` orchestrates, nothing more:
- Builds one provider per destination — the one the destination states (`getProvider`) — in one promise cache, which `getProvider` and the token API share when no `provider` option is given.
- With a `provider` option, the token API keeps 3.x's reads: `serviceUrl` (session, else service key), the UAA credentials (session, else service key) and the stored token and refresh token, seeding a factory once per destination (promise-cached) or using an instance as given.
- Asks the provider once — `getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()` — with no retry and no fallback.
- Writes what a provider obtains through one path, `SessionWriter`: the secret alone with its binding, retried until the store takes it — `onTokens` for its own providers, the token API after each answer of a consumer's.

### `getProvider`

`getProvider(destination)` builds the `IAuthProvider` a `connection` 10
connector takes:
- reads the means from the service key store (`getConnectionConfig`); none,
  or no `authType`, is a `DestinationConfigError` — whatever the session holds;
- `basic` → `BasicAuthProvider(username, password)`; `snc` →
  `SncLogonProvider.forSecureLoginClient(…)` from the four SNC fields — neither
  reads the session;
- `jwt` / `saml` need a `grantType` from the allowed pairs; `none` reads the
  session (`loadSession`) and hands over its token (`TokenAuthProvider.fixed`)
  or cookies (`SamlAuthProvider`);
- `jwt` / `authorization_code`, `client_credentials`, `passcode` →
  `AuthorizationCodeProvider`, `ClientCredentialsProvider`,
  `UaaPasscodeProvider`, with the client from the key store
  (`getAuthorizationConfig`), seeded from the session (token, refresh token,
  `expiresAt`; not `client_credentials`) only when the session is bound to
  this destination (below), the consumer's `authorization(d, grant)` for the
  two interactive ones, the broker's logger and `onTokens`;
- `jwt` / `oidc_authorization_code`, `device_code`, `password`,
  `token_exchange` → `OidcBrowserProvider`, `OidcDeviceFlowProvider`,
  `OidcPasswordProvider`, `OidcTokenExchangeProvider` (`oidcProvider` in
  `src/destinations.ts`): the client id and secret (`''` a public client) from
  the key store's client, `oidcIssuerUrl` or the row's explicit endpoints, the
  scopes (`token_exchange`: joined by one space), the user or the subject and
  actor tokens; the consumer's `oidcAuthorization(d)` / `deviceCodePresenter(d)`;
  seeded and wired as the UAA rows;
- `saml` / `saml2_pure`, `saml2_bearer` → `Saml2PureProvider`,
  `Saml2BearerProvider` (`samlProvider`): the broker composes the validator —
  `createSignedResponseValidator` for pure, `createSignedAssertionValidator`
  for bearer, from `samlIdpCertificates`, `samlClockSkewMs` and the consumer's
  `assertionReplayStore(d)` — and passes `samlIdpEntityId` as the expected
  issuer; `authorization(d, grant)` conducts the login, `samlCookies(d)` turns
  pure's SAMLResponse into cookies; pure is seeded with the stored cookies and
  `expiresAt`, bearer with the token, refresh token and expiry, and takes the
  client and `samlTokenUrl`;
- with a `clientAuthentication` strategy (4.1.0), every row whose client
  authenticates — the three UAA rows, the four OIDC rows, `saml2_bearer` —
  first resolves it (`src/clientAuthentication.ts`): the strategy is called
  with the destination, the grant, the key store's secret client and a lazy,
  memoised `readCertificate()` (`getClientCertificate`); its answer goes to
  the provider as `clientAuthentication`, and no secret goes with it; the
  row's client is its identity — the secret client's `uaaUrl` / `uaaClientId`,
  else the certificate client's (`clientIdentity`), never PEM. Whatever the
  strategy throws, and an answer that is no `IClientAuthentication`, becomes a
  `DestinationConfigError` naming `clientAuthentication` in fixed words chosen
  by class (`resolveClientAuthentication`), before any provider exists.
  Without a strategy none of this runs — 4.0.0's client and nothing
  certificate-related — and a client row with no client id adds the fixed
  hint `a certificate client needs a clientAuthentication strategy`;
- every field and collaborator option a row lacks is named in one
  `DestinationConfigError`, before any collaborator is called;
- caches the *promise* of the build per destination, set before the first store
  read and dropped when the build throws, so concurrent first calls build once
  and a failure is retried.

### The binding (`src/binding.ts`)

A stored secret is used only for the resource it was obtained for, from the
issuer and client that issued it. `getProvider` computes, from the
means, `issuedFor` (`serviceUrl` + `sapClient`) and `issuedBy` (`uaaUrl` +
`uaaClientId` for the UAA grants and `saml2_bearer`; `oidcIssuerUrl`, else
`uaaUrl`, + `uaaClientId` for the OIDC grants; `samlAcsUrl` for `saml2_pure`;
for `none`, `oidcIssuerUrl` or the client for `jwt`, `samlAcsUrl` for `saml`), with one canonicalising function — the
broker's only: scheme and host lower-cased by `URL`, the port explicit
(443/80), the path without a trailing `/`, one parameter (`sap-client`, the
means' `sapClient` first; `client_id`; none for an ACS) re-encoded through
`URLSearchParams`, nothing else. The session's values are canonicalised the
same way before the comparison, so a store keeps them as given. The rows
that obtain a secret (UAA, OIDC, SAML) seed only when both match — otherwise the secret, refresh token included, is
dropped (`boundOrDiscarded`, one value-free warn line) and the provider logs
in afresh; the `none` rows throw `DestinationConfigError` naming `issuedFor`
(always compared) or `issuedBy` (compared when the means state an issuer).

On the `clientAuthentication` strategy path (4.1.0) the binding is computed
from the row's client identity (`issuedBy` = its `uaaUrl` + `client_id`, so a
secret client and a certificate client of one id share a session) and marked
`unstatedResourceMatches` (`strategyBinding`): a resource that neither the
means (no `serviceUrl`, or one that does not parse) nor the stored session
states matches, so the issuer and client alone decide; one stated on one side
only never matches. The token API's consumer factory on that path is bound the
same way (`consumerBinding` with the identity), receives every stored secret —
the refresh token in its fourth argument (`TokenProviderClient`) and in
`authConfig`, the token, cookies and expiry in `connConfig` — only when
`boundHere`, and carries forward only a bound refresh token (`carry: 'bound'`;
without a strategy, 4.0.0's `carry: 'any'`).

### Persistence (`SessionWriter`)

Every token provider `getProvider` builds gets `onTokens`, which
`BaseTokenProvider` awaits after every login and refresh — never on a cache
hit — so a renewal inside a connector is stored before the connector resends.
The broker writes the session secret alone, `{ authorizationToken, expiresAt,
refreshToken, issuedFor, issuedBy }` in one `saveSession` — for a `saml2_pure`
result (`tokenType: 'saml'`) `{ sessionCookies, expiresAt, issuedFor,
issuedBy }`, with no refresh token; `saml2_bearer`'s is a token — the expiry fixed
when the result arrives, the binding computed when the provider was built
(each field left out when the means lack its source), the stored refresh
token carried forward when the result has none and the stored session is
bound here — and never a means field; a destination the key store states as `basic` or
`snc` is not written. `onTokens` never throws: a failed write stays pending per
destination in `SessionWriter` (`src/SessionWriter.ts`), retried on an
`unref()`ed timer (1 s, doubling, capped at 60 s), the latest result replacing
a pending one, the attempts for one destination chained so they never overlap,
each failure logged by class name. `flush()` gives every pending write one more
attempt and rejects naming the destinations still failing.

### Stores

Each store has one role (contracts from `@mcp-abap-adt/interfaces-auth-broker`):
- `IServiceKeyStore` answers the means — `getConnectionConfig` (`authType`, `grantType`, `serviceUrl`, `sapClient`, user and password, the SNC, OIDC and SAML fields) and `getAuthorizationConfig` (the client). It is read-only: the broker never writes means.
- `ISessionStore` holds the secret — `loadSession` / `saveSession` of the token or cookies, `expiresAt`, the refresh token, `issuedFor` and `issuedBy`. It must take a write of the secret alone.

Concrete stores live in `@mcp-abap-adt/auth-stores` 3 (`EnvDestinationStore`, the SAP service key stores with a `grantType` option, the ABAP and XSUAA session stores and their in-memory variants); the library never imports it, and any implementation of the contracts serves.

### Providers

Providers live in `@mcp-abap-adt/auth-providers` 5, a runtime dependency: `getProvider` constructs the one a destination states (above) and hands it out as `IAuthProvider`; the token providers among them also implement `IRefreshableTokenProvider`, which is what the token API asks. A consumer's own `provider` is any `IRefreshableTokenProvider`.

`getTokens()` answers the cache while valid, else refreshes, else logs in. `refreshTokens()` always obtains a new token (decision 39 in the `mcp-abap-adt-interfaces` repository's `docs/architecture/DECISIONS.md`: a forced refresh is its own interface, not a flag).

## Authentication Flow

**`getToken(destination)`**
1. Read the destination's `authType` from the key store: `basic` or `snc` → `DestinationConfigError` (`authType`) before any provider is asked.
2. **No `provider` option:** a `none` destination → `DestinationConfigError` (`provider`); else `await getProvider(destination)` — the shared cache — and `provider.getTokens()`. Nothing is written here: `onTokens` wrote anything new before `getTokens()` answered.
3. **A `provider` option:** resolve `serviceUrl` (without one, fail before asking the provider); build (factory, first call for the destination) or reuse the provider — the factory receives the credentials with the stored refresh token, and the connection config with the stored token; `provider.getTokens()`; submit the result to `SessionWriter` — the secret alone (`sessionCookies` when `tokenType` is `'saml'`, else `authorizationToken`; `expiresAt`; the refresh token, the stored one carried forward; `issuedFor` from the URL and SAP client, `issuedBy` from a factory's client — both fixed when the provider is built for the destination and kept with it, so a later change of URL or client never re-labels a secret obtained before it; a new broker picks the change up) — and await that attempt.
4. If the write of the result received failed, throw the store's error (the retry goes on); else return the token.

The write's outcome is found by the result object: `SessionWriter`'s write records a failure in a `WeakMap<ITokenResult, Map<destination, …>>` keyed on the result the provider handed to `onTokens` — which `BaseTokenProvider` also returns from `getTokens()` / `refreshTokens()` — never on the copy it writes (whose `expiresAt` is fixed on arrival), and drops it when a write of that result for that destination lands — one result object answered for two destinations (an instance) keeps a failure of one when the other's write lands.

**`refreshToken(destination)`** is the same with `provider.refreshTokens()` — a new token, never the cached one; on the shared provider a renewal in flight (a connector's `rejected()`) is joined — and backs `ITokenRefresher.refreshToken()` from `createTokenRefresher()`.

**Headless processes** give the broker collaborators that refuse (then `prepare()` / `rejected()` answer Oops when a login is needed), or — with a `provider` of their own — configure it with an authorization strategy that refuses and catch the error it throws; there is no broker switch for it.

## Secrets

Everything the broker writes is the secret alone, in one `saveSession` (see *Persistence*) — a `getProvider` provider's token and the token API's alike; `setConnectionConfig` and `setAuthorizationConfig` are never called, so no `serviceUrl`, `authType` or client reaches a session. The broker logs no part of any token.

## Error Handling

- Provider errors propagate unchanged (class, `code`, `missingFields`, `cause`).
- Store reads: `null` or `FILE_NOT_FOUND` is absence and the broker goes on to the next source; any other store failure is thrown unchanged — before the provider is asked when it happens in the reads that come before the token; one in the reads a write makes (the session, for the refresh token to carry; the key store, for the `basic`/`snc` guard) counts as a failed write.
- A write that fails is retried by `SessionWriter` and reported by `flush()`; the token API also throws it to its caller, for the result it received.
- A destination that lacks what its type needs: `DestinationConfigError`
  (`code: 'DESTINATION_CONFIG'`, `destination`, `missingFields` — names only,
  never a value; no `cause`, since a provider's own error quotes the value it
  refused).

## Responsibilities Split

- **AuthBroker**: orchestration and persistence.
- **Stores**: the means (read-only to the broker) and the secret.
- **Providers**: token lifecycle, OAuth/SAML flows, how a login is conducted.
