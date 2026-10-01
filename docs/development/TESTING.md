# Testing

How this repository is tested: where each suite lives, what it needs, and the
checks that run before a release.

The repository is an npm workspace with two packages, `packages/auth-broker`
(the library) and `packages/auth-broker-cli` (the `mcp-auth` and `mcp-sso`
commands). Every command below runs from the repository root, where the dev
dependencies are installed.

## Where the suites live

```
packages/auth-broker/src/__tests__/
├── broker/
│   ├── AuthBroker.test.ts               # the broker against fake stores and providers,
│   │                                    # and once against a real AbapSessionStore on disk
│   └── AuthBroker.integration.test.ts   # real service keys, sessions and providers
└── helpers/                             # test configuration, logger, free-port helpers

packages/auth-broker-cli/src/__tests__/
├── mcpSsoConfig.test.ts                 # CLI flags and --config merged into a provider config
├── mcpSsoSamlProviders.test.ts          # those configs handed to the real auth-providers SAML providers
├── samlMetadata.test.ts                 # IdP and SP metadata read into the SAML trust
└── fixtures/                            # metadata documents with their identities replaced
```

Each package has its own `jest.config.js` (ts-jest, `maxWorkers: 1`,
`maxConcurrency: 1`: the tests run one at a time, in the order they are
defined).

## What each suite needs

- **`AuthBroker.test.ts`** and **every CLI suite**: nothing — no network, no
  configuration, no browser.
- **`AuthBroker.integration.test.ts`**: a real destination. It reads
  `packages/auth-broker/tests/test-config.yaml`; without it the template
  (`test-config.yaml.template`) is read, its placeholders disable every case,
  and each case returns at once. With it, the cases read the service keys and
  sessions it points at and may open a browser for a login. Copy the template
  and fill in:
  - `auth_broker.paths.service_keys_dir` — directory of `{destination}.json`
  - `auth_broker.paths.sessions_dir` — directory of `{destination}.env`
  - `auth_broker.abap.destination` — ABAP destination name (e.g. `trial`)
  - `auth_broker.xsuaa.btp_destination`, `auth_broker.xsuaa.mcp_url` — for the
    XSUAA cases

  Before the workspace layout this file lived at `tests/test-config.yaml` in
  the repository root; move an existing copy.

## Running

```bash
# Every workspace's tests
npm test

# One package
npm test -w @mcp-abap-adt/auth-broker
npm test -w @mcp-abap-adt/auth-broker-cli

# One file, or one case
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts -t "name of the case"
```

`DEBUG_BROKER=true` (or `DEBUG_AUTH_BROKER=true`) turns on the test logger.

## The checks

`npm run check` is the release gate; `npm run release:publish` runs it once,
and each package's `prepublishOnly` runs it too:

| Script | What it proves |
|---|---|
| `npm run build` | Biome at error level, then `tsc -b` over both packages (the CLI references the library) |
| `npm run test:check` | both packages type-check, tests included |
| `npm run lint:check` | Biome over `packages/` and `tools/` |
| `npm run check:graph` | each package imports only what its allowlist permits, declares it, and uses every runtime dependency it declares; tests import only declared dependencies; the library never imports `auth-stores` |
| `npm run check:packed` | the bin smoke check: both packages packed and installed into an empty directory, `mcp-auth` and `mcp-sso` run with `--version` (the CLI's version) and `help`, the library loads with no `bin`. Needs the network, and says so when it cannot reach it |
| `npm run check:publish` | `tools/publish-changed.js` exercised against fixture repositories and a fake npm |

`npm run check` does not run Jest: the library's integration suite reads real
session files when configured, and a release gate must not reach a real system
unasked. Run `npm test` beside it.

## Interactive stands (CLI)

Not part of `npm test`; run by hand, each needs a browser or a deployed app:

| Script (`-w @mcp-abap-adt/auth-broker-cli`) | What it runs |
|---|---|
| `test:device-code`, `test:saml-pure`, `test:sso` | `mcp-sso` against a local Keycloak (`packages/auth-broker-cli/tests/keycloak`) |
| `test:mcp-auth`, `test:mcp-sso` | `mcp-auth` against the CAP demo on BTP (`packages/auth-broker-cli/tests/sso-demo`) |
