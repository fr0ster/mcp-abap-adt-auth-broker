# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
