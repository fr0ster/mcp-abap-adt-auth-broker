# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The version after 1.0.0 is **2.0.0** (major), set in the release that publishes
it with `@mcp-abap-adt/auth-broker` 4.0.0, together with the dependency
`@mcp-abap-adt/auth-broker` `^4.0.0`. Major by this package's own surface: a
flag goes (`--authn-request-id`), a flag changes meaning (`--passcode`, `--cookie`),
invocations that worked now fail (`--passcode` without `--uaa-url`, `bearer`
without a client, `generate-env` without `--grant`), and what a reader of the
output finds changes (the means keys, a public client's empty secret, no
`SAP_UAA_URL` for an OIDC run without `--uaa-url`). See *Migrating from 1.0.0*
in the README.

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
  session (`setAuthorizationConfig`), which the 3.x session stores refuse; no
  session write carries means or the client secret now (H4). The grant-specific
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
  (no provider obtains them), bound to the URL (`SAP_ISSUED_FOR`). No SAML
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
  `client_credentials` for a key whose URL named `authentication` (H1). It
  writes the means and the secret as the commands do, through `getProvider`,
  and `flush()`es.
- **`--format json`** is rendered from the two stores after the secret is
  stored: the 1.x fields, `uaaUrl` being the client's (see above).

### Changed

- **Every collaborator is stated by the CLI** and handed to the broker:
  `authorization` (the passcode and SAML strategies), `oidcAuthorization`,
  `deviceCodePresenter` (`consoleDeviceCodePresenter` on this CLI's logger),
  `samlCookies` and `assertionReplayStore` (`defaultReplayStore`); `mcp-auth`
  states its browser callback strategy. The broker supplies none (H2).
- **The SAML validator is built by the broker** from the trust the destination
  states (`SAP_SAML_IDP_CERTIFICATES_B64`, `SAP_SAML_IDP_ENTITY_ID`) —
  `createSignedResponseValidator` for pure, `createSignedAssertionValidator`
  for bearer; `mcp-sso` writes the trust it collects and still refuses missing
  trust before anything is written.
- **`@mcp-abap-adt/auth-stores` `^3.2.0`** (was `^1.2.3`, decision D7) and
  **`@mcp-abap-adt/auth-providers` `^5.2.1`** (was `^5.1.0`). The dependency on
  `@mcp-abap-adt/auth-broker` stays `^3.1.0` in the tree — the workspace builds
  against the library's 4.0 code — until the release sets `^4.0.0`.
- From 4a, carried into this version: the manual SAML strategy reads through
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
