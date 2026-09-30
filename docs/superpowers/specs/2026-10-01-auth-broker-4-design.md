# auth-broker 4.0.0 and auth-broker-cli 1.0.0 — design

**Answers to:** `docs/superpowers/2026-09-30-auth-broker-4-goal.md`. The goal is
fixed; this spec designs what delivering it takes — including the contract
fields, store changes and consumer-supplied collaborators the code lacks today
(§1). Every section names the *Holds throughout* rules it serves (H0–H6); §16
maps every *What changes* bullet and every hold to where it is met.

**Status:** draft for review in #33.

**Evidence.** A claim tagged `file:line` was read in the code named. Paths
without a repository prefix are this repository at `e88c652`; others are
`auth-providers` (5.0.1, `1cf6767`), `connection` (10.0.2, `b859607`),
`auth-stores` (2.0.0, `2a7fc4b`), `interfaces` (`interfaces-auth` 3.0.0 /
`interfaces-auth-sap` 1.1.0, `160a0e6`), `server` (`mcp-abap-adt`, `ec208a87`)
and `calm` (`mcp-calm-server`). *(inference)* marks what was not verified;
*measured* marks what was run.

## 0. What shaped this design

1. **The library has no provider factory of its own.** 3.x takes a provider
   instance or a `TokenProviderFactory` from the consumer and builds nothing
   (`src/AuthBroker.ts:45-66`, `:196-222`). "Today's factories" are the
   consumers': the server always builds `AuthorizationCodeProvider`
   (`server src/lib/auth/brokerFactory.ts:884-891`); calm-server chooses by its
   own config field `authFlow` (`calm src/server/auth/buildBroker.ts:112-125`);
   `mcp-auth` by `--credential` (`bin/mcp-auth.ts:862-881`);
   `generate-env-from-service-key` by whether the key's URL contains
   `authentication` (`bin/generate-env-from-service-key.ts:80-83`, `:134-145`) —
   the inference H1 forbids; `mcp-sso` by `--protocol`/`--flow` into
   `SsoProviderFactory` (`bin/mcp-sso.ts:864-866`, `bin/mcpSsoConfig.ts:644-730`).
2. **Everything `mcp-sso` configures is either data or a function.** Data: the
   OIDC issuer and endpoints, client, scopes, username/password, subject and
   actor tokens (`bin/mcpSsoConfig.ts:38-100`); the SAML IdP SSO URL, entity
   IDs, certificates, ACS, relay state, `idpInitiated`, token URL — the CLI
   resolves metadata into these once, at write time (`bin/samlMetadata.ts:228-270`).
   Functions and live objects: the interactive strategies (browser, manual
   paste, static value, IdP-initiated paste, `bin/mcpSsoConfig.ts:414-573`),
   the SAML `cookieProvider` (`:575-590`), and — under auth-providers 5 — the
   device-code presenter, the assertion validator and its replay store
   (`auth-providers src/providers/OidcDeviceFlowProvider.ts:42`,
   `src/providers/saml2Utils.ts:55`, `src/validation/assertionValidator.ts:53-68`).
   That split decides §1 (data → contract and stores, H0) and §5 (functions →
   consumer, H2).
3. **The store contract carries none of that data and no grant**
   (`interfaces-auth-sap src/auth/IConnectionConfig.ts:5-33`,
   `src/auth/IAuthorizationConfig.ts:5-14`). `IAuthorizationConfig` requires
   `uaaClientSecret`, so nothing that must exist without a secret can live there.
4. **Only the ABAP session stores state `authType`** (`auth-stores src/stores/**`:
   `grep authType` hits only `abap/*SessionStore.ts` and `env/EnvFileSessionStore.ts`).
5. **`onTokens` is best effort.** `BaseTokenProvider` awaits it after every new
   token and swallows its failure (`auth-providers src/providers/BaseTokenProvider.ts:362-375`);
   3.x `getToken` lets a store failure reach its caller (`src/AuthBroker.ts:186-193`).
   A store does not judge a token: it checks the form of what it is given
   (which fields), never the content. So a write fails for two reasons only —
   a form the caller got wrong (a broker bug, the same on every call, caught by
   the broker's tests) or the storage itself (disk, permissions, a locked file,
   an unreachable database) — and neither says the token is bad. The broker,
   which owns every store call, retries a failed write itself (§6).

## 1. Prerequisites

Three releases precede 4.0.0. None changes a contract in a breaking way.

### 1.1 `@mcp-abap-adt/interfaces-auth-sap` 1.2.0 (minor, additive)

A new type and optional fields on `IConnectionConfig` — flat, as the SNC fields
of 1.1.0 are, so a store updates them field by field under its existing rules.
All are destination data; none is a function.

```ts
/** How a destination obtains a new credential. Stated by the destination (H1). */
type DestinationGrant =
  // authType 'jwt'
  | 'authorization_code'      // UAA authorization code        → AuthorizationCodeProvider
  | 'client_credentials'      // UAA client credentials        → ClientCredentialsProvider
  | 'passcode'                // UAA one-time passcode          → UaaPasscodeProvider
  | 'oidc_authorization_code' // OIDC code + PKCE               → OidcBrowserProvider
  | 'device_code'             // OIDC device authorization      → OidcDeviceFlowProvider
  | 'password'                // OIDC resource owner password   → OidcPasswordProvider
  | 'token_exchange'          // RFC 8693                       → OidcTokenExchangeProvider
  // authType 'saml'
  | 'saml2_pure'              // SAML → session cookies         → Saml2PureProvider
  | 'saml2_bearer'            // SAML → OAuth token (RFC 7522)  → Saml2BearerProvider
  // either
  | 'none';                   // handed over, not renewed       → TokenAuthProvider.fixed / SamlAuthProvider

interface IConnectionConfig {
  // … every 1.1.0 field unchanged …
  grantType?: DestinationGrant;

  // OIDC grants (oidc_authorization_code, device_code, password, token_exchange)
  oidcIssuerUrl?: string;
  oidcAuthorizationEndpoint?: string;
  oidcTokenEndpoint?: string;
  oidcDeviceAuthorizationEndpoint?: string;
  oidcScopes?: string[];
  oidcSubjectToken?: string;        // token_exchange
  oidcSubjectTokenType?: string;    // token_exchange
  oidcAudience?: string;            // token_exchange
  oidcActorToken?: string;          // token_exchange
  oidcActorTokenType?: string;      // token_exchange
  // password grant: the existing username / password fields

  // SAML grants (saml2_pure, saml2_bearer)
  samlIdpSsoUrl?: string;
  samlIdpEntityId?: string;         // the Issuer every assertion must name
  samlIdpCertificates?: string[];   // signing certificates, PEM or base64 DER; several during a rotation
  samlSpEntityId?: string;          // the Audience
  samlAcsUrl?: string;              // the Recipient
  samlRelayState?: string;
  samlIdpInitiated?: boolean;       // no AuthnRequest; the assertion carries no InResponseTo
  samlClockSkewMs?: number;
  samlTokenUrl?: string;            // saml2_bearer: the bearer endpoint (/oauth/token/alias/…)
}
```

- **Why on `IConnectionConfig`:** fact 3. A public OIDC client, a SAML IdP's
  trust and a grant all exist without a client secret; on
  `IAuthorizationConfig` each would drag `uaaClientSecret` into the session
  (H4). The client itself stays where it is (§3.3).
