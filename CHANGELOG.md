# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the complete list.

## [Unreleased]

## [0.3.5] - 2026-01-28

### Changed
- **CLI**: Remove legacy wrapper; only compiled `dist/bin/mcp-auth.js` remains (no runtime `spawn`).

## [0.3.4] - 2026-01-28

### Changed
- **CLI**: Ship a compiled `mcp-auth` binary in `dist/bin` and point `bin` to it (no runtime `tsx`).
- **Build**: Added `tsconfig.cli.json` to compile the CLI during build.

## [0.3.3] - 2026-01-28

### Fixed
- **CLI**: Resolve local `tsx` via its `bin` entry so global installs work without `npx` or global `tsx`.

## [0.3.2] - 2026-01-28

### Changed
- **CLI**: Run via local `tsx` CLI using Node to avoid platform-specific spawn issues (no `npx`/`.cmd`).
- **Build**: Use local `tsc` and `biome` binaries directly to avoid `npx` resolving the wrong package.

### Documentation
- **README**: Clarify that `mcp-auth` uses local dependencies and does not require global `tsx`.

### Documentation
- **README**: Clarify that `mcp-auth` uses local dependencies and does not require global `tsx`.

## [0.3.0] - 2025-12-31

### Added
- **CLI**: Auto-detect service key format (ABAP vs XSUAA) based on content structure
- **CLI**: Support for "credentials" wrapper in service keys (common in SAP BTP)
- **CLI**: Fallback parsing when stores fail to parse service key
- **CLI**: Log authorization URL and redirect URI for easier debugging
- **Documentation**: Added `CLAUDE.md` for Claude Code project guidance

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/auth-stores` from `^0.2.10` to `^0.3.0`

### Fixed
- **CLI**: Filter placeholder `<SERVICE_URL>` from output when not available

## [0.2.17] - 2025-12-31

### Changed
- **Dependencies**: Depend on the published `@mcp-abap-adt/auth-broker` `^0.2.17` package to keep the CLI wiring aligned with the latest release.
- **Dependencies**: Bump `@mcp-abap-adt/interfaces` to `^0.2.15` so consumers pick up the current interface contracts.

## [0.2.16] - 2025-12-31

### Changed
- **CLI**: Changed default authentication flow from `client_credentials` to `authorization_code`
  - Both ABAP and XSUAA now use `authorization_code` by default (browser-based OAuth2)
  - Default browser is `auto` (tries to open browser, falls back to showing URL)
  - Added `--credential` flag for `client_credentials` flow (special cases)
  - `--browser none` shows URL in console and waits for callback (no browser opened)
- **CLI**: Updated help text and examples to reflect new defaults

### Fixed
- **CLI**: Fixed process hanging after successful token retrieval by adding explicit `process.exit(0)`

## [0.2.15] - 2025-12-30

### Fixed
- **CLI**: Remove duplicate `authConfig` declaration in `mcp-auth.ts` that caused esbuild/tsx to fail with "symbol already declared" error

## [0.2.14] - 2025-12-26

### Added
- **Structured logging**: Added detailed logging throughout `AuthBroker` for better debugging and observability
  - Logs broker initialization with configuration details
  - Logs token retrieval operations with formatted tokens (start...end format)
  - Logs token persistence with expiration dates in readable format
  - Logs session state checks with token and refresh token information
  - Uses `formatToken()` and `formatExpirationDate()` utilities for consistent formatting
- **Token formatting utilities**: Added `formatExpirationDate()` function to `utils/formatting.ts` for readable date/time formatting (e.g., "2025-12-25 19:21:27 UTC")
- **Test configuration**: Added `forceExit: true` to `jest.config.js` to prevent test hanging after completion

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/auth-providers` from `^0.2.8` to `^0.2.10`
- **Dependencies**: Updated `@mcp-abap-adt/auth-stores` from `^0.2.9` to `^0.2.10`
- **Logging format**: All token logging now uses formatted tokens (shows first 25 and last 25 characters, skipping middle)
- **Logging format**: All expiration date logging now uses readable date/time format instead of raw timestamps

### Fixed
- **Test hanging**: Fixed issue where tests would hang after completion by adding `forceExit: true` to Jest configuration

## [0.2.13] - 2025-12-26

### Changed
- **Token lifecycle management**: Broker now always calls `provider.getTokens()` instead of validating tokens itself. Provider handles all token lifecycle operations internally (validation, refresh, login). Consumer doesn't need to know about token issues - provider manages everything automatically.
- **Removed token validation step**: Removed Step 1 (Token Validation) from broker flow. Broker no longer checks token validity before calling provider - provider decides what to do based on token state.
- **Simplified broker logic**: Broker is now a thin wrapper that always delegates to provider. Provider is responsible for token lifecycle management.

### Removed
- **`validateExistingToken()` method**: Removed internal token validation method. Broker no longer validates tokens - provider handles this internally via `getTokens()`.

### Fixed
- **Compatibility with auth-providers 0.2.8**: Removed dependency on deprecated `refreshTokenFromServiceKey()` method from token providers. Broker now exclusively uses `getTokens()` method which handles all token lifecycle operations internally. This ensures compatibility with stateful token providers that manage refresh/re-auth internally.

## [0.2.12] - 2025-12-25

### Changed
- **Auth flow**: Broker now relies on `ITokenProvider.getTokens()` with no parameters and expects providers to manage refresh/re-auth internally.
- **Constructor**: `tokenProvider` is required and `allowBrowserAuth` is supported for non-interactive flows.
- **Docs**: Updated usage/architecture/export docs to reflect provider injection, new flow, and CLI usage.

## [0.2.11] - 2025-12-23

### Changed
- **mcp-auth CLI**: Reworked to use AuthBroker + stores with env-first refresh fallback to service key.
- **Token provider wiring**: AuthBroker now guards optional token provider methods before invoking them.
- **Docs**: Added CLI usage details for mcp-auth in README and usage guide.

### Updated
- **Dependencies**: Bumped `@mcp-abap-adt/interfaces` to ^0.2.9 and `@mcp-abap-adt/auth-providers` to latest.

