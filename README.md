# @mcp-abap-adt/auth-broker

JWT authentication broker for MCP ABAP ADT server. Manages authentication tokens based on destination headers, automatically loading tokens from `.env` files and refreshing them using service keys when needed.

## Features

- 🔐 **Destination-based Authentication**: Load tokens based on `x-mcp-destination` header
- 📁 **Environment File Support**: Automatically loads tokens from `{destination}.env` files
- 🔄 **Automatic Token Refresh**: Refreshes expired tokens using service keys from `{destination}.json` files
- ✅ **Token Validation**: Validates tokens via provider (if `validateToken` is implemented)
- 💾 **Token Caching**: In-memory caching for improved performance
- 🔧 **Configurable Base Path**: Customize where `.env` and `.json` files are stored

## Installation

```bash
npm install @mcp-abap-adt/auth-broker
```

## Usage

### Basic Usage (Provider Required)

AuthBroker requires a token provider configured for the destination:

```typescript
import { AuthBroker, AbapSessionStore } from '@mcp-abap-adt/auth-broker';
import { AuthorizationCodeProvider } from '@mcp-abap-adt/auth-providers';

const tokenProvider = new AuthorizationCodeProvider({
  uaaUrl: 'https://...authentication...hana.ondemand.com',
  clientId: '...',
  clientSecret: '...',
  browser: 'system',
});

const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  tokenProvider,
});

const token = await broker.getToken('TRIAL');
```

### Full Configuration (All Dependencies)

For maximum flexibility, provide all three dependencies:

```typescript
import {
  AuthBroker,
  AbapServiceKeyStore,
  AbapSessionStore,
} from '@mcp-abap-adt/auth-broker';
import { AuthorizationCodeProvider } from '@mcp-abap-adt/auth-providers';

const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'), // optional
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://...authentication...hana.ondemand.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
}, 'chrome', logger);

// Disable browser authentication for headless/stdio environments (e.g., MCP with Cline)
const brokerNoBrowser = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://...authentication...hana.ondemand.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'none',
  }),
  allowBrowserAuth: false, // Throws BROWSER_AUTH_REQUIRED if browser auth needed
}, 'chrome', logger);
```

### Session + Service Key (For Initialization)

If you need to initialize sessions from service keys, create the provider from service key auth config:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://...authentication...hana.ondemand.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});
```

### In-Memory Session Store

For testing or temporary sessions:

```typescript
import { AuthBroker, SafeAbapSessionStore } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  sessionStore: new SafeAbapSessionStore(), // In-memory, data lost after restart
});
```

### Custom Browser Auth Port

To avoid port conflicts with browser authentication:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://...authentication...hana.ondemand.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
    redirectPort: 4001,
  }),
}, 'chrome');
```

### Getting Tokens

```typescript
const token = await broker.getToken('TRIAL');

// Force refresh token
const newToken = await broker.refreshToken('TRIAL');
```

### Creating Token Refresher for DI

The `createTokenRefresher()` method creates an `ITokenRefresher` implementation that can be injected into connections. This enables connections to handle token refresh transparently without knowing about authentication internals.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { JwtAbapConnection } from '@mcp-abap-adt/connection';

// Create broker
const broker = new AuthBroker({
  sessionStore: mySessionStore,
  serviceKeyStore: myServiceKeyStore,
  tokenProvider: myTokenProvider,
});

// Create token refresher for specific destination
const tokenRefresher = broker.createTokenRefresher('TRIAL');

// Inject into connection (connection can handle 401/403 automatically)
const connection = new JwtAbapConnection(config, tokenRefresher);

