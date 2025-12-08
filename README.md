# @mcp-abap-adt/auth-broker

JWT authentication broker for MCP ABAP ADT server. Manages authentication tokens based on destination headers, automatically loading tokens from `.env` files and refreshing them using service keys when needed.

## Features

- 🔐 **Destination-based Authentication**: Load tokens based on `x-mcp-destination` header
- 📁 **Environment File Support**: Automatically loads tokens from `{destination}.env` files
- 🔄 **Automatic Token Refresh**: Refreshes expired tokens using service keys from `{destination}.json` files
- ✅ **Token Validation**: Validates tokens by testing connection to SAP system
- 💾 **Token Caching**: In-memory caching for improved performance
- 🔧 **Configurable Base Path**: Customize where `.env` and `.json` files are stored

## Installation

```bash
npm install @mcp-abap-adt/auth-broker
```

## Usage

```typescript
import { 
  AuthBroker, 
  AbapServiceKeyStore, 
  AbapSessionStore, 
  SafeAbapSessionStore,
  BtpTokenProvider
} from '@mcp-abap-adt/auth-broker';

// Use default file-based stores (current working directory)
const broker = new AuthBroker();

// Use custom file-based stores with specific paths
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  tokenProvider: new BtpTokenProvider(),
}, 'chrome');

// Use safe in-memory session store (data lost after restart)
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeAbapSessionStore(), // In-memory, secure
  tokenProvider: new BtpTokenProvider(),
});

// Use BtpTokenProvider with custom browser auth port (to avoid port conflicts)
const brokerWithCustomPort = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  tokenProvider: new BtpTokenProvider(4001), // Custom port for OAuth callback server
});

// Get token for destination (loads from .env, validates, refreshes if needed)
const token = await broker.getToken('TRIAL');

// Force refresh token using service key
const newToken = await broker.refreshToken('TRIAL');
```

## Configuration

### Environment Variables

- `AUTH_BROKER_PATH` - Colon/semicolon-separated paths for searching `.env` and `.json` files (default: current working directory)
- `DEBUG_AUTH_LOG` - Set to `true` to enable debug logging (default: `false`)

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
- Does not know about concrete implementation classes (e.g., `AbapSessionStore`, `BtpTokenProvider`)
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
- **Delegates to providers**: Calls `tokenProvider.getConnectionConfig()` to obtain tokens and connection configuration
- **Delegates to stores**: Uses `sessionStore.setConnectionConfig()` to save tokens and connection configuration

#### What AuthBroker Does NOT Do

- **Does NOT know about `serviceUrl`**: `AuthBroker` does not know whether a specific `ISessionStore` implementation requires `serviceUrl` or not. It simply passes the `IConnectionConfig` returned by `tokenProvider` to `sessionStore.setConnectionConfig()`
- **Does NOT merge configurations**: `AuthBroker` does not merge `serviceUrl` from service keys with connection config from token providers. This is the responsibility of the consumer or the session store implementation
- **Does NOT implement storage**: File I/O, parsing, and storage logic are handled by concrete store implementations from `@mcp-abap-adt/auth-stores`
- **Does NOT implement token acquisition**: OAuth2 flows, refresh token logic, and client credentials are handled by concrete provider implementations from `@mcp-abap-adt/auth-providers`

### Consumer Responsibilities

The **consumer** (application using `AuthBroker`) is responsible for:

1. **Selecting appropriate implementations**: Choose the correct `IServiceKeyStore`, `ISessionStore`, and `ITokenProvider` implementations based on the use case:
   - **ABAP systems**: Use `AbapServiceKeyStore`, `AbapSessionStore` (or `SafeAbapSessionStore`), and `BtpTokenProvider`
   - **BTP systems**: Use `AbapServiceKeyStore`, `BtpSessionStore` (or `SafeBtpSessionStore`), and `BtpTokenProvider`
   - **XSUAA services**: Use `XsuaaServiceKeyStore`, `XsuaaSessionStore` (or `SafeXsuaaSessionStore`), and `XsuaaTokenProvider`

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
- **Returning connection config**: Returning `IConnectionConfig` with `authorizationToken` and optionally `serviceUrl` (if known)
- **Not returning `serviceUrl` if unknown**: Providers like `BtpTokenProvider` may not return `serviceUrl` because they only handle token acquisition, not connection configuration

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

### Example: Why AuthBroker Doesn't Handle `serviceUrl`

Consider this scenario:
- `BtpTokenProvider.getConnectionConfig()` returns `IConnectionConfig` with `authorizationToken` but **without** `serviceUrl` (because it only handles token acquisition)
- `AbapSessionStore.setConnectionConfig()` requires `sapUrl` (which maps to `serviceUrl`)

