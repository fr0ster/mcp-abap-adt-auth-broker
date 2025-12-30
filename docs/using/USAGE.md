# Usage Guide

This guide provides API documentation and usage examples for the `@mcp-abap-adt/auth-broker` package.

## Basic Usage

### Import the Package

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
```

### Create AuthBroker Instance

```typescript
import {
  AuthBroker,
  AbapServiceKeyStore,
  AbapSessionStore,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
  BtpSessionStore,
  SafeAbapSessionStore,
  SafeXsuaaSessionStore,
  SafeBtpSessionStore,
} from '@mcp-abap-adt/auth-broker';
import {
  AuthorizationCodeProvider,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';

// ABAP authentication (authorization_code)
const abapBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});

// XSUAA authentication (client_credentials)
const xsuaaBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore(['/path/to/destinations']),
  sessionStore: new XsuaaSessionStore(['/path/to/destinations']),
  tokenProvider: new ClientCredentialsProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
  }),
}, 'none');

// BTP authentication (authorization_code)
const btpBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']), // BTP uses same service key format as ABAP
  sessionStore: new BtpSessionStore(['/path/to/destinations']),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});

// Safe in-memory session stores (data lost after restart, secure)
const abapMemoryBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeAbapSessionStore(), // In-memory, no disk persistence
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});

const xsuaaMemoryBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeXsuaaSessionStore(), // In-memory, no disk persistence
  tokenProvider: new ClientCredentialsProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
  }),
}, 'none');

const btpMemoryBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeBtpSessionStore(), // In-memory, no disk persistence
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});
```

## Store Methods

Stores provide methods to access configuration values through standardized interfaces:

```typescript
import { XsuaaSessionStore } from '@mcp-abap-adt/auth-broker';

const store = new XsuaaSessionStore(['/path/to/sessions']);

// Get authorization config (for token refresh)
const authConfig = await store.getAuthorizationConfig('mcp');
if (authConfig) {
  // authConfig.uaaUrl, authConfig.uaaClientId, authConfig.uaaClientSecret
  // authConfig.refreshToken (optional)
}

// Get connection config (for making requests)
const connConfig = await store.getConnectionConfig('mcp');
if (connConfig) {
  // connConfig.authorizationToken
  // connConfig.serviceUrl (may be undefined for XSUAA)
  // connConfig.sapClient, connConfig.language (for ABAP/BTP)
}

// Load complete config (may contain both authorization and connection)
const config = await store.loadSession('mcp');
if (config) {
  // Check for specific fields
  if (config.uaaUrl) {
    // Authorization config present
  }
  if (config.authorizationToken) {
    // Connection config present
  }
}
```

### Environment Variables

Stores use the following environment variables internally (not exported as constants):

**ABAP Environment Variables** (used by `AbapSessionStore`):
- `SAP_URL` - SAP system URL
- `SAP_JWT_TOKEN` - JWT token for authorization
- `SAP_REFRESH_TOKEN` - Refresh token for token renewal
- `SAP_UAA_URL` - UAA URL for token refresh
- `SAP_UAA_CLIENT_ID` - UAA client ID
- `SAP_UAA_CLIENT_SECRET` - UAA client secret
- `SAP_CLIENT` - SAP client number
- `SAP_LANGUAGE` - Language

**XSUAA Environment Variables** (used by `XsuaaSessionStore`):
- `XSUAA_MCP_URL` - MCP server URL (optional, not part of authentication)
- `XSUAA_JWT_TOKEN` - JWT token for `Authorization: Bearer` header
- `XSUAA_REFRESH_TOKEN` - Refresh token for token renewal
- `XSUAA_UAA_URL` - UAA URL for token refresh
- `XSUAA_UAA_CLIENT_ID` - UAA client ID
- `XSUAA_UAA_CLIENT_SECRET` - UAA client secret

**BTP Environment Variables** (used by `BtpSessionStore`):
- `BTP_ABAP_URL` - ABAP system URL (required, from service key or YAML)
- `BTP_JWT_TOKEN` - JWT token for `Authorization: Bearer` header
- `BTP_REFRESH_TOKEN` - Refresh token for token renewal
- `BTP_UAA_URL` - UAA URL for token refresh
- `BTP_UAA_CLIENT_ID` - UAA client ID
- `BTP_UAA_CLIENT_SECRET` - UAA client secret
- `BTP_SAP_CLIENT` - SAP client number (optional)
- `BTP_LANGUAGE` - Language (optional)

**Note**: Constants are internal implementation details and are not exported. Consumers should use store methods (`getAuthorizationConfig()`, `getConnectionConfig()`) to access configuration values.

## CLI: mcp-auth

Use `mcp-auth` to generate or refresh `.env`/JSON output using AuthBroker + stores.

```bash
mcp-auth --service-key <path> --output <path> [--env <path>] [--type abap|xsuaa] [--credential] [--browser auto|none|system|chrome|edge|firefox] [--format json|env]
```

**Authentication Flow:**
- Default: `authorization_code` (browser-based OAuth2)
- `--credential`: `client_credentials` (clientId/clientSecret, no browser)

**Browser Options (for authorization_code):**
- `auto` (default): Try to open browser, fallback to showing URL
- `none`: Show URL in console and wait for callback (no browser)
- `system/chrome/edge/firefox`: Open specific browser

**Behavior:**
- If `--env` is provided and exists, refresh token is attempted first.
- If refresh fails (or env is missing), service key auth is used.

**Examples:**
```bash
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

