# @mcp-abap-adt/auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A per-destination credential broker for SAP BTP and ABAP systems. For a destination — a name,
such as `TRIAL` — `getProvider` builds the `IAuthProvider` the destination states (basic, SNC, a
UAA, OIDC or SAML grant, or a credential handed over) from the *means* in the service key store
and the *secret* in the session store, ready for a `@mcp-abap-adt/connection` 14 connector, and
stores back every token or set of SAML session cookies that provider obtains or renews. The
token API (`getToken`, `refreshToken`, `createTokenRefresher`) serves whoever wants a token and
nothing else. It decides nothing about tokens itself: whether the cached token is still good,
when to refresh and when to log in is the provider's call (`@mcp-abap-adt/auth-providers`) and
the renewal strategy's you give it; where means and secrets live is the stores'
(`@mcp-abap-adt/auth-stores`, or your own).

**Upgrading from 4.x?** 5.0.0 is a major: see [*Migrating to 5.0.0*](#migrating-to-500). In
short — a token destination needs two options the broker has no default for (`renewal`,
`onWriteFailure`); every failure is an `AuthProviderFailure` read through
`@mcp-abap-adt/auth-errors`; every session written before 5.0.0 reads as unbound once, so each
token destination logs in once after the upgrade.

The `mcp-auth` command that writes destination files is
[`@mcp-abap-adt/auth-broker-cli`](../auth-broker-cli/README.md) (3.0.0, on this version), in the
same repository. This package has no `bin`.

## Features

- 🔌 **A credential for a connector**: `getProvider(destination)` builds the `IAuthProvider` the destination states — basic, SNC, the UAA grants (authorization code, client credentials, passcode), the OIDC grants (authorization code with PKCE, device code, password, token exchange), the SAML grants (session cookies, bearer token), or a credential handed over — from the service key store's means and the session store's secret
- 🧭 **You compose, the broker does not guess**: how a token provider renews (`renewal`) and what a session write that did not land means (`onWriteFailure`) are your statements, with no default
- 💾 **What a provider obtains is stored**: every token or set of SAML session cookies a provider obtains or renews — at `prepare()`, on expiry, or after a 401 in `rejected()` — is written to the session store before the provider answers, one write at a time per destination; `flush()` tells you whether everything landed
- 🔒 **A credential stays bound to its identity**: a stored secret is reused only by a provider built from exactly the means it was obtained under — the resource, the row (`authType` / `grantType`), the client, every server address and the trust; anything else changed, a new provider is built, and it starts with nothing
- 🛑 **Every wait can be cancelled by whoever waits**: `getProvider`, the token API and `flush()` take a `signal`; the broker sets no timeout of its own
- 🧾 **Failures as the provider made them**: a provider's `AuthProviderFailure` reaches you as the same object; the broker's own refusals carry names, never values
- 🪙 **A token API for whoever wants a token and nothing else**: `getToken`, `refreshToken` and `createTokenRefresher` on the destination's own provider, or on one you give the broker
- 📜 **x509 service keys**: a client that authenticates with a certificate instead of a secret, when you say so — `clientAuthentication: fromServiceKeyCertificate()`; the certificate and key never reach the session store, a log line or an error

## Installation

```bash
npm install @mcp-abap-adt/auth-broker @mcp-abap-adt/auth-providers @mcp-abap-adt/auth-errors @mcp-abap-adt/auth-stores
```

5.0.0 depends on `@mcp-abap-adt/auth-providers` `^6.0.0`, `@mcp-abap-adt/auth-errors`
`^2.1.1`, `@mcp-abap-adt/interfaces-auth` `^7.5.0`, `@mcp-abap-adt/interfaces-auth-sap`
`^3.3.0`, `@mcp-abap-adt/interfaces-auth-broker` `^1.3.0` and
`@mcp-abap-adt/interfaces-utils` `^1.1.0`. Declare `auth-providers` yourself — the renewal
strategies (`refreshThenLogin`, `refreshOnly`) and the interactive strategies come from it —
and `auth-errors` to read a failure. The stores are yours to choose: `@mcp-abap-adt/auth-stores`
`^4.0.0`, or any implementation of the `@mcp-abap-adt/interfaces-auth-broker` contracts. Keep
one installed copy of each contract package (`npm ls @mcp-abap-adt/interfaces-auth`,
`npm ls @mcp-abap-adt/auth-errors`): a failure of another copy is still read correctly, but
loses its diagnostics.

Requires Node.js 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`): 22 and 24 are the versions
SAP BTP's Cloud Foundry Node.js buildpack offers, and 26 is supported as well.

## Usage

### A Provider for a Connector: `getProvider`

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  browserCallbackStrategy,
  linuxDefaultBrowser,
  refreshThenLogin,
} from '@mcp-abap-adt/auth-providers';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';

const broker = new AuthBroker(
  {
    // The means: <destinations>/<name>.env, else the SAP service key <keys>/<name>.json.
    serviceKeyStore: new EnvDestinationStore('/path/to/destinations', {
      fallback: new AbapServiceKeyStore('/path/to/keys', {
        grantType: 'authorization_code',
      }),
    }),
    // The secret: the token or cookies, its expiry, the refresh token, its binding.
    sessionStore: new AbapSessionStore('/path/to/sessions'),
    // How a token provider renews: refresh, then log in (4.x's steps). Required.
    renewal: () => refreshThenLogin(),
    // What a session write that did not land means. Required.
    onWriteFailure: 'fail',
    // The interactive half of authorization_code: the platform's default browser.
    authorization: () => browserCallbackStrategy({ browser: linuxDefaultBrowser() }),
  },
  logger, // optional ILogger
);

const session = new AbortController(); // the connector's session: abort it when the session ends
const provider = await broker.getProvider('TRIAL', { signal: session.signal });
// new AdtCloudConnector({ url, client, authType: 'jwt' }, provider, transport, logger) …
```

`getProvider(destination)` returns the `IAuthProvider` (from `@mcp-abap-adt/interfaces-auth`
7) that a `@mcp-abap-adt/connection` 14 connector takes as it is. The broker reads two stores,
each for one role:

- **the means** — `authType`, `grantType`, basic's user and password, the SNC, OIDC and SAML
  fields, `serviceUrl`, the client — from the **service key store** (`getConnectionConfig`,
  `getAuthorizationConfig`, and `getClientCertificate` when a `clientAuthentication` strategy
  asks), and only from there;
- **the secret** — the token or session cookies, `expiresAt`, the refresh token, and what it
  is bound to — from the **session store** (`loadSession`), and only from there.

Nothing is inferred: the destination's `authType` (and `grantType`, for `jwt` and `saml`)
decides the provider, never which other fields are present.

| `authType` / `grantType` | Provider (auth-providers 6) | Read from the key store | Read from the session store |
|---|---|---|---|
| `basic` (no grant read) | `new BasicAuthProvider(username, password)` | `username`, `password` | nothing |
| `snc` (no grant read) | `SncLogonProvider.forSecureLoginClient({ partnerName, qop, sncLib, myName, logger })` | `sncPartnerName` (required); `sncQop`, `sncLib`, `sncMyName` when set | nothing |
| `jwt` / `authorization_code` | `AuthorizationCodeProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret`; `serviceUrl`, `sapClient` for the binding | the seed: `authorizationToken`, `refreshToken`, `expiresAt` — see *A Credential Stays Bound to Its Identity* |
| `jwt` / `client_credentials` | `ClientCredentialsProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret`; `serviceUrl`, `sapClient` for the binding | nothing (the row takes the client alone) |
| `jwt` / `passcode` | `UaaPasscodeProvider` | the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`''` = a public client); `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `oidc_authorization_code` | `OidcBrowserProvider` (PKCE) | `uaaClientId`, `uaaClientSecret` (`''` = a public client); `oidcIssuerUrl`, or `oidcAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `device_code` | `OidcDeviceFlowProvider` | the client as above; `oidcIssuerUrl`, or `oidcDeviceAuthorizationEndpoint` + `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `password` | `OidcPasswordProvider` | the client as above; `username`, `password`; `oidcIssuerUrl`, or `oidcTokenEndpoint`; `oidcScopes`; `serviceUrl`, `sapClient` | the seed, as above |
| `jwt` / `token_exchange` | `OidcTokenExchangeProvider` (RFC 8693) | the client as above; `oidcSubjectToken`, `oidcSubjectTokenType`; `oidcAudience`, `oidcActorToken`, `oidcActorTokenType` when set; `oidcScopes`, joined by one space into its `scope`; `oidcIssuerUrl`, or `oidcTokenEndpoint`; `serviceUrl`, `sapClient` | nothing: its subject token is a secret and cannot bind a stored session, so it obtains a fresh token after every restart (no refresh grant: a renewal exchanges again) |
| `saml` / `saml2_pure` | `Saml2PureProvider` | `samlIdpSsoUrl`, `samlSpEntityId`, `samlIdpEntityId` (the expected issuer), `samlIdpCertificates`; `samlAcsUrl`, `samlRelayState`, `samlIdpInitiated`, `samlClockSkewMs` when set; `serviceUrl`, `sapClient` | the seed: `sessionCookies`, `expiresAt` |
| `saml` / `saml2_bearer` | `Saml2BearerProvider` (RFC 7522) | the same SAML fields; `samlTokenUrl` when set; the client: `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`''` = a public client); `serviceUrl`, `sapClient` | the seed: `authorizationToken`, `refreshToken`, `expiresAt` |
| `jwt` / `none` | `TokenAuthProvider.fixed(authorizationToken)` | `authType`, `grantType`, `serviceUrl` (+ `sapClient`); the client and `oidcIssuerUrl` when stated | `authorizationToken` (required), `issuedFor` and `issuedBy` (required to match exactly) |
| `saml` / `none` | `new SamlAuthProvider(sessionCookies)` | `authType`, `grantType`, `serviceUrl` (+ `sapClient`); `samlAcsUrl` when stated | `sessionCookies` (required), `issuedFor` and `issuedBy` (required to match exactly) |

