# mcp-abap-adt-auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

The per-destination token broker for SAP BTP and ABAP, and the commands that
log in through it. Two packages, one repository.

| package | what it is | depends on |
|---|---|---|
| [`@mcp-abap-adt/auth-broker`](packages/auth-broker) | the library: for a destination name, reads its session and service key from the stores it is given, gets a token from a provider, persists the result | the contract packages (`interfaces-auth`, `interfaces-auth-sap`, `interfaces-utils`) |
| [`@mcp-abap-adt/auth-broker-cli`](packages/auth-broker-cli) | the `mcp-auth` and `mcp-sso` commands: service key, OIDC or SAML login, written to a session file | the library, `auth-stores`, `auth-providers`, the logger |

## Installing

The library:

```bash
npm install @mcp-abap-adt/auth-broker
```

The commands: **`@mcp-abap-adt/auth-broker-cli` is not published yet** — 1.0.0
is released together with `@mcp-abap-adt/auth-broker` 4.0.0. Up to 3.0.4 the
commands shipped in the library package, and that is still where the published
ones are:

```bash
npm install -g @mcp-abap-adt/auth-broker@3.0.4     # today
npm install -g @mcp-abap-adt/auth-broker-cli       # once 1.0.0 is published
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
| `release:publish` | `tools/publish-changed.js` |
| `chrono` | `tools/version-stats.sh` |

`npm run check` does not run Jest: the library's integration suite reads real
session files when `packages/auth-broker/tests/test-config.yaml` exists, and a
release gate must not reach a real system unasked. Where the suites live and
what each needs: [`docs/development/TESTING.md`](docs/development/TESTING.md).

## Releasing

Each package is tagged `<dir>-v<version>`: `auth-broker-v4.0.0`,
`auth-broker-cli-v1.0.0`. The `v*` tags are the library's history up to 3.0.4,
when it was the only package here.

`npm run release:publish` publishes exactly the versions the registry does not
have, in workspace order — the library first, then the CLI — and runs
`npm run check` once. It refuses a dirty tree, a version without its tag, a tag
that is not an ancestor of `HEAD` or whose tree differs from `HEAD`, a
prerelease on `latest`, and moving `latest` backwards. Exit 2 means published
but not yet served by the registry: wait, then re-check. `--dry-run` prints the
plan and changes nothing.

**Until 4.0.0 it refuses for the whole repository**: the CLI's 1.0.0 is on
`main` without its tag, on purpose, so nothing is published before the two
packages go out together.

Pushing a tag also runs `.github/workflows/release.yml`, which packs the
package the tag names and attaches the tarball to a GitHub release.

## Documentation

[`docs/`](docs/README.md): architecture, installation, usage, testing. Each
package's README covers its own API or commands.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) for both
packages. See [`LICENSE`](LICENSE) and [`COPYING`](COPYING). Contributors:
[`CONTRIBUTORS.md`](CONTRIBUTORS.md).
