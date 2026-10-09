# Testing

How this repository is tested: where each suite lives, what it needs, and the checks that run
before a release.

The repository is an npm workspace with two packages, `packages/auth-broker` (the library,
5.0.0) and `packages/auth-broker-cli` (the `mcp-auth` command, 3.0.0). Every command below runs
from the repository root, where the dev dependencies are installed. Never run `npx jest`
directly: the npm scripts set `--experimental-vm-modules`, without which the suites do not load.

## Where the suites live

```
packages/auth-broker/src/__tests__/
├── broker/
│   ├── getProvider.test.ts              # every row through IAuthProvider: fake stores, real providers
│   ├── getProviderTokens.test.ts        # the UAA grants and what they persist: a local token endpoint
│   ├── getProviderBinding.test.ts       # a stored secret used only where it is bound; 4.x records unbound
│   ├── getProviderOidcSaml.test.ts      # the OIDC and SAML grants: discovery, device flow, auth-mocks' IdP
│   ├── bindingRecord.test.ts            # the version-2 record and trust digest; round trips through
│   │                                    # every auth-stores 4 session store
│   ├── identityRebuild.test.ts          # a changed value builds a new provider that starts with nothing;
│   │                                    # restarts on the same files
│   ├── buildIdentity.test.ts            # what a build read, compared exactly
│   ├── consumerIdentity.test.ts         # the consumer path's identity; an instance refused after a change
│   ├── twoPaths.test.ts                 # the row path and the consumer path: two slots, two providers
│   ├── sessionWrites.test.ts            # what one write states; the refresh token a build owns; restarts
│   ├── writeQueue.test.ts               # in order, one at a time; a failed write pending; 'fail' / 'continue';
│   │                                    # the check before success; flush()
│   ├── ownedAfterDiscard.test.ts        # a discard makes the owned refresh token none
│   ├── renewal.test.ts                  # renewal required, called once per build, its answer passed through
│   ├── cancellation.test.ts             # every wait raced against its caller's signal; attach; ports bound
│   ├── errors.test.ts                   # failures relayed as the same object; a second auth-errors copy;
│   │                                    # DestinationConfigError carrying the provider's failure
│   ├── debug.test.ts                    # authDebug only for true; no DEBUG_* variable read; no server text
│   ├── sources.test.ts                  # source rules over src: no timers, no error instanceof / message
│   ├── clientAuthentication*.test.ts    # the strategy, its factories, every client row, its binding
│   ├── tokenApiShared.test.ts           # the token API on getProvider's provider
│   ├── tokenProviderFactory.test.ts     # the factory: handed no stored secret, the fourth argument
│   ├── ownKeys.test.ts                  # the exact own keys of what the broker hands out and writes
│   ├── connection14.test.ts             # end to end: an AdtCloudConnector from getProvider over a local
│   │                                    # 401-then-200 server and token endpoint
│   ├── AuthBroker.test.ts               # the token API with a consumer provider
│   └── AuthBroker.integration.test.ts   # real service keys, sessions and providers (opt-in)
├── stand/
│   ├── uaaGrants.test.ts                # the UAA grants against UAA in Docker
│   ├── oidcGrants.test.ts               # the OIDC grants against Keycloak in Docker
│   └── samlGrants.test.ts               # the SAML grants, Keycloak to UAA, in Docker
├── live/
│   ├── getProvider.live.test.ts         # getProvider through connection 14 against real systems
│   └── x509.live.test.ts                # an x509 XSUAA key through the broker and the CLI
├── tools/
│   └── shapeCheckCopy.test.ts           # tools/check-provider-shape.mjs is auth-errors 2.1.1's, byte for byte
└── helpers/                             # fake stores, the local token endpoint, test logger, ports

packages/auth-broker-cli/src/__tests__/
├── subcommandArgs.test.ts               # one command: every 2.x mcp-sso form, as its mcp-auth form, parses
│                                        # as 2.1.0's parser did (helpers/mcpSso210.ts, the oracle);
│                                        # --protocol refused, --dev unknown, only the mcp-auth bin
├── sources.test.ts                      # --service-key / --env / --destination; the folder order
├── runMcpAuth.test.ts                   # mcp-auth end to end: state + PKCE, --env reuse, JSON, XSUAA keys,
│                                        # --client-auth, a write the store refuses
├── runMcpSso.test.ts                    # oidc / saml2-pure end to end, one case per row of the CLI's table
├── generateEnv.test.ts                  # generate-env: --grant required, always a login, --client-auth
├── interrupt.test.ts                    # SIGINT / SIGTERM during each kind of login: 130 / 143, the port
│                                        # bound afterwards, the work directory gone, listeners removed
├── outputStreams.test.ts                # the built bin: stdout only help and --version; nothing secret on
│                                        # either stream
├── printFailure.test.ts                 # failures in fixed words, no stack; no @mcp-abap-adt/logger
├── authDebugFlag.test.ts                # --auth-debug wired in every subcommand; no environment variable
├── browser.test.ts                      # every cell of the browser table; other platforms refused
├── samlAcs.test.ts                      # a pasted SAML login declares its ACS; no localhost fallback
├── terminalPrompts.test.ts              # prompts on stderr, the question after the URL
├── mcpSsoConfig.test.ts                 # flags and --config merged; the means each flow states
├── mcpSsoSamlProviders.test.ts          # the SAML destinations built by the real broker into real providers
├── samlMetadata.test.ts                 # IdP and SP metadata through the XML parser; redirects checked
├── fileVariables.test.ts                # a session file's own lines, read as dotenv reads them
├── stand/                               # the built bin against the stand (below)
│   ├── authorizationCode.test.ts        # UAA: browser login through the fake browser, SIGINT / SIGTERM,
│   │                                    # --browser none, a revoked refresh token, --env reuse
│   ├── deviceCode.test.ts               # Keycloak: oidc --flow device, the code read from stderr
│   ├── samlManual.test.ts               # Keycloak as IdP: saml2-pure --assertion-flow manual,
│   │                                    # saml2-bearer --idp-initiated, the SAMLResponse on stdin
│   ├── uaaProxy.test.ts                 # the proxy closes what it opened upstream (no stand needed)
│   └── cliStand.ts                      # the bin as a child, the fake browser, the recording UAA proxy
├── helpers/                             # the local token endpoint, reading what a run wrote, the oracle
└── fixtures/                            # metadata documents and test certificates (trusted by nothing)
```

