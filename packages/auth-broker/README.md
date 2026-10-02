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

- 🔌 **A credential for a connector**: `getProvider(destination)` builds the `IAuthProvider` the destination states — basic, SNC, the UAA grants (authorization code, client credentials, passcode), the OIDC grants (authorization code with PKCE, device code, password, token exchange), the SAML grants (session cookies, bearer token), or a credential handed over — from the service key store's means and the session store's secret
- 💾 **What a provider obtains is stored**: every token or set of SAML session cookies a `getProvider` provider obtains or renews — at `prepare()`, on expiry, or after a 401 in `rejected()` — is written to the session store, the secret alone with what it is bound to; a failed write is retried by the broker, and `flush()` tells you whether everything landed
- 🔒 **A secret goes only where it was obtained**: a stored token is used only for the resource it was obtained for, from the issuer and client that issued it — otherwise it is discarded and the provider logs in afresh
- 🎯 **Per destination**: one provider per destination name, shared by `getProvider` and the token API — one token, one refresh token, one renewal in flight
- 🔄 **Provider-driven token lifecycle**: The provider decides whether its cached token is still good, refreshes it, or logs in; the broker persists what it returns
- 🪙 **A token API for whoever wants a token and nothing else**: `getToken`, `refreshToken` and `createTokenRefresher` on the destination's own provider, or on one you give the broker, as in 3.x
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

This is the token API with a provider of your own — the 3.x way, which keeps
working. The broker takes a session store, an optional service key store, and
a token provider implementing `IRefreshableTokenProvider` (from
`@mcp-abap-adt/interfaces-auth`) — or a factory that builds one per
destination. Without a `provider` the token API serves what the destination
states, on the provider `getProvider` builds (see *Getting Tokens*); for a
`@mcp-abap-adt/connection` 10 connector, use `getProvider` itself.

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

These are 3.x's reads, in 3.x's order, kept for this path: a session store
that still answers a client or a URL is read first. auth-stores 3's session
stores answer neither, so the key store's are what is found. What the broker
writes back is the session secret alone (see *Getting Tokens*).

A provider instance can be passed instead of a factory; it is then used as
given, for every destination, and the broker seeds it with nothing:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/sessions'),
  provider: new AuthorizationCodeProvider({
    uaaUrl, clientId, clientSecret,
    authorization: browserCallbackStrategy({ browser: 'system' }),
  }),
});
```

> `AuthorizationCodeProvider` and the other `@mcp-abap-adt/auth-providers`
> providers implement `IRefreshableTokenProvider` (from `@mcp-abap-adt/interfaces-auth`
> 3.0.0) as of auth-providers 5.1.0. Since auth-providers 5 the interactive ones
> take their `authorization` strategy explicitly — none is built for you.

### A Provider for a Connector: `getProvider`

`getProvider(destination)` returns the `IAuthProvider` (from
`@mcp-abap-adt/interfaces-auth` 3) that a `@mcp-abap-adt/connection` 10
connector takes as it is. The destination states which provider it gets; the
broker reads two stores, each for one role:

- **the means** — `authType`, `grantType`, basic's user and password, the SNC,
  OIDC and SAML fields, `serviceUrl`, the client — from the **service key store**
  (`getConnectionConfig`), and only from there;
- **the secret** — the token or session cookies, `expiresAt`, the refresh
  token — from the **session store** (`loadSession`), and only from there.

Means a session store happens to answer are not read, and neither is a token
or cookies a key store happens to answer. Nothing is inferred: the
destination's `authType` (and `grantType`, for `jwt` and `saml`) decides the
provider, never which other fields are present.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: myKeyStore, // the means — required by getProvider
  sessionStore: mySessionStore, // the secret
  // no `provider`: that option is the token API's source, not getProvider's
});

const provider = await broker.getProvider('DEV'); // an IAuthProvider
// const connection = createAbapConnection({ url, provider }, logger) …
```