The allowed pairs are `jwt` with `authorization_code`, `client_credentials`, `passcode`,
`oidc_authorization_code`, `device_code`, `password`, `token_exchange` or `none`, and `saml`
with `saml2_pure`, `saml2_bearer` or `none`. A pair outside them is a `DestinationConfigError`
naming `grantType`.

**No provider reads `serviceUrl`.** The URL of the system is where the connector connects, not
authorization data: give the connector its URL from your key store (`getConnectionConfig`). The
broker reads it, with `sapClient`, for one thing only: to bind a stored secret to the resource
it was obtained for. A token destination without it still gets its provider, but no stored
secret is reused for it (except on the `clientAuthentication` strategy path, below).

`none` is how a handed-over credential is stated: the key store says `grantType: 'none'`, and
the token or cookies live in the session. The SNC row takes the contract's own defaults when a
field is absent — the library is discovered (`SNC_LIB_64`, `SNC_LIB`, the Secure Login Client's
install path) when `sncLib` is, the user's SNC name comes from the credential when `sncMyName`
is, and `qop` is the provider's `'9'` when `sncQop` is.

**The UAA grants.** The client comes from the key store's `getAuthorizationConfig` — never from
the session store. A seed is presented while it is valid (a JWT's own `exp` decides; the stored
`expiresAt` serves a token that carries none), and its refresh token renews it, as the renewal
strategy says. Without a seed the provider obtains its first token at `prepare()`.
`uaaClientSecret: ''` is a public client: `passcode` takes it as no secret;
`AuthorizationCodeProvider` and `ClientCredentialsProvider` require a secret, so for them `''`
is missing. With a `clientAuthentication` strategy no secret is read or required (see *How the
Client Authenticates*).

**The OIDC grants.** The client is the key store's `getAuthorizationConfig` again: `uaaClientId`,
and `uaaClientSecret` — `''` is a public client, sent with no secret. The endpoints come from
`oidcIssuerUrl`, which the provider discovers them from, or — without it — from every explicit
endpoint the row reads; without either the error names `oidcIssuerUrl` and the endpoints
missing. `oidcScopes` is passed as given (`token_exchange` takes one `scope` string: the scopes
joined by a space). The subject and actor tokens of `token_exchange` and the user and password
of `password` are means: sent to the token endpoint, never written to the session.

**The SAML grants.** Each provider validates the assertion before anything uses it, with a
validator the broker composes from the destination's trust and your replay store:
`createSignedResponseValidator` for `saml2_pure` (the Response must be signed — the cookies'
system receives it whole) and `createSignedAssertionValidator` for `saml2_bearer` (the Assertion
must be signed — the token endpoint receives it alone), from `samlIdpCertificates` (PEM or
base64 DER; several during a rotation), `samlClockSkewMs` and `assertionReplayStore(destination)`;
`samlIdpEntityId` is the issuer every assertion must name. A certificate the validator cannot
read is a `DestinationConfigError` naming `samlIdpCertificates` and carrying the validator's
error; a `samlClockSkewMs` that is not a whole, non-negative number of milliseconds is one naming
`samlClockSkewMs`. `samlIdpInitiated: true` declares an IdP-initiated login: no AuthnRequest,
and an assertion carrying no `InResponseTo` — your strategy then hands over the SAMLResponse
without asking for an authorization URL. Cookies carry no expiry of their own, so `saml2_pure`
keeps them until the assertion's earliest `NotOnOrAfter` (less the provider's one-minute
margin); SAML has no refresh token, so its renewal is a new login through your strategy.
`saml2_bearer` posts the Assertion to `samlTokenUrl`, else `<uaaUrl>/oauth/token`, with the
client, and renews by its refresh token.

**The collaborator options** — each a function of the destination, called once per build of
that destination's provider (again for every new build, see *A Credential Stays Bound to Its
Identity*), never disposed by the broker, and required only by the rows that use it; a row whose
option is missing is a `DestinationConfigError` naming it:

| Option | Rows | What it returns |
|---|---|---|
| `authorization(destination, grant)` | `authorization_code`, `passcode`, `saml2_pure`, `saml2_bearer` (the grant is passed: a `StrategyGrant`) | the `IAuthorizationStrategy<string>` that conducts the login — for `passcode`, the one that asks for the code (handed `<uaaUrl>/passcode` as the URL); for the SAML grants, the one that returns the SAMLResponse |
| `oidcAuthorization(destination)` | `oidc_authorization_code` | an `IAuthorizationStrategy<OidcCallbackResult>` (`oidcCallbackStrategy`, or `asOidcResult(…)` over a string strategy) |
| `deviceCodePresenter(destination)` | `device_code` | an `IDeviceCodePresenter` that shows the user the verification URL and code (`consoleDeviceCodePresenter(logger)`, or your UI) |
| `samlCookies(destination)` | `saml2_pure` | `(samlResponse) => Promise<string>`: posts the validated SAMLResponse to the system's ACS and returns the session cookies it sets |
| `assertionReplayStore(destination)` | `saml2_pure`, `saml2_bearer` | the `IAssertionReplayStore` the validator records each assertion in, refusing one presented twice — `defaultReplayStore` (process-wide, in memory) or a shared one of yours |

A strategy you write yourself must honour `AuthorizationRequest.signal` (auth-providers 6):
when it aborts, the strategy stops waiting and releases what it holds before it settles.

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  browserCallbackStrategy,
  consoleDeviceCodePresenter,
  defaultReplayStore,
  linuxDefaultBrowser,
  manualPasscodeStrategy,
  oidcCallbackStrategy,
  refreshThenLogin,
  samlCallbackStrategy,
} from '@mcp-abap-adt/auth-providers';

const browser = linuxDefaultBrowser(); // macDefaultBrowser(), windowsDefaultBrowser(), …

const ssoBroker = new AuthBroker(
  {
    serviceKeyStore: myKeyStore,
    sessionStore: mySessionStore,
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
    authorization: (destination, grant) =>
      grant === 'passcode'
        ? manualPasscodeStrategy()
        : grant === 'saml2_pure' || grant === 'saml2_bearer'
          ? samlCallbackStrategy({ browser })
          : browserCallbackStrategy({ browser }),
    oidcAuthorization: () => oidcCallbackStrategy({ browser }),
    deviceCodePresenter: () => consoleDeviceCodePresenter(logger),
    samlCookies: (destination) => (samlResponse) =>
      postToAcs(destination, samlResponse), // yours: the system's ACS answers Set-Cookie
    assertionReplayStore: () => defaultReplayStore,
  },
  logger,
);
```

A login waits until it ends or a signal aborts it — no strategy of auth-providers 6 has a
timeout. A bound is yours to compose: the strategy's `signal` option, or the signal you pass the
broker (`AbortSignal.timeout(ms)`).

### How a Token Provider Renews: `renewal`

```typescript
import type { AuthBrokerConfig } from '@mcp-abap-adt/auth-broker';
import { refreshOnly, refreshThenLogin } from '@mcp-abap-adt/auth-providers';

// The same for every destination: refresh, then log in — what 4.x did.
const sameForAll: AuthBrokerConfig['renewal'] = () => refreshThenLogin();

// Per destination or grant: a headless destination never logs in.
const perDestination: AuthBrokerConfig['renewal'] = (destination, grant) =>
  destination === 'HEADLESS' || grant === 'device_code' ? refreshOnly() : refreshThenLogin();
