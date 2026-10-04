# x509 service keys — design

**Answers:** `docs/superpowers/2026-10-05-x509-service-keys-goal.md` — its
"Holds throughout" binds every section; its "Decided" list is not reopened.

**Status:** for review. The plan follows only after this is approved.

## 1. The contract — `@mcp-abap-adt/interfaces-auth-broker` (minor)

Types only, in its own PR, released before anything builds against it.

```ts
/** A client certificate a service key carries — the key's data, as it is. */
export interface IClientCertificate {
  /** The authorization server (XSUAA `url`) — its authorize page. */
  readonly uaaUrl: string;
  /** The client id (`clientid`). */
  readonly clientId: string;
  /** PEM: the client certificate, possibly a chain (leaf first). */
  readonly certificate: string;
  /** PEM: the certificate's private key. */
  readonly key: string;
  /** The mTLS host of the authorization server (XSUAA `certurl`), no path. */
  readonly certUrl: string;
}

export interface IServiceKeyStore {
  // … unchanged members …
  /**
   * The destination's client certificate, when its key carries one; `null`
   * when it does not. Optional: a store that never holds certificates omits it.
   * Answers data only — which authentication the client uses is the consumer's.
   */
  getClientCertificate?(destination: string): Promise<IClientCertificate | null>;
}
```

`IAuthorizationConfig` (`interfaces-auth-sap`) is untouched, and an x509 key
is **not** answered through it: `getAuthorizationConfig` answers `null` for an
x509 key, exactly as a 4.0.0-era store does for a key it cannot read. The whole
certificate client — `uaaUrl`, `clientId`, certificate, key, `certUrl` — comes
only from `getClientCertificate`. So no existing consumer (a 4.0.0 broker, a
direct store user) can mistake an x509 client for a public one: an empty
`uaaClientSecret` means a public client in `destinations.ts` (passcode, OIDC,
SAML bearer), and an x509 key never produces one (version-skew safe).

## 2. `@mcp-abap-adt/auth-stores` (minor)

- **`XsuaaServiceKeyStore`** (and its parser, which today requires
  `clientsecret`): a key — bare or wrapped in `credentials` — carrying
  `url`, `clientid`, `certificate`, `key` and `certurl` and no `clientsecret`
  is an x509 key. `getAuthorizationConfig` answers `null` for it;
  `getClientCertificate` answers `{ uaaUrl, clientId, certificate, key, certUrl }`. A key with a
  `clientsecret` answers `getClientCertificate` with `null` and everything else
  exactly as today. A key carrying both a secret and a certificate is refused
  in fixed words (the key does not say what it is).
- **`EnvDestinationStore`:** three variables, each a path or a URL, never
  PEM — `UAA_CLIENT_CERT_PATH`, `UAA_CLIENT_KEY_PATH`, `UAA_CERT_URL`. Its
  answers, decided from which variables are set (no file is read to decide):
  - **none of the three** → as 4.0.0 (`getAuthorizationConfig` unchanged;
    `getClientCertificate` → `null`);
  - **all three, and no `UAA_CLIENT_SECRET`** → a certificate destination:
    `getAuthorizationConfig` → `null` (as for an x509 key, so an older consumer
    never sees a public client); `getClientCertificate` reads the two files
    and answers `{ uaaUrl, clientId, certificate, key, certUrl }` with
    `UAA_URL` / `UAA_CLIENT_ID`;
  - **some but not all three**, or **any of them together with
    `UAA_CLIENT_SECRET`** → both methods throw the store's own error in fixed
    words naming the variables (incomplete / mixed client) — never a silent
    `null`, never the secret;
  - a file that cannot be read → the store's error in fixed words naming the
    variable, never the path's content.
  `setDestination` writes the three as it writes the others, and when it
  writes a certificate client it removes `UAA_CLIENT_SECRET`, and when it
  writes a secret client it removes the three — switching a destination's
  authentication never leaves a stale credential of the other kind.
- **Never** to the session store: `SessionSecret` gains nothing, and no session
  writer receives a certificate or key.
- **ABAP service keys** (`AbapServiceKeyStore`) are not touched.

## 3. `@mcp-abap-adt/auth-broker`

### 3.1 The strategy