- **Certificates, not a metadata reference.** The destination stores the
  signing certificates `mcp-sso` resolved from `--idp-metadata` / `--idp-cert`
  when it wrote the destination. A metadata URL would make every broker start
  fetch trust over the network, and auth-providers does not fetch IdP metadata
  by design (its CLAUDE.md, *Package responsibilities*). Rotating a key is
  writing the destination again, as it is today.
- **No per-login values.** `authnRequestId` is minted per login by the provider
  or declared by a strategy; it is not destination data and is not added.
- **Scopes:** one field. `token_exchange` takes a single `scope` string
  (`auth-providers OidcTokenExchangeProvider.ts` config); the broker passes
  `oidcScopes.join(' ')`.
- **`expiresAt?: number`** (epoch ms) — when the stored credential stops
  being valid, as the provider reported it (`ITokenResult.expiresAt`). A JWT
  carries its own `exp`; cookies do not, and a token provider treats a
  credential without `expiresAt` as expired (`auth-providers
  BaseTokenProvider.ts:96`, `:253`), so without this field stored cookies
  could never be reused.
- The doc comment on `authType` says a store states it for every destination
  that holds a credential or a grant.

### 1.2 `@mcp-abap-adt/auth-stores` 2.1.0 (minor)

The broker reads only through the contract (H0); these changes make the file
stores able to hold what §1.1 adds and state what §3 reads.

1. **Every §1.1 field is kept** by the ABAP session stores
   (`AbapSessionStore`, `SafeAbapSessionStore`), the XSUAA session stores
   (`XsuaaSessionStore`, `SafeXsuaaSessionStore`) and `EnvFileSessionStore`,
   under their existing update rule (field by field for the session's current
   type, `''` clears; a list is written whole). Key names are the store's
   (e.g. `SAP_GRANT_TYPE`, `SAP_OIDC_*`, `SAP_SAML_*`; `XSUAA_*` in the XSUAA
   stores).
2. **Which fields belong to which type** — the store's one-credential rule
   (`auth-stores CHANGELOG.md` 2.0.0) extended by grant:
   - `jwt`: `authorizationToken`, `grantType`, the `oidc*` fields; with
     `grantType: 'password'` also `username` and `password`.
   - `saml`: `grantType`, the `saml*` fields, and the credential its grant
     yields — `sessionCookies` for `saml2_pure` and `none`,
     `authorizationToken` for `saml2_bearer`.
   - A write of another type drops these as it drops any other type's fields.
3. **`authType` is stated by every store that holds a destination.** The XSUAA
   session stores write it (`XSUAA_AUTH_TYPE`, values `jwt` or `saml` — the
   latter for `saml2_bearer`; cookie sessions stay ABAP-only, as `mcp-sso`
   refuses them for `xsuaa`, `bin/mcp-sso.ts:810-819`) and answer `jwt` for a
   file without it — the only type an XSUAA file before 2.1.0 can hold, stated
   by the store about its own format, as the ABAP stores do for theirs.
   `AbapServiceKeyStore` and `XsuaaServiceKeyStore` answer `authType: 'jwt'`
   from `getConnectionConfig`: a UAA service key holds OAuth client credentials
   and nothing else. None of these is a choice between alternatives; the
   broker still reads only `authType`.
4. **A destination with no credential yet** — seeded before its first login:
   `authType`, `grantType`, `serviceUrl`, the grant's data, no token — is kept
   by both ABAP session stores and answered from `getConnectionConfig` with
   everything it states. **Measured on 2.0.0** (2026-10-01;
   `saveSession(d, { serviceUrl, authType: 'jwt', uaaUrl, uaaClientId, uaaClientSecret })`):
   `AbapSessionStore` writes the file and keeps the authorization config, but
   `getConnectionConfig` answers `null`; `SafeAbapSessionStore` throws "missing
   required field". The two stores disagree, and neither lets the broker read
   what such a destination states. The XSUAA session stores are stricter:
   `XsuaaSessionStore` and `SafeXsuaaSessionStore` both throw "missing
   required field" on it (measured, same date and call); and for a session
   they do keep, both answer `getConnectionConfig` with `authType` undefined
   (measured) — item 3.
5. **A public client** — an `IAuthorizationConfig` with `uaaClientSecret: ''`
   — is kept and returned as such. Today `mcp-sso` writes `__public__` and
   strips the line from its output (`bin/mcp-sso.ts:836-850`, `:911-920`).
   **Measured on 2.0.0** (2026-10-01; `saveSession` of a `jwt` session with a
   token and `uaaClientSecret: ''`): all four session stores (`AbapSessionStore`,
   `SafeAbapSessionStore`, `XsuaaSessionStore`, `SafeXsuaaSessionStore`) keep
   the token but answer `getAuthorizationConfig` with `null`, so a public
   client's destination cannot renew.
6. **`expiresAt`** is kept with the credential it belongs to — a field of the
   `jwt` and `saml` credentials — written, updated and cleared with it under
   the one-credential rules of 2.0.0.

### 1.3 `@mcp-abap-adt/auth-providers` 5.1.0 (minor, additive)

`Saml2PureProviderConfig` takes the stored credential as the other token
providers take theirs (`AuthorizationCodeProvider`, `UaaPasscodeProvider`, the
four OIDC providers and `Saml2BearerProvider` have `accessToken?` /
`refreshToken?`; `Saml2PureProvider.ts:30-35` has neither): `accessToken?` —
the cookies, which this provider already answers as its `authorizationToken`
(`Saml2PureProvider.ts:93`) — `refreshToken?`, and `expiresAt?`, since cookies
carry no expiry of their own. The token providers whose token is a JWT take
`expiresAt?` as well, used only when the token has no `exp`. No contract
changes: a constructor is called by whoever knows the class, so its config is
the class's, not `interfaces-auth`'s. Dependents on `^5.0.1` (connection)
take it without a release.

Neither the broker nor the CLI can be released before these three; §9 gives
the order.

## 2. The public surface

```ts
interface AuthBrokerConfig {
  sessionStore: ISessionStore;                                  // as 3.x
  serviceKeyStore?: IServiceKeyStore;                           // as 3.x
  /** The token API's source, as 3.x — now optional. Not used by getProvider (§4.3). */
  provider?: IRefreshableTokenProvider | TokenProviderFactory;  // TokenProviderFactory unchanged

  // Collaborators — each per destination, each required only by the grants that use it (§5).
  authorization?: (destination: string, grant: StrategyGrant) => IAuthorizationStrategy<string>;
  oidcAuthorization?: (destination: string) => IAuthorizationStrategy<OidcCallbackResult>;
  deviceCodePresenter?: (destination: string) => IDeviceCodePresenter;
  samlCookies?: (destination: string) => (samlResponse: string) => Promise<string>;
  assertionReplayStore?: (destination: string) => IAssertionReplayStore;
}
type StrategyGrant = 'authorization_code' | 'passcode' | 'saml2_pure' | 'saml2_bearer';

class AuthBroker {
  constructor(config: AuthBrokerConfig, logger?: ILogger);
  getProvider(destination: string): Promise<IAuthProvider>;      // new
  getToken(destination: string): Promise<string>;                // 3.x
  refreshToken(destination: string): Promise<string>;            // 3.x
  createTokenRefresher(destination: string): ITokenRefresher;    // 3.x
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>; // 3.x
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;       // 3.x
  flush(): Promise<void>;                                        // new: pending writes, §6
}

class DestinationConfigError extends Error {
  readonly code = 'DESTINATION_CONFIG';
  readonly destination: string;
  readonly missingFields: string[];   // field or option names only, never a value
  readonly cause?: unknown;           // a provider constructor's error, when that is what failed
}
```

