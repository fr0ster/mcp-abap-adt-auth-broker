# Usage Guide

This guide provides API documentation and usage examples for the `@mcp-abap-adt/auth-broker` package (4.1.0) and its commands (`@mcp-abap-adt/auth-broker-cli` 2.1.0). Coming from 4.0.0 or 3.x: *Migrating from 4.0.0* and *Migrating from 3.x* in the [library README](../../packages/auth-broker/README.md#migrating-from-400).

## Basic Usage

### Import the Package

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
```

### Create AuthBroker Instance

For the token API with a provider of your own (the 3.x way, which keeps
working), the broker takes a session store, an optional service key store,
and a provider implementing `IRefreshableTokenProvider` — or a factory
building one per destination. Stores come from `@mcp-abap-adt/auth-stores`
(3.x: the means in a key store, the secret alone in a session store),
providers from `@mcp-abap-adt/auth-providers`. Without a provider, see *A
Provider for a Connector* and *The token API*.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  EnvDestinationStore,
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
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
  provider: (destination, authConfig) => {
    if (!authConfig) throw new Error(`No UAA credentials for ${destination}`);
    return new ClientCredentialsProvider({
      uaaUrl: authConfig.uaaUrl,
      clientId: authConfig.uaaClientId,
      clientSecret: authConfig.uaaClientSecret,
    });
  },
});

// In-memory session store (nothing on disk, lost on restart), provider
// instance; the URL is means, stated in <keys>/<destination>.env as SAP_URL.
const memoryBroker = new AuthBroker({
  serviceKeyStore: new EnvDestinationStore('/path/to/destinations'),
  sessionStore: new SafeAbapSessionStore(),
  provider: new AuthorizationCodeProvider({
    uaaUrl: 'https://auth.example.com',
    clientId: '...',
    clientSecret: '...',
    authorization: browserCallbackStrategy({ browser: 'system' }),
  }),
});
```

`@mcp-abap-adt/auth-providers` 5 providers implement `IRefreshableTokenProvider`
(from `@mcp-abap-adt/interfaces-auth` 3).

## A Provider for a Connector: `getProvider`

`getProvider(destination)` returns the `IAuthProvider` the destination states,
for a `@mcp-abap-adt/connection` 10 connector. The **service key store**
answers the means — `authType`, `grantType`, the user and password, the SNC
fields, the UAA client — and the **session store** the secret; neither is read for the
other's fields, and nothing is inferred from which fields are present. No
`provider` option is needed: that one is the token API's, and `getProvider`
never uses it. Without it, the token API asks the provider `getProvider`
builds (see *The token API*).

With auth-stores 3.0.0, the means of a destination that has no SAP service key
live in `EnvDestinationStore` (`<directory>/<destination>.env`):

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
SAP_SNC_LIB=C:\Program Files\SAP\FrontEnd\SecureLogin\lib\sapcrypto.dll

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
SAP_UAA_URL=https://idp.example.com/realms/sap
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

```typescript
import { AuthBroker, DestinationConfigError } from '@mcp-abap-adt/auth-broker';
import { AbapSessionStore, EnvDestinationStore } from '@mcp-abap-adt/auth-stores';

import {
  browserCallbackStrategy,
  consoleDeviceCodePresenter,
  defaultReplayStore,
  samlCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';

const broker = new AuthBroker(
  {
    serviceKeyStore: new EnvDestinationStore('/path/to/destinations'),
    sessionStore: new AbapSessionStore('/path/to/sessions'),
    // The collaborators: each a function of the destination, called once per
    // destination's build, never disposed by the broker, required only by the
    // grants that use it.
    authorization: (destination, grant) =>
      grant === 'saml2_pure' || grant === 'saml2_bearer'
        ? samlCallbackStrategy()
        : browserCallbackStrategy(),
    deviceCodePresenter: () => consoleDeviceCodePresenter(logger),
    samlCookies: (destination) => (samlResponse) =>
      postToAcs(destination, samlResponse), // yours: returns the Set-Cookie values
    assertionReplayStore: () => defaultReplayStore,
  },
  logger,
);

const basic = await broker.getProvider('DEV');   // BasicAuthProvider: header over HTTP, user/passwd over RFC
const snc = await broker.getProvider('PRD');     // SncLogonProvider: snc_* logon parameters after prepare()
const trial = await broker.getProvider('TRIAL'); // AuthorizationCodeProvider, seeded from TRIAL's session
const idp = await broker.getProvider('IDP');     // OidcDeviceFlowProvider: the code through the presenter
const sso = await broker.getProvider('SSO');     // Saml2PureProvider: validated SAML → cookies
```

| `authType` / `grantType` | Provider | Needs |
|---|---|---|
| `basic` | `BasicAuthProvider` | `username`, `password` in the key store |
| `snc` | `SncLogonProvider.forSecureLoginClient` | `sncPartnerName` in the key store; `sncQop`, `sncLib`, `sncMyName` when set (absent: `qop` `'9'`, the library discovered, the name from the credential) |
| `jwt` / `authorization_code` | `AuthorizationCodeProvider` | `uaaUrl`, `uaaClientId`, `uaaClientSecret` in the key store; the `authorization` option; seeded from the session (token, refresh token, `expiresAt`) when there is one bound to this destination (below) |
| `jwt` / `client_credentials` | `ClientCredentialsProvider` | `uaaUrl`, `uaaClientId`, `uaaClientSecret` in the key store; not seeded |
| `jwt` / `passcode` | `UaaPasscodeProvider` | `uaaUrl`, `uaaClientId` (`uaaClientSecret` `''` is a public client) in the key store; the `authorization` option, handed `<uaaUrl>/passcode`; seeded like `authorization_code` |
| `jwt` / `oidc_authorization_code` | `OidcBrowserProvider` | `uaaClientId` (`uaaClientSecret` `''` is a public client); `oidcIssuerUrl`, or `oidcAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; the `oidcAuthorization` option; seeded like `authorization_code` |
| `jwt` / `device_code` | `OidcDeviceFlowProvider` | the client as above; `oidcIssuerUrl`, or `oidcDeviceAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; the `deviceCodePresenter` option; seeded |
| `jwt` / `password` | `OidcPasswordProvider` | the client as above; `username`, `password`; `oidcIssuerUrl`, or `oidcTokenEndpoint`; `oidcScopes`; seeded |
| `jwt` / `token_exchange` | `OidcTokenExchangeProvider` | the client as above; `oidcSubjectToken`, `oidcSubjectTokenType` (`oidcAudience`, `oidcActorToken`, `oidcActorTokenType` when set); `oidcScopes`, joined by a space; `oidcIssuerUrl`, or `oidcTokenEndpoint`; seeded (no refresh: a renewal exchanges again) |
| `saml` / `saml2_pure` | `Saml2PureProvider` | `samlIdpSsoUrl`, `samlSpEntityId`, `samlIdpEntityId`, `samlIdpCertificates` (`samlAcsUrl`, `samlRelayState`, `samlIdpInitiated`, `samlClockSkewMs` when set); the `authorization`, `samlCookies` and `assertionReplayStore` options; seeded from the stored cookies and `expiresAt`; the Response must be signed |
| `saml` / `saml2_bearer` | `Saml2BearerProvider` | the same SAML fields, `samlTokenUrl` when set; `uaaUrl`, `uaaClientId` (`uaaClientSecret` `''` a public client); the `authorization` and `assertionReplayStore` options; seeded like `authorization_code`; the Assertion must be signed |
| `jwt` / `none` | `TokenAuthProvider.fixed` | `serviceUrl` in the key store; `authorizationToken` and a matching `issuedFor` in the session store (and `issuedBy`, when the means state an issuer) |
| `saml` / `none` | `SamlAuthProvider` | `serviceUrl` in the key store; `sessionCookies` and a matching `issuedFor` in the session store (and `issuedBy`, when `samlAcsUrl` is stated) |

No provider reads `serviceUrl`: it is where the connector connects, not
authorization data. Take the connector's URL from your key store's
`getConnectionConfig`. The broker reads it, with `sapClient`, only to bind a
stored secret to its resource.

### A stored secret is used only where it is bound

Beside the secret, the session store keeps `issuedFor` — the resource it was
obtained for, `serviceUrl` with `sap-client` — and `issuedBy` — who issued it
to which client: `uaaUrl` with `client_id` (UAA grants, `saml2_bearer`),
`oidcIssuerUrl` (else `uaaUrl`) with `client_id` (OIDC grants), or the ACS,
`samlAcsUrl`, for `saml2_pure`'s cookies. The broker computes both from the
destination's means, canonicalises both sides (scheme and host lower-cased,
the port explicit, no trailing `/`, only `sap-client` / `client_id` kept and
re-encoded) and compares:

- **The grants that obtain a secret** (UAA, OIDC, SAML): both equal → the session seeds the provider. Otherwise the
  secret is not used, refresh token included: the provider logs in afresh,
  the log says only `<destination>: secret bound to another resource,
  discarded`, and the new secret is written with this destination's binding.
  A destination without `serviceUrl` gets its provider, but never reuses a
  stored secret.
- **`none`:** a stored `issuedFor` that is not the destination's (or none) is
  `DestinationConfigError` naming `issuedFor`; when the means state an issuer
  (`oidcIssuerUrl` or the client for `jwt`, `samlAcsUrl` for `saml`), the same
  for `issuedBy`.

```typescript
// A session store of your own must keep both fields with the secret:
async saveSession(destination, config) {
  await db.put(destination, {
    token: config.authorizationToken,
    expiresAt: config.expiresAt,
    refreshToken: config.refreshToken,
    issuedFor: config.issuedFor, // without these two the broker never
    issuedBy: config.issuedBy,   // reuses a session: a login every start
  });
}
```

Session files written before `@mcp-abap-adt/auth-stores` 3.1.0 keep working:
its stores answer the binding from the file's `SAP_URL` (+ `SAP_CLIENT`) and
`SAP_UAA_URL` + `SAP_UAA_CLIENT_ID`. A headless process whose strategy refuses
logins answers Oops on a mismatch rather than present a foreign secret.

