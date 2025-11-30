# Architecture

This document describes the architecture and design decisions of the `@mcp-abap-adt/auth-broker` package.

## Overview

The `auth-broker` package provides JWT token management for SAP ABAP ADT systems. It handles token loading, validation, refresh, and browser-based OAuth authentication.

## Core Components

### AuthBroker Class

The main class that orchestrates all authentication operations.

**Location**: `src/AuthBroker.ts`

**Responsibilities**:
- Token retrieval and caching
- Token validation
- Token refresh coordination
- Browser authentication flow
- Environment file management

### Component Modules

#### Path Resolver (`src/pathResolver.ts`)
Resolves search paths for `.env` and `.json` files:
- Handles constructor parameters
- Reads `AUTH_BROKER_PATH` environment variable
- Falls back to current working directory
- Supports multiple paths (colon/semicolon-separated)

#### Environment Loader (`src/envLoader.ts`)
Loads configuration from `{destination}.env` files:
- Parses environment variables
- Extracts JWT token, refresh token, UAA credentials
- Handles optional fields (client, language)

#### Service Key Loader (`src/serviceKeyLoader.ts`)
Loads service key from `{destination}.json` files:
- Validates JSON structure
- Extracts UAA configuration
- Extracts SAP URL (supports multiple formats: `url`, `abap.url`, `sap_url`)

#### Token Validator (`src/tokenValidator.ts`)
Validates JWT tokens by testing connection to SAP system:
- Makes test request to SAP ADT discovery endpoint
- Handles 401/403 errors (distinguishes expired tokens from permission errors)
- Returns boolean validation result

#### Token Refresher (`src/tokenRefresher.ts`)
Refreshes JWT tokens using OAuth2 refresh token flow:
- Uses UAA OAuth endpoint
- Exchanges refresh token for new access token
- Returns new tokens

#### Browser Auth (`src/browserAuth.ts`)
Handles browser-based OAuth2 flow for initial token acquisition:
- Starts local HTTP server for OAuth callback
- Opens browser with authorization URL (configurable: chrome, edge, firefox, system, none)
- If `browser === 'none'`, prints URL to console for manual copy
- Waits for user authentication
- Exchanges authorization code for tokens

#### Cache (`src/cache.ts`)
In-memory token caching:
- Stores tokens per destination
- Provides cache management methods
- Thread-safe (single-threaded Node.js)

## Authentication Flow

### 1. getToken() Flow

```
User calls getToken('TRIAL')
  ↓
Check cache for 'TRIAL'
  ↓ (if cached)
Validate cached token
  ↓ (if valid)
Return cached token
  ↓ (if invalid/expired)
Load from .env file
  ↓ (if exists)
Validate token from .env
  ↓ (if valid)
Cache and return token
  ↓ (if invalid/expired)
Load service key
  ↓ (if exists)
Call refreshToken() → browser auth or refresh
  ↓
Save new token to .env
  ↓
Cache and return token
  ↓ (if no service key)
Throw error with instructions
```

### 2. refreshToken() Flow

```
User calls refreshToken('TRIAL')
  ↓
Load service key
  ↓ (if not found)
Throw error with instructions
  ↓
Load .env file
  ↓
Check for refresh token
  ↓ (if refresh token exists)
Call refreshJwtToken() with refresh token
  ↓ (if no refresh token)
Call startBrowserAuth() → OAuth flow
  ↓
Save tokens to .env file
  ↓
Update cache
  ↓
Return new access token
```

### 3. Browser Authentication Flow

```
startBrowserAuth() called
  ↓
Start local HTTP server (port 3001)
  ↓
Generate OAuth authorization URL
  ↓
Open browser with authorization URL
  ↓
User authenticates in browser
  ↓
Browser redirects to localhost:3001/callback?code=...
  ↓
Exchange authorization code for tokens
  ↓
Close HTTP server
  ↓
Return { accessToken, refreshToken }
```

## File System Structure

### Environment File Format

`{destination}.env` file structure:

