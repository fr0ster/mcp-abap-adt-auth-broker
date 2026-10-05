# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Built under a stricter compiler**, as `@mcp-abap-adt/auth-broker`:
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, sources and
  tests. No behaviour changes: every flag, message, exit code and written file
  is as before. Argument parsing reads each value once and tests it instead of
  the index bound; a destination's stated means, a strategy's options and a
  provider's configuration keep the keys they had (`redirectUri: undefined`,
  `port: undefined` included).
- Lint: `noExplicitAny` is an error outside the tests, and `lint:check` fails
  on any warning.

## [2.1.0] - 2026-10-05

The commands on `@mcp-abap-adt/auth-broker` 4.1.0 (`^4.1.0`, released
together): x509 service keys. Every 2.0.0 invocation runs as before.

### Added

- **`--client-auth certificate|secret`** for `mcp-auth` and
  `generate-env-from-service-key`, under the same rules: never inferred from
  the key; no flag is the client secret, as 2.0.0.
  - `--client-auth certificate --cert-path <path> --key-path <path>`: the
    key's x509 client — its certificate and private key from the user's own
    PEM files (existing, resolved to absolute paths before anything is
    written), presented at the key's `certurl`. The destination states the
    paths and `certurl` — `SAP_UAA_CLIENT_CERT_PATH`,
    `SAP_UAA_CLIENT_KEY_PATH`, `SAP_UAA_CERT_URL` (`XSUAA_UAA_*` with
    `--type xsuaa` / an XSUAA key) — and no client secret; never PEM.
    `--format json` adds `uaaUrl`, `uaaClientId`, `uaaClientCertPath`,
    `uaaClientKeyPath`, `uaaCertUrl`.
  - `--client-auth secret --basic-encoding raw|form`: the secret in a Basic
    header; the encoding is required (`raw` for XSUAA).
  - Each flag only with its choice, and each choice with its flags, checked
    before anything is read or written; refusals name the flag.
- An x509 key (a certificate, no secret) run without `--client-auth` is
  refused, naming the flags it needs; `--client-auth certificate` for a key
  without a certificate client is refused, naming its fields.

### Changed

- **No copy of key material, whatever the flags.** A `credentials`-wrapped
  key carrying a `certificate` or `key` field is read in place (by
  `XsuaaServiceKeyStore`) instead of unwrapped into the work directory; an
  ABAP-format key carrying one is read by `XsuaaServiceKeyStore`, the store
  that answers a certificate client. A key without such fields keeps 2.0.0's
  handling.
- **A JSON file that does not parse is refused in fixed words**: `The service
  key <path> cannot be read as JSON` (`mcp-auth`, `generate-env`), `The config
  file <path> cannot be read as JSON` (`mcp-sso --config`) — the parser's
  message quoted the file, which holds a client secret or a private key. Exit
  code `1`, as before.