A destination that lacks what its type needs throws `DestinationConfigError`,
naming the fields — never their values:

```typescript
try {
  await broker.getProvider('DEV');
} catch (error) {
  if (error instanceof DestinationConfigError) {
    // e.g. error.missingFields: ['password'], or ['authType'] when the key
    // store has nothing for the destination, ['grantType'] for a jwt / saml
    // destination that states none, ['deviceCodePresenter'] for a device_code
    // destination built without that option
  }
  throw error;
}
```

The broker builds one provider per destination and keeps it: concurrent first
calls share one build, a build that threw is retried on the next call, and a
destination rewritten on disk is picked up by a new broker.

### What a provider obtains is stored; `flush()`

A token provider `getProvider` built writes every token it obtains — at
`prepare()`, on expiry, or in `rejected()` after a 401 — to the session store
before it answers: `{ authorizationToken, expiresAt, refreshToken, issuedFor,
issuedBy }` in one `saveSession` (`saml2_pure`'s cookies as `{ sessionCookies,
expiresAt, issuedFor, issuedBy }`; `saml2_bearer`'s token as a token), the
stored refresh token kept when the result has none (and it is bound here),
and nothing else — no URL field, no
`authType`, no client. The key store is never
written. `basic`, `snc` and `none` obtain nothing and write nothing.

A write the store refuses does not fail the authentication: the broker retries
it on its own (one second, doubling, capped at a minute, on a timer that does
not keep the process alive), and only the latest result per destination is
written. Before the process ends, ask whether everything landed:

```typescript
try {
  await broker.flush(); // one more attempt for each pending write
} catch (error) {
  // AggregateError: the message names the destinations still not stored
}
```

## A client certificate: `clientAuthentication`

A client that authenticates with an x509 certificate instead of a secret — an
XSUAA service key created with `{"credential-type": "x509"}` — is used only
when you say so, with a strategy; the broker never infers it from the key:

```typescript
import {
  AuthBroker,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '@mcp-abap-adt/auth-broker';
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
  // The certificate when the key holds one, else the secret (XSUAA: raw) —
  // decided by what the key holds; a bad certificate is refused, never
  // replaced by the secret.
  clientAuthentication: async (context) =>
    (await context.readCertificate())
      ? fromServiceKeyCertificate()(context)
      : fromServiceKeySecret({ encoding: 'raw' })(context),
});

