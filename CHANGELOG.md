# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the complete list.

## [Unreleased]

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