| `authType` / `grantType` | Provider (auth-providers 5.2) | Read from the key store | Read from the session store |
|---|---|---|---|
| `basic` (no grant read) | `new BasicAuthProvider(username, password)` | `username`, `password` | nothing |
| `snc` (no grant read) | `SncLogonProvider.forSecureLoginClient({ partnerName, qop, sncLib, myName, logger })` | `sncPartnerName` (required); `sncQop`, `sncLib`, `sncMyName` when set | nothing |
| `jwt` / `authorization_code` | `AuthorizationCodeProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret`; `serviceUrl`, `sapClient` for the binding | the seed: `authorizationToken`, `refreshToken`, `expiresAt` — used only when `issuedFor` and `issuedBy` match |
| `jwt` / `client_credentials` | `ClientCredentialsProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret`; `serviceUrl`, `sapClient` for the binding | nothing (the row takes the client alone) |
| `jwt` / `passcode` | `UaaPasscodeProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`''` = a public client); `serviceUrl`, `sapClient` for the binding | the seed: `authorizationToken`, `refreshToken`, `expiresAt` — used only when `issuedFor` and `issuedBy` match |
| `jwt` / `oidc_authorization_code` | `OidcBrowserProvider` (PKCE) | `uaaClientId`, `uaaClientSecret` (`''` = a public client); `oidcIssuerUrl`, or `oidcAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` for the binding | the seed — used only when `issuedFor` and `issuedBy` match |
| `jwt` / `device_code` | `OidcDeviceFlowProvider` | the client as above; `oidcIssuerUrl`, or `oidcDeviceAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `password` | `OidcPasswordProvider` | the client as above; `username`, `password`; `oidcIssuerUrl`, or `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `token_exchange` | `OidcTokenExchangeProvider` (RFC 8693) | the client as above; `oidcSubjectToken`, `oidcSubjectTokenType`; `oidcAudience`, `oidcActorToken`, `oidcActorTokenType` when set; `oidcScopes`, joined by one space into its `scope`; `oidcIssuerUrl`, or `oidcTokenEndpoint`; `serviceUrl`, `sapClient` | the seed, as above (it has no refresh grant: a renewal exchanges again) |
| `saml` / `saml2_pure` | `Saml2PureProvider` | `samlIdpSsoUrl`, `samlSpEntityId`, `samlIdpEntityId` (the expected issuer), `samlIdpCertificates`; `samlAcsUrl`, `samlRelayState`, `samlIdpInitiated`, `samlClockSkewMs` when set; `serviceUrl`, `sapClient` for the binding | the seed: `sessionCookies`, `expiresAt` — used only when `issuedFor` and `issuedBy` match |
| `saml` / `saml2_bearer` | `Saml2BearerProvider` (RFC 7522) | the same SAML fields; `samlTokenUrl` when set; the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`''` = a public client); `serviceUrl`, `sapClient` | the seed: `authorizationToken`, `refreshToken`, `expiresAt` — used only when `issuedFor` and `issuedBy` match |
| `jwt` / `none` | `TokenAuthProvider.fixed(authorizationToken)` | `authType`, `grantType`, `serviceUrl` (+ `sapClient`); an issuer, when stated: `oidcIssuerUrl`, or the client's `uaaUrl` + `uaaClientId` | `authorizationToken` (required), `issuedFor` (required to match); `issuedBy` when the means state an issuer |
| `saml` / `none` | `new SamlAuthProvider(sessionCookies)` | `authType`, `grantType`, `serviceUrl` (+ `sapClient`); `samlAcsUrl` when stated | `sessionCookies` (required), `issuedFor` (required to match); `issuedBy` when `samlAcsUrl` is stated |

**No provider reads `serviceUrl`.** The URL of the system is where the
connector connects, not authorization data: no token provider reads it — a
UAA grant needs the client and `uaaUrl` — so `getProvider` neither requires it
nor passes it to a provider. Give the connector its URL from your key store
(`getConnectionConfig`), as the key store answers it. The broker reads it,
with `sapClient`, for one thing only: to bind a stored secret to the resource
it was obtained for (see *A Secret Is Bound to Its Resource and Issuer*). A
token destination without it still gets its provider, but no stored secret
is reused for it.

`none` is how a handed-over credential is stated: the key store says
`grantType: 'none'`, and the token or cookies live in the session. The SNC
row takes the contract's own defaults when a field is absent — the library is
discovered (`SNC_LIB_64`, `SNC_LIB`, the Secure Login Client's install path)
when `sncLib` is, the user's SNC name comes from the credential when
`sncMyName` is, and `qop` is the provider's `'9'` when `sncQop` is.

The allowed pairs are `jwt` with `authorization_code`, `client_credentials`,
`passcode`, `oidc_authorization_code`, `device_code`, `password`,
`token_exchange` or `none`, and `saml` with `saml2_pure`, `saml2_bearer` or
`none`. A pair outside them is a `DestinationConfigError` naming `grantType`.

**The UAA grants.** The client comes from the key store's
`getAuthorizationConfig` — never from the session store. A session is the
seed: the stored token is presented while it is valid (a JWT's own `exp`
decides; the stored `expiresAt` serves a token that carries none), and the
stored refresh token renews it. Without a session the provider is built
unseeded and obtains its first token at `prepare()`. `uaaClientSecret: ''` is
a public client: `passcode` takes it as no secret; `AuthorizationCodeProvider`
and `ClientCredentialsProvider` require a secret, so for them `''` is missing.

**The `authorization` option** is the interactive half of
`authorization_code` and `passcode`: a function of the destination and the
grant, returning the `IAuthorizationStrategy<string>` the provider logs in
with. The broker calls it once, when it builds that destination's provider,
and never disposes what it returns — whoever constructs, disposes. For
`passcode` the strategy is handed `<uaaUrl>/passcode` as the URL to send the
user to, and returns the code. There is no default: a destination whose grant
needs it, without it, is a `DestinationConfigError` naming `authorization`.
A headless process passes one that refuses (see *Headless Processes*).

```typescript
import { browserCallbackStrategy, manualPasscodeStrategy } from '@mcp-abap-adt/auth-providers';