## [0.2.10] - 2025-12-22

### Changed
- **Biome Migration**: Migrated from ESLint/Prettier to Biome for linting and formatting
  - Added `@biomejs/biome` as dev dependency
  - Added `lint`, `lint:check`, and `format` scripts to package.json
  - Integrated Biome check into build process (`npx biome check src --diagnostic-level=error`)
  - Replaced `unknown` with `any` in catch blocks (Biome requirement)
  - Added `ErrorWithCode` type for better error type safety
  - Refactored `getToken()` method into smaller private methods for better maintainability:
    - `loadSessionData()` - loads session connection and authorization configs
    - `getServiceUrl()` - gets serviceUrl from session or service key store
    - `getUaaCredentials()` - gets UAA credentials from session or service key
    - `saveTokenToSession()` - saves token and config to session
    - `initializeSessionFromServiceKey()` - Step 0: initializes session from service key
    - `validateExistingToken()` - Step 1: validates existing token
    - `refreshTokenFromSession()` - Step 2a: refreshes token from session
    - `refreshTokenFromServiceKey()` - Step 2b: refreshes token from service key

### Fixed
- Fixed type safety issues by replacing `unknown` with `any` in error handling
- Removed unnecessary type assertions by using `ErrorWithCode` type
- Improved code organization and readability through method extraction

## [0.2.9] - 2025-12-21

### Added
- **`createTokenRefresher()` Method**: New factory method to create `ITokenRefresher` for dependency injection
  - Returns `ITokenRefresher` implementation for a specific destination
  - `getToken()` - returns cached token if valid, otherwise refreshes
  - `refreshToken()` - forces token refresh and saves to session store
  - Designed to be injected into `JwtAbapConnection` via DI
  - Enables connections to handle 401/403 transparently without knowing auth internals

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/interfaces` to `^0.2.5`
  - New `ITokenRefresher` interface for token management DI
  - Simplified `IAbapConnection` interface (consumer-facing methods only)

### Exports
- Re-export `ITokenRefresher` type from `@mcp-abap-adt/interfaces` for convenience

## [0.2.8] - 2025-12-21

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/auth-stores` to `^0.2.8`
  - EnvFileSessionStore now persists JWT tokens back to .env file after token refresh
  - Removed duplicate BTP stores (now aliases to XSUAA equivalents)

## [0.2.7] - 2025-12-21

### Added
- **Headless Browser Mode**: Added `browser: 'headless'` option for SSH and remote sessions
  - Logs authentication URL and waits for manual callback
  - Ideal for environments without display (SSH, Docker, CI/CD)
  - Differs from `'none'` which rejects immediately (for automated tests)

### Changed
- **Documentation Update**: Updated browser option documentation to clarify `headless` vs `none` modes

### Dependencies
- Updated `@mcp-abap-adt/interfaces` to `^0.2.4` for headless browser mode support
- Updated `@mcp-abap-adt/auth-providers` to `^0.2.3` (devDependency, tests only) for headless mode implementation

## [0.2.5] - 2025-12-20

### Added
- **`allowBrowserAuth` Option**: New configuration option to control browser-based authentication
  - When `allowBrowserAuth: false`, broker throws `BROWSER_AUTH_REQUIRED` error instead of blocking on browser auth
  - Useful for headless/non-interactive environments (e.g., MCP stdio transport with Cline)
  - Error includes `code: 'BROWSER_AUTH_REQUIRED'` and `destination` property for programmatic handling
  - Broker still works with valid session tokens or refresh tokens when browser auth is disabled

### Dependencies
- Updated `@mcp-abap-adt/auth-providers` to `^0.2.2` for automatic port selection, improved server shutdown, and process termination cleanup
  - Browser auth server now automatically finds an available port if the requested port is in use
  - Improved server shutdown ensures ports are properly freed after authentication completes
  - Prevents `EADDRINUSE` errors when multiple stdio servers run simultaneously
  - Ports are properly released after server shutdown, preventing lingering port occupation

## [0.2.4] - 2025-12-19

### Changed
- **Comprehensive Error Handling**: Added robust error handling for all external operations
  - **SessionStore errors**: Handle FILE_NOT_FOUND, PARSE_ERROR from session files (graceful degradation)
  - **ServiceKeyStore errors**: Handle FILE_NOT_FOUND, PARSE_ERROR, INVALID_CONFIG from service key files (log and fallback)
  - **TokenProvider errors**: Handle network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND), validation errors, browser auth failures
  - **Write operation errors**: Handle failures when saving tokens/config to session files
  - All errors logged with detailed context (file paths, error codes, missing fields)
  - Broker continues with fallback mechanisms when possible instead of crashing
- **Token Refresh Architecture**: Removed direct UAA HTTP requests from AuthBroker
  - `getToken()` now uses provider's `refreshTokenFromSession()` (Step 2a) and `refreshTokenFromServiceKey()` (Step 2b) methods
  - All authentication logic delegated to providers (XsuaaTokenProvider, BtpTokenProvider)
  - Providers handle browser-based authentication and client_credentials flow internally
  - Better error handling with typed errors from `@mcp-abap-adt/auth-providers@0.2.0`
- **Error Handling**: Improved error handling in token requests
  - Network errors (connection issues) are now handled separately from HTTP errors (401, 403)
  - Better error messages with UAA URL context when network errors occur
  - No retry attempts for network errors (retries cannot fix infrastructure issues)

### Fixed
- **Defensive Programming**: Treat all injected dependencies as untrusted
  - File operations (session/service key stores) may fail - files missing, corrupted, permission issues
  - Network operations (token provider) may fail - timeouts, connection refused, invalid responses
  - All external operations wrapped in try-catch with specific error handling per operation type
  - Prevents broker crashes when consumers misconfigure files or network issues occur
