# mcp-abap-adt-auth-broker
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

The per-destination token broker for SAP BTP and ABAP, and the commands that
log in through it. Two packages, one repository.

| package | what it is | depends on |
|---|---|---|
| [`@mcp-abap-adt/auth-broker`](packages/auth-broker) | the library: for a destination name, builds the `IAuthProvider` it states (`getProvider`) from the means in its key store and the secret in its session store, and stores every token or SAML session cookie that provider obtains, bound to the means it was obtained under; and the token API (`getToken`, `refreshToken`, `createTokenRefresher`) on that same provider, or on one you give it. You state how a provider renews and what a failed write means; every call takes a `signal` | the contract packages (`interfaces-auth`, `interfaces-auth-sap`, `interfaces-auth-broker`, `interfaces-utils`), `auth-providers`, `auth-errors` |
| [`@mcp-abap-adt/auth-broker-cli`](packages/auth-broker-cli) | the `mcp-auth` command (subcommands `auth-code`, `oidc`, `saml2-pure`, `saml2-bearer`): service key, session file or named destination; UAA, OIDC, UAA passcode or SAML login, written as a destination — the means through `auth-stores`' destination store, the secret through the broker — to one `.env` file | the library, `auth-stores`, `auth-providers`, `auth-errors` |

## Installing

The library:

```bash
npm install @mcp-abap-adt/auth-broker
```

The commands:

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
```

The current versions are the library's 5.0.0 and the CLI's 3.0.0, which
depends on it (`^5.0.0`); both are on the 6.0 auth chain (`auth-providers` 6,
`interfaces-auth` 7, `auth-errors` 2, `auth-stores` 4). Both are majors:

- **A 4.x consumer of the library**: *Migrating to 5.0.0* in its
  [README](packages/auth-broker/README.md#migrating-to-500) — `renewal` and
  `onWriteFailure` are required for token destinations, failures are
  `AuthProviderFailure`s, and every session written before 5.0.0 reads as
  unbound once (one login per token destination).
- **A 2.x user of the CLI**: *Migrating to 3.0.0* in its
  [README](packages/auth-broker-cli/README.md#migrating-to-300) — the
  `mcp-sso` command is gone (every form is an `mcp-auth` subcommand), a run
  takes one source, and a login waits until you end it.

Up to 3.0.4 the commands shipped in the library package; from 3.1.0 they are
`@mcp-abap-adt/auth-broker-cli`. If you installed the library globally for the
commands:

```bash
npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli
```

Node.js 22, 24 or 26.

## Working in this repository

```bash
npm ci
npm run build      # Biome, then tsc -b over both packages
npm test           # every workspace's Jest suites
npm run check      # build, type checks, lint, dependency graph, shape check, packed tarballs, release tool
```

| Script | What it does |
|---|---|
| `build` | cleans both packages, Biome at error level, `tsc -b` (the CLI references the library) |
| `test` | Jest in each workspace; `npm test -w <package> -- <file> -t "<case>"` for one |
| `test:check` | type-checks both packages, tests included, under the strict flags of `tsconfig.base.json` |
| `lint` / `lint:check` / `format` | Biome over `packages/` and `tools/`; `lint:check` fails on any warning |
| `check:graph` | `tools/check-graph.js`: each package imports only what it may, declares it, and uses what it declares; the library never imports `auth-stores` |
| `check:shape` | `tools/check-provider-shape.mjs` (a byte-identical copy of auth-errors 2.1.1's) with rules 4, 5, 6 over both packages: no type assertion to a contract error, refusal, outcome or failure; no spread or `Object.assign` of an error; a builder's diagnostics only from the listed sites |
| `check:packed` | `tools/check-packed.js`: both packages packed and installed into an empty directory; `mcp-auth` runs with `--version`, `help` and every subcommand's `--help`, and no `mcp-sso` is installed; needs the network |
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

Each package is tagged `<dir>-v<version>`: `auth-broker-v5.0.0`,
`auth-broker-cli-v3.0.0`. The `v*` tags are the library's history up to 3.0.4,
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
(`auth-broker-v5.0.0`, `auth-broker-cli-v3.0.0`), then publish.

Pushing a tag also runs `.github/workflows/release.yml`, which packs the
package the tag names and attaches the tarball to a GitHub release.

## Documentation

[`docs/`](docs/README.md): architecture, installation, usage, testing. Each
package's README covers its own API or commands.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) for both
packages. See [`LICENSE`](LICENSE) and [`COPYING`](COPYING). Contributors:
[`CONTRIBUTORS.md`](CONTRIBUTORS.md).