Each package has its own `jest.config.js` (ts-jest, `maxWorkers: 1`, `maxConcurrency: 1`: the
tests run one at a time). The library's `jest.config.js` ignores `__tests__/live/`;
`jest.live.config.js` runs only that directory.

## What each suite needs

- **The library's `broker/` suites and every CLI suite outside `stand/`**: nothing — no network beyond the
  loopback, no configuration, no browser. Stores are in-memory fakes of the contract, or
  `@mcp-abap-adt/auth-stores` 4 (a dev dependency) in temporary directories. Token grants talk to
  a token endpoint the test starts on `127.0.0.1` (`helpers/tokenEndpoint.ts`, which also serves
  OIDC discovery and device authorization, can prefix what it issues and can withhold a response
  until released); their interactive half is a recording strategy or presenter, or one that
  waits until aborted. The SAML grants' assertions come from `@mcp-abap-adt/auth-mocks`' identity
  provider. The SNC case writes a 64-byte ELF header for the host's architecture into a temporary
  directory as its `sncLib`. `connection14.test.ts` runs `@mcp-abap-adt/connection` 14 over its
  real HTTP wire. A released port is proved by binding it, never by a log line.
- **`stand/*.test.ts`** (both packages): the stand (below). Without `UAA_URL` / `KEYCLOAK_URL`
  each is skipped, printing why; the CLI's also skip off Linux, and need the built bin.
- **`AuthBroker.integration.test.ts`**: a real destination. It reads
  `packages/auth-broker/tests/test-config.yaml`; without it the template
  (`test-config.yaml.template`) is read, its placeholders disable every case, and each case
  returns at once. With it, the cases read the service keys and sessions it points at and may open
  a browser for a login. A session written before 5.0.0 reads as unbound: the first case of each
  token destination logs in once.

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

In the library's suites, `DEBUG_BROKER=true` (or `DEBUG_AUTH_BROKER=true`, `DEBUG=broker`) turns
on the test logger (`@mcp-abap-adt/logger`, a dev dependency), its level from `AUTH_LOG_LEVEL`.
These variables belong to the test harness only: neither package's code reads them.

## The stand: UAA and Keycloak in Docker