```

`renewal(destination, grant)` is called once per build of every token row — the UAA, OIDC and
SAML grants (`TokenGrant`: every `DestinationGrant` but `none`) — after every other check of the
row has passed and before the provider's constructor; its answer is the provider's `renewal`,
unchanged. The broker never wraps, inspects or calls it.

- **Required for every token row, no default.** A token row built without it is a
  `DestinationConfigError` with `missingFields` naming `renewal` — together with every other
  field and option the row lacks, in one error — before any collaborator is called and before
  anything is cached. `basic`, `snc` and the `none` rows build without it.
- **A `renewal` that throws** is a `DestinationConfigError(['renewal'])`, "the renewal option
  failed", carrying what it threw as auth-errors reads it (`error`); nothing is built or cached.
  A provider that refuses the strategy it was given (one whose `next` is not a function) is a
  `DestinationConfigError` naming `renewal` too, "the provider refused the configuration the
  destination states", carrying the provider's error.
- **Never called for the token API's consumer `provider`**: an instance or a factory's result
  is your composition, and brings its own renewal.

`refreshThenLogin()` refreshes when there is a refresh token and logs in through the row's
interactive strategy when the refresh is refused or there is none. `refreshOnly()` never logs
in: a headless process uses it, or an `authorization` strategy that refuses (see *Headless
Processes*).

### Session Writes: `onWriteFailure`, the Write Queue and `flush()`

Every token provider `getProvider` builds writes what it obtains back to the session store
before it answers, whichever moment triggered the renewal: `prepare()`, `authorize()` on expiry,
or `rejected()` after a 401. A renewal inside a connector is stored before the connector resends.
The broker builds each provider's persistence from auth-providers' own
`refreshStatePersistence` over one write path of its own; you cannot give a provider the broker
builds a persistence strategy of yours, since the broker writes the binding beside the secret.

`onWriteFailure: 'fail'` suits a command or a test that must know the secret landed;
`onWriteFailure: 'continue'` a long-running server that goes on best effort. **It is required** for every destination that writes a secret — a token row
`getProvider` builds, and every call of the token API with a `provider` of yours. Without it the
build (or the call) throws `DestinationConfigError` naming `onWriteFailure`; `basic`, `snc` and
`none` destinations do not need it. One option serves both paths.

- **`'fail'`:** the call whose write did not land fails — `unknown`, `persisting-tokens`
  ("persisting the tokens failed (unknown error, EACCES)", the code only when it is
  allowlisted): for a provider the broker built, the provider's awaited report fails its
  `getTokens()` / `refreshTokens()` or its moment, and the token API relays that failure; on
  the consumer path the token API rejects with the same failure. And **while the destination's
  last write is pending, its calls are refused until a write lands**: `getProvider`, `getToken`
  and `refreshToken` ask "is the destination's last write pending?" on entry and once more right
  before they return success; each time the answer is yes they retry that write — it lands, the
  call goes on; it fails, the call rejects with the same failure. "Pending" is any write not yet
  landed: failed, queued or in flight. **The limit:** a provider already handed to a connector
  answers its moments from its own state; a moment that commits nothing (a valid cached token
  presented) is not refused because of a pending write. Every moment that renews writes, and
  awaits its write.
- **`'continue'`:** no call fails because of a write. A failed write is logged (`warn`, the
  failure's `logFields` only), stays pending, and the call goes on.

**The write queue.** The writes of one destination run one at a time, in the order they were
queued, so an older write never runs after — and never overwrites — a newer one; destinations
never wait on each other. A write of a provider that has since been replaced (see *A Credential
Stays Bound to Its Identity*) is dropped once the new provider has written. **A failed write
stays pending** — the latest state its provider reported, which every later write of that
provider carries too — and is retried by the destination's next write or by `flush()`. **There
is no retry timer**: nothing is retried on its own. Every wait on the queue races its caller's
signal: an abort releases that caller at once with auth-errors' `aborted` failure — never with
success — and the write runs on, landing or failing on its own.

**The store's contract.** `saveSession` settles: it resolves or rejects. A store whose
`saveSession` never settles holds its destination's queue; avoiding that is yours (each waiting
caller is still released by its own signal). auth-stores 4's `saveSession` **merges** — a field
left out keeps what is stored — so the broker states every field that must not survive:

| What the provider reported | What one `saveSession` writes |
|---|---|
| a token | `authorizationToken`, `expiresAt`, `refreshToken` (below), `issuedFor` (`''` when the means state no `serviceUrl`), `issuedBy` |
| `saml2_pure`'s cookies (`tokenType: 'saml'`) | `sessionCookies`, `expiresAt`, `refreshToken: ''` (SAML has none, and one stored beside earlier cookies or a token is not this credential's), `issuedFor`, `issuedBy` |
| a refresh token discarded before any credential is held | **only** `refreshToken: ''` — the stored credential keeps its own binding and loses its refresh token |

**The refresh token a provider owns.** Each provider the broker builds owns a refresh token: the
one it was seeded with from a session bound to it, or none; then each write updates it — a new
one written makes it owned, a discard makes it none. A write that reports no new refresh token
writes the owned one, or `''` when it owns none — never one read from the store at write time.
So a refresh token is persisted only by the provider that obtained it or was seeded with it and
has not discarded or replaced it since; a refresh token another provider of the destination
wrote never ends up beside this provider's credential. `expiresAt` is the provider's report,
absolute. A destination the key store states as `basic` or `snc` at write time is not written.

**`flush({ signal? })`** waits for every write queued so far and gives each pending one one more
attempt. It resolves when all landed, and rejects with an `AggregateError` ("Session writes
still failing for "<destination>", …; each stays pending until its destination's next write or
flush()") whose `errors` are one `SessionWriteFailure` per destination still failing:
`destination`, and `error` — the store's error as auth-errors classifies it (`unknown`,
`persisting-tokens`), never its message; its own message is `"<destination>": <reason>`. What
still fails stays pending. Call it on shutdown — on `SIGTERM`, before a stdio transport closes —
to know whether every token is stored:

```typescript
import { SessionWriteFailure } from '@mcp-abap-adt/auth-broker';

process.on('SIGTERM', async () => {
  try {
    await broker.flush();
  } catch (error) {
    for (const failure of error instanceof AggregateError ? error.errors : [error]) {
      if (failure instanceof SessionWriteFailure) {
        logger.error(`Not stored: ${failure.destination}: ${failure.error.reason}`);
      }
    }
  }
  process.exit(0);
});
```

**Across restarts.** A new broker on the same stores seeds each token row only from a session
bound to its means, and with its refresh token only when that is not empty:

| Before the restart | After it |
|---|---|
| a refused refresh discarded the refresh token R, and its `''` write landed | no refresh token: the renewal strategy decides (with `refreshThenLogin()`, a login) |
| the same, the `''` write still pending when the process ended | `'fail'`: you noticed — every call failed and `flush()` rejected before exit; `'continue'`: **R comes back** from the store |
| a new refresh token R2 landed | R2 |
| a token-only result while R was held | R — the one that provider owned |
| a session obtained under other means | discarded, not seeded (one `warn` line) |

A remaining limit, auth-providers' own: a process that dies between a discard and its report
reaching the broker may present the stored R once after a restart.

### A Credential Stays Bound to Its Identity

A token's audience, cookies' host, a refresh token's issuer: presenting a secret to a resource
it was not obtained for, or for an identity it was not obtained under, is a leak. So the session
store keeps two strings beside the secret, and the broker reuses a stored secret only when both
are exactly what the destination's current means give.

- **`issuedFor`** — the resource: `serviceUrl` with the SAP client, canonical (4.x's form):
  scheme and host lower-cased, the port explicit (`443` / `80`), the path without a trailing
  `/`, one query parameter `sap-client` (the means' `sapClient` first), e.g.
  `https://my-abap.example.com:443/sap/bc/adt?sap-client=100`. Both sides are canonicalised
  before they are compared.
- **`issuedBy`** — a versioned record only the broker produces, compared by exact equality and
  never parsed:

  ```
  mcp-abap-adt-binding/2;<row>;<clientId>;<uaaUrl>;<oidcIssuerUrl>;<oidcTokenEndpoint>;
    <oidcAuthorizationEndpoint>;<oidcDeviceAuthorizationEndpoint>;<oidcAudience>;
    <samlIdpSsoUrl>;<samlAcsUrl>;<samlTokenUrl>;<certUrl>;<trust>
  ```

  (one line; broken here for reading). `row` is `authType/grantType` — or `provider/…` for the
  token API's consumer provider. Each address field is **the exact string the row hands its
  provider**, `encodeURIComponent`-encoded, `""` when the row hands it none — never
  canonicalised. `trust` is the lower-case hex SHA-256 of the row's non-secret trust input, or
  `""`.

Which fields each row fills, and its trust input:

