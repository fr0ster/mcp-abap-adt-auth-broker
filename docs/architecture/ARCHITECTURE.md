# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package.

## Overview

`auth-broker` orchestrates JWT token management for SAP ABAP ADT and BTP scenarios. It delegates storage to session/service-key stores and delegates token acquisition/refresh to injected token providers.

Supported authentication styles:
- **ABAP/BTP**: authorization_code (browser or refresh token)
- **XSUAA**: client_credentials (no browser)

## Core Principles

- **Interface-only communication**: The broker only talks to `ISessionStore`, `IServiceKeyStore`, and `ITokenProvider` interfaces.
- **Dependency inversion**: Implementations live in `@mcp-abap-adt/auth-stores` and `@mcp-abap-adt/auth-providers`.
- **Stateful providers**: Providers own token lifecycle (refresh/relogin) and return fresh tokens via `getTokens()`.

## Core Components

### AuthBroker

`AuthBroker` orchestrates token retrieval and persistence:
- Loads session data and service URLs from stores.
- Validates existing tokens if the provider supports `validateToken`.
- Requests new tokens via `tokenProvider.getTokens()` and persists results to the session store.
- Supports `allowBrowserAuth` to disable interactive flows in headless environments.

### Stores

Stores provide configuration data:
- `ISessionStore` exposes stored tokens and connection info (`IConnectionConfig`).
- `IServiceKeyStore` exposes authorization config (`IAuthorizationConfig`) and connection config.

Concrete stores live in `@mcp-abap-adt/auth-stores` (ABAP, BTP, XSUAA, safe in-memory variants).

### Providers

Providers live in `@mcp-abap-adt/auth-providers` and implement `ITokenProvider`:
- `AuthorizationCodeProvider` for ABAP/BTP (authorization_code + refresh token).
- `ClientCredentialsProvider` for XSUAA (client_credentials).

Providers are configured at construction time and manage refresh/re-auth internally. The broker simply calls `getTokens()`.

## Authentication Flow (getToken)

1. **Step 0 - Initialize**
   - If the session has no token and no auth config, the broker loads auth config from `serviceKeyStore` and calls `tokenProvider.getTokens()`.
   - Tokens are persisted to the session store.

2. **Step 1 - Validate**
   - If a token exists and `validateToken` is available, validate it.
   - If valid, return the existing token.

3. **Step 2 - Refresh/Re-auth**
   - If session auth config exists, call `tokenProvider.getTokens()`.
   - If that fails (or no session auth config), fall back to service key auth config and call `tokenProvider.getTokens()` again.
   - If browser auth is disabled and a refresh token is not available, the broker throws `BROWSER_AUTH_REQUIRED`.

## Error Handling

- Store errors are handled defensively with fallbacks (session → service key).
- Provider errors are surfaced with actionable messages (validation, browser auth, network).
- Critical persistence errors (unable to save tokens) fail fast.

## Responsibilities Split

- **AuthBroker**: orchestration and persistence.
- **Stores**: reading/writing config and tokens.
- **Providers**: OAuth flows, refresh logic, token validation.
