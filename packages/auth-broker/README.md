# @mcp-abap-adt/auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A per-destination token broker for SAP BTP and ABAP systems. For a destination — a name, such as
`TRIAL` — it reads the session and the service key from the stores it is given, hands them to
a token provider, and saves what the provider returns back to the session: a JWT or, for SAML,
session cookies, with the refresh token. It decides nothing about tokens itself: whether the
cached token is still good, when to refresh and when to log in is the provider's call
(`@mcp-abap-adt/auth-providers`), and where sessions live is the stores' (`@mcp-abap-adt/auth-stores`).

The `mcp-auth` and `mcp-sso` commands that write session files are in
[`@mcp-abap-adt/auth-broker-cli`](../auth-broker-cli/README.md), in the same
repository. Up to 3.0.4 they shipped in this package; from 3.1.0 this package
has no `bin`. Install the commands with
`npm i -g @mcp-abap-adt/auth-broker-cli` — after
`npm uninstall -g @mcp-abap-adt/auth-broker` if you had installed this one
globally for them.

## Features

- 🎯 **Per destination**: one provider per destination name, built by a factory or given once
- 🔄 **Provider-driven token lifecycle**: The provider decides whether its cached token is still good, refreshes it, or logs in; the broker persists what it returns
- ⚡ **Forced refresh**: `refreshToken()` obtains a new token even when the cached one looks valid — for a caller holding a 401
- 🧾 **JWT or SAML cookies**: what the provider returns is saved as a token or as session cookies
- 🔑 **No secrets copied**: The client secret stays in the service key; the session store gets tokens only

## Installation

```bash
npm install @mcp-abap-adt/auth-broker
```

Requires Node.js 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`): 22 and 24 are
the versions SAP BTP's Cloud Foundry Node.js buildpack offers, and 26 is
supported as well.

## Usage

### Basic Usage

The broker takes a session store, an optional service key store, and a token
provider implementing `IRefreshableTokenProvider` (from
`@mcp-abap-adt/interfaces-auth`) — or a factory that builds one per
destination:

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
} from '@mcp-abap-adt/auth-stores';
import {
  AuthorizationCodeProvider,
  browserCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';

const broker = new AuthBroker(
  {
    sessionStore: new AbapSessionStore('/path/to/sessions'),
    serviceKeyStore: new AbapServiceKeyStore('/path/to/keys'), // optional
    // Called once per destination, seeded with what the stores hold.
    provider: (destination, authConfig, connConfig) => {
      if (!authConfig) throw new Error(`No UAA credentials for ${destination}`);
      return new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl,
        clientId: authConfig.uaaClientId,
        clientSecret: authConfig.uaaClientSecret,
        refreshToken: authConfig.refreshToken, // stored by an earlier login
        accessToken: connConfig.authorizationToken, // reused while valid
        authorization: browserCallbackStrategy({ browser: 'system' }),
      });
    },
  },
  logger, // optional ILogger
);

const token = await broker.getToken('TRIAL');
```

The factory receives:

- `authConfig` — the UAA credentials: the session's own when it holds them,
  else the service key's; carrying the refresh token the session stored.
  `null` when no store has credentials (a SAML flow needs none).
- `connConfig` — the session's connection config, with `serviceUrl` resolved
  (from the session, else the service key) and the token stored last.

A provider instance can be passed instead of a factory; it is then used as
given, for every destination, and the broker seeds it with nothing:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/sessions'),
  provider: new AuthorizationCodeProvider({ uaaUrl, clientId, clientSecret }),
});
```

> `AuthorizationCodeProvider` and the other `@mcp-abap-adt/auth-providers`
> providers implement `IRefreshableTokenProvider` from auth-providers 4.2.0.

### Headless Processes (No Browser)

Whether a login may open a browser is the provider's authorization strategy,
not a broker option. A process nobody is watching (an MCP server on stdio, a
CI job) gives the provider a strategy that refuses, and catches its own error —
the broker hands it back unchanged:

```typescript
class LoginRequiredError extends Error {}