```ts
/**
 * Every grant whose client authenticates to the authorization server: the
 * three UAA grants, the OIDC grants and `saml2_bearer` — every row that
 * passes a client secret today. (`saml2_pure` and the basic/SNC/handover rows
 * authenticate no client and never call the strategy.)
 */
export type ClientAuthenticationGrant =
  | 'client_credentials'
  | 'authorization_code'
  | 'passcode'
  | 'oidc_authorization_code'
  | 'device_code'
  | 'password'
  | 'token_exchange'
  | 'saml2_bearer';

export interface ClientAuthenticationContext {
  readonly destination: string;
  readonly grant: ClientAuthenticationGrant;
  /** What `getAuthorizationConfig` answered (a secret client), or null. */
  readonly client: IAuthorizationConfig | null;
  /**
   * Reads the store's certificate client — only when called. Nothing reads a
   * certificate or its files unless the strategy asks.
   */
  readCertificate(): Promise<IClientCertificate | null>;
}

export interface AuthBrokerConfig {
  // … unchanged …
  /**
   * How a jwt destination's client authenticates to the authorization server.
   * Called once when the destination's provider is built. Its answer goes to
   * the provider as `clientAuthentication`. A given strategy always answers
   * one, or throws: there is no "nothing" answer, so an explicit choice can
   * never fall back to the secret. Only an absent strategy means 4.0.0.
   */
  clientAuthentication?: (
    context: ClientAuthenticationContext,
  ) => Promise<IClientAuthentication>;
}
```

Shipped factories (`src/clientAuthentication.ts`), each returning a function of
that shape — the consumer passes one, or composes its own:

| Factory | Answers |
|---|---|
| `fromServiceKeyCertificate()` | `tlsClientCertificate({ material: { cert, key }, endpoint: \`${certUrl}/oauth/token\` })` from `readCertificate()`. The store lacking `getClientCertificate`, or answering `null` (e.g. an `EnvDestinationStore` with none of the three variables), **throws** — fixed words, "the destination has no client certificate" |
| `fromServiceKeySecret({ encoding })` | `clientSecretBasic(uaaClientSecret, { encoding })` from the secret client. No secret client, or an empty secret, **throws** — fixed words, "the destination has no client secret". `encoding` is required (`'raw'` for XSUAA, measured) |

Both fail closed. A consumer that wants one with the other as its fallback
writes that itself — e.g. `ctx => fromServiceKeyCertificate()(ctx).catch(() => fromServiceKeySecret({ encoding: 'raw' })(ctx))`
— the fallback, and its order, are the consumer's statement, never the
broker's. Every throw is turned into the guarded `DestinationConfigError`
(3.2).

### 3.2 `uaaProvider`

- **Without a strategy:** exactly 4.0.0 — `getAuthorizationConfig`, the secret
  through the providers' path without a strategy, the same lacking-field
  checks. **Nothing certificate-related is called** — no `getClientCertificate`,
  no file read, no identity resolution. When the destination fails the check
  for lack of a client, the `DestinationConfigError` names the lacking fields
  as 4.0.0 does and adds, in fixed words, that a certificate client needs a
  `clientAuthentication` strategy — a hint, decided without looking at the
  key.
- **With a strategy:** the broker calls it with the context (the certificate
  read lazily, only if the strategy asks). Its answer goes to the provider as
  `clientAuthentication`, with **no** `clientSecret` (5.3.0 refuses both);
  `uaaUrl` / `uaaClientId` come from the secret client or, when that is null,
  from the certificate client the strategy read (the broker reads it through
  the same lazy, memoised `readCertificate`, so it is read at most once).
- **Strategy failures never carry a value out.** The strategy call and
  everything it constructs (`tlsClientCertificate`, reading files, a malformed
  PEM) run inside one guard in the broker: any throw becomes a
  `DestinationConfigError` in fixed words naming `clientAuthentication` — no
  `cause`, no message of the thrown value — before any provider exists.
- **Every client-authenticating row** — `uaaProvider`, the OIDC row
  (`oidcProvider`) and `saml2_bearer` — applies the same rule: with a strategy,
  the provider gets its answer as `clientAuthentication` and no `clientSecret`
  (all these 5.3.0 providers take it); without one, 4.0.0. A strategy is
  therefore never silently ignored. The exact `DestinationGrant` names of the
  OIDC rows are taken from `interfaces-auth-broker` in the plan.
- **The session binding uses the client identity, never PEM — on the strategy
  path only.** Without a strategy the binding is 4.0.0's (from
  `getAuthorizationConfig`). With a strategy, the binding (`destinationBinding`,
  `consumerBinding`, `uaaBinding`) is computed from the secret client when
  there is one, else from the certificate client's `uaaUrl` and `clientId` —
  resolved through the same memoised `readCertificate` before the binding and
  the session seed are chosen. So a certificate destination's
  tokens are stored with `issuedBy` = its issuer and client, reused after the
  broker is recreated, and refused after the issuer or client id changes.