- **Network Error Detection**: Add proper network error detection in token requests
  - Detect network errors: `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, `ENETUNREACH`, `EHOSTUNREACH`
  - Throw network errors immediately with clear error message indicating connectivity issues
  - Prevents confusing error messages when VPN is down or server is unreachable
  - Network errors now clearly indicate infrastructure issues vs authentication failures
- **Simplified Refresh**: `refreshToken()` now simply delegates to `getToken()` for full refresh flow
  - Ensures consistent refresh behavior across all token operations
  - No code duplication between getToken and refreshToken methods

### Removed
- **Direct UAA Code**: Removed direct UAA request methods and old credential flow
  - Removed `getTokenWithClientCredentials()` private method (logic moved to providers)
  - Removed `refreshTokenDirect()` private method (logic moved to providers)
  - Removed `allowClientCredentials` constructor parameter (handled by providers)
  - Removed old "Step 2: UAA Credentials Flow" (replaced with provider-based Step 2a/2b)

### Dependencies
- Updated `@mcp-abap-adt/interfaces` to `^0.2.3` for STORE_ERROR_CODES and TOKEN_PROVIDER_ERROR_CODES
- Updated `@mcp-abap-adt/auth-stores` to `^0.2.5` for typed errors (ParseError, FileNotFoundError, etc.)
- Updated `@mcp-abap-adt/auth-providers` to `^0.2.0` for new refresh methods and typed errors

## [0.2.3] - 2025-12-18

### Added
- `allowClientCredentials` config flag (default: true). Set to `false` to skip UAA client_credentials flow and force provider/browser-based login (useful for ABAP ADT backends that reject service tokens).

## [0.2.2] - 2025-12-13

### Changed
- Dependency bump: `@mcp-abap-adt/interfaces` to `^0.1.16` to align with latest interfaces release

## [0.2.1] - 2025-12-12

### Fixed
- **ServiceUrl fallback from serviceKeyStore**: Fixed `getToken()` method to retrieve `serviceUrl` from `serviceKeyStore` when it's missing in session
  - Previously, `getToken()` would throw an error immediately if `serviceUrl` was not found in session, even when it was available in `serviceKeyStore`
  - Now, the method first checks session for `serviceUrl`, and if not found, attempts to retrieve it from `serviceKeyStore` before throwing an error
  - This allows integration tests and real-world scenarios to work correctly when session is empty but service key contains `serviceUrl`
  - Error messages now indicate that `serviceUrl` can come from either session or `serviceKeyStore`

## [0.2.0] - 2025-12-08

### Breaking Changes

**⚠️ IMPORTANT: This is a breaking change with NO backward compatibility. Migration is required. See Migration Guide below.**

#### Constructor Signature Changed
- **Constructor now accepts configuration object**: The constructor signature has changed from requiring all three dependencies to making `serviceKeyStore` and `tokenProvider` optional
- **No backward compatibility**: Old constructor signature is NOT supported. You must update your code to use the new signature. Migration guide provided below.
  - **Before (v0.1.x)**:
    ```typescript
    new AuthBroker({
      serviceKeyStore: serviceKeyStore,  // required
      sessionStore: sessionStore,         // required
      tokenProvider: tokenProvider,      // required
    }, browser?, logger?)
    ```
  - **After (v0.2.0)**:
    ```typescript
    new AuthBroker({
      sessionStore: sessionStore,         // required
      serviceKeyStore?: serviceKeyStore,  // optional
      tokenProvider?: tokenProvider,      // optional
    }, browser?, logger?)
    ```

#### New Authentication Flow
- **Three-step authentication flow**: `getToken()` now implements a new three-step flow (Step 0, Step 1, Step 2) instead of the previous six-step fallback chain
- **Direct UAA HTTP requests**: When UAA credentials are available in session, broker uses direct HTTP requests to UAA without requiring `tokenProvider`
- **Session initialization requirements**: SessionStore must contain initial session with `serviceUrl` before calling `getToken()`

### Added

#### Direct UAA HTTP Requests
- **Direct UAA refresh_token grant**: When UAA credentials are available in session, broker can refresh tokens directly via HTTP without `tokenProvider`
- **Direct UAA client_credentials grant**: When UAA credentials are available, broker can obtain tokens directly via HTTP without `tokenProvider`
- **Automatic fallback to provider**: If direct UAA requests fail and `tokenProvider` is available, broker automatically falls back to provider

#### Flexible Configuration
- **Optional serviceKeyStore**: `serviceKeyStore` is now optional - only needed for initializing sessions from service keys
- **Optional tokenProvider**: `tokenProvider` is now optional - only needed for browser authentication or when direct UAA requests fail
- **Session-only mode**: Can work with only `sessionStore` if session contains valid UAA credentials (no `serviceKeyStore` or `tokenProvider` needed)

#### Enhanced Error Messages
- **Step-based error messages**: Error messages now indicate which step failed (Step 0, Step 1, or Step 2)
- **Context-aware errors**: Error messages include information about what was tried and what's available
- **Actionable errors**: Error messages suggest what to do next (e.g., "Provide serviceKeyStore to initialize from service key")

### Changed

#### Authentication Flow (getToken)
- **Step 0: Session Initialization**: 
  - Checks if session has `authorizationToken` and UAA credentials
  - If both empty and `serviceKeyStore` available: tries direct UAA request from service key, falls back to provider if failed
  - If session has token OR UAA credentials → proceeds to Step 1
- **Step 1: Refresh Token Flow**:
  - If refresh token exists: tries direct UAA refresh, falls back to provider if failed
  - If successful → returns new token
  - Otherwise → proceeds to Step 2
- **Step 2: UAA Credentials Flow**:
  - Tries direct UAA client_credentials request, falls back to provider if failed
  - If successful → returns new token
  - If all failed → throws error

#### Token Refresh (refreshToken)
- **Direct UAA support**: Uses direct UAA HTTP requests when UAA credentials are available
- **Provider fallback**: Falls back to provider if direct UAA fails and provider is available

#### Dependencies
- **Added axios**: Added `axios@^1.13.2` as dependency for direct UAA HTTP requests
- **Updated interfaces**: Works with `@mcp-abap-adt/interfaces@^0.1.4+`

### Migration Guide

#### Updating Constructor Calls

**Before (v0.1.x)**:
```typescript
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  tokenProvider: new BtpTokenProvider(),
}, 'chrome', logger);
```

**After (v0.2.0) - All dependencies**:
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']), // optional
  tokenProvider: new BtpTokenProvider(), // optional
}, 'chrome', logger);
```

