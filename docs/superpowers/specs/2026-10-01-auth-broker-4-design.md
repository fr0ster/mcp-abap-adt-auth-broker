# auth-broker 4.0.0 and auth-broker-cli 1.0.0 — design

**Answers to:** `docs/superpowers/2026-09-30-auth-broker-4-goal.md`. Every
section names the goal's *Holds throughout* rules it serves (H0–H6). Where this
spec could not stay inside a hold, or inside the goal's text, it says so in §14
as a **proposed goal change**, for review before the plan — nothing below
departs from the goal silently.

**Status:** draft for review in #33.

**Evidence.** A claim tagged `file:line` was read in the code named. Paths
without a repository prefix are this repository at `e88c652`; others are
`auth-providers` (5.0.1, `1cf6767`), `connection` (10.0.2, `b859607`),
`auth-stores` (2.0.0, `2a7fc4b`), `interfaces` (`interfaces-auth` 3.0.0 /
`interfaces-auth-sap` 1.1.0, `160a0e6`), `server` (`mcp-abap-adt`, `ec208a87`)
and `calm` (`mcp-calm-server`). Anything tagged *(inference)* was not verified.

## 0. What shaped this design

Five facts, each of which decided something below:

1. **The library has no provider factory of its own.** 3.x takes a provider
   instance or a `TokenProviderFactory` from the consumer and builds nothing
   (`src/AuthBroker.ts:45-66`, `:196-222`). "Today's factories" are the
   consumers': the server always builds `AuthorizationCodeProvider`
   (`server src/lib/auth/brokerFactory.ts:884-891`); calm-server chooses by its
   own config field `authFlow` (`calm src/server/auth/buildBroker.ts:112-125`,
   `src/server/config.ts:35`); `generate-env-from-service-key` chooses
   client credentials when the key's URL contains `authentication`
   (`bin/generate-env-from-service-key.ts:80-83`, `:134-145`) — exactly the
   inference H1 forbids; `mcp-auth` chooses by its `--credential` flag
   (`bin/mcp-auth.ts:862-881`).
2. **`onTokens` is best effort.** `BaseTokenProvider` awaits it after every new
   token and swallows its failure (`auth-providers src/providers/BaseTokenProvider.ts:362-375`).
   3.x `getToken` lets a store failure reach its caller (`src/AuthBroker.ts:186-193`,
   `:295-345`). §8 keeps the latter for the token API.
3. **The store contract has no field for the grant**, and
   `IAuthorizationConfig` requires `uaaClientSecret`
   (`interfaces packages/interfaces-auth-sap/src/auth/IAuthorizationConfig.ts:5-14`) —
   so a grant stated there would drag the secret into every session (H4).
4. **Only the ABAP session stores state `authType`.** `XsuaaSessionStore`,
   `SafeXsuaaSessionStore` and both service key stores never set it
   (`auth-stores src/stores/**` — `grep authType` hits only `abap/*SessionStore.ts`
   and `env/EnvFileSessionStore.ts`).
5. **A SAML provider that renews cannot be built from a store.**
   `Saml2PureProvider` needs a `cookieProvider` function
   (`auth-providers src/providers/Saml2PureProvider.ts:34`) and both SAML
   providers an `IAssertionValidator` built from IdP certificates
   (`src/providers/saml2Utils.ts:55`); `IConnectionConfig` carries neither
   (`interfaces-auth-sap src/auth/IConnectionConfig.ts:5-33`).

## 1. The public surface

```ts
interface AuthBrokerConfig {
  sessionStore: ISessionStore;                                  // as 3.x
  serviceKeyStore?: IServiceKeyStore;                           // as 3.x
  /** The token source for `jwt` destinations — as 3.x, now optional. */
  provider?: IRefreshableTokenProvider | TokenProviderFactory;  // TokenProviderFactory unchanged
  /** The interactive login for an `authorization_code` destination the broker builds. */
  authorization?: (destination: string) => IAuthorizationStrategy<string>;
  /** The grant for a `jwt` destination whose configuration states none (§3.2). */
  grantType?: TokenGrant;
}
type TokenGrant = 'authorization_code' | 'client_credentials';

class AuthBroker {
  constructor(config: AuthBrokerConfig, logger?: ILogger);       // logger as 3.x
  getProvider(destination: string): Promise<IAuthProvider>;      // new
  getToken(destination: string): Promise<string>;                // 3.x
  refreshToken(destination: string): Promise<string>;            // 3.x
  createTokenRefresher(destination: string): ITokenRefresher;    // 3.x
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>; // 3.x
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;       // 3.x
}

class DestinationConfigError extends Error {
  readonly code = 'DESTINATION_CONFIG';
  readonly destination: string;
  readonly missingFields: string[];   // field names only, never a value
  readonly cause?: unknown;           // a provider constructor's ValidationError, when that is what failed
}
```

`IAuthProvider` is not re-exported: the consumer takes the contract from
`@mcp-abap-adt/interfaces-auth`, as `connection` 10 decided for itself
(`connection src/index.ts:11-14`). The 3.x re-exports stay. The broker logs no
token and writes nothing to `process.stdout`.

## 2. `getProvider(destination)` (H1, H2)

### 2.1 What each `authType` gets

The broker reads the destination's **stated** `authType` (§3.1) and builds:

| `authType` | Provider (auth-providers 5.0.1) | Built from | Collaborators | Persists |
|---|---|---|---|---|
| `basic` | `new BasicAuthProvider(username, password)` | `IConnectionConfig.username`, `.password` | none | nothing |
| `snc` | `SncLogonProvider.forSecureLoginClient({ partnerName, qop, sncLib, myName, logger })` | `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName` | the recipe's: `DefaultSncLibraryLocator(nodeSncSystem(), sncLib)`, `[SecureLoginClientProbe]` (`auth-providers src/snc/SncLogonProvider.ts:106-121`) | nothing |
| `saml` | `new SamlAuthProvider(sessionCookies)` | `IConnectionConfig.sessionCookies` | none | nothing |
| `jwt`, grant `authorization_code` | `new AuthorizationCodeProvider({ uaaUrl, clientId, clientSecret, refreshToken, accessToken, authorization, onTokens, logger })` | authorization config (§2.2), the session's `authorizationToken` | `config.authorization(destination)` | `onTokens` (§5) |
| `jwt`, grant `client_credentials` | `new ClientCredentialsProvider({ uaaUrl, clientId, clientSecret, onTokens, logger })` | authorization config | none | `onTokens` |
| `jwt`, no authorization config anywhere | `TokenAuthProvider.fixed(authorizationToken)` | the session's token | none | nothing |
| `jwt`, consumer passed `provider` | `TokenAuthProvider.from(this.createTokenRefresher(destination))` | the consumer's provider, through the token API | the consumer's | the token API (§8) |

- **The consumer's `provider` wins for `jwt`.** It is how a consumer that
  "builds its own" (goal, *Stays*) says so; wrapping it in the broker's own
  token API means every renewal the connector triggers goes through the same
  persist as `getToken` (H3) and through the same provider cache — one token
  source per destination, not two (§6).
- **`saml` is a session handed over, not renewed** — fact 5. A refused session
  is `SamlAuthProvider`'s Oops "the SAML session was refused or has expired —
  obtain a new SAML session" (`auth-providers src/credentials/SamlAuthProvider.ts:33-40`).
  This narrows the goal; see §14 G1. A `provider` given to the broker is not
  used for `saml` destinations by `getProvider` (it still serves the token API).
- **`TokenAuthProvider.fixed` is not an inference.** With no authorization
  config there is no grant to choose between; the stored token is all the
  destination holds, which is what the server does today when `getToken` fails
  (`server src/embeddable/BaseMcpServer.ts:112-127`). A refused fixed token is
  Oops "the token was refused — obtain a new token".
- **SNC uses the named recipe.** It composes every collaborator explicitly
  (auth-providers rule 7 allows a static factory to assemble "a named, common
  recipe"), and `sncLib` from the store reaches the locator as the explicit
  candidate. A consumer needing another SNC product builds its own
  `SncLogonProvider` and hands it to the connector; the broker has nothing to
  persist for it.
- The broker's logger is passed to every provider it builds.

### 2.2 Where the fields come from

- **Connection fields** (`authType`, `grantType`, `username`, `password`,
  `sncPartnerName`…, `sessionCookies`, `authorizationToken`, `serviceUrl`): the
  session's `getConnectionConfig`, each field falling back to the service key
  store's `getConnectionConfig` only where the session does not have it (the
  3.x rule for `serviceUrl`, `src/AuthBroker.ts:264-285`).
- **Authorization config** (`jwt` only): the 3.x resolution, unchanged — the
  session's own `IAuthorizationConfig`, else the service key's with the refresh
  token the session stored through `loadSession` (`src/AuthBroker.ts:231-262`).
- **Store reads** keep the 3.x rule: `null` or `FILE_NOT_FOUND` is absence, any
  other store failure is thrown as the store raised it (`src/AuthBroker.ts:358-372`).

### 2.3 A destination that lacks what its type needs: `getProvider` throws

**Decision:** `getProvider` throws `DestinationConfigError` naming the
destination and the missing fields — never a value. It never returns a provider
whose `prepare()` refuses a configuration.

- Rule 1 of auth-providers ("no exception crosses the contract") binds the four
  `IAuthProvider` methods. `getProvider` is not one; it is the broker's, and
  the broker already throws on configuration before any provider is asked
  (3.x: a missing `serviceUrl`, `src/AuthBroker.ts:278-283`).
- A missing field is a fault no renewal cures. A provider built only to refuse
  would be a credential the destination does not have — its `kind` would name
  nothing real — and the fault would surface at the first `connect()` instead
  of where the server builds its connector at startup, which is where calm
  already fails on missing UAA credentials (`calm buildBroker.ts:103-109`).
- Runtime conditions are **not** configuration and stay the provider's:
  no token yet, an expired refresh token, a login the strategy refuses — all
  answered by `prepare()` / `rejected()` as Oops.

Thrown when: no `authType` is stated or it is not one of the four; `basic`
without `username` or `password` (`''` counts as missing); `snc` without
`sncPartnerName`; `saml` without `sessionCookies`; `jwt` with an authorization
config that lacks `uaaUrl` / `uaaClientId` / `uaaClientSecret`, or states no
grant and the consumer gave no `grantType`; `jwt` with neither an authorization
config nor a token; `authorization_code` without the `authorization` option
(named `authorization`, a broker option); a token provider's destination
without `serviceUrl` (the 3.x token-API rule, kept because persistence writes
it). A provider constructor's `ValidationError` (an `sncQop` outside
`1|2|3|8|9`, `auth-providers src/snc/SncLogonProvider.ts:90-96`) becomes a
`DestinationConfigError` naming the store field (`sncQop`), with the original
as `cause`.