const broker = new AuthBroker({
  serviceKeyStore: myKeyStore,
  sessionStore: mySessionStore,
  authorization: (destination, grant) =>
    grant === 'passcode'
      ? manualPasscodeStrategy({ timeoutMs: 300_000 })
      : browserCallbackStrategy({ timeoutMs: 120_000 }),
});
```

**The OIDC grants.** The client is the key store's `getAuthorizationConfig`
again: `uaaClientId`, and `uaaClientSecret` — `''` is a public client, sent
with no secret. (A key store answers a client when it holds one: from
auth-stores 3.2.0, `EnvDestinationStore` answers one whenever `uaaClientId`
is stated, a missing `uaaUrl` or secret as `''` — so an OIDC destination
states its issuer in `oidcIssuerUrl` alone, and a public client no secret.)
The endpoints come from `oidcIssuerUrl`, which the provider discovers them
from, or — without it — from every explicit endpoint the row reads
(`oidcAuthorizationEndpoint`, `oidcDeviceAuthorizationEndpoint`,
`oidcTokenEndpoint`); without either the error names `oidcIssuerUrl` and the
endpoints missing. `oidcScopes` is passed as given (`token_exchange` takes
one `scope` string: the scopes joined by a space). The subject and actor
tokens of `token_exchange` and the user and password of `password` are
means: sent to the token endpoint, never written to the session.

**The SAML grants.** Each provider validates the assertion before anything
uses it, with a validator the broker composes from the destination's trust
and your replay store: `createSignedResponseValidator` for `saml2_pure` (the
Response must be signed — the cookies' system receives it whole) and
`createSignedAssertionValidator` for `saml2_bearer` (the Assertion must be
signed — the token endpoint receives it alone), from `samlIdpCertificates`
(PEM or base64 DER; several during a rotation), `samlClockSkewMs` and
`assertionReplayStore(destination)`; `samlIdpEntityId` is the issuer every
assertion must name. A certificate the validator cannot read, or a
`samlClockSkewMs` that is not a whole, non-negative number of milliseconds,
is a `DestinationConfigError` naming the field. `samlIdpInitiated: true`
declares an IdP-initiated login: no AuthnRequest, and an assertion carrying
no `InResponseTo` — your strategy then hands over the SAMLResponse without
asking for an authorization URL (a strategy that asks gets Oops from
`prepare()`). `saml2_pure` is seeded with the stored cookies and their
`expiresAt` — cookies carry no expiry of their own, so the provider keeps them
until the assertion's earliest `NotOnOrAfter` (less the provider's one-minute
margin: an identity provider whose assertions live a minute or less makes
every request a login); SAML has no refresh token, so a renewal is a new
login through your strategy. `saml2_bearer` posts the Assertion to
`samlTokenUrl`, else `<uaaUrl>/oauth/token`, with the client, and renews by
its refresh token.

**The collaborator options** — each a function of the destination, called
once when that destination's provider is built, never disposed by the
broker, and required only by the rows that use it; a row whose option is
missing is a `DestinationConfigError` naming it:

| Option | Rows | What it returns |
|---|---|---|
| `authorization(destination, grant)` | `authorization_code`, `passcode`, `saml2_pure`, `saml2_bearer` (the grant is passed) | the `IAuthorizationStrategy<string>` that conducts the login — for the SAML grants, the one that returns the SAMLResponse (`samlCallbackStrategy`, `manualSamlResponseStrategy`, …) |
| `oidcAuthorization(destination)` | `oidc_authorization_code` | an `IAuthorizationStrategy<OidcCallbackResult>` (`oidcCallbackStrategy`, or `asOidcResult(…)` over a string strategy) |
| `deviceCodePresenter(destination)` | `device_code` | an `IDeviceCodePresenter` that shows the user the verification URL and code (`consoleDeviceCodePresenter(logger)`, or your UI) |
| `samlCookies(destination)` | `saml2_pure` | `(samlResponse) => Promise<string>`: posts the validated SAMLResponse to the system's ACS and returns the session cookies it sets |
| `assertionReplayStore(destination)` | `saml2_pure`, `saml2_bearer` | the `IAssertionReplayStore` the validator records each assertion in, refusing one presented twice — `defaultReplayStore` (process-wide, in memory) or a shared one of yours |

```typescript
import {
  consoleDeviceCodePresenter,
  defaultReplayStore,
  oidcCallbackStrategy,
  samlCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';

const broker = new AuthBroker(
  {
    serviceKeyStore: myKeyStore,
    sessionStore: mySessionStore,
    authorization: (destination, grant) =>
      grant === 'saml2_pure' || grant === 'saml2_bearer'
        ? samlCallbackStrategy({ timeoutMs: 120_000 })
        : browserCallbackStrategy({ timeoutMs: 120_000 }),
    oidcAuthorization: () => oidcCallbackStrategy({ timeoutMs: 120_000 }),
    deviceCodePresenter: () => consoleDeviceCodePresenter(logger),
    samlCookies: (destination) => (samlResponse) =>
      postToAcs(destination, samlResponse), // yours: the system's ACS answers Set-Cookie
    assertionReplayStore: () => defaultReplayStore,
  },
  logger,
);
```

### A Secret Is Bound to Its Resource and Issuer

A token's audience, cookies' host and path, a system's client: presenting a
secret to a resource it was not obtained for is a leak, and a secret from
another authorization server or client must not stand in for this
destination's. So the session store keeps, beside the secret, two strings
(`IConnectionConfig`, `@mcp-abap-adt/interfaces-auth-broker` 1.1.0):

- **`issuedFor`** — the resource: `serviceUrl` with the SAP client, e.g.
  `https://my-abap.example.com:443/sap/bc/adt?sap-client=100`;
- **`issuedBy`** — who issued it, to which client: `uaaUrl` with
  `client_id=<uaaClientId>` for the UAA grants and `saml2_bearer`, e.g.
  `https://sub.authentication.us10.hana.ondemand.com:443?client_id=sb-abap-trial`;
  `oidcIssuerUrl` — else `uaaUrl` — with `client_id=<uaaClientId>` for the
  OIDC grants; for `saml2_pure`'s cookies, the ACS of the system that set
  them: `samlAcsUrl`, origin and path.

The broker computes both from the destination's means and compares them,
canonicalised on **both** sides, with what the session holds:

- **The canonical form:** scheme and host lower-cased; the port explicit
  (`443` for `https`, `80` for `http`); the path without a trailing `/` (the
  root path is empty); one query parameter at most — `sap-client` (the means'
  `sapClient` wins over a `sap-client` already in `serviceUrl`) or
  `client_id` — parsed and re-encoded, so a value percent-encoded on one side
  and plain on the other compares equal; no user info, no other parameter,
  no fragment. A URL that does not parse binds nothing. A store keeps the
  strings as given and need not canonicalise them.
- **The grants that obtain a secret** (UAA, OIDC, SAML)**:** a stored secret seeds the provider only when **both**
  stored values equal the computed ones. Otherwise — either different, or
  absent on either side (no `serviceUrl` in the means, an OIDC destination
  stating neither `oidcIssuerUrl` nor `uaaUrl`, a `saml2_pure` one without
  `samlAcsUrl`, a session written without them) — the secret is not used,
  **refresh token included**: the
  provider is built as with no session and logs in afresh by its grant, and
  the log says only `<destination>: secret bound to another resource,
  discarded` — never a URI, never a token. The new secret is written with
  both fields.
- **The `none` rows** present a credential the broker cannot obtain again, so
  a mismatch is refused, not discarded: a `DestinationConfigError` naming
  `issuedFor` when the stored resource differs or is absent (or the means
  state no `serviceUrl`), and naming `issuedBy` when the means state an issuer
  (`oidcIssuerUrl` or the client for `jwt`, `samlAcsUrl` for `saml` — then
  canonicalised as origin and path) and the stored one differs or is absent.
  Means that state no issuer leave `issuedBy` uncompared.
- **The binding does not check the token.** Its audience stays the
  resource's to enforce; the broker compares two strings and parses no token.

**What you meet:**

1. **A custom `ISessionStore`** (a database, a message log, a secret store)
   must persist `issuedFor` and `issuedBy` beside the secret, and answer
   them from `loadSession`. One that drops them still type-checks, but the
   broker then never reuses its sessions: every process start is a fresh
   login — a browser each time for an interactive grant.
2. **A headless process whose strategy refuses logins** gets Oops ("login
   required") from `prepare()` / `rejected()` on a mismatch, instead of
   presenting a foreign secret; log in again with the CLI.
3. **Changing a destination's URL, SAP client, UAA or client** costs one
   fresh login — intended.
4. **Session files written before auth-stores 3.1.0** keep working: its
   session stores answer `issuedFor` from the file's `SAP_URL` (+
   `SAP_CLIENT`) and `issuedBy` from `SAP_UAA_URL` + `SAP_UAA_CLIENT_ID`,
   which the 3.x broker and CLI wrote with the token — so a stored token whose
   URL and client are the destination's is reused. XSUAA sessions written with
   an empty URL have no `issuedFor`, and log in once.

**One provider per destination** for the broker's life, shared with the token
API when the broker has no `provider` option (see *Getting Tokens*):
concurrent first calls share one build, and a build that threw is tried again
on the next call. A destination rewritten from outside is picked up by a new
broker.

### Persistence and `flush()`

Every token provider `getProvider` builds writes what it obtains back to the
session store, through its `onTokens` hook, before it answers — whichever
moment triggered the renewal: `prepare()`, `authorize()` on expiry, or
`rejected()` after a 401. A renewal inside a connector is stored before the
connector resends.

- **The secret alone, with its binding, in one write**:
  `saveSession(destination, { authorizationToken, expiresAt, refreshToken,
  issuedFor, issuedBy })` — or, for `saml2_pure`'s cookies (a result of
  `tokenType: 'saml'`), `{ sessionCookies, expiresAt, issuedFor, issuedBy }`,
  with no refresh token: SAML has none. `saml2_bearer`'s result is a token
  and is written as one — `issuedFor` / `issuedBy` as computed when the
  provider was built, each left out when the means lack its source (so the
  store clears it). No means is ever written — not `serviceUrl`, not
  `authType`, not the client: the client secret lives in the key store, and
  the broker never writes the key store (its contract has no write method).
  `expiresAt` is the result's, else the `expires_in` it reported counted from
  when it arrived. A result without a refresh token keeps the one the session
  holds — when that one is bound where the new secret is; one bound to
  another resource or issuer is not carried into it.
