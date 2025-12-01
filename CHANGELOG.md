# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the complete list.

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