const certificateProvider = await x509Broker.getProvider('mcp');
```

The strategy applies to every grant whose client authenticates (the UAA and
OIDC grants, `saml2_bearer`), and to the token API's factory, which then gets a
fourth argument (`TokenProviderClient`). On that path a secret is bound to the
client's identity, and stored secrets reach a provider only when bound. Without
a strategy everything is 4.0.0's. A failing strategy is a
`DestinationConfigError` naming `clientAuthentication`, in fixed words. The
whole rule set, the factories, the `.env` variables and what is measured:
*How the Client Authenticates* in the
[library README](../../packages/auth-broker/README.md#how-the-client-authenticates-clientauthentication).

## Store Methods

Stores answer through the contracts of `@mcp-abap-adt/interfaces-auth-broker`,
each for its role (auth-stores 3):

```typescript
import { XsuaaServiceKeyStore, XsuaaSessionStore } from '@mcp-abap-adt/auth-stores';

const keys = new XsuaaServiceKeyStore('/path/to/keys', {
  grantType: 'client_credentials',
});
const sessions = new XsuaaSessionStore('/path/to/sessions');

// The means: the client and the destination's connection fields.
const client = await keys.getAuthorizationConfig('mcp');
// client.uaaUrl, client.uaaClientId, client.uaaClientSecret
const means = await keys.getConnectionConfig('mcp');
// means.authType, means.grantType, means.serviceUrl (XSUAA: the key's url)

// auth-stores 3.3.0: an x509 key's client — url, clientid, certificate, key,
// certurl; getAuthorizationConfig answers null for it. null for a secret key.
const certificateClient = await keys.getClientCertificate('mcp');

// The secret: the token, its expiry, the refresh token, and its binding.
const secret = await sessions.loadSession('mcp');
// secret.authorizationToken, secret.expiresAt, secret.refreshToken,
// secret.issuedFor, secret.issuedBy — and no client, no URL
```

### Environment Variables

auth-stores 3 exports its key names, each table for one role:

- **The secret** — `ABAP_SESSION_VARS` (`AbapSessionStore`,
  `EnvFileSessionStore`): `SAP_JWT_TOKEN`, `SAP_SESSION_COOKIES_B64`,
  `SAP_EXPIRES_AT`, `SAP_REFRESH_TOKEN`, `SAP_ISSUED_FOR`, `SAP_ISSUED_BY`;
  `XSUAA_SESSION_VARS` (`XsuaaSessionStore`) the `XSUAA_*` equivalents. The
  broker writes these and nothing else.
- **The means** — `ABAP_DESTINATION_VARS` (`EnvDestinationStore`): `SAP_URL`,
  `SAP_CLIENT`, `SAP_LANGUAGE`, `SAP_AUTH_TYPE`, `SAP_GRANT_TYPE`, the user
  and password, the `SAP_SNC_*`, `SAP_OIDC_*` and `SAP_SAML_*` fields, and the
  client (`SAP_UAA_URL`, `SAP_UAA_CLIENT_ID`, `SAP_UAA_CLIENT_SECRET`, or —
  a certificate client, auth-stores 3.3.0 — `SAP_UAA_CLIENT_CERT_PATH`,
  `SAP_UAA_CLIENT_KEY_PATH`, `SAP_UAA_CERT_URL`: paths and a URL, never PEM,
  and no secret); `XSUAA_DESTINATION_VARS` for the `XSUAA_*` files. The broker
  never writes them.

A session file written by the 3.x broker or CLI holds both in one file; point
an `EnvDestinationStore` at it for the means, and a session store for the
secret.

## CLI: mcp-auth

The commands in this section and the next are `@mcp-abap-adt/auth-broker-cli`
(`packages/auth-broker-cli`, `npm i -g @mcp-abap-adt/auth-broker-cli`); up to
3.0.4 they shipped in `@mcp-abap-adt/auth-broker`. Their
[README](../../packages/auth-broker-cli/README.md) has every option.

Use `mcp-auth` to write a destination from a service key: its means through
`EnvDestinationStore.setDestination` (`SAP_AUTH_TYPE=jwt`, `SAP_GRANT_TYPE`,
the key's client, `SAP_URL`), then a login through the broker's token API with
the command's own provider, which stores the secret alone (token, expiry,
refresh token, `SAP_ISSUED_FOR` / `SAP_ISSUED_BY`) through the session store —
both in one `<destination>.env`, `XSUAA_*` with `--type xsuaa`. The output is
written once `flush()` reports the secret stored; otherwise the command exits 1.

```bash
mcp-auth --service-key <path> --output <path> [--env <path>] [--type abap|xsuaa] [--credential] [--browser auto|none|system|chrome|edge|firefox] [--format json|env]
         [--client-auth certificate --cert-path <path> --key-path <path> | --client-auth secret --basic-encoding raw|form]