### 3.3 The token API, `getAuthorizationConfig`, and the consumer's factory

`AuthBroker.getAuthorizationConfig` keeps answering what it answers; for an
x509 key that is `null`, and it never returns the certificate or key.

The token API's consumer factory (`provider: TokenProviderFactory`) gains an
optional fourth argument — additive, so a 4.0.0 factory keeps working:

```ts
export type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
  client?: {
    /** The strategy's answer, when the broker was given a strategy. */
    readonly clientAuthentication?: IClientAuthentication;
    /** The client's identity when it has no secret client — never PEM. */
    readonly uaaUrl?: string;
    readonly clientId?: string;
  },
) => IRefreshableTokenProvider;
```

The broker resolves the strategy (guarded, as in 3.2) **before** it calls the
factory, and calls the factory inside the same guard: a throw from either is a
`DestinationConfigError` in fixed words. Without a strategy the fourth argument
is absent and the call is 4.0.0's. `runMcpAuth` uses exactly this path (§4).

### 3.4 Errors and logs

Nothing of a certificate, a key or a file's content reaches a log line, a
refusal, a `DestinationConfigError` or a thrown message — the broker logs only
fixed words and the destination name. A strategy that throws surfaces as the
provider's refusal (5.3.0 already maps it in fixed words).

## 4. `@mcp-abap-adt/auth-broker-cli`

- `mcp-auth` / `runMcpAuth`: it reads the key itself and builds providers
  through the broker's `provider` factory (§3.3); it gains the same choice,
  stated by the user — `--client-auth certificate|secret` and, for `secret`,
  `--basic-encoding raw|form` (required with `secret`). The flag builds the
  broker's `clientAuthentication` strategy from the matching factory; the
  factory receives its answer and the client identity through the fourth
  argument. The grant stays the command's own (`--credential` →
  `client_credentials`, else `authorization_code`) — client authentication
  does not choose a grant. No flag → 4.0.0 behaviour; an x509 key with no flag
  → an error naming the flag (it no longer rejects a null `authConfig` when the
  certificate strategy supplies the identity). With `certificate` it takes
  `--cert-path` / `--key-path` exactly as `generate-env` does (existing files,
  resolved to absolute paths) and writes them, with `certurl`, into the
  `EnvDestinationStore` it authenticates through — path-only; its
  `withPlaceholderUrl` adapter forwards `getClientCertificate` like every other
  store method. **No key material is ever copied, whatever the flags.** Today's
  `credentials`-wrapper branch (`runMcpAuth.ts`) serialises the unwrapped key
  into the work directory before anything is validated; from now on it first
  looks only at whether the unwrapped object carries a `certificate` or `key`
  field (not to choose an authentication — only to know it must not copy it):
  such a key is never serialised — the **original** file goes to
  `XsuaaServiceKeyStore`, which unwraps `credentials` itself — with no flag,
  with `secret`, with `certificate`, and for a mixed key alike; the command
  then proceeds or fails as the flags and the store decide. Only a key with no
  `certificate`/`key` field keeps today's temporary-copy handling. So no copy
  of a private key ever exists outside the user's own files, even on a failed
  run. Its exported destination (env/JSON output) carries the paths
  and `certurl`, never PEM, and a fresh broker over it gets a token.
