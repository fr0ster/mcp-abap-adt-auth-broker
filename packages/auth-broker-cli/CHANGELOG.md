# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`@mcp-abap-adt/auth-providers` `^5.1.0`** (was `^4.2.0`), whose providers
  build no collaborator of their own. Commands, flags and the files they
  write are unchanged; `mcp-sso` now hands each provider what 4.x defaulted:
  - the OIDC device flow gets `consoleDeviceCodePresenter`, writing where to
    go and the code to enter to this CLI's logger, as before;
  - the SAML flows get an `assertionValidator` built from the trust the CLI
    collects (`--idp-cert`, `--idp-entity-id`, `--idp-metadata`, or
    `idpCertificates` / `idpEntityId` in `--config`):
    `createSignedAssertionValidator` for `bearer` — the token endpoint is sent
    the Assertion alone — and `createSignedResponseValidator` for `pure`, both
    with the process-wide `defaultReplayStore`. A missing certificate or
    entity ID is still a `ValidationError` naming each field, now raised by
    the CLI before any provider is built;
  - the manual SAML strategy reads through `read(prompt, signal)`, and
    `readManualInput` rejects and closes its `readline` when the signal
    aborts, so an abandoned read no longer holds stdin.
- `@mcp-abap-adt/auth-stores` stays `^1.2.3`. Its 3.0.0 session stores refuse
  the means (`serviceUrl`, the client) these commands write into the session,
  and `getAuthorizationConfig` there answers `null`; moving to it is the
  change that writes a destination's means to a key store instead.

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