const provider = new AuthorizationCodeProvider({
  uaaUrl, clientId, clientSecret, refreshToken,
  authorization: {
    authorize: async () => {
      throw new LoginRequiredError('Run mcp-auth to log in');
    },
  },
});

try {
  await broker.getToken('TRIAL');
} catch (error) {
  if (error instanceof LoginRequiredError) {
    // No usable token or refresh token: a person has to log in.
  }
}
```

A cached token that is still valid, or a refresh token the UAA accepts, never
reaches the strategy.

### Custom Browser Auth Port

How a login is conducted — including which port the local OAuth2 callback
listens on — is an `IAuthorizationStrategy` passed as `authorization`, not a
field on the provider config. `browserCallbackStrategy` from
`@mcp-abap-adt/auth-providers` builds the ready-made one; its default port is
`61001`, chosen to sit well clear of the range application servers and
proxies typically use (e.g. `3001`/`3333`). Pass `port` to avoid conflicts
with a specific redirect URI registered at the identity provider:

```typescript
new AuthorizationCodeProvider({
  uaaUrl, clientId, clientSecret,
  authorization: browserCallbackStrategy({ browser: 'system', port: 4001 }),
});
```

### Getting Tokens

```typescript
// The provider's current token: cached while valid, else refreshed or logged in.
const token = await broker.getToken('TRIAL');

// A new token, never the cached one — after the server refused the token (401).
const newToken = await broker.refreshToken('TRIAL');
```

Both write the result to the session store: a SAML result as session cookies,
anything else as the bearer token, and the refresh token when the result has
one.

### Creating Token Refresher for DI

The `createTokenRefresher()` method creates an `ITokenRefresher` implementation that can be injected into connections. This enables connections to handle token refresh transparently without knowing about authentication internals.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { JwtAbapConnection } from '@mcp-abap-adt/connection';

// Create broker
const broker = new AuthBroker({
  sessionStore: mySessionStore,
  serviceKeyStore: myServiceKeyStore,
  provider: myProviderFactory,
});

// Create token refresher for specific destination
const tokenRefresher = broker.createTokenRefresher('TRIAL');

// Inject into connection (connection can handle 401/403 automatically)
const connection = new JwtAbapConnection(config, tokenRefresher);

// Token refresher methods:
// - getToken(): the provider's current token (broker.getToken)
// - refreshToken(): a new token, never the cached one (broker.refreshToken)
```

**Benefits of Token Refresher:**
- 🔄 **Transparent Refresh**: Connection handles 401/403 errors automatically
- 🧩 **Dependency Injection**: Clean separation of concerns
- 💾 **Automatic Persistence**: Tokens saved to session store after refresh
- 🎯 **Destination-Scoped**: Each refresher is bound to specific destination

## Migrating from 2.2.0

1. `tokenProvider` is now `provider`, and the `browser` argument is gone:
   `new AuthBroker({ sessionStore, serviceKeyStore, tokenProvider }, 'system', logger)`
   becomes `new AuthBroker({ sessionStore, serviceKeyStore, provider }, logger)`.
2. The provider must implement `IRefreshableTokenProvider` (`refreshTokens()`,
   a new token, never the cached one) — `@mcp-abap-adt/auth-providers` 4.2.0
   providers do. Pass a factory instead of an instance to have the broker seed
   it with the stored refresh token and token.
3. `allowBrowserAuth: false` and `BROWSER_AUTH_REQUIRED` are gone: give the
   provider an authorization strategy that refuses and catch your own error
   (see *Headless Processes*). A browser login that fails — timeout, the
   identity provider's refusal, a busy callback port — is auth-providers'
   `BrowserAuthError` (from 4.2.0).
4. Provider errors arrive unchanged: match on the class or `code`, not on the
   old `Token provider … error for <destination>` messages.
5. The broker no longer writes the client secret into the session store. Read
   it from the service key store if you relied on finding it in the session.