```

**Client authentication (2.1.0):** no `--client-auth` is the client secret, as
before; `--client-auth secret --basic-encoding raw|form` the secret in a Basic
header; `--client-auth certificate --cert-path <path> --key-path <path>` an x509
key's certificate client, from your own PEM files, which the destination names
by absolute path (`SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH`,
`SAP_UAA_CERT_URL`, `XSUAA_UAA_*` with `--type xsuaa`). An x509 key without
`--client-auth` is refused; no key material is ever copied. See *Client
authentication* in the CLI's README.

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
- If `--env` is provided and exists, it is the starting point: its refresh token
  is attempted first, and its means are kept where the run does not restate them.
- If refresh fails (or env is missing), the grant the command states logs in.
- The grant is the command's (`--credential` or not), never read from the key.

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

# XSUAA x509 key: client_credentials with the client certificate
mcp-auth --service-key ./x509-key.json --output ./mcp.env --type xsuaa --credential --client-auth certificate --cert-path ./client.crt --key-path ./client.key

# Using existing .env for refresh token
mcp-auth --env ./mcp.env --service-key ./mcp.json --output ./mcp.env --type xsuaa
```

## CLI: mcp-sso

`mcp-sso` writes the destination its flow states — `jwt` / `oidc_authorization_code`,
`device_code`, `password`, `passcode` (`--flow password --passcode`), `token_exchange`;
`saml` / `saml2_pure`, `saml2_bearer`, or `none` for `--cookie` — then asks the broker for that
destination's provider (`getProvider`), handing it every collaborator explicitly: the OIDC
browser, passcode and SAML strategies, the device-code presenter on its logger, the SAML cookie
function and the process-wide replay store. The table of what each flow writes is in the
[CLI's README](../../packages/auth-broker-cli/README.md#what-each-command-writes-and-where).

### SAML

`mcp-sso` (and `mcp-auth saml2-pure`/`saml2-bearer`, which call it) validates every SAML
assertion through `@mcp-abap-adt/auth-providers` 5 before using it, and a SAML run does not start
without the trust it checks against. `mcp-sso` writes that trust into the destination
(`SAP_SAML_IDP_CERTIFICATES_B64`, `SAP_SAML_IDP_ENTITY_ID`) and the broker builds the validator
from it: `bearer` requires the `Assertion` signed (the token endpoint gets the Assertion alone),
`pure` the `Response`; a replay is refused within the process:

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
- `--authn-request-id` is refused from 2.0.0: a destination cannot state a request ID, so an
  `--assertion` answering a request `mcp-sso` did not send cannot be validated.
- `bearer` writes its client: `--uaa-url` and `--client-id`, or `--service-key`.

```bash
# With a service key: XSUAA's side from its metadata, the IdP's from the IdP's
mcp-sso bearer --service-key ./service-key.json \
  --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated \
  --output ./sso.env --type xsuaa

# Every value stated
mcp-sso bearer --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> \
  --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --idp-initiated \
  --uaa-url https://uaa.example --client-id <client> \
  --token-endpoint https://uaa.example/oauth/token/alias/<alias> --assertion <base64> --output ./sso.env --type xsuaa
```

See the [CLI's README](../../packages/auth-broker-cli/README.md), *CLI: mcp-sso*, for every
option, the `--config` fields, the migration from 2.2.0 and *Migrating from 1.0.0*.

## API Reference

### AuthBroker Class

#### Constructor

```typescript
constructor(
  config: {
    sessionStore: ISessionStore;
    serviceKeyStore?: IServiceKeyStore;  // getProvider needs it
    provider?: IRefreshableTokenProvider | TokenProviderFactory; // the token API's own, optional
    // collaborators, each a function of the destination:
    authorization?,        // (destination, grant) — authorization_code, passcode, saml2_pure, saml2_bearer
    oidcAuthorization?,    // (destination) — oidc_authorization_code
    deviceCodePresenter?,  // (destination) — device_code
    samlCookies?,          // (destination) — saml2_pure
    assertionReplayStore?, // (destination) — saml2_pure, saml2_bearer
    clientAuthentication?, // (context) — how a client authenticates (4.1.0)
  },
  logger?: ILogger,
)

type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
  client?: TokenProviderClient, // only beside clientAuthentication (4.1.0)
) => IRefreshableTokenProvider;
```

**Parameters**:
- `config.sessionStore` — the session secret: the token or cookies,
  `expiresAt`, the refresh token, and what it is bound to (`issuedFor`,
  `issuedBy`). It must take a write of the secret alone (auth-stores 3 does;
  auth-stores 1.x/2.x's `AbapSessionStore` and `SafeAbapSessionStore` refuse
  one without `serviceUrl`).
- `config.serviceKeyStore` — the means: `authType`, `grantType`, the client,
  user and password, the SNC, OIDC and SAML fields, `serviceUrl`. Required by
  `getProvider`.
- `config.provider` — a token API source of your own, not used by
  `getProvider`; without it the token API asks the provider `getProvider`
  builds for the destination, and with neither it nor a `serviceKeyStore`
  `getToken` / `refreshToken` throw `DestinationConfigError` naming both. A
  provider instance, used as given for every destination, or a factory called
  once per destination (concurrent first calls build once) and seeded — 3.x's
  reads, the session first — with:
  - `authConfig`: the session's UAA credentials, else the service key's,
    carrying the refresh token the session stored; `null` when neither store
    has credentials;
  - `connConfig`: the session's connection config with `serviceUrl` resolved
    and the token stored last.
- `config.authorization` — `(destination, grant) => IAuthorizationStrategy<string>`,
  the login of `jwt` / `authorization_code`, `jwt` / `passcode`, `saml` /
  `saml2_pure` and `saml` / `saml2_bearer` (for the SAML grants, a strategy
  that returns the SAMLResponse).
- `config.oidcAuthorization` — `(destination) =>
  IAuthorizationStrategy<OidcCallbackResult>`, the login of `jwt` /
  `oidc_authorization_code`.
- `config.deviceCodePresenter` — `(destination) => IDeviceCodePresenter`, how
  `jwt` / `device_code` shows the user where to go and what to enter.
- `config.samlCookies` — `(destination) => (samlResponse) => Promise<string>`:
  `saml2_pure` posts the validated SAMLResponse through it to the system's ACS
  and presents the cookies it returns.
- `config.assertionReplayStore` — `(destination) => IAssertionReplayStore`,
  where the SAML validators record each assertion so one presented twice is
  refused (`defaultReplayStore`, or your shared one).
- `config.clientAuthentication` — `(context) => Promise<IClientAuthentication>`,
  how the client of every grant that authenticates one authenticates:
  `fromServiceKeyCertificate()`, `fromServiceKeySecret({ encoding })`, or your
  composition (see *A client certificate* above). Absent: the client secret,
  as in 4.0.0.
- Each collaborator is called once when the destination's provider is built,
  never disposed by the broker, and required only by the rows that use it: no
  default — a row without its option is a `DestinationConfigError` naming it.
- `logger` — optional `ILogger`; without one nothing is logged. No log line
  contains any part of a token.

There is no browser option and no `allowBrowserAuth`: how a login is conducted
is the provider's authorization strategy (see *Headless processes* below).

#### getProvider()

```typescript
async getProvider(destination: string): Promise<IAuthProvider>
```

The provider the destination states (see *A Provider for a Connector*), cached
per destination. Throws `DestinationConfigError` when the destination lacks
what its type needs; a store failure other than absence is thrown as the store
raised it.

#### flush()

```typescript
async flush(): Promise<void>
```

One more attempt for every session write still pending; resolves when all have
landed, rejects with an `AggregateError` naming the destinations whose store
still refuses (the broker keeps retrying them). Call it on shutdown.

#### getToken()

```typescript
async getToken(destination: string): Promise<string>
```

1. Reads the destination's `authType` from the key store: `basic` or `snc` is
   a `DestinationConfigError` naming `authType`, before any provider is asked.
2. Without a `provider` option: takes the provider `getProvider` hands out
   for the destination — the same one, from the same cache — and calls
   `getTokens()` once; its `onTokens` has written anything new. A `none`
   destination is a `DestinationConfigError` naming `provider`.
3. With one: resolves `serviceUrl` from the session, else the service key (an
   error if neither has one, before the provider is asked), builds the
   provider on first use (factory) or uses the instance, calls `getTokens()`
   once, and writes the result — the secret alone (`sessionCookies` when
   `tokenType` is `'saml'`, else `authorizationToken`; `expiresAt`; the
   refresh token, the stored one carried forward when the result has none;
   `issuedFor`, `issuedBy`) — through the broker's write path.
4. Throws the store's error if the write of this token failed — the broker
   keeps retrying it — else returns the token.

#### refreshToken()

```typescript
async refreshToken(destination: string): Promise<string>
```

The same with `provider.refreshTokens()`: a new token, never the cached one.
Use it when the server refused the token `getToken()` returned (401/403). A
renewal already in flight for the destination — a connector's, in
`rejected()` — is joined, not repeated.

#### getAuthorizationConfig() / getConnectionConfig()

```typescript
async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>
async getConnectionConfig(destination: string): Promise<IConnectionConfig | null>
```

Composed from both stores, each for its role: `getConnectionConfig` is the
key store's means with the session's `authorizationToken`, `sessionCookies`,
`expiresAt` and binding (`issuedFor`, `issuedBy`) laid over them — a key
store's answer for any of these is never used (`null` when neither holds anything);
`getAuthorizationConfig` is the key store's client with the session's refresh
token (`null` without a client in the key store). Means a session store
answers are not read. Up to 3.1.0 both answered the session's configuration
whole, and the key's only when the session had none.

#### createTokenRefresher()

```typescript
createTokenRefresher(destination: string): ITokenRefresher
```

`getToken()` and `refreshToken()` bound to one destination, for injection into
a connection of your own that refreshes on 401. Unchanged since 3.x and not
deprecated; a `@mcp-abap-adt/connection` 10 connector takes `getProvider`'s
`IAuthProvider` instead.

### The token API

`getToken`, `refreshToken` and `createTokenRefresher` are for a consumer that
wants a token and nothing else. They have two sources:

- **No `provider` option** — the destination's own provider, the one
  `getProvider` hands out: one provider per destination, so a connector and
  the token API share one token, one refresh token and one renewal. They write
  nothing themselves: the provider's `onTokens` does.
- **A `provider` option** — yours, as in 3.x, with 3.x's reads; every answer
  is written, cache hits included, as the secret alone through the same write
  path (retried, flushed). `issuedFor` is the URL with the SAP client and
  `issuedBy` the client a factory was handed (none for an instance), both
  fixed when the provider is built for the destination and kept with it — a
  later change of URL or client does not re-label what it obtained.
  `getProvider` does not use it, so a process that also calls `getProvider`
  for that destination has two token sources for it; use one per destination,
  or hand yours to a connector as
  `TokenAuthProvider.from(broker.createTokenRefresher(d))`.

With a `clientAuthentication` strategy, a factory is called with a fourth
argument (`TokenProviderClient`: the strategy's answer, the client identity, a
bound refresh token) and seeded only with stored secrets bound to the
destination; see *How the Client Authenticates* in the library README.

Either way a destination stated `basic` or `snc` is refused before any
provider is asked, and a failed write reaches the caller as the store raised
it while the broker retries it.

## Usage Examples

### Headless processes

With `getProvider`, a process nobody is watching gives the broker
collaborators that refuse — `authorization` and `oidcAuthorization` returning
a strategy whose `authorize` throws, a `deviceCodePresenter` whose `present`
throws. The provider runs on its stored secret and refresh token; when a
login is needed, `prepare()` / `rejected()` answer Oops, with fixed wording
and never your error's message, and nothing is written.

With the token API, the process gives its own provider a strategy that
refuses, and catches its own error; the broker hands it back unchanged:

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
  `code`, `missingFields` and `cause`: `ValidationError`, `BrowserAuthError`,
  `AssertionValidationError` from `@mcp-abap-adt/auth-providers`, network
  errors (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`), and whatever the
  authorization strategy throws. The broker does not retry.
- **`DestinationConfigError`** (`code: 'DESTINATION_CONFIG'`) — a destination
  that lacks what its type needs, from `getProvider` and from the token API;
  from the token API also a destination stated `basic` or `snc` (`authType`),
  a `none` destination without a `provider` option (`provider`), and neither
  a `provider` nor a `serviceKeyStore` (both). `missingFields` names fields or
  options, never a value.
  A provider constructor's refusal (an `sncQop` outside `1`, `2`, `3`, `8`,
  `9`) is mapped to the store field's name; its own error is not kept, since
  its message quotes the value it refused.
- **Missing service URL**: `Session for destination "<name>" is missing required
  field 'serviceUrl'` — neither the session nor the service key has one.
- **No token in the provider's result**: `Token provider did not return
  authorization token for destination "<name>"`.
- **Store reads**: `null` or `FILE_NOT_FOUND` means absent and the broker tries
  the next source; any other store failure (an invalid or unreadable service
  key, for instance) is thrown unchanged. **Store writes** that fail reach the
  token API's caller as the store raised them, and are retried all the same;
  a `getProvider` provider's write is retried and reported by `flush()`.

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

The broker writes the session secret alone — the token (or session cookies),
`expiresAt`, the refresh token, `issuedFor` and `issuedBy`, in one
`saveSession` — for a `getProvider` provider and for the token API alike;
never the client secret, `serviceUrl` or `authType`, which are means and live
in the key store. The commands of `@mcp-abap-adt/auth-broker-cli` 2.x write
the means themselves, through `EnvDestinationStore`, and leave the secret to
the broker — both into one `<destination>.env`, each store touching its own
keys.

A client certificate or its private key never reaches the session store or
the `.env`: a certificate destination states only the paths of the user's own
PEM files and `certurl` (`SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH`,
`SAP_UAA_CERT_URL`), and nothing of the PEM is logged or carried in an error.

The stored refresh token comes back through `loadSession()`, which the broker
reads to seed the next process's provider.

## Logging

Pass an `ILogger` as the constructor's second argument (for instance
`DefaultLogger` from `@mcp-abap-adt/logger`). The broker logs its
initialization, each provider build (for `getProvider`'s: the `authType`,
grant and whether it was seeded; for a factory's: whether credentials, a
refresh token and a stored token were there), each session secret saved
(token or cookies, whether a refresh token came back, the expiry), a stored
secret discarded because it is bound elsewhere, failed writes (by error class)
and store read failures. It never logs any part of a token or secret, nor a
store error's message.

## Best Practices

1. **State the destination in the key store and give no `provider`**: the
   token API then serves the provider the destination states, shared with
   `getProvider`. With a `provider` of your own, **pass a factory** when the
   stores hold the credentials, so it is seeded with the stored refresh token
   and token instead of logging in again.
2. **Headless**: give the provider a refusing strategy and catch your own error.
3. **On 401**: call `refreshToken()`, not `getToken()`.
4. **Storage**: auth-stores 3 — `AbapSessionStore`/`XsuaaSessionStore` for
   persistence across restarts, `SafeAbapSessionStore`/`SafeXsuaaSessionStore`
   to keep tokens in memory only — and call `flush()` on shutdown.
5. **Never commit** `.env` or service key `.json` files.

## Next Steps

- See [Installation Guide](../installing/INSTALLATION.md) for setup instructions
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development guide