- `generate-env-from-service-key`: the same explicit choice
  (`--client-auth certificate|secret`, `--basic-encoding raw|form` with
  `secret`), passed into the `AuthBroker` it builds. For `certificate` it also
  takes `--cert-path` and `--key-path`: existing PEM files the user owns, which
  the command does not create; both are resolved to absolute paths before
  anything is written, so the destination `.env` works from its final
  location regardless of the command's temporary work directory. It writes the
  three variables (paths and `certurl`), never PEM; on a failed login it
  leaves an existing destination file untouched (today's behaviour). Missing
  flags → an error naming them.
- The CLI never prints a certificate, a key or a path's content.

## 5. Dependencies and versions

- auth-broker: `@mcp-abap-adt/auth-providers ^5.3.0`, `interfaces-auth ^3.2.0`,
  `interfaces-auth-broker ^<the new minor>`, `auth-stores ^<the new minor>`
  (dev); auth-broker-cli: the same where used. All from the registry.
- Versions: interfaces-auth-broker minor, auth-stores minor, auth-broker 4.1.0
  (additive), auth-broker-cli minor.

## 6. Tests

| Where | What it proves |
|---|---|
| stores, unit | a bare and a wrapped x509 key → `getAuthorizationConfig` null and `getClientCertificate` the whole certificate client; a secret key → `null` and today's answers; both → refused; `EnvDestinationStore`: all three variables → the files' content; none → `null`; some but not all, or any together with `UAA_CLIENT_SECRET` → the store's fixed-words error from both methods, **without reading any file**; an unreadable file → fixed words, no content |
| broker, unit | each factory's answer, and each factory throwing when its client is unavailable (store without the method, `null`, no secret; an incomplete or mixed `.env` throws earlier, in the store) → the guarded `DestinationConfigError`, never a fallback; the consumer factory receiving the fourth argument, and a throwing factory guarded; `uaaProvider` with a strategy → the provider got `clientAuthentication` and no secret, for all three grants; without one → byte-for-byte 4.0.0 (existing tests unchanged); certificate without a strategy → `DestinationConfigError` naming `clientAuthentication`; nothing of a key in a log, error or refusal (a marker test) |
| CLI, unit | the flags; x509 key without a flag → the named error; the `.env` gets paths, never PEM |
| broker stand | unchanged suites green on 5.3.0 |
| stores, unit (added) | `EnvDestinationStore`: none / all three without secret / partial / mixed with `UAA_CLIENT_SECRET` → 4.0.0 / certificate (authz null) / fixed-words error / fixed-words error; old-consumer view of a certificate destination → `getAuthorizationConfig` null; `setDestination` switching secret↔certificate removes the other kind |
| broker, unit (bindings, rows) | a certificate destination's binding uses its `uaaUrl`/`clientId`: a stored token reused after broker recreation, refused after the issuer or client id changes; the strategy reaches the OIDC row and `saml2_bearer` (provider gets `clientAuthentication`, no secret) |
| CLI, unit (added) | a wrapped x509 key and a wrapped mixed key, each run with no flag, `--client-auth secret` and `--client-auth certificate` (successful or failing) → no file under the work directory or in the exported destination contains PEM (scan for `-----BEGIN`); a wrapped secret-only key keeps today's temporary copy |
| broker, unit (added) | a complete certificate destination with **no strategy** → zero calls to `getClientCertificate` and zero PEM-file reads (a spy store / spied fs), and the error carries the fixed hint; a throwing strategy and a malformed PEM → `DestinationConfigError` in fixed words, nothing of the thrown value; the lazy-read rule with a **spy store** (not `EnvDestinationStore`): `getAuthorizationConfig` answers a secret client and `getClientCertificate` throws if called → with no strategy the secret provider builds and the method is never called; old-consumer shape: an x509 key → `getAuthorizationConfig` null (never `''`) |
| trial, live (`test:live`, opt-in) | setup creates an XSUAA instance with an x509 key (exact `cf target` guard, `.local/owned`). (a) `AuthBroker` + `XsuaaServiceKeyStore` + `fromServiceKeyCertificate()` → `getProvider(dest).prepare()` Ok and the token API returns a token whose client id is the key's; (b) `mcp-auth --credential --client-auth certificate --cert-path <abs> --key-path <abs>` → a token with that client id, and a fresh broker over its exported destination gets one too; (c) `generate-env-from-service-key --client-auth certificate --cert-path … --key-path …` → a destination `.env` with paths only, then a fresh `AuthBroker` over that `.env` from its final location gets a token; (d) a failing run leaves the previous destination file untouched and prints no PEM. Exact non-interactive invocations: `mcp-auth --credential --client-auth certificate --service-key <key> …` and `generate-env-from-service-key <dest> <key> <session> --grant client_credentials --client-auth certificate --cert-path <abs> --key-path <abs>`; the PEM fixtures are written from the trial key into `.local/` (0600) by setup; each run has a timeout; the test asserts no interactive authorization strategy was constructed or invoked (none is passed; a call fails the test). Teardown removes everything, also on failure |

Every rule protected by a test is proven load-bearing.

## 7. Documentation

README (both packages): the strategy, the two factories, composing them, the
`.env` variables, the CLI flags; CHANGELOG entries in every package; the
broker's CLAUDE.md where it lists collaborators. Unmeasured: `authorization_code`
and `passcode` over x509, ABAP keys with x509.

## 8. Not in this change

`mcp-abap-adt`; `private_key_jwt`; ABAP service keys with x509; issuing or
rotating certificates; the session store.
