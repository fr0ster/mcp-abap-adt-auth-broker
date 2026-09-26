# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package.

## Overview

`auth-broker` orchestrates JWT token management for SAP ABAP ADT and BTP scenarios. It delegates storage to session/service-key stores and delegates token acquisition/refresh to injected token providers.

Supported authentication styles:
- **ABAP/BTP**: authorization_code (browser or refresh token)
- **XSUAA**: client_credentials (no browser)

## Core Principles

- **Interface-only communication**: The broker only talks to `ISessionStore`, `IServiceKeyStore`, and `IRefreshableTokenProvider` interfaces.
- **Dependency inversion**: Implementations live in `@mcp-abap-adt/auth-stores` and `@mcp-abap-adt/auth-providers`.
- **The provider decides**: Providers own the token lifecycle — whether the cached token is still good, refresh, re-login — and how a login is conducted (their authorization strategy). The broker does not repeat or override any of it.

## Core Components

### AuthBroker

`AuthBroker` orchestrates, nothing more:
- Resolves `serviceUrl` (session, else service key), the UAA credentials (session, else service key) and the stored token and refresh token.
- Builds the provider on first use when given a factory, seeded with the above, and reuses it per destination; uses an instance as given.
- Asks the provider once — `getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()` — with no retry and no fallback.
- Persists the result by type (session cookies for SAML, bearer token otherwise; the refresh token when present) and returns the token.

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

The broker writes tokens and the refresh token to the session store, never the client secret; credentials from the service key stay there. A session with credentials of its own keeps them and only its refresh token changes. The broker logs no part of any token.

## Error Handling

- Provider errors propagate unchanged (class, `code`, `missingFields`, `cause`).
- Store reads: `null` or `FILE_NOT_FOUND` is absence and the broker goes on to the next source; any other store failure is thrown unchanged, before the provider is asked.
- Store writes that fail propagate.

## Responsibilities Split

- **AuthBroker**: orchestration and persistence.
- **Stores**: reading/writing config and tokens.
- **Providers**: token lifecycle, OAuth/SAML flows, how a login is conducted.