`IAuthProvider` is not re-exported (the consumer takes contracts from
`interfaces-auth`, as `connection` 10 decided, `connection src/index.ts:11-14`);
the 3.x re-exports stay. The broker logs no token and writes nothing to
`process.stdout`.

## 3. The destination states the provider (H1)

### 3.1 Two fields decide, nothing else

`getProvider` reads the destination's `authType` and `grantType` and nothing
else to choose the provider; it never looks at which other fields are present.
Each is taken from the session's `getConnectionConfig`, else from the service
key store's (§3.3). The pairs:

| `authType` | allowed `grantType` |
|---|---|
| `basic` | not read |
| `snc` | not read |
| `jwt` | `authorization_code`, `client_credentials`, `passcode`, `oidc_authorization_code`, `device_code`, `password`, `token_exchange`, `none` |
| `saml` | `saml2_pure`, `saml2_bearer`, `none` |

A `jwt` or `saml` destination that states no `grantType`, or a pair outside the
table, is a `DestinationConfigError` (§4.4). There is no broker-level grant and
no default: the grant is stated by the destination's stores, the reading of H1
the review settled. What a consumer must write so its destinations state it is
in §12 (the server) and §10 (the CLI).

**`none` is how a handed-over credential is stated.** A `jwt` destination with a
token and no way to renew it, or a `saml` destination with cookies negotiated
elsewhere (`mcp-sso saml2 --flow pure --cookie …`, `bin/mcp-sso.ts:31`), says
`grantType: 'none'` — not "no authorization config", which would be choosing by
what is absent.

### 3.2 A 3.x session without `SAP_AUTH_TYPE`

`auth-stores` 2.x reads such a file by its 1.x inference (cookies → `saml`,
username and password with an empty token → `basic`, token → `jwt`;
`auth-stores CHANGELOG.md` 2.0.0 *Added*). **Decision: that is the store's
answer through the contract, not the broker's inference.** H0 makes the
contract the broker's whole view of storage; how a file store reads its own
legacy format is that store's business, as a database store reading a column
would be. The broker adds no rule of its own. Such a file has no `grantType`,
so `getProvider` refuses a `jwt` or `saml` one until it is written again
(`mcp-auth` / `mcp-sso` 1.0 write both fields, §10); `basic` needs nothing new.
The token API does not read `grantType` and serves it as in 3.x (§9).

### 3.3 Where each field comes from

- **Connection fields** — the session's `getConnectionConfig`, each field
  falling back to the service key store's only where the session lacks it
  (the 3.x rule for `serviceUrl`, `src/AuthBroker.ts:264-285`).
- **The client** (every grant but `none`): `IAuthorizationConfig` resolved as
  3.x does — the session's own, else the service key's with the refresh token
  the session stored through `loadSession` (`src/AuthBroker.ts:231-262`).
  `uaaUrl` is the authorization server's base URL (for OIDC grants, what
  `mcp-sso` writes there today: `--uaa-url`, else the token endpoint, else the
  issuer, `bin/mcp-sso.ts:836-850`); `uaaClientSecret: ''` is a public client
  and reaches the provider as no secret. `client_credentials`, `passcode`,
  `authorization_code` and `saml2_bearer` need `uaaUrl`; the OIDC grants need
  `uaaClientId` and take their endpoints from the `oidc*` fields.
- **The refresh token** — from the authorization config when the session holds
  one, else `loadSession().refreshToken` (the "refresh token alone" session 3.x
  writes, `src/AuthBroker.ts:322-333`).
- **Store reads** keep the 3.x rule: `null` or `FILE_NOT_FOUND` is absence, any
  other failure is thrown as the store raised it (`src/AuthBroker.ts:358-372`).

## 4. `getProvider(destination)` (H1, H2, H3)

### 4.1 What each destination gets

All classes are auth-providers 5.0.1. "Seed" is the stored `authorizationToken`
(`accessToken`) and refresh token. Every token provider gets
`onTokens` (§6) and the broker's logger.

| `authType` / `grantType` | Provider | Destination data | Consumer collaborators |
|---|---|---|---|
| `basic` | `new BasicAuthProvider(username, password)` | `username`, `password` | — |
| `snc` | `SncLogonProvider.forSecureLoginClient({ partnerName, qop, sncLib, myName, logger })` | `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName` | — (the recipe composes `DefaultSncLibraryLocator(nodeSncSystem(), sncLib)` and `[SecureLoginClientProbe]`, `auth-providers src/snc/SncLogonProvider.ts:106-121`) |
| `jwt` / `authorization_code` | `AuthorizationCodeProvider` | client, seed | `authorization(d, 'authorization_code')` |
| `jwt` / `client_credentials` | `ClientCredentialsProvider` | client | — |
| `jwt` / `passcode` | `UaaPasscodeProvider` | client, seed | `authorization(d, 'passcode')` — handed `<uaaUrl>/passcode`, returns the code |
| `jwt` / `oidc_authorization_code` | `OidcBrowserProvider` | client; `oidcIssuerUrl`, `oidcAuthorizationEndpoint`, `oidcTokenEndpoint`, `oidcScopes`; seed | `oidcAuthorization(d)` |
| `jwt` / `device_code` | `OidcDeviceFlowProvider` | client; `oidcIssuerUrl`, `oidcDeviceAuthorizationEndpoint`, `oidcTokenEndpoint`, `oidcScopes`; seed | `deviceCodePresenter(d)` |
| `jwt` / `password` | `OidcPasswordProvider` | client; `username`, `password`; `oidcIssuerUrl`, `oidcTokenEndpoint`, `oidcScopes`; seed | — |
| `jwt` / `token_exchange` | `OidcTokenExchangeProvider` | client; `oidcSubjectToken`, `oidcSubjectTokenType`, `oidcAudience`, `oidcActorToken`, `oidcActorTokenType`, `oidcScopes` (joined), `oidcIssuerUrl`, `oidcTokenEndpoint`; seed | — |
| `jwt` / `none` | `TokenAuthProvider.fixed(authorizationToken)` | `authorizationToken` | — |
| `saml` / `saml2_pure` | `Saml2PureProvider` | `samlIdpSsoUrl`, `samlSpEntityId`, `samlAcsUrl`, `samlRelayState`, `samlIdpEntityId`, `samlIdpInitiated`; the validator's `samlIdpCertificates`, `samlClockSkewMs`; seed (`sessionCookies` as `accessToken`, `expiresAt`) | `authorization(d, 'saml2_pure')`, `samlCookies(d)`, `assertionReplayStore(d)` |
| `saml` / `saml2_bearer` | `Saml2BearerProvider` | the same SAML fields; `samlTokenUrl`; client (`uaaUrl`, `uaaClientId`, `uaaClientSecret`); seed | `authorization(d, 'saml2_bearer')`, `assertionReplayStore(d)` |
| `saml` / `none` | `new SamlAuthProvider(sessionCookies)` | `sessionCookies` | — |

