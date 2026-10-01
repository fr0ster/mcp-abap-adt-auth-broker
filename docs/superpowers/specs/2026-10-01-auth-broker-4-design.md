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
`interfaces-auth-sap` 1.1.0, `160a0e6`; `interfaces-auth-broker` 1.0.0 /
`interfaces-auth-sap` 2.0.0, `6165673`), `server` (`mcp-abap-adt`, `ec208a87`)
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
6. **The two stores are split by the role of the data, not by auth type**
   (decided by the user, 2026-10-01). `IServiceKeyStore` holds the *means* —
   what is used to obtain a session secret: the client, the grant, basic's
   user and password, the SNC, OIDC and SAML settings, `serviceUrl`,
   `sapClient`, `language`. `ISessionStore` holds only the *secret* that
   authorizes within a session: `authorizationToken`, `refreshToken`,
   `expiresAt`, `sessionCookies`. Either store may have many implementations
   (a service key file, a database, something hand-written; a session folder,
   memory); the broker knows only the contracts. §8 states the split and
   verifies the contract carries it; every section below follows from it.

## 1. Prerequisites

Four releases precede 4.0.0: a new contract package, the SAP one without what moved into it, the stores and the providers. The first two are done: `interfaces-auth-sap` 2.0.0 and `interfaces-auth-broker` 1.0.0 were published on 2026-10-01 (tags `interfaces-auth-sap-v2.0.0`, `interfaces-auth-broker-v1.0.0` in `mcp-abap-adt-interfaces`). The split of fact 6 needs no further contract release (§8); it needs `auth-stores` 3.0.0 (§1.2).

### 1.1 `@mcp-abap-adt/interfaces-auth-broker` 1.0.0 (new) and `interfaces-auth-sap` 2.0.0 — published 2026-10-01

**The split (decided 2026-10-01).** `interfaces-auth-sap` 1.1.0 holds two
subjects: the SAP system and BTP (`ISapConfig`, `SapAuthType`, XSUAA,
`ICertificateMaterialLoader`, the UAA client `IAuthorizationConfig`, the header
validation types), which providers, connection and adt-clients use; and the
destination with its storage (`IConnectionConfig`, `IConfig`, `ISessionStore`,
`IServiceKeyStore`, `ITokenProviderResult`), which only the stores, the broker
and the server use. The second group is the broker's port — the broker states
what it needs from a destination and the stores implement it — so it moves to
a package named for it, `@mcp-abap-adt/interfaces-auth-broker` 1.0.0, which
depends on `interfaces-auth-sap` for `IAuthorizationConfig`.
`interfaces-auth-sap` 2.0.0 is the first group alone (removing exports is a
major; no re-export, decision 34). Nobody else moves: auth-providers takes
`IAuthorizationConfig` and `ISapConfig`, connection and adt-clients
`ISapConfig`, all of which stay.

`interfaces-auth-broker` 1.0.0 carries `IConnectionConfig` with a new type and
these optional fields — flat, as the SNC fields of 1.1.0 are, so a store
updates them field by field under its existing rules. All are destination
data; none is a function.

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
  trust and a grant all exist without a client secret, so none can live on
  `IAuthorizationConfig`, which requires one. The client itself stays where it
  is (§3.3). Under the split (fact 6) these fields are means: the key store
  answers them, the session store never holds them (§8).
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

### 1.2 `@mcp-abap-adt/auth-stores` 3.0.0 (major)

The broker reads only through the contract (H0); these changes make the file
stores take the roles of fact 6 — the session stores hold the secret, the key
stores answer the means.

1. **A session store holds the session secret and nothing else** —
   `authorizationToken`, `sessionCookies`, `expiresAt`, `refreshToken` — in
   `AbapSessionStore`, `SafeAbapSessionStore`, `XsuaaSessionStore`,
   `SafeXsuaaSessionStore` and `EnvFileSessionStore`.
   - **A session needs no `serviceUrl`.** Today every ABAP session must have
     one: a file without `SAP_URL` reads as no session
     (`auth-stores src/stores/abap/AbapSessionStore.ts:690-695`), a new session
     without it is refused (`:610-619`; `SafeAbapSessionStore.ts:82-85`), and
     `saveTokenToEnv` writes `SAP_URL` unconditionally (`src/storage/abap/tokenStorage.ts:117`;
     with `sapUrl` undefined the later `value.includes` would throw, `:188-193`
     — *inference* from the code, not run). The XSUAA stores take
     `defaultServiceUrl` instead (`XsuaaSessionStore.ts:326`, `:402`). In 3.0.0
     the URL is means and the session store neither requires nor answers it.
   - **A write carrying means is refused**, naming the fields (never a value):
     `serviceUrl`, `authType`, `grantType`, `username`, `password`, the `snc*`,
     `oidc*` and `saml*` fields, `sapClient`, `language`, and an
     authorization config's `uaaUrl` / `uaaClientId` / `uaaClientSecret`.
     Refused rather than dropped: a caller still on the 2.x roles (a 3.x
     broker's `persist`, `src/AuthBroker.ts:301-308`; `bin/mcp-auth.ts:890`;
     `bin/mcp-sso.ts:826`, `:845`) would otherwise lose what it wrote without
     a word. `setAuthorizationConfig` therefore always refuses (the contract's
     `IAuthorizationConfig` requires the client, `interfaces-auth-sap
     src/auth/IAuthorizationConfig.ts:7-11`), and `getAuthorizationConfig`
     answers `null`: a session holds no client.
   - **One secret kind at a time:** a token or cookies (with `expiresAt` and an
     optional refresh token). Writing one clears the other. That is a rule
     about which field was written, not an inference about the destination:
     the session store states no `authType` (it is means).
   - **The XSUAA session stores keep refusing a session without a token**
     (`XsuaaSessionStore.ts:138`, `SafeXsuaaSessionStore.ts:75-76`): an XSUAA
     session is a token, and the broker always writes the token with its
     refresh token (§6), so the refusal is correct and stays.
   - `expiresAt` (epoch ms) is kept with the token or cookies it belongs to
     (keys `SAP_EXPIRES_AT`, `XSUAA_EXPIRES_AT`), written and cleared with them.