`packages/auth-broker/tests/stand/` runs Cloud Foundry UAA (`cfidentity/uaa` v79.7.0) and
Keycloak (26.7.4) in Docker, on the loopback address only: real token endpoints for the token
grants `getProvider` builds and the `mcp-auth` logins. It is `@mcp-abap-adt/auth-providers`'
stand copied whole and owned here: `compose.yaml`, `up.sh` / `run.sh` / `down.sh`, the UAA
configuration, the Keycloak realm and the test SAML IdP's key — committed test fixtures, trusted
by nothing but the local stand, so a clone needs only Docker. Beside them, two test-only helpers
both packages' stand suites import (reused, never copied; `tools/check-graph.js` allows exactly
these two relative imports out of a package's `src`; each package's `tsconfig.json` type-checks
them, its `tsconfig.build.json` compiles `src` alone): `formLogin.ts` plays the user on UAA's
login form and `/passcode` page and on Keycloak's login, device, consent and SAML pages — no
browser is opened; `standAdmin.ts` makes UAA trust Keycloak, reads UAA's ACS from its metadata
and sets a Keycloak SAML client's attributes through the admin API.

```bash
npm run test:stand                   # start the stand, build the CLI, run both packages' suites,
                                     # stop what it started
npm run test:stand -- -t "passcode"  # one case
npm run stand:up                     # or keep it running: start it once …
UAA_URL=http://localhost:8080/uaa KEYCLOAK_URL=http://localhost:8081/realms/test \
  npm test -w @mcp-abap-adt/auth-broker -- src/__tests__/stand
npm run build && UAA_URL=http://localhost:8080/uaa KEYCLOAK_URL=http://localhost:8081/realms/test \
  npm test -w @mcp-abap-adt/auth-broker-cli -- src/__tests__/stand
npm run stand:down                   # … and stop it
```

- `run.sh` stops only the servers it started, per service: one already running is left running,
  and one running on another port than asked is refused. `STAND_KEEP=1` keeps what it started.
  On a failure it prints the servers' last 200 log lines first. `UAA_PORT` / `KEYCLOAK_PORT` move
  the ports (defaults 8080 / 8081).
- The compose project and containers are named `auth-broker-stand`, `auth-broker-uaa`,
  `auth-broker-keycloak`; auth-providers' stand uses the same default ports, so only one runs at a
  time unless one is moved.
- Each suite composes the broker as a consumer does — auth-stores 4's `EnvDestinationStore` for
  the means, its `AbapSessionStore` for the secret, `renewal` and `onWriteFailure` stated — and
  reads the session file back from disk, asserting the version-2 binding record. It takes UAA's
  issuer from its discovery document, never from `UAA_URL`.
- CI runs `npm run test:stand` as its own job (`broker-stand` in `.github/workflows/ci.yml`).