- **The no-client refusals say why**: `mcp-auth`'s `Authorization config not
  found … url fields` ends `; a client certificate needs --client-auth
  certificate.`; `generate-env`'s `Missing authorization config for <d>` adds
  the same hint for a key carrying a certificate.
- **A rerun reuses the session with `--client-auth`**: the broker binds it to
  the client's identity, and a resource neither side states matches, so an
  XSUAA destination written without `--service-url` reuses its refresh token
  on a rerun with `--env` (without `--client-auth`, as 2.0.0, it logs in
  again).

### Dependencies

`@mcp-abap-adt/auth-broker` `^4.1.0` (was `^4.0.0`),
`@mcp-abap-adt/auth-stores` `^3.3.0` (was `^3.2.0`),
`@mcp-abap-adt/auth-providers` `^5.3.0` (was `^5.2.1`),
`@mcp-abap-adt/interfaces-auth` `^3.2.0` (new: the `IAuthorizationStrategy`
types the commands now name).

### Migrating from 2.0.0

Nothing is required. A script that matched the messages above should match
the exit code. A server reading a destination written with `--client-auth
certificate` needs `@mcp-abap-adt/auth-broker` 4.1.0 with
`clientAuthentication: fromServiceKeyCertificate()` and auth-stores 3.3.0; an
older reader finds a client without a secret and refuses it.

### Measured, and not

Measured on a BTP trial, 2026-10-05: `mcp-auth --credential --client-auth
certificate` and `generate-env --grant client_credentials --client-auth
certificate` against XSUAA, a fresh broker over each written destination, and
a failing run that leaves the destination untouched and prints no PEM. Not
measured: `authorization_code` over x509, ABAP environment keys with x509.
`mcp-sso` has no `--client-auth`.

### Known limitations (unchanged since 2.0.0)

- The output is replaced by a copy (`copyFileSync`), not an atomic rename.
- `generate-env` names a `credentials`-wrapped ABAP key's variables `XSUAA_*`
  (it reads the format from the key's top level).
- `generate-env` takes an option it does not know as a positional argument.

## [2.0.0] - 2026-10-02

The commands on `@mcp-abap-adt/auth-broker` 4.0.0 (`^4.0.0`, released
together). Major by this package's own surface: a flag goes
(`--authn-request-id`), flags change meaning (`--passcode`, `--cookie`),
invocations that worked now fail (`--passcode` without `--uaa-url`, `bearer`
without a client, `generate-env` without `--grant`), and what a reader of the
output finds changes (the means keys, a public client's empty secret, no
`SAP_UAA_URL` for an OIDC run without `--uaa-url`).

### Breaking — in short

- Every command writes a complete 4.0 destination: the means through
  `EnvDestinationStore`, the secret through the broker, into the same
  `<destination>.env`; the output is written only once the secret is stored.
- `--flow password --passcode` is the UAA passcode grant; `--cookie` is a
  `saml` / `none` destination; `bearer` needs its client; `--authn-request-id`
  is refused; `generate-env` needs `--grant`.
- A public client is `SAP_UAA_CLIENT_SECRET=` (empty); OIDC endpoints are
  under `SAP_OIDC_*`, not `SAP_UAA_URL`.

### Migrating from 1.0.0

- **Install:** `npm i -g @mcp-abap-adt/auth-broker-cli@2` — it brings
  `@mcp-abap-adt/auth-broker` 4, `@mcp-abap-adt/auth-stores` 3 and
  `@mcp-abap-adt/auth-providers` 5.
- **Flags:** replace `--authn-request-id` with `--idp-initiated` or a request
  `mcp-sso` sends; give `--passcode` a `--uaa-url` (or `--service-key`) and
  `--client-id`; give `bearer` `--uaa-url` and `--client-id` (or
  `--service-key`); give `generate-env` `--grant authorization_code` or
  `--grant client_credentials`; pass `--issuer` to an OIDC run whose token a
  server should reuse.
- **Files:** a file written by 1.0.0 and passed with `--env` is read where it
  is and restated by the run. Whatever reads the output (a server on
  `@mcp-abap-adt/auth-broker` 4) composes `EnvDestinationStore` and a session
  store over the same directory; a reader of the 1.x keys finds them under the
  same names, plus `SAP_AUTH_TYPE`, `SAP_GRANT_TYPE`, `SAP_EXPIRES_AT`,
  `SAP_ISSUED_FOR` / `SAP_ISSUED_BY` and the grant's `SAP_OIDC_*` /
  `SAP_SAML_*`.
- **Exit codes:** still `0` success, `1` failure — and now `1`, with
  `--output` left as it was, when the broker's `flush()` reports the secret not
  stored.

Details, per change:

### Changed — breaking

- **Each command writes a complete 4.0 destination: the means to a key store,
  the secret through the broker.** The means — `SAP_AUTH_TYPE`,
  `SAP_GRANT_TYPE`, the grant's data (`SAP_OIDC_*`, `SAP_SAML_*`,
  `SAP_USERNAME` / `SAP_PASSWORD`), the client and `SAP_URL` — go through
  `EnvDestinationStore.setDestination` before the login. The secret — the token
  or cookies, `SAP_EXPIRES_AT`, the refresh token, `SAP_ISSUED_FOR` /
  `SAP_ISSUED_BY` — reaches the session store only through the broker's
  persistence: `mcp-sso` and `generate-env` through the provider
  `getProvider` builds for the destination, `mcp-auth` through the token API
  with its own provider. Both stores share `<destination>.env` (`XSUAA_*` with
  `--type xsuaa`), each touching its own keys. 1.0.0 wrote the client into the
  session (`setAuthorizationConfig`), which auth-stores 3's session stores refuse; no
  session write carries means or the client secret now. The grant-specific
  means a run does not state are removed from a file passed with `--env`.
- **`broker.flush()` before the output is written.** A command works in a
  private temporary directory and copies the destination to `--output` only
  once the secret is stored; a secret the store does not take exits `1` and
  leaves `--output` as it was. The output is created `0600`.
- **`mcp-sso oidc --flow password --passcode`** is the UAA `passcode` grant
  (`UaaPasscodeProvider`): `SAP_GRANT_TYPE=passcode`, the client from
  `--uaa-url` and `--client-id` (or `--service-key`), the code through a static
  strategy — never stored. `--flow password` with neither `--password` nor
  `--username` asks for the passcode through `manualPasscodeStrategy`, which
  shows `<uaa>/passcode`. 1.0.0 sent it as the password grant with the user
  `passcode` and stored it as a password, which a one-time code cannot renew.
- **`mcp-sso saml2 --flow pure --cookie`** is a `saml` / `none` destination:
  `SAP_URL` as means, the handed-over cookies stored by the command itself
  (no provider obtains them), with the binding the broker's `bindingOf`
  computes from the destination's means — the resource with its SAP client
  (`SAP_ISSUED_FOR`); the CLI composes no binding of its own. No SAML
  login runs, and no trust is required.
- **`mcp-sso bearer`** writes its client (`SAP_UAA_URL`, `SAP_UAA_CLIENT_ID`,
  `SAP_UAA_CLIENT_SECRET`), which the broker requires: `--uaa-url` and
  `--client-id`, or `--service-key`.
- **`--authn-request-id` is refused.** The broker builds the SAML provider from
  the destination alone, and neither `IConnectionConfig` nor the broker's
  options carry a request ID, so an `--assertion` answering a request sent
  elsewhere cannot be validated. `--idp-initiated`, or a request `mcp-sso`
  sends, still work.
- **A public client is written as `SAP_UAA_CLIENT_SECRET=`** (the secret `''`),
  and read back as one, instead of `__public__` stripped from the output.
- **`mcp-sso` OIDC runs state their endpoints under `SAP_OIDC_*`**;
  `SAP_UAA_URL` is `--uaa-url` only (1.0.0 wrote the token endpoint or the
  issuer there). A destination with endpoints alone binds its token to no
  issuer, so `getProvider` does not reuse it: pass `--issuer`.
- **`generate-env` takes the grant from `--grant`** (`authorization_code` or
  `client_credentials`) and refuses without it; 1.0.0 chose
  `client_credentials` for a key whose URL named `authentication`, inferring the
  grant from the key's shape. It
  writes the means and the secret as the commands do, through `getProvider`,
  on a copy in a private temporary directory, and replaces the session file
  (the exact session path given) only after `flush()` succeeds: a refused or
  cancelled login leaves it byte for byte as it was. 1.0.0 wrote into the
  sessions directory as it went.
- **`--format json`** is rendered from the two stores after the secret is
  stored: the 1.x fields, `uaaUrl` being the client's (see above).

### Changed

- **Every collaborator is stated by the CLI** and handed to the broker:
  `authorization` (the passcode and SAML strategies), `oidcAuthorization`,
  `deviceCodePresenter` (`consoleDeviceCodePresenter` on this CLI's logger),
  `samlCookies` and `assertionReplayStore` (`defaultReplayStore`); `mcp-auth`
  states its browser callback strategy. The broker supplies none.
- **The SAML validator is built by the broker** from the trust the destination
  states (`SAP_SAML_IDP_CERTIFICATES_B64`, `SAP_SAML_IDP_ENTITY_ID`) —
  `createSignedResponseValidator` for pure, `createSignedAssertionValidator`
  for bearer; `mcp-sso` writes the trust it collects and still refuses missing
  trust before anything is written.
- **`@mcp-abap-adt/auth-broker` `^4.0.0`** (was `^3.1.0`),
  **`@mcp-abap-adt/auth-stores` `^3.2.0`** (was `^1.2.3`) and
  **`@mcp-abap-adt/auth-providers` `^5.2.1`** (was `^5.1.0`).
- The manual SAML strategy reads through
  `read(prompt, signal)`, and `readManualInput` rejects and closes its
  `readline` when the signal aborts.

## [1.0.0] - 2026-10-01

### Added

- **The package.** `mcp-auth` and `mcp-sso`, moved out of
  `@mcp-abap-adt/auth-broker`, where they shipped up to 3.0.4 — its
  [CHANGELOG](../auth-broker/CHANGELOG.md) holds their history. Commands and
  flags are unchanged. Released together with `@mcp-abap-adt/auth-broker`
  3.1.0, the first version without them, which this package depends on
  (`^3.1.0`). Whoever installed the library globally for the commands:
  `npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli`.

### Changed

- **`AuthBroker` is imported from `@mcp-abap-adt/auth-broker`**, not
  `require`d from `../index.js`, a path into the library's `dist` that held only
  while both lived in one package.
- **`--version` prints this package's version**, read from its own manifest;
  it used to fall back to the library's.
- **The commands compile to `dist/mcp-auth.js` and `dist/mcp-sso.js`** (were
  `dist/bin/`); the stand scripts under `tests/` run them from there.