**After (v0.2.0) - Session only (if session has UAA credentials)**:
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  // serviceKeyStore and tokenProvider not needed if session has UAA credentials
});
```

**After (v0.2.0) - Session + Service Key (for initialization)**:
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  // tokenProvider optional - direct UAA requests will be used
});
```

#### Session Requirements

**Important**: SessionStore must contain initial session with `serviceUrl` before calling `getToken()`. If session is empty, provide `serviceKeyStore` to initialize from service key.

#### When to Provide tokenProvider

- **Required**: When initializing session from service key via browser authentication (Step 0)
- **Optional but recommended**: As fallback when direct UAA requests fail
- **Not needed**: When session contains valid UAA credentials (direct UAA requests will be used)

### Dependencies
- Updated to work with `@mcp-abap-adt/connection` v0.2.0+ (which removed token refresh and session storage)
- Updated to work with `@mcp-abap-adt/interfaces` v0.1.4+ (which removed session state methods from `IAbapConnection`)
- Added `axios@^1.13.2` for direct UAA HTTP requests

## [0.1.12] - 2025-12-09

### Added
- **Debugging Environment Variables**: Added comprehensive debugging support via environment variables
  - `DEBUG_AUTH_BROKER` - Enable/disable logging for auth-broker package (default: `false`)
  - `LOG_LEVEL` - Control log verbosity: `debug`, `info`, `warn`, `error` (default: `info`)
  - `DEBUG` - Alternative way to enable debugging (set to `true` or string containing `auth-broker`)
  - Logging is disabled by default to avoid misleading output in tests
  - Tests that expect errors use no-op logger to prevent error message output

### Changed
- **Test Logger Behavior**: Modified `createTestLogger` to require explicit enable via environment variables
  - No longer enabled by default in test environment (`NODE_ENV === 'test'`)
  - Requires `DEBUG_AUTH_BROKER=true` or `DEBUG=true` to enable logging
  - Prevents misleading error output in tests that expect errors
  - Tests that expect errors now use `noOpLogger` to avoid false error messages

### Fixed
- **Service URL Handling**: Fixed `serviceUrl` propagation for ABAP sessions
  - `AuthBroker` now retrieves `serviceUrl` from `serviceKeyStore` if not provided by `tokenProvider`
  - Ensures ABAP session stores receive required `serviceUrl` even when token provider doesn't return it
  - Applied to all authentication flows (refresh token, UAA, browser auth)

## [0.1.11] - 2025-12-07

### Changed
- **Dependency Updates**: Updated dependencies to latest versions
  - `@mcp-abap-adt/interfaces`: `^0.1.1` → `^0.1.3` (includes new header constants and session ID header constants)
  - `@mcp-abap-adt/auth-providers`: `^0.1.2` → `^0.1.3` (includes configurable browser auth port and implementation isolation)
  - `@mcp-abap-adt/auth-stores`: `^0.1.4` → `^0.1.5` (updated to use latest interfaces package)
- **Documentation Updates**: Updated README with examples for `BtpTokenProvider` with custom browser auth port
  - Added example showing how to use `BtpTokenProvider(4001)` to avoid port conflicts
  - Added note about `browserAuthPort` parameter in token provider section

## [0.1.10] - 2025-12-07

### Added
- **Constructor Validation**: Added validation checks in `AuthBroker` constructor to ensure all required dependencies are provided
  - Validates that `stores` parameter is not null/undefined
  - Validates that `serviceKeyStore` is provided
  - Validates that `sessionStore` is provided
  - Validates that `tokenProvider` is provided
  - Throws descriptive error messages if any required dependency is missing
  - Helps catch configuration errors early during development

## [0.1.9] - 2025-12-05

### Changed
- **Dependency Injection for Logger**: Migrated from concrete `Logger` implementation to `ILogger` interface
  - Removed dependency on `@mcp-abap-adt/logger` package
  - Now uses `ILogger` interface from `@mcp-abap-adt/interfaces`
  - Logger parameter in constructor is optional - uses no-op logger if not provided
  - Follows Dependency Inversion Principle - depends on interface, not implementation
- **Bin Script Fixes**: Fixed `generate-env-from-service-key.ts` script
  - Corrected imports from non-existent packages (`@mcp-abap-adt/auth-stores-btp`, `@mcp-abap-adt/auth-stores-xsuaa`) to correct package (`@mcp-abap-adt/auth-stores`)
  - Fixed constructor parameters: changed from array `[directory]` to string `directory` for all store constructors

### Removed
- **Unused Dependencies**: Removed `@mcp-abap-adt/connection` dependency (not used in production code)

## [0.1.8] - 2025-12-04

### Added
- **Interfaces Package Integration**: Migrated to use `@mcp-abap-adt/interfaces` package for all interface definitions
  - All interfaces now imported from shared package
  - Backward compatibility maintained with type aliases
  - Dependency on `@mcp-abap-adt/interfaces@^0.1.0` added
  - Updated `@mcp-abap-adt/connection` dependency to `^0.1.14`

### Changed
- **Interface Renaming**: Interfaces renamed to follow `I` prefix convention:
  - `TokenProviderResult` → `ITokenProviderResult` (type alias for backward compatibility)
  - `TokenProviderOptions` → `ITokenProviderOptions` (type alias for backward compatibility)
  - Old names still work via type aliases for backward compatibility
- **AuthType Export**: `AuthType` now exported from `@mcp-abap-adt/interfaces` instead of local definition

## [0.1.7] - 2025-12-04

