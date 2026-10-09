# Usage Guide

This guide shows how to use `@mcp-abap-adt/auth-broker` (5.0.0) and its command
(`@mcp-abap-adt/auth-broker-cli` 3.0.0). The full API is the
[library README](../../packages/auth-broker/README.md); every flag of `mcp-auth` is in the
[CLI README](../../packages/auth-broker-cli/README.md). Coming from 4.x: *Migrating to 5.0.0* in
the library README; from CLI 2.x: *Migrating to 3.0.0* in the CLI README.

## A Broker for a Connector

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  browserCallbackStrategy,
  consoleDeviceCodePresenter,
  defaultReplayStore,
  linuxDefaultBrowser,
  refreshThenLogin,
  samlCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';
import { AbapSessionStore, EnvDestinationStore } from '@mcp-abap-adt/auth-stores';

const browser = linuxDefaultBrowser();

const broker = new AuthBroker(
  {
    serviceKeyStore: new EnvDestinationStore('/path/to/destinations'), // the means
    sessionStore: new AbapSessionStore('/path/to/sessions'),           // the secret
    renewal: () => refreshThenLogin(), // required by every token destination
    onWriteFailure: 'continue',        // required wherever a secret is written
    // The collaborators: each a function of the destination, called once per build, never
    // disposed by the broker, required only by the grants that use it.
    authorization: (destination, grant) =>
      grant === 'saml2_pure' || grant === 'saml2_bearer'
        ? samlCallbackStrategy({ browser })
        : browserCallbackStrategy({ browser }),
    deviceCodePresenter: () => consoleDeviceCodePresenter(logger),
    samlCookies: (destination) => (samlResponse) => postToAcs(destination, samlResponse),
    assertionReplayStore: () => defaultReplayStore,
  },
  logger,
);

const session = new AbortController(); // abort it when the connector's session closes

const basic = await broker.getProvider('DEV', { signal: session.signal });   // BasicAuthProvider
const snc = await broker.getProvider('PRD', { signal: session.signal });     // SncLogonProvider
const trial = await broker.getProvider('TRIAL', { signal: session.signal }); // AuthorizationCodeProvider
const idp = await broker.getProvider('IDP', { signal: session.signal });     // OidcDeviceFlowProvider
const sso = await broker.getProvider('SSO', { signal: session.signal });     // Saml2PureProvider
```

The destinations, stated as means in `EnvDestinationStore`'s `<directory>/<destination>.env`:

```bash
# DEV.env — basic
SAP_URL=https://abap.example.com:44300
SAP_AUTH_TYPE=basic
SAP_USERNAME=DEVELOPER
SAP_PASSWORD=...

# PRD.env — SNC over RFC, through the Secure Login Client
SAP_AUTH_TYPE=snc
SAP_SNC_PARTNERNAME=p:CN=PRD, O=ACME
SAP_SNC_QOP=9

# TRIAL.env — BTP ABAP environment, UAA authorization code
SAP_URL=https://<id>.abap.us10.hana.ondemand.com
SAP_AUTH_TYPE=jwt
SAP_GRANT_TYPE=authorization_code
SAP_UAA_URL=https://<subdomain>.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=...
SAP_UAA_CLIENT_SECRET=...

# IDP.env — an OIDC identity provider, device code, a public client
SAP_URL=https://my-abap.example.com
SAP_AUTH_TYPE=jwt
SAP_GRANT_TYPE=device_code
SAP_OIDC_ISSUER_URL=https://idp.example.com/realms/sap
SAP_OIDC_SCOPES=openid
SAP_UAA_CLIENT_ID=abap-cli
SAP_UAA_CLIENT_SECRET=

