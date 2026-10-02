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
│   ├── AuthBroker.test.ts               # the token API with a consumer provider (the 3.x
│   │                                    # suite): fake stores and providers, and once
│   │                                    # auth-stores 3's EnvDestinationStore + AbapSessionStore
│   ├── tokenApiShared.test.ts           # the token API on getProvider's provider: one cache,
│   │                                    # one renewal; basic/snc/none refused; write failures
│   ├── connection10.test.ts             # end to end: AdtCloudConnector from getProvider,
│   │                                    # a local 401-then-200 server and token endpoint,
│   │                                    # the token in the session file, then getToken
│   ├── getProvider.test.ts              # getProvider: fake stores, real auth-providers credentials,
│   │                                    # driven only through IAuthProvider
│   ├── getProviderTokens.test.ts        # the UAA grants and their persistence: fake stores,
│   │                                    # real token providers, a local token endpoint
│   ├── getProviderBinding.test.ts       # a stored secret used only where it is bound (issuedFor,
│   │                                    # issuedBy): fake stores and auth-stores 3.1.0's
│   │                                    # AbapSessionStore over a 3.x-shaped file
│   ├── getProviderOidcSaml.test.ts      # the OIDC and SAML grants: fake stores, real providers,
│   │                                    # a local token endpoint, auth-mocks' SAML identity provider
│   └── AuthBroker.integration.test.ts   # real service keys, sessions and providers
├── stand/
│   ├── uaaGrants.test.ts                # the UAA grants against UAA in Docker;
│   ├── oidcGrants.test.ts               # the OIDC grants against Keycloak in Docker;
│   ├── samlGrants.test.ts               # the SAML grants, Keycloak to UAA, in Docker;
│   │                                    # `npm run test:stand` runs the three
│   └── formLogin.ts                     # plays the user on the stand's login pages
├── live/
│   └── getProvider.live.test.ts         # getProvider through connection 10 against real
│                                        # systems; `npm run test:live` only
└── helpers/                             # test configuration, logger, free-port helpers,
                                         # the local token endpoint

packages/auth-broker-cli/src/__tests__/
├── mcpSsoConfig.test.ts                 # CLI flags and --config merged; the means each flow
│                                        # states; every collaborator it hands the broker
├── mcpSsoSamlProviders.test.ts          # the SAML destinations, written and built by the real
│                                        # broker into the real providers: the trust reaches the validator
├── runMcpSso.test.ts                    # mcp-sso end to end, one case per row of the CLI's table:
│                                        # means read back through the key store, the secret alone
│                                        # in every session write, getProvider over the output, flush
├── runMcpAuth.test.ts                   # mcp-auth end to end: the stated strategy, --env refresh,
│                                        # JSON, the XSUAA keys, a write the store refuses
├── generateEnv.test.ts                  # generate-env: --grant required, never inferred
├── samlMetadata.test.ts                 # IdP and SP metadata read into the SAML trust
├── helpers/                             # the local token endpoint, reading what a run wrote
└── fixtures/                            # metadata documents with their identities replaced
```

Each package has its own `jest.config.js` (ts-jest, `maxWorkers: 1`,
`maxConcurrency: 1`: the tests run one at a time, in the order they are
defined). The library's `jest.config.js` ignores `__tests__/live/`;
`jest.live.config.js` runs only that directory.

## What each suite needs

- **`AuthBroker.test.ts`**, **`tokenApiShared.test.ts`**,
  **`connection10.test.ts`**, **`getProvider.test.ts`**,
  **`getProviderTokens.test.ts`**, **`getProviderBinding.test.ts`**,
  **`getProviderOidcSaml.test.ts`** and **every CLI suite**: nothing — no
  network beyond the loopback, no configuration, no browser. The SNC case
  writes a 64-byte ELF header for the host's architecture into a temporary
  directory as its `sncLib`: the locator reads only the header, so no SNC
  product is needed. The UAA grants get their tokens from a token endpoint the
  test starts on `127.0.0.1` (`helpers/tokenEndpoint.ts`, which also serves
  an OIDC discovery document and a device authorization endpoint for the
  OIDC grants), and their interactive half from a recording strategy or
  presenter; the retry of a failed session write runs under Jest's fake
  timers. The SAML grants' assertions come from
  `@mcp-abap-adt/auth-mocks`' identity provider (a dev dependency), started on
  `127.0.0.1` with a key generated per run — one signing the Response, one
  the Assertion alone — and fetched by a test strategy as a browser would;
  nothing in the suite signs a document itself. `connection10.test.ts` runs
  `@mcp-abap-adt/connection` 10 (a dev dependency) over its real HTTP wire
  against a server the test starts on `127.0.0.1`, which answers like ABAP
  Cloud (a session resource, a CSRF token) and refuses with a 401 any bearer
  token the local token endpoint did not issue. The suites that read or write
  files use `@mcp-abap-adt/auth-stores` 3.2 (a dev dependency) in temporary
  directories.
- **`stand/uaaGrants.test.ts`**, **`stand/oidcGrants.test.ts`**,
  **`stand/samlGrants.test.ts`**: the stand (below). Without `UAA_URL` /
  `KEYCLOAK_URL` each is skipped, printing why.
- **`AuthBroker.integration.test.ts`**: a real destination. It reads
  `packages/auth-broker/tests/test-config.yaml`; without it the template
  (`test-config.yaml.template`) is read, its placeholders disable every case,
  and each case returns at once. With it, the cases read the service keys and
  sessions it points at and may open a browser for a login; its stores are
  auth-stores 3's, so a session it seeds holds the secret alone. Copy the template
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

## The stand: UAA and Keycloak in Docker

`packages/auth-broker/tests/stand/` runs Cloud Foundry UAA (`cfidentity/uaa`
v79.7.0) and Keycloak (26.7.4) in Docker, on the loopback address only: real
token endpoints for the token grants `getProvider` builds. It is
`@mcp-abap-adt/auth-providers`' stand copied whole and owned here, so the
broker's tests never depend on another repository: `compose.yaml`, `up.sh` /
`run.sh` / `down.sh`, the UAA configuration (`uaa/config/uaa.yml` — its users,
clients and signing keys), the Keycloak realm (`keycloak/realm-test.json`) and
the test SAML IdP's key (`uaa/idp/`). Those keys and passwords are committed
test fixtures, trusted by nothing but the local stand, so a clone needs only
Docker. `src/__tests__/stand/formLogin.ts` plays the user on UAA's login form
and `/passcode` page and on Keycloak's login, device and consent pages — no
browser is opened.

```bash
npm run test:stand                   # start the stand, run the suites, stop what it started
npm run test:stand -- -t "passcode"  # one case
npm run stand:up                     # or keep it running: start it once …
UAA_URL=http://localhost:8080/uaa KEYCLOAK_URL=http://localhost:8081/realms/test \
  npm test -w @mcp-abap-adt/auth-broker -- src/__tests__/stand