6. `refreshToken()` now forces a new token; it used to return `getToken()`'s.
7. Node.js 22, 24 or 26; SAML runs need the IdP trust (see *Migrating `mcp-sso`
   SAML runs from 2.2.0* in the [CLI's README](../auth-broker-cli/README.md)).

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

**What is logged:** broker initialization (which stores, instance or factory),
provider builds (whether credentials, a refresh token and a stored token were
there), and each token saved (token type, grant, whether a refresh token came
back, expiry). Store read failures are logged as warnings.

**What is never logged:** any part of a token, refresh token or secret — not a
prefix, not a suffix. A log line says whether a token is there, never what it is.

Example output with `DEBUG_BROKER=true LOG_LEVEL=info`:
```
[INFO] ℹ️ [AUTH-BROKER] [AuthBroker] Token saved for TRIAL: tokenType(jwt), authType(authorization_code), hasRefreshToken(true), expiresAt(2026-09-26T20:15:30.000Z)
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

- **Resolves what the stores hold**: the service URL, the UAA credentials, the stored token and refresh token
- **Builds or reuses the provider**: a factory is called once per destination, seeded with the above
- **Asks the provider once**: `getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()` — no retries, no fallbacks
- **Persists the answer**: token or session cookies, and the refresh token, to `sessionStore`
- **Works with interfaces only**: `IServiceKeyStore`, `ISessionStore`, `IRefreshableTokenProvider`

#### What AuthBroker Does NOT Do

- **Does NOT implement storage**: File I/O, parsing, and storage logic are handled by concrete store implementations from `@mcp-abap-adt/auth-stores`
- **Does NOT implement token acquisition**: OAuth2 flows, refresh token logic, and client credentials are handled by concrete provider implementations from `@mcp-abap-adt/auth-providers`
- **Does NOT judge the token**: whether a cached token is still valid, and whether to refresh or log in, is the provider's decision
- **Does NOT decide how a login is conducted**: browser, headless or pasted code is the provider's authorization strategy
- **Does NOT copy secrets**: the client secret stays in the service key store

### Consumer Responsibilities

The **consumer** (application using `AuthBroker`) is responsible for:

1. **Selecting appropriate implementations**: Choose the correct `IServiceKeyStore`, `ISessionStore`, and `IRefreshableTokenProvider` implementations based on the use case:
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

Concrete `IRefreshableTokenProvider` implementations are responsible for:

- **Obtaining tokens**: Using OAuth2 flows, refresh tokens, or client credentials to obtain JWT tokens
- **Managing token lifecycle**: Caching, validating, refreshing, and re-authenticating as needed (`getTokens()`)
- **Forcing a new token**: `refreshTokens()` — never the cached one
- **Reporting failures with typed errors**, which the broker passes on unchanged

### Design Principles

1. **Interface-Only Communication** (Core Principle): All interactions with external dependencies happen **ONLY through interfaces**. The code knows **NOTHING beyond what is defined in the interfaces** (see [Core Development Principle](#core-development-principle) above)
2. **Dependency Inversion Principle (DIP)**: `AuthBroker` depends on abstractions (`IServiceKeyStore`, `ISessionStore`, `IRefreshableTokenProvider`), not concrete implementations
3. **Single Responsibility**: Each component has a single, well-defined responsibility:
   - `AuthBroker`: Orchestration — resolving, asking, persisting
   - `ISessionStore`: Session data storage and retrieval
   - `IRefreshableTokenProvider`: Token acquisition and lifecycle
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
    provider:                           // required
      | IRefreshableTokenProvider
      | ((
          destination: string,
          authConfig: IAuthorizationConfig | null,
          connConfig: IConnectionConfig,
        ) => IRefreshableTokenProvider);
  },
  logger?: ILogger,
)
```

**Parameters:**
- `config.sessionStore` - **Required** - Where tokens and the refresh token are kept. Its `serviceUrl`, or the service key's, is required.
- `config.serviceKeyStore` - **Optional** - UAA credentials and the service URL.
- `config.provider` - **Required** - A provider instance, used for every destination, or a factory (`TokenProviderFactory`), called once per destination and seeded with what the stores hold (see *Basic Usage*).
- `logger` - Optional logger. If not provided, nothing is logged.

**Available Implementations:**
- **ABAP**: `AbapServiceKeyStore(directory, logger?)`, `AbapSessionStore(directory, logger?, defaultServiceUrl?)`, `SafeAbapSessionStore(logger?, defaultServiceUrl?)`, `AuthorizationCodeProvider(...)`
- **XSUAA** (reduced scope): `XsuaaServiceKeyStore(directory, logger?)`, `XsuaaSessionStore(directory, defaultServiceUrl, logger?)`, `SafeXsuaaSessionStore(defaultServiceUrl, logger?)`, `ClientCredentialsProvider(...)`

#### Methods

##### `getToken(destination: string): Promise<string>`

1. Resolves the destination's `serviceUrl` (session, else service key; an error if neither has one).
2. Builds the provider on first use (factory form), seeded with the credentials, the stored refresh token and the stored token — or uses the instance.
3. Calls `provider.getTokens()` once. The provider answers from its cache, refreshes, or logs in.
4. Persists the result: `sessionCookies` for `tokenType: 'saml'`, else `authorizationToken`; the refresh token when the result has one.
5. Returns the token.

##### `refreshToken(destination: string): Promise<string>`

The same, with `provider.refreshTokens()`: a new token, never the cached one —
for a caller whose token the server has just refused.

##### `getAuthorizationConfig(destination)` / `getConnectionConfig(destination)`

The session's configuration, else the service key's, else `null`.

##### `createTokenRefresher(destination): ITokenRefresher`

`getToken()` and `refreshToken()` bound to one destination, for injection into a connection.

##### Error Handling

- **Provider errors propagate unchanged** — the same object, with its class,
  `code`, `missingFields` and `cause`: auth-providers' `ValidationError`,
  `BrowserAuthError`, `AssertionValidationError`, network errors (`ECONNREFUSED`,
  `ETIMEDOUT`, `ENOTFOUND`), and whatever your authorization strategy throws.
  The broker does not retry a failed call.
- **Store reads: absence is an answer, a failure is not.** A store that answers
  `null`, or fails with `FILE_NOT_FOUND` (logged at debug), means "nothing
  here", and the broker goes on to the next source. Any other store failure —
  a service key that is not valid JSON, a file the process may not read — is
  thrown unchanged. A failure in the reads that come before the token (the
  session's connection config, the service key) stops the call before the
  provider is asked; one in the reads that save it (the session's
  authorization config, the session) arrives after the provider answered and
  the new token was written. (The session stores of
  auth-stores answer an unreadable session file with `null` themselves, so it
  reads as absent before the broker sees it.)
- **Store writes propagate**: a token that cannot be saved is an error.
- **A provider result without a token** is an error.

```typescript
import { ValidationError } from '@mcp-abap-adt/auth-providers';

try {
  const token = await broker.getToken('TRIAL');
} catch (error) {
  if (error instanceof ValidationError) {
    logger.error(`Missing: ${error.missingFields?.join(', ')}`);
  }
  throw error;
}
```

#### Secrets in the Session Store

The broker writes the token (or session cookies) and the refresh token to the
session store — never the client secret. When the credentials come from the
service key they stay there. A session that already holds its own credentials
(written by you, or by `mcp-auth`/`mcp-sso`, whose output is a self-contained
session file) keeps them, and only its refresh token is updated.

With credentials in the service key, the stores return the stored refresh
token through `loadSession()`, which the broker reads to seed the next
process's provider — the XSUAA stores too, from auth-stores 1.2.3.

### Token Providers

The package uses the `ITokenProvider` interface for token acquisition. Provider implementations live in `@mcp-abap-adt/auth-providers`:

- **`ClientCredentialsProvider`** - For XSUAA authentication (reduced scope)
  - Uses client_credentials grant type
  - No browser interaction required
  - No refresh token provided

- **`AuthorizationCodeProvider`** - For BTP/ABAP authentication (full scope)
  - How the login is conducted is an `authorization?: IAuthorizationStrategy<string>`, not a
    provider field. Omitted, it defaults to a browser callback on port `61001`
  - `browserCallbackStrategy({ browser?, port?, timeoutMs? })` from `@mcp-abap-adt/auth-providers`
    builds the ready-made strategy; pass `port` to avoid conflicts when running alongside other
    services (e.g. a proxy server) or to match a redirect URI registered at the identity provider
  - The callback port is held only for the duration of a login and released when it ends —
    by success, failure, timeout, or cancellation
  - Uses browser-based OAuth2 flow (if no refresh token)
  - Uses refresh token if available
  - Provides refresh token for future use

**Example Usage:**

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { ClientCredentialsProvider } from '@mcp-abap-adt/auth-providers';

// XSUAA, client_credentials: credentials from the service key
const xsuaaBroker = new AuthBroker({
  sessionStore: new XsuaaSessionStore('/path/to/sessions', 'https://mcp.example.com'),
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys'),
  provider: (destination, authConfig) => {
    if (!authConfig) throw new Error(`No UAA credentials for ${destination}`);
    return new ClientCredentialsProvider({
      uaaUrl: authConfig.uaaUrl,
      clientId: authConfig.uaaClientId,
      clientSecret: authConfig.uaaClientSecret,
    });
  },
});
```

## Testing

The library's tests are in `packages/auth-broker/src/__tests__/` and use Jest.
Run them from the repository root, where the dev dependencies are installed:

```bash
# Every workspace's tests (library and CLI)
npm test

# The library's only
npm test -w @mcp-abap-adt/auth-broker

# One file, or one case
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts -t "name of the case"
```

Tests run sequentially (`maxWorkers: 1` and `maxConcurrency: 1` in
`packages/auth-broker/jest.config.js`). `AuthBroker.test.ts` needs nothing;
`AuthBroker.integration.test.ts` reads real service keys and sessions, and
every case in it returns early unless the configuration below names a real
destination.

### Test Setup

1. Copy `packages/auth-broker/tests/test-config.yaml.template` to
   `packages/auth-broker/tests/test-config.yaml` (until the workspace layout it
   lived in `tests/` at the repository root; move an existing copy)
2. Fill in configuration values (paths, destinations, MCP URL for XSUAA)
3. Place service key files in configured `service_keys_dir`:
   - `{destination}.json` for ABAP tests (e.g., `trial.json`)
   - `{btp_destination}.json` for XSUAA tests (e.g., `btp.json`)

Without `test-config.yaml` the template is read, its placeholders disable every
integration case, and the run reaches no system.

## Documentation

Complete documentation is available in the repository's [`docs/`](../../docs/) directory:

- **[Architecture](../../docs/architecture/ARCHITECTURE.md)** - System architecture and design decisions
- **[Development](../../docs/development/)** - Testing methodology and development roadmap
- **[Development Roadmap](../../docs/development/DEVELOPMENT_ROADMAP.md)** - Development roadmap and future plans
- **[Installation](../../docs/installing/INSTALLATION.md)** - Installation and setup guide
- **[Usage](../../docs/using/USAGE.md)** - API reference and usage examples

See [docs/README.md](../../docs/README.md) for the complete documentation index.

## Contributors

Thank you to all contributors! See [CONTRIBUTORS.md](../../CONTRIBUTORS.md) for the complete list.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`).
Earlier published versions were MIT and stay MIT — a licence change is not
retroactive.

Copyright © 2025–2026 Oleksii Kyslytsia

This library is free software: you can redistribute it and/or modify it under the
terms of the GNU Lesser General Public License as published by the Free Software
Foundation, version 3.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See the GNU Lesser General Public License for more details.

Both texts ship with the package and both are needed: [`LICENSE`](LICENSE) is the
LGPL, [`COPYING`](COPYING) is the GPL it is written on top of, since the LGPL is a
set of additional permissions over the GPL and cannot be read alone.

**What this means if you depend on this package.** Linking it into your own
program — importing it, as every consumer of an npm package does — does not put
your program under the LGPL. What the licence asks is that changes *to this
library* stay free, and that your users can replace it with their own build.