What it covers: `jwt` / `client_credentials`, `authorization_code` (UAA's login form) and
`passcode` (`/passcode`) — each obtained and written as the secret alone with its binding, the two
interactive ones renewed by refresh after a 401; a session bound to another URL is not reused.
The OIDC grants against Keycloak's `test` realm: `password` (and a new broker seeded from its
session), `oidc_authorization_code` (Keycloak's page, PKCE, a public client), `device_code` (the
consumer's presenter approves the code) and `token_exchange` (exchanged again after a 401). The
SAML grants, Keycloak as identity provider and UAA as service provider: `saml2_pure` (Keycloak's
assertion posted by the test's `samlCookies` to UAA's web SSO ACS, a real UAA session cookie,
written as cookies, reused by a new broker, renewed by a new login after a 401) and `saml2_bearer`
(exchanged at UAA's bearer grant, renewed by refresh).

- **Both SAML logins are IdP-initiated**: UAA 79.7.0 refuses an assertion whose
  `SubjectConfirmationData` carries an `InResponseTo` it did not send — at the bearer grant, and,
  measured here, at web SSO too.
- **Keycloak's assertion lifespan is set to an hour** on `uaa-sp` (its default ends a minute after
  issue, inside a token provider's one-minute margin).
- **What it does not prove** is SAP ICF's own SAML handling, nor the difference between the two
  validators (Keycloak signs both the Response and the Assertion; the unit suite's identity
  providers sign one each).

### The CLI against the stand

`packages/auth-broker-cli/src/__tests__/stand/` runs the **built** `mcp-auth` bin (`run.sh`
builds it first) as a child process, under `node`, with an environment of its own: `PATH` is an
empty directory — no browser or URL launcher can be found by name — and `HOME` / `TMPDIR` the
test's directory. No real browser starts: a browser login is given the suite's **fake browser**
by absolute path (`--browser-program`), a node script the suite writes at run time; it hands the
URL to the test over a loopback inbox and exits, and the test plays the user with `formLogin`,
then brings the redirect to the CLI's callback — or holds the URL without answering. Every case
asserts stdout empty and no token or refresh token on either stream; every run given the fake
browser also asserts that neither stream holds the authorization URL, its `state` or the code
that came back (the provider prompts the URL only when a launch fails). Each run of the UAA suite
has a `TMPDIR` of its own, so the interrupt cases see the CLI's private work directory while the
login waits and gone after exit 130 / 143. Skipped, each suite prints
`skipped: <title> — <reason>` on stderr, as the library's do.

- **UAA** (`authorizationCode.test.ts`): the service key names a recording proxy in front of UAA
  (it forwards everything, records each token request's grant and whether it carried a
  `code_verifier`, never a value; each upstream request has its own socket and is destroyed when
  its client goes or the proxy closes, whose close settles only once nothing upstream remains —
  `uaaProxy.test.ts` proves it against an upstream that never answers). The browser login — the URL carries `state` and an S256
  `code_challenge`, one code exchange with its verifier, the `.env` holds the pair; `SIGINT` and
  `SIGTERM` while the fake holds the URL — exit 130 / 143, "the authorization was aborted", the
  callback port bound by the test afterwards, no output file; `--browser none` — the URL read from
  stderr; a refused refresh — UAA revokes the stored refresh token
  (`DELETE /oauth/token/revoke/{token}` with the user's own access token), the next `--env` run
  sends the refresh, is refused, logs in and writes back a new pair that never holds the revoked
  token; `--env` reuse — a valid bound session, no token request at the proxy, no browser, the
  file byte for byte unchanged. Clients `cli_authcode` and `cli_short` (access tokens of 30 s,
  inside the one-minute margin, so the next run renews) register
  `http://localhost:61001/callback`, the CLI's default callback.
- **Keycloak** (`deviceCode.test.ts`): `oidc --flow device` with `oidc-device`; the user code and
  complete verification URI read from stderr (the presenter has no logger), approved on
  Keycloak's pages.
- **SAML** (`samlManual.test.ts`), Keycloak as the identity provider: `saml2-pure --assertion-flow
  manual` sends its AuthnRequest to Keycloak's `sap-sp` client with a declared ACS; the test
  pastes the SAMLResponse on stdin, the CLI validates it, then asks for the session cookies — no
  SAP system is on the stand to set them, and UAA's web SSO refuses an SP-initiated assertion, so
  the test pastes a cookie of its own (the CLI's paste, validation and write are measured, not
  ICF). `saml2-bearer --idp-initiated` reads UAA's SP metadata itself (`--uaa-url`: ACS, Audience,
  token alias); the SAMLResponse of an IdP-initiated login at Keycloak is pasted and exchanged at
  UAA. Both Keycloak clients get hour-long assertions at run time (`standAdmin.ts`).

## Live checks: getProvider against real systems

`packages/auth-broker/src/__tests__/live/getProvider.live.test.ts` hands the provider
`getProvider` builds to a `@mcp-abap-adt/connection` 14 connector and reads
`/sap/bc/adt/compatibility/graph` from a real system. It is not part of `npm test` or `npm run
check`:

```bash
npm run test:live                               # every case
npm run test:live -- -t "basic over HTTP"       # one case
```

Each case states where it runs and reads only the environment variables it names — there is no
configuration file. Where a condition does not hold, the case is skipped with the reason in its
title and in the run's log. A skip is not a failure: it says this machine is not the one the case
is for. Only status codes and response sizes are printed — never a value from the store.

| Case | Runs where | Variables |
|---|---|---|
| `basic` over HTTP | any machine that reaches an on-premise system | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_BASIC_DESTINATION` |
| `basic` over RFC (`rfcConversationFrom`) | a machine with the SAP NW RFC SDK and `@mcp-abap-adt/sap-rfc-lite` built against it | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_RFC_DESTINATION`; optional `SAP_SYSNR` |
| `snc` over RFC | Windows or macOS with an SNC library (the SAP Secure Login Client, logged on), the NW RFC SDK and `sap-rfc-lite` | `AUTH_BROKER_LIVE_KEYS_DIR`, `AUTH_BROKER_LIVE_SNC_DESTINATION`; optional `SAP_SYSNR` |
| `jwt` / `authorization_code` over HTTP (`AdtCloudConnector`) | any machine that reaches a BTP ABAP environment (trial), with a session holding a refresh token | `AUTH_BROKER_LIVE_SERVICE_KEYS_DIR`, `AUTH_BROKER_LIVE_JWT_DESTINATION`, `AUTH_BROKER_LIVE_SESSIONS_DIR` |

**The `jwt` case** seeds the session with a well-formed JWT the system did not issue: the first
request is a 401, the provider renews by the stored refresh token in `rejected()`, the request is
answered 200, and after `flush()` the session file holds a new token and its binding. It never
logs in — its `authorization` strategy refuses — and never writes the original session file (it
works on a copy). The means are the destination's SAP service key, read by
`new AbapServiceKeyStore(dir, { grantType: 'authorization_code' })`. **The session must be bound
to that key by auth-broker 5**: a session written before 5.0.0 reads as unbound — the broker does
not use its refresh token, the refusing strategy fails the login, and the case fails. **Measured**
2026-10-09 against the BTP trial: a session written by `mcp-auth --service-key <the key>`
(CLI 3.0.0, `--type abap`) carries exactly the binding this case computes — the case passed on
it (one 401, renewed, `200`). A session written by a 5.0.0 `getProvider` over the same key is
read from the code, not measured. Logging in once with CLI 3.0.0 makes the case runnable. Where the server rotates refresh tokens the
run spends the original's refresh token; log in again afterwards.

**The destinations.** `AUTH_BROKER_LIVE_KEYS_DIR` is a directory of `<destination>.env` files read
by auth-stores 4's `EnvDestinationStore`. A `basic` destination:

```bash
SAP_URL=http://127.0.0.1:8000
SAP_CLIENT=100
SAP_AUTH_TYPE=basic
SAP_USERNAME=DEVELOPER
SAP_PASSWORD='...'
```

An `snc` destination states the system's SNC name instead of a user:

```bash
SAP_URL=https://host.example:44300
SAP_CLIENT=100
SAP_AUTH_TYPE=snc
SAP_SNC_PARTNERNAME='p:CN=SID, O=ORG, C=DE'
# optional: SAP_SNC_QOP=9, SAP_SNC_LIB=<path>, SAP_SNC_MYNAME=p:CN=ME
```

**RFC.** The RFC address is the host of `SAP_URL`; the system number is taken from its port by
the SAP convention (`80NN` → `NN`) unless `SAP_SYSNR` is set. `@mcp-abap-adt/sap-rfc-lite` is
connection's optional dependency: `npm ci` builds it only when `SAPNWRFC_HOME` points at the SDK,
and leaves it out otherwise — then the RFC cases skip, naming why.

### On Linux (HTTP and RFC)

```bash
# basic over HTTP
AUTH_BROKER_LIVE_KEYS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_BASIC_DESTINATION=<a basic destination> \
npm run test:live -- -t "basic over HTTP"

# basic over RFC: build the addon against the SDK once, then run
export SAPNWRFC_HOME=~/sap/nwrfcsdk
export LD_LIBRARY_PATH="$SAPNWRFC_HOME/lib:$LD_LIBRARY_PATH"
npm ci                                          # builds sap-rfc-lite now that the SDK is found
AUTH_BROKER_LIVE_KEYS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_RFC_DESTINATION=<a basic destination whose SAP_URL host is the RFC host> \
npm run test:live -- -t "basic over RFC"

# jwt / authorization_code against the BTP ABAP environment (trial)
AUTH_BROKER_LIVE_SERVICE_KEYS_DIR=~/.config/mcp-abap-adt/service-keys \
AUTH_BROKER_LIVE_SESSIONS_DIR=~/.config/mcp-abap-adt/sessions \
AUTH_BROKER_LIVE_JWT_DESTINATION=trial \
npm run test:live -- -t "jwt"
```

A Node.js that ships its own glibc (Homebrew's) needs the system `libuuid` on
`LD_LIBRARY_PATH` for the SDK.

### On Windows (SNC)

**Keep the checkout's path short.** The lockfile nests some packages deep, and npm runs their
install scripts with that directory as the working directory, which Windows limits to 260
characters (`MAX_PATH`): under a long root `npm ci` fails with `npm error enoent spawn
C:\WINDOWS\system32\cmd.exe ENOENT`. Run from a short root instead, e.g. a worktree:

```powershell
git worktree add C:\ab <branch>                 # then run everything below in C:\ab
```

Log on to the SAP Secure Login Client first. Install the SAP NW RFC SDK and put its `lib` on
`PATH`, then:

```powershell
$env:SAPNWRFC_HOME = 'C:\nwrfcsdk\nwrfcsdk'
$env:PATH = "$env:SAPNWRFC_HOME\lib;$env:PATH"
npm ci                                          # builds sap-rfc-lite against the SDK

$env:AUTH_BROKER_LIVE_KEYS_DIR = "$HOME\Documents\mcp-abap-adt\sessions"
$env:AUTH_BROKER_LIVE_SNC_DESTINATION = '<an snc destination>'
npm run test:live '--' -t 'snc over RFC'
```

In PowerShell quote the `--`: unquoted, PowerShell consumes it. The test and build scripts run on
any platform (`cross-env` sets `NODE_OPTIONS`, `clean` is plain Node), and so does `npm run
check`. On macOS the SNC case runs the same way (`export` instead of `$env:`,
`DYLD_LIBRARY_PATH` for the SDK's `lib`).

## Live check: an x509 XSUAA service key

`packages/auth-broker/src/__tests__/live/x509.live.test.ts` runs `client_credentials` with an
x509 XSUAA service key against a real XSUAA: the broker with `fromServiceKeyCertificate()` over
`XsuaaServiceKeyStore` (`getProvider().prepare()` and the token API), `mcp-auth --credential
--client-auth certificate` and `generate-env-from-service-key --grant client_credentials
--client-auth certificate` (each followed by a fresh broker over the destination it wrote), and a
failing run that leaves the previous destination untouched and prints no PEM. One command builds,
creates the environment, runs the suite and removes everything, also on failure:

```bash
export XSUAA_CF_API=<api> XSUAA_CF_ORG=<org> XSUAA_CF_SPACE=<space>  # exactly as `cf target` shows
cf login -a "$XSUAA_CF_API" --sso -o "$XSUAA_CF_ORG" -s "$XSUAA_CF_SPACE"
npm run test:live:x509                 # every case
npm run test:live:x509 -- -t "(b)"     # one case
X509_KEEP=1 npm run test:live:x509     # keep the environment for another run
```

Not in `npm test`, not in CI. The scripts (`packages/auth-broker/tests/live/x509/`) refuse unless
`cf target` equals the three variables exactly, and touch only what `setup.sh` created — an
`xsuaa` / `application` instance (`credential-types: ["binding-secret", "x509"]`) and its key
`x509-key`, made afresh each run with `{"credential-type": "x509"}` — each recorded with its GUID
in the ledger `tests/live/x509/.local/owned`, re-checked before every reuse or delete. The key and
its PEM files are saved owner-only under the gitignored `.local/`, never printed. A failed
teardown exits non-zero and keeps `.local/`; `tests/live/x509/teardown.sh` finishes it.

Last run: BTP trial, 2026-10-05, on 4.1.0 — all five cases passed. Not covered: `authorization_code`
and `passcode` over x509, the OIDC grants and `saml2_bearer` with a strategy, ABAP environment
keys with x509.

## The checks

`npm run check` is the release gate; `npm run release:publish` runs it once, and each package's
`prepublishOnly` runs it too:

| Script | What it proves |
|---|---|
| `npm run build` | Biome at error level, then `tsc -b` over both packages (the CLI references the library) |
| `npm run test:check` | both packages type-check, tests included, under the strict flags of `tsconfig.base.json` |
| `npm run lint:check` | Biome over `packages/` and `tools/`, no warning allowed |
| `npm run check:graph` | each package imports only what its allowlist permits, declares it, and uses every runtime dependency it declares; tests import only declared dependencies; the library never imports `auth-stores` |
| `npm run check:shape` | `tools/check-provider-shape.mjs` (auth-errors 2.1.1's, byte for byte) with rules 4, 5, 6 over both packages' `src`: no type assertion to a contract error, refusal, outcome or failure; no spread of an error; a builder's diagnostics only from the listed sites |
| `npm run check:packed` | the bin smoke check: both packages packed and installed into an empty directory; `mcp-auth` runs with `--version` (the CLI's version), `help` and every subcommand's `--help`; no `mcp-sso` is installed; the library loads with no `bin`. Needs the network |
| `npm run check:publish` | `tools/publish-changed.js` exercised against fixture repositories and a fake npm |

`npm run check` does not run Jest: the library's integration suite reads real session files when
configured, and a release gate must not reach a real system unasked. Run `npm test` beside it.

There are no hand-run stands in the CLI package any more: 3.0.0 removed `tests/keycloak` and
`tests/sso-demo` and their npm scripts; the library's stand covers the token grants, and the CLI's
interactive steps are covered in-process by its suites.