If `AuthBroker` tried to merge `serviceUrl` from `serviceKeyStore`, it would:
1. Violate the DIP by knowing about specific store requirements
2. Break the abstraction - `AuthBroker` shouldn't know that `AbapSessionStore` needs `serviceUrl`
3. Create coupling between `AuthBroker` and concrete implementations

Instead, the consumer or `AbapSessionStore` itself should handle this:
- **Option 1**: Consumer retrieves `serviceUrl` from `serviceKeyStore` and ensures it's in the session before calling `AuthBroker.getToken()`
- **Option 2**: `AbapSessionStore.setConnectionConfig()` retrieves `serviceUrl` from `serviceKeyStore` internally if not provided
- **Option 3**: `AbapSessionStore.setConnectionConfig()` uses existing `sapUrl` from current session if available

## API

### `AuthBroker`

#### Constructor

```typescript
new AuthBroker(
  stores?: { 
    serviceKeyStore?: IServiceKeyStore; 
    sessionStore?: ISessionStore;
    tokenProvider?: ITokenProvider;
  }, 
  browser?: string, 
  logger?: ILogger
)
```

- `stores` - Optional object with custom storage implementations:
  - `serviceKeyStore` - Store for service keys (default: `AbapServiceKeyStore()`)
  - `sessionStore` - Store for session data (default: `AbapSessionStore()`)
  - `tokenProvider` - Token provider for token acquisition (default: `BtpTokenProvider()`)
  - Available implementations:
    - **ABAP**: `AbapServiceKeyStore(searchPaths?)`, `AbapSessionStore(searchPaths?)`, `SafeAbapSessionStore()`, `BtpTokenProvider()`
    - **XSUAA** (reduced scope): `XsuaaServiceKeyStore(searchPaths?)`, `XsuaaSessionStore(searchPaths?)`, `SafeXsuaaSessionStore()`, `XsuaaTokenProvider()`
    - **BTP** (full scope for ABAP): `AbapServiceKeyStore(searchPaths?)`, `BtpSessionStore(searchPaths?)`, `SafeBtpSessionStore()`, `BtpTokenProvider()`
- `browser` - Optional browser name for authentication (`chrome`, `edge`, `firefox`, `system`, `none`). Default: `system`
  - For XSUAA, browser is not used (client_credentials grant type) - use `'none'`
- `logger` - Optional logger instance. If not provided, uses default logger

#### Methods

##### `getToken(destination: string): Promise<string>`

Gets authentication token for destination. Tries to load from session store, validates it, and refreshes if needed using a fallback chain:

1. **Check session**: Load token from session store and validate it
2. **Try refresh token**: If refresh token is available, attempt to refresh using it (via tokenProvider)
3. **Try UAA (client_credentials)**: Attempt to get token using UAA credentials (via tokenProvider)
4. **Try browser authentication**: Attempt browser-based OAuth2 flow using service key (via tokenProvider)
5. **Throw error**: If all authentication methods failed

**Note**: Token validation is performed only when checking existing session. Tokens obtained through refresh/UAA/browser authentication are not validated before being saved.

##### `refreshToken(destination: string): Promise<string>`

Force refresh token for destination using service key from `{destination}.json` file.

##### `clearCache(destination: string): void`

Clear cached token for specific destination.

##### `clearAllCache(): void`

Clear all cached tokens.

### Token Providers

The package uses `ITokenProvider` interface for token acquisition. Two implementations are available:

- **`XsuaaTokenProvider`** - For XSUAA authentication (reduced scope)
  - Uses client_credentials grant type
  - No browser interaction required
  - No refresh token provided

- **`BtpTokenProvider`** - For BTP/ABAP authentication (full scope)
  - Constructor accepts optional `browserAuthPort?: number` parameter (default: 3001)
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
  XsuaaTokenProvider,
  BtpTokenProvider
} from '@mcp-abap-adt/auth-broker';

// XSUAA authentication (no browser needed)
const xsuaaBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore(['/path/to/keys']),
  sessionStore: new XsuaaSessionStore(['/path/to/sessions']),
  tokenProvider: new XsuaaTokenProvider(),
}, 'none');

// BTP authentication (browser or refresh token)
const btpBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/keys']),
  sessionStore: new BtpSessionStore(['/path/to/sessions']),
  tokenProvider: new BtpTokenProvider(),
});
```

### Utility Script

Generate `.env` files from service keys:

```bash
npm run generate-env <destination> [service-key-path] [session-path]
```

**Examples:**
```bash
# Generate .env from service key (auto-detect paths)
npm run generate-env mcp

# Specify paths explicitly
npm run generate-env mcp ./mcp.json ./mcp.env

# Use absolute paths
npm run generate-env TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json ~/.config/mcp-abap-adt/sessions/TRIAL.env
```

The script automatically detects service key type (ABAP or XSUAA) and uses the appropriate authentication flow:
- **ABAP**: Opens browser for OAuth2 authorization code flow
- **XSUAA**: Uses client_credentials grant type (no browser required)

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

