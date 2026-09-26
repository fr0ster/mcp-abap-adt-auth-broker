# Usage Guide

This guide provides API documentation and usage examples for the `@mcp-abap-adt/auth-broker` package.

## Basic Usage

### Import the Package

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
```

### Create AuthBroker Instance

The broker takes a session store, an optional service key store, and a
provider implementing `IRefreshableTokenProvider` — or a factory building one
per destination. Stores come from `@mcp-abap-adt/auth-stores`, providers from
`@mcp-abap-adt/auth-providers`.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  SafeAbapSessionStore,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import {
  AuthorizationCodeProvider,
  browserCallbackStrategy,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';

// ABAP (authorization_code). The factory is called once per destination with
// what the stores hold: UAA credentials plus the stored refresh token, and the
// connection config with serviceUrl and the stored token.
const abapBroker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore('/path/to/keys'),
  sessionStore: new AbapSessionStore('/path/to/sessions'),
  provider: (destination, authConfig, connConfig) => {
    if (!authConfig) throw new Error(`No UAA credentials for ${destination}`);
    return new AuthorizationCodeProvider({
      uaaUrl: authConfig.uaaUrl,
      clientId: authConfig.uaaClientId,
      clientSecret: authConfig.uaaClientSecret,
      refreshToken: authConfig.refreshToken,
      accessToken: connConfig.authorizationToken,
      authorization: browserCallbackStrategy({ browser: 'system' }),
    });
  },
});

// XSUAA (client_credentials)
const xsuaaBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys'),
  sessionStore: new XsuaaSessionStore('/path/to/sessions', 'https://mcp.example.com'),
  provider: (destination, authConfig) => {
    if (!authConfig) throw new Error(`No UAA credentials for ${destination}`);
    return new ClientCredentialsProvider({
      uaaUrl: authConfig.uaaUrl,
      clientId: authConfig.uaaClientId,
      clientSecret: authConfig.uaaClientSecret,
    });
  },
});

// In-memory session store (nothing on disk, lost on restart), provider instance
const memoryBroker = new AuthBroker({
  sessionStore: new SafeAbapSessionStore(undefined, 'https://abap.example.com'),
  provider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    authorization: browserCallbackStrategy({ browser: 'system' }),
  }),
});
```

`@mcp-abap-adt/auth-providers` providers implement `IRefreshableTokenProvider`
from 4.2.0.

## Store Methods

Stores provide methods to access configuration values through standardized interfaces:

```typescript
import { XsuaaSessionStore } from '@mcp-abap-adt/auth-stores';

const store = new XsuaaSessionStore('/path/to/sessions', 'https://mcp.example.com');

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

`--browser` and `--redirect-port` are routed into `browserCallbackStrategy` from
`@mcp-abap-adt/auth-providers`. This CLI has no default of its own for the callback port:
`--redirect-port` overrides it when given; omitted, the port comes from `auth-providers`
(currently `61001`, chosen to sit above the ephemeral range and clear of the `3001`/`3333` range
servers and proxies typically use). If you registered a redirect URI with a specific port at
your identity provider, pass `--redirect-port` to match it. A login is given 5 minutes to
complete (a person switching to a browser and signing in by hand, not an unattended caller).

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

## CLI: mcp-sso (SAML)

`mcp-sso` (and `mcp-auth saml2-pure`/`saml2-bearer`, which call it) validates every SAML
assertion through `@mcp-abap-adt/auth-providers` 4 before using it, and a SAML run does not start
without the trust it checks against:

- `--idp-metadata <url|path>` — the identity provider's SAML metadata, e.g.
  `https://<tenant>.accounts.ondemand.com/saml2/metadata` — or `--idp-cert <path>` (repeatable;
  PEM or DER) and `--idp-entity-id <id>`, or `idpCertificates` and `idpEntityId` in a `--config`
  file. Required for both `bearer` and `pure`.
- `--sp-entity-id` is the `Audience` the assertion must name, and `--acs-url` the `Recipient`.
  For `bearer` with `--service-key` both, and the token endpoint, are read from XSUAA's
  `<uaa.url>/saml/metadata`.
- `--idp-initiated` when the identity provider starts the login. `bearer` against UAA or XSUAA
  needs it: both refuse an assertion carrying `InResponseTo`. Use it with `--assertion`, or with
  `--assertion-flow manual` (its default), which asks for the `SAMLResponse` the identity
  provider posts; the browser flow has no URL to open and is refused.
- `--authn-request-id <id>` for an `--assertion` answering an SP-initiated request that
  `mcp-sso` did not send.

```bash
# With a service key: XSUAA's side from its metadata, the IdP's from the IdP's
mcp-sso bearer --service-key ./service-key.json \
  --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated \
  --output ./sso.env --type xsuaa

# Every value stated
mcp-sso bearer --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> \
  --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --idp-initiated \
  --token-endpoint https://uaa.example/oauth/token --assertion <base64> --output ./sso.env --type xsuaa
```

See the main README, *CLI: mcp-sso*, for every option, the `--config` fields and the migration
from 2.2.0.

## API Reference

### AuthBroker Class

#### Constructor

```typescript
constructor(
  config: {
    sessionStore: ISessionStore;
    serviceKeyStore?: IServiceKeyStore;
    provider: IRefreshableTokenProvider | TokenProviderFactory;
  },
  logger?: ILogger,
)

type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
) => IRefreshableTokenProvider;
```

