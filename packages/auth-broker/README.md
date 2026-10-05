# @mcp-abap-adt/auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A per-destination credential broker for SAP BTP and ABAP systems. For a destination — a name,
such as `TRIAL` — `getProvider` builds the `IAuthProvider` the destination states (basic, SNC, a
UAA, OIDC or SAML grant, or a credential handed over) from the *means* in the service key store
and the *secret* in the session store, ready for a `@mcp-abap-adt/connection` 10 connector, and
stores back every token or set of SAML session cookies that provider obtains or renews. The
token API (`getToken`, `refreshToken`, `createTokenRefresher`) serves whoever wants a token and
nothing else. It decides nothing about tokens itself: whether the cached token is still good,
when to refresh and when to log in is the provider's call (`@mcp-abap-adt/auth-providers`), and
where means and secrets live is the stores' (`@mcp-abap-adt/auth-stores`, or your own).

**Upgrading from 3.x?** See [*Migrating from 3.x*](#migrating-from-3x) — 4.0.0 needs a session
store that takes the secret alone (auth-stores 3 or later), means stated in a key store, and
the contracts of `interfaces-auth` 3. **On 4.0.0?** 4.1.0 is additive — a client that
authenticates with an x509 certificate, through the `clientAuthentication` strategy (see
[*How the Client Authenticates*](#how-the-client-authenticates-clientauthentication)); what a
4.0.0 consumer may notice is in [*Migrating from 4.0.0*](#migrating-from-400).

The `mcp-auth` and `mcp-sso` commands that write destination files are in
[`@mcp-abap-adt/auth-broker-cli`](../auth-broker-cli/README.md) (2.1.0, on this
version), in the same repository. Up to 3.0.4 they shipped in this package; from 3.1.0 this package
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
- 📜 **x509 service keys**: a client that authenticates with a certificate instead of a secret (`tls_client_auth`), when you say so — `clientAuthentication: fromServiceKeyCertificate()`; the certificate and key are read from the key store, and never reach the session store, a log line or an error

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

> `AuthorizationCodeProvider` and the other `@mcp-abap-adt/auth-providers` 5
> providers implement `IRefreshableTokenProvider` (from `@mcp-abap-adt/interfaces-auth`
> 3). Since auth-providers 5 the interactive ones take their `authorization`
> strategy explicitly — none is built for you.

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

| `authType` / `grantType` | Provider (auth-providers 5.3) | Read from the key store | Read from the session store |
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
With a `clientAuthentication` strategy no secret is read or required: the
client authenticates with the strategy's answer — a certificate, say (see *How
the Client Authenticates*).

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
- **`bindingOf(means, client?)` — for a consumer that hands over a
  credential.** A `none` destination presents a token or cookies the broker
  cannot obtain; whoever writes them to the session store must write the
  binding beside them. `bindingOf` answers exactly what the broker computes for
  those means — the one function `getProvider` checks against and `persist`
  writes (`issuedFor` from `serviceUrl` + `sapClient`, `issuedBy` from the
  issuer, client or ACS the grant uses) — so a consumer never canonicalises a
  URI itself:

  ```typescript
  const means = await keyStore.getConnectionConfig('DEV'); // saml / none
  await sessionStore.saveSession('DEV', {
    sessionCookies: cookies,
    ...bindingOf(means ?? {}), // { issuedFor: 'https://dev.example.com:443?sap-client=100' }
  });
  ```

  A destination that states no `jwt` / `saml` type or no grant binds nothing
  (`{}`). `mcp-sso … --cookie` writes its cookies this way.

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

### How the Client Authenticates: `clientAuthentication`

Every grant whose client authenticates to the authorization server — the UAA
grants (`authorization_code`, `client_credentials`, `passcode`), the OIDC
grants (`oidc_authorization_code`, `device_code`, `password`,
`token_exchange`) and `saml2_bearer` — sends the client's secret, as in 4.0.0,
unless you tell the broker otherwise. An XSUAA service key created with
`{"credential-type": "x509"}` holds no secret: it holds a client certificate,
its private key and the mTLS host the certificate is presented to (`certurl`).
How the client authenticates is your choice, stated as a strategy — the broker
never infers it from a key's shape and has no default:

```typescript
import {
  AuthBroker,
  fromServiceKeyCertificate,
} from '@mcp-abap-adt/auth-broker';
import {
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';

const broker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys', {
    grantType: 'client_credentials',
  }),
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
  // The key's certificate, presented at <certurl>/oauth/token.
  clientAuthentication: fromServiceKeyCertificate(),
});

const provider = await broker.getProvider('mcp'); // its client: the certificate
```

**The strategy** is `(context) => Promise<IClientAuthentication>`
(`ClientAuthenticationStrategy`). The broker calls it once when it builds a
destination's provider, with a `ClientAuthenticationContext`:

- `destination` and `grant` (a `ClientAuthenticationGrant`, one of the eight
  above);
- `client` — the secret client the key store's `getAuthorizationConfig`
  answered, as `uaaUrl`, `uaaClientId` and `uaaClientSecret` only — never a
  refresh token or any other field the store answered with it — or `null`
  (an x509 key answers `null` there, never a client with an empty secret);
- `readCertificate()` — the key store's certificate client
  (`IClientCertificate`: `uaaUrl`, `clientId`, `certificate`, `key`,
  `certUrl`), read **only when called**, at most once per build; `null` when
  the store holds none or implements no `getClientCertificate`.

Its answer goes to the provider as `clientAuthentication`, and **no client
secret goes with it** (auth-providers 5.3 refuses both). A given strategy
always answers or throws: there is no "nothing" answer, so an explicit choice
never falls back to the secret. `saml2_pure`, the `none` rows, `basic` and
`snc` authenticate no client and never call it.

**The two shipped factories** each fail closed:

| Factory | Answers | Throws (→ the refusal below) |
|---|---|---|
| `fromServiceKeyCertificate()` | auth-providers' `tlsClientCertificate` with the certificate and key `readCertificate()` answers, against `<certUrl>/oauth/token` (a trailing `/` of `certUrl` dropped). The material is checked before the factory answers, so a malformed, incomplete or expired certificate is refused when the provider is built, not at its first token request | the store answers no certificate client: "the destination has no client certificate" |
| `fromServiceKeySecret({ encoding })` | auth-providers' `clientSecretBasic` with the secret client's `uaaClientSecret`, in an `Authorization: Basic` header. `encoding` is required: `'raw'` for XSUAA (measured — it does not form-decode), `'form'` for UAA and Keycloak (RFC 6749 §2.3.1); anything else is a `TypeError` when the factory is made | no secret client, or an empty secret: "the destination has no client secret" |

**Composing them is yours.** A fallback, and its order, is your statement,
never the broker's. Branch on what the key holds (`readCertificate()` is
memoised, so the factory reads the same answer); do not `catch` a factory's
refusal and fall back — that would also swallow an expired, incomplete or
unreadable certificate and send the secret instead:

```typescript
import {
  type ClientAuthenticationStrategy,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '@mcp-abap-adt/auth-broker';

// The certificate when the key holds one, else the secret in a Basic header.
// Decided by what the key holds, never by a failure: an expired, incomplete or
// unreadable certificate is refused, not replaced by the secret.
const certificateElseSecret: ClientAuthenticationStrategy = async (context) =>
  (await context.readCertificate())
    ? fromServiceKeyCertificate()(context)
    : fromServiceKeySecret({ encoding: 'raw' })(context);

// The certificate for client_credentials only; every other grant its secret.
const byGrant: ClientAuthenticationStrategy = (context) =>
  context.grant === 'client_credentials'
    ? fromServiceKeyCertificate()(context)
    : fromServiceKeySecret({ encoding: 'raw' })(context);
```

**Where the certificate comes from** — `IServiceKeyStore.getClientCertificate?`
(`@mcp-abap-adt/interfaces-auth-broker` 1.2.0, optional), which auth-stores
3.3.0 implements:

- **`XsuaaServiceKeyStore`** — a key (bare, or wrapped in `credentials`)
  carrying `url`, `clientid`, `certificate`, `key` and `certurl` and no
  `clientsecret` is an x509 key: `getAuthorizationConfig` answers `null`,
  `getClientCertificate` the certificate client. A key carrying both a secret
  and a complete certificate offers both — the secret client as before, the
  certificate client beside it — and your strategy picks; the store does not
  read `credential-type` to choose. A key carrying only part of a
  certificate client is refused by `getClientCertificate` (`incomplete`),
  naming the missing fields, never a value. `AbapServiceKeyStore` holds no
  certificate client.
- **`EnvDestinationStore`** — three means variables, each a path or a URL,
  never PEM: `SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH`,
  `SAP_UAA_CERT_URL` (`XSUAA_UAA_CLIENT_CERT_PATH`, … with
  `XSUAA_DESTINATION_VARS`), beside `SAP_UAA_URL` / `SAP_UAA_CLIENT_ID` and
  **without** `SAP_UAA_CLIENT_SECRET`. All three and no secret is a
  certificate client (the two files read when `getClientCertificate` is
  called); none of them is 4.0.0's answer; some but not all, or any beside the
  secret, is the store's `ClientCertificateError` from both methods, naming
  the variables. A file that states neither a client id, a secret nor any of
  the three asks its `fallback` — so an `EnvDestinationStore` over an `XsuaaServiceKeyStore`
  answers the x509 key's certificate client. See auth-stores' README for the
  details.

```env
# A certificate destination — EnvDestinationStore (ABAP_DESTINATION_VARS)
SAP_AUTH_TYPE=jwt
SAP_GRANT_TYPE=client_credentials
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=sb-your-app!t12345
SAP_UAA_CLIENT_CERT_PATH=/home/you/keys/client.crt
SAP_UAA_CLIENT_KEY_PATH=/home/you/keys/client.key
SAP_UAA_CERT_URL=https://your-account.authentication.cert.us10.hana.ondemand.com
```

**Without a strategy nothing changes:** the client secret, exactly as 4.0.0,
and nothing certificate-related is read — no `getClientCertificate`, no file.
A client row whose key store answers no client, or one without a client id,
now says, after 4.0.0's words, `a certificate client needs a clientAuthentication strategy` (see
*Migrating from 4.0.0*).

**With a strategy, what the row requires** is its client's identity —
`uaaUrl` and `uaaClientId` (the OIDC rows: `uaaClientId`) — taken from the
secret client when the key store has one, else from the certificate client
(`uaaUrl`, `clientId`), read through the same memoised `readCertificate`; the
secret is no longer required.

**The binding on the strategy path.** A secret is bound to the client's
identity (`issuedBy` = `uaaUrl` + `client_id`), never to how the client
authenticates and never to PEM:

- a certificate destination's tokens are stored with `issuedBy` from the
  certificate client's `uaaUrl` and `clientId`, reused after the broker is
  recreated, and dropped after the issuer or the client id changes;
- a secret key and an x509 key of the **same client id** at the same
  `uaaUrl` (as an XSUAA instance's keys are) share one session: switching the
  destination from one to the other keeps its token and refresh token;
- the resource (`issuedFor`) matches when both sides state it and it is
  equal — **or when neither does**: means with no `serviceUrl`, or one that
  does not parse (the CLI's XSUAA placeholder is such a URL), and a session
  stored without `issuedFor`. A resource stated on one side only never
  matches. So an XSUAA destination without a service URL reuses its own
  session instead of logging in on every run; the client identity still
  decides. (Without a strategy, 4.0.0's rule stands: an absent resource
  matches nothing.)

**The token API with a factory of yours** gets the same strategy. For a
destination whose grant authenticates a client, the broker resolves the
strategy first and calls your factory with a **fourth argument**,
`TokenProviderClient` — never a certificate, a key or a secret:

| Field | What it is |
|---|---|
| `clientAuthentication` | the strategy's answer, to hand to your provider |
| `uaaUrl`, `clientId` | the client's identity: the secret client's when the stores hold one, else the certificate client's; absent when there is neither |
| `refreshToken` | the refresh token the session stored — only when the session is bound to this resource and this client identity, and only from that session read (a refresh token a store's `getAuthorizationConfig` carries is dropped on this path; `authConfig` carries the same bound one) |

```typescript
import {
  AuthBroker,
  fromServiceKeyCertificate,
  type TokenProviderFactory,
} from '@mcp-abap-adt/auth-broker';
import { ClientCredentialsProvider } from '@mcp-abap-adt/auth-providers';
import {
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';

const certificateClient: TokenProviderFactory = (
  destination,
  _authConfig, // null for an x509 key
  _connConfig,
  client,
) => {
  if (!client?.clientAuthentication || !client.uaaUrl || !client.clientId) {
    throw new Error(`No client for ${destination}`);
  }
  return new ClientCredentialsProvider({
    uaaUrl: client.uaaUrl,
    clientId: client.clientId,
    clientAuthentication: client.clientAuthentication,
  });
};

const tokenBroker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys', {
    grantType: 'client_credentials',
  }),
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
  clientAuthentication: fromServiceKeyCertificate(),
  provider: certificateClient,
});

const token = await tokenBroker.getToken('mcp');
```

On this path:

- the destination must state its `authType` (`jwt` or `saml`) and
  `grantType` — the strategy is told the grant — else a
  `DestinationConfigError` naming `authType`, `grantType`; a `saml2_pure` or
  `none` destination authenticates no client, and its factory gets three
  arguments, as in 4.0.0;
- every stored secret your factory is seeded with passes only when the
  session is bound to this resource and this client identity: the refresh
  token (in the fourth argument, and in `authConfig` for a secret client), and
  the stored token, cookies and expiry in `connConfig` — so a refresh token
  can never reach another authorization server. A result without a refresh
  token carries forward only a bound one. (Without a strategy, 4.0.0's
  carry-over stands: the stored refresh token whatever its binding.)
- what the factory is handed is built from allowlists, never a store's
  answer passed whole: `authConfig` is `uaaUrl`, `uaaClientId`,
  `uaaClientSecret` and the bound refresh token; `connConfig` is
  `serviceUrl`, `sapClient`, `language`, `authType`, `grantType`, plus — when
  that same connection read is bound — `authorizationToken`,
  `sessionCookies`, `expiresAt`, `issuedFor`, `issuedBy`. Anything else a
  store answers (a password, grant data, a field outside the type) stays
  behind; without a strategy the reads go through as in 4.0.0;
- a factory that throws is a `DestinationConfigError` naming `provider`,
  `clientAuthentication`, in fixed words — what it threw is not kept;
- a provider **instance** given as `provider` is your own composition: the
  token API uses it as given and calls no strategy for it.

**A strategy that fails carries nothing out.** Whatever the strategy, a store
it reads or the certificate check throws — and an answer that is no
`IClientAuthentication` — becomes a `DestinationConfigError` with
`missingFields: ['clientAuthentication']`, before any provider exists, in
fixed words chosen by the error's class only — no `cause`, nothing of the
thrown message:

| Words (after `Destination "<name>": `) | When |
|---|---|
| `the clientAuthentication strategy refused: the destination has no client certificate` | `fromServiceKeyCertificate()`, no certificate client |
| `the clientAuthentication strategy refused: the destination has no client secret` | `fromServiceKeySecret()`, no secret client or an empty secret |
| `the clientAuthentication strategy refused: the client certificate is incomplete` / `has expired` / `could not be used` | the certificate check refused the material |
| `the clientAuthentication strategy answered no client authentication` | the answer has no `authenticate` function |
| `the client certificate could not be read` | the store failed reading the certificate client for the row's identity |
| `the clientAuthentication strategy failed` | anything else — your strategy's own error, a store's error (an incomplete `.env`), an unreadable file |

A certificate, a key or a file's content never reaches a log line, a refusal,
a `DestinationConfigError`, a thrown message or the session store.

**The certificate is pinned for the broker's lifetime.** It is read when the
destination's provider is built, and that provider is cached per destination
for as long as the `AuthBroker` lives. An XSUAA x509 key's certificate lives
about seven days: a long-running process then gets `the client certificate
has expired` from its provider until it builds a new `AuthBroker`, and
replacing the key or the PEM files changes nothing before that. Rotating
certificates is out of scope: create a new key, then a new broker (restart).

**What is measured.** `client_credentials` with an x509 XSUAA service key,
against XSUAA on a BTP trial (2026-10-05; the instance's `credential-types`
`["binding-secret", "x509"]`, its key created with
`{"credential-type": "x509"}`): through the broker
(`fromServiceKeyCertificate()` + `XsuaaServiceKeyStore`, `getProvider` and the
token API), through `mcp-auth --client-auth certificate` and through
`generate-env-from-service-key --client-auth certificate`, each followed by a
fresh broker over the written destination — see *Testing*. **Not measured:**
`authorization_code` and `passcode` over x509 (the broker builds them, nothing
has run them against XSUAA), the OIDC grants and `saml2_bearer` with a
strategy, and ABAP environment service keys with x509 (`AbapServiceKeyStore`
holds no certificate client).

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
  `getProvider` never seeds from it. Both are fixed when your provider is
  built for the destination (an instance: at its first call for it) and kept
  with it: a URL or client changed later never re-labels a token that
  provider obtained — a new broker picks the change up.

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

## Migrating from 4.0.0

4.1.0 is a minor: nothing to change to keep 4.0.0's behaviour. Without a
`clientAuthentication` strategy every destination is served as before and
nothing certificate-related is read. What a 4.0.0 consumer may still notice:

1. **A refusal's message gains a hint.** A UAA, OIDC or `saml2_bearer`
   destination whose key store answers no client (or one without a client
   id) is still a `DestinationConfigError` with the same `missingFields`; its
   message now ends with `; a certificate client needs a clientAuthentication
   strategy`. Match on `missingFields` or the class, never the message.
2. **Dependencies.** `@mcp-abap-adt/interfaces-auth-broker` `^1.2.0` (the
   optional `IServiceKeyStore.getClientCertificate` and `IClientCertificate`),
   `@mcp-abap-adt/interfaces-auth` `^3.2.0` and `@mcp-abap-adt/auth-providers`
   `^5.3.0` (`IClientAuthentication`). A key store that reads x509 keys is
   auth-stores `^3.3.0`; an older store simply has no certificate client.
3. **New exports:** `fromServiceKeyCertificate`, `fromServiceKeySecret`, and
   the types `ClientAuthenticationStrategy`, `ClientAuthenticationContext`,
   `ClientAuthenticationGrant`, `FromServiceKeySecretOptions`,
   `TokenProviderClient`, `IClientCertificate`, `IClientAuthentication`.

**Adopting a strategy** (`clientAuthentication`, see *How the Client
Authenticates*) changes, for the destinations it applies to:

- **No secret goes to the provider** — the strategy's answer does; a
  provider's constructor refuses both.
- **A secret is bound to the client's identity**: a secret key and an x509
  key of the same client id at the same `uaaUrl` share one session, so
  switching between them keeps the token and the refresh token; a destination
  stating no parseable `serviceUrl` reuses a session stored without
  `issuedFor`, which 4.0.0 never did.
- **The token API with a factory of yours** passes the fourth argument; seeds
  your factory with a stored refresh token, token or cookies only when the
  session is bound here (4.0.0 carried the stored refresh token over whatever
  its binding); refuses a destination that states no `authType` / `grantType`;
  and turns a throwing factory into a `DestinationConfigError` naming
  `provider`, `clientAuthentication`.

## Migrating from 3.x

4.0.0 is a major: what a 3.x consumer must do, in short (the full list is the
[CHANGELOG](CHANGELOG.md)'s 4.0.0 entry).

1. **Session store: `@mcp-abap-adt/auth-stores` 3 or later** (`^3.1.0` for
   the binding), or one of your own on the
   `@mcp-abap-adt/interfaces-auth-broker` contract. The broker writes the
   secret alone — token or cookies, `expiresAt`, refresh token, `issuedFor`,
   `issuedBy` — and auth-stores 1.x/2.x's session stores refuse such a write
   (their `AbapSessionStore` throws without `serviceUrl`): they are not
   supported. A custom store must keep `issuedFor` and `issuedBy`.
2. **State the means in a key store**, not in the session: `authType`, and
   for `jwt` / `saml` a `grantType`; the client; the URL. For a SAP service
   key, `new AbapServiceKeyStore(dir, { grantType: 'authorization_code' })`
   (or `XsuaaServiceKeyStore`); otherwise `EnvDestinationStore(dir, {
   fallback })`. A 3.x session file is a readable destination as it is once
   it states `SAP_AUTH_TYPE` (and `SAP_GRANT_TYPE` for `jwt` / `saml`).
3. **A connector of `@mcp-abap-adt/connection` 10** takes `await
   broker.getProvider(destination)` — no `getToken` before connecting, no
   token refresher. Give the broker the collaborators its grants need
   (`authorization`, `oidcAuthorization`, `deviceCodePresenter`,
   `samlCookies`, `assertionReplayStore`); there is no default.
4. **The token API** keeps its calls, signatures and 3.x reads with a
   `provider` of yours; it writes the secret alone, refuses a destination
   stated `basic` or `snc`, and throws a failed write while the broker retries
   it.
5. **`getConnectionConfig` / `getAuthorizationConfig`** compose the key
   store's means with the session's secret; a URL or client kept only in the
   session store is not found any more.
6. **New:** catch `DestinationConfigError`; call `flush()` on shutdown;
   write `bindingOf(means)` beside a credential you hand over yourself.
7. **Contracts:** `interfaces-auth` 3, `interfaces-auth-sap` 2,
   `interfaces-auth-broker` 1.1 (the store contracts moved there from
   `interfaces-auth-sap`), auth-providers 5. The commands are
   `@mcp-abap-adt/auth-broker-cli` 2.0.0.

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

The library reads no environment variable: the stores take their directories
from their constructors, and the providers their settings from the
destination's means and the collaborators you give the broker. (In the
repository's test suites, `DEBUG_BROKER=true` — or `DEBUG_AUTH_BROKER=true`,
`DEBUG=broker` — turns on the test logger, its level from `AUTH_LOG_LEVEL`.)

### Logging

Pass an `ILogger` as the constructor's second argument (for instance
`DefaultLogger` from `@mcp-abap-adt/logger`); without one, nothing is logged.

**What is logged:** the broker's initialization (whether a key store is
given; the `provider` option: `none`, `factory` or `instance`), each provider build (the destination's `authType` and grant, whether
it was seeded), each session secret saved (token or cookies, whether a
refresh token came back, the expiry), a stored secret discarded because it is
bound elsewhere (the destination only), and each failed write with the error's
class name.

**What is never logged:** any part of a token, refresh token, password or
secret — not a prefix, not a suffix — nor a store error's message, which may
quote what was being written.

With `DefaultLogger` at `info`:

```
[INFO] ℹ️ [AuthBroker] Session secret saved for TRIAL
{"credential":"token","hasRefreshToken":true,"expiresAt":1790000000000}
```

### File Structure

With `@mcp-abap-adt/auth-stores` 3 one `<destination>.env` file can hold a
destination whole, each store reading and writing only its own keys — the
means through `EnvDestinationStore`, the secret through `AbapSessionStore`
(or both in separate directories, as you compose them):

```env
# The means — EnvDestinationStore (ABAP_DESTINATION_VARS); the broker never writes them
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_GRANT_TYPE=authorization_code
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=client_id
SAP_UAA_CLIENT_SECRET=client_secret

# The secret — AbapSessionStore (ABAP_SESSION_VARS); what the broker writes
SAP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
SAP_EXPIRES_AT=1790000000000
SAP_REFRESH_TOKEN=refresh_token_string
SAP_ISSUED_FOR=https://your-system.abap.us10.hana.ondemand.com:443?sap-client=100
SAP_ISSUED_BY=https://your-account.authentication.us10.hana.ondemand.com:443?client_id=client_id
```

A client that authenticates with a certificate states `SAP_UAA_CLIENT_CERT_PATH`,
`SAP_UAA_CLIENT_KEY_PATH` and `SAP_UAA_CERT_URL` — paths and a URL, never PEM —
in place of `SAP_UAA_CLIENT_SECRET` (see *How the Client Authenticates*).
SAML cookies are `SAP_SESSION_COOKIES_B64` in place of `SAP_JWT_TOKEN`. The
XSUAA stores use the same names with `XSUAA_` (`XSUAA_DESTINATION_VARS`,
`XSUAA_SESSION_VARS`; the URL is `XSUAA_MCP_URL`). Every means key
(`SAP_USERNAME`, `SAP_SNC_*`, `SAP_OIDC_*`, `SAP_SAML_*`, …) is listed in
[USAGE.md](../../docs/using/USAGE.md#environment-variables).

#### Service Key File (`{destination}.json`)

A SAP service key, read by `AbapServiceKeyStore` (an ABAP environment key:
the client and the ABAP URL) or `XsuaaServiceKeyStore` (an XSUAA key: the
client). A key cannot state which grant the destination uses, so the store is
told: `new AbapServiceKeyStore(dir, { grantType: 'authorization_code' })`.

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

An XSUAA key carries no URL of the resource it authorizes for: state it as
means in an `EnvDestinationStore` (`XSUAA_MCP_URL`, with
`XSUAA_DESTINATION_VARS`) whose `fallback` is the `XsuaaServiceKeyStore`.

An x509 XSUAA key (created with `{"credential-type": "x509"}`) holds a
certificate client instead of a secret — the broker uses it only beside a
`clientAuthentication` strategy (see *How the Client Authenticates*):

```json
{
  "url": "https://your-account.authentication.us10.hana.ondemand.com",
  "clientid": "sb-your-app!t12345",
  "certificate": "-----BEGIN CERTIFICATE-----\n...",
  "key": "-----BEGIN RSA PRIVATE KEY-----\n...",
  "certurl": "https://your-account.authentication.cert.us10.hana.ondemand.com",
  "credential-type": "x509"
}
```

## Responsibilities and Design Principles

### Core Development Principle

**Interface-Only Communication**: This package follows a fundamental development principle: **all interactions with external dependencies happen ONLY through interfaces**. The code knows **NOTHING beyond what is defined in the interfaces**.

This means:
- Does not know about concrete store classes (e.g., `AbapSessionStore`); the provider classes it knows only to construct the one a destination states, and hands out as `IAuthProvider`
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

1. **Composing the stores and collaborators**: an `IServiceKeyStore` for the means and an `ISessionStore` for the secret — with auth-stores 3:
   - **ABAP systems (a SAP service key)**: `AbapServiceKeyStore(dir, { grantType })`, alone or as the `fallback` of an `EnvDestinationStore`, and `AbapSessionStore` (or `SafeAbapSessionStore`, in memory)
   - **Destinations without a key** (basic, SNC, OIDC, SAML, `none`): `EnvDestinationStore(dir)` and `AbapSessionStore`
   - **XSUAA services**: `EnvDestinationStore(dir, { variables: XSUAA_DESTINATION_VARS, fallback: new XsuaaServiceKeyStore(keys, { grantType }) })` and `XsuaaSessionStore` (or `SafeXsuaaSessionStore`)
   - the collaborator options the destinations' grants need — or, for the token API the 3.x way, an `IRefreshableTokenProvider` of your own

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
2. **Dependency Inversion Principle (DIP)**: `AuthBroker` depends on abstractions (`IServiceKeyStore`, `ISessionStore`, `IAuthProvider`, `IRefreshableTokenProvider`), not concrete store implementations; the providers it builds it hands out as `IAuthProvider`
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
          client?: TokenProviderClient, // only beside clientAuthentication (4.1.0)
        ) => IRefreshableTokenProvider);
    // Collaborators, each a function of the destination, called once per
    // build, never disposed by the broker:
    authorization?: (destination: string, grant: StrategyGrant) => IAuthorizationStrategy<string>; // authorization_code, passcode, saml2_pure, saml2_bearer
    oidcAuthorization?: (destination: string) => IAuthorizationStrategy<OidcCallbackResult>; // oidc_authorization_code
    deviceCodePresenter?: (destination: string) => IDeviceCodePresenter; // device_code
    samlCookies?: (destination: string) => (samlResponse: string) => Promise<string>; // saml2_pure
    assertionReplayStore?: (destination: string) => IAssertionReplayStore; // saml2_pure, saml2_bearer
    // How a client authenticates (4.1.0): every grant that authenticates one
    clientAuthentication?: ClientAuthenticationStrategy;
  },
  logger?: ILogger,
)
```

**Parameters:**
- `config.sessionStore` - **Required** - The session secret: the token or cookies, `expiresAt`, the refresh token, and what it is bound to (`issuedFor`, `issuedBy`). For the token API with a `provider`, its `serviceUrl`, or the service key's, is required (3.x's reads).
- `config.serviceKeyStore` - The means: `authType`, `grantType`, the client, basic's user and password, the SNC, OIDC and SAML fields, `serviceUrl`. **Required by `getProvider`**, which has no other source of means.
- `config.provider` - The token API's source (`getToken`, `refreshToken`, `createTokenRefresher`): a provider instance, used for every destination, or a factory (`TokenProviderFactory`), called once per destination and seeded with what the stores hold (see *Basic Usage*); beside a `clientAuthentication` strategy, with a fourth argument (`TokenProviderClient`, see *How the Client Authenticates*). Not used by `getProvider`. Without it, the token API asks the provider `getProvider` builds for the destination (see *Getting Tokens*); with neither it nor a `serviceKeyStore`, the token API throws `DestinationConfigError` naming both.
- `config.authorization` - The interactive strategy of `jwt` / `authorization_code`, `jwt` / `passcode`, `saml` / `saml2_pure` and `saml` / `saml2_bearer`, as a function of the destination and the grant (see *A Provider for a Connector*).
- `config.oidcAuthorization` - The interactive strategy of `jwt` / `oidc_authorization_code`.
- `config.deviceCodePresenter` - Where `jwt` / `device_code` shows the user the verification URL and code.
- `config.samlCookies` - `saml2_pure`: turns the validated SAMLResponse into the system's session cookies.
- `config.assertionReplayStore` - The replay store the SAML validators record each assertion in.
- `config.clientAuthentication` - How the client of every grant that authenticates one (the UAA and OIDC grants, `saml2_bearer`) authenticates to the authorization server: a `ClientAuthenticationStrategy` — `fromServiceKeyCertificate()`, `fromServiceKeySecret({ encoding })`, or your own composition. Called once per build; absent, the client secret as in 4.0.0 and nothing certificate-related is read (see *How the Client Authenticates*).
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
  when the key store has no client — an x509 key's included: it never answers
  a certificate or a key.

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
  | a client row (UAA, OIDC, `saml2_bearer`) with no client id and no `clientAuthentication` strategy | as above; the message adds `a certificate client needs a clientAuthentication strategy` |
  | the `clientAuthentication` strategy threw, refused, or answered no client authentication; the certificate client could not be read | `clientAuthentication` (fixed words, see *How the Client Authenticates*) |
  | the token API with a `clientAuthentication` strategy and a factory, on a destination that states no `jwt` / `saml` type | `authType`, `grantType` |
  | the token API's factory threw beside a `clientAuthentication` strategy | `provider`, `clientAuthentication` |
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

Provider implementations live in `@mcp-abap-adt/auth-providers` 5. `getProvider`
builds the one the destination states (see *A Provider for a Connector*); for
the token API the 3.x way you pass one yourself — an `IRefreshableTokenProvider`
or a factory:

- **`ClientCredentialsProvider`** — `client_credentials`: no user, no browser,
  no refresh token.
- **`AuthorizationCodeProvider`** — `authorization_code`: refreshes by the
  stored refresh token, and logs in through the `authorization` strategy you
  give it — there is no default. `browserCallbackStrategy({ browser?, port?,
  timeoutMs? })` builds the usual one (callback port `61001` unless `port` is
  given; held only for the duration of a login).

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

### The x509 Live Check

`npm run test:live:x509` (from the repository root or this package) runs
`client_credentials` with an x509 XSUAA service key against a real BTP
subaccount: it builds, creates an `xsuaa` / `application` instance
(`credential-types: ["binding-secret", "x509"]`) and a key made with
`{"credential-type": "x509"}`, runs `src/__tests__/live/x509.live.test.ts`
— the broker with `fromServiceKeyCertificate()`, `mcp-auth --client-auth
certificate`, `generate-env-from-service-key --client-auth certificate`, a
fresh broker over each written destination, and a failing run that leaves the
previous destination untouched and prints no PEM — and removes everything,
also when a test fails. Not in `npm test`, not in CI.

It refuses to run unless `XSUAA_CF_API`, `XSUAA_CF_ORG` and `XSUAA_CF_SPACE`
equal exactly what `cf target` shows (`cf login -a <api> --sso -o <org> -s
<space>` first). It touches only what it created: each resource is recorded
with its GUID in a ledger, `tests/live/x509/.local/owned` (gitignored, with
the key and its PEM files, owner-only), bound to that API, org and space, and
re-checked before every reuse or delete; a name held by anything else is
refused. A failed teardown exits non-zero and keeps `.local/` — run
`tests/live/x509/teardown.sh` with the same three variables. `X509_KEEP=1`
keeps the environment for another run; `-- -t "(b)"` runs one case. Last run:
BTP trial, 2026-10-05, all five cases passed.

## Documentation

Complete documentation is available in the repository's [`docs/`](../../docs/) directory:

- **[Architecture](../../docs/architecture/ARCHITECTURE.md)** - System architecture and design decisions
- **[Testing](../../docs/development/TESTING.md)** - Where the suites live, what they need, the release checks
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

