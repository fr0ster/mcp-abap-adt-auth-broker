# mcp-abap-adt-auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

The per-destination token broker for SAP BTP and ABAP, and the commands that
log in through it. Two packages, one repository.

| package | what it is | depends on |
|---|---|---|
| [`@mcp-abap-adt/auth-broker`](packages/auth-broker) | the library: for a destination name, builds the `IAuthProvider` it states (`getProvider`) from the means in its key store and the secret in its session store, and stores every token or SAML session cookie that provider obtains; and the token API (`getToken`, `refreshToken`, `createTokenRefresher`) on that same provider, or on one you give it | the contract packages (`interfaces-auth`, `interfaces-auth-sap`, `interfaces-auth-broker`, `interfaces-utils`), `auth-providers` |
| [`@mcp-abap-adt/auth-broker-cli`](packages/auth-broker-cli) | the `mcp-auth` and `mcp-sso` commands: service key, OIDC, UAA passcode or SAML login, written as a destination — the means through `auth-stores`' destination store, the secret through the broker — to one `.env` file | the library, `auth-stores`, `auth-providers`, the logger |

## Installing

The library:

```bash
npm install @mcp-abap-adt/auth-broker
```

The commands:

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
```

Up to 3.0.4 the commands shipped in the library package; from 3.1.0 they are
`@mcp-abap-adt/auth-broker-cli` (1.0.0 on), which depends on the library
`^3.1.0`. Its 2.0.0 is released with the library's 4.0.0 (`^4.0.0`) and writes
a complete 4.0 destination; what changes for a 1.0.0 user is in its
[README](packages/auth-broker-cli/README.md#migrating-from-100). If you
installed the library globally for the commands:

```bash
npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli
```

Node.js 22, 24 or 26.

## Working in this repository

```bash
npm ci
npm run build      # Biome, then tsc -b over both packages
npm test           # every workspace's Jest suites
npm run check      # build, type checks, lint, dependency graph, packed tarballs, release tool
```

| Script | What it does |
|---|---|
| `build` | cleans both packages, Biome at error level, `tsc -b` (the CLI references the library) |
| `test` | Jest in each workspace; `npm test -w <package> -- <file> -t "<case>"` for one |
| `test:check` | type-checks both packages, tests included |
| `lint` / `lint:check` / `format` | Biome over `packages/` and `tools/` |
| `check:graph` | `tools/check-graph.js`: each package imports only what it may, declares it, and uses what it declares; the library never imports `auth-stores` |
| `check:packed` | `tools/check-packed.js`: both packages packed and installed into an empty directory; `mcp-auth` and `mcp-sso` run with `--version` and `help`; needs the network |
| `check:publish` | `tools/test-publish-changed.js`: the release tool against fixture repositories |
| `check` | all of the above but Jest |
| `test:live` | the library's live suite against real systems — not in `test` or `check`; each case skips, printing why, where its variables, platform or RFC SDK are missing ([`TESTING.md`](docs/development/TESTING.md#live-checks-getprovider-against-real-systems)) |
| `test:stand` | the library's token-grant suites against UAA and Keycloak in Docker (`packages/auth-broker/tests/stand`): starts the stand, runs them, stops what it started; CI runs it as its own job. `stand:up` / `stand:down` keep it running between runs ([`TESTING.md`](docs/development/TESTING.md#the-stand-uaa-and-keycloak-in-docker)) |
| `release:publish` | `tools/publish-changed.js` |
| `chrono` | `tools/version-stats.sh` |

`npm run check` does not run Jest: the library's integration suite reads real
session files when `packages/auth-broker/tests/test-config.yaml` exists, and a
release gate must not reach a real system unasked. Where the suites live and
what each needs: [`docs/development/TESTING.md`](docs/development/TESTING.md).

## Releasing

Each package is tagged `<dir>-v<version>`: `auth-broker-v3.1.0`,
`auth-broker-cli-v1.0.0`. The `v*` tags are the library's history up to 3.0.4,
when it was the only package here.

`npm run release:publish` publishes exactly the versions the registry does not
have, in workspace order — the library first, then the CLI — and runs
`npm run check` once. It refuses a dirty tree, a version without its tag, a tag
that is not an ancestor of `HEAD` or whose tree differs from `HEAD`, a
prerelease on `latest`, and moving `latest` backwards. Exit 2 means published
but not yet served by the registry: wait, then re-check. `--dry-run` prints the
plan and changes nothing.

A version with no tag is refused, which is why `release:publish` fails for the
whole repository between a version bump and its tags: tag the merge commit
(`auth-broker-v3.1.0`, `auth-broker-cli-v1.0.0`), then publish.

Pushing a tag also runs `.github/workflows/release.yml`, which packs the
package the tag names and attaches the tarball to a GitHub release.

## Documentation

[`docs/`](docs/README.md): architecture, installation, usage, testing. Each
package's README covers its own API or commands.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) for both
packages. See [`LICENSE`](LICENSE) and [`COPYING`](COPYING). Contributors:
[`CONTRIBUTORS.md`](CONTRIBUTORS.md).