## 3. The destination states the provider (H1)

### 3.1 `authType`

`getProvider` reads `authType` and nothing else to decide the type. It never
looks at which fields are present.

**A 3.x session without `SAP_AUTH_TYPE`** is read by `auth-stores` 2.0.0
by its 1.x inference (cookies → `saml`, username and password with an empty
token → `basic`, token → `jwt`; `auth-stores CHANGELOG.md` 2.0.0 *Added*).
**Decision: that is the store's answer, not the broker's inference.** H0 makes
the contract the broker's whole view of storage: `authType` arrives through
`IConnectionConfig`, and how a file store derives it from its own legacy format
is that store's business — the same way a database store would read a column.
The broker adds no rule of its own on top. SNC, the one type a shape could
confuse, is never inferred by the store either.

A store that answers no `authType` is refused (§2.3). Fact 4 means that today
covers the XSUAA session stores and both service key stores — fixed in the
stores (§7), not by a broker fallback.

### 3.2 Which provider for a token destination (goal open 2)

**Recommendation:** the destination states its grant in a new optional field
`IConnectionConfig.grantType?: 'authorization_code' | 'client_credentials'`
(`interfaces-auth-sap` 1.2.0, §7). The broker takes the first of:

1. the destination's `grantType` (session, then service key);
2. `AuthBrokerConfig.grantType`, which the consumer states once for every
   destination that states none;
3. neither → `DestinationConfigError` (`grantType`) — for a destination that has
   an authorization config; without one it is `TokenAuthProvider.fixed` (§2.1).

Why this shape:

- **On `IConnectionConfig`, not `IAuthorizationConfig`** — fact 3. The grant is
  the same question as `authType` (which provider), and it sits beside it.
- **The broker option is the consumer's statement, not a default.** Absent, the
  broker chooses nothing. It is the form calm-server already has (`authFlow`
  in its own config), and it lets the server state "authorization code" for the
  sessions it seeds without every session file being rewritten first. Whether
  this counts as "the destination's configuration" under H1 is for review:
  §14 G4 gives the stricter alternative.
- **Two grants only.** They are the two the stores can serve (UAA
  credentials plus a refresh token). The OIDC and SAML-bearer grants need
  issuer and IdP configuration the contract does not carry; a destination
  produced by them (`mcp-sso oidc`, `mcp-sso bearer`) is a `jwt` session with
  no `grantType`, and `getProvider` refuses it when it holds an authorization
  config. A consumer serving such sessions passes its own `provider`.

## 4. The interactive strategy (H2; goal open 1)

**Recommendation: per destination, supplied per broker** —
`authorization: (destination) => IAuthorizationStrategy<string>`, a constructor
option, called once when the broker builds the destination's
`AuthorizationCodeProvider`.

- **Not per call.** `getProvider` is cached (§6): a strategy passed on a call
  would take effect on the first call only.
- **Not one instance per broker.** A browser strategy holds one port and
  rejects an overlapping `authorize` (`auth-providers src/strategies/BrowserCallbackStrategy.ts:112-116`),
  and a process may want different strategies per destination. A function
  covers both: returning the same instance is allowed and serialises logins by
  that rule.