- **The SAML validator is composed by the broker** from data and one
  collaborator: `createSignedResponseValidator({ idpCertificates, clockSkewMs, replayStore })`
  for `saml2_pure` and `createSignedAssertionValidator(…)` for `saml2_bearer` —
  the pairing auth-providers' own recipes use (`Saml2PureProvider.ts:56-71`,
  `Saml2BearerProvider.ts:73-88`); the provider gets `idpEntityId` as the
  expected issuer. The replay store is a live object, so it is the
  consumer's (`defaultReplayStore` is the usual answer).
- **Same wiring as `mcp-sso`.** Each row passes the provider the fields
  `mcp-sso` passes today (`bin/mcpSsoConfig.ts:446-633`), seeded as
  `buildProviderConfig` seeds OIDC and bearer (`:712-728`); `mcp-sso`'s strategy
  choices (callback, manual paste, static assertion, IdP-initiated paste)
  become what the consumer's function returns.
- **`saml2_pure` is seeded like the rest** (auth-providers 5.1.0, §1.3): the
  stored cookies as `accessToken` with the stored `expiresAt`, so a new broker
  reuses them until they expire and logs in again only then; the cookies it
  obtains are persisted with their `expiresAt` (§6). "Seed" in this table
  always includes `expiresAt` when the store holds one.
- `snc` composes every collaborator explicitly through the named recipe
  (auth-providers rule 7 allows a static factory for "a named, common recipe");
  `sncLib` from the store is the locator's explicit candidate.

### 4.2 A refused credential

Each provider answers `rejected()` by its own rules (auth-providers rule 5–6):
a token provider renews once (refresh, then at most one login through its
collaborator); `basic`, `snc`, `none` and `SamlAuthProvider` answer Oops in
their own words ("the user or password was refused", the GSS cause, "the token
was refused", "the SAML session was refused or has expired").

### 4.3 A consumer's own provider

`AuthBrokerConfig.provider` is the token API's source (§9), as in 3.x. It is not
used by `getProvider`: the destination states its provider (H1), and a
consumer that builds its own ("injecting a provider or a factory", goal
*Stays*) hands it to the connector itself — or wraps the token API with
`TokenAuthProvider.from(broker.createTokenRefresher(d))`, whose every renewal is
persisted by the token API (H3). With a consumer `provider`, `getProvider` and
the token API are two token sources for one destination; the README says so.

### 4.4 A destination that lacks what its type needs: `getProvider` throws

**Decision:** `DestinationConfigError`, naming the destination and the missing
fields or options — never a value. `getProvider` never returns a provider built
only to refuse in `prepare()`.

- Auth-providers rule 1 ("no exception crosses the contract") binds the four
  `IAuthProvider` methods; `getProvider` is the broker's, and the broker
  already throws on configuration before any provider is asked (3.x: a missing
  `serviceUrl`, `src/AuthBroker.ts:278-283`).
- A missing field is a fault no renewal cures. A provider built to refuse would
  be a credential the destination does not have, and the fault would surface at
  the first `connect()` instead of where the server builds its connector at
  startup — where calm already fails on missing UAA credentials
  (`calm buildBroker.ts:103-109`).
- Runtime conditions stay the provider's: no token yet, a refused refresh
  token, a login the strategy refuses — Oops from `prepare()` / `rejected()`.

Thrown for: no `authType`, or one outside the four; for `jwt`/`saml` no
`grantType`, or a pair outside §3.1; a field its row in §4.1 needs (`''`
counts as missing; `oidcIssuerUrl` or the explicit endpoints satisfy the OIDC
rows as the providers accept either); a collaborator its row needs (named by
option, e.g. `deviceCodePresenter`); a token provider's destination without
`serviceUrl` (the 3.x rule, kept because persistence writes it). A provider
constructor's own `ValidationError` (an `sncQop` outside `1|2|3|8|9`,
`SncLogonProvider.ts:90-96`; `idpInitiated` with a request ID) becomes a
`DestinationConfigError` naming the store field, with the original as `cause`.

## 5. Collaborators the consumer supplies (H2; goal open 1)

**Recommendation: one option per kind of collaborator, each a function of the
destination, given to the broker's constructor** (§2). The broker calls it once,
when it builds that destination's provider.

- **Not per call:** `getProvider` is cached (§7); a collaborator passed on a
  call would take effect on the first call only.
- **Not one instance per broker:** a browser strategy holds one port and
  rejects an overlapping `authorize` (`auth-providers src/strategies/BrowserCallbackStrategy.ts:112-116`),
  and a process may want different collaborators per destination. A function
  covers both; returning one shared instance is allowed.
- **`authorization` also receives the grant**, because the UAA code, the
  passcode and the two SAML flows take different strategies of the same type
  (`browserCallbackStrategy`, `manualPasscodeStrategy`, `samlCallbackStrategy`,
  `manualSamlResponseStrategy`…). The OIDC browser strategy has another result
  type (`OidcCallbackResult`), hence its own option.
- **Required only where used.** Absent, a destination whose row needs it is a
  `DestinationConfigError` naming the option; nothing else needs any. There is
  no broker default (H2).