2. **2.x files keep being read.** A 2.x `<destination>.env` holds means and
   secret together (`AbapSessionStore.ts:33-50`). It maps onto the split by
   key:

   | 2.x key (ABAP; the XSUAA stores' `XSUAA_*` keys alike) | Role in 3.0.0 | Read by |
   |---|---|---|
   | `SAP_JWT_TOKEN`, `SAP_SESSION_COOKIES_B64`, `SAP_REFRESH_TOKEN` (and the new `SAP_EXPIRES_AT`) | secret | the session store |
   | `SAP_URL`, `SAP_AUTH_TYPE`, `SAP_USERNAME`, `SAP_PASSWORD`, `SAP_SNC_*`, `SAP_UAA_URL`, `SAP_UAA_CLIENT_ID`, `SAP_UAA_CLIENT_SECRET`, `SAP_CLIENT`, `SAP_LANGUAGE` | means | not the session store; the destination store of item 4 (D6) reads them from the same file |

   The session store answers only the secret keys of such a file, and a write
   rewrites only those keys, preserving every other line — the env writer
   already keeps lines it does not set (`tokenStorage.ts:95-113`); what changes
   is that it no longer writes `SAP_URL` and `SAP_AUTH_TYPE` or clears the
   other types' credential keys (`:117`, `:124-154`). So a 2.x file stays a
   complete 2.x file after a 3.0.0 session write, and remains readable as means
   by the store of item 4.
3. **The service key stores answer the means their format holds, and say
   which grant only where the format can state it.**
   - `AbapServiceKeyStore` and `XsuaaServiceKeyStore` answer `authType: 'jwt'`
     from `getConnectionConfig`: the key holds an OAuth client and nothing else
     (`AbapServiceKeyStore.ts:87-110`, `XsuaaServiceKeyStore.ts:93-112`), and
     every grant that client alone serves (`authorization_code`,
     `client_credentials`, `passcode`) yields a token. A `saml2_bearer`
     destination also needs the IdP trust, which no service key holds, so it is
     stated elsewhere (item 4) and states `saml` there.
   - **No `grantType`: a SAP service key cannot state it.** The parsers read
     only `uaa.url`, `uaa.clientid`, `uaa.clientsecret` and `abap.url` /
     `client` / `language`, `sap_url`, `url` (`AbapServiceKeyStore.ts:87-110`,
     `:158-184`; `XsuaaServiceKeyStore.ts:93-112`, `:149-170`; no `grant` in
     any non-test source, `grep -rni grant src` outside `__tests__` finds nothing). The grants a
     client may use are declared on the XSUAA instance, in
     `xs-security.json`'s `oauth2-configuration` (SAP Help, *Application
     Security Descriptor Configuration Syntax*,
     `help.sap.com/docs/HANA_CLOUD_DATABASE/b9902c314aef4afb8f7a29bf8c5b37b3/6d3ed64092f748cbac691abc5fe52985.html`),
     not in the binding the key is. And a list of permitted grants would still
     not say which one this destination uses (*inference* from the shape of
     the problem: a client permitted `authorization_code` and
     `client_credentials` serves both). Answering a grant from a key would be
     choosing between alternatives by the key's shape — H1. So a destination
     whose means are a SAP service key alone is refused by `getProvider`,
     naming `grantType`, until something states the grant (item 4).
   - Both stop answering `authorizationToken: ''`
     (`AbapServiceKeyStore.ts:181`, `XsuaaServiceKeyStore.ts:165`): a token is
     secret, and a key store answers means only.
4. **A key store for a destination that has no SAP service key — an
   auth-stores question, not a broker one (decision D6).** Basic, SNC, OIDC,
   SAML, a `none` destination and a service key's missing grant all need
   somewhere to state means. **Recommendation:** auth-stores ships an
   `IServiceKeyStore` over `<dir>/<destination>.env` (working name
   `EnvDestinationStore`) that
   - reads every means field of `IConnectionConfig` and the client, under the
     2.x session key names plus `SAP_GRANT_TYPE`, `SAP_OIDC_*`, `SAP_SAML_*`
     (`XSUAA_*` likewise) — so a 2.x session file is already a readable
     destination (item 2);
   - keeps `uaaClientSecret: ''` and answers it as a public client — today
     `mcp-sso` writes `__public__` and strips the line afterwards
     (`bin/mcp-sso.ts:836-850`, `:911-920`), and the 2.0.0 session stores
     answer such a client's `getAuthorizationConfig` with `null` (measured
     2026-10-01, all four session stores);
   - may be given another `IServiceKeyStore` (a SAP service key store) to fall
     back to field by field, so `TRIAL.env` stating `SAP_AUTH_TYPE=jwt` and
     `SAP_GRANT_TYPE=authorization_code` completes `TRIAL.json`'s client and
     URL — the overlay is the store's rule, the broker sees one store (H0);
   - has a write method of its own, outside the contract (`IServiceKeyStore`
     is read-only, `interfaces-auth-broker src/serviceKey/IServiceKeyStore.ts:11-36`),
     which is what the CLI (§10) and the server (§12) write means through.

   It may point at the session store's directory — disjoint keys in one file,
   each store touching only its own — which keeps every existing path and 2.x
   file working with no move, or at a directory of its own when the secret
   should live apart. Recommended default: the same directory *(the
   concurrent-writer case — CLI and server writing one file at once — is
   inference, not measured; both write with an atomic rename,
   `tokenStorage.ts:203-207`)*. The broker is indifferent: it takes whatever
   `IServiceKeyStore` it is given.