- **`basic` and `snc` are never written**: they obtain no session secret, and
  `none` obtains nothing either. A destination the key store states as
  `basic` or `snc` at write time is not written.
- **The token API writes through the same path** (see *Getting Tokens*):
  with a `provider` of yours, every answer it gets is written as above — the
  stored refresh token carried forward whatever its binding, as your provider
  was seeded with it.
- **A failed write does not fail the authentication.** The connector goes on
  with the token it holds; the broker keeps the result pending for that
  destination and retries on its own — one second, doubling, capped at one
  minute — on a timer that never keeps the process alive. A newer result
  replaces the pending one; writes for one destination never overlap. Each
  failure is logged by its class name, never its message. The token API's
  caller still gets the failure: `getToken()` / `refreshToken()` throw the
  store's error for the token they received, while the retry goes on.
- **`flush()`** gives every pending write one more attempt, resolves when all
  have landed, and rejects (an `AggregateError` naming the destinations; each
  of its `errors` is `"<destination>": <error class>` — never the store's own
  message, which may quote what was being written) when the store still
  refuses — the broker keeps retrying.
  Call it on shutdown — on `SIGTERM`, before a stdio transport closes — to
  know whether every token is stored.

```typescript
process.on('SIGTERM', async () => {
  try {
    await broker.flush();
  } catch (error) {
    logger.error(`Tokens not stored: ${(error as Error).message}`);
  }
  process.exit(0);
});
```