# SSO.env — SAML, the system's session cookies
SAP_URL=https://my-abap.example.com
SAP_AUTH_TYPE=saml
SAP_GRANT_TYPE=saml2_pure
SAP_SAML_IDP_SSO_URL=https://idp.example.com/saml/sso
SAP_SAML_IDP_ENTITY_ID=https://idp.example.com
SAP_SAML_IDP_CERTIFICATES_B64=<each certificate base64-encoded, comma-separated>
SAP_SAML_SP_ENTITY_ID=https://my-abap.example.com
SAP_SAML_ACS_URL=https://my-abap.example.com/sap/saml2/sp/acs/100
```

The table of every `authType` / `grantType` row, what it reads and the provider it builds is in
the library README, *A Provider for a Connector*.

## What Happens on Each Call

- **The means are re-read on every call.** The broker compares everything the destination's
  provider was built from; unchanged, the cached provider; anything changed — a URL, a client
  id, a scope, a certificate, a password — a new provider that starts with nothing and logs in.
- **A stored secret is reused only when bound exactly.** The session's `issuedFor` and the
  versioned `issuedBy` record must equal what the current means give. A session written before
  5.0.0 reads as unbound once: one login per token destination after upgrading.
- **Every token a provider obtains is written** before it answers, one write at a time per
  destination; what a failed write means is your `onWriteFailure` (`'fail'`: the call fails, and
  the destination's calls are refused until a write lands; `'continue'`: logged). Nothing retries
  a pending write on its own: call `flush()` on shutdown.
- **Every wait can be cancelled** by its own caller's signal; the broker sets no timeout. A
  connector session's signal, given to `getProvider`, also aborts a login its provider starts
  later, once every session holding it has aborted.

```typescript
process.on('SIGTERM', async () => {
  try {
    await broker.flush({ signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    logger.error('Some session writes are still pending');
  }
  process.exit(0);
});
```

## The Token API

For a consumer that wants a token and nothing else:

```typescript
// The provider's current token: cached while valid, else renewed as its strategy says.
let token = await broker.getToken('TRIAL', { signal });
let response = await call(token);
if (response.status === 401) {
  // A new token, never the cached one; a renewal already in flight is joined.
  token = await broker.refreshToken('TRIAL', { signal });
  response = await call(token);
}

// For a connection of your own that asks for a token per request.
const refresher = broker.createTokenRefresher('TRIAL', { signal });
```

Without a `provider` option the token API asks the destination's own provider — the one
`getProvider` hands out — so a connector and the token API share one token and one renewal. With
one, it asks yours: a factory is handed the destination's means and client, never a stored
secret, and the broker writes every answer. See *Getting Tokens* in the library README.

## Headless Processes

A process nobody is watching (an MCP server on stdio, a CI job) never logs in:

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { refreshOnly } from '@mcp-abap-adt/auth-providers';

const headless = new AuthBroker({
  serviceKeyStore: myKeyStore,
  sessionStore: mySessionStore,
  renewal: () => refreshOnly(), // refresh, never a login
  onWriteFailure: 'continue',
  authorization: () => ({
    authorize: async (): Promise<never> => {
      throw new Error('Run mcp-auth to log in');
    },
  }),
});
```

The provider runs on its stored secret and refresh token; when neither serves, `prepare()` /
`rejected()` answer Oops and the token API rejects with the provider's failure. Run `mcp-auth`
for the destination once to log in.

## Reading a Failure

```typescript
import { isDestinationConfigError } from '@mcp-abap-adt/auth-broker';
import { isAuthProviderFailure, readFailure } from '@mcp-abap-adt/auth-errors';

try {
  await broker.getProvider('DEV');
} catch (error) {
  if (isDestinationConfigError(error)) {
    // Names only, e.g. ['password'], ['renewal'], ['grantType'], ['deviceCodePresenter'];
    // error.error is the provider's failure when one caused the refusal.
    logger.error(`${error.destination} lacks: ${error.missingFields.join(', ')}`);
  } else if (isAuthProviderFailure(error)) {
    const failure = readFailure(error, 'token-source');
    logger.error(`${failure.kind}: ${failure.reason}`);
  }
  throw error;
}
```

A provider's failure reaches you as the same object; a store's read failure as the store raised
it. The broker's refusals carry names, never values; nothing it throws or logs carries a token,
a refresh token, a client secret, a URL or a server's text.

## A Client Certificate: `clientAuthentication`

A client that authenticates with an x509 certificate instead of a secret — an XSUAA service key
created with `{"credential-type": "x509"}` — is used only when you say so:

```typescript
import {
  AuthBroker,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import {
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';

const x509Broker = new AuthBroker({
  // The URL in <dir>/mcp.env (XSUAA_MCP_URL), the client from the x509 key.
  serviceKeyStore: new EnvDestinationStore('/path/to/destinations', {
    variables: XSUAA_DESTINATION_VARS,
    fallback: new XsuaaServiceKeyStore('/path/to/keys', {
      grantType: 'client_credentials',
    }),
  }),
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
  renewal: () => refreshThenLogin(),
  onWriteFailure: 'fail',
  // The certificate when the key holds one, else the secret (XSUAA: raw) — decided by what
  // the key holds; a bad certificate is refused, never replaced by the secret.
  clientAuthentication: async (context) =>
    (await context.readCertificate())
      ? fromServiceKeyCertificate()(context)
      : fromServiceKeySecret({ encoding: 'raw' })(context),
});

const certificateProvider = await x509Broker.getProvider('mcp');
```

The rules, the factories, the `.env` variables and what is measured: *How the Client
Authenticates* in the
[library README](../../packages/auth-broker/README.md#how-the-client-authenticates-clientauthentication).

## Store Methods

Stores answer through the contracts of `@mcp-abap-adt/interfaces-auth-broker`, each for its role
(auth-stores 4):

```typescript
import { XsuaaServiceKeyStore, XsuaaSessionStore } from '@mcp-abap-adt/auth-stores';

const keys = new XsuaaServiceKeyStore('/path/to/keys', { grantType: 'client_credentials' });
const sessions = new XsuaaSessionStore('/path/to/sessions');

// The means: the client and the destination's connection fields.
const client = await keys.getAuthorizationConfig('mcp');
const means = await keys.getConnectionConfig('mcp');

// An x509 key's client — url, clientid, certificate, key, certurl; getAuthorizationConfig
// answers null for it. null for a secret key.
const certificateClient = await keys.getClientCertificate('mcp');

// The secret: the token, its expiry, the refresh token, and its binding.
const secret = await sessions.loadSession('mcp');
```

A session store of your own must keep `issuedFor` and `issuedBy` beside the secret, byte for
byte, take `refreshToken: ''` as clearing the stored one, and settle every `saveSession`:

```typescript
import type { IConfig, ISessionStore } from '@mcp-abap-adt/auth-broker';

declare const db: {
  get(key: string): Promise<IConfig | null>;
  merge(key: string, value: Partial<IConfig>): Promise<void>; // resolves or rejects, always
};

const dbSessionStore: Pick<ISessionStore, 'loadSession' | 'saveSession'> = {
  loadSession: (destination) => db.get(destination),
  // The contract types the write as `IConfig | unknown`: the broker writes an IConfig.
  saveSession: (destination, config) => db.merge(destination, config as IConfig),
};
```

### Environment Variables

auth-stores 4 exports its key names, each table for one role:

- **The secret** — `ABAP_SESSION_VARS` (`AbapSessionStore`, `EnvFileSessionStore`):
  `SAP_JWT_TOKEN`, `SAP_SESSION_COOKIES_B64`, `SAP_EXPIRES_AT`, `SAP_REFRESH_TOKEN`,
  `SAP_ISSUED_FOR`, `SAP_ISSUED_BY`; `XSUAA_SESSION_VARS` (`XsuaaSessionStore`) the `XSUAA_*`
  equivalents. The broker writes these and nothing else.
- **The means** — `ABAP_DESTINATION_VARS` (`EnvDestinationStore`): `SAP_URL`, `SAP_CLIENT`,
  `SAP_LANGUAGE`, `SAP_AUTH_TYPE`, `SAP_GRANT_TYPE`, the user and password, the `SAP_SNC_*`,
  `SAP_OIDC_*` and `SAP_SAML_*` fields, and the client (`SAP_UAA_URL`, `SAP_UAA_CLIENT_ID`,
  `SAP_UAA_CLIENT_SECRET`, or — a certificate client — `SAP_UAA_CLIENT_CERT_PATH`,
  `SAP_UAA_CLIENT_KEY_PATH`, `SAP_UAA_CERT_URL`: paths and a URL, never PEM, and no secret);
  `XSUAA_DESTINATION_VARS` for the `XSUAA_*` files. The broker never writes them.
- `SAP_UAA_BASIC_ENCODING` / `XSUAA_UAA_BASIC_ENCODING` is a line the `mcp-auth` command writes
  and reads for itself (`--basic-encoding`); neither store nor the broker reads it.

The library reads no environment variable itself; `authDebug` is an option.

## The `mcp-auth` Command

`@mcp-abap-adt/auth-broker-cli` (`npm i -g @mcp-abap-adt/auth-broker-cli`) writes a destination
the broker reads — its means through `EnvDestinationStore`, the secret through the broker's
persistence, both in one `<destination>.env` (`XSUAA_*` keys with `--type xsuaa`) — and copies
the output only once `flush()` reports the secret stored.

```bash
# A service key: always a new login, written to --output
mcp-auth --service-key ./abap.json --output ./abap.env --type abap
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --credential

# A session file: its valid token reused, refreshed, or a login — written back
mcp-auth --env ./mcp.env --type xsuaa

# A destination of the destination folder (--destination-dir, AUTH_BROKER_PATH, ~/.config/mcp-abap-adt)
mcp-auth --destination TRIAL --type abap

# OIDC, the UAA passcode, SAML
mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
mcp-auth oidc --flow password --uaa-url https://<subdomain>.authentication.<region>.hana.ondemand.com --client-id cf --passcode <code> --output ./sso.env --type xsuaa
mcp-auth saml2-bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa
```

A login waits until it finishes or you end it (Ctrl+C: exit 130); the browser is the platform's
default unless `--browser` / `--browser-program` say otherwise; stdout carries only `help` and
`--version`. Every flag, the browser table, the SAML trust and the migration from 2.x: the
[CLI README](../../packages/auth-broker-cli/README.md).

## Next Steps

- See [Installation Guide](../installing/INSTALLATION.md) for setup instructions
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development guide