## API Reference

### AuthBroker Class

#### Constructor

```typescript
constructor(
  config: {
    sessionStore: ISessionStore;
    serviceKeyStore?: IServiceKeyStore;
    tokenProvider: ITokenProvider;
    allowBrowserAuth?: boolean;
  },
  browser?: string,
  logger?: ILogger
)
```

**Parameters**:
- `config`: Object with required stores and provider:
  - `sessionStore` - Store for session data
  - `serviceKeyStore` - Optional store for service keys
  - `tokenProvider` - Token provider for token acquisition and refresh
  - `allowBrowserAuth` - When `false`, throws `BROWSER_AUTH_REQUIRED` instead of launching browser auth
  - Available store implementations:
    - `AbapServiceKeyStore(searchPaths?)`, `AbapSessionStore(searchPaths?)`, `SafeAbapSessionStore()`
    - `XsuaaServiceKeyStore(searchPaths?)`, `XsuaaSessionStore(searchPaths?)`, `SafeXsuaaSessionStore()`
    - `BtpSessionStore(searchPaths?)`, `SafeBtpSessionStore()`
  - Provider implementations (from `@mcp-abap-adt/auth-providers`):
    - `AuthorizationCodeProvider(...)` - browser-based OAuth2 (ABAP/BTP)
    - `ClientCredentialsProvider(...)` - client_credentials (XSUAA)
- `browser` (optional): Browser name for authentication. Options:
  - `'chrome'` - Open in Google Chrome
  - `'edge'` - Open in Microsoft Edge
  - `'firefox'` - Open in Mozilla Firefox
  - `'system'` - Use system default browser (default)
  - `'headless'` - Don't open browser, print URL and wait for manual callback (SSH/remote)
  - `'none'` - Don't open browser, print URL and reject immediately (automated tests)
- `logger` (optional): Custom logger instance. If not provided, uses default logger

**Example**:
```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore, SafeAbapSessionStore } from '@mcp-abap-adt/auth-broker';
import { AuthorizationCodeProvider } from '@mcp-abap-adt/auth-providers';

// ABAP with browser-based authorization_code
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/custom/path']),
  sessionStore: new AbapSessionStore(['/custom/path']),
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'system',
  }),
});

// Safe in-memory session store for ABAP (secure, no disk persistence)
const memoryBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path1']),
  sessionStore: new SafeAbapSessionStore(), // Data lost after restart
  tokenProvider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    browser: 'none',
  }),
}, 'none');
```

#### getToken()

Get authentication token for destination. Tries to load from session store, validates it, and refreshes if needed using a fallback chain.

```typescript
async getToken(destination: string): Promise<string>
```

**Parameters**:
- `destination`: Destination name (e.g., "TRIAL")

**Returns**: Promise that resolves to JWT token string

**Throws**: Error if neither session data nor service key found, or if all authentication methods failed

**Example**:
```typescript
try {
  const token = await broker.getToken('TRIAL');
  console.log('Token:', token);
} catch (error) {
  console.error('Failed to get token:', error.message);
}
```

**Flow**:
1. **Step 0 - Initialize**: If session has no token and no auth config, load auth config from service key and call `tokenProvider.getTokens()`
2. **Step 1 - Refresh/Re-auth**: Broker always calls `tokenProvider.getTokens()`. Provider handles token lifecycle internally (validation, refresh, login). If session auth config exists, use it; on failure, fall back to service key auth config
3. **Error**: If all attempts fail, throw an error (or `BROWSER_AUTH_REQUIRED` when browser auth is disabled)

**Important**: Broker always calls `provider.getTokens()` - provider decides whether to return cached token, refresh, or perform login. Consumer doesn't need to know about token issues.

#### refreshToken()

Force refresh token for destination. Calls `getToken()` to run the full refresh flow and persist updated tokens.