### Changed
- **getToken() Fallback Chain** - Improved authentication reliability with multi-step fallback chain
  - **Step 1**: Check if session exists and token is valid (returns immediately if valid)
  - **Step 2**: Verify service key exists (throws error if missing)
  - **Step 3**: Try refresh token authentication (via tokenProvider) if refresh token is available
  - **Step 4**: Try UAA client_credentials authentication (via tokenProvider) if refresh token missing or failed
  - **Step 5**: Try browser authentication (via tokenProvider) if UAA failed or parameters missing
  - **Step 6**: Throw comprehensive error if all methods failed
  - All authentication attempts use `ITokenProvider` interface (no direct implementation imports)
  - Token validation is performed only when checking existing session (step 1)
  - Tokens obtained through refresh/UAA/browser authentication are not validated before being saved
  - Improved error messages with details about which authentication methods failed

## [0.1.6] - 2025-12-04

### Changed
- **Package Split** - Extracted store and provider implementations into separate packages
  - `@mcp-abap-adt/auth-stores-btp` - BTP and ABAP stores
  - `@mcp-abap-adt/auth-stores-xsuaa` - XSUAA stores
  - `@mcp-abap-adt/auth-providers` - XSUAA and BTP token providers
  - `auth-broker` now only contains interfaces and core broker logic
- **ITokenProvider Interface** - Added optional `validateToken` method to token provider interface
  - Token validation is now handled by providers, not by auth-broker
  - Providers can implement custom validation logic
- **Dependencies** - Removed unused dependencies (axios, express, open, dotenv)
  - These are now in provider/store packages
  - `auth-broker` only depends on `@mcp-abap-adt/connection`

### Removed
- Store implementations (moved to `@mcp-abap-adt/auth-stores-btp` and `@mcp-abap-adt/auth-stores-xsuaa`)
- Provider implementations (moved to `@mcp-abap-adt/auth-providers`)
- Token validator utility (moved to providers)
- Authentication functions (moved to providers)

## [0.1.5] - 2025-12-02

### Changed
- **Interface Naming** - All interfaces now start with `I` prefix
  - `AuthorizationConfig` → `IAuthorizationConfig`
  - `ConnectionConfig` → `IConnectionConfig`
  - `ServiceKeyStore` → `IServiceKeyStore`
  - `SessionStore` → `ISessionStore`
- **Type System** - Introduced `IConfig` as optional composition of `IAuthorizationConfig` and `IConnectionConfig`
  - `loadSession()` and `getServiceKey()` now return `IConfig | null`
  - `IConfig` is `Partial<IAuthorizationConfig> & Partial<IConnectionConfig>`
- **Token Provider Architecture** - Extracted token acquisition logic into `ITokenProvider` interface
  - `XsuaaTokenProvider` - Uses client_credentials grant type (no browser)
  - `BtpTokenProvider` - Uses browser-based OAuth2 or refresh token
  - `AuthBroker` now accepts `tokenProvider` in constructor
- **XSUAA Configuration** - Renamed `btp_url` to `mcp_url` in YAML configuration
  - For XSUAA, MCP URL is provided via `mcp_url` in YAML config (not `btp_url`)
  - MCP URL is optional and not part of authentication
- **Constants** - Removed constants from exports (internal implementation details)
  - All file operations are handled by stores through interfaces
  - Consumers should use `IServiceKeyStore` and `ISessionStore` methods
- **File Structure** - Organized source code into logical subfolders
  - `src/auth/` - Authentication logic (browserAuth, clientCredentialsAuth, tokenRefresher, tokenValidator)
  - `src/cache/` - Token caching
  - `src/constants/` - Internal constants
  - `src/loaders/` - Service key loaders (abap, xsuaa)
  - `src/logger/` - Logging utilities
  - `src/methods/` - AuthBroker methods (getToken, refreshToken)
  - `src/parsers/` - Service key parsers
  - `src/pathResolver/` - Path resolution utilities
  - `src/providers/` - Token providers (ITokenProvider, XsuaaTokenProvider, BtpTokenProvider)
  - `src/storage/` - Environment file loaders and token storage (abap, btp, xsuaa)
  - `src/stores/` - Store implementations (abap, btp, xsuaa)
  - `src/types/` - Type definitions
  - `src/utils/` - Utility functions
- **Test Structure** - Organized tests into subfolders by implementation
  - `src/__tests__/broker/` - AuthBroker tests
  - `src/__tests__/stores/abap/`, `src/__tests__/stores/btp/`, `src/__tests__/stores/xsuaa/` - Store tests
  - `src/__tests__/loaders/abap/`, `src/__tests__/loaders/xsuaa/` - Loader tests
  - `src/__tests__/storage/abap/`, `src/__tests__/storage/btp/`, `src/__tests__/storage/xsuaa/` - Storage tests
  - `src/__tests__/parsers/` - Parser tests
  - `src/__tests__/utils/` - Utility tests
  - `src/__tests__/helpers/` - Test helpers (configHelpers, testHelpers, AuthBrokerTestHelper)

### Removed
- **ServiceKey Type** - Removed `ServiceKey` type (internal implementation detail)
- **Internal Types** - Removed internal storage types from exports
  - `EnvConfig`, `XsuaaSessionConfig`, `BtpSessionConfig` are now internal to store implementations
- **Constants Export** - Removed constants from public API
  - `ABAP_AUTHORIZATION_VARS`, `ABAP_CONNECTION_VARS`, etc. are internal
  - `ABAP_HEADERS`, `XSUAA_HEADERS`, `BTP_HEADERS` are internal
- **Parser Exports** - Removed parser interfaces and implementations from exports
  - `IServiceKeyParser`, `AbapServiceKeyParser`, `XsuaaServiceKeyParser` are internal

### Fixed
- **Test Configuration** - Tests now use YAML configuration file (`tests/test-config.yaml`)
  - Removed hardcoded paths and destinations
  - Added `AuthBrokerTestHelper` for creating broker instances from YAML
  - Tests organized into subfolders by implementation (`abap`, `btp`, `xsuaa`)
- **Browser Authentication** - Fixed hanging tests when `browser: 'none'` is specified
  - `startBrowserAuth` now immediately throws error with URL when `browser: 'none'`
  - Added timeout to `clientCredentialsAuth` to prevent hanging