// Token refresher methods:
// - getToken(): Returns cached token if valid, otherwise refreshes
// - refreshToken(): Forces token refresh and saves to session store
```

**Benefits of Token Refresher:**
- 🔄 **Transparent Refresh**: Connection handles 401/403 errors automatically
- 🧩 **Dependency Injection**: Clean separation of concerns
- 💾 **Automatic Persistence**: Tokens saved to session store after refresh
- 🎯 **Destination-Scoped**: Each refresher is bound to specific destination

## Configuration

### Environment Variables

#### Configuration Variables

- `AUTH_BROKER_PATH` - Colon/semicolon-separated paths for searching `.env` and `.json` files (default: current working directory)

#### Debugging Variables

- `DEBUG_BROKER` - Enable debug logging for `auth-broker` package (short name)
  - Set to `true` to enable logging (default: `false`)
  - When enabled, logs authentication steps, token operations, and error details
  - Can be explicitly disabled by setting to `false`
  - Example: `DEBUG_BROKER=true npm test`
  
- `DEBUG_AUTH_BROKER` - Long name (backward compatibility)
  - Same as `DEBUG_BROKER`, but longer name
  - Example: `DEBUG_AUTH_BROKER=true npm test`
  
- `LOG_LEVEL` - Control log verbosity level
  - Values: `debug`, `info`, `warn`, `error` (default: `info`)
  - `debug` - All messages including detailed debug information
  - `info` - Informational messages, warnings, and errors
  - `warn` - Warnings and errors only
  - `error` - Errors only
  - Example: `LOG_LEVEL=debug DEBUG_BROKER=true npm test`

- `DEBUG` - Alternative way to enable debugging
  - Set to `true` to enable all debug logging
  - Or set to a string containing `broker` or `auth-broker` to enable only this package
  - Example: `DEBUG=true npm test` or `DEBUG=broker npm test` or `DEBUG=auth-broker npm test`

**Note**: For debugging related packages:
- `DEBUG_STORES` (short) or `DEBUG_AUTH_STORES` (long) - Enable logging for `@mcp-abap-adt/auth-stores` package
- `DEBUG_PROVIDER` (short) or `DEBUG_AUTH_PROVIDERS` (long) - Enable logging for `@mcp-abap-adt/auth-providers` package

**Legacy Support**: `DEBUG_AUTH_LOG` is still supported for backward compatibility (equivalent to `DEBUG_BROKER=true LOG_LEVEL=debug`)

### Logging Features

When logging is enabled (via `DEBUG_BROKER=true` or `DEBUG_AUTH_BROKER=true`), the broker provides detailed structured logging:

**What is logged:**
- **Broker initialization**: Configuration details, stores, token provider, browser settings
- **Token retrieval**: Session state checks, token presence, refresh token availability
- **Token operations**: Token requests via provider, received tokens with expiration information
- **Token persistence**: Saving tokens to session with formatted token values and expiration dates
- **Error context**: Detailed error information with file paths, error codes, missing fields

**Logging Features:**
- **Token Formatting**: Tokens are logged in truncated format (first 25 and last 25 characters, skipping middle) for security and readability
- **Date Formatting**: Expiration dates are logged in readable format (e.g., "2025-12-25 19:21:27 UTC") instead of raw timestamps
- **Structured Logging**: Uses `DefaultLogger` from `@mcp-abap-adt/logger` for proper formatting with icons and level prefixes
- **Log Levels**: Controlled via `LOG_LEVEL` or `AUTH_LOG_LEVEL` environment variable (error, warn, info, debug)

Example output with `DEBUG_BROKER=true LOG_LEVEL=info`:
```
[INFO] ℹ️ [AUTH-BROKER] Broker initialized: hasServiceKeyStore(true), hasSessionStore(true), hasTokenProvider(true), browser(system), allowBrowserAuth(true)
[INFO] ℹ️ [AUTH-BROKER] Getting token for destination: TRIAL
[INFO] ℹ️ [AUTH-BROKER] Session check for TRIAL: hasToken(true), hasAuthConfig(true), hasServiceUrl(true), serviceUrl(https://...abap...), authorizationToken(eyJ0eXAiOiJKV1QiLCJqaWQiO...Q5ti7aYmEzItIDuLp7axNYo6w), hasRefreshToken(true)
[INFO] ℹ️ [AUTH-BROKER] Requesting tokens for TRIAL via session
[INFO] ℹ️ [AUTH-BROKER] Tokens received for TRIAL: authorizationToken(eyJ0eXAiOiJKV1QiLCJqaWQiO...Q5ti7aYmEzItIDuLp7axNYo6w), hasRefreshToken(true), authType(authorization_code), expiresIn(43199), expiresAt(2025-12-26 20:15:30 UTC)
[INFO] ℹ️ [AUTH-BROKER] Saving tokens to session for TRIAL: serviceUrl(https://...abap...), authorizationToken(eyJ0eXAiOiJKV1QiLCJqaWQiO...Q5ti7aYmEzItIDuLp7axNYo6w), hasRefreshToken(true), expiresAt(2025-12-26 20:15:30 UTC)
[INFO] ℹ️ [AUTH-BROKER] Token retrieved for TRIAL (via session): authorizationToken(eyJ0eXAiOiJKV1QiLCJqaWQiO...Q5ti7aYmEzItIDuLp7axNYo6w)
```

**Note**: Logging only works when a logger is explicitly provided to the broker constructor. The broker will not output anything to console if no logger is passed.

### File Structure

#### Environment File for ABAP (`{destination}.env`)

For ABAP connections, use `SAP_*` environment variables:

```env
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
SAP_REFRESH_TOKEN=refresh_token_string
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=client_id
SAP_UAA_CLIENT_SECRET=client_secret
```

#### Environment File for XSUAA (`{destination}.env`)

For XSUAA connections (reduced scope), use `XSUAA_*` environment variables:

```env
XSUAA_MCP_URL=https://your-mcp-server.cfapps.eu10.hana.ondemand.com
XSUAA_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
XSUAA_REFRESH_TOKEN=refresh_token_string
XSUAA_UAA_URL=https://your-account.authentication.eu10.hana.ondemand.com
XSUAA_UAA_CLIENT_ID=client_id
XSUAA_UAA_CLIENT_SECRET=client_secret
```

**Note**: `XSUAA_MCP_URL` is optional - it's not part of authentication, only needed for making requests. The token and UAA credentials are sufficient for authentication.

#### Environment File for BTP (`{destination}.env`)

For BTP connections (full scope for ABAP systems), use `BTP_*` environment variables:

```env
BTP_ABAP_URL=https://your-system.abap.us10.hana.ondemand.com
BTP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
BTP_REFRESH_TOKEN=refresh_token_string
BTP_UAA_URL=https://your-account.authentication.eu10.hana.ondemand.com
BTP_UAA_CLIENT_ID=client_id
BTP_UAA_CLIENT_SECRET=client_secret
BTP_SAP_CLIENT=100
BTP_LANGUAGE=EN
```

**Note**: `BTP_ABAP_URL` is required - it's the ABAP system URL. All parameters (except tokens) come from service key.

#### Service Key File for ABAP (`{destination}.json`)

Standard ABAP service key format:

```json
{
  "url": "https://your-system.abap.us10.hana.ondemand.com",
  "uaa": {
    "url": "https://your-account.authentication.us10.hana.ondemand.com",
    "clientid": "your_client_id",
    "clientsecret": "your_client_secret"
  }
}
```

#### Service Key File for XSUAA (`{destination}.json`)

Direct XSUAA service key format (from BTP):

```json
{
  "url": "https://your-account.authentication.eu10.hana.ondemand.com",
  "apiurl": "https://api.authentication.eu10.hana.ondemand.com",
  "clientid": "your_client_id",
  "clientsecret": "your_client_secret"
}
```

**Note**: For XSUAA service keys, `apiurl` is prioritized over `url` for UAA authorization if present.

## XSUAA vs BTP Authentication

This package supports two types of BTP authentication:

### XSUAA (Reduced Scope)
- **Purpose**: Access BTP services with limited scopes
- **Service Key**: Contains only UAA credentials (no ABAP URL)
- **Session Store**: `XsuaaSessionStore` (uses `XSUAA_*` environment variables)
- **Authentication**: Client credentials grant type (no browser required)
- **MCP URL**: Optional, provided separately (from YAML config `mcp_url`, parameter, or request header)
- **Use Case**: Accessing BTP services like MCP servers with reduced permissions

### BTP (Full Scope for ABAP)
- **Purpose**: Access ABAP systems with full roles and scopes
- **Service Key**: Contains UAA credentials and ABAP URL
- **Session Store**: `BtpSessionStore` (uses `BTP_*` environment variables)
- **Authentication**: Browser-based OAuth2 (like ABAP) or refresh token
- **ABAP URL**: Required, from service key or YAML configuration
- **Use Case**: Accessing ABAP systems in BTP with full permissions

## Responsibilities and Design Principles

### Core Development Principle

**Interface-Only Communication**: This package follows a fundamental development principle: **all interactions with external dependencies happen ONLY through interfaces**. The code knows **NOTHING beyond what is defined in the interfaces**.

This means:
- Does not know about concrete implementation classes (e.g., `AbapSessionStore`, `AuthorizationCodeProvider`)
- Does not know about internal data structures or methods not defined in interfaces
- Does not make assumptions about implementation behavior beyond interface contracts
- Does not access properties or methods not explicitly defined in interfaces

This principle ensures:
- **Loose coupling**: `AuthBroker` is decoupled from concrete implementations
- **Flexibility**: New implementations can be added without modifying `AuthBroker`
- **Testability**: Easy to mock dependencies for testing
- **Maintainability**: Changes to implementations don't affect `AuthBroker`

### Package Responsibilities

The `@mcp-abap-adt/auth-broker` package defines **interfaces** and provides **orchestration logic** for authentication. It does **not** implement concrete storage or token acquisition mechanisms - these are provided by separate packages (`@mcp-abap-adt/auth-stores`, `@mcp-abap-adt/auth-providers`).

#### What AuthBroker Does

- **Orchestrates authentication flows**: Coordinates token retrieval, validation, and refresh using provided stores and providers
- **Manages token lifecycle**: Handles token caching, validation, and automatic refresh
- **Works with interfaces only**: Uses `IServiceKeyStore`, `ISessionStore`, and `ITokenProvider` interfaces without knowing concrete implementations
- **Delegates to providers**: Calls `tokenProvider.getTokens()` to obtain tokens
- **Delegates to stores**: Saves tokens and connection configuration to `sessionStore`

#### What AuthBroker Does NOT Do

- **Does NOT implement storage**: File I/O, parsing, and storage logic are handled by concrete store implementations from `@mcp-abap-adt/auth-stores`
- **Does NOT implement token acquisition**: OAuth2 flows, refresh token logic, and client credentials are handled by concrete provider implementations from `@mcp-abap-adt/auth-providers`

### Consumer Responsibilities

The **consumer** (application using `AuthBroker`) is responsible for:

1. **Selecting appropriate implementations**: Choose the correct `IServiceKeyStore`, `ISessionStore`, and `ITokenProvider` implementations based on the use case:
   - **ABAP systems**: Use `AbapServiceKeyStore`, `AbapSessionStore` (or `SafeAbapSessionStore`), and `AuthorizationCodeProvider`
   - **BTP systems**: Use `AbapServiceKeyStore`, `BtpSessionStore` (or `SafeBtpSessionStore`), and `AuthorizationCodeProvider`
   - **XSUAA services**: Use `XsuaaServiceKeyStore`, `XsuaaSessionStore` (or `SafeXsuaaSessionStore`), and `ClientCredentialsProvider`

2. **Ensuring complete configuration**: If a session store requires `serviceUrl` (e.g., `AbapSessionStore` requires `sapUrl`), the consumer must ensure that:
   - The session is created with `serviceUrl` before calling `AuthBroker.getToken()`, OR
   - The session store implementation handles `serviceUrl` retrieval internally (e.g., from `serviceKeyStore`)

3. **Understanding store requirements**: Different session store implementations have different requirements:
   - `AbapSessionStore`: Requires `sapUrl` (maps to `serviceUrl` in `IConnectionConfig`)
   - `BtpSessionStore`: Does not require `serviceUrl` (uses `mcpUrl` instead)
   - `XsuaaSessionStore`: Does not require `serviceUrl` (MCP URL is optional)

### Store Responsibilities

Concrete `ISessionStore` implementations are responsible for:

- **Handling their own data format**: Each store knows its internal data format (e.g., `AbapSessionData`, `BtpBaseSessionData`)
- **Converting between formats**: Converting between `IConfig`/`IConnectionConfig` and internal storage format
- **Managing required fields**: If a store requires `serviceUrl` (e.g., `AbapSessionStore`), it should:
  - Retrieve it from `serviceKeyStore` if not provided in `IConnectionConfig`, OR
  - Use existing value from current session if available, OR
  - Throw an error if neither is available (depending on implementation)

### Provider Responsibilities

Concrete `ITokenProvider` implementations are responsible for:

- **Obtaining tokens**: Using OAuth2 flows, refresh tokens, or client credentials to obtain JWT tokens
- **Managing token lifecycle**: Caching, validating, refreshing, and re-authenticating as needed

### Design Principles

1. **Interface-Only Communication** (Core Principle): All interactions with external dependencies happen **ONLY through interfaces**. The code knows **NOTHING beyond what is defined in the interfaces** (see [Core Development Principle](#core-development-principle) above)
2. **Dependency Inversion Principle (DIP)**: `AuthBroker` depends on abstractions (`IServiceKeyStore`, `ISessionStore`, `ITokenProvider`), not concrete implementations
3. **Single Responsibility**: Each component has a single, well-defined responsibility:
   - `AuthBroker`: Orchestration and token lifecycle management
   - `ISessionStore`: Session data storage and retrieval
   - `ITokenProvider`: Token acquisition
   - `IServiceKeyStore`: Service key storage and retrieval
4. **Interface Segregation**: Interfaces are focused and minimal, containing only what's necessary for their specific purpose
5. **Open/Closed Principle**: New store and provider implementations can be added without modifying `AuthBroker`

## API

### `AuthBroker`

#### Constructor

```typescript
new AuthBroker(
  config: {
    sessionStore: ISessionStore;        // required
    serviceKeyStore?: IServiceKeyStore; // optional
    tokenProvider: ITokenProvider;      // required
    allowBrowserAuth?: boolean;         // optional
  }, 
  browser?: string, 
  logger?: ILogger
)
```

**Parameters:**
- `config` - Configuration object:
  - `sessionStore` - **Required** - Store for session data. Must contain initial session with `serviceUrl`
  - `serviceKeyStore` - **Optional** - Store for service keys. Only needed for initializing sessions from service keys
  - `tokenProvider` - **Required** - Token provider for token acquisition and refresh
  - `allowBrowserAuth` - **Optional** - When `false`, throws `BROWSER_AUTH_REQUIRED` instead of launching browser auth
- `browser` - Optional browser name for authentication (`chrome`, `edge`, `firefox`, `system`, `headless`, `none`). Default: `system`
  - Use `'headless'` for SSH/remote sessions - logs URL and waits for manual callback
  - Use `'none'` for automated tests - logs URL and rejects immediately
  - For XSUAA, browser is not used (client_credentials grant type) - use `'none'`
- `logger` - Optional logger instance. If not provided, uses no-op logger

**When to Provide Each Dependency:**

- **`sessionStore` (required)**: Always required. Must contain initial session with `serviceUrl`
- **`serviceKeyStore` (optional)**: 
  - Required if you need to initialize sessions from service keys (Step 0)
  - Not needed if session already contains authorization config and tokens
- **`tokenProvider` (required)**:
  - Used for all token acquisition and refresh flows
  - Must be configured with the destination's auth parameters (e.g., UAA credentials)

**Available Implementations:**
- **ABAP**: `AbapServiceKeyStore(directory, defaultServiceUrl?, logger?)`, `AbapSessionStore(directory, defaultServiceUrl?, logger?)`, `SafeAbapSessionStore(defaultServiceUrl?, logger?)`, `AuthorizationCodeProvider(...)`
- **XSUAA** (reduced scope): `XsuaaServiceKeyStore(directory, logger?)`, `XsuaaSessionStore(directory, defaultServiceUrl, logger?)`, `SafeXsuaaSessionStore(defaultServiceUrl, logger?)`, `ClientCredentialsProvider(...)`
- **BTP** (full scope for ABAP): `AbapServiceKeyStore(directory, defaultServiceUrl?, logger?)`, `BtpSessionStore(directory, defaultServiceUrl, logger?)`, `SafeBtpSessionStore(defaultServiceUrl, logger?)`, `AuthorizationCodeProvider(...)`

#### Methods

##### `getToken(destination: string): Promise<string>`

Gets authentication token for destination. Implements a three-step flow:

**Step 0: Initialize Session with Token (if needed)**
- Checks if session has `authorizationToken` and authorization config
- If both are missing and `serviceKeyStore` is available:
  - Loads authorization config from service key
  - Uses `tokenProvider.getTokens()` to obtain tokens
  - Persists tokens to session
- Otherwise → proceeds to Step 1

**Step 1: Token Refresh / Re-Auth**
- If session has authorization config:
  - Uses `tokenProvider.getTokens()` to refresh or re-authenticate
  - Persists tokens to session
  - Returns new token
- If that fails (or no session auth config) and `serviceKeyStore` is available:
  - Loads authorization config from service key
  - Uses `tokenProvider.getTokens()` to obtain tokens
  - Persists tokens to session
- If all failed → throws error

**Important Notes:**
- All authentication is handled by the injected provider (authorization_code or client_credentials).
- `tokenProvider` is required for all token acquisition and refresh flows.
- **Broker always calls `provider.getTokens()`** - provider handles token lifecycle internally (validation, refresh, login). Consumer doesn't need to know about token issues.
- Provider decides whether to return cached token, refresh, or perform login based on token state.
- **Store errors are handled gracefully**: If service key files are missing or malformed, the broker logs the error and continues with fallback mechanisms (session store data or provider-based auth)

##### Error Handling

The broker implements comprehensive error handling for all external operations, treating all injected dependencies as untrusted:

```typescript
import { STORE_ERROR_CODES } from '@mcp-abap-adt/interfaces';

try {
  const token = await broker.getToken('TRIAL');
} catch (error: any) {
  // Broker handles errors internally where possible, but critical errors propagate
  console.error('Failed to get token:', error.message);
}
```

**Error Categories** (handled by broker with graceful degradation):

**1. SessionStore Errors** (reading session files):
- `STORE_ERROR_CODES.FILE_NOT_FOUND` - Session file missing (logged, tries serviceKeyStore fallback)
- `STORE_ERROR_CODES.PARSE_ERROR` - Corrupted session file (logged with file path, tries fallback)
- Write failures when saving tokens (logged and thrown - critical)

**2. ServiceKeyStore Errors** (reading service key files):
- `STORE_ERROR_CODES.FILE_NOT_FOUND` - Service key file missing (logged, continues with session data)
- `STORE_ERROR_CODES.PARSE_ERROR` - Invalid JSON in service key (logged with file path and cause)
- `STORE_ERROR_CODES.INVALID_CONFIG` - Missing required fields (logged with missing field names)
- `STORE_ERROR_CODES.STORAGE_ERROR` - Permission/write errors (logged)

**3. TokenProvider Errors** (network operations):
- Network errors: `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` (logged, throws with descriptive message)
- `VALIDATION_ERROR` - Missing required auth fields (logged with field names, throws)
- `BROWSER_AUTH_ERROR` - Browser authentication failed or cancelled (logged, throws)
- `REFRESH_ERROR` - Token refresh failed at UAA server (logged, throws)

**4. Browser Auth Disabled Errors** (when `allowBrowserAuth: false`):
- `BROWSER_AUTH_REQUIRED` - Browser authentication is required but disabled. Thrown when:
  - **Step 0**: No token and no UAA credentials in session, service key exists but browser auth needed
  - **Step 2b**: Refresh token expired/invalid and browser auth needed for new token
  - Error includes `destination` property for context
  - Use case: Non-interactive environments (MCP stdio, Cline) where browser cannot open

**Defensive Design Principles:**
- **All external operations wrapped in try-catch**: Files may be missing/corrupted, network may fail
- **Graceful degradation**: Store errors trigger fallback mechanisms (serviceKey → session → provider)
- **Detailed error context**: Logs include file paths, error codes, missing fields for debugging
- **Fail-fast for critical errors**: Write failures and provider errors throw immediately (cannot recover)
- **No assumptions about injected dependencies**: All stores/providers treated as potentially unreliable

Example error scenarios handled:
- Session file deleted mid-operation → uses service key
- Service key has invalid JSON → logs parse error, uses session data
- Network timeout during token refresh → logs timeout, throws descriptive error
- File permission denied → logs error with file path, throws

##### `refreshToken(destination: string): Promise<string>`

Force refresh token for destination. Calls `getToken()` to run the full refresh flow and persist updated tokens.

##### `clearCache(destination: string): void`

Clear cached token for specific destination.

##### `clearAllCache(): void`

Clear all cached tokens.

### Token Providers

The package uses the `ITokenProvider` interface for token acquisition. Provider implementations live in `@mcp-abap-adt/auth-providers`:

- **`ClientCredentialsProvider`** - For XSUAA authentication (reduced scope)
  - Uses client_credentials grant type
  - No browser interaction required
  - No refresh token provided

- **`AuthorizationCodeProvider`** - For BTP/ABAP authentication (full scope)
  - Constructor accepts optional `browserAuthPort?: number` parameter (default: 3001)
  - Automatically finds an available port if the requested port is in use (prevents `EADDRINUSE` errors)
  - Server properly closes all connections and frees the port after authentication completes
  - Use custom port to avoid conflicts when running alongside other services (e.g., proxy server)
  - Uses browser-based OAuth2 flow (if no refresh token)
  - Uses refresh token if available
  - Provides refresh token for future use

**Example Usage:**

```typescript
import {
  AuthBroker,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
  AbapServiceKeyStore,
  BtpSessionStore
} from '@mcp-abap-adt/auth-broker';
import {
  ClientCredentialsProvider,
  AuthorizationCodeProvider,
} from '@mcp-abap-adt/auth-providers';

// XSUAA authentication
const xsuaaBroker = new AuthBroker({
  sessionStore: new XsuaaSessionStore('/path/to/sessions', 'https://mcp.example.com'),
  tokenProvider: new ClientCredentialsProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
  }),
});

