# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the complete list.

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