- **Session Store Validation** - Fixed validation in `Safe*SessionStore` classes
  - Now accepts `IConfig` format (with `serviceUrl`/`authorizationToken`) and converts to internal format
  - Validation messages updated to match actual error messages
- **YAML Configuration** - Fixed path resolution for test configuration
  - Uses `findProjectRoot()` to reliably locate `test-config.yaml`
  - Properly expands `~` to home directory in paths
  - Added diagnostic logging controlled by `TEST_VERBOSE` environment variable

### Added
- **BTP Full-Scope Authentication** - Full support for BTP authentication to ABAP systems (with full roles and scopes)
  - `BtpSessionStore` - Store for BTP sessions (uses `BTP_*` environment variables)
  - `SafeBtpSessionStore` - In-memory BTP session store
  - `BtpSessionConfig` - Configuration interface for BTP authentication (includes `abapUrl`)
  - `loadBtpEnvFile()` - Loads BTP session configuration from `.env` files with `BTP_*` variables
  - `saveBtpTokenToEnv()` - Saves BTP session configuration to `.env` files with `BTP_*` variables
- **BTP Environment Variables** - `BTP_ENV_VARS` constants
  - `BTP_ABAP_URL` - ABAP system URL (required, from service key or YAML)
  - `BTP_JWT_TOKEN` - JWT token for `Authorization: Bearer` header
  - `BTP_REFRESH_TOKEN` - Optional refresh token
  - `BTP_UAA_URL`, `BTP_UAA_CLIENT_ID`, `BTP_UAA_CLIENT_SECRET` - UAA credentials (from service key)
- **BTP HTTP Headers** - `BTP_HEADERS` constants
  - `BTP_HEADERS.AUTHORIZATION` - Authorization header
  - `BTP_HEADERS.ABAP_URL` - ABAP URL header (`x-abap-url`)
  - `BTP_HEADERS.BTP_DESTINATION` - BTP destination header (`x-btp-destination`)
  - `BTP_HEADERS.SAP_CLIENT` - SAP client header (`x-sap-client`)
  - `BTP_HEADERS.LANGUAGE` - Language header (`x-sap-language`)
- **Helper Functions** - `isBtpEnvVar()` function to check if environment variable is BTP-related
- **XSUAA Support** - Full support for XSUAA authentication (reduced scope)
  - `XsuaaServiceKeyStore` - Store for XSUAA service keys (direct format from BTP)
  - `XsuaaSessionStore` - Store for XSUAA sessions (uses `XSUAA_*` environment variables)
  - `SafeXsuaaSessionStore` - In-memory XSUAA session store
  - `XsuaaServiceKeyParser` - Parser for direct XSUAA service key format
  - Client credentials grant type for XSUAA (no browser required)
- **Environment Variable Constants** - Exported constants for consumers
  - `ABAP_ENV_VARS` - Environment variable names for ABAP connections (SAP_URL, SAP_JWT_TOKEN, etc.)
  - `XSUAA_ENV_VARS` - Environment variable names for XSUAA connections (XSUAA_MCP_URL, XSUAA_JWT_TOKEN, etc.)
  - `ABAP_HEADERS` - HTTP header names for ABAP requests (x-sap-url, x-sap-jwt-token, etc.)
  - `XSUAA_HEADERS` - HTTP header names for XSUAA requests (Authorization, x-mcp-url, etc.)
  - Helper functions: `getBtpAuthorizationHeader()`, `isAbapEnvVar()`, `isXsuaaEnvVar()`
- **Service Key Parsers** - Modular parser architecture
  - `IServiceKeyParser` - Interface for service key parsers
  - `AbapServiceKeyParser` - Parser for standard ABAP service keys
  - `XsuaaServiceKeyParser` - Parser for direct XSUAA service keys
- **Utility Script** - `generate-env` command
  - Generates `.env` files from service keys
  - Supports both ABAP and XSUAA service key formats
  - Automatically detects service key type and uses appropriate authentication flow
- **XSUAA Environment Loader** - `loadXsuaaEnvFile()` function
  - Loads XSUAA session configuration from `.env` files with `XSUAA_*` variables
- **XSUAA Token Storage** - `saveXsuaaTokenToEnv()` function
  - Saves XSUAA session configuration to `.env` files with `XSUAA_*` variables
  - Automatically removes old `SAP_*` variables when saving XSUAA sessions

### Changed
- **Interface Naming** - All interfaces now start with `I` prefix
  - `AuthorizationConfig` → `IAuthorizationConfig`
  - `ConnectionConfig` → `IConnectionConfig`
  - `ServiceKeyStore` → `IServiceKeyStore`
  - `SessionStore` → `ISessionStore`
- **Type System** - Introduced `IConfig` as optional composition of `IAuthorizationConfig` and `IConnectionConfig`
  - `loadSession()` and `getServiceKey()` now return `IConfig | null`
  - `IConfig` is `Partial<IAuthorizationConfig> & Partial<IConnectionConfig>`
- **Token Provider Architecture** - Extracted token acquisition logic into `ITokenProvider` interface
  - `XsuaaTokenProvider` - Uses client_credentials grant type (no browser)
  - `BtpTokenProvider` - Uses browser-based OAuth2 or refresh token
  - `AuthBroker` now accepts `tokenProvider` in constructor
- **XSUAA Configuration** - Renamed `btp_url` to `mcp_url` in YAML configuration
  - For XSUAA, MCP URL is provided via `mcp_url` in YAML config (not `btp_url`)
  - MCP URL is optional and not part of authentication
- **Constants** - Removed constants from exports (internal implementation details)
  - All file operations are handled by stores through interfaces
  - Consumers should use `IServiceKeyStore` and `ISessionStore` methods
