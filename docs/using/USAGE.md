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
  SafeAbapSessionStore,
  SafeXsuaaSessionStore,
} from '@mcp-abap-adt/auth-broker';

// Use default file-based stores for ABAP (current working directory) and default browser
const broker = new AuthBroker();

// Use custom file-based stores for ABAP with specific paths
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
});

// Use XSUAA stores for BTP/XSUAA connections
const broker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore(['/path/to/destinations']),
  sessionStore: new XsuaaSessionStore(['/path/to/destinations']),
}, 'none'); // Browser not needed for XSUAA (client_credentials)

// Use safe in-memory session stores (data lost after restart, secure)
const abapBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeAbapSessionStore(), // In-memory, no disk persistence
});

const xsuaaBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeXsuaaSessionStore(), // In-memory, no disk persistence
}, 'none');
```

## Constants

The package exports constants for environment variable names and HTTP headers to help consumers work with ABAP and BTP/XSUAA connections:

```typescript
import {
  ABAP_ENV_VARS,
  BTP_ENV_VARS,
  ABAP_HEADERS,
  BTP_HEADERS,
  getBtpAuthorizationHeader,
  isAbapEnvVar,
  isBtpEnvVar,
} from '@mcp-abap-adt/auth-broker';

// Read environment variables
const sapUrl = process.env[ABAP_ENV_VARS.SAP_URL];
const btpToken = process.env[BTP_ENV_VARS.BTP_JWT_TOKEN];

// Set HTTP headers for ABAP
headers[ABAP_HEADERS.SAP_URL] = 'https://system.sap.com';
headers[ABAP_HEADERS.SAP_JWT_TOKEN] = token;

// Set HTTP headers for BTP
headers[BTP_HEADERS.AUTHORIZATION] = getBtpAuthorizationHeader(token);
headers[BTP_HEADERS.MCP_URL] = 'https://mcp-server.cfapps.eu10.hana.ondemand.com';

// Check variable type
if (isAbapEnvVar('SAP_URL')) {
  // Handle ABAP variable
}
if (isBtpEnvVar('BTP_JWT_TOKEN')) {
  // Handle BTP variable
}
```

### Available Constants

**ABAP Environment Variables** (`ABAP_ENV_VARS`):
- `SAP_URL` - SAP system URL
- `SAP_JWT_TOKEN` - JWT token for authorization
- `SAP_REFRESH_TOKEN` - Refresh token for token renewal
- `SAP_UAA_URL` - UAA URL for token refresh
- `SAP_UAA_CLIENT_ID` - UAA client ID
- `SAP_UAA_CLIENT_SECRET` - UAA client secret
- `SAP_CLIENT` - SAP client number
- `SAP_LANGUAGE` - Language

**BTP Environment Variables** (`BTP_ENV_VARS`):
- `BTP_URL` / `BTP_MCP_URL` - MCP server URL (optional, not part of authentication)
- `BTP_JWT_TOKEN` - JWT token for `Authorization: Bearer` header
- `BTP_REFRESH_TOKEN` - Refresh token for token renewal
- `BTP_UAA_URL` - UAA URL for token refresh
- `BTP_UAA_CLIENT_ID` - UAA client ID
- `BTP_UAA_CLIENT_SECRET` - UAA client secret

**ABAP HTTP Headers** (`ABAP_HEADERS`):
- `x-sap-url` - SAP system URL
- `x-sap-auth-type` - Authentication type (jwt, xsuaa, basic)
- `x-sap-jwt-token` - JWT token
- `x-sap-refresh-token` - Refresh token
- `x-sap-uaa-url` - UAA URL
- `x-sap-uaa-client-id` - UAA client ID
- `x-sap-uaa-client-secret` - UAA client secret
- `x-sap-client` - SAP client number
- `x-sap-destination` - Destination name for service key-based authentication
- `x-mcp-destination` - Destination name for MCP destination-based authentication
- `x-sap-login` - Login for basic authentication
- `x-sap-password` - Password for basic authentication

**BTP HTTP Headers** (`BTP_HEADERS`):
- `Authorization` - Authorization header with Bearer token (for BTP Cloud authentication)
- `x-mcp-url` - MCP server URL (optional, can be provided separately)
- `x-btp-destination` - BTP destination name for service key-based authentication

## API Reference

### AuthBroker Class

#### Constructor

```typescript
constructor(
  stores?: { serviceKeyStore?: IServiceKeyStore; sessionStore?: ISessionStore },
  browser?: string,
  logger?: Logger
)
```

**Parameters**:
- `stores` (optional): Object with custom storage implementations:
  - `serviceKeyStore` - Store for service keys (default: `AbapServiceKeyStore()`)
  - `sessionStore` - Store for session data (default: `AbapSessionStore()`)
  - Available implementations for ABAP:
    - `AbapServiceKeyStore(searchPaths?)` - File-based service key store for ABAP
    - `AbapSessionStore(searchPaths?)` - File-based session store for ABAP (persists to disk)
    - `SafeAbapSessionStore()` - In-memory session store for ABAP (secure, data lost after restart)
  - Available implementations for XSUAA:
    - `XsuaaServiceKeyStore(searchPaths?)` - File-based service key store for XSUAA
    - `XsuaaSessionStore(searchPaths?)` - File-based session store for XSUAA (uses BTP_* variables)
    - `SafeXsuaaSessionStore()` - In-memory session store for XSUAA (secure, data lost after restart)
- `browser` (optional): Browser name for authentication. Options:
  - `'chrome'` - Open in Google Chrome
  - `'edge'` - Open in Microsoft Edge
  - `'firefox'` - Open in Mozilla Firefox
  - `'system'` - Use system default browser (default)
  - `'none'` - Don't open browser, print URL to console for manual copy
- `logger` (optional): Custom logger instance. If not provided, uses default logger

**Example**:
```typescript
import { AuthBroker, FileServiceKeyStore, FileSessionStore, SafeSessionStore } from '@mcp-abap-adt/auth-broker';