- **Lifecycle: whoever constructs, disposes** (auth-providers' rule). The
  consumer's function constructs; the broker never disposes a strategy, and
  neither does the provider (`AuthorizationCodeProvider` takes it as given).
- **Required only where needed.** Absent, an `authorization_code` destination is
  a `DestinationConfigError`; `basic`, `snc`, `saml`, `client_credentials` and
  a consumer's `provider` need none. There is no broker default (H2).
- **A headless process passes a strategy that refuses**, e.g.
  `() => ({ authorize: async () => { throw new LoginRequiredError(…) } })` —
  calm-server's `refuseLogin` is exactly this (`calm buildBroker.ts:42-50`). The
  provider then runs on its refresh token until that is refused; the one login
  after it fails and `prepare()` / `rejected()` answer Oops with the class label
  of what the strategy threw (never its message, auth-providers rule 2). A
  process that can reach a user some other way passes `externalCodeStrategy`
  with its own `provide(url)`.
- The server today opens a browser from the server process
  (`browser: this.config.browser || 'system'`, `brokerFactory.ts:876`); in step
  5 it passes `browserCallbackStrategy({ browser, port })` from its own options.

## 5. Persistence through `onTokens` (H3, H4)

Every token provider the broker builds gets
`onTokens: (result) => this.persist(destination, result)`. `BaseTokenProvider`
calls it after every login and every refresh — never on a cache hit — and awaits
it before answering, whichever moment triggered the renewal: `prepare()`,
`authorize()` on expiry, `rejected()` after a 401, or the token API
(`BaseTokenProvider.ts:207-248`). So a renewal inside the connector is written
before the connector resends.

`persist` writes what 3.x writes (`src/AuthBroker.ts:295-345`), under three rules:

1. **Connection config** — `sessionStore.setConnectionConfig(destination, { ...connConfig, serviceUrl, authorizationToken, sessionCookies, authType })`,
   where a result with `tokenType: 'saml'` is `{ sessionCookies: token, authType: 'saml' }`
   and anything else `{ authorizationToken: token, authType: 'jwt' }`.
   **`authType` is always declared**, so an `auth-stores` 2.x session store never
   meets a config with two credentials and no type (it refuses those,
   `auth-stores CHANGELOG.md` 2.0.0 *Changed*). `connConfig` is re-read at
   write time, not captured when the provider was built, so a field written in
   between is not reverted; its `grantType` is carried through.
2. **Refresh token** — only when the result has one, as 3.x: into the session's
   own authorization config when it holds one; otherwise `saveSession` with
   the refresh token alone. **The client secret is never written** (H4) — the
   credentials that came from the service key stay there.
3. **A `basic` or `snc` session is never overwritten.** `persist` reads the
   session's stated `authType` first and refuses to write a token over `basic`
   or `snc` (it throws; §8 says where that surfaces). For a provider the broker
   built it cannot happen — `basic` and `snc` destinations get providers that
   obtain no token — so the check guards the token API.

`ITokenResult.expiresAt` still has no field to go to; the provider seeded with
the stored JWT reads `exp` itself (3.x comment, `src/AuthBroker.ts:292-293`).

**A failing write inside `onTokens`** is logged by the provider by class name
and does not fail the authentication (fact 2): a connector keeps working with a
token the store did not take. The broker records the failure against that
result (a `WeakMap<ITokenResult, unknown>`) so the token API can still report it
(§8).

## 6. Caching and concurrency (goal open 3)

**Recommendation: one provider per destination for the broker's life, shared
by `getProvider` and the token API.**

- `getProvider(d)` and the token API both go through one per-destination cache.
  With no consumer `provider`, `getToken(d)` asks the same
  `AuthorizationCodeProvider` / `ClientCredentialsProvider` a connector holds,
  so there is one token, one refresh token and one renewal in flight per
  destination. With a consumer `provider`, `getProvider` wraps the token API
  (§2.1) — still one source.
- **The cache holds the promise of the build**, set before the first store read
  and dropped if the build throws. 3.x set the map only after an `await`
  (`src/AuthBroker.ts:204-213`), so two concurrent first calls could build two
  providers; the promise closes that. A build that threw is retried on the
  next call, as 3.x does for a factory that threw.
- **Two callers renewing at once** share one renewal: `BaseTokenProvider`
  holds one in flight (one refresh, at most one login;
  `BaseTokenProvider.ts:198-205`), and a `rejected()` whose presented token is
  already superseded answers Ok without renewing again (`:416-443`). The
  connection adds no single-flight of its own and asks `rejected()` once per
  request (`connection src/connection/AbstractAbapConnection.ts:1610-1621`).
  The token API's `refreshToken` joins the same renewal. One renewal means one
  `onTokens`, so writes for one destination do not race each other.
- **What the cache does not see:** a session rewritten from outside (a new
  `mcp-auth` run) is picked up by a new broker, not by a cached provider — as
  in 3.x. Basic, SNC and SAML providers are cached too; a changed password or
  new cookies need a new broker. An explicit eviction is out of scope (§15).

## 7. What the store contract must carry (H0; goal open 5)

| `authType` | Needs | In `interfaces-auth-sap` 1.1.0? |
|---|---|---|
| any | `authType` | yes, `IConnectionConfig.authType` (`IConnectionConfig.ts:15`) — but not stated by every store (fact 4) |
| `basic` | `username`, `password` | yes (`:11`, `:13`) |
| `snc` | `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName` | yes (`:26-32`) |
| `saml` | `sessionCookies` | yes (`:21`) |
| `jwt` | `authorizationToken`; `uaaUrl`, `uaaClientId`, `uaaClientSecret`, `refreshToken` | yes (`IConnectionConfig.ts:9`, `IAuthorizationConfig.ts:5-14`) |
| `jwt` | **the grant** | **no** |
| renewal write-back | `setConnectionConfig` with the token and `authType`; `setAuthorizationConfig` / `saveSession` with the refresh token | yes (`ISessionStore.ts`), as 3.x uses them |

**Added to the contract — `interfaces-auth-sap` 1.2.0 (minor, additive):**
`IConnectionConfig.grantType?: 'authorization_code' | 'client_credentials'`,
documented as "for `authType: 'jwt'`: how a new token is obtained; absent means
the destination does not say". Nothing else; certificate fields stay out (goal,
open 4).