```typescript
async refreshToken(destination: string): Promise<string>
```

**Parameters**:
- `destination`: Destination name (e.g., "TRIAL")

**Returns**: Promise that resolves to new JWT token string

**Throws**: Error if service key not found

**Example**:
```typescript
try {
  const newToken = await broker.refreshToken('TRIAL');
  console.log('New token:', newToken);
} catch (error) {
  console.error('Failed to refresh token:', error.message);
}
```

**Flow**:
1. Delegates to `getToken(destination)`

#### clearCache()

Clear cached token for specific destination.

```typescript
clearCache(destination: string): void
```

**Parameters**:
- `destination`: Destination name

**Example**:
```typescript
broker.clearCache('TRIAL');
```

#### clearAllCache()

Clear all cached tokens.

```typescript
clearAllCache(): void
```

**Example**:
```typescript
broker.clearAllCache();
```

## Usage Examples

### Example 1: Basic Token Retrieval

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker();

async function getToken() {
  try {
    const token = await broker.getToken('TRIAL');
    console.log('Token obtained:', token.substring(0, 20) + '...');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getToken();
```

### Example 2: Custom Search Paths

```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

// Search in multiple directories
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore([
    '/home/user/.sap/destinations',
    '/etc/sap/destinations',
    process.cwd()
  ]),
  sessionStore: new AbapSessionStore([
    '/home/user/.sap/destinations',
    '/etc/sap/destinations',
    process.cwd()
  ]),
});

const token = await broker.getToken('PRODUCTION');
```

### Example 3: Force Token Refresh

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker();

async function refreshToken() {
  try {
    // Force refresh (will use browser auth if no refresh token)
    const newToken = await broker.refreshToken('TRIAL');
    console.log('Token refreshed:', newToken.substring(0, 20) + '...');
  } catch (error) {
    console.error('Refresh failed:', error.message);
  }
}

refreshToken();
```

### Example 4: Error Handling

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker();

async function handleTokenRequest() {
  try {
    const token = await broker.getToken('MISSING');
  } catch (error) {
    if (error.message.includes('No authentication found')) {
      console.error('Please create MISSING.env or MISSING.json file');
      console.error('Searched in:', error.message);
    } else if (error.message.includes('Service key file not found')) {
      console.error('Please create MISSING.json service key file');
    } else {
      console.error('Unexpected error:', error);
    }
  }
}

handleTokenRequest();
```

### Example 5: Cache Management

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker();

// Get token (will be cached)
const token1 = await broker.getToken('TRIAL');

// Get again (will use cache if valid)
const token2 = await broker.getToken('TRIAL');

// Clear cache for this destination
broker.clearCache('TRIAL');

// Next call will validate again
const token3 = await broker.getToken('TRIAL');

// Clear all caches
broker.clearAllCache();
```

## Integration Examples

### Example: Integration with MCP Server

```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(),
  sessionStore: new AbapSessionStore(),
});

// In MCP handler
async function handleRequest(headers: Record<string, string>) {
  const destination = headers['x-mcp-destination'];
  const authType = headers['x-sap-auth-type'];
  
  if (authType === 'jwt' && destination) {
    try {
      const token = await broker.getToken(destination);
      // Use token for SAP connection
      return { token };
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }
}
```

### Example: Multiple Destinations

```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(),
  sessionStore: new AbapSessionStore(),
});

async function getTokensForDestinations() {
  const destinations = ['TRIAL', 'PRODUCTION', 'DEVELOPMENT'];
  
  const tokens = await Promise.all(
    destinations.map(async (dest) => {
      try {
        const token = await broker.getToken(dest);
        return { destination: dest, token, status: 'success' };
      } catch (error) {
        return { destination: dest, error: error.message, status: 'error' };
      }
    })
  );
  
  return tokens;
}
```

## Configuration

### Environment Variables

#### AUTH_BROKER_PATH

Specify search paths via environment variable:

```bash
# Linux/macOS
export AUTH_BROKER_PATH=/path1:/path2:/path3

# Windows
set AUTH_BROKER_PATH=C:\path1;C:\path2;C:\path3
```

**Usage**:
```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

// If AUTH_BROKER_PATH is set, it will be used by AbapServiceKeyStore and AbapSessionStore
// when no paths are provided to their constructors
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(), // Uses AUTH_BROKER_PATH if set
  sessionStore: new AbapSessionStore(), // Uses AUTH_BROKER_PATH if set
});
```

#### DEBUG_AUTH_LOG

Control debug logging output:

```bash
# Enable debug logging
export DEBUG_AUTH_LOG=true

# Disable debug logging (default)
unset DEBUG_AUTH_LOG
# or
export DEBUG_AUTH_LOG=false
```

