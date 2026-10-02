# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package.

## Overview

`auth-broker` orchestrates JWT token management for SAP ABAP ADT and BTP scenarios. It delegates storage to session/service-key stores and delegates token acquisition/refresh to injected token providers.

Supported authentication styles:
- **ABAP/BTP**: authorization_code (browser or refresh token)
- **XSUAA**: client_credentials (no browser)

## Repository Layout

An npm workspace in the layout of `mcp-abap-adt-interfaces`:

```
/                          private root: package.json (workspaces, scripts), package-lock.json,
                           tsconfig.base.json, biome.json, tools/, docs/
packages/auth-broker/      @mcp-abap-adt/auth-broker — the library (src/, its tests,
                           tests/test-config.yaml.template, tests/stand/: UAA and
                           Keycloak in Docker for the token grants' suites)
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
- Releases are tagged per package, `<dir>-v<version>` (`auth-broker-v3.1.0`,
  `auth-broker-cli-v1.0.0`); `npm run release:publish` publishes exactly the
  versions the registry lacks, and refuses one without its tag.

## Core Principles

- **Interface-only communication**: The broker only talks to `ISessionStore`, `IServiceKeyStore`, and `IRefreshableTokenProvider` interfaces. `getProvider` constructs auth-providers classes by name, from what the destination states, and hands them out as `IAuthProvider`.
- **Means and secret are split by store**: the service key store holds the means (`authType`, `grantType`, the client, basic's user and password, the SNC fields, `serviceUrl`), the session store the secret (token or cookies, `expiresAt`, refresh token). `getProvider` and the broker's `getConnectionConfig` / `getAuthorizationConfig` read each from its own store only.
- **The destination states its provider**: `authType`, and `grantType` for `jwt` / `saml`, choose it — never which other fields are present.
- **Dependency inversion**: Implementations live in `@mcp-abap-adt/auth-stores` and `@mcp-abap-adt/auth-providers`.
- **The provider decides**: Providers own the token lifecycle — whether the cached token is still good, refresh, re-login — and how a login is conducted (their authorization strategy). The broker does not repeat or override any of it.

## Core Components

### AuthBroker

`AuthBroker` orchestrates, nothing more:
- Resolves `serviceUrl` (session, else service key), the UAA credentials (session, else service key) and the stored token and refresh token.
- Builds the provider on first use when given a factory, seeded with the above, and reuses it per destination; uses an instance as given.
- Asks the provider once — `getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()` — with no retry and no fallback.
- Persists the result by type (session cookies for SAML, bearer token otherwise; the refresh token when present) and returns the token.

### `getProvider`

`getProvider(destination)` builds the `IAuthProvider` a `connection` 10
connector takes:
- reads the means from the service key store (`getConnectionConfig`); none,
  or no `authType`, is a `DestinationConfigError` — whatever the session holds;
- `basic` → `BasicAuthProvider(username, password)`; `snc` →
  `SncLogonProvider.forSecureLoginClient(…)` from the four SNC fields — neither
  reads the session;
- `jwt` / `saml` need a `grantType` from the table (spec §3.1); `none` reads the
  session (`loadSession`) and hands over its token (`TokenAuthProvider.fixed`)
  or cookies (`SamlAuthProvider`);
- `jwt` / `authorization_code`, `client_credentials`, `passcode` →
  `AuthorizationCodeProvider`, `ClientCredentialsProvider`,
  `UaaPasscodeProvider`, with the client from the key store
  (`getAuthorizationConfig`), seeded from the session (token, refresh token,
  `expiresAt`; not `client_credentials`) only when the session is bound to
  this destination (below), the consumer's `authorization(d, grant)` for the
  two interactive ones, the broker's logger and `onTokens`; the OIDC and SAML
  grants are not built yet;
- caches the *promise* of the build per destination, set before the first store
  read and dropped when the build throws, so concurrent first calls build once
  and a failure is retried.

### The binding (`src/binding.ts`)

A stored secret is used only for the resource it was obtained for, from the
issuer and client that issued it (spec §4.5). `getProvider` computes, from the
means, `issuedFor` (`serviceUrl` + `sapClient`) and `issuedBy` (`uaaUrl` +
`uaaClientId` for the UAA grants; for `none`, `oidcIssuerUrl` or the client
for `jwt`, `samlAcsUrl` for `saml`), with one canonicalising function — the
broker's only: scheme and host lower-cased by `URL`, the port explicit
(443/80), the path without a trailing `/`, one parameter (`sap-client`, the
means' `sapClient` first; `client_id`; none for an ACS) re-encoded through
`URLSearchParams`, nothing else. The session's values are canonicalised the
same way before the comparison, so a store keeps them as given. The UAA rows
seed only when both match — otherwise the secret, refresh token included, is
dropped (`boundOrDiscarded`, one value-free warn line) and the provider logs
in afresh; the `none` rows throw `DestinationConfigError` naming `issuedFor`
(always compared) or `issuedBy` (compared when the means state an issuer).

### Persistence (`SessionWriter`)

Every token provider `getProvider` builds gets `onTokens`, which
`BaseTokenProvider` awaits after every login and refresh — never on a cache
hit — so a renewal inside a connector is stored before the connector resends.
The broker writes the session secret alone, `{ authorizationToken, expiresAt,
refreshToken, issuedFor, issuedBy }` in one `saveSession` — the expiry fixed
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

Stores provide configuration data:
- `ISessionStore` exposes stored tokens and connection info (`IConnectionConfig`), and the refresh token.
- `IServiceKeyStore` exposes authorization config (`IAuthorizationConfig`) and connection config.

Concrete stores live in `@mcp-abap-adt/auth-stores` (ABAP, XSUAA, safe in-memory variants).

### Providers

Providers live in `@mcp-abap-adt/auth-providers` and implement `IRefreshableTokenProvider` (from 4.2.0):
- `AuthorizationCodeProvider` for ABAP/BTP (authorization_code + refresh token).
- `ClientCredentialsProvider` for XSUAA (client_credentials).
- The OIDC and SAML providers built by `SsoProviderFactory`.

`getTokens()` answers the cache while valid, else refreshes, else logs in. `refreshTokens()` always obtains a new token (decision 39 in `@mcp-abap-adt/interfaces`' DECISIONS.md: a forced refresh is its own interface, not a flag).

## Authentication Flow

**`getToken(destination)`**
1. Resolve `serviceUrl`; without one, fail before asking the provider.
2. Build (factory, first call for the destination) or reuse the provider. The factory receives the credentials with the stored refresh token, and the connection config with the stored token.
3. `provider.getTokens()`.
4. Persist: `sessionCookies` when `tokenType` is `'saml'`, else `authorizationToken`; the refresh token when the result carries one.
5. Return the token.

**`refreshToken(destination)`** is the same with `provider.refreshTokens()` — a new token, never the cached one — and backs `ITokenRefresher.refreshToken()` from `createTokenRefresher()`.

**Headless processes** configure the provider with an authorization strategy that refuses and catch the error it throws; there is no broker switch for it.

## Secrets

What a `getProvider` provider obtains is written as the secret alone (see *Persistence*). The token API writes tokens and the refresh token to the session store, never the client secret; credentials from the service key stay there. A session with credentials of its own keeps them and only its refresh token changes. The broker logs no part of any token.

## Error Handling

- Provider errors propagate unchanged (class, `code`, `missingFields`, `cause`).
- Store reads: `null` or `FILE_NOT_FOUND` is absence and the broker goes on to the next source; any other store failure is thrown unchanged — before the provider is asked when it happens in the reads that come before the token, after the provider answered and the token was written when it happens in the reads `persist()` makes to save the refresh token.
- Store writes that fail propagate from the token API; `getProvider`'s writes
  are retried and reported by `flush()`.
- A destination that lacks what its type needs: `DestinationConfigError`
  (`code: 'DESTINATION_CONFIG'`, `destination`, `missingFields` — names only,
  never a value; no `cause`, since a provider's own error quotes the value it
  refused).

## Responsibilities Split

- **AuthBroker**: orchestration and persistence.
- **Stores**: reading/writing config and tokens.
- **Providers**: token lifecycle, OAuth/SAML flows, how a login is conducted.