5. **Version: 3.0.0.** Evidence that 2.1.0 would break consumers:
   - session stores refuse writes 2.0.0 accepted — the 3.x broker's `persist`
     spreads the connection config, `serviceUrl` and `authType` into
     `setConnectionConfig` (`src/AuthBroker.ts:301-308`) and the 3.x CLI writes
     the client into the session (`bin/mcp-auth.ts:890`, `bin/mcp-sso.ts:826`,
     `:845`, `bin/generate-env-from-service-key.ts:122`);
   - session reads stop answering what 2.0.0 answered — `serviceUrl`,
     `authType`, `username`, the client — which the 3.x broker reads from the
     session first (`src/AuthBroker.ts:264-285`, `:378-420`);
   - the service key stores stop answering `authorizationToken: ''` and start
     answering `authType`.
   The type compatibility check the plan had for 2.1.0 no longer decides
   anything; the contract move (`interfaces-auth-sap` → `interfaces-auth-broker`)
   rides in the same major.

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
the class's, not `interfaces-auth`'s. `connection` 10.0.2 has auth-providers
only as a dev dependency (`^5.0.1`, for its tests); its runtime dependencies
are `interfaces-auth` ^3.0.0 and `interfaces-auth-sap` ^1.1.0 among others, so
5.1.0 needs no connection release.

Neither the broker nor the CLI can be released before these three; §9 gives
the order.

## 2. The public surface