**A destination that lacks what its type needs** is a `DestinationConfigError`
(see *Error Handling*), thrown by `getProvider` before any provider exists —
never a provider built only to refuse in `prepare()`.

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

With `getProvider` the same holds for every collaborator option: give the
broker an `authorization` / `oidcAuthorization` that refuses, and a
`deviceCodePresenter` that routes the code to wherever a person can see it —
or refuses. The provider then runs on its stored secret and refresh token;
when a login is needed, `prepare()` / `rejected()` answer Oops — whose
refusal carries fixed wording, never the message of what your collaborator
threw — and nothing is written:

```typescript
const refuseLogin = {
  authorize: async () => {
    throw new LoginRequiredError('Run mcp-auth to log in');
  },
};

const broker = new AuthBroker({
  serviceKeyStore: myKeyStore,
  sessionStore: mySessionStore,
  authorization: () => refuseLogin,
  oidcAuthorization: () => refuseLogin,
  deviceCodePresenter: () => ({
    present: async () => {
      throw new LoginRequiredError('No one to show a device code to');
    },
  }),
});
```

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

**Which provider answers.**

- **No `provider` option** — the destination's own: the very provider
  `getProvider('TRIAL')` hands out, from the same per-destination cache. A
  connector and the token API in one process therefore share one token, one
  refresh token and one renewal: a `refreshToken()` while the connector renews
  in `rejected()` joins that renewal, and a token the connector renewed is
  what `getToken()` answers next. The destination must state a grant that
  obtains a token — every grant but `none` (see the table under *A Provider
  for a Connector*); a `none` destination is a `DestinationConfigError`
  naming `provider`, before any provider is built.
- **A `provider` option** — yours, as in 3.x (see *Basic Usage*): the factory
  is called once per destination (concurrent first calls build once; a call
  after one that threw builds again), an instance serves every destination.

**What is written.** The session secret alone, in one `saveSession` — the
token, or the cookies of a SAML result (`tokenType: 'saml'`), its
`expiresAt`, the refresh token (the stored one carried forward when the
result has none), and what the secret is bound to (`issuedFor`, `issuedBy`,
see *A Secret Is Bound to Its Resource and Issuer*). Never `serviceUrl`,
`authType` or a client: they are means, and live in the key store.

- Without a `provider`, the token API writes nothing itself: the provider's
  `onTokens` writes every token it obtains (see *Persistence and `flush()`*),
  and a cache hit writes nothing.
- With a `provider`, the token API writes after every answer, cache hits
  included, through the same write path. `issuedFor` is the `serviceUrl` it
  resolved, with the SAP client; `issuedBy` the client a factory was handed —
  an instance is handed none, so what it obtains is bound to no issuer and
  `getProvider` never seeds from it.