// XSUAA authentication - with service key initialization
const xsuaaBrokerWithServiceKey = new AuthBroker({
  sessionStore: new XsuaaSessionStore('/path/to/sessions', 'https://mcp.example.com'),
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys'),
  tokenProvider: new ClientCredentialsProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
  }),
}, 'none');

// BTP authentication
const btpBroker = new AuthBroker({
  sessionStore: new BtpSessionStore('/path/to/sessions', 'https://abap.example.com'),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});

// BTP authentication - with service key and provider (for browser auth)
const btpBrokerFull = new AuthBroker({
  sessionStore: new BtpSessionStore('/path/to/sessions', 'https://abap.example.com'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/keys'),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});
```

### CLI: mcp-auth

Generate or refresh `.env`/JSON output using AuthBroker + stores:

```bash
mcp-auth <auth-code|oidc|saml2-pure|saml2-bearer> [options]
mcp-auth --service-key <path> --output <path> [--env <path>] [--type abap|xsuaa] [--credential] [--browser auto|none|system|chrome|edge|firefox] [--format json|env]
```

**Note**: The published CLI is compiled to `dist/bin` and does not require `tsx` at runtime. For repo usage, run `npm install` and `npm run build`.

**Authentication Flow:**
- Default: `authorization_code` (browser-based OAuth2)
- `--credential`: `client_credentials` (clientId/clientSecret, no browser)

**Browser Options (for authorization_code):**
- `auto` (default): Try to open browser, fallback to showing URL
- `none`: Show URL in console and wait for callback (no browser)
- `system/chrome/edge/firefox`: Open specific browser

**Examples:**
```bash
# Auth code (default via service key)
mcp-auth auth-code --service-key ./abap.json --output ./abap.env --type abap

# OIDC SSO (device flow example)
mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# SAML2 pure (cookie)
mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --output ./saml.env --type abap

# SAML2 bearer (in progress, requires --dev)
mcp-auth saml2-bearer --dev --service-key ./mcp.json --assertion <base64> --output ./sso.env --type xsuaa

# ABAP: authorization_code (default, opens browser)
mcp-auth --service-key ./abap.json --output ./abap.env --type abap

# ABAP: authorization_code (show URL in console, no browser)
mcp-auth --service-key ./abap.json --output ./abap.env --type abap --browser none

# XSUAA: authorization_code (default)
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa

# XSUAA: client_credentials (special cases)
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --credential

# Using existing .env for refresh token
mcp-auth --env ./mcp.env --service-key ./mcp.json --output ./mcp.env --type xsuaa
```

### CLI: mcp-sso

Get tokens via SSO providers (OIDC/SAML) and generate `.env`/JSON output:

```bash
mcp-sso <oidc|saml2|bearer> [options]
mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [--type abap|xsuaa] [--format env|json] [--env <path>] [--config <path>]
```

**Supported flows:**
- OIDC: `browser`, `device`, `password`, `token_exchange`
- SAML2: `bearer`, `pure`

**Examples:**
```bash
# OIDC browser flow
mcp-sso oidc --flow browser --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# OIDC browser flow (manual code / OOB)
mcp-sso oidc --flow browser --token-endpoint https://issuer/token --client-id my-client --code <auth_code> --redirect-uri urn:ietf:wg:oauth:2.0:oob --output ./sso.env --type xsuaa

# OIDC device flow
mcp-sso oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# OIDC password flow
mcp-sso oidc --flow password --token-endpoint https://issuer/oauth/token --client-id my-client --username user --password pass --output ./sso.env --type xsuaa

# OIDC token exchange
mcp-sso oidc --flow token_exchange --issuer https://issuer --client-id my-client --subject-token <token> --output ./sso.env --type xsuaa

# SAML bearer flow (assertion -> token)
mcp-sso bearer --idp-sso-url https://idp/sso --sp-entity-id my-sp --token-endpoint https://uaa.example/oauth/token --assertion <base64> --output ./sso.env --type xsuaa

# SAML pure flow (cookie)
mcp-sso saml2 --flow pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --assertion <base64> --cookie "SAP_SESSION=..." --output ./sso.env --type abap
```

**SAML token alias (XSUAA):**
If your IdP requires the token alias endpoint, pass SAML metadata XML:

```bash
mcp-sso bearer --saml-metadata ./saml-sp.xml --assertion <base64> --service-key ./service-key.json --output ./sso.env --type xsuaa
```

### Local Keycloak (OIDC + SAML Tests)

For local testing of `mcp-sso`, a ready-to-run Keycloak setup is included
(OIDC browser/password/device + SAML assertion capture).

```bash
cd tests/keycloak
docker compose up -d
```

Then use:
```bash
node dist/bin/mcp-sso.js \
  oidc \
  --flow browser \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa
```

See `tests/keycloak/README.md` for device flow and SAML examples.

### XSUAA Demo (CAP)

A minimal CAP app for testing XSUAA flows is included at `tests/sso-demo`.
It enables `authorization_code` and `saml2-bearer` grant types and provides a
simple `CatalogService`. See `tests/sso-demo/readme.md` for deploy steps.

**Config file:**
You can pass a JSON file with provider config:

```json
{
  "protocol": "oidc",
  "flow": "device",
  "issuerUrl": "https://issuer",
  "clientId": "my-client",
  "scopes": ["openid", "profile"]
}
```

### Utility Script

Generate `.env` files from service keys:

```bash
npm run generate-env <destination> [service-key-path] [session-path]
```

## Testing

Tests are located in `src/__tests__/` and use Jest as the test runner.

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file (all tests in that file)
npm test -- getToken.test.ts
npm test -- refreshToken.test.ts

# Run specific test by name/pattern
npm test -- getToken.test.ts -t "Test 1"
npm test -- getToken.test.ts -t "Test 2"
npm test -- getToken.test.ts -t "Test 3"

# Run test group (e.g., all getToken tests)
npm test -- getToken.test.ts

# Note: Test 2 requires Test 1 to pass first (test1Passed flag)
# To run Test 2 alone, you may need to run all tests in the file:
npm test -- getToken.test.ts
```

### Test Structure

Tests are designed to run sequentially (guaranteed by `maxWorkers: 1` and `maxConcurrency: 1` in `jest.config.js`):

1. **Test 1**: Verifies error handling for non-existent destination (`NO_EXISTS`)
   - Requires: `NO_EXISTS.json` should NOT exist
   
2. **Test 2**: Tests browser authentication when service key exists but `.env` file doesn't
   - Requires: `TRIAL.json` must exist, `TRIAL.env` should NOT exist
   - Will open browser for OAuth authentication
   
3. **Test 3**: Tests token refresh using existing `.env` file
   - Requires: `TRIAL.json` and `TRIAL.env` must exist
   - Can run independently if `.env` file exists (created manually or by Test 2)

### Test Setup

1. Copy `tests/test-config.yaml.template` to `tests/test-config.yaml`
2. Fill in configuration values (paths, destinations, MCP URL for XSUAA)
3. Place service key files in configured `service_keys_dir`:
   - `{destination}.json` for ABAP tests (e.g., `trial.json`)
   - `{btp_destination}.json` for XSUAA tests (e.g., `btp.json`)

Tests will automatically skip if required files are missing or configuration contains placeholders.

## Documentation

Complete documentation is available in the [`docs/`](docs/) directory:

- **[Architecture](docs/architecture/ARCHITECTURE.md)** - System architecture and design decisions
- **[Development](docs/development/)** - Testing methodology and development roadmap
- **[Development Roadmap](docs/development/DEVELOPMENT_ROADMAP.md)** - Development roadmap and future plans
- **[Installation](docs/installing/INSTALLATION.md)** - Installation and setup guide
- **[Usage](docs/using/USAGE.md)** - API reference and usage examples

See [docs/README.md](docs/README.md) for the complete documentation index.

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](CONTRIBUTORS.md) for the complete list.

## License

MIT