**Changed in the stores — `auth-stores` 2.1.0 (not a contract change, but the
broker's H1 depends on it):**

- the ABAP session stores and `EnvFileSessionStore` read and write `grantType`
  as a `jwt` field (a key such as `SAP_GRANT_TYPE`; the name is the store's);
- `XsuaaSessionStore`, `SafeXsuaaSessionStore`, `AbapServiceKeyStore` and
  `XsuaaServiceKeyStore` answer `authType: 'jwt'` from `getConnectionConfig`.
  This is the store stating its own format — a UAA service key and an XSUAA
  session hold nothing but OAuth credentials and tokens — not a guess between
  alternatives; the broker still reads only `authType`.
- **A `jwt` session with no token yet** — a destination seeded before its
  first login — is kept by both ABAP session stores and answered from
  `getConnectionConfig` with its `authType` and `serviceUrl`. Measured on
  2.0.0 (2026-10-01; `saveSession(d, { serviceUrl, authType: 'jwt', uaaUrl,
  uaaClientId, uaaClientSecret })`): `AbapSessionStore` writes the file and
  keeps the authorization config, but `getConnectionConfig` answers `null`;
  `SafeAbapSessionStore` throws "missing required field". The two stores
  disagree, and neither lets the broker read what such a destination states.

All three are prerequisites of 4.0.0: §14 G2.

## 8. The token API keeps 3.x (H5)

Every 3.x behaviour, and how 4.0 keeps it:

| 3.x behaviour (tested in `src/__tests__/broker/AuthBroker.test.ts`) | 4.0 |
|---|---|
| `getToken` asks `getTokens()`, `refreshToken` asks `refreshTokens()` — never the cached token | unchanged |
| a factory is seeded with `(destination, authConfig \| null, { ...conn, serviceUrl })`; the session's credentials win over the key's; the stored refresh token is passed | unchanged; `TokenProviderFactory` keeps its signature |
| one provider per destination from a factory; an instance for every destination as given; a factory that threw is retried | unchanged; the cache is the §6 one |
| `serviceUrl` from the session, else the service key, else an error before the provider is asked | unchanged |
| the result is written (§5), a SAML result as cookies; the refresh token only when the result has one; no client secret | unchanged (same `persist`) |
| provider errors propagate unchanged, and the provider is not asked again after a failure | unchanged |
| store failures other than absence propagate as raised | unchanged, including a write failure (below) |
| a result without `authorizationToken` is an error | unchanged |
| `createTokenRefresher(d)` = `{ getToken: () => getToken(d), refreshToken: () => refreshToken(d) }` | unchanged |

**Where the token API writes.** With a consumer `provider`, exactly as 3.x:
`persist` after every `getTokens()` / `refreshTokens()`, cache hits included.
With a provider the broker built, `onTokens` has already written every new
token, so the token API writes nothing itself; if `onTokens`' write failed for
the result it received, the token API throws that failure — a store failure
still reaches the caller as in 3.x. (A cache hit is not written again: it is the
token the session already holds or one `onTokens` wrote.)

**One deliberate change** — the goal's "the session's `authType` is not
overwritten": the token API on a destination whose session states `basic` or
`snc` throws `DestinationConfigError` before asking any provider. 3.x asked the
provider and then wrote `jwt` over the session. §14 G3.

**Without a consumer `provider`**, the token API serves the destinations whose
§2.1 provider is a token provider (`authorization_code`, `client_credentials`)
and throws `DestinationConfigError` for the others — there is no token to give
for `basic`/`snc`, and nothing to renew for a fixed token or a SAML session.

**`createTokenRefresher` stays as it is** and is not deprecated: calm-server
injects it into its own connection (`calm src/server/buildClient.ts:31`). For
a `connection` 10 connector, `getProvider` replaces it; a consumer that wants
the refresher there anyway wraps it with `TokenAuthProvider.from(refresher)`.

## 9. `@mcp-abap-adt/auth-broker-cli` 1.0.0

**What moves.** `bin/mcp-auth.ts`, `bin/mcp-sso.ts`, `bin/mcpSsoConfig.ts`,
`bin/samlMetadata.ts`, `bin/workDir.ts` → `packages/auth-broker-cli/src/`,
compiled to `dist/`; `bin` = `mcp-auth`, `mcp-sso`. Their tests
(`src/__tests__/bin/*`, fixtures included) and the CLI stands (`tests/keycloak`,
`tests/sso-demo`, with their npm scripts) move with them.
`generate-env-from-service-key.ts` moves as a development script of that
package, not a bin, as it is today (`package.json` `generate-env`); it states the
grant with a flag, as `mcp-auth` does, instead of reading it from the key's URL
(fact 1).

**Commands and flags are unchanged.** Changes are internal:

- `AuthBroker` is imported from `@mcp-abap-adt/auth-broker`, not `require`d by
  a path into `dist` (`bin/mcp-auth.ts:28-29`, `bin/mcp-sso.ts:38-39`).
- `getVersion()` reads **this** package's manifest; the smoke check (below)
  asserts the printed version is the CLI's, not the broker's.
- **Explicit collaborators instead of auth-providers 4.x defaults:**
  - device flow: `presenter: consoleDeviceCodePresenter(logger)`
    (`auth-providers src/providers/OidcDeviceFlowProvider.ts:42`);
  - SAML: `assertionValidator` built from the trust the CLI already collects
    (`--idp-cert`, `--idp-metadata`, `--idp-entity-id`, `idpCertificates` in
    `--config`) — `createSignedResponseValidator` for pure,
    `createSignedAssertionValidator` for bearer, each with `expectedIssuer`
    and `replayStore: defaultReplayStore` — replacing `idpCertificates` on the
    provider config (`bin/mcpSsoConfig.ts:595-602`); the CLI's own flags keep
    their names;
  - manual strategies: `read: (prompt, signal) => readManualInput(prompt, signal)`,
    where `readManualInput` closes its `readline` and rejects when the signal
    aborts (today it takes no signal, `bin/mcpSsoConfig.ts:110-130`, so a
    timed-out or disposed strategy would leave stdin held).
- **The session file it writes is a 4.0 destination.** `mcp-auth` keeps
  injecting its provider (§8 path, unchanged), and its output states
  `authType` (`jwt`) and `grantType` (`authorization_code`, or
  `client_credentials` with `--credential`), using `auth-stores` 2.1 key
  names. `mcp-sso` states `authType`; for OIDC and SAML-bearer sessions it
  states no grant (§3.2).

**Dependencies:** `@mcp-abap-adt/auth-broker` ^4.0.0, `@mcp-abap-adt/auth-stores`
^2.1.0, `@mcp-abap-adt/auth-providers` ^5.0.1, `@mcp-abap-adt/interfaces-auth`
^3.0.0, `@mcp-abap-adt/interfaces-auth-sap` ^1.2.0, `@mcp-abap-adt/interfaces-utils`
^1.1.0, `@mcp-abap-adt/logger` (a runtime dependency, the 3.0.4 lesson,
`CHANGELOG.md` 3.0.4).

**The bin smoke check** (`tools/check-packed.js`, part of `npm run check`, §10):
pack both packages; in an empty temporary directory `npm init -y` and
`npm install --no-save --ignore-scripts` both tarballs; then run
`node <installed>/mcp-auth --version`, `mcp-sso --version` and each `help`,
asserting exit 0 and the CLI's manifest version; `require('@mcp-abap-adt/auth-broker')`
loads, its manifest has no `bin` and does not depend on `auth-stores`. It
installs the other dependencies from the registry, so it needs the network and
says so when it cannot reach it. Same check as the server's
(`server src/__tests__/unit/binSmoke.test.ts`), which exists because 3.0.3
shipped a bin that died on `MODULE_NOT_FOUND`.

**Release order.** One `release:publish` run publishes `auth-broker` 4.0.0 and
then `auth-broker-cli` 1.0.0, in workspace order (§10), so no registry state has
3.x's `mcp-auth` gone without the CLI package present. `interfaces-auth-sap`
1.2.0 and `auth-stores` 2.1.0 are on the registry before that run (§14 G2).

## 10. The repository takes the `mcp-abap-adt-interfaces` layout

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
4. Per package: `package.json` with `repository.directory`, a per-package
   `homepage`, `files` = `dist`, README, CHANGELOG, LICENSE, COPYING;
   `prepublishOnly: npm run --prefix ../.. check`; `tsconfig.json` extending the
   base, `tsconfig.build.json` with project `references` to its siblings;
   its own README and CHANGELOG. Licence files copied into each package.
5. `publish-changed.js`: publishes only versions not on the registry, runs
   `npm run check` once, publishes with `--ignore-scripts`, refuses a dirty
   tree, a missing tag, a tag that is not `HEAD`'s ancestor, any difference
   between `HEAD` and the tag, a prerelease on `latest`, and moving `latest`
   backwards; verifies at the end (exit 2 = published, not yet served).
   Tags are `<dir>-v<version>`.
6. `check-graph.js`: each package imports only what an allowlist permits,
   declares it, and imports everything it declares.
7. No CI: `npm run check` is what holds, run by `release:publish` and by every
   `prepublishOnly`. `.gitignore` names `node_modules` both ways.

**Mirrored here:**

```
/                      private root: package.json, package-lock.json, tsconfig.base.json,
                       biome.json, tools/, docs/, README.md (workspace overview), LICENSE,
                       COPYING, CONTRIBUTORS.md, CLAUDE.md, AGENTS.md, ROADMAP.md, .github/
packages/auth-broker/      @mcp-abap-adt/auth-broker — src/ (today's), its tests,
                           tests/test-config.yaml.template, README, CHANGELOG (3.x history + 4.0.0)
packages/auth-broker-cli/  @mcp-abap-adt/auth-broker-cli — src/ (today's bin/), its tests,
                           tests/keycloak, tests/sso-demo, README, CHANGELOG (starts at 1.0.0)
tools/                 publish-changed.js, test-publish-changed.js (copied; comments about
                       the interfaces facade removed), check-graph.js, check-packed.js,
                       version-stats.sh
```

- `workspaces`: `["packages/auth-broker", "packages/auth-broker-cli"]`.
- Root scripts as item 2, plus `test` (`--workspaces --if-present`: the
  interfaces have no Jest suites, this repository does). Jest, `ts-jest` and
  `@types/jest` become root dev dependencies; each package keeps its own
  `jest.config.js`.
- `check` = build, `test:check`, `lint:check`, `check:graph`, `check:packed`,
  `check:publish`. It does not run Jest: the library's integration suite reads
  real session files when configured, and a release gate must not reach a real
  system unasked.
- `check-graph.js` allowlist: `auth-broker` → `interfaces-auth`,
  `interfaces-auth-sap`, `interfaces-utils`, `auth-providers`;
  `auth-broker-cli` → the §9 list. This makes H0 ("the library never imports
  auth-stores") a check, not a promise.
- Tags from 4.0.0 on: `auth-broker-v4.0.0`, `auth-broker-cli-v1.0.0`. The
  existing `v*` tags stay as history.
- **CHANGELOGs:** today's `CHANGELOG.md` moves to `packages/auth-broker/` and
  continues there; the CLI's starts at 1.0.0 and says the commands shipped in
  `@mcp-abap-adt/auth-broker` up to 3.0.4, whose changelog holds their history.
- **READMEs:** the root README becomes the workspace overview (the two
  packages, what each holds and depends on, working in the repository,
  publishing); the library README keeps the API; the `mcp-auth` / `mcp-sso`
  sections move to the CLI README.

**Departures, each justified:**

- **`.github/workflows/release.yml` stays, adapted** (interfaces has no CI).
  It exists today and attaches the tarball to a GitHub release, which
  installation docs rely on (*inference* — not checked which). Its trigger
  `v*.*.*` matches no new tag; it becomes `auth-broker-v*` and
  `auth-broker-cli-v*`, packing the workspace the tag names.
- **`check-surface.js` and `package-map.json` are not mirrored**: they check
  the interfaces' symbol-to-package split, which this repository does not have.
- **`check-packed.js` checks bins, not declarations**: the risk here is a bin
  that does not start (§9), which is what the check is for.
- **`engines` stays `^22 || ^24 || ^26`**, not interfaces' `>=18`: it follows
  SAP BTP's Node versions (`CHANGELOG.md` 3.0.2).

## 11. Breaking changes and migration

**`@mcp-abap-adt/auth-broker` 4.0.0:**

1. **No `bin`.** `mcp-auth` and `mcp-sso` are in `@mcp-abap-adt/auth-broker-cli`.
2. **Contracts:** `@mcp-abap-adt/interfaces-auth` ^3.0.0,
   `@mcp-abap-adt/interfaces-auth-sap` ^1.2.0, `@mcp-abap-adt/auth-providers`
   ^5.0.1. Types from `interfaces-auth` 2.x no longer mix: a consumer's
   provider or store must be on the same contracts.
3. **`@mcp-abap-adt/auth-stores` is no longer a dependency** (H0). A consumer
   that imported it without declaring it must declare it.
4. **The token API refuses a destination stated `basic` or `snc`** (§8).
5. `axios` leaves the dependencies (nothing in `src/` or `bin/` imports it).

Additive: `getProvider`, `DestinationConfigError`, the `authorization` and
`grantType` options, `provider` optional.

**Migration notes:**

- **The server (goal step 5).** Build the connector from
  `await broker.getProvider(destination)`; delete the per-auth-type
  `connectionParams`, the `getToken` call before connecting and the
  `tokenRefresher` (`BaseMcpServer.ts:112-205`, `:316-334`,
  `utils.ts` `getManagedConnection`). Construct the broker without `provider`,
  with `authorization: () => browserCallbackStrategy({ browser, port })` and
  `grantType: 'authorization_code'` (what `createTokenProviderForDestination`
  always chose), or write `authType` / `grantType` into the sessions it seeds
  from service keys. `getConnectionConfig` still gives the URL and client for
  the connector. Its docs install `@mcp-abap-adt/auth-broker-cli` for
  `mcp-auth` (`README.md:367`, `docs/installation/INSTALLATION.md:53,83,292`,
  `docs/user-guide/AUTHENTICATION.md:47`).
- **calm-server (token API).** Bump the broker, auth-providers 5 and the
  contracts together. `TokenProviderFactory`, `refuseLogin` and
  `createTokenRefresher` work unchanged; its `mcp-auth` hints need the new
  package name.
- **People who `npm i -g @mcp-abap-adt/auth-broker` for `mcp-auth`:**
  `npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli`.
  Commands and flags are the same. Session files written by 3.x keep working
  for the token API; for `getProvider` a `jwt` file needs a `grantType` (write
  it again with `mcp-auth` 1.0, or let the consumer state `grantType`).

## 12. Testing

**Unit (`packages/auth-broker`, stores as in-memory fakes of the contract, providers real):**

- per `authType`, what `getProvider` returns does the right thing through the
  contract, with nothing in the test branching on its class: `basic` writes the
  Basic header and offers `{ user, passwd }`; `saml` writes the cookies; `snc`
  hands over `snc_partnername` / `snc_qop` / `snc_myname` / `snc_lib` after
  `prepare()` (with `sncLib` pointing at a fixture whose header is the host's
  architecture — *inference* that `DefaultSncLibraryLocator` accepts it), and a
  missing `sncLib` file is refused naming `sncLib`;
  `authorization_code` and `client_credentials` against a local token endpoint;
  `jwt` without authorization config presents the stored token;
- each `DestinationConfigError` case of §2.3, asserting `missingFields` and that
  no value appears in the message;
- `grantType` precedence: session, service key, broker option, none;
- the consumer's `provider`: `getProvider` presents its token, and a
  `rejected()` renewal is written through the token API;
- persistence: a renewal through `rejected({ at: 'request', status: 401 })` on
  the provider `getProvider` returned is in the session store afterwards,
  with `authType` declared, the refresh token beside it, **no client secret**;
  a `basic` / `snc` session is never overwritten; `onTokens`' write failure
  surfaces from `getToken`; a failure elsewhere does not stop the connector's
  provider;
- caching: two concurrent `getProvider` calls build once; a failed build is
  retried; `getProvider` and `getToken` share one provider, one renewal;
- every row of §8's table, carried over from today's suite.

**Integration through `connection` 10** (dev dependency): an
`AdtCloudConnector` over its HTTP wire against a local server that answers the
first request 401 and the second 200, with a local token endpoint; the broker's
provider renews once, the connector resends once, and the session store holds
the new token — the goal's success criterion, end to end, with no SAP system.

**Live (H6):** `packages/auth-broker/src/__tests__/live/getProvider.live.test.ts`,
one case per row. Each case reads a sessions directory and a destination name
from environment variables it names, states where it runs, and skips elsewhere
printing why. No configuration framework.

| Case | Where it runs |
|---|---|
| `basic` over HTTP and over RFC (`rfcConversationFrom`, needs `@mcp-abap-adt/sap-rfc-lite` and the NW RFC SDK) | an on-premise system |
| a `jwt` destination over HTTP; seeded with a well-formed JWT the system refuses (future `exp`, so the provider trusts it), so the first request is a 401 and the renewal happens in `rejected()` — the new token must be in the session file afterwards | BTP ABAP environment (trial) |
| `snc` over RFC | Windows or macOS with the SAP Secure Login Client logged on; on Linux the case skips stating that the Secure Login Client exists only there |

**Load-bearing:** each rule above is broken once on purpose (the `authType` in
`persist`, the `basic`/`snc` guard, the H4 branch, the promise cache, the
failure hand-over from `onTokens`) and its test must go red, then restored.

**CLI package:** today's `mcpSsoConfig` / `samlMetadata` / `mcpSsoSamlProviders`
suites move and are adapted to validators; `readManualInput` honours the abort;
the smoke check of §9.

## 13. Documentation and housekeeping

- **Stale comments:** `src/index.ts:34-37` and `src/stores/index.ts:4-6` name
  `@mcp-abap-adt/auth-stores-btp` / `-xsuaa`, which do not exist — they become
  "store implementations: `@mcp-abap-adt/auth-stores`, or any
  `ISessionStore` / `IServiceKeyStore`"; `src/types.ts:4` and
  `src/stores/interfaces.ts:4` say "imported from `@mcp-abap-adt/interfaces`",
  deleted as of its 52.0.0 — they name `interfaces-auth-sap`.
- **Docs updated for 4.0** (global rule: all of them, not only the CHANGELOG):
  root and both package READMEs; `docs/architecture/ARCHITECTURE.md` and
  `EXPORTS.md` (`getProvider`, the new options, the error);
  `docs/using/USAGE.md`; `docs/installing/INSTALLATION.md` (the CLI package);
  `docs/development/TESTING.md` (live cases, the smoke check); `CLAUDE.md` and
  `AGENTS.md` (layout, commands); a *Migrating to 4.0.0* section with §11.
- The goal, this spec and the plan are deleted before the release.

## 14. Proposed goal changes

- **G1 — `saml` is handed over, not renewed.** The goal's `saml → the SAML
  providers (cookies or bearer), as mcp-sso configures them` cannot be met from
  the stores: those providers need a cookie function and IdP trust the contract
  does not carry (fact 5). 4.0 gives `SamlAuthProvider` from the session's
  cookies. Renewing SAML from a destination is a later step of its own, like
  certificates: the trust fields in a contract, the stores, the broker.
- **G2 — two prerequisites before step 4.** *3b:* `interfaces-auth-sap` 1.2.0
  (`IConnectionConfig.grantType`). *3c:* `auth-stores` 2.1.0 (`grantType`; the
  XSUAA session stores and both service key stores state `authType: 'jwt'`;
  both ABAP session stores keep a `jwt` session with no token yet and answer
  it from `getConnectionConfig` — §7).
  The goal's dependency line becomes `interfaces-auth-sap ^1.2.0`, and the CLI
  depends on `auth-stores ^2.1.0`.
- **G3 — H5 has one exception, which the goal already implies.** The token API
  refuses a destination stated `basic` or `snc` rather than writing `jwt` over
  it; the goal's "the session's `authType` is not overwritten" cannot hold
  otherwise.
- **G4 — for review: may the consumer state the grant?** §3.2 lets
  `AuthBrokerConfig.grantType` state it for destinations that do not. The
  stricter reading of H1 removes the option: every `jwt` destination must carry
  `grantType` in its stores, and the server rewrites the sessions it seeds.
  This spec recommends keeping the option (calm's `authFlow` shows consumers
  already state it once) and asks the review to decide.

## 15. Out of scope

- Certificates (goal, open 4); SAML renewal (G1); the OIDC and SAML-bearer
  grants in `getProvider` (§3.2).
- Evicting a cached provider when a store changes underneath it (§6).
- The server's migration (goal step 5) beyond the note in §11.

## 16. Check against the goal

| Hold | Where |
|---|---|
| H0 the broker speaks the store contracts | §2.2, §7 (the grant goes into `interfaces-auth-sap`), §10 `check-graph` |
| H1 the configuration states the provider | §3.1, §3.2, G4 |
| H2 no implicit defaults | §2.1 (every collaborator named), §4 |
| H3 what a provider obtains reaches the store | §5, §2.1 (the consumer's provider through the token API), §12 |
| H4 no secret it was not given | §5 item 2, §12 |
| H5 the token API keeps 3.x | §8, G3 |
| H6 measured | §12 *Live* |

| Goal open question | Answer |
|---|---|
| 1 strategy | §4 — per destination, from a function given to the broker; headless passes a refusing one |
| 2 grant | §3.2 — `IConnectionConfig.grantType`, then the consumer's `grantType`, else refused |
| 3 caching | §6 — one provider per destination, shared, promise-cached |
| 5 contract | §7 — `grantType` added; stores state `authType` |