**A write that fails** reaches the caller: `getToken()` / `refreshToken()`
throw the store's error, as raised, for the token they received — and the
broker keeps retrying that write on its own; `flush()` tells you when it
landed.

**A destination stated `basic` or `snc` has no token API.** The token API
reads the destination's `authType` from the key store first and, for `basic`
or `snc`, throws `DestinationConfigError` naming `authType` before any provider
is asked — a token written over such a session would replace a credential
that is not one. A key store that states no `authType` (a 3.x setup), or no
key store, is served as before.

**Two token sources, with a `provider` option.** `getProvider` never uses
the `provider` option: the destination states its own provider. A process
that gives the broker a `provider` and also calls `getProvider` for the same
destination has two token sources for it — each with its own token and
renewal, both writing to the same session. Use one of them per destination;
or, to hand your own provider to a connector, wrap the token API:
`TokenAuthProvider.from(broker.createTokenRefresher('TRIAL'))`
(`@mcp-abap-adt/auth-providers`), whose every renewal the token API writes.

### Creating Token Refresher for DI

`createTokenRefresher(destination)` returns an `ITokenRefresher` (from
`@mcp-abap-adt/interfaces-auth`) bound to one destination — `getToken()` is
`broker.getToken(destination)`, `refreshToken()` is
`broker.refreshToken(destination)` — for a connection of your own that asks
for a token per request and for a new one after a 401. It is unchanged since
3.x and not deprecated: calm-server injects it into its own connection.

```typescript
const tokenRefresher = broker.createTokenRefresher('TRIAL');

// In your own connection:
const token = await tokenRefresher.getToken();
// …the server answered 401:
const newToken = await tokenRefresher.refreshToken();
```

A `@mcp-abap-adt/connection` 10 connector takes an `IAuthProvider` instead:
give it `await broker.getProvider('TRIAL')`.

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

- **Resolves what the stores hold**: the means from the key store, the secret from the session store (and, for a `provider` of yours, the 3.x reads: the service URL and the UAA credentials, session first)
- **Builds or reuses the provider**: one per destination — the one the destination states, shared by `getProvider` and the token API; or your factory, called once per destination
- **Asks the provider once**: `getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()` — no retries, no fallbacks
- **Persists the answer**: the session secret alone — token or session cookies, `expiresAt`, the refresh token, and what it is bound to — to `sessionStore`, retrying a write that fails
- **Works with interfaces only**: `IServiceKeyStore`, `ISessionStore`, `IAuthProvider`, `IRefreshableTokenProvider`

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

2. **Stating the means in the key store**: `authType`, `grantType` and the fields its row reads, the client, and `serviceUrl` — for the token API with a `provider` of yours, the service URL comes from the session, else the key store.

3. **A session store that takes the secret alone**: the broker writes the token or cookies, `expiresAt`, the refresh token, `issuedFor` and `issuedBy` in one `saveSession`, and nothing else. auth-stores 3's session stores do; auth-stores 1.x/2.x's `AbapSessionStore` and `SafeAbapSessionStore` refuse a write without `serviceUrl` (measured on 1.2.3, 1.2.4, 2.0.0), so a token API on them throws after every token. A custom store must also keep `issuedFor` and `issuedBy`.

### Store Responsibilities

Concrete `ISessionStore` implementations are responsible for:

- **Handling their own data format**: Each store knows its internal data format (e.g., `AbapSessionData`, `BtpBaseSessionData`)
- **Converting between formats**: Converting between `IConfig`/`IConnectionConfig` and internal storage format
- **Taking the secret alone**: a session store is written the secret and its binding only, and keeps what it held beside them (auth-stores 3 refuses means outright)

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
    serviceKeyStore?: IServiceKeyStore; // getProvider needs it
    provider?:                          // the token API's, optional
      | IRefreshableTokenProvider
      | ((
          destination: string,
          authConfig: IAuthorizationConfig | null,
          connConfig: IConnectionConfig,
        ) => IRefreshableTokenProvider);
    // Collaborators, each a function of the destination, called once per
    // build, never disposed by the broker:
    authorization?: (destination: string, grant: StrategyGrant) => IAuthorizationStrategy<string>; // authorization_code, passcode, saml2_pure, saml2_bearer
    oidcAuthorization?: (destination: string) => IAuthorizationStrategy<OidcCallbackResult>; // oidc_authorization_code
    deviceCodePresenter?: (destination: string) => IDeviceCodePresenter; // device_code
    samlCookies?: (destination: string) => (samlResponse: string) => Promise<string>; // saml2_pure
    assertionReplayStore?: (destination: string) => IAssertionReplayStore; // saml2_pure, saml2_bearer
  },
  logger?: ILogger,
)
```

**Parameters:**
- `config.sessionStore` - **Required** - The session secret: the token or cookies, `expiresAt`, the refresh token, and what it is bound to (`issuedFor`, `issuedBy`). For the token API with a `provider`, its `serviceUrl`, or the service key's, is required (3.x's reads).
- `config.serviceKeyStore` - The means: `authType`, `grantType`, the client, basic's user and password, the SNC, OIDC and SAML fields, `serviceUrl`. **Required by `getProvider`**, which has no other source of means.
- `config.provider` - The token API's source (`getToken`, `refreshToken`, `createTokenRefresher`): a provider instance, used for every destination, or a factory (`TokenProviderFactory`), called once per destination and seeded with what the stores hold (see *Basic Usage*). Not used by `getProvider`. Without it, the token API asks the provider `getProvider` builds for the destination (see *Getting Tokens*); with neither it nor a `serviceKeyStore`, the token API throws `DestinationConfigError` naming both.
- `config.authorization` - The interactive strategy of `jwt` / `authorization_code`, `jwt` / `passcode`, `saml` / `saml2_pure` and `saml` / `saml2_bearer`, as a function of the destination and the grant (see *A Provider for a Connector*).
- `config.oidcAuthorization` - The interactive strategy of `jwt` / `oidc_authorization_code`.
- `config.deviceCodePresenter` - Where `jwt` / `device_code` shows the user the verification URL and code.
- `config.samlCookies` - `saml2_pure`: turns the validated SAMLResponse into the system's session cookies.
- `config.assertionReplayStore` - The replay store the SAML validators record each assertion in.
- Each collaborator option is required only by the rows that use it (missing → `DestinationConfigError` naming it); the broker supplies no default, calls it once per build, and disposes nothing it returns.
- `logger` - Optional logger. If not provided, nothing is logged.

**Available Implementations:**
- **Means** (auth-stores 3): `EnvDestinationStore(directory, { fallback? })`, `AbapServiceKeyStore(directory, { grantType?, log? })`, `XsuaaServiceKeyStore(directory, { grantType?, log? })`
- **Secret** (auth-stores 3): `AbapSessionStore(directory, log?)`, `SafeAbapSessionStore(log?)`, `XsuaaSessionStore(directory, log?)`, `SafeXsuaaSessionStore(log?)`, `EnvFileSessionStore(file, log?)`
- **Providers** (auth-providers 5): `AuthorizationCodeProvider(...)`, `ClientCredentialsProvider(...)` and the rest, for a `provider` of yours

#### Methods

##### `getProvider(destination: string): Promise<IAuthProvider>`

The `IAuthProvider` the destination states, built from the key store's means
and the session store's secret (see *A Provider for a Connector*). Cached per
destination; a failed build is retried on the next call. Throws
`DestinationConfigError` for a destination that lacks what its type needs, and
passes a store failure other than absence on as the store raised it.

##### `flush(): Promise<void>`

Every session write still pending gets one more attempt. Resolves when all
have landed; rejects with an `AggregateError` naming the destinations whose
store still refuses (its `errors` carry each destination and the store
error's class only, never its message) — the broker keeps retrying them. See *Persistence and `flush()`*.

##### `getToken(destination: string): Promise<string>`

1. Reads the destination's `authType` from the key store: `basic` or `snc` is a `DestinationConfigError` naming `authType`, before any provider is asked.
2. **Without a `provider` option:** takes the provider `getProvider(destination)` hands out (the same cache; a `none` destination is a `DestinationConfigError` naming `provider`), calls `getTokens()` once, and writes nothing itself — the provider's `onTokens` wrote anything new.
3. **With one:** resolves `serviceUrl` (session, else service key; an error if neither has one), builds the provider on first use (factory form) seeded with the credentials, the stored refresh token and the stored token — or uses the instance — calls `getTokens()` once, and writes the result: the secret alone, through the broker's write path.
4. Throws the store's error if the write of this token failed (the broker keeps retrying it); else returns the token.

##### `refreshToken(destination: string): Promise<string>`

The same, with `provider.refreshTokens()`: a new token, never the cached one —
for a caller whose token the server has just refused. A renewal already in
flight for the destination (a connector's, in `rejected()`) is joined.

##### `getAuthorizationConfig(destination)` / `getConnectionConfig(destination)`

The two stores composed, each for its role:

- `getConnectionConfig` — the service key store's means with the session's
  secret (`authorizationToken`, `sessionCookies`, `expiresAt`) laid over them;
  `null` when neither store holds anything.
- `getAuthorizationConfig` — the service key store's client (`uaaUrl`,
  `uaaClientId`, `uaaClientSecret`) with the session's refresh token; `null`
  when the key store has no client.

Means a session store answers (a client, a URL, an `authType`) are not read,
nor a secret a key store answers. Up to 3.1.0 both answered the session's
configuration whole, and the key's only when the session had none.

##### `createTokenRefresher(destination): ITokenRefresher`

`getToken()` and `refreshToken()` bound to one destination, for injection into a connection of your own. Unchanged since 3.x; not deprecated.

##### Error Handling

- **`DestinationConfigError`** — a destination that lacks what its type needs.
  `getProvider` throws it before any provider is asked; so does the token
  API, for the same destinations and for those below. It carries `code:
  'DESTINATION_CONFIG'`, `destination`, `missingFields` — field or option
  names only. When a provider's constructor refused (an `sncQop` outside `1`,
  `2`, `3`, `8`, `9`), the store field is named and the provider's own error
  is not kept — its message quotes the value. **No stored value
  reaches it**: not a password, not a token, not an `authType` that is none of
  the four. Thrown for:

  | Case | `missingFields` |
  |---|---|
  | no `serviceKeyStore` option (`getProvider`) | `serviceKeyStore` |
  | the token API with neither a `provider` nor a `serviceKeyStore` option | `provider`, `serviceKeyStore` |
  | the token API on a destination stated `basic` or `snc` | `authType` |
  | the token API without a `provider` option, on a `jwt` / `none` or `saml` / `none` destination | `provider` |
  | the key store has no means for the destination — whatever the session holds | `authType` |
  | no `authType`, `''`, or one that is not `basic`, `jwt`, `saml`, `snc` | `authType` |
  | `jwt` / `saml` without `grantType`, `''`, or a pair outside the table | `grantType` |
  | `basic` without user or password (`''` counts as missing) | `username`, `password` — each that is missing |
  | `snc` without `sncPartnerName` | `sncPartnerName` |
  | `snc` whose settings the provider refuses | the store field, e.g. `sncQop` |
  | `jwt` / `none` without a token in the session | `authorizationToken` |
  | `saml` / `none` without cookies in the session | `sessionCookies` |
  | `jwt` / `none`, `saml` / `none` whose stored `issuedFor` is not the destination's resource, or is absent, or the means state no `serviceUrl` | `issuedFor` |
  | `jwt` / `none`, `saml` / `none` whose means state an issuer and whose stored `issuedBy` is not it, or is absent | `issuedBy` |
  | a UAA grant without its client in the key store (`''` counts as missing) | `uaaUrl`, `uaaClientId`, and `uaaClientSecret` for `authorization_code` / `client_credentials` — each that is missing |
  | `authorization_code` / `passcode` without the `authorization` option | `authorization` |
  | an OIDC grant without its client's id in the key store | `uaaClientId` |
  | an OIDC grant with neither `oidcIssuerUrl` nor every endpoint its row reads | `oidcIssuerUrl`, and each endpoint missing: `oidcAuthorizationEndpoint` / `oidcDeviceAuthorizationEndpoint`, `oidcTokenEndpoint` |
  | `password` without user or password | `username`, `password` — each that is missing |
  | `token_exchange` without its subject | `oidcSubjectToken`, `oidcSubjectTokenType` — each that is missing |
  | `oidc_authorization_code` without the `oidcAuthorization` option | `oidcAuthorization` |
  | `device_code` without the `deviceCodePresenter` option | `deviceCodePresenter` |
  | a SAML grant without its trust (`''` and an empty certificate list count as missing) | `samlIdpSsoUrl`, `samlSpEntityId`, `samlIdpEntityId`, `samlIdpCertificates` — each that is missing |
  | `saml2_bearer` without its client | `uaaUrl`, `uaaClientId` — each that is missing |
  | a SAML grant without its collaborators | `authorization`, `samlCookies` (`saml2_pure`), `assertionReplayStore` — each that is missing |
  | a certificate the validator cannot read | `samlIdpCertificates` |
  | a `samlClockSkewMs` that is not a whole, non-negative number | `samlClockSkewMs` |

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
- **Store writes**: a write that fails reaches the token API's caller — the
  store's error, as raised, for the token it received — and is retried by the
  broker all the same. A `getProvider` provider's write never fails the
  authentication; it is retried, and `flush()` reports it.
- **A provider result without a token** is an error.

```typescript
import { DestinationConfigError } from '@mcp-abap-adt/auth-broker';
import { ValidationError } from '@mcp-abap-adt/auth-providers';

try {
  const provider = await broker.getProvider('TRIAL');
} catch (error) {
  if (error instanceof DestinationConfigError) {
    logger.error(`${error.destination} lacks: ${error.missingFields.join(', ')}`);
  }
  throw error;
}

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

Everything the broker writes — a `getProvider` provider's token and the
token API's alike — is the secret alone: `authorizationToken` (or
`sessionCookies`), `expiresAt`, `refreshToken`, with `issuedFor` and
`issuedBy`, in one `saveSession`, and nothing else (see *Persistence and
`flush()`*). Never the client secret, never `serviceUrl` or `authType`:
`setConnectionConfig` and `setAuthorizationConfig` are not called. A store
that merges a write into what it holds keeps a client or URL it held beside
the secret; auth-stores 3 holds the secret alone.

The stored refresh token comes back through `loadSession()`, which the broker
reads to seed the next process's provider.

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
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
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