**Parameters**:
- `config.sessionStore` — where tokens and the refresh token are kept.
- `config.serviceKeyStore` — optional; UAA credentials and the service URL.
- `config.provider` — a provider instance, used as given for every destination,
  or a factory called once per destination and seeded with:
  - `authConfig`: the session's UAA credentials, else the service key's,
    carrying the refresh token the session stored; `null` when neither store
    has credentials;
  - `connConfig`: the session's connection config with `serviceUrl` resolved
    and the token stored last.
- `logger` — optional `ILogger`; without one nothing is logged. No log line
  contains any part of a token.

There is no browser option and no `allowBrowserAuth`: how a login is conducted
is the provider's authorization strategy (see *Headless processes* below).

#### getToken()

```typescript
async getToken(destination: string): Promise<string>
```

1. Resolves `serviceUrl` from the session, else the service key — an error if
   neither has one, before the provider is asked.
2. Builds the provider on first use (factory) or uses the instance.
3. Calls `provider.getTokens()` once: the provider answers its cached token
   while valid, else refreshes, else logs in.
4. Persists the result: `sessionCookies` when `tokenType` is `'saml'`, else
   `authorizationToken`; the refresh token when the result carries one.
5. Returns the token.

#### refreshToken()

```typescript
async refreshToken(destination: string): Promise<string>
```

The same with `provider.refreshTokens()`: a new token, never the cached one.
Use it when the server refused the token `getToken()` returned (401/403).

#### getAuthorizationConfig() / getConnectionConfig()

```typescript
async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>
async getConnectionConfig(destination: string): Promise<IConnectionConfig | null>
```

The session's configuration, else the service key's, else `null`.

#### createTokenRefresher()

```typescript
createTokenRefresher(destination: string): ITokenRefresher
```

`getToken()` and `refreshToken()` bound to one destination, for injection into
a connection that refreshes on 401.

## Usage Examples

### Headless processes

A process nobody is watching gives the provider a strategy that refuses, and
catches its own error; the broker hands it back unchanged:

```typescript
class LoginRequiredError extends Error {}

const broker = new AuthBroker({
  sessionStore,
  serviceKeyStore,
  provider: (destination, authConfig, connConfig) =>
    new AuthorizationCodeProvider({
      uaaUrl: authConfig!.uaaUrl,
      clientId: authConfig!.uaaClientId,
      clientSecret: authConfig!.uaaClientSecret,
      refreshToken: authConfig!.refreshToken,
      accessToken: connConfig.authorizationToken,
      authorization: {
        authorize: async () => {
          throw new LoginRequiredError(`Log in to ${destination} with mcp-auth first`);
        },
      },
    }),
});

try {
  const token = await broker.getToken('TRIAL');
} catch (error) {
  if (error instanceof LoginRequiredError) {
    // Neither a valid token nor a usable refresh token: a person must log in.
  }
}
```

### Refresh after a 401

```typescript
let token = await broker.getToken('TRIAL');
let response = await call(token);
if (response.status === 401) {
  token = await broker.refreshToken('TRIAL');
  response = await call(token);
}
```

### Multiple destinations

One broker serves many destinations; a factory builds one provider per
destination and reuses it.

```typescript
const tokens = await Promise.all(
  ['TRIAL', 'PRODUCTION'].map((destination) => broker.getToken(destination)),
);
```

## Error Handling

- **Provider errors propagate unchanged** — the same object, with its class,
  `code`, `missingFields` and `cause`: `ValidationError`, `RefreshError`,
  `AssertionValidationError` from `@mcp-abap-adt/auth-providers`, network
  errors (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`), and whatever the
  authorization strategy throws. The broker does not retry.
- **Missing service URL**: `Session for destination "<name>" is missing required
  field 'serviceUrl'` — neither the session nor the service key has one.
- **No token in the provider's result**: `Token provider did not return
  authorization token for destination "<name>"`.
- **Store reads**: `null` or `FILE_NOT_FOUND` means absent and the broker tries
  the next source; any other store failure (an invalid or unreadable service
  key, for instance) is thrown unchanged. **Store writes** that fail propagate.

```typescript
import { ValidationError } from '@mcp-abap-adt/auth-providers';

try {
  await broker.getToken('TRIAL');
} catch (error) {
  if (error instanceof ValidationError) {
    // error.missingFields names what the provider config lacks
  }
  throw error;
}
```

## Secrets

The broker writes the token (or session cookies) and the refresh token to the
session store, never the client secret: credentials from the service key stay
there. A session holding credentials of its own keeps them; only its refresh
token is updated. `mcp-auth`, `mcp-sso` and `npm run generate-env` do write the
secret into the file they produce, on purpose: that file is a self-contained
session read with no service key beside it.

The session stores return a refresh token stored without credentials through
`loadSession()`, which the broker reads — the XSUAA stores from auth-stores
1.2.3.

## Logging

Pass an `ILogger` as the constructor's second argument (for instance
`DefaultLogger` from `@mcp-abap-adt/logger`). The broker logs its
initialization, each provider build (whether credentials, a refresh token and
a stored token were there), each saved token (type, grant, expiry, whether a
refresh token came back) and store read failures. It never logs any part of a
token or secret.

## Best Practices

1. **Pass a factory** when the stores hold the credentials, so the provider is
   seeded with the stored refresh token and token instead of logging in again.
2. **Headless**: give the provider a refusing strategy and catch your own error.
3. **On 401**: call `refreshToken()`, not `getToken()`.
4. **Storage**: use `AbapSessionStore`/`XsuaaSessionStore` for persistence
   across restarts, `SafeAbapSessionStore`/`SafeXsuaaSessionStore` to keep
   tokens in memory only.
5. **Never commit** `.env` or service key `.json` files.

## Next Steps

- See [Installation Guide](../installing/INSTALLATION.md) for setup instructions
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development guide