npm run stand:down                   # … and stop it
```

- `run.sh` stops only the servers it started, per service: one already running
  (from `stand:up`, or started by hand) is left running, and one running on
  another port than asked is refused rather than recreated. `STAND_KEEP=1`
  keeps what it started. On a failure it prints the servers' last 200 log lines
  before removing anything. `UAA_PORT` / `KEYCLOAK_PORT` move the ports
  (defaults 8080 / 8081).
- The compose project and containers are named `auth-broker-stand`,
  `auth-broker-uaa`, `auth-broker-keycloak`, so Docker tells this stand from
  auth-providers'; both use the same default ports, so only one runs at a time
  unless one is moved.
- Each suite composes the broker as a consumer does: auth-stores 3's
  `EnvDestinationStore` for the means, its `AbapSessionStore` for the secret,
  each in a temporary directory, and reads the session file back from disk.
  It takes UAA's issuer from its discovery document, never from `UAA_URL`.
- CI runs `npm run test:stand` as its own job (`.github/workflows/ci.yml`,
  `broker-stand`), beside the build-and-test job.

What it covers today: `jwt` / `client_credentials`, `authorization_code`
(UAA's login form) and `passcode` (`/passcode`) — each obtained, written to the
session file as the secret alone with its binding (`SAP_ISSUED_FOR`,
`SAP_ISSUED_BY`, asserted by value), and the two interactive ones renewed by
refresh after a 401; and a session bound to another URL is not reused — the
destination's `serviceUrl` changed, the next broker logs in through UAA's form
again and writes the new binding.

The OIDC grants against Keycloak's `test` realm (`oidcGrants.test.ts`):
`password`, `oidc_authorization_code` (Keycloak's login page, PKCE, a public
client), `device_code` (the consumer's presenter approves the code on
Keycloak's pages) and `token_exchange` (a subject token obtained for another
client, stated as means) — each written with its binding (`SAP_ISSUED_BY` the
realm with `client_id`), renewed after a 401 (by refresh, or for
`token_exchange` by a new exchange), and `password`'s token reused by a new
broker.

The SAML grants, Keycloak as identity provider and UAA as service provider
(`samlGrants.test.ts`): `saml2_pure` end to end — Keycloak's signed
SAMLResponse, validated by the provider, posted by the test's `samlCookies`
to UAA's web SSO ACS, whose session cookie is checked to be a real UAA login;
written as cookies (`SAP_SESSION_COOKIES_B64`, `SAP_ISSUED_BY` the ACS),
reused by a new broker, and renewed by a new login after a 401 — and
`saml2_bearer`: the assertion exchanged at UAA's bearer grant, written as a
token, renewed by refresh. The suite registers Keycloak in UAA from its
metadata, trusts the certificates under `KeyDescriptor use="signing"`, and
points Keycloak's `uaa-sp` client at the ACS each case needs, at run time.

- **Both SAML logins are IdP-initiated** (`samlIdpInitiated: true`; the
  test's strategy hands over the SAMLResponse without asking for an
  AuthnRequest URL). UAA 79.7.0 refuses an assertion whose
  `SubjectConfirmationData` carries an `InResponseTo` it did not send — at the
  bearer grant, and, measured here, at web SSO too, even with
  `login.saml.disableInResponseToCheck: true` (that switch drops the
  Response-level check only).
- **Keycloak's assertion lifespan is set to an hour** on `uaa-sp` (its
  default `Conditions` end a minute after issue, inside a token provider's
  one-minute margin: the stored cookies would count as expired on arrival, and
  every request would log in again).
- **What it does not prove** is SAP ICF's own SAML handling (`SAP_SESSIONID`,
  `MYSAPSSO2`): no system at hand accepts SAML from a test IdP. Nor does it
  tell the two validators apart — Keycloak signs both the Response and the
  Assertion; the unit suite, whose identity providers sign one each, does.

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
| `jwt` / `authorization_code` over HTTP (`AdtCloudConnector`) | any machine that reaches a BTP ABAP environment (trial), with a session holding a refresh token from an earlier login | `AUTH_BROKER_LIVE_SERVICE_KEYS_DIR`, `AUTH_BROKER_LIVE_JWT_DESTINATION`, `AUTH_BROKER_LIVE_SESSIONS_DIR` |

**The `jwt` case** seeds the session with a well-formed JWT the system did not
issue (an `exp` an hour ahead, so the provider trusts it): the first request
is a 401, the provider renews by the stored refresh token in `rejected()`, the
request is answered 200, and after `flush()` the session file holds a new
token. It never logs in — the `authorization` strategy it passes refuses, so
no browser opens — and it never writes the original session file:
`<destination>.env` in `AUTH_BROKER_LIVE_SESSIONS_DIR` is copied to a
temporary directory first. Where the server rotates refresh tokens the run
spends the original's refresh token (not measured for XSUAA); log in again
afterwards.

The destination's means are its SAP service key — `<destination>.json` in
`AUTH_BROKER_LIVE_SERVICE_KEYS_DIR`, the key of the ABAP environment instance
as BTP gives it, read by auth-stores 3's `AbapServiceKeyStore`: the client
(`uaa.url`, `uaa.clientid`, `uaa.clientsecret`) and the ABAP URL the connector
dials. A SAP key cannot state a grant, so the grant is stated by whoever
builds the store: `new AbapServiceKeyStore(dir, { grantType:
'authorization_code' })` (auth-stores 3.1.0). No provider reads the URL: the
connector takes it from the key, and the broker reads it only for the
binding.

**The binding.** The session must be bound to the key (`issuedFor` /
`issuedBy`, see the library README): a file
written before auth-stores 3.1.0 answers `issuedFor` from its `SAP_URL` (+
`SAP_CLIENT`) and `issuedBy` from `SAP_UAA_URL` + `SAP_UAA_CLIENT_ID`, which
the 3.x CLI wrote from the same key. The case writes its refused token under
the binding the file answered, and after the renewal expects the session to
hold `issuedFor` and `issuedBy` again. A file that answers no binding fails the
case before any request, naming the keys; one whose binding is not the key's
is discarded by the broker, the refusing strategy then fails the login, and
the case fails — log in again with the CLI.

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

```bash
# jwt / authorization_code against the BTP ABAP environment (trial): the
# service key service-keys/<destination>.json, the session
# sessions/<destination>.env holding a refresh token from an earlier login
AUTH_BROKER_LIVE_SERVICE_KEYS_DIR=~/.config/mcp-abap-adt/service-keys \
AUTH_BROKER_LIVE_SESSIONS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_JWT_DESTINATION=trial \
npm run test:live -- -t "jwt"
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
Windows as well, and so does `npm run check`. The release tools start npm
through its `npm-cli.js` (`npm_execpath`), never through a shell;
`check:packed` starts the installed bins through their `.cmd` shims on
Windows, and `check:publish` hands the script its fake npm as `npm_execpath`.

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
