# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@mcp-abap-adt/auth-broker`, a JWT authentication broker for MCP ABAP ADT. It manages OAuth2 tokens for SAP BTP/ABAP systems, supporting both XSUAA and ABAP authentication types.

## Build and Development Commands

```bash
# Build (clean, lint, compile)
npm run build

# Fast build (TypeScript only, skip lint)
npm run build:fast

# Lint and auto-fix
npm run lint

# Lint check only (no fix)
npm run lint:check

# Format code
npm run format

# Run all tests
npm test

# Run specific test file
npm test -- AuthBroker.test.ts

# Run specific test by name pattern
npm test -- -t "Test 1"

# Type check (no emit)
npm run test:check
```

## Architecture

### Core Components

**AuthBroker** (`src/AuthBroker.ts`) - The main class that orchestrates token management:
- Coordinates between session stores, service key stores, and token providers
- Implements a multi-step token acquisition flow: validate cached token -> refresh token -> browser-based OAuth
- Creates `ITokenRefresher` instances for dependency injection into consuming services

**Stores** (interfaces from `@mcp-abap-adt/interfaces`, implementations in `@mcp-abap-adt/auth-stores`):
- `ISessionStore` - Stores session data (tokens, connection config) in `.env` files
- `IServiceKeyStore` - Reads service keys from `.json` files for initial authentication

**Token Providers** (from `@mcp-abap-adt/auth-providers`):
- `AuthorizationCodeProvider` - OAuth2 authorization_code flow with browser
- `ClientCredentialsProvider` - OAuth2 client_credentials flow (no browser)

### Package Dependencies

This package re-exports interfaces from `@mcp-abap-adt/interfaces` for convenience. Store and provider implementations are in separate packages:
- `@mcp-abap-adt/auth-stores` - ABAP and XSUAA store implementations
- `@mcp-abap-adt/auth-providers` - Token provider implementations

### CLI Tool

`bin/mcp-auth.ts` - Command-line tool for generating `.env` files from service keys:
```bash
mcp-auth --service-key ./key.json --output ./mcp.env --type xsuaa
mcp-auth --service-key ./key.json --output ./abap.env --type abap --credential
```

## Testing

Tests are in `src/__tests__/` and use real implementations (no mocks) for integration testing:
- Browser tests (Test 2) require user interaction and are skipped in CI
- Tests run sequentially (`maxWorkers: 1`) to ensure proper file state
- Test config: `tests/test-config.yaml` (from template `tests/test-config.yaml.template`)

## Code Style

- Biome for linting and formatting (2-space indent, single quotes, semicolons)
- Strict TypeScript with `noExplicitAny` as warning (disabled in tests)
- CommonJS module output targeting ES2022
