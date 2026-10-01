# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is an npm workspace (the `mcp-abap-adt-interfaces` layout) with two packages: `packages/auth-broker` — `@mcp-abap-adt/auth-broker`, a per-destination token broker for SAP BTP/ABAP systems — and `packages/auth-broker-cli` — `@mcp-abap-adt/auth-broker-cli`, the `mcp-auth` and `mcp-sso` commands. For a destination name it reads the session and service key from injected stores, gets tokens from an injected `IRefreshableTokenProvider` (or a factory building one per destination), and persists the result — a JWT or SAML session cookies, with the refresh token. Token lifecycle decisions are the provider's (`@mcp-abap-adt/auth-providers`); storage is the stores' (`@mcp-abap-adt/auth-stores`). The commands moved out of the library into the CLI package; up to 3.0.4 they shipped in the library. XSUAA and ABAP authentication types are both supported.

## Build and Development Commands

Everything runs from the repository root; the dev dependencies (Biome, TypeScript, Jest, ts-jest, semver) are the root's.

```bash
npm run build        # clean, Biome at error level, tsc -b over both packages
npm run test:check   # type-check both packages, tests included
npm run lint         # Biome with --write over packages/ and tools/
npm run lint:check   # Biome, read-only
npm run format
npm test             # Jest in every workspace
npm run check        # build, test:check, lint:check, check:graph, check:packed, check:publish (no Jest)

# One package, one file, one case
npm test -w @mcp-abap-adt/auth-broker
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts -t "name of the case"
npm test -w @mcp-abap-adt/auth-broker-cli
```

- `check:graph` (`tools/check-graph.js`): runtime files (src outside `__tests__`) import only their package's allowlist, declare it in `dependencies`, and use every dependency; tests import only what the package declares (dependencies or devDependencies). The library never imports `auth-stores`.
- `check:packed` (`tools/check-packed.js`): the bin smoke check — pack both, install the tarballs into an empty directory, run `mcp-auth`/`mcp-sso` with `--version` (must print the CLI's version) and `help`, load the library (no `bin`). Needs the network.
- `check:publish` (`tools/test-publish-changed.js`): the release tool against fixture repositories.
- `release:publish` (`tools/publish-changed.js`): publishes exactly the versions the registry lacks, in workspace order, after one `npm run check`; refuses an untagged version. Tags are `<dir>-v<version>` (`auth-broker-v…`, `auth-broker-cli-v…`); the `v*` tags are the single package's history. Between a version bump and its tags it refuses for the whole repository: tag the merge commit first. Never `npm publish` a workspace by hand.

## Architecture

### Core Components

**AuthBroker** (`packages/auth-broker/src/AuthBroker.ts`) - The main class that orchestrates token management:
- Coordinates between session stores, service key stores, and token providers
- Implements a multi-step token acquisition flow: validate cached token -> refresh token -> browser-based OAuth
- Creates `ITokenRefresher` instances for dependency injection into consuming services

**Stores** (interfaces from `@mcp-abap-adt/interfaces-auth-broker`, implementations in `@mcp-abap-adt/auth-stores` — which the library's runtime never imports; only its tests and the CLI do):
- `ISessionStore` - Stores session data (tokens, connection config) in `.env` files
- `IServiceKeyStore` - Reads service keys from `.json` files for initial authentication

**Token Providers** (from `@mcp-abap-adt/auth-providers`):
- `AuthorizationCodeProvider` - OAuth2 authorization_code flow with browser
- `ClientCredentialsProvider` - OAuth2 client_credentials flow (no browser)

### Package Dependencies

The contracts come from the packages that declare them — `@mcp-abap-adt/interfaces-auth` 3 (tokens, `STORE_ERROR_CODES`), `-auth-broker` 1 (the store contracts: `IConfig`, `IConnectionConfig`, `ISessionStore`, `IServiceKeyStore`), `-auth-sap` 2 (`IAuthorizationConfig`, `AuthType` — the only two that stayed there) and `-utils` (`ILogger`). The library's tests and the CLI use `auth-providers` 5.1 and still `auth-stores` 1.2.3: its 3.0.0 session stores refuse the means the 3.x broker and the CLI write into a session, so the library's tests move to it with the broker's persistence (plan step 4e) and the CLI with its destination store (step 5). **Not `@mcp-abap-adt/interfaces`**: that facade is deleted as of its 52.0.0, npm serves 51.0.0 to whoever is pinned to it, and nothing further ships there. Some of those types are re-exported here for convenience, each from the package that declares it. Store and provider implementations are in separate packages:
- `@mcp-abap-adt/auth-stores` - ABAP and XSUAA store implementations
- `@mcp-abap-adt/auth-providers` - Token provider implementations

### CLI Tool

`packages/auth-broker-cli/src/` — `mcp-auth.ts`, `mcp-sso.ts` (the bins, compiled to `dist/`), `mcpSsoConfig.ts`, `samlMetadata.ts`, `workDir.ts`, and `generate-env-from-service-key.ts` (a development script run with `tsx`, `npm run generate-env -w @mcp-abap-adt/auth-broker-cli`, not compiled). They import `AuthBroker` from `@mcp-abap-adt/auth-broker` by name, never by a path into its `dist`, and `--version` reads the CLI's own manifest.
```bash
mcp-auth --service-key ./key.json --output ./mcp.env --type xsuaa
mcp-auth --service-key ./key.json --output ./abap.env --type abap --credential
```

## Testing

Tests live in each package's `src/__tests__/` (see `docs/development/TESTING.md`):
- Library: `AuthBroker.test.ts` needs nothing; `AuthBroker.integration.test.ts` reads real service keys and sessions only when `packages/auth-broker/tests/test-config.yaml` exists (from the template beside it) — without it every case returns at once.
- CLI: `mcpSsoConfig`, `mcpSsoSamlProviders`, `samlMetadata` — need nothing. The Keycloak and CAP stands under `packages/auth-broker-cli/tests/` are interactive, by hand only.
- Tests run sequentially (`maxWorkers: 1`) to ensure proper file state.

## Code Style

- Biome for linting and formatting (2-space indent, single quotes, semicolons)
- Strict TypeScript with `noExplicitAny` as warning (disabled in tests)
- CommonJS module output targeting ES2022

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.