```ts
interface AuthBrokerConfig {
  sessionStore: ISessionStore;                                  // as 3.x; the session secret (§8)
  serviceKeyStore?: IServiceKeyStore;                           // as 3.x; the means (§8) — getProvider needs it (§4.4)
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
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>; // 3.x signature; sources per §3.3
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;       // 3.x signature; sources per §3.3
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
Both are means, so both come from the service key store's
`getConnectionConfig` and never from the session (§3.3). The pairs:

| `authType` | allowed `grantType` |
|---|---|
| `basic` | not read |
| `snc` | not read |
| `jwt` | `authorization_code`, `client_credentials`, `passcode`, `oidc_authorization_code`, `device_code`, `password`, `token_exchange`, `none` |
| `saml` | `saml2_pure`, `saml2_bearer`, `none` |

A `jwt` or `saml` destination that states no `grantType`, or a pair outside the
table, is a `DestinationConfigError` (§4.4). There is no broker-level grant and
no default: the grant is stated by the destination's key store, the reading of H1
the review settled. A SAP service key cannot state it (§1.2 item 3), so a
destination whose means are such a key alone is refused naming `grantType`
until a store states it (§1.2 item 4, D6). What a consumer must write so its destinations state it is
in §12 (the server) and §10 (the CLI).

**`none` is how a handed-over credential is stated.** A `jwt` destination with a
token and no way to renew it, or a `saml` destination with cookies negotiated
elsewhere (`mcp-sso saml2 --flow pure --cookie …`, `bin/mcp-sso.ts:31`), says
`grantType: 'none'` — not "no authorization config", which would be choosing by
what is absent.

### 3.2 A 3.x session that carries means

A session file written through 3.x holds means and secret together — the URL,
`SAP_AUTH_TYPE` (or none: auth-stores 2.x then reads the type by its 1.x
inference, `auth-stores CHANGELOG.md` 2.0.0 *Added*), basic's user and password,
the SNC fields, the client — beside the token, cookies and refresh token
(§1.2 item 2).

**Decision: the broker reads means only from the key store; it never falls
back to means a session store answers, not even for a 3.x file.** Why:

- **H1 — one stated source.** With a fallback, which store states a
  destination's `authType` and grant would depend on which one happens to hold
  the field — the broker would choose by presence, the thing §3.1 forbids, and
  would need a precedence rule of its own for a field both stores answer.
- **H0 — a legacy format is its store's business.** How a 2.x file maps onto
  the split is decided by the stores that read it (§1.2 item 2): auth-stores
  3.0.0's session store answers only its secret keys, and the destination
  store of §1.2 item 4 reads its means keys. A consumer that points both
  stores at a 3.x sessions directory gets every 3.x destination's means and
  secret with nothing moved. A database store migrating a column would be the
  same kind of decision, and just as invisible to the broker.
- **H4 — the split is what keeps the client secret out of the session.** A
  broker that read means from the session would make a session holding means
  legitimate again, and the rule would be back to a convention the broker
  enforces on its writes alone.

Consequences: a 3.x `basic` or `snc` file works unchanged once a key store
reads its means (§1.2 item 4). A 3.x `jwt` or `saml` file states no grant —
3.x never wrote one — so `getProvider` refuses it naming `grantType` until it is
stated: run the CLI command that produced it again (§10), or add
`SAP_GRANT_TYPE` by hand. No migration command is added: there is nothing to
move under the recommended store, and the grant is the one fact no tool can
recover from a 3.x file without inferring it. The token API with a consumer
`provider` keeps its 3.x reads (§9).

### 3.3 Where each field comes from

A destination is resolved by its name in both stores; both contracts key every
method by `destination: string` (`interfaces-auth-broker
src/serviceKey/IServiceKeyStore.ts:17`, `:25-27`, `:35`;
`src/session/ISessionStore.ts:19`, `:27`, `:41-51`).

- **The means — from the service key store only.** `getConnectionConfig` for
  `authType`, `grantType`, `serviceUrl`, `sapClient`, `language`, `username`,
  `password`, the `snc*`, `oidc*` and `saml*` fields; `getAuthorizationConfig`
  for the client (`uaaUrl`, `uaaClientId`, `uaaClientSecret`). A secret field a
  key store happens to answer (`authorizationToken`, `sessionCookies`,
  `expiresAt`, an authorization config's `refreshToken` — the 2.x service key
  stores answer `authorizationToken: ''`, `auth-stores
  src/stores/abap/AbapServiceKeyStore.ts:181`) is not read.
  `uaaUrl` is the authorization server's base URL (for OIDC grants, what
  `mcp-sso` writes there today: `--uaa-url`, else the token endpoint, else the
  issuer, `bin/mcp-sso.ts:836-850`); `uaaClientSecret: ''` is a public client
  and reaches the provider as no secret. `client_credentials`, `passcode`,
  `authorization_code` and `saml2_bearer` need `uaaUrl`; the OIDC grants need
  `uaaClientId` and take their endpoints from the `oidc*` fields.
- **The secret — from the session store only**, through `loadSession`, whose
  `IConfig` carries all four fields (`interfaces-auth-broker
  src/auth/IConfig.ts:9-10`): `authorizationToken` or `sessionCookies`,
  `expiresAt`, `refreshToken`. Means a session store answers (a 2.x store
  reading a 3.x file) are not read (§3.2). When there is no session the
  provider is built unseeded and obtains its first secret at `prepare()` by its
  grant (§4.1).
- **`getConnectionConfig` / `getAuthorizationConfig` on the broker** answer the
  same composition: the key store's means with the session's secret laid over
  them (the refresh token on the authorization config). In 3.x they answered
  the session's config whole and the key's only when the session had none
  (`src/AuthBroker.ts:378-420`) — a breaking change, §12.
- **Store reads** keep the 3.x rule: `null` or `FILE_NOT_FOUND` is absence, any
  other failure is thrown as the store raised it (`src/AuthBroker.ts:358-372`).

## 4. `getProvider(destination)` (H1, H2, H3)

### 4.1 What each destination gets

All classes are auth-providers 5.1.0 (5.0.1 plus the `saml2_pure` seed and the `expiresAt` fallback, §1.3). Every token provider gets
`onTokens` (§6) and the broker's logger.

**How a provider is built from the two stores** (fact 6, §3.3):

1. The **means** come from the service key store: `authType` and `grantType`
   choose the row, and the row's fields and the client are read there.
2. The **secret** comes from the session store when there is one — the
   *seed*: the stored `authorizationToken` (`accessToken`) or `sessionCookies`,
   its `expiresAt`, and the refresh token.
3. **No session** — the provider is built unseeded and logs in at `prepare()`
   by its grant (a client-credentials request, or a login through the
   consumer's collaborator); `onTokens` then writes the first secret (§6).
   `basic` and `snc` obtain no separate session secret, so their session holds
   nothing and is never read.
4. **Neither means nor secret** — `DestinationConfigError` (§4.4). A secret
   with no means is the same error naming `authType`: a session cannot state
   what the destination is.

"Destination data" in the table is means unless it says *seed*.

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
| `jwt` / `none` | `TokenAuthProvider.fixed(authorizationToken)` | seed: `authorizationToken` (the only way in, so required) | — |
| `saml` / `saml2_pure` | `Saml2PureProvider` | `samlIdpSsoUrl`, `samlSpEntityId`, `samlAcsUrl`, `samlRelayState`, `samlIdpEntityId`, `samlIdpInitiated`; the validator's `samlIdpCertificates`, `samlClockSkewMs`; seed (`sessionCookies` as `accessToken`, `expiresAt`) | `authorization(d, 'saml2_pure')`, `samlCookies(d)`, `assertionReplayStore(d)` |
| `saml` / `saml2_bearer` | `Saml2BearerProvider` | the same SAML fields; `samlTokenUrl`; client (`uaaUrl`, `uaaClientId`, `uaaClientSecret`); seed | `authorization(d, 'saml2_bearer')`, `assertionReplayStore(d)` |
| `saml` / `none` | `new SamlAuthProvider(sessionCookies)` | seed: `sessionCookies` (the only way in, so required) | — |

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
  `sncLib` from the key store is the locator's explicit candidate.
- **`none` is stated in the key store, its credential lives in the session.**
  The handed-over token or cookies is a session secret like any other; the
  key store states only `authType` and `grantType: 'none'` (and the URL). Such
  a destination without a session has no way in, so it is the §4.4 error
  naming the field, not an unseeded provider.

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

Thrown for: no `serviceKeyStore` option (named as the option — there is no
other source of means); no means for the destination (the key store answers
`null`), whether or not a session exists; no `authType`, or one outside the four; for `jwt`/`saml` no
`grantType`, or a pair outside §3.1; a field its row in §4.1 needs (`''`
counts as missing; `oidcIssuerUrl` or the explicit endpoints satisfy the OIDC
rows as the providers accept either); a collaborator its row needs (named by
option, e.g. `deviceCodePresenter`); a token provider's destination without
`serviceUrl` in its means (the 3.x rule, kept: a connector built from a
provider with nowhere to connect is the same startup fault). A provider
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

`persist` writes **the session secret and nothing else** (fact 6), under these
rules:

1. **One write, the whole secret.** `saveSession(destination, { <credential>,
   expiresAt, refreshToken })` — `IConfig` carries all four fields
   (`interfaces-auth-broker src/auth/IConfig.ts:9-10`; `saveSession` takes it,
   `src/session/ISessionStore.ts:27`). `<credential>` is `sessionCookies` for a
   `saml2_pure` result (`tokenType: 'saml'`) and `authorizationToken`
   otherwise — `saml2_bearer` included, since the session states no type.
   `expiresAt` is `ITokenResult.expiresAt`. `refreshToken` is the result's,
   else the one the session holds (re-read at write time), so a provider that
   returns none does not erase the stored one — the 3.x rule
   (`src/AuthBroker.ts:310-333`). The contract does not say whether
   `saveSession` merges into or replaces a session (`ISessionStore.ts:21-27`);
   writing the complete secret every time makes the result the same either
   way. `setAuthorizationConfig` is not used: its `IAuthorizationConfig`
   requires the client (`interfaces-auth-sap src/auth/IAuthorizationConfig.ts:7-11`),
   which is means.
2. **No means is ever written** — not `serviceUrl`, not `authType`, not the
   grant's data, not the client. 3.x spread the connection config, the URL and
   a derived `authType` into the session (`src/AuthBroker.ts:301-308`) and,
   when the session held a client, rewrote it with the refresh token
   (`:316-321`). **H4 now follows from the split:** the client secret is means,
   means live in the key store, and the broker never writes the key store —
   the contract gives it no way to (`IServiceKeyStore.ts:11-36` has only
   getters). The same holds for every other means secret (a password, a
   subject token).
3. **A `basic` or `snc` destination is never written.** Those destinations get
   providers that obtain nothing, and their session holds nothing (§4.1). The
   guard stays for the token API (§9): `persist` reads the destination's
   `authType` from the key store and refuses for `basic` or `snc`. The goal's
   "the session's `authType` is not overwritten" holds by construction — the
   broker writes no `authType` anywhere, and the type lives in a store it never
   writes.

A provider seeded with a stored JWT still reads `exp` itself; the stored
`expiresAt` serves the tokens that carry none — cookies above all (§1.3).

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

### 8.1 The split (decided by the user, 2026-10-01)

| Store | Holds | Implementations (the broker knows none) |
|---|---|---|
| `IServiceKeyStore` — the **means**: what is used to obtain a session secret | the client (`IAuthorizationConfig`: `uaaUrl`, `uaaClientId`, `uaaClientSecret`); `authType`, `grantType`; the authorization-code data; basic's `username` / `password`; `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName`; the `oidc*` fields; the SAML IdP trust and endpoints (`saml*`); `serviceUrl`, `sapClient`, `language` | a SAP service key file in a folder (§1.2 item 3), the destination store of §1.2 item 4, a database, something hand-written |
| `ISessionStore` — the **secret** that authorizes within a session | `authorizationToken`, `refreshToken`, `expiresAt`, `sessionCookies` | the session folder (§1.2 items 1–2), memory |

`basic` and `snc` obtain no separate session secret: their session holds
nothing. Both stores resolve a destination by its name (§3.3).

### 8.2 The contract carries it as it is — verified

Checked against `interfaces-auth-broker` 1.0.0 (`6165673`) and
`interfaces-auth-sap` 2.0.0:

- **Both stores answer `IConnectionConfig`** — the key store filled with means
  (`src/serviceKey/IServiceKeyStore.ts:35`), the session store with the secret
  (`src/session/ISessionStore.ts:51`). One shape, two roles: every means field
  and the two credential fields are optional members of it
  (`src/auth/IConnectionConfig.ts:7-84`).
- **Every means field is reachable through `IServiceKeyStore`'s methods:**
  `authType` (`IConnectionConfig.ts:20`), `grantType` (`:22`), `serviceUrl`
  (`:9`), `username` / `password` (`:13`, `:15`), `sapClient` / `language`
  (`:29`, `:31`), the SNC fields (`:38-44`), the OIDC fields (`:50-64`), the SAML
  fields (`:68-83`) — through `getConnectionConfig` (`IServiceKeyStore.ts:35`);
  the client through `getAuthorizationConfig` (`:25-27`), whose
  `IAuthorizationConfig` is `uaaUrl`, `uaaClientId`, `uaaClientSecret`,
  `refreshToken?` (`interfaces-auth-sap src/auth/IAuthorizationConfig.ts:5-14`).
- **Every secret field is reachable through `ISessionStore`:** `loadSession`
  returns `IConfig` (`ISessionStore.ts:19`), which is
  `Partial<IAuthorizationConfig> & Partial<IConnectionConfig>`
  (`src/auth/IConfig.ts:9-10`) and so carries `authorizationToken`,
  `sessionCookies`, `expiresAt` and `refreshToken` together; `saveSession`
  takes the same (`ISessionStore.ts:27`).
- **`IServiceKeyStore` is read-only:** three getters, no setter
  (`IServiceKeyStore.ts:11-36`). The broker never writes it; writing means is
  a store implementation's own API (§1.2 item 4), used by the CLI and the
  server, never by the broker.
- **Renewal write-back** needs `saveSession` alone (§6 rule 1).

So no contract release is needed for the split.

### 8.3 Where the contract is thinner than the broker's use — open, for the user

None of these blocks the design; each is a place where the contract carries
what the broker needs only by convention, recorded rather than fixed:

1. **A client with no secret, or no UAA URL.** `IAuthorizationConfig` requires
   `uaaUrl`, `uaaClientId` and `uaaClientSecret` as strings
   (`IAuthorizationConfig.ts:7-11`). A public client is `uaaClientSecret: ''`
   and an OIDC client whose endpoints are all in the `oidc*` fields still needs
   some `uaaUrl` (§3.3 says what `mcp-sso` writes there). The type carries both
   only through the empty-string convention; a store that, like the 2.x ones,
   answers `null` for an empty field (`auth-stores AbapSessionStore.ts:353-362`)
   loses the client.
2. **`saveSession`'s merge-or-replace semantics are unstated**
   (`ISessionStore.ts:21-27`). §6 writes the complete secret each time so the
   outcome does not depend on it.
3. **The doc comments still describe the 2.x roles** — "Service keys contain
   UAA credentials and connection URLs" (`IServiceKeyStore.ts:3-4`), "session
   data (tokens, configuration)" (`ISessionStore.ts:4`), "A store states it for
   every destination that holds a credential or a grant" on `authType`
   (`IConnectionConfig.ts:17-19`). The types are sufficient; the words would
   mislead a store author. A documentation-only patch of
   `interfaces-auth-broker` would state the split — *(proposal; not part of
   this plan unless the user asks)*.

Certificates are out of scope (goal, open 4): no field is added for them.

## 9. The token API keeps 3.x (H5)

| 3.x behaviour (tested in `src/__tests__/broker/AuthBroker.test.ts`) | 4.0 |
|---|---|
| `getToken` asks `getTokens()`, `refreshToken` asks `refreshTokens()` — never the cached token | unchanged |
| a factory is seeded with `(destination, authConfig \| null, { ...conn, serviceUrl })`; the session's credentials win over the key's; the stored refresh token is passed | unchanged reads and signature (below: with a consumer `provider` the 3.x reads stay — H5 outranks §3.2); a 3.0.0 session store answers no client, so the key store's is what is found |
| one provider per destination from a factory; an instance for every destination; a factory that threw is retried | unchanged; the §7 cache |
| `serviceUrl` from the session, else the service key, else an error before the provider is asked | unchanged reads; a 3.0.0 session store answers none, so the key store's is what is found |
| the result is written, a SAML result as cookies; the refresh token only when the result has one; no client secret | unchanged in what a caller observes; what is written is the secret alone (§6) — no `serviceUrl`, no `authType`, no client — so the 3.x tests asserting those extra fields in the session change with §6 |
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

**With a consumer `provider`, the token API reads as 3.x did.** H5 holds the
token API to its 3.x behaviour, so its reads keep the 3.x order — the session
first, then the key store, for the client and `serviceUrl` — rather than the
means-only rule of §3.2, which governs `getProvider`. Under auth-stores 3.0.0
the session store answers neither, so in practice the key store is read; a
consumer's own session store that still answers means keeps working as in 3.x.
The writes follow §6 (the secret alone): every value 3.x wrote beyond the
secret was one it had just read from a store, so a store that answered it
still answers it. calm-server shows the cost of the old writes: it wraps its
session store so that the `serviceUrl` 3.x writes back never lands in the
user's session (`calm src/server/auth/targetUrlSessionStore.ts:12-19`).

**Design decision — a `basic` or `snc` destination has no token API.** The goal
says the session's `authType` is not overwritten; 3.x asked the provider and
wrote `jwt` over whatever the session said (`src/AuthBroker.ts:302-308`). So the
token API reads the destination's `authType` from the key store first and, for
`basic` or `snc`, throws `DestinationConfigError` before any provider is asked.
A destination whose key store states no `authType` (a 3.x setup with a consumer
`provider`) is served as in 3.x. Every other 3.x path is as the table says.

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
- **It writes a complete 4.0 destination: means to a key store, the secret to
  the session store.** Each run first writes the destination's means —
  `authType`, `grantType` and the grant's data — to the key store
  implementation, through that store's own write method (the contract is
  read-only, §8.2); under the recommendation of §1.2 item 4 (D6) that is
  auth-stores' destination store, in the directory the CLI writes its session
  to today, so the paths a user and the server know do not change. The login
  then runs through the broker, and the secret it obtains reaches the session
  store as any other (§6). 3.x wrote the client into the session
  (`bin/mcp-auth.ts:890`, `bin/mcp-sso.ts:826`, `:845`); 4.0's session store
  refuses that (§1.2 item 1).

  | Command | `authType` / `grantType` | Means written to the key store | Secret (session store) |
  |---|---|---|---|
  | `mcp-auth` | `jwt` / `authorization_code` | client, `serviceUrl` (as today) | token, refresh token, `expiresAt` |
  | `mcp-auth --credential` | `jwt` / `client_credentials` | client | token, `expiresAt` |
  | `mcp-sso oidc --flow browser` | `jwt` / `oidc_authorization_code` | `oidcIssuerUrl`, endpoints, `oidcScopes`, client | token, refresh token, `expiresAt` |
  | `mcp-sso oidc --flow device` | `jwt` / `device_code` | same | same |
  | `mcp-sso oidc --flow password` | `jwt` / `password` | `username`, `password`, `oidcTokenEndpoint`, … | same |
  | `mcp-sso oidc --flow password --passcode` | `jwt` / `passcode` | client (today this is the password grant with username `passcode`, `bin/mcpSsoConfig.ts:471-486`; a one-time code cannot log in twice) | same |
  | `mcp-sso oidc --flow token_exchange` | `jwt` / `token_exchange` | `oidcSubjectToken`, types, audience, … | same |
  | `mcp-sso saml2 --flow pure` | `saml` / `saml2_pure` | every `saml*` field `applySamlMetadata` resolved | cookies, `expiresAt` |
  | `mcp-sso saml2 --flow pure --cookie …` | `saml` / `none` | `authType`, `grantType`, `serviceUrl` only | the cookies the user handed over |
  | `mcp-sso bearer` | `saml` / `saml2_bearer` | `saml*` fields incl. `samlTokenUrl`, client | token, refresh token, `expiresAt` |

  The means secrets (`password`, subject and actor tokens, a client secret the
  user gave) are written by the CLI because the user asked it to produce a
  destination that can renew; the broker never writes them (H4, §6 rule 2). A
  public client is written with `uaaClientSecret: ''` (§1.2 item 4) instead of
  today's `__public__` stripped afterwards. The handed-over cookies of the
  `--cookie` row are a secret the user gave the CLI to store: the CLI writes
  them to the session store itself, since no provider obtains them.
- `mcp-auth` keeps injecting its own provider into the broker (the token API
  path, §9) — its browser, port and timeout flags are its own.

**Dependencies:** `@mcp-abap-adt/auth-broker` ^4.0.0, `@mcp-abap-adt/auth-stores`
^3.0.0, `@mcp-abap-adt/auth-providers` ^5.1.0, `@mcp-abap-adt/interfaces-auth`
^3.0.0, `@mcp-abap-adt/interfaces-auth-sap` ^2.0.0, `@mcp-abap-adt/interfaces-auth-broker` ^1.0.0, `@mcp-abap-adt/interfaces-utils`
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

**Release order.** `interfaces-auth-sap` 2.0.0 and `interfaces-auth-broker` 1.0.0 — done, published 2026-10-01 in one run of the interfaces repository's `release:publish`; then `auth-stores` 3.0.0 and `auth-providers` 5.1.0 (§1; the last depends on neither).
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
  `interfaces-auth-sap`, `interfaces-auth-broker`, `interfaces-utils`, `auth-providers`;
  `auth-broker-cli` → the §10 list. H0's "the library never imports
  auth-stores" becomes a check.
- **`check-graph.js` is adapted, not copied.** The interfaces version walks
  every file under a package's `src` (`mcp-abap-adt-interfaces
  tools/check-graph.js:54`) and compares imports with `dependencies` only;
  there `src` holds no tests. Here `src/__tests__` imports dev dependencies
  (`auth-stores`, `auth-providers`, later `connection` and `sap-rfc-lite`). So
  the allowlist and the declared-and-used rules apply to the non-test files
  and `dependencies`; a file under `__tests__` may import what the package
  declares in `devDependencies` (or `dependencies`), and nothing undeclared.
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
   `@mcp-abap-adt/interfaces-auth-sap` ^2.0.0, `@mcp-abap-adt/interfaces-auth-broker`
   ^1.0.0, `@mcp-abap-adt/auth-providers` ^5.1.0. Types from `interfaces-auth` 2.x no longer mix.
3. **`@mcp-abap-adt/auth-stores` is no longer a dependency** (H0); a consumer
   that imported it without declaring it must declare it.
4. **The token API refuses a destination stated `basic` or `snc`** (§9).
5. `axios` leaves the dependencies (nothing in `src/` or `bin/` imports it).
6. **The session gets the secret alone** (§6): no `serviceUrl`, `authType` or
   client is written to it any more, by `getProvider`'s providers or by the
   token API.
7. **`getProvider` takes means only from the service key store** (§3.2, §3.3):
   a destination whose means only a session answers is a
   `DestinationConfigError`.
8. **`getConnectionConfig` / `getAuthorizationConfig` compose** the key store's
   means with the session's secret (§3.3) instead of answering the session's
   config whole.
9. **auth-stores 3.0.0** is what the broker's own tests run against (§1.2); a
   consumer on auth-stores 2.x keeps its session stores answering means, which
   `getProvider` ignores (item 7).

Additive: `getProvider`, `DestinationConfigError`, the collaborator options,
`provider` optional.

**Migration notes:**

- **The server (goal step 5).** Build the connector from
  `await broker.getProvider(destination)`; delete the per-auth-type
  `connectionParams`, the `getToken` call before connecting and the
  `tokenRefresher` (`BaseMcpServer.ts:112-205`, `:316-334`, `utils.ts`
  `getManagedConnection`). Construct the broker without `provider`, with
  `authorization: () => browserCallbackStrategy({ browser, port })` (and the
  other collaborators for the grants it serves). **Its stores:** a key
  store for the means — under D6, auth-stores' destination store over the
  sessions directory, falling back to the service key store for the client and
  URL — and the session store for the secret. **What it must write:** instead
  of seeding sessions from service keys (`brokerFactory.ts:490-598`), it writes
  `authType: 'jwt'` and `grantType: 'authorization_code'` — what
  `createTokenProviderForDestination` always chose — as means, through the
  destination store's write method; nothing is written to the session before
  the first login. A `.env` a user wrote by hand (`--env`) is means, read by
  the destination store (§1.2 item 4), and for a `none` destination also holds
  the token, read by `EnvFileSessionStore` as the secret: it must state
  `SAP_GRANT_TYPE` (`none` for a token alone); `getProvider` names it when it
  is missing. `broker.getConnectionConfig` gives the connector its URL and
  client, composed from both stores (§3.3). Its docs install `@mcp-abap-adt/auth-broker-cli` for `mcp-auth`
  (`README.md:367`, `docs/installation/INSTALLATION.md:53,83,292`,
  `docs/user-guide/AUTHENTICATION.md:47`).
- **calm-server (token API).** Bump the broker, auth-providers 5 and the
  contracts together. `TokenProviderFactory`, `refuseLogin` and
  `createTokenRefresher` work unchanged; its `mcp-auth` hints name the new
  package. Its `TargetUrlSessionStore` exists only to keep the `serviceUrl` 3.x
  wrote back out of the user's session (`calm
  src/server/auth/targetUrlSessionStore.ts:12-19`); with §6 nothing is written
  back, and `CALM_BASE_URL` becomes means it can answer from a key store
  *(inference — calm's change is calm's to design)*. If it moves to
  auth-stores 3.0.0 it needs a key store for the client the 3.x `mcp-auth`
  wrote into its sessions (§1.2 item 2).
- **People who `npm i -g @mcp-abap-adt/auth-broker` for `mcp-auth`:**
  `npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli`.
  Commands and flags are the same. A session file written by 3.x carries means
  and secret together: under D6's destination store pointed at the same
  directory its means are read as they are, and a `basic` or `snc` one works
  unchanged; a `jwt` or `saml` one needs `grantType` — run the command that
  produced it again, or add `SAP_GRANT_TYPE` (§3.2). The token API with a
  consumer `provider` serves it as in 3.x (§9).

## 13. Testing

**Unit (`packages/auth-broker`; stores as in-memory fakes of the contract,
providers real, token endpoints local):**

- the split (§3.2, §3.3): means are read from the key store only — a session
  fake that also answers `authType`, `grantType`, a client or `username` is
  ignored, and a destination whose means only the session answers is a
  `DestinationConfigError` naming `authType`; the secret is read from the
  session only — a key store answering `authorizationToken` is not used as a
  seed; no session → the provider is unseeded and logs in at `prepare()`
  (client credentials against a local endpoint); a `none` destination without
  a session is the error naming its field; the key store fake has no write
  method, and a spy proves the broker never calls one;

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
  the provider `getProvider` returned is in the session store afterwards, and
  what was written is **exactly** the secret — the field set of the
  `saveSession` call is `{ authorizationToken | sessionCookies, expiresAt,
  refreshToken }`: no client secret (H4), no `serviceUrl`, no `authType`, no
  grant data; a result without a refresh token carries the stored one forward;
  a `saml2_bearer` token is written as a token, `saml2_pure` cookies as
  cookies; nothing is written for a `basic` / `snc` destination; `onTokens`'
  write failure surfaces from `getToken`;
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

**Load-bearing:** each rule is broken once on purpose (`persist` writing one
means field — `serviceUrl`, then `authType`, then the client secret, one at a
time; a fallback to means the session answers; the stored refresh token not
carried forward; the `basic`/`snc` guard; the promise cache; the broker's own
retry of a failed write; the pair table) and its test must go red, then
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
  deleted as of its 52.0.0 — they name `interfaces-auth-broker` for the store
  contracts (`IConnectionConfig`, `IConfig`, `ISessionStore`,
  `IServiceKeyStore`) and `interfaces-auth-sap` for `IAuthorizationConfig` and
  `AuthType` (`src/index.ts:10`), the only two that stayed there.
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
| built from the configuration the destination states (`authType`) | §3.1, §3.3 (means from the key store), §8.1 |
| `basic` → `BasicAuthProvider(username, password)` | §4.1 |
| `jwt` → a token provider seeded from the session and the service key, as today's factories do | §4.1 (every grant today's factories and `mcp-sso` use: UAA code, client credentials, passcode, the four OIDC grants; the service key's means, the session's secret as seed), §3.3 |
| `saml` → the SAML providers (cookies or bearer), as `mcp-sso` configures them | §4.1 (`saml2_pure`, `saml2_bearer`, the validator and `mcp-sso`'s wiring; `none` for cookies handed over), §1.1 |
| `snc` → `SncLogonProvider` from the four SNC fields | §4.1 |
| persistence moves to `onTokens`; a renewal the connector triggers is written back | §6 (the secret alone, retried, `flush()`), §13 |
| no implicit defaults: strategy, presenter, SAML validator and replay store, SNC locator and probes explicit | §5 (strategies, presenter, cookie function, replay store), §4.1 (validator composed from data + replay store; SNC recipe) |
| the commands move to `@mcp-abap-adt/auth-broker-cli`; the interfaces layout; `release:publish` | §10, §11 |
| the CLI on explicit collaborators: presenter, `assertionValidator`, `read(prompt, signal)` | §10 |
| dependencies: auth-providers ^5.1.0, interfaces-auth ^3.0.0, interfaces-auth-sap ^2.0.0, interfaces-auth-broker ^1.0.0; auth-stores only as a dev dependency of the library | §12 item 2, §1.3 (auth-providers 5.1.0), §1.1 (the interfaces releases), §11 `check-graph` |
| the session's `authType` is not overwritten | §6 rules 2 and 3 (the broker writes no `authType` anywhere; the type is means, in a store the broker never writes), §9 |
| *Stays:* the stores and their contracts; no client secret in the session; the token API and `createTokenRefresher`; injecting a provider or a factory | §8.2 (the contract carries the split as it is — no change), §6 rule 2 (no client secret: it is means, and the session gets the secret alone), §9, §4.3 |

**Holds:**

| Hold | Met by |
|---|---|
| H0 the broker speaks only the store contracts | §3.3, §8.2 (every means field reachable through `IServiceKeyStore`, every secret through `ISessionStore`), §1.1, §1.2 (stores implement the split; a 2.x file's mapping is the store's), §3.2, §11 `check-graph` |
| H1 the configuration states the provider; nothing inferred | §3.1 (`authType` + `grantType` from the key store, no broker-level grant, `none` stated), §3.2 (one source, no fallback by presence), §1.2 item 3 (a SAP key states no grant rather than one inferred) |
| H2 no implicit defaults | §5, §4.1, §4.4 (a missing collaborator is an error, never a default) |
| H3 what a provider obtains reaches the session store | §6, §4.3, §13 |
| H4 no secret the broker was not given to store | §6 rule 2 (follows from the split: the broker writes only the session secret, never the read-only key store), §10 (the CLI's own writes of means), §13 |
| H5 the token API keeps its 3.x behaviour | §9 |
| H6 measured: basic, token, SNC through a connection 10 connector | §13 *Live* |

| Goal open question | Answer |
|---|---|
| 1 strategy | §5 — per destination, from functions given to the broker; headless passes refusing ones |
| 2 grant | §3.1 — stated by the destination's `grantType`, the full set of §1.1 |
| 3 caching | §7 — one provider per destination, shared, promise-cached |
| 4 certificates | out of scope, as decided |
| 5 contract | §1.1, §8 (the split; sufficient as is; what a store accepts back on renewal is the secret alone, §6) |
