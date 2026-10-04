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
- **`EnvDestinationStore`:** three variables, each optional, never PEM —
  `UAA_CLIENT_CERT_PATH`, `UAA_CLIENT_KEY_PATH`, `UAA_CERT_URL`.
  `getClientCertificate` reads the two files when all three are set (with
  `UAA_URL` and `UAA_CLIENT_ID` it already holds) and answers their contents; any one missing → `null`; a file that cannot be read → an
  error of the store's own class in fixed words naming the variable, never the
  path's content. `setDestination` takes the three as it takes the others.
- **Never** to the session store: `SessionSecret` gains nothing, and no session
  writer receives a certificate or key.
- **ABAP service keys** (`AbapServiceKeyStore`) are not touched.

## 3. `@mcp-abap-adt/auth-broker`

### 3.1 The strategy

```ts
/** The grants whose client authenticates to the authorization server. */
export type ClientAuthenticationGrant =
  | 'client_credentials'
  | 'authorization_code'
  | 'passcode';

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
   * the provider as `clientAuthentication`; `undefined` means "as 4.0.0": the
   * secret through the providers' path without a strategy.
   */
  clientAuthentication?: (
    context: ClientAuthenticationContext,
  ) => Promise<IClientAuthentication | undefined>;
}
```

Shipped factories (`src/clientAuthentication.ts`), each returning a function of
that shape — the consumer passes one, or composes its own:

| Factory | Answers |
|---|---|
| `fromServiceKeyCertificate()` | `tlsClientCertificate({ material: { cert, key }, endpoint: \`${certUrl}/oauth/token\` })` when `readCertificate()` answers one; `undefined` otherwise |
| `fromServiceKeySecret({ encoding })` | `clientSecretBasic(uaaClientSecret, { encoding })` when the client has a non-empty secret; `undefined` otherwise. `encoding` is required (`'raw'` for XSUAA, measured) |

They are separate on purpose: a consumer who wants both writes
`async ctx => (await fromServiceKeyCertificate()(ctx)) ?? fromServiceKeySecret({ encoding: 'raw' })(ctx)`
— the order is its choice, not the broker's.

### 3.2 `uaaProvider`

- **Without a strategy:** exactly 4.0.0 — `getAuthorizationConfig`, the secret
  through the providers' path without a strategy, the same lacking-field
  checks. No certificate is read. Only when the destination fails that check
  for lack of a client (`getAuthorizationConfig` answered `null`) does the
  broker ask `getClientCertificate?.()` whether a certificate client exists,
  solely to name `clientAuthentication` among the lacking fields (fixed words:
  the key carries a certificate and no strategy was given to use it).
- **With a strategy:** the broker calls it with the context (the certificate
  read lazily, only if the strategy asks). An `IClientAuthentication` answer
  goes to the provider as `clientAuthentication`, with **no** `clientSecret`
  (5.3.0 refuses both); `uaaUrl` / `uaaClientId` come from the secret client
  or, when that is null, from the certificate client the strategy read. An
  `undefined` answer → the path without a strategy, as above.
- **Strategy failures never carry a value out.** The strategy call and
  everything it constructs (`tlsClientCertificate`, reading files, a malformed
  PEM) run inside one guard in the broker: any throw becomes a
  `DestinationConfigError` in fixed words naming `clientAuthentication` — no
  `cause`, no message of the thrown value — before any provider exists.
- Grants: `client_credentials`, `authorization_code`, `passcode`.

### 3.3 The token API and `getAuthorizationConfig`

`AuthBroker.getAuthorizationConfig` keeps answering what it answers; it never
returns the certificate or key. The token-API factory path (`provider` /
`TokenProviderFactory`) receives the same `clientAuthentication` answer when the
broker builds the token provider itself.

### 3.4 Errors and logs

Nothing of a certificate, a key or a file's content reaches a log line, a
refusal, a `DestinationConfigError` or a thrown message — the broker logs only
fixed words and the destination name. A strategy that throws surfaces as the
provider's refusal (5.3.0 already maps it in fixed words).

## 4. `@mcp-abap-adt/auth-broker-cli`

- `mcp-auth` / `runMcpAuth`: it reads the key itself and builds providers; it
  gains the same choice, stated by the user — a flag naming the client
  authentication (`--client-auth certificate|secret`) and, for `secret`, the
  encoding (`--basic-encoding raw|form`, required with `secret`). No flag →
  4.0.0 behaviour; an x509 key with no flag → an error naming the flag.
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
| stores, unit | a bare and a wrapped x509 key → the authorization config with `''` and the certificate; a secret key → `null` and today's answers; both → refused; `EnvDestinationStore` paths → the files' content; a missing variable → `null`; an unreadable file → fixed words, no content |
| broker, unit | each factory's answer; `uaaProvider` with a strategy → the provider got `clientAuthentication` and no secret, for all three grants; without one → byte-for-byte 4.0.0 (existing tests unchanged); certificate without a strategy → `DestinationConfigError` naming `clientAuthentication`; nothing of a key in a log, error or refusal (a marker test) |
| CLI, unit | the flags; x509 key without a flag → the named error; the `.env` gets paths, never PEM |
| broker stand | unchanged suites green on 5.3.0 |
| broker, unit (added) | a throwing strategy and a malformed PEM → `DestinationConfigError` in fixed words, nothing of the thrown value; a valid secret with unreadable certificate paths and no strategy → the secret provider builds, no file read; old-consumer shape: an x509 key → `getAuthorizationConfig` null (never `''`) |
| trial, live (`test:live`, opt-in) | setup creates an XSUAA instance with an x509 key (exact `cf target` guard, `.local/owned`). (a) `AuthBroker` + `XsuaaServiceKeyStore` + `fromServiceKeyCertificate()` → `getProvider(dest).prepare()` Ok and the token API returns a token whose client id is the key's; (b) `mcp-auth --client-auth certificate` → a token with that client id; (c) `generate-env-from-service-key --client-auth certificate --cert-path … --key-path …` → a destination `.env` with paths only, then a fresh `AuthBroker` over that `.env` from its final location gets a token; (d) a failing run leaves the previous destination file untouched and prints no PEM. Teardown removes everything, also on failure |

Every rule protected by a test is proven load-bearing.

## 7. Documentation

README (both packages): the strategy, the two factories, composing them, the
`.env` variables, the CLI flags; CHANGELOG entries in every package; the
broker's CLAUDE.md where it lists collaborators. Unmeasured: `authorization_code`
and `passcode` over x509, ABAP keys with x509.

## 8. Not in this change

`mcp-abap-adt`; `private_key_jwt`; ABAP service keys with x509; issuing or
rotating certificates; the session store.
