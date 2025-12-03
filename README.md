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
import { AuthBroker, FileServiceKeyStore, FileSessionStore, SafeSessionStore } from '@mcp-abap-adt/auth-broker';

// Use default file-based stores (current working directory)
const broker = new AuthBroker();

// Use custom file-based stores with specific paths
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/path/to/destinations']),
  sessionStore: new FileSessionStore(['/path/to/destinations']),
}, 'chrome');

// Use safe in-memory session store (data lost after restart)
const broker = new AuthBroker({
  serviceKeyStore: new FileServiceKeyStore(['/path/to/destinations']),
  sessionStore: new SafeSessionStore(), // In-memory, secure
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

#### Environment File for BTP/XSUAA (`{destination}.env`)

For BTP/XSUAA connections, use `BTP_*` environment variables:

```env
BTP_URL=https://your-mcp-server.cfapps.eu10.hana.ondemand.com
BTP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
BTP_REFRESH_TOKEN=refresh_token_string
BTP_UAA_URL=https://your-account.authentication.eu10.hana.ondemand.com
BTP_UAA_CLIENT_ID=client_id
BTP_UAA_CLIENT_SECRET=client_secret
```

**Note**: `BTP_URL` is optional - it's not part of authentication, only needed for making requests. The token and UAA credentials are sufficient for authentication.

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

## API

### `AuthBroker`

#### Constructor

```typescript
new AuthBroker(stores?: { serviceKeyStore?: IServiceKeyStore; sessionStore?: ISessionStore }, browser?: string, logger?: Logger)
```

- `stores` - Optional object with custom storage implementations:
  - `serviceKeyStore` - Store for service keys (default: `AbapServiceKeyStore()`)
  - `sessionStore` - Store for session data (default: `AbapSessionStore()`)
  - Available implementations:
    - **ABAP**: `AbapServiceKeyStore(searchPaths?)`, `AbapSessionStore(searchPaths?)`, `SafeAbapSessionStore()`
    - **XSUAA**: `XsuaaServiceKeyStore(searchPaths?)`, `XsuaaSessionStore(searchPaths?)`, `SafeXsuaaSessionStore()`
- `browser` - Optional browser name for authentication (`chrome`, `edge`, `firefox`, `system`, `none`). Default: `system`
  - For XSUAA, browser is not used (client_credentials grant type)
- `logger` - Optional logger instance. If not provided, uses default logger

#### Methods

##### `getToken(destination: string): Promise<string>`

Gets authentication token for destination. Tries to load from `.env` file, validates it, and refreshes if needed.

##### `refreshToken(destination: string): Promise<string>`

Force refresh token for destination using service key from `{destination}.json` file.

##### `clearCache(destination: string): void`

Clear cached token for specific destination.

##### `clearAllCache(): void`

Clear all cached tokens.

### Constants

The package exports constants for environment variable names and HTTP headers:

```typescript
import {
  ABAP_ENV_VARS,
  BTP_ENV_VARS,
  ABAP_HEADERS,
  BTP_HEADERS,
  getBtpAuthorizationHeader,
} from '@mcp-abap-adt/auth-broker';

// Environment variable names
const sapUrl = process.env[ABAP_ENV_VARS.SAP_URL];
const btpToken = process.env[BTP_ENV_VARS.BTP_JWT_TOKEN];

// HTTP headers
headers[ABAP_HEADERS.SAP_URL] = 'https://system.sap.com';
headers[ABAP_HEADERS.SAP_JWT_TOKEN] = token;

// BTP authorization header
headers[BTP_HEADERS.AUTHORIZATION] = getBtpAuthorizationHeader(token);
```

**Available Constants:**
- `ABAP_ENV_VARS` - Environment variable names for ABAP (SAP_URL, SAP_JWT_TOKEN, etc.)
- `BTP_ENV_VARS` - Environment variable names for BTP/XSUAA (BTP_URL, BTP_JWT_TOKEN, etc.)
- `ABAP_HEADERS` - HTTP header names for ABAP (x-sap-url, x-sap-jwt-token, etc.)
- `BTP_HEADERS` - HTTP header names for BTP (Authorization, x-mcp-url, etc.)

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

Place your service key file in `./test-destinations/TRIAL.json` to run tests 2 and 3.

Tests will automatically skip if required files are missing or present when they shouldn't be.

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