- **Lifecycle: whoever constructs, disposes** (auth-providers' rule). The
  consumer's function constructs; neither the broker nor the provider disposes.
- **A headless process** passes an `authorization` that refuses — calm-server's
  `refuseLogin` is exactly that (`calm buildBroker.ts:42-50`) — and a presenter
  that routes the device code wherever it can reach a person, or refuses. The
  provider then runs on its refresh token; when a login is needed it fails, and
  `prepare()` / `rejected()` answer Oops with the class label of what the
  collaborator threw (never its message, auth-providers rule 2).
- The server today opens a browser from the server process
  (`browser: this.config.browser || 'system'`, `brokerFactory.ts:876`); in step
  5 it passes `browserCallbackStrategy({ browser, port })` from its own options.

## 6. Persistence through `onTokens` (H3, H4)

Every token provider the broker builds gets
`onTokens: (result) => this.persist(destination, result)`. `BaseTokenProvider`
calls it after every login and every refresh — never on a cache hit — and awaits
it before answering, whichever moment triggered the renewal: `prepare()`,
`authorize()` on expiry, `rejected()` after a 401, or the token API
(`BaseTokenProvider.ts:207-248`). A renewal inside the connector is written
before the connector resends.

`persist` writes what 3.x writes (`src/AuthBroker.ts:295-345`), under these rules:

1. **The destination's stated `authType` is declared on every write, never
   derived from the result.** `setConnectionConfig(destination, { ...connConfig, serviceUrl, <credential>, authType })`,
   re-reading `connConfig` at write time so nothing written meanwhile is
   reverted (its `grantType` and `oidc*`/`saml*` fields are carried through).
   `<credential>` is `sessionCookies` for a `saml2_pure` result (`tokenType:
   'saml'`) and `authorizationToken` otherwise — for `saml2_bearer` under
   `authType: 'saml'`, which §1.2 item 2 lets the store hold. Declaring the type
   is also what `auth-stores` 2.x needs: it refuses a config with two
   credentials and no type (`CHANGELOG.md` 2.0.0 *Changed*).
2. **The refresh token**, only when the result has one: into the session's own
   authorization config when it holds one, else `saveSession` with the refresh
   token alone. **The client secret is never written** (H4); nor is any other
   §1.1 secret — `persist` writes only what the provider obtained.
3. **A `basic` or `snc` session is never written over.** `persist` reads the
   session's stated `authType` first and refuses to write a token over `basic`
   or `snc`. A provider the broker built cannot reach that — those destinations
   get providers that obtain nothing — so the check guards the token API (§9).

`ITokenResult.expiresAt` is written as `expiresAt` (§1.1) with the credential
it belongs to, for `jwt` and `saml` alike; a provider seeded with a stored JWT
still reads `exp` itself (`src/AuthBroker.ts:292-293`), the stored value
serving the tokens that carry none — cookies above all.

**A failed write does not fail the authentication; the broker retries it on
its own until the store takes it** (H3). The failure is the storage's or a
broker bug, never the token's (fact 5), so the connector goes on with the token
it holds. The retry does not wait for the provider to be called again — a
request may be the process's last:

- the broker's `onTokens` never throws; a failed `persist` leaves the result
  pending for that destination and schedules another attempt with a growing
  delay (one second, doubling, capped at one minute) on a timer that is
  `unref()`ed, so it never keeps a process alive;
- a newer result for the destination replaces the pending one — only the
  latest is ever written; attempts for one destination never overlap, and a
  write from the token API or a later `onTokens` goes through the same queue
  (§7);
- each failure is logged by class name (no message: the store holds tokens);
- **`flush()`** awaits every pending write with one more attempt each and
  rejects with the failures, by destination, if any remain — the consumer
  calls it on shutdown (the server on `SIGTERM` and before a stdio transport
  closes) to know whether its tokens are stored. The CLI calls it before it
  exits and exits non-zero on a failure.

What a provider obtains reaches the store once the store can write, while the
process lives; a storage that stays broken until the process ends cannot be
written by any design, and `flush()` is how the consumer learns of it. The
token API reports a failed write to its caller, as 3.x did: the broker records
it against that result (a `WeakMap<ITokenResult, unknown>`, §9) and keeps
retrying it as above. auth-providers is not changed for this: its best-effort
`onTokens` (`BaseTokenProvider.ts:362-375`) is exactly what the broker needs.

## 7. Caching and concurrency (goal open 3)

**Recommendation: one provider per destination for the broker's life, shared
by `getProvider` and the token API** (when no consumer `provider` is given).

- One per-destination cache serves both, so there is one token, one refresh
  token and one renewal in flight per destination.
- **The cache holds the promise of the build**, set before the first store read
  and dropped if the build throws. 3.x set the map only after an `await`
  (`src/AuthBroker.ts:204-213`), so two concurrent first calls could build two
  providers. A build that threw is retried on the next call, as 3.x does for a
  factory that threw.
- **Two callers renewing at once** share one renewal: `BaseTokenProvider` holds
  one in flight (`BaseTokenProvider.ts:198-205`), and a `rejected()` whose
  presented token is already superseded answers Ok without renewing
  (`:416-443`). The connection adds no single-flight and asks `rejected()` once
  per request (`connection src/connection/AbstractAbapConnection.ts:1610-1621`).
  The token API's `refreshToken` joins the same renewal. One renewal is one
  `onTokens`, so writes for a destination do not race each other.
- **What the cache does not see:** a destination rewritten from outside (a new
  `mcp-auth` run) is picked up by a new broker, not a cached provider — as in
  3.x. That holds for every type.

## 8. What the store contract must carry (H0; goal open 5)

| Destination | Needs | Where (1.2.0) |
|---|---|---|
| any | `authType` | `IConnectionConfig.authType` (1.1.0, `IConnectionConfig.ts:15`); stated by every store (§1.2 item 3) |
| `jwt`, `saml` | the grant | **new** `IConnectionConfig.grantType` |
| `basic` | `username`, `password` | 1.1.0 (`:11`, `:13`) |
| `snc` | `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName` | 1.1.0 (`:26-32`) |
| UAA grants, `saml2_bearer`, OIDC client | `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`''` = public), `refreshToken` | 1.1.0 `IAuthorizationConfig`; public client semantics new (§1.2 item 5) |
| OIDC grants | issuer, endpoints, scopes; subject/actor token and types; audience | **new** `oidc*` fields |
| `password` | `username`, `password` | 1.1.0 fields, kept in a `jwt` session (§1.2 item 2) |
| SAML grants | IdP SSO URL, entity IDs, certificates, ACS, relay state, `idpInitiated`, clock skew, token URL | **new** `saml*` fields |
| `none` | the token or the cookies | 1.1.0 (`:9`, `:21`) |
| renewal write-back | `setConnectionConfig` with the credential and `authType`; `setAuthorizationConfig` / `saveSession` with the refresh token | `ISessionStore` (1.1.0), as 3.x uses it; a token under `saml` for `saml2_bearer` (§1.2 item 2) |
| a destination before its first login | read back with what it states | store behaviour (§1.2 item 4) |

Certificates are out of scope (goal, open 4): no field is added for them.

## 9. The token API keeps 3.x (H5)

| 3.x behaviour (tested in `src/__tests__/broker/AuthBroker.test.ts`) | 4.0 |
|---|---|
| `getToken` asks `getTokens()`, `refreshToken` asks `refreshTokens()` — never the cached token | unchanged |
| a factory is seeded with `(destination, authConfig \| null, { ...conn, serviceUrl })`; the session's credentials win over the key's; the stored refresh token is passed | unchanged; `TokenProviderFactory` keeps its signature |
| one provider per destination from a factory; an instance for every destination; a factory that threw is retried | unchanged; the §7 cache |
| `serviceUrl` from the session, else the service key, else an error before the provider is asked | unchanged |
| the result is written, a SAML result as cookies; the refresh token only when the result has one; no client secret | unchanged (§6 `persist`; with no stated `authType`, the type follows the result as 3.x) |
| provider errors propagate unchanged; the provider is not asked again after a failure | unchanged |
| store failures other than absence propagate as raised | unchanged, including a write failure (below) |
| a result without `authorizationToken` is an error | unchanged |
| `createTokenRefresher(d)` = `{ getToken: () => getToken(d), refreshToken: () => refreshToken(d) }` | unchanged |

**Where the token API writes.** With a consumer `provider`, exactly as 3.x:
`persist` after every `getTokens()` / `refreshTokens()`, cache hits included.
With a provider the broker built, `onTokens` writes every new token, so the
token API writes nothing itself; if the write of the result it received
failed, the token API throws that failure (§6) — a store failure still reaches
the caller — while the provider keeps retrying the write.

**Design decision — a `basic` or `snc` destination has no token API.** The goal
says the session's `authType` is not overwritten; 3.x asked the provider and
wrote `jwt` over whatever the session said (`src/AuthBroker.ts:302-308`). So the
token API reads the session's stated `authType` first and, for `basic` or `snc`,
throws `DestinationConfigError` before any provider is asked. Every other 3.x
path is as the table says.

**Without a consumer `provider`**, the token API serves the destinations whose
§4.1 provider is a token provider (every grant but `none`, and not `basic` /
`snc`), and throws `DestinationConfigError` for the rest.

**`createTokenRefresher` stays as it is** and is not deprecated: calm-server
injects it into its own connection (`calm src/server/buildClient.ts:31`). For a
`connection` 10 connector, `getProvider` replaces it.

## 10. `@mcp-abap-adt/auth-broker-cli` 1.0.0

**What moves.** `bin/mcp-auth.ts`, `bin/mcp-sso.ts`, `bin/mcpSsoConfig.ts`,
`bin/samlMetadata.ts`, `bin/workDir.ts` → `packages/auth-broker-cli/src/`,
compiled to `dist/`; `bin` = `mcp-auth`, `mcp-sso`. Their tests
(`src/__tests__/bin/*`, fixtures included) and the CLI stands (`tests/keycloak`,
`tests/sso-demo`, with their npm scripts) move with them.
`generate-env-from-service-key.ts` moves as a development script (not a bin,
as today), and takes the grant from a flag, as `mcp-auth` does, instead of from
the key's URL (fact 1).

**Commands and flags are unchanged.** Internal changes:

- `AuthBroker` is imported from `@mcp-abap-adt/auth-broker`, not `require`d by
  path into `dist` (`bin/mcp-auth.ts:28-29`, `bin/mcp-sso.ts:38-39`).
- `getVersion()` reads **this** package's manifest.
- **Explicit collaborators instead of auth-providers 4.x defaults:** the device
  flow gets `presenter: consoleDeviceCodePresenter(logger)`; the SAML flows get
  an `assertionValidator` built from the trust the CLI already collects
  (`createSignedResponseValidator` for pure, `createSignedAssertionValidator`
  for bearer, `replayStore: defaultReplayStore`), replacing `idpCertificates`
  on the provider config (`bin/mcpSsoConfig.ts:595-602`); manual strategies get
  `read: (prompt, signal) => readManualInput(prompt, signal)`, where
  `readManualInput` closes its `readline` and rejects when the signal aborts
  (today it takes none, `bin/mcpSsoConfig.ts:110-130`).
- **The session it writes is a complete 4.0 destination.** Each run writes,
  through the session store's contract, the destination's `authType`,
  `grantType` and the grant's data before the login, so the file it produces
  is one `getProvider` can build from:

  | Command | `authType` / `grantType` | Also written |
  |---|---|---|
  | `mcp-auth` | `jwt` / `authorization_code` | client (as today) |
  | `mcp-auth --credential` | `jwt` / `client_credentials` | client |
  | `mcp-sso oidc --flow browser` | `jwt` / `oidc_authorization_code` | `oidcIssuerUrl`, endpoints, `oidcScopes`, client |
  | `mcp-sso oidc --flow device` | `jwt` / `device_code` | same |
  | `mcp-sso oidc --flow password` | `jwt` / `password` | `username`, `password`, `oidcTokenEndpoint`, … |
  | `mcp-sso oidc --flow password --passcode` | `jwt` / `passcode` | client (today this is the password grant with username `passcode`, `bin/mcpSsoConfig.ts:471-486`; a one-time code cannot log in twice) |
  | `mcp-sso oidc --flow token_exchange` | `jwt` / `token_exchange` | `oidcSubjectToken`, types, audience, … |
  | `mcp-sso saml2 --flow pure` | `saml` / `saml2_pure` | every `saml*` field `applySamlMetadata` resolved |
  | `mcp-sso saml2 --flow pure --cookie …` | `saml` / `none` | the cookies |
  | `mcp-sso bearer` | `saml` / `saml2_bearer` | `saml*` fields incl. `samlTokenUrl`, client |

  The secrets among them (`password`, subject and actor tokens, a client
  secret the user gave) are written because the user asked the CLI to produce a
  destination that can renew; the broker never writes them (H4). A public
  client is written with `uaaClientSecret: ''` (§1.2 item 5) instead of today's
  `__public__` stripped afterwards.
- `mcp-auth` keeps injecting its own provider into the broker (the token API
  path, §9) — its browser, port and timeout flags are its own.

**Dependencies:** `@mcp-abap-adt/auth-broker` ^4.0.0, `@mcp-abap-adt/auth-stores`
^2.1.0, `@mcp-abap-adt/auth-providers` ^5.1.0, `@mcp-abap-adt/interfaces-auth`
^3.0.0, `@mcp-abap-adt/interfaces-auth-sap` ^1.2.0, `@mcp-abap-adt/interfaces-utils`
^1.1.0, `@mcp-abap-adt/logger` (a runtime dependency, `CHANGELOG.md` 3.0.4).

**The bin smoke check** (`tools/check-packed.js`, part of `npm run check`, §11):
pack both packages; in an empty temporary directory `npm init -y` and
`npm install --no-save --ignore-scripts` both tarballs; run `mcp-auth` and
`mcp-sso` with `--version` and `help`, asserting exit 0 and the CLI's manifest
version (not the broker's); `require('@mcp-abap-adt/auth-broker')` loads, and its
manifest has no `bin` and no `auth-stores` dependency. It installs the other
dependencies from the registry, so it needs the network and says so when it
cannot reach it. Same check as the server's
(`server src/__tests__/unit/binSmoke.test.ts`), which exists because 3.0.3
shipped a bin that died on `MODULE_NOT_FOUND`.

**Release order.** `interfaces-auth-sap` 1.2.0, then `auth-stores` 2.1.0 and `auth-providers` 5.1.0 (§1; the last depends on neither).
Then one `release:publish` run here publishes `auth-broker` 4.0.0 and
`auth-broker-cli` 1.0.0 in workspace order, so no registry state has 3.x's
`mcp-auth` gone without the CLI package present.

## 11. The repository takes the `mcp-abap-adt-interfaces` layout

**What that layout is** (`interfaces` root, read in full):

1. A private root `package.json` (`"private": true`, no version) whose
   `workspaces` lists every package **in dependency order**, which is also the
   publish order.
2. Root scripts: `clean` (`--workspaces`), `lint` / `lint:check` / `format`
   (Biome over `packages` and `tools`), `build` (clean, Biome at error level,
   `tsc -b` over each package's `tsconfig.build.json`), `test:check`
   (`--workspaces`), `check` (build, type checks, the tools' checks, packed
   tarballs, the release tool's own test), `check:publish`
   (`tools/test-publish-changed.js`), `release:publish`
   (`tools/publish-changed.js`), `chrono`.
3. Root dev dependencies only (`@biomejs/biome`, `typescript`, `@types/node`,
   `semver`); one `package-lock.json`; `tsconfig.base.json` at the root.
4. Per package: `package.json` with `repository.directory`, its own
   `homepage`, `files` = `dist`, README, CHANGELOG, LICENSE, COPYING;
   `prepublishOnly: npm run --prefix ../.. check`; `tsconfig.json` extending the
   base and `tsconfig.build.json` with project `references` to its siblings.
5. `publish-changed.js`: publishes only versions not on the registry, runs
   `npm run check` once, publishes with `--ignore-scripts`, refuses a dirty
   tree, a missing tag, a tag that is not `HEAD`'s ancestor, any difference
   between `HEAD` and the tag, a prerelease on `latest`, and moving `latest`
   backwards; verifies at the end (exit 2 = published, not yet served). Tags
   are `<dir>-v<version>`.
6. `check-graph.js`: each package imports only what an allowlist permits,
   declares it, and imports everything it declares.
7. No CI: `npm run check` is what holds, run by `release:publish` and every
   `prepublishOnly`. `.gitignore` names `node_modules` both ways.

**Mirrored here:**

```
/                          private root: package.json, package-lock.json, tsconfig.base.json,
                           biome.json, tools/, docs/, README.md (workspace overview), LICENSE,
                           COPYING, CONTRIBUTORS.md, CLAUDE.md, AGENTS.md, ROADMAP.md, .github/
packages/auth-broker/      @mcp-abap-adt/auth-broker — today's src/, its tests,
                           tests/test-config.yaml.template, README, CHANGELOG (3.x history + 4.0.0)
packages/auth-broker-cli/  @mcp-abap-adt/auth-broker-cli — today's bin/ as src/, its tests,
                           tests/keycloak, tests/sso-demo, README, CHANGELOG (starts at 1.0.0)
tools/                     publish-changed.js, test-publish-changed.js (copied; comments about the
                           interfaces facade removed), check-graph.js, check-packed.js, version-stats.sh
```

- `workspaces`: `["packages/auth-broker", "packages/auth-broker-cli"]`.
- Root scripts as item 2, plus `test` (`--workspaces --if-present`: this
  repository has Jest suites). Jest, `ts-jest` and `@types/jest` are root dev
  dependencies; each package keeps its own `jest.config.js`.
- `check` = build, `test:check`, `lint:check`, `check:graph`, `check:packed`,
  `check:publish`. It does not run Jest: the library's integration suite reads
  real session files when configured, and a release gate must not reach a real
  system unasked.
- `check-graph.js` allowlist: `auth-broker` → `interfaces-auth`,
  `interfaces-auth-sap`, `interfaces-utils`, `auth-providers`;
  `auth-broker-cli` → the §10 list. H0's "the library never imports
  auth-stores" becomes a check.
- Tags from here on: `auth-broker-v4.0.0`, `auth-broker-cli-v1.0.0`; the `v*`
  tags stay as history.
- **CHANGELOGs:** today's `CHANGELOG.md` moves to `packages/auth-broker/` and
  continues there; the CLI's starts at 1.0.0 and says the commands shipped in
  `@mcp-abap-adt/auth-broker` up to 3.0.4, whose changelog holds their history.
- **READMEs:** the root README becomes the workspace overview; the library
  README keeps the API; the `mcp-auth` / `mcp-sso` sections move to the CLI's.

**Departures, each justified:**

- **`.github/workflows/release.yml` stays, adapted** (interfaces has no CI). It
  attaches the tarball to a GitHub release today; its trigger `v*.*.*` matches
  no new tag, so it becomes `auth-broker-v*` / `auth-broker-cli-v*`, packing
  the workspace the tag names. Whether any installation doc relies on those
  release assets is not checked *(inference)*.
- **`check-surface.js` and `package-map.json` are not mirrored**: they check the
  interfaces' symbol-to-package split, which does not exist here.
- **`check-packed.js` checks bins, not declarations**: the risk here is a bin
  that does not start (§10).
- **`engines` stays `^22 || ^24 || ^26`**, not `>=18`: it follows SAP BTP's Node
  versions (`CHANGELOG.md` 3.0.2).

## 12. Breaking changes and migration

**`@mcp-abap-adt/auth-broker` 4.0.0:**

1. **No `bin`.** `mcp-auth` and `mcp-sso` are in `@mcp-abap-adt/auth-broker-cli`.
2. **Contracts:** `@mcp-abap-adt/interfaces-auth` ^3.0.0,
   `@mcp-abap-adt/interfaces-auth-sap` ^1.2.0, `@mcp-abap-adt/auth-providers`
   ^5.1.0. Types from `interfaces-auth` 2.x no longer mix.
3. **`@mcp-abap-adt/auth-stores` is no longer a dependency** (H0); a consumer
   that imported it without declaring it must declare it.
4. **The token API refuses a destination stated `basic` or `snc`** (§9).
5. `axios` leaves the dependencies (nothing in `src/` or `bin/` imports it).

Additive: `getProvider`, `DestinationConfigError`, the collaborator options,
`provider` optional.

**Migration notes:**

- **The server (goal step 5).** Build the connector from
  `await broker.getProvider(destination)`; delete the per-auth-type
  `connectionParams`, the `getToken` call before connecting and the
  `tokenRefresher` (`BaseMcpServer.ts:112-205`, `:316-334`, `utils.ts`
  `getManagedConnection`). Construct the broker without `provider`, with
  `authorization: () => browserCallbackStrategy({ browser, port })` (and the
  other collaborators for the grants it serves). **What it must write:** the
  sessions it seeds from service keys (`brokerFactory.ts:490-598`) get
  `authType: 'jwt'` and `grantType: 'authorization_code'` — what
  `createTokenProviderForDestination` always chose — through
  `setConnectionConfig`, which §1.2 item 4 lets both ABAP session stores keep
  before the first login. A `.env` a user wrote by hand (`--env`) must state
  `SAP_GRANT_TYPE` (`none` for a token alone); `getProvider` names it when it
  is missing. `getConnectionConfig` still gives the connector its URL and
  client. Its docs install `@mcp-abap-adt/auth-broker-cli` for `mcp-auth`
  (`README.md:367`, `docs/installation/INSTALLATION.md:53,83,292`,
  `docs/user-guide/AUTHENTICATION.md:47`).
- **calm-server (token API).** Bump the broker, auth-providers 5 and the
  contracts together. `TokenProviderFactory`, `refuseLogin` and
  `createTokenRefresher` work unchanged; its `mcp-auth` hints name the new
  package.
- **People who `npm i -g @mcp-abap-adt/auth-broker` for `mcp-auth`:**
  `npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli`.
  Commands and flags are the same. A session file written by 3.x keeps working
  for the token API; for `getProvider` it needs `grantType` — run the command
  that produced it again.

## 13. Testing

**Unit (`packages/auth-broker`; stores as in-memory fakes of the contract,
providers real, token endpoints local):**

- every row of §4.1: what `getProvider` returns does the right thing through
  the contract, with nothing in the test branching on its class — `basic`
  writes the Basic header and offers `{ user, passwd }`; `snc` hands over
  `snc_partnername` / `snc_qop` / `snc_myname` / `snc_lib` after `prepare()`
  (`sncLib` pointing at a fixture whose header is the host's architecture —
  *inference* that `DefaultSncLibraryLocator` accepts it), and a missing
  `sncLib` file is refused naming `sncLib`; each token grant obtains from a
  local endpoint with exactly the stored fields and calls its collaborator
  (a recording strategy, presenter, cookie function, replay store); the SAML
  rows validate a signed fixture assertion against `samlIdpCertificates` and
  refuse one from another key; each `none` presents what is stored;
- each `DestinationConfigError` case of §4.4, asserting `missingFields` and that
  no value appears in the message; `grantType` absent and each invalid pair;
- persistence: a renewal through `rejected({ at: 'request', status: 401 })` on
  the provider `getProvider` returned is in the session store afterwards, with
  the stated `authType`, the refresh token beside it, **no client secret**; a
  `saml2_bearer` token is stored under `saml`, `saml2_pure` cookies as cookies;
  a `basic` / `snc` session is never overwritten; `onTokens`' write failure
  surfaces from `getToken`;
- a failed write through a connector: a connection 10 connector with the
  provider `getProvider` returned and a session store whose write fails once —
  the 401 renewal succeeds, the request is resent with the new token, and with
  no further call to the provider (fake timers) the broker writes the same
  result again and the store holds it; no second refresh, no login;
- `flush()`: resolves once pending writes land; rejects naming the destination
  when the store still fails; a newer result replaces a pending one; the retry
  timer does not keep the process alive (it is `unref()`ed);
- caching: concurrent `getProvider` calls build once; a failed build is retried;
  `getProvider` and `getToken` share one provider and one renewal;
- every row of §9, carried over from today's suite.

**Through `connection` 10** (dev dependency), no SAP system: an
`AdtCloudConnector` over its HTTP wire against a local server that answers the
first request 401 and the second 200, with a local token endpoint; the
provider renews once, the connector resends once, and the session store holds
the new token — the goal's success criterion end to end.

**Through the auth-providers stand** *(inference — the stand is that
repository's; reusing it here is proposed, not checked)*: the OIDC and SAML
grants against Keycloak and UAA in Docker, as auth-providers proves its own
wire contract, run only when `UAA_URL` / `KEYCLOAK_URL` are set.

**Live (H6):** `packages/auth-broker/src/__tests__/live/getProvider.live.test.ts`,
one case per row. Each reads a sessions directory and a destination name from
environment variables it names, states where it runs, and skips elsewhere
printing why. No configuration framework.

| Case | Where it runs |
|---|---|
| `basic` over HTTP and over RFC (`rfcConversationFrom`, needs `@mcp-abap-adt/sap-rfc-lite` and the NW RFC SDK) | an on-premise system |
| a `jwt` / `authorization_code` destination over HTTP, seeded with a well-formed JWT the system refuses (future `exp`, so the provider trusts it): the first request is a 401, the renewal happens in `rejected()`, and the new token is in the session file afterwards | BTP ABAP environment (trial) |
| `snc` over RFC | Windows or macOS with the SAP Secure Login Client logged on; on Linux the case skips stating that the Secure Login Client exists only there |

**Load-bearing:** each rule is broken once on purpose (the declared `authType`
in `persist`, the `basic`/`snc` guard, the H4 branch, the promise cache, the
the broker's own retry of a failed write, the pair table) and its test must go red, then
restored.

**CLI package:** today's `mcpSsoConfig` / `samlMetadata` / `mcpSsoSamlProviders`
suites move and are adapted to validators and to the destination each command
writes (§10 table); `readManualInput` honours the abort; the smoke check.

## 14. Documentation and housekeeping

- **Stale comments:** `src/index.ts:34-37` and `src/stores/index.ts:4-6` name
  `@mcp-abap-adt/auth-stores-btp` / `-xsuaa`, which do not exist — they become
  "store implementations: `@mcp-abap-adt/auth-stores`, or any
  `ISessionStore` / `IServiceKeyStore`"; `src/types.ts:4` and
  `src/stores/interfaces.ts:4` say "imported from `@mcp-abap-adt/interfaces`",
  deleted as of its 52.0.0 — they name `interfaces-auth-sap`.
- **Docs updated for 4.0** (all of them, not only the CHANGELOG): root and both
  package READMEs (the destination table of §3.1/§4.1, the collaborator options,
  a *Migrating to 4.0.0* section with §12); `docs/architecture/ARCHITECTURE.md`
  and `EXPORTS.md`; `docs/using/USAGE.md`; `docs/installing/INSTALLATION.md`;
  `docs/development/TESTING.md`; `CLAUDE.md` and `AGENTS.md`.
- The goal, this spec and the plan are deleted before the release.

## 15. Out of scope

- Certificates (goal, open 4 — decided).
- Evicting a cached provider when a store changes underneath it (§7).
- The server's migration (goal step 5) beyond §12.

## 16. Check against the goal

**What changes:**

| Goal bullet | Met by |
|---|---|
| `getProvider(destination): IAuthProvider` taken by a `connection` 10 connector as it is | §2, §4, §13 *Through connection 10* |
| built from the configuration the destination states (`authType`) | §3.1, §3.3 |
| `basic` → `BasicAuthProvider(username, password)` | §4.1 |
| `jwt` → a token provider seeded from the session and the service key, as today's factories do | §4.1 (every grant today's factories and `mcp-sso` use: UAA code, client credentials, passcode, the four OIDC grants; seeded), §3.3 |
| `saml` → the SAML providers (cookies or bearer), as `mcp-sso` configures them | §4.1 (`saml2_pure`, `saml2_bearer`, the validator and `mcp-sso`'s wiring; `none` for cookies handed over), §1.1 |
| `snc` → `SncLogonProvider` from the four SNC fields | §4.1 |
| persistence moves to `onTokens`; a renewal the connector triggers is written back | §6, §13 |
| no implicit defaults: strategy, presenter, SAML validator and replay store, SNC locator and probes explicit | §5 (strategies, presenter, cookie function, replay store), §4.1 (validator composed from data + replay store; SNC recipe) |
| the commands move to `@mcp-abap-adt/auth-broker-cli`; the interfaces layout; `release:publish` | §10, §11 |
| the CLI on explicit collaborators: presenter, `assertionValidator`, `read(prompt, signal)` | §10 |
| dependencies: auth-providers ^5.0.1, interfaces-auth ^3.0.0, interfaces-auth-sap; auth-stores only as a dev dependency of the library | §12 item 2 (auth-providers ^5.1.0 and interfaces-auth-sap ^1.2.0, the releases §1.3 and §1.1 add), §11 `check-graph` |
| the session's `authType` is not overwritten | §6 item 1 and 3, §9 |
| *Stays:* the stores and their contracts; no client secret in the session; the token API and `createTokenRefresher`; injecting a provider or a factory | §1 (contracts extended, not changed), §6 item 2, §9, §4.3 |

**Holds:**

| Hold | Met by |
|---|---|
| H0 the broker speaks only the store contracts | §3.3, §1.1 (everything `getProvider` needs is added to `interfaces-auth-sap`), §1.2 (stores implement it), §11 `check-graph` |
| H1 the configuration states the provider; nothing inferred | §3.1 (`authType` + `grantType`, no broker-level grant, `none` stated), §3.2 |
| H2 no implicit defaults | §5, §4.1, §4.4 (a missing collaborator is an error, never a default) |
| H3 what a provider obtains reaches the session store | §6, §4.3, §13 |
| H4 no secret the broker was not given to store | §6 item 2, §10 (the CLI's own writes), §13 |
| H5 the token API keeps its 3.x behaviour | §9 |
| H6 measured: basic, token, SNC through a connection 10 connector | §13 *Live* |

| Goal open question | Answer |
|---|---|
| 1 strategy | §5 — per destination, from functions given to the broker; headless passes refusing ones |
| 2 grant | §3.1 — stated by the destination's `grantType`, the full set of §1.1 |
| 3 caching | §7 — one provider per destination, shared, promise-cached |
| 4 certificates | out of scope, as decided |
| 5 contract | §1.1, §8 |
