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
│   ├── getProvider.test.ts              # getProvider: fake stores, real auth-providers credentials,
│   │                                    # driven only through IAuthProvider
│   └── AuthBroker.integration.test.ts   # real service keys, sessions and providers
├── live/
│   └── getProvider.live.test.ts         # getProvider through connection 10 against real
│                                        # systems; `npm run test:live` only
└── helpers/                             # test configuration, logger, free-port helpers

packages/auth-broker-cli/src/__tests__/
├── mcpSsoConfig.test.ts                 # CLI flags and --config merged into a provider config
├── mcpSsoSamlProviders.test.ts          # those configs handed to the real auth-providers SAML providers
├── samlMetadata.test.ts                 # IdP and SP metadata read into the SAML trust
└── fixtures/                            # metadata documents with their identities replaced
```

Each package has its own `jest.config.js` (ts-jest, `maxWorkers: 1`,
`maxConcurrency: 1`: the tests run one at a time, in the order they are
defined). The library's `jest.config.js` ignores `__tests__/live/`;
`jest.live.config.js` runs only that directory.

## What each suite needs

- **`AuthBroker.test.ts`**, **`getProvider.test.ts`** and **every CLI suite**:
  nothing — no network, no configuration, no browser. The SNC case writes a
  64-byte ELF header for the host's architecture into a temporary directory as
  its `sncLib`: the locator reads only the header, so no SNC product is needed.
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

## Live checks: getProvider against real systems

`packages/auth-broker/src/__tests__/live/getProvider.live.test.ts` hands the
provider `getProvider` builds to a `@mcp-abap-adt/connection` 10 connector and
reads `/sap/bc/adt/compatibility/graph` from a real system. It is not part of
`npm test` or `npm run check`; run it with

```bash
npm run test:live                               # every case
npm run test:live -- -t "basic over HTTP"       # one case
```

from the repository root (or `npm run test:live` in `packages/auth-broker`).

Each case states where it runs and reads only the environment variables it
names — there is no configuration file. Where a condition does not hold, the
case is skipped with the reason in its title, and the reason and each result
go through `@mcp-abap-adt/logger`'s `DefaultLogger` — the logger the other
suites use (`createTestLogger`), level from `AUTH_LOG_LEVEL`. (Jest 30 shows
only a summary when it runs under an AI agent — `AI_AGENT`, `CLAUDECODE` and
the like; `--reporters=default` restores the full report.)

```
[INFO] ℹ️ skipped: snc over RFC — Windows or macOS with the SAP Secure Login Client logged on (getProvider → rfcConversationFrom) — the SAP Secure Login Client exists only on Windows and macOS; this is linux
```

A skip is not a failure: it says this machine is not the one the case is for.
Only status codes and response sizes are printed — never a value from the store.

| Case | Runs where | Variables |
|---|---|---|
| `basic` over HTTP | any machine that reaches an on-premise system | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_BASIC_DESTINATION` |
| `basic` over RFC (`rfcConversationFrom`) | a machine with the SAP NW RFC SDK and `@mcp-abap-adt/sap-rfc-lite` built against it, that reaches the system's RFC gateway | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_RFC_DESTINATION`; optional `SAP_SYSNR` |
| `snc` over RFC | Windows or macOS with an SNC library installed (the SAP Secure Login Client, logged on), the NW RFC SDK and `sap-rfc-lite` — on Windows or macOS with no SNC library it skips, naming every place it looked | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_SNC_DESTINATION`; optional `SAP_SYSNR` |

The `jwt` / `authorization_code` case of the plan (a token the system refuses,
renewed in `rejected()`, the new token in the session file) needs the token
providers `getProvider` builds from step 4c, and is added with them.

**The destinations.** `AUTH_BROKER_LIVE_KEYS_DIR` is a directory of
`<destination>.env` files read by auth-stores 3's `EnvDestinationStore` — the
means, in its `SAP_*` keys. The connector dials the same destination's
`SAP_URL` and `SAP_CLIENT`. A `basic` destination:

```bash
SAP_URL=http://127.0.0.1:8000
SAP_CLIENT=100
SAP_AUTH_TYPE=basic
SAP_USERNAME=DEVELOPER
SAP_PASSWORD='...'
```

An `snc` destination states the system's SNC name instead of a user; the
library is found as the Secure Login Client installs it unless `SAP_SNC_LIB`
names it:

```bash
SAP_URL=https://host.example:44300
SAP_CLIENT=100
SAP_AUTH_TYPE=snc
SAP_SNC_PARTNERNAME='p:CN=SID, O=ORG, C=DE'
# optional: SAP_SNC_QOP=9, SAP_SNC_LIB=<path>, SAP_SNC_MYNAME=p:CN=ME
```

A 3.x session file of a `basic` destination (`SAP_URL`, `SAP_USERNAME`,
`SAP_PASSWORD`, `SAP_CLIENT`) serves as it is once it states
`SAP_AUTH_TYPE=basic`: the store reads only its means keys.

**RFC.** The RFC address is the host of `SAP_URL`; the system number is taken
from its port by the SAP convention (`80NN` → `NN`) unless `SAP_SYSNR` is set
(connection 10's `rfcParamsFrom`). `@mcp-abap-adt/sap-rfc-lite` is
connection's optional dependency: `npm ci` builds it only when `SAPNWRFC_HOME`
points at the SDK, and leaves it out without failing otherwise — then the RFC
cases skip, naming why.

### On this Linux machine (HTTP and RFC)

```bash
# basic over HTTP, through the E19 tunnel (127.0.0.1:8000, HTTP only)
AUTH_BROKER_LIVE_KEYS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_BASIC_DESTINATION=e19-tunnel \
npm run test:live -- -t "basic over HTTP"