| Row | Address fields | Trust input (hashed, in order) |
|---|---|---|
| UAA (`authorization_code`, `client_credentials`, `passcode`) | `clientId`, `uaaUrl`; `certUrl` when the build read a certificate client | `clientCertificate` (the certificate client's public certificate, when read — never its key) |
| OIDC (`oidc_authorization_code`, `device_code`, `password`, `token_exchange`) | `clientId`, `oidcIssuerUrl`, `oidcTokenEndpoint`; `oidcAuthorizationEndpoint` (`oidc_authorization_code`), `oidcDeviceAuthorizationEndpoint` (`device_code`), `oidcAudience` (`token_exchange`); `certUrl` as above | `oidcScopes`; `username` (`password`); `oidcSubjectTokenType`, `oidcActorTokenType` (`token_exchange`); `clientCertificate` |
| `saml2_pure` | `samlIdpSsoUrl`, `samlAcsUrl` | `samlIdpCertificates`, `samlIdpEntityId`, `samlSpEntityId`, `samlClockSkewMs`, `samlIdpInitiated` |
| `saml2_bearer` | `clientId`, `uaaUrl`, `samlIdpSsoUrl`, `samlAcsUrl`, `samlTokenUrl`; `certUrl` as above | the SAML trust above, then `clientCertificate` |
| `jwt` / `none` | `clientId`, `uaaUrl`, `oidcIssuerUrl` as the means state them | none |
| `saml` / `none` | `samlAcsUrl` | none |
| the token API's consumer factory | `clientId`, `uaaUrl` of the client it was handed; an instance: none | none |

**No secret takes part in either string, nor a hash of one** — not the password, the client
secret, a key, a subject or actor token: a hash in a session file can be checked offline against
guesses. The consequence: after a restart, a session obtained under a previous password or
client secret of the *same* user or client may seed (a revoked credential is refused by the
server and renewed through the renewal strategy); within one process any secret change makes a
new provider (below).

**When a stored secret seeds a provider.** Only the first build of a destination in a broker may
start from the store, and only when the stored `issuedFor` and `issuedBy` equal the build's
exactly **and** the build's binding is *fully stated*: its record holds the client the row
authenticates and every server address its provider sends a credential to:

| Row | Fully stated when the record holds |
|---|---|
| UAA | `clientId` and `uaaUrl`; and `certUrl` when the build read the certificate client |
| OIDC | `clientId`; the token endpoint (`oidcTokenEndpoint`, or `oidcIssuerUrl` it is discovered from); for `oidc_authorization_code` the authorization endpoint, for `device_code` the device endpoint (each explicit, or the issuer); `certUrl` as above |
| `saml2_bearer` | `clientId`, `samlIdpSsoUrl`, and the token endpoint (`samlTokenUrl`, or `uaaUrl`); `certUrl` as above |
| `saml2_pure` | `samlIdpSsoUrl` and `samlAcsUrl` |
| `token_exchange`, the token API's consumer provider | never |

The token, cookies and expiry then come from the same session read whose binding was checked,
and so does the refresh token the provider owns from then on. Otherwise the stored secret is not
used, **refresh token included**: the provider is built as with no session and obtains a new one
by its grant, and one `warn` line says only `<destination>: the stored session secret is not
recorded as issued under the destination's current means; not used, the provider obtains a new
one` — never a URI, a record or a token. A destination that can never be seeded (`token_exchange`,
means lacking what the record needs, or no `serviceUrl`) gets a `debug` line instead, on every
start. An OIDC destination with explicit endpoints and a client but no issuer is fully stated,
and is reused after a restart when its means are unchanged.

**The `none` rows** present a credential the broker cannot obtain again, so a mismatch is
refused, not discarded: a `DestinationConfigError` naming `issuedFor` when the stored resource
differs or is absent (or the means state no `serviceUrl`), and `issuedBy` when the stored record
is not exactly the row's.

**A provider is never changed.** Every call of `getProvider` and of the token API re-reads what
the destination's provider was built from — the means, the client, and the certificate client
when the build read it — and compares everything the build read, exactly (arrays element by
element, an absent value distinct from `''`), secrets included (held in memory beside the
provider, never logged, never persisted). Unchanged: the cached provider, as it is. **Anything
changed, by a single character** — trust, a secret, an address, the row: a **new provider**,
which starts with nothing — no token, no refresh token, nothing of the old provider and nothing
of a session written under other means: it logs in. The old one is never handed out again for
that destination; whoever already holds it keeps it, and its late writes are dropped once the
new one has written. A rotated client certificate is picked up the same way: at the next call, a
new provider presenting it.

**`bindingOf(means, client?)` — for a consumer that hands over a credential.** A `none`
destination presents a token or cookies the broker cannot obtain; whoever writes them to the
session store writes the binding beside them. `bindingOf` answers exactly what `getProvider`
compares for those means — `issuedFor` and the version-2 `issuedBy` of the row the means state —
so a consumer never builds a record itself:

```typescript
import { bindingOf } from '@mcp-abap-adt/auth-broker';

const means = await keyStore.getConnectionConfig('DEV'); // saml / none
await sessionStore.saveSession('DEV', {
  sessionCookies: cookies,
  refreshToken: '', // auth-stores 4 merges: clear what an earlier session left
  ...bindingOf(means ?? {}),
  // { issuedFor: 'https://dev.example.com:443?sap-client=100',
  //   issuedBy: 'mcp-abap-adt-binding/2;saml/none;;;;;;;;;;;;' }
});
```

A destination that states no `jwt` / `saml` type or no grant binds nothing (`{}`). A token row
built with a `clientAuthentication` strategy writes more than `bindingOf` knows (the certificate
client's `certUrl` and certificate), so `bindingOf` is for handed-over credentials.

**What you meet:**

1. **A custom `ISessionStore`** (a database, a secret store) must persist `issuedFor` and
   `issuedBy` beside the secret, byte for byte, answer them from `loadSession`, take
   `refreshToken: ''` as "clear the stored one", and settle every `saveSession`. One that drops
   them still type-checks, but the broker then never reuses its sessions: every process start
   is a fresh login.
2. **The first run after upgrading to 5.0.0** reads every earlier session as unbound (see
   *Migrating to 5.0.0*): one login, or one token request, per token destination.
3. **Changing a destination's URL, SAP client, client, grant, any server address or any trust
   value** costs one fresh login — **even a cosmetic change** (a trailing `/`, a case change, a
   port written out): addresses are compared exactly.
4. **A headless process whose strategy refuses logins** gets Oops ("login required") from
   `prepare()` / `rejected()` on a mismatch, instead of presenting a foreign secret; log in
   again with the CLI.

### Cancellation: `signal`

```typescript
const session = new AbortController(); // one per connector session
const provider = await broker.getProvider('TRIAL', { signal: session.signal });
const token = await broker.getToken('TRIAL', { signal: AbortSignal.timeout(60_000) });
const refresher = broker.createTokenRefresher('TRIAL', { signal: session.signal });
await broker.flush({ signal: AbortSignal.timeout(10_000) });
session.abort(); // the session closed: a login its provider started now is aborted
```

Every call takes `BrokerCallOptions`, `{ readonly signal?: AbortSignal | undefined }`. A signal says "this caller no longer needs the answer". Its abort releases **that caller alone**
from every wait it has — the store reads, the shared build, its write — with auth-errors'
`aborted` failure (`interactive-login`, `outcome: 'aborted'`, "the authorization was aborted"),
never with success; the work it waited on runs on for the others. The waiter rules are
auth-errors' `sharedAttempt`; the broker implements none of its own.

- **Concurrent callers of one destination share one resolution**, per path (below). One
  caller's abort rejects only its promise. When every caller has aborted, the attempt leaves the
  slot at once: a caller arriving meanwhile starts a fresh one, and a build that completes after
  its attempt was aborted is never cached, never handed out, and writes nothing.
- **`getProvider`'s signal is attached to the provider it answers** — built or from the cache —
  when that provider has parties: every token provider and the SNC provider. A login that
  provider starts later in a moment (`rejected()` above all) is aborted once every session
  holding it has aborted its signal. `getProvider` without a signal attaches nothing. Tie the
  signal to the connector's session: abort it when the session closes.
- **The token API never attaches.** `getToken` / `refreshToken` pass the call's signal to the
  provider's `getTokens({ signal })` / `refreshTokens({ signal })`; a token call can neither keep
  a later moment's login alive nor bound it. `createTokenRefresher(destination, { signal })`
  makes every call of the refresher a waiter with that signal.
- **A cached provider after every caller has gone** stays cached. Its parties were released by
  their aborts, so a moment's login it starts later runs unbounded — the next caller that gave
  no signal can log in on it; one that gives a signal is attached again.
- **The `clientAuthentication` strategy** gets the build's attempt as
  `ClientAuthenticationContext.signal`: it aborts when every caller waiting on the build has
  gone. Store reads take no signal (the store contract has none): the caller is released at
  once, the read completes on its own and its result is dropped.
- **No bound of the broker's own.** The broker sets no timeout, adds no signal of its own and
  has no timer; nothing bounds anybody's wait. A caller that wants a bound passes
  `AbortSignal.timeout(ms)`.

### How the Client Authenticates: `clientAuthentication`

Every grant whose client authenticates to the authorization server — the UAA grants, the OIDC
grants and `saml2_bearer` (`ClientAuthenticationGrant`) — sends the client's secret, unless you
tell the broker otherwise. An XSUAA service key created with `{"credential-type": "x509"}` holds
no secret: it holds a client certificate, its private key and the mTLS host the certificate is
presented to (`certurl`). How the client authenticates is your choice, stated as a strategy —
the broker never infers it from a key's shape and has no default:

```typescript
import { AuthBroker, fromServiceKeyCertificate } from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import { XsuaaServiceKeyStore, XsuaaSessionStore } from '@mcp-abap-adt/auth-stores';

const x509Broker = new AuthBroker({
  serviceKeyStore: new XsuaaServiceKeyStore('/path/to/keys', {
    grantType: 'client_credentials',
  }),
  sessionStore: new XsuaaSessionStore('/path/to/sessions'),
  renewal: () => refreshThenLogin(),
  onWriteFailure: 'fail',
  // The key's certificate, presented at <certurl>/oauth/token.
  clientAuthentication: fromServiceKeyCertificate(),
});

const certificateProvider = await x509Broker.getProvider('mcp');
```

**The strategy** is `(context) => Promise<IClientAuthentication>` (`ClientAuthenticationStrategy`).
The broker calls it once per build of a destination's provider, with a
`ClientAuthenticationContext`:

- `destination` and `grant` (a `ClientAuthenticationGrant`);
- `client` — the secret client the key store's `getAuthorizationConfig` answered, as `uaaUrl`,
  `uaaClientId` and `uaaClientSecret` only — never a refresh token — or `null` (an x509 key
  answers `null` there);
- `readCertificate()` — the key store's certificate client (`IClientCertificate`: `uaaUrl`,
  `clientId`, `certificate`, `key`, `certUrl`), read **only when called**, at most once per
  build; `null` when the store holds none or implements no `getClientCertificate`;
- `signal` — the build's attempt (see *Cancellation*).

Its answer goes to the provider as `clientAuthentication`, and **no client secret goes with it**
(auth-providers 6 refuses both). A given strategy always answers or throws: there is no
"nothing" answer, so an explicit choice never falls back to the secret. `saml2_pure`, the `none`
rows, `basic` and `snc` authenticate no client and never call it.

**The two shipped factories** each fail closed:

| Factory | Answers | Refuses |
|---|---|---|
| `fromServiceKeyCertificate()` | auth-providers' `tlsClientCertificate` with the certificate and key `readCertificate()` answers, against `<certUrl>/oauth/token` (a trailing `/` of `certUrl` dropped). The material is checked before the factory answers, so a malformed, incomplete or expired certificate is refused when the provider is built, not at its first token request | the store answers no certificate client: "the destination has no client certificate" |
| `fromServiceKeySecret({ encoding })` | auth-providers' `clientSecretBasic` with the secret client's `uaaClientSecret`, in an `Authorization: Basic` header. `encoding` is required: `'raw'` for XSUAA (measured — it does not form-decode), `'form'` for UAA and Keycloak (RFC 6749 §2.3.1); anything else is a `TypeError` when the factory is made | no secret client, or an empty secret: "the destination has no client secret" |

**Composing them is yours.** A fallback, and its order, is your statement, never the broker's.
Branch on what the key holds (`readCertificate()` is memoised, so the factory reads the same
answer); do not `catch` a factory's refusal and fall back — that would also swallow an expired,
incomplete or unreadable certificate and send the secret instead:

```typescript
import {
  type ClientAuthenticationStrategy,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '@mcp-abap-adt/auth-broker';

// The certificate when the key holds one, else the secret in a Basic header.
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
(`@mcp-abap-adt/interfaces-auth-broker`, optional), which auth-stores implements:

- **`XsuaaServiceKeyStore`** — a key (bare, or wrapped in `credentials`) carrying `url`,
  `clientid`, `certificate`, `key` and `certurl` and no `clientsecret` is an x509 key:
  `getAuthorizationConfig` answers `null`, `getClientCertificate` the certificate client. A key
  carrying both a secret and a complete certificate offers both, and your strategy picks.
  `AbapServiceKeyStore` holds no certificate client.
- **`EnvDestinationStore`** — three means variables, each a path or a URL, never PEM:
  `SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH`, `SAP_UAA_CERT_URL`
  (`XSUAA_UAA_CLIENT_CERT_PATH`, … with `XSUAA_DESTINATION_VARS`), beside `SAP_UAA_URL` /
  `SAP_UAA_CLIENT_ID` and **without** `SAP_UAA_CLIENT_SECRET`. See auth-stores' README.

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

**Without a strategy** the client secret goes to the provider and nothing certificate-related is
read. A client row whose key store answers no client, or one without a client id, is refused
naming the fields, and its message adds `a certificate client needs a clientAuthentication
strategy`.

**With a strategy, what the row requires** is its client's identity — `uaaUrl` and
`uaaClientId` (the OIDC rows: `uaaClientId`) — taken from the secret client when the key store
has one, else from the certificate client (`uaaUrl`, `clientId`); the secret is no longer
required. The record names that identity, and — when the build read the certificate client —
its `certUrl` and, in the trust digest, its certificate. On this path a resource neither the
means nor the stored session states matches (an XSUAA destination without a service URL reuses
its own session); a resource stated on one side only never matches.

**A strategy that fails carries nothing out but what auth-errors admits.** Whatever the
strategy, a store it reads or the certificate check throws — and an answer that is no
`IClientAuthentication` — becomes a `DestinationConfigError` with `missingFields:
['clientAuthentication']`, before any provider exists:

| Words (after `Destination "<name>": `) | When |
|---|---|
| `the clientAuthentication strategy refused: the destination has no client certificate` | `fromServiceKeyCertificate()`, no certificate client |
| `the clientAuthentication strategy refused: the destination has no client secret` | `fromServiceKeySecret()`, no secret client or an empty secret |
| `the clientAuthentication strategy failed: <reason>` | anything else; `error` carries what was thrown as auth-errors reads it — for an unusable certificate, auth-providers' `client-certificate` failure, whose reason is `the client certificate is incomplete`, `… could not be used` or `… has expired` (its `hint` in `error.hint`); for your own error, its classification only |
| `the clientAuthentication strategy answered no client authentication` | the answer has no `authenticate` function |
| `the client certificate could not be read` | the store failed reading the certificate client for the row's identity |
| `the client certificate the key store answered holds no certificate` | a certificate client whose `certificate` is not a string |

A certificate, a key or a file's content never reaches a log line, a refusal, a
`DestinationConfigError`, a thrown message or the session store.

**What is measured.** `client_credentials` with an x509 XSUAA service key, against XSUAA on a BTP
trial (2026-10-05, on 4.1.0: `fromServiceKeyCertificate()` + `XsuaaServiceKeyStore`, through
`getProvider` and the token API, and through the CLI) — see *Testing*. **Not measured:**
`authorization_code` and `passcode` over x509, the OIDC grants and `saml2_bearer` with a
strategy, and ABAP environment service keys with x509.

### Headless Processes (No Browser)

Whether a login may happen is the renewal strategy's and the interactive strategy's, not a
broker switch. A process nobody is watching (an MCP server on stdio, a CI job) gives the broker
`renewal: () => refreshOnly()` — never a login — or strategies that refuse:

```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';

class LoginRequiredError extends Error {}

const refuseLogin = {
  authorize: async (): Promise<never> => {
    throw new LoginRequiredError('Run mcp-auth to log in');
  },
};

const headless = new AuthBroker({
  serviceKeyStore: myKeyStore,
  sessionStore: mySessionStore,
  renewal: () => refreshThenLogin(),
  onWriteFailure: 'continue',
  authorization: () => refuseLogin,
  oidcAuthorization: () => refuseLogin,
  deviceCodePresenter: () => ({
    present: async () => {
      throw new LoginRequiredError('No one to show a device code to');
    },
  }),
});
```

The provider runs on its stored secret and refresh token; when a login is needed, `prepare()` /
`rejected()` answer Oops and `getToken()` rejects with the provider's `AuthProviderFailure` —
fixed wording, never the message of what your strategy threw — and nothing is written. A cached token that is still valid, or a refresh token the
server accepts, never reaches the strategy.

### Custom Callback Port

How a login is conducted — including which port the local OAuth2 callback listens on — is the
strategy you return from `authorization`, not a broker option. `browserCallbackStrategy` from
`@mcp-abap-adt/auth-providers` listens on `61001` by default, clear of the range application
servers and proxies typically use (`3001` / `3333`). Pass `port` to match a redirect URI
registered at the identity provider:

```typescript
import type { AuthBrokerConfig } from '@mcp-abap-adt/auth-broker';
import { browserCallbackStrategy, linuxDefaultBrowser } from '@mcp-abap-adt/auth-providers';

const onPort4001: AuthBrokerConfig['authorization'] = () =>
  browserCallbackStrategy({ browser: linuxDefaultBrowser(), port: 4001 });
```

Every listener is loopback-only; a user whose browser is on another machine tunnels the port
(`ssh -L`).

### Getting Tokens: the Token API

```typescript
// The provider's current token: cached while valid, else renewed as its strategy says.
const token = await broker.getToken('TRIAL');

// A new token, never the cached one — after the server refused the token (401).
const newToken = await broker.refreshToken('TRIAL', { signal });
```

**Two paths, two providers.** The token API answers from one of two paths, each resolved, cached
and bound on its own:

- **No `provider` option — the row path:** the destination's own provider, the very one
  `getProvider` hands out (the same cache; never through `getProvider` itself). A connector and
  the token API in one process share one token, one refresh token and one renewal; the token API
  writes nothing itself (the provider's persistence does, and a cache hit writes nothing). The
  destination must state a grant that obtains a token; a `none` destination is a
  `DestinationConfigError` naming `provider`.
- **A `provider` option — the consumer path:** yours. An instance is used as given, for every
  destination; a factory is called once per destination and again whenever what it was handed
  changes (its new provider starting with nothing). Every answer — cache hits included — is
  written through the same write queue, raced against the call's signal, with the binding fixed
  when the provider was taken into use (`issuedFor` the URL with the SAP client, `issuedBy` the
  `provider/…` record): the result is authoritative — a result without a refresh token writes
  `refreshToken: ''`.

```typescript
import { AuthBroker, type TokenProviderFactory } from '@mcp-abap-adt/auth-broker';
import { ClientCredentialsProvider, refreshThenLogin } from '@mcp-abap-adt/auth-providers';

const clientCredentials: TokenProviderFactory = (destination, authConfig) => {
  if (!authConfig) throw new Error(`No client for ${destination}`);
  return new ClientCredentialsProvider({
    uaaUrl: authConfig.uaaUrl,
    clientId: authConfig.uaaClientId,
    clientSecret: authConfig.uaaClientSecret,
    renewal: refreshThenLogin(), // yours: the broker gives a provider of yours none
    // No persistence: the token API writes every answer of this provider itself.
  });
};

const tokenBroker = new AuthBroker({
  serviceKeyStore: myKeyStore,
  sessionStore: mySessionStore,
  provider: clientCredentials,
  onWriteFailure: 'fail', // the token API writes every answer
});
```

**The factory is handed the means and the client, never a stored secret.** `authConfig` is the
client (`uaaUrl`, `uaaClientId`, `uaaClientSecret` — the session store's when it answers one,
else the key store's; `refreshToken` present as a key, never a value), or `null` when no store
has a client. `connConfig` is `serviceUrl` (the session's, else the key store's; neither is an
error before the factory is called), `sapClient`, `language`, `authType`, `grantType` — no
token, cookies, expiry, refresh token or binding. The broker cannot know what your factory
composes from what it is handed, so the consumer path is **never seeded from the store**: a
provider of yours that must resume after a restart composes that itself — its own seed and its
own persistence (`refreshStatePersistence` over a store of yours) — or use the row path, whose
providers the broker seeds from a matching record.

**An instance after the means changed** cannot be rebuilt, and the identity of the credential it
holds is unknown to the broker: once the identity the instance was first used for changes, the
token API refuses the destination — `DestinationConfigError(['provider'])`, "the destination's
means changed since the provider instance was first used for it" — until a new broker.

**A destination stated `basic` or `snc` has no token API**: the token API reads the
destination's `authType` first and throws `DestinationConfigError` naming `authType` before any
provider is asked. A key store that states no `authType`, or no key store, is served by a
`provider` of yours as before.

**Two token sources, with a `provider` option.** `getProvider` never uses the `provider` option.
A process that gives the broker a `provider` and also calls `getProvider` for the same
destination has two providers for it — each with its own token, renewal and binding record,
both writing the same session. Use one path per destination; or, to hand your own provider to a
connector, wrap the token API: `TokenAuthProvider.from(broker.createTokenRefresher('TRIAL'))`
(`@mcp-abap-adt/auth-providers`), whose every renewal the token API writes.

### Creating a Token Refresher for DI

`createTokenRefresher(destination, { signal? })` returns an `ITokenRefresher` (from
`@mcp-abap-adt/interfaces-auth`) bound to one destination — `getToken()` is
`broker.getToken(destination, { signal })`, `refreshToken()` is
`broker.refreshToken(destination, { signal })` — for a connection of your own that asks for a
token per request and for a new one after a 401.

```typescript
const tokenRefresher = broker.createTokenRefresher('TRIAL', { signal: session.signal });

const current = await tokenRefresher.getToken();
// …the server answered 401:
const renewed = await tokenRefresher.refreshToken();
```

A `@mcp-abap-adt/connection` 14 connector takes an `IAuthProvider` instead: give it `await
broker.getProvider('TRIAL', { signal })`.

## Errors

**A provider's failure passes as the same object.** Whatever a provider throws from
`getTokens()` / `refreshTokens()` — an `AuthProviderFailure` of `@mcp-abap-adt/auth-errors` —
`getToken()` / `refreshToken()` rethrow unchanged, so its kind, facts, words and diagnostics are
the provider's; the moments of a provider `getProvider` hands out are never wrapped. Read a
failure with auth-errors, never by class or message:

```typescript
import { isDestinationConfigError } from '@mcp-abap-adt/auth-broker';
import { isAuthProviderFailure, readFailure } from '@mcp-abap-adt/auth-errors';

try {
  await broker.getToken('TRIAL', { signal });
} catch (error) {
  if (isDestinationConfigError(error)) {
    // Names only: error.missingFields, e.g. ['renewal'] or ['uaaClientSecret'].
    logger.error(`${error.destination} lacks: ${error.missingFields.join(', ')}`);
  } else if (isAuthProviderFailure(error)) {
    const failure = readFailure(error, 'token-source');
    // failure.kind: 'interactive-login', 'credential-refused', 'request-failed', …
    logger.error(failure.hint ? `${failure.reason} — ${failure.hint}` : failure.reason);
  }
  throw error;
}
```

`readFailure(thrown, operation)` gives the same kind and facts for a failure of another
installed copy of auth-errors (its diagnostics dropped); `matchKind(failure, handlers)` switches
over every kind. auth-providers' *Migrating to 6.0.0* maps each 5.x error class to its kind.

**The failures the broker makes itself** are `AuthProviderFailure`s minted by auth-errors, no
free words of its own:

| When | Kind and facts | Words |
|---|---|---|
| a caller's signal aborted | `interactive-login`, `outcome: 'aborted'` | the authorization was aborted |
| a session write did not land, under `'fail'` (the consumer path; the row path's provider answers the same) | `unknown`, `operation: 'persisting-tokens'`, an allowlisted `code` | persisting the tokens failed (unknown error[, CODE]) |
| a provider answered no token | `request-failed`, `operation: 'token-source'`, `problem: 'no-access-token'` | the token source returned no access_token |

**`DestinationConfigError`** — a destination that lacks what its type needs, thrown by
`getProvider` (and the token API) before any provider is asked. It carries `name:
'DestinationConfigError'`, `code: 'DESTINATION_CONFIG'`, `destination` and `missingFields` —
store field or broker option names only, never a value — and, when a provider's or a strategy's
failure caused the refusal, `error`: that failure as auth-errors read it (`IAuthProviderError`:
kind, facts, rendered `reason` and `hint`, admitted diagnostics — no `cause`, no message of any
thrown value). Its message is `Destination "<destination>": <reason> (<fields>)`, the reason
followed by `: <error.reason>` when `error` is present; `error.hint` is not in the message.
Recognise it with `isDestinationConfigError(value)` — structural, so a JSON copy and one of
another installed copy of this package answer true — rather than `instanceof`.

| Case | `missingFields` |
|---|---|
| no `serviceKeyStore` option (`getProvider`) | `serviceKeyStore` |
| the token API with neither a `provider` nor a `serviceKeyStore` option | `provider`, `serviceKeyStore` |
| the token API on a destination stated `basic` or `snc` | `authType` |
| the token API without a `provider` option, on a `jwt` / `none` or `saml` / `none` destination | `provider` |
| a token row built with no `renewal` option | `renewal` (beside every other missing field) |
| a destination that writes a secret (a token row, or the token API with a `provider`) and no `onWriteFailure` option (`'fail'` / `'continue'`) | `onWriteFailure` |
| the `renewal` option threw (`error` carried) | `renewal` |
| a provider's constructor refused the configuration the row gave it (`error` carried) | the store fields its configuration facts name, or none |
| the token API with an instance `provider` after the destination's identity changed | `provider` |
| the key store has no means for the destination — whatever the session holds | `authType` |
| no `authType`, `''`, or one that is not `basic`, `jwt`, `saml`, `snc` | `authType` |
| `jwt` / `saml` without `grantType`, `''`, or a pair outside the table | `grantType` |
| `basic` without user or password (`''` counts as missing) | `username`, `password` — each that is missing |
| `snc` without `sncPartnerName` | `sncPartnerName` |
| `snc` whose settings the provider refuses (`error` carried) | the store field its facts name, e.g. `sncQop`; for another kind, the SNC fields the means state |
| `jwt` / `none` without a token in the session | `authorizationToken` |
| `saml` / `none` without cookies in the session | `sessionCookies` |
| `jwt` / `none`, `saml` / `none` whose stored `issuedFor` is not the destination's resource, or is absent, or the means state no `serviceUrl` | `issuedFor` |
| `jwt` / `none`, `saml` / `none` whose stored `issuedBy` is not exactly the row's record (a 4.x binding included) | `issuedBy` |
| a UAA grant without its client in the key store (`''` counts as missing) | `uaaUrl`, `uaaClientId`, and `uaaClientSecret` for `authorization_code` / `client_credentials` — each that is missing |
| `authorization_code` / `passcode` without the `authorization` option | `authorization` |
| an OIDC grant without its client's id in the key store | `uaaClientId` |
| an OIDC grant with neither `oidcIssuerUrl` nor every endpoint its row reads | `oidcIssuerUrl`, and each endpoint missing |
| `oidcScopes` that is not a list of strings; `oidcActorTokenType` that is not a string | `oidcScopes`, `oidcActorTokenType` |
| `password` without user or password | `username`, `password` — each that is missing |
| `token_exchange` without its subject | `oidcSubjectToken`, `oidcSubjectTokenType` — each that is missing |
| `oidc_authorization_code` without the `oidcAuthorization` option | `oidcAuthorization` |
| `device_code` without the `deviceCodePresenter` option | `deviceCodePresenter` |
| a SAML grant without its trust (`''` and an empty certificate list count as missing) | `samlIdpSsoUrl`, `samlSpEntityId`, `samlIdpEntityId`, `samlIdpCertificates` — each that is missing |
| `samlIdpInitiated` that is not a boolean | `samlIdpInitiated` |
| `saml2_bearer` without its client | `uaaUrl`, `uaaClientId` — each that is missing |
| a client row (UAA, OIDC, `saml2_bearer`) with no client id and no `clientAuthentication` strategy | as above; the message adds `a certificate client needs a clientAuthentication strategy` |
| the `clientAuthentication` strategy threw, refused, or answered no client authentication; the certificate client could not be read | `clientAuthentication` (see *How the Client Authenticates*) |
| the token API with a `clientAuthentication` strategy and a factory, on a destination that states no `jwt` / `saml` type | `authType`, `grantType` |
| the token API's factory threw beside a `clientAuthentication` strategy | `provider`, `clientAuthentication` |
| a SAML grant without its collaborators | `authorization`, `samlCookies` (`saml2_pure`), `assertionReplayStore` — each that is missing |
| a certificate the validator cannot read (`error` carried) | `samlIdpCertificates` |
| a `samlClockSkewMs` that is not a whole, non-negative number | `samlClockSkewMs` |
| a store answered a field in a shape the broker cannot take (a function, a getter that throws) | that field |

Kept as the broker's own configuration words, none copying a provider's: the reason of every row
above, "the destination has no client certificate / secret", and the hint `a certificate client
needs a clientAuthentication strategy`.

**What is not an auth failure:**

- **A store's read failure** (anything but `FILE_NOT_FOUND`, which is absence) reaches the
  caller as the store raised it — your collaborator's error, returned to you, also through the
  shared resolution. A store that answers `null`, or fails with `FILE_NOT_FOUND` (logged at
  debug), means "nothing here".
- **The constructor's argument checks** (`AuthBroker: sessionStore is required`, …) are plain
  `Error`s naming option names: a programming error.
- **The token API with a factory and no `serviceUrl`** in either store: `Session for destination
  "<name>" is missing required field 'serviceUrl'`, a plain `Error`, before the factory is
  called.
- **`flush()`** rejects with the `AggregateError` of `SessionWriteFailure`s above.

## Logging and `authDebug`

Pass an `ILogger` (`@mcp-abap-adt/interfaces-utils`) as the constructor's second argument;
without one nothing is logged. Every line goes through a guard: a logger that throws or rejects
changes no outcome. The broker never writes to stdout.

**What is logged:** `debug` — the broker's initialization (whether a key store is given; the
`provider` option: `none`, `factory` or `instance`), each provider build (`{ authType, grant,
seeded }`), the token API's method, a replaced provider's write dropped, a destination whose
means never let a stored secret be used; `info` — each session secret saved (`{ credential:
'token' | 'cookies', hasRefreshToken, expiresAt }`), a refresh token cleared; `warn` — a stored
secret not recorded under the current means and not used, a session write that failed (`Session
write for <destination> failed; it stays pending until the destination's next write or
flush()`, with the failure's `logFields`), a write not made because the destination is now
`basic` / `snc`. The destination name is the only free value.

**What is never logged:** any part of a token, refresh token, password or secret, a store's or a
provider's message, a URL, a client id, `state`.

After a login, at `info`, your logger is called with the message `[AuthBroker] Session secret
saved for TRIAL` and the meta `{ credential: 'token', hasRefreshToken: true, expiresAt:
1790000000000 }`.

**`authDebug`.** `authDebug: true` is passed to every token provider the broker builds; on only
for `true` itself — absent, `false`, `'true'` or `1` is off — and **never read from the
environment** (no `DEBUG_*` variable changes anything). The broker's logger is the providers'
logger, so the provider's one debug line for a refused token request lands in yours. With
`authDebug` that line names the request's secrets in the provider's prepared form (the first and
last four characters around a length marker) and never the server's text; without it no line
carries a secret or server text. A `provider` of yours — an instance or what a factory builds —
keeps its own setting.

## Configuration

### Environment Variables

The library reads no environment variable: the stores take their directories from their
constructors, the providers their settings from the destination's means and the collaborators
you give the broker, and `authDebug` is an option. (In the repository's test suites,
`DEBUG_BROKER=true` — or `DEBUG_AUTH_BROKER=true`, `DEBUG=broker` — turns on the test logger,
its level from `AUTH_LOG_LEVEL`.)

### File Structure

With `@mcp-abap-adt/auth-stores` 4 one `<destination>.env` file can hold a destination whole,
each store reading and writing only its own keys — the means through `EnvDestinationStore`, the
secret through `AbapSessionStore` (or both in separate directories, as you compose them):

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
SAP_ISSUED_BY=mcp-abap-adt-binding/2;jwt/authorization_code;client_id;https%3A%2F%2Fyour-account.authentication.us10.hana.ondemand.com;;;;;;;;;;8be36724f0e889f23f88526620417e7545eed1115742c715e2bc8da01678d785
```

A client that authenticates with a certificate states `SAP_UAA_CLIENT_CERT_PATH`,
`SAP_UAA_CLIENT_KEY_PATH` and `SAP_UAA_CERT_URL` — paths and a URL, never PEM — in place of
`SAP_UAA_CLIENT_SECRET`. SAML cookies are `SAP_SESSION_COOKIES_B64` in place of
`SAP_JWT_TOKEN`. The XSUAA stores use the same names with `XSUAA_` (`XSUAA_DESTINATION_VARS`,
`XSUAA_SESSION_VARS`; the URL is `XSUAA_MCP_URL`). Every means key (`SAP_USERNAME`,
`SAP_SNC_*`, `SAP_OIDC_*`, `SAP_SAML_*`, …) is listed in
[USAGE.md](../../docs/using/USAGE.md#environment-variables).

#### Service Key File (`{destination}.json`)

A SAP service key, read by `AbapServiceKeyStore` (an ABAP environment key: the client and the
ABAP URL) or `XsuaaServiceKeyStore` (an XSUAA key: the client). A key cannot state which grant
the destination uses, so the store is told: `new AbapServiceKeyStore(dir, { grantType:
'authorization_code' })`.

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

An XSUAA key carries no URL of the resource it authorizes for: state it as means in an
`EnvDestinationStore` (`XSUAA_MCP_URL`, with `XSUAA_DESTINATION_VARS`) whose `fallback` is the
`XsuaaServiceKeyStore`. An x509 XSUAA key (created with `{"credential-type": "x509"}`) holds a
certificate client instead of a secret — the broker uses it only beside a
`clientAuthentication` strategy:

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

## Responsibilities

**The broker** reads each store for its role; builds one provider per destination and path — the
one the destination states, or yours — and rebuilds it when what it was built from changes; asks
it once (`getTokens()` for `getToken()`, `refreshTokens()` for `refreshToken()`) with no retry of
its own; writes what it obtains, the secret alone with its binding, one write at a time per
destination. It works through the contracts only — `IServiceKeyStore`, `ISessionStore`,
`IAuthProvider`, `IRefreshableTokenProvider` — and constructs auth-providers' classes by name
only to build the one a destination states. It never imports `@mcp-abap-adt/auth-stores`.

**It does not** implement storage (the stores do), token acquisition, refresh or the token's
validity (the providers do), how a login is conducted (the strategies you give), when to renew
(the renewal strategy you give), or what a failed write means (your `onWriteFailure`). It copies
no secret: the client secret stays in the key store, and the broker never writes the key store
(its contract has no write method).

**You** compose the stores, the collaborators, `renewal` and `onWriteFailure`; state the means in
the key store; and give a session store that keeps `issuedFor` / `issuedBy` exactly, takes
`refreshToken: ''` as clearing, and settles every `saveSession`.

## API

```typescript
import type {
  BrokerCallOptions,
  ClientAuthenticationStrategy,
  IAuthorizationConfig,
  IConnectionConfig,
  ILogger,
  IRefreshableTokenProvider,
  IRenewalStrategy,
  IServiceKeyStore,
  ISessionStore,
  ITokenRefresher,
  StrategyGrant,
  TokenGrant,
  TokenProviderClient,
} from '@mcp-abap-adt/auth-broker';
import type { IDeviceCodePresenter, OidcCallbackResult } from '@mcp-abap-adt/auth-providers';
import type {
  IAssertionReplayStore,
  IAuthorizationStrategy,
  IAuthProvider,
} from '@mcp-abap-adt/interfaces-auth';

export interface AuthBrokerConfig {
  sessionStore: ISessionStore;                                   // required
  serviceKeyStore?: IServiceKeyStore | undefined;                // getProvider needs it
  provider?: IRefreshableTokenProvider | TokenProviderFactory | undefined; // the token API's own
  authorization?: ((destination: string, grant: StrategyGrant) => IAuthorizationStrategy<string>) | undefined;
  oidcAuthorization?: ((destination: string) => IAuthorizationStrategy<OidcCallbackResult>) | undefined;
  deviceCodePresenter?: ((destination: string) => IDeviceCodePresenter) | undefined;
  samlCookies?: ((destination: string) => (samlResponse: string) => Promise<string>) | undefined;
  assertionReplayStore?: ((destination: string) => IAssertionReplayStore) | undefined;
  clientAuthentication?: ClientAuthenticationStrategy | undefined;
  renewal?: ((destination: string, grant: TokenGrant) => IRenewalStrategy) | undefined; // required by token rows
  onWriteFailure?: 'fail' | 'continue' | undefined;              // required where a secret is written
  authDebug?: boolean | undefined;                               // on only for true
}

export declare class AuthBroker {
  constructor(config: AuthBrokerConfig, logger?: ILogger);
  getProvider(destination: string, options?: BrokerCallOptions): Promise<IAuthProvider>;
  getToken(destination: string, options?: BrokerCallOptions): Promise<string>;
  refreshToken(destination: string, options?: BrokerCallOptions): Promise<string>;
  flush(options?: BrokerCallOptions): Promise<void>;
  createTokenRefresher(destination: string, options?: BrokerCallOptions): ITokenRefresher;
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>;
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;
}

export type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
  client?: TokenProviderClient, // only beside clientAuthentication, for a grant that authenticates a client
) => IRefreshableTokenProvider;
```

- **`getProvider(destination, { signal? })`** — the `IAuthProvider` the destination states (see
  *A Provider for a Connector*): the cached one while what its build read is unchanged, else a
  new build. A token or SNC provider gets the signal attached. Throws `DestinationConfigError`
  for a destination that lacks what its type needs; under `'fail'`, the `persisting-tokens`
  failure while the destination's last write is pending; a store's read failure as the store
  raised it.
- **`getToken(destination, { signal? })`** / **`refreshToken(destination, { signal? })`** —
  `getTokens()` / `refreshTokens()` of the destination's provider (row path) or of yours
  (consumer path), the signal passed to it; a renewal already in flight is joined. See *Getting
  Tokens*.
- **`flush({ signal? })`** — one more attempt for every pending write; see *Session Writes*.
- **`createTokenRefresher(destination, { signal? })`** — `getToken` / `refreshToken` bound to
  one destination and signal.
- **`getConnectionConfig(destination)`** — the key store's means with the session's
  `authorizationToken`, `sessionCookies`, `expiresAt`, `issuedFor` and `issuedBy` laid over
  them; `null` when neither store holds anything. **`getAuthorizationConfig(destination)`** —
  the key store's client (`uaaUrl`, `uaaClientId`, `uaaClientSecret`) with the session's refresh
  token; `null` when the key store has no client (an x509 key's included). Store reads with no
  signal.
- **`TokenProviderClient`** — the factory's fourth argument: `clientAuthentication` (the
  strategy's answer), `uaaUrl` and `clientId` (the client identity); never a certificate, a key,
  a secret or a refresh token (`refreshToken` stays in the type and is never set).
- **`StrategyGrant`** — `'authorization_code' | 'passcode' | 'saml2_pure' | 'saml2_bearer'`;
  **`TokenGrant`** — every `DestinationGrant` but `'none'`; **`BrokerCallOptions`** —
  `{ signal? }`.
- **`bindingOf(means, client?)`**, **`fromServiceKeyCertificate()`**,
  **`fromServiceKeySecret({ encoding })`**, **`DestinationConfigError`**,
  **`isDestinationConfigError`**, **`SessionWriteFailure`** — above.
- Re-exported types: `IClientAuthentication`, `IRenewalStrategy`, `ITokenRefresher` (from
  `interfaces-auth`), `IClientCertificate` (`interfaces-auth-broker`), `AuthType`
  (`interfaces-auth-sap`), `ILogger` (`interfaces-utils`), the store contracts
  (`IAuthorizationConfig`, `IConnectionConfig`, `IServiceKeyStore`, `ISessionStore`, `IConfig`)
  and the token provider contracts (`IRefreshableTokenProvider`, `ITokenProvider`,
  `ITokenResult`, `TokenProviderOptions`). `IAuthProvider` is not re-exported: take it from
  `@mcp-abap-adt/interfaces-auth`.

## Migrating to 5.0.0

What a 4.x consumer must now do, row by row. The full list of changes is the
[CHANGELOG](CHANGELOG.md)'s 5.0.0 entry.

| 4.x | 5.0.0 — what to do |
|---|---|
| `@mcp-abap-adt/auth-providers` 5, `interfaces-auth` 3, `auth-stores` 3 | auth-providers `^6.0.0`, interfaces-auth `^7.5.0`, auth-errors `^2.1.1`, auth-stores `^4.0.0`; one installed copy of each contract (`npm ls`) |
| token rows renewed by the provider's built-in rule | pass `renewal: () => refreshThenLogin()` — 4.x's steps; without `renewal` a token row is refused (`missingFields: ['renewal']`) |
| a `getProvider` provider's failed write never failed the authentication; the token API threw the store's error | pass `onWriteFailure`: `'continue'` keeps 4.x's connector behaviour (best effort); `'fail'` keeps 4.x's token-API behaviour and extends it to the connector and to every later call of the destination while the write is pending. Without it a destination that writes a secret is refused |
| errors of the token API: auth-providers 5.x classes (`ValidationError`, `BrowserAuthError`, `RefreshError`, …) | `AuthProviderFailure`: read it with `readFailure(error, operation)` and `matchKind` (auth-errors); auth-providers' *Migrating to 6.0.0* maps each class to its kind |
| the token API's failed write: the store's own error | `AuthProviderFailure`, `unknown`, `persisting-tokens` (with an allowlisted `code`), only with `'fail'` |
| "Token provider did not return authorization token …" (`Error`) | `request-failed`, `no-access-token`, operation `token-source` |
| `error instanceof DestinationConfigError` | `isDestinationConfigError(error)`; `error.error` is the provider's error when one caused the refusal, and the message adds `: <its reason>` |
| a provider's `ValidationError` thrown raw by `getProvider` (rows other than SNC) | a `DestinationConfigError` naming the store fields, the provider's error in `error` |
| the certificate words of `clientAuthentication` (`incomplete` / `expired` / `could not be used`) | `error.reason` of the carried `client-certificate` failure; the message reads `the clientAuthentication strategy failed: <reason>` |
| the token API with a consumer `provider`: a call waited for its session write however long the store took | the wait races the call's `signal`: an abort releases the caller (`aborted`) while the write runs on |
| a failed session write was retried on a timer (1 s, doubling to 60 s) | no timer: it stays pending and is retried by the destination's next write or `flush()` — **call `flush()` on shutdown**. Under `'fail'` the destination's calls are refused while it is pending |
| a store whose `saveSession` never settled kept being retried | **the store's contract:** `saveSession` must settle (resolve or reject). One that never settles holds that destination's write queue; each waiting caller is released by its own signal |
| `flush()`'s `AggregateError.errors`: `Error("<dest>": <class>)` | `SessionWriteFailure` (`destination`, `error`) |
| `getProvider(d)`, `getToken(d)`, `refreshToken(d)` | unchanged calls; each also takes `{ signal }` — tie a session's close to `getProvider`'s signal and each request's cancellation to the token API's |
| providers' 30 s / 300 s login timeouts | none: a login waits until it ends or a signal aborts it; bound it with your own signal or the strategy's `signal` option |
| collaborator strategies of auth-providers 5 (`browserCallbackStrategy({ browser: 'system', timeoutMs })`, `openUrl`) | auth-providers 6's: `browser` an `IBrowser` (`linuxDefaultBrowser()`, `macDefaultBrowser()`, `windowsDefaultBrowser()`, …), `signal` instead of `timeoutMs`, `redirectUri` required for the manual ones; a strategy of yours must honour `AuthorizationRequest.signal` |
| a stored session bound by `issuedFor` / `issuedBy` (issuer and client) | the binding also names the row: `issuedBy` is a versioned record. **Every session written before 5.0.0 reads as unbound once**: for each token destination the stored token and refresh token are not used (one `warn` line) and the provider's first renewal is a **login, not a refresh** — interactive for `authorization_code`, `passcode`, `oidc_authorization_code`, `device_code` and the SAML grants; a token request for `client_credentials`, `password`, `token_exchange`. **A headless consumer must run that login once per destination after upgrading** (e.g. `mcp-auth --env <file>` or `--service-key` with CLI 3.0.0). A handed-over credential (`none`) is refused naming `issuedBy` until written again with 5.0.0's `bindingOf`. A switch of grant with unchanged resource and client no longer reuses the other grant's credential |
| SAML trust (`samlIdpCertificates`, `samlIdpEntityId`, `samlSpEntityId`, `samlClockSkewMs`, `samlIdpInitiated`), OIDC scopes, the `password` grant's user, the certificate client's certificate, changed | the destination **logs in once** — within a running broker and after a restart; 4.x kept the cached provider and its session, accepting assertions under the trust it was built with |
| any other value a build reads changed (a password, a client secret, a subject token, an option of the means) | within a running broker: a new provider, **one login**; after a restart, only a change the record holds (above) forces a login — a secret is not persisted in any form |
| a `token_exchange` destination | obtains a fresh token after every restart (one token request, no interaction): its subject is a secret and cannot bind a stored session |
| a server address the destination states changed (`uaaUrl`, `oidcIssuerUrl`, the three OIDC endpoints, `oidcAudience`, `samlIdpSsoUrl`, `samlAcsUrl`, `samlTokenUrl`, a certificate client's `certUrl`) or its client id | the stored token and refresh token are not reused: the destination **logs in once** after the change (4.x refreshed with the old refresh token at the new address, or kept its token). **Even a cosmetic change counts** — a trailing `/`, a case change, a port written out: the strings are compared exactly |
| an OIDC destination with explicit endpoints only (no `oidcIssuerUrl`, no `uaaUrl`) — 4.x never seeded its session | **now reused after a restart** when its means are unchanged, byte for byte. Only a destination whose means lack the client the row authenticates, or an address its credential goes to, is never seeded and logs in after every restart |
| means changed under a running broker were picked up by a new broker | picked up at the next call: a changed identity rebuilds the destination's provider, unseeded; an instance `provider` is refused for that destination until a new broker |
| the token API's factory seeded with whatever the session held (`authConfig.refreshToken`, `connConfig`'s token and expiry, the fourth argument's `refreshToken`) | **handed no stored secret at all**: the means and the client only. A factory that relied on the stored session to resume after a restart must compose that itself — give its provider its own persistence (e.g. `refreshStatePersistence` over a store of yours) and its own seed — or use `getProvider`'s path, whose providers the broker seeds from a matching record. The broker still writes what the provider returns, with the `provider/…` record |
| a consumer provider's result without a refresh token kept the stored one | it clears it (`refreshToken: ''`): auth-providers 6 providers return the refresh token they hold |
| `onTokens` of the built providers | `persistence` (internal: nothing to do) |
| `DEBUG_*` environment variables | the broker reads none; `authDebug: true` for the providers' debug line |

**The first run after upgrading costs one login (or one token request) per token destination**:
plan it for headless consumers before switching them over. Migrations from earlier majors are in
the [CHANGELOG](CHANGELOG.md) (*Migrating from 3.x* under 4.0.0; 4.1.0's additions under 4.1.0).

## Testing

The library's tests are in `packages/auth-broker/src/__tests__/` and use Jest. Run them from the
repository root, where the dev dependencies are installed — never `npx jest` directly (the npm
script sets `--experimental-vm-modules`):

```bash
npm test -w @mcp-abap-adt/auth-broker
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts -t "name of the case"
```

Tests run sequentially (`maxWorkers: 1`, `maxConcurrency: 1`). The broker suites need nothing:
fake stores of the contract or auth-stores 4 in temporary directories, real providers, a token
endpoint the test starts on `127.0.0.1`. `AuthBroker.integration.test.ts` reads real service
keys and sessions only when `packages/auth-broker/tests/test-config.yaml` exists (from the
template beside it); without it every case returns at once. The stand (`npm run test:stand`,
UAA and Keycloak in Docker), the live checks (`npm run test:live`, `npm run test:live:x509`) and
what each needs: [`docs/development/TESTING.md`](../../docs/development/TESTING.md).

### The x509 Live Check

`npm run test:live:x509` (from the repository root or this package) runs `client_credentials`
with an x509 XSUAA service key against a real BTP subaccount: it builds, creates an `xsuaa` /
`application` instance (`credential-types: ["binding-secret", "x509"]`) and a key made with
`{"credential-type": "x509"}`, runs `src/__tests__/live/x509.live.test.ts` — the broker with
`fromServiceKeyCertificate()`, `mcp-auth --client-auth certificate`, `generate-env
--client-auth certificate`, a fresh broker over each written destination, and a failing run that
leaves the previous destination untouched and prints no PEM — and removes everything, also when
a test fails. Not in `npm test`, not in CI. It refuses to run unless `XSUAA_CF_API`,
`XSUAA_CF_ORG` and `XSUAA_CF_SPACE` equal exactly what `cf target` shows, and touches only what
it recorded in its ledger (`tests/live/x509/.local/owned`). Last run: BTP trial, 2026-10-05, on
4.1.0, all five cases passed.

## Documentation

The repository's [`docs/`](../../docs/): [Architecture](../../docs/architecture/ARCHITECTURE.md),
[Exports](../../docs/architecture/EXPORTS.md), [Testing](../../docs/development/TESTING.md),
[Installation](../../docs/installing/INSTALLATION.md), [Usage](../../docs/using/USAGE.md); the
index is [docs/README.md](../../docs/README.md).

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