// Default (current working directory, system browser, file-based stores)
const broker = new AuthBroker();

// Custom paths with file-based stores
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/custom/path']),
  sessionStore: new FileSessionStore(['/custom/path']),
});

// Multiple paths with Chrome browser
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/path1', '/path2']),
  sessionStore: new FileSessionStore(['/path1', '/path2']),
}, 'chrome');

// Safe in-memory session store (secure, no disk persistence)
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/path1']),
  sessionStore: new SafeSessionStore(), // Data lost after restart
});

// Print URL instead of opening browser
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/path1']),
  sessionStore: new FileSessionStore(['/path1']),
}, 'none');
```

#### getToken()

Get authentication token for destination. Tries to load from `.env` file, validates it, and refreshes if needed.

```typescript
async getToken(destination: string): Promise<string>
```

**Parameters**:
- `destination`: Destination name (e.g., "TRIAL")

**Returns**: Promise that resolves to JWT token string

**Throws**: Error if neither `.env` file nor service key found

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
1. Check cache for valid token
2. Load from `.env` file and validate
3. If expired or not found, refresh using service key
4. If no service key, throw error with instructions

#### refreshToken()

Force refresh token for destination using service key. If no refresh token exists, starts browser authentication flow.

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
1. Load service key from `{destination}.json`
2. Check for existing refresh token in `.env`
3. If refresh token exists, use it to refresh
4. If no refresh token, start browser authentication
5. Save new tokens to `.env` file
6. Update cache
7. Return new access token

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
import { AuthBroker, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

// Search in multiple directories
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore([
    '/home/user/.sap/destinations',
    '/etc/sap/destinations',
    process.cwd()
  ]),
  sessionStore: new FileSessionStore([
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
import { AuthBroker, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(),
  sessionStore: new FileSessionStore(),
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
import { AuthBroker, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(),
  sessionStore: new FileSessionStore(),
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
import { AuthBroker, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

// If AUTH_BROKER_PATH is set, it will be used by FileServiceKeyStore and FileSessionStore
// when no paths are provided to their constructors
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(), // Uses AUTH_BROKER_PATH if set
  sessionStore: new FileSessionStore(), // Uses AUTH_BROKER_PATH if set
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
import { AuthBroker, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

// With debug logging enabled
process.env.DEBUG_AUTH_LOG = 'true';
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(),
  sessionStore: new FileSessionStore(),
});
await broker.getToken('TRIAL');
// Output: [DEBUG] No refresh token found for destination "TRIAL". Starting browser authentication...
//         [DEBUG] 🌐 Opening browser for authentication...

// Without debug logging (default)
process.env.DEBUG_AUTH_LOG = 'false';
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(),
  sessionStore: new FileSessionStore(),
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
import { AuthBroker, Logger, FileServiceKeyStore, FileSessionStore } from '@mcp-abap-adt/auth-broker';

class MyLogger implements Logger {
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
  serviceKeyStore: new FileServiceKeyStore(),
  sessionStore: new FileSessionStore(),
}, undefined, logger);
```

## Best Practices

1. **Error Handling**: Always wrap token requests in try/catch blocks
2. **Cache Management**: Clear cache when tokens are manually updated
3. **Storage Selection**: Choose appropriate storage based on security requirements:
   - Use `FileSessionStore` if you need persistence across restarts
   - Use `SafeSessionStore` if you want secure in-memory storage (data lost after restart)
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