# basic over RFC: build the addon against the SDK once, then run
export SAPNWRFC_HOME=~/sap/nwrfcsdk
# Homebrew's Node ships its own glibc: give it the system libuuid
mkdir -p ~/.local/lib/sap-rfc-lite
ln -sf /lib/x86_64-linux-gnu/libuuid.so.1 ~/.local/lib/sap-rfc-lite/
export LD_LIBRARY_PATH="$HOME/.local/lib/sap-rfc-lite:$SAPNWRFC_HOME/lib:$LD_LIBRARY_PATH"
npm ci                                          # builds sap-rfc-lite now that the SDK is found
AUTH_BROKER_LIVE_KEYS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_RFC_DESTINATION=<a basic destination whose SAP_URL host is the RFC host> \
npm run test:live -- -t "basic over RFC"
```

The E19 tunnel forwards HTTP only, so `e19-tunnel` cannot serve the RFC case:
name a destination whose `SAP_URL` host is reachable on the RFC gateway port
(`33NN`), with `SAP_SYSNR` when its HTTP port does not follow `80NN`.

### On Windows (SNC)

**Keep the checkout's path short.** The lockfile nests some packages deep
(`node_modules\jest\node_modules\jest-cli\…\jest-haste-map\node_modules\@parcel\watcher`
is about 200 characters on its own), and npm runs their install scripts with
that directory as the working directory, which Windows limits to 260
characters (`MAX_PATH`). Under a root such as
`C:\Users\<name>\projects\mcp-abap-adt-auth-broker`, `npm ci` fails with
`npm error enoent spawn C:\WINDOWS\system32\cmd.exe ENOENT` and a `path` deep
in `node_modules`. Run from a short root instead, e.g. a worktree:

```powershell
git worktree add C:\ab <branch>                 # then run everything below in C:\ab
```

Log on to the SAP Secure Login Client first. Install the SAP NW RFC SDK and
put its `lib` on `PATH`, then:

```powershell
$env:SAPNWRFC_HOME = 'C:\nwrfcsdk\nwrfcsdk'
$env:PATH = "$env:SAPNWRFC_HOME\lib;$env:PATH"
npm ci                                          # builds sap-rfc-lite against the SDK

$env:AUTH_BROKER_LIVE_KEYS_DIR = "$HOME\Documents\mcp-abap-adt\sessions"
$env:AUTH_BROKER_LIVE_SNC_DESTINATION = '<an snc destination>'
npm run test:live '--' -t 'snc over RFC'
```

In PowerShell quote the `--`: unquoted, PowerShell consumes it, npm takes
`-t` for its own option, and Jest receives only the bare words. The test and
build scripts run on any platform (`cross-env` sets `NODE_OPTIONS`, `clean`
is plain Node), so `npm test`, `npm run test:live` and `npm run build` work on
Windows as well. `check:packed` and `check:publish` do not yet: they spawn
`npm` and the bins without a shell, which Windows requires for `.cmd` shims.

The `basic` cases run there too with their variables set. On macOS the SNC
case runs the same way (`export` instead of `$env:`, `DYLD_LIBRARY_PATH` for
the SDK's `lib`).

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
