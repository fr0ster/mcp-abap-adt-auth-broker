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

#### Environment File (`{destination}.env`)

```env
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
SAP_REFRESH_TOKEN=refresh_token_string
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=client_id
SAP_UAA_CLIENT_SECRET=client_secret
```

#### Service Key File (`{destination}.json`)

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

## API

### `AuthBroker`

#### Constructor

```typescript
new AuthBroker(stores?: { serviceKeyStore?: IServiceKeyStore; sessionStore?: ISessionStore }, browser?: string, logger?: Logger)
```

- `stores` - Optional object with custom storage implementations:
  - `serviceKeyStore` - Store for service keys (default: `FileServiceKeyStore()`)
  - `sessionStore` - Store for session data (default: `FileSessionStore()`)
  - Available implementations:
    - `FileServiceKeyStore(searchPaths?)` - File-based service key store
    - `FileSessionStore(searchPaths?)` - File-based session store (persists to disk)
    - `SafeSessionStore()` - In-memory session store (secure, data lost after restart)
- `browser` - Optional browser name for authentication (`chrome`, `edge`, `firefox`, `system`, `none`). Default: `system`
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