```env
# Token Expiry Information (auto-generated)
# JWT Token expires: Monday, December 1, 2025, 10:30:00 AM (UTC)
# JWT Token expires at: 2025-12-01T10:30:00.000Z
# Refresh Token expires: Monday, December 15, 2025, 10:30:00 AM (UTC)
# Refresh Token expires at: 2025-12-15T10:30:00.000Z

SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_LANGUAGE=EN
TLS_REJECT_UNAUTHORIZED=0
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
SAP_REFRESH_TOKEN=refresh_token_string
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=client_id
SAP_UAA_CLIENT_SECRET=client_secret

# For JWT authentication
# SAP_USERNAME=your_username
# SAP_PASSWORD=your_password
```

### Service Key File Format

`{destination}.json` file structure:

```json
{
  "url": "https://your-system.abap.us10.hana.ondemand.com",
  "abap": {
    "url": "https://your-system.abap.us10.hana.ondemand.com",
    "client": "100",
    "language": "EN"
  },
  "uaa": {
    "url": "https://your-account.authentication.us10.hana.ondemand.com",
    "clientid": "your_client_id",
    "clientsecret": "your_client_secret"
  }
}
```

## Search Path Resolution

Files are searched in the following order (priority):

1. **Constructor parameter** (highest priority)
   ```typescript
   new AuthBroker(['/custom/path1', '/custom/path2'])
   ```

2. **AUTH_BROKER_PATH environment variable**
   ```bash
   export AUTH_BROKER_PATH=/path1:/path2
   ```

3. **Current working directory** (lowest priority)
   - Defaults to `process.cwd()`

## Token Caching

Tokens are cached in memory per destination:
- Cache key: destination name (e.g., "TRIAL")
- Cache validation: Tokens are validated before returning from cache
- Cache invalidation: Tokens are removed from cache if validation fails
- Cache management: `clearCache()` and `clearAllCache()` methods

## Error Handling

### Error Types

1. **File Not Found**
   - `.env` file not found
   - Service key file not found
   - Error includes searched paths and instructions

2. **Invalid Configuration**
   - Missing required fields in service key
   - Invalid token format
   - Missing UAA credentials

3. **Authentication Failures**
   - Token validation failed
   - Refresh token expired
   - Browser authentication timeout

### Error Messages

All error messages include:
- Clear description of the problem
- Expected file locations
- Searched paths
- Instructions for resolution

## Design Decisions

### Why File-Based Configuration?

- **Simplicity**: No database or external service required
- **Portability**: Configuration files can be versioned and shared
- **Compatibility**: Works with existing `sap-abap-auth` utility format
- **Security**: Files can be secured with file system permissions

### Why Multi-Path Search?

- **Flexibility**: Supports different deployment scenarios
- **Priority**: Allows overriding default paths
- **Environment-specific**: Different paths for dev/staging/prod

### Why In-Memory Caching?

- **Performance**: Reduces redundant validation calls
- **Simplicity**: No external cache service required
- **Thread Safety**: Node.js single-threaded model ensures safety

### Why Browser Authentication?

- **User Experience**: Familiar OAuth flow
- **Security**: No need to store user credentials
- **Compatibility**: Works with SAP BTP OAuth2 flow

## Dependencies

### Runtime Dependencies

- `@mcp-abap-adt/connection` - Token refresh utilities
- `axios` - HTTP requests for token validation and refresh
- `dotenv` - Environment variable parsing (used internally)
- `express` - OAuth callback server
- `open` - Browser opening utility

### Development Dependencies

- `jest` - Test framework
- `ts-jest` - TypeScript support for Jest
- `typescript` - TypeScript compiler
- `@types/*` - TypeScript type definitions

## Security Considerations

1. **Token Storage**: Tokens are stored in `.env` files - ensure proper file permissions
2. **Service Keys**: Service keys contain sensitive credentials - never commit to version control
3. **HTTPS**: Always use HTTPS for production SAP systems
4. **Token Expiry**: Tokens are automatically refreshed, but monitor expiry times
5. **Browser Auth**: OAuth flow uses localhost callback - ensure no malicious local servers