- **File Structure** - Organized source code into logical subfolders
  - `src/auth/` - Authentication logic (browserAuth, clientCredentialsAuth, tokenRefresher, tokenValidator)
  - `src/cache/` - Token caching
  - `src/constants/` - Internal constants
  - `src/loaders/` - Service key loaders (abap, xsuaa)
  - `src/logger/` - Logging utilities
  - `src/methods/` - AuthBroker methods (getToken, refreshToken)
  - `src/parsers/` - Service key parsers
  - `src/pathResolver/` - Path resolution utilities
  - `src/providers/` - Token providers (ITokenProvider, XsuaaTokenProvider, BtpTokenProvider)
  - `src/storage/` - Environment file loaders and token storage (abap, btp, xsuaa)
  - `src/stores/` - Store implementations (abap, btp, xsuaa)
  - `src/types/` - Type definitions
  - `src/utils/` - Utility functions
- **Test Structure** - Organized tests into subfolders by implementation
  - `src/__tests__/broker/` - AuthBroker tests
  - `src/__tests__/stores/abap/`, `src/__tests__/stores/btp/`, `src/__tests__/stores/xsuaa/` - Store tests
  - `src/__tests__/loaders/abap/`, `src/__tests__/loaders/xsuaa/` - Loader tests
  - `src/__tests__/storage/abap/`, `src/__tests__/storage/btp/`, `src/__tests__/storage/xsuaa/` - Storage tests
  - `src/__tests__/parsers/` - Parser tests
  - `src/__tests__/utils/` - Utility tests
  - `src/__tests__/helpers/` - Test helpers (configHelpers, testHelpers, AuthBrokerTestHelper)
- **Renamed XSUAA Components** - Clarified naming for reduced-scope XSUAA authentication
  - `BtpSessionConfig` → `XsuaaSessionConfig` (for reduced-scope XSUAA)
  - `BTP_ENV_VARS` → `XSUAA_ENV_VARS` (for reduced-scope XSUAA)
  - `BTP_HEADERS` → `XSUAA_HEADERS` (for reduced-scope XSUAA)
  - `BtpSessionStore` → `XsuaaSessionStore` (for reduced-scope XSUAA)
  - `SafeBtpSessionStore` → `SafeXsuaaSessionStore` (for reduced-scope XSUAA)
- **XSUAA Session Format** - Uses `XSUAA_*` environment variables instead of `SAP_*`
  - `XSUAA_MCP_URL` - MCP server URL (optional, not part of authentication)
  - `XSUAA_JWT_TOKEN` - JWT token for `Authorization: Bearer` header
  - `XSUAA_REFRESH_TOKEN` - Optional refresh token
  - `XSUAA_UAA_URL`, `XSUAA_UAA_CLIENT_ID`, `XSUAA_UAA_CLIENT_SECRET` - UAA credentials
- **MCP URL Handling** - MCP URL is now optional for XSUAA sessions
  - MCP URL is not part of authentication (only needed for making requests)
  - Can be provided via YAML config (`mcp_url`), parameter, or request header
  - Session files can be created without MCP URL (tokens and UAA credentials are sufficient)
- **Service Key URL Priority** - For XSUAA service keys, `apiurl` is prioritized over `url` for UAA authorization
- **Store Naming** - Renamed stores for clarity
  - `FileServiceKeyStore` → `AbapServiceKeyStore` (for ABAP service keys)
  - `FileSessionStore` → `AbapSessionStore` (for ABAP sessions)
  - `SafeSessionStore` → `SafeAbapSessionStore` (for in-memory ABAP sessions)
  - Old names still available as type aliases for backward compatibility

### Removed
- **ServiceKey Type** - Removed `ServiceKey` type (internal implementation detail)
- **Internal Types** - Removed internal storage types from exports
  - `EnvConfig`, `XsuaaSessionConfig`, `BtpSessionConfig` are now internal to store implementations
- **Constants Export** - Removed constants from public API
  - `ABAP_AUTHORIZATION_VARS`, `ABAP_CONNECTION_VARS`, etc. are internal
  - `ABAP_HEADERS`, `XSUAA_HEADERS`, `BTP_HEADERS` are internal
- **Parser Exports** - Removed parser interfaces and implementations from exports
  - `IServiceKeyParser`, `AbapServiceKeyParser`, `XsuaaServiceKeyParser` are internal

### Fixed
- **XSUAA Authentication** - Fixed client_credentials grant type implementation
  - Uses POST request to UAA token endpoint with `grant_type=client_credentials`
  - No browser interaction required for XSUAA
  - Proper error handling for OAuth2 redirect parameters
- **Test Configuration** - Tests now use YAML configuration file (`tests/test-config.yaml`)
  - Removed hardcoded paths and destinations
  - Added `AuthBrokerTestHelper` for creating broker instances from YAML
  - Tests organized into subfolders by implementation (`abap`, `btp`, `xsuaa`)
- **Browser Authentication** - Fixed hanging tests when `browser: 'none'` is specified
  - `startBrowserAuth` now immediately throws error with URL when `browser: 'none'`
  - Added timeout to `clientCredentialsAuth` to prevent hanging
- **Session Store Validation** - Fixed validation in `Safe*SessionStore` classes
  - Now accepts `IConfig` format (with `serviceUrl`/`authorizationToken`) and converts to internal format
  - Validation messages updated to match actual error messages
- **YAML Configuration** - Fixed path resolution for test configuration
  - Uses `findProjectRoot()` to reliably locate `test-config.yaml`
  - Properly expands `~` to home directory in paths
  - Added diagnostic logging controlled by `TEST_VERBOSE` environment variable

## [0.1.4] - 2025-12-01