**Behavior**:
- **When `DEBUG_AUTH_LOG=true`**: Shows detailed debug messages including:
  - Browser opening notifications
  - Token refresh operations
  - Authentication flow details
- **When `DEBUG_AUTH_LOG=false` or unset** (default): Only shows:
  - Error messages (always visible)
  - URL for manual browser opening (when browser is not opened automatically)
  - No debug messages

**Example**:
```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

// With debug logging enabled
process.env.DEBUG_AUTH_LOG = 'true';
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(),
  sessionStore: new AbapSessionStore(),
});
await broker.getToken('TRIAL');
// Output: [DEBUG] No refresh token found for destination "TRIAL". Starting browser authentication...
//         [DEBUG] 🌐 Opening browser for authentication...

// Without debug logging (default)
process.env.DEBUG_AUTH_LOG = 'false';
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(),
  sessionStore: new AbapSessionStore(),
});
await broker.getToken('TRIAL');
// Output: (only errors and manual URL if browser cannot be opened)
```

### File Naming Convention

Files must follow the naming pattern:
- Environment file: `{destination}.env`
- Service key file: `{destination}.json`

**Examples**:
- Destination "TRIAL" → `TRIAL.env`, `TRIAL.json`
- Destination "PRODUCTION" → `PRODUCTION.env`, `PRODUCTION.json`

## Error Handling

### Common Errors

#### 1. File Not Found

```typescript
Error: No authentication found for destination "TRIAL".
Neither TRIAL.env file nor TRIAL.json service key found.
Please create one of:
  - /path/to/TRIAL.env (with SAP_JWT_TOKEN)
  - /path/to/TRIAL.json (service key)
Searched in:
  - /path1
  - /path2
```

**Solution**: Create the required file in one of the searched paths.

#### 2. Service Key Not Found

```typescript
Error: Service key file not found for destination "TRIAL".
Please create file: /path/to/TRIAL.json
Searched in:
  - /path1
  - /path2
```

**Solution**: Create service key file `TRIAL.json` in one of the searched paths.

#### 3. Invalid Service Key

```typescript
Error: Invalid service key for destination "TRIAL".
Missing required UAA fields: url, clientid, clientsecret
```

**Solution**: Ensure service key has valid `uaa` object with all required fields.

#### 4. Missing SAP URL

```typescript
Error: Service key for destination "TRIAL" does not contain SAP URL.
Expected field: url, abap.url, or sap_url
```

**Solution**: Ensure service key has `url`, `abap.url`, or `sap_url` field.

## Logging

The package uses a configurable logger that respects the `DEBUG_AUTH_LOG` environment variable.

### Log Levels

- **Info**: Always visible (errors, manual URLs)
- **Debug**: Only visible when `DEBUG_AUTH_LOG=true`

### Custom Logger

You can inject a custom logger into `AuthBroker`:

```typescript
import { AuthBroker, ILogger, AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-broker';

class MyLogger implements ILogger {
  info(message: string): void {
    // Custom info logging
  }
  debug(message: string): void {
    // Custom debug logging
  }
  error(message: string): void {
    // Custom error logging
  }
  // ... other methods
}

const logger = new MyLogger();
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(),
  sessionStore: new AbapSessionStore(),
}, undefined, logger);
```

## Best Practices

1. **Error Handling**: Always wrap token requests in try/catch blocks
2. **Cache Management**: Clear cache when tokens are manually updated
3. **Storage Selection**: Choose appropriate storage based on security requirements:
   - Use `AbapSessionStore`, `XsuaaSessionStore`, or `BtpSessionStore` if you need persistence across restarts
   - Use `SafeAbapSessionStore`, `SafeXsuaaSessionStore`, or `SafeBtpSessionStore` if you want secure in-memory storage (data lost after restart)
4. **Security**: Never commit `.env` or `.json` files to version control
5. **File Permissions**: Set appropriate file permissions for sensitive files
6. **Multiple Destinations**: Use separate broker instances or clear cache between destinations
7. **Logging**: Use `DEBUG_AUTH_LOG=true` only when debugging - production should use default (minimal logging)
8. **Explicit Stores**: Always explicitly create stores - don't rely on defaults if you need specific behavior

## Performance Considerations

1. **Caching**: Tokens are cached in memory - subsequent calls are fast
2. **Validation**: Tokens are validated before returning from cache
3. **Refresh**: Refresh only happens when token is expired or invalid
4. **Browser Auth**: Browser authentication is only used when no refresh token exists

## Next Steps

- See [Installation Guide](../installing/INSTALLATION.md) for setup instructions
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development guide