### Dependencies
- Updated `@mcp-abap-adt/connection` to `^0.1.13`:
  - **CSRF Token Endpoint Optimization**: Connection layer now uses `/sap/bc/adt/core/discovery` endpoint instead of `/sap/bc/adt/discovery`
    - Lighter response payload (smaller XML response)
    - Available on all SAP systems (on-premise and cloud)
    - Standard ADT discovery endpoint ensures better compatibility
  - **CSRF Configuration Export**: `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES` constants are now exported from connection package
    - Enables consistent CSRF token handling across different connection implementations
    - Provides centralized configuration for retry logic, delays, and error messages
    - See [PR Proposal](https://github.com/fr0ster/mcp-abap-adt/blob/main/packages/connection/PR_PROPOSAL_CSRF_CONFIG.md) for details
  - **Impact**: Authentication broker benefits from optimized CSRF token fetching
    - Faster connection initialization when managing JWT tokens
    - Reduced network traffic during authentication flows
    - Better compatibility across different SAP system versions

## [0.1.3] - 2025-12-01

### Added
- **Configurable Log Levels** - Added log level control via environment variable `AUTH_LOG_LEVEL`
  - `error` - only errors
  - `warn` - errors and warnings
  - `info` - errors, warnings, and info (default)
  - `debug` - all messages
  - Backward compatible: `DEBUG_AUTH_LOG=true` still works (sets level to debug)
  - New `warn()` method in Logger interface for warning messages

### Fixed
- **Error Handling for Consumer** - Improved error handling to ensure consumer can distinguish different error types
  - Service key missing error: throws `Error` with message containing "No authentication found" or "Service key file not found"
  - Browser opening failed error: throws `Error` with message containing "Browser opening failed"
  - Both errors are now properly thrown and can be caught by consumer in `catch` blocks
  - Errors are distinct and can be programmatically handled differently

### Changed
- **Logger Implementation** - Enhanced logger with log level filtering
  - All log methods now respect the configured log level
  - `info()`, `debug()`, `error()`, and new `warn()` methods filter output based on `AUTH_LOG_LEVEL`
  - Default log level is `info` (shows errors, warnings, and info messages)

## [0.1.2] - 2025-11-30

### Added
- **Storage Interfaces** - New interfaces for custom storage implementations
  - `ServiceKeyStore` interface - for reading service keys
  - `SessionStore` interface - for reading/writing session data (tokens, configuration)
  - `FileServiceKeyStore` - default file-based implementation for service keys
  - `FileSessionStore` - default file-based implementation for sessions
- **Dependency Injection Support** - AuthBroker now accepts custom stores via constructor
  - Can provide custom `ServiceKeyStore` and `SessionStore` implementations
  - Default to file-based stores if not provided (backward compatible)
  - Enables custom storage backends (database, cloud, etc.) without creating new packages
  - New API: constructor accepts object with `serviceKeyStore` and `sessionStore` properties
  - Backward compatible: still accepts `searchPaths` as first parameter (string/array)

### Technical Details
- Storage abstraction allows consumers to provide custom implementations
- No breaking changes - existing code continues to work
- File-based stores remain the default implementation

## [0.1.1] - 2025-11-30

### Added
- **AuthBroker.getSapUrl()** - New method to get SAP URL for destination
  - Loads URL from `.env` file first, then from service key
  - Returns `undefined` if URL not found
  - Useful for destination-based authentication where URL comes from destination, not headers

## [0.1.0] - 2025-11-30

### Added
- **AuthBroker class** - Main class for managing JWT authentication tokens
  - `getToken(destination)` - Get token for destination (loads, validates, refreshes if needed)
  - `refreshToken(destination)` - Force refresh token using service key or browser authentication
  - `getSapUrl(destination)` - Get SAP URL for destination (loads from .env or service key)
  - `clearCache(destination)` - Clear cached token for specific destination
  - `clearAllCache()` - Clear all cached tokens
- **Multi-path file search** - Configurable search paths for `.env` and `.json` files
  - Constructor parameter (highest priority)
  - `AUTH_BROKER_PATH` environment variable
  - Current working directory (fallback)
- **Token management**
  - Automatic token validation before use
  - Automatic token refresh when expired
  - In-memory token caching for performance
  - Token expiry information in `.env` file comments
- **Browser-based OAuth2 authentication**
  - Automatic browser opening for initial authentication
  - Configurable browser selection (chrome, edge, firefox, system, none)
  - Manual URL copy option when browser cannot be opened
  - OAuth2 callback server with success page
- **Service key support**
  - Load service keys from `{destination}.json` files
  - Support for multiple service key formats (url, abap.url, sap_url)
  - Extract UAA credentials for token refresh
- **Environment file management**
  - Load tokens from `{destination}.env` files
  - Automatic `.env` file creation after authentication
  - Atomic file writes for safe updates
  - Format compatible with `sap-abap-auth` utility
- **Comprehensive error handling**
  - Clear error messages with file location instructions
  - Searched paths listed in error messages
  - Graceful handling of missing files and invalid configurations
- **TypeScript support**
  - Full TypeScript definitions
  - Type-safe API
  - Exported types: `EnvConfig`, `ServiceKey`
- **Configurable logging system**
  - Injectable logger interface for custom logging implementations
  - Environment variable `DEBUG_AUTH_LOG` to control debug output
  - Minimal logging by default (only errors and manual URLs)
  - Detailed debug logging when `DEBUG_AUTH_LOG=true`
  - Custom logger support via constructor injection
- **Testing infrastructure**
  - Unit tests for all components
  - Integration tests for authentication flows
  - Sequential test execution for reliable results
  - Test scenarios covering error cases, browser auth, and token refresh
  - Silent test output (no verbose logging during test execution)
  - Clean test output focusing on failures
- **Documentation**
  - Complete API documentation
  - Architecture documentation
  - Installation guide
  - Usage guide with examples
  - Testing methodology guide
  - Logging configuration guide

### Changed
- **Logging behavior**
  - Default logger now shows minimal output (only errors and manual URLs)
  - Debug messages only visible when `DEBUG_AUTH_LOG=true`
  - Browser opening notifications moved to debug level
  - Token refresh operations logged at debug level
- **Test output**
  - Removed verbose logging from test files
  - Tests now produce clean, focused output
  - Only test results and errors are displayed
  - Improved readability and CI/CD integration

### Technical Details
- **Dependencies**
  - `@mcp-abap-adt/connection` - Token refresh utilities
  - `axios` - HTTP requests
  - `express` - OAuth callback server
  - `open` - Browser opening utility
- **Node.js version**: >= 18.0.0
- **Module system**: CommonJS
- **Build output**: TypeScript compiled to JavaScript with type definitions
- **Logging**: Injectable logger interface with environment variable control
