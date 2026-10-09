# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is an npm workspace (the `mcp-abap-adt-interfaces` layout) with two packages: `packages/auth-broker` — `@mcp-abap-adt/auth-broker` (5.0.0), a per-destination credential broker for SAP BTP/ABAP systems — and `packages/auth-broker-cli` — `@mcp-abap-adt/auth-broker-cli` (3.0.0), the one command `mcp-auth` (subcommands `auth-code`, `oidc`, `saml2-pure`, `saml2-bearer`). For a destination name the broker builds the `IAuthProvider` the destination states (`getProvider`) from the means in its key store and the secret in its session store, and serves the token API (`getToken`, `refreshToken`, `createTokenRefresher`) on that same provider — or on an injected `IRefreshableTokenProvider` / factory — writing what is obtained back as the session secret alone. Token lifecycle decisions are the provider's (`@mcp-abap-adt/auth-providers` 6) and the consumer's `renewal` strategy's; storage is the stores' (`@mcp-abap-adt/auth-stores` 4); a failure is read through `@mcp-abap-adt/auth-errors` 2. The consumer composes and the broker guesses nothing: `renewal` and `onWriteFailure` have no default.

## Build and Development Commands

Everything runs from the repository root; the dev dependencies (Biome, TypeScript, Jest, ts-jest, semver) are the root's. The install is hoisted and deduplicated (`.npmrc`: `install-strategy=hoisted`, `prefer-dedupe=true`): one copy of `auth-providers`, `auth-errors`, `interfaces-auth` and `auth-stores` for both packages.

```bash
npm run build        # clean, Biome at error level, tsc -b over both packages
npm run test:check   # type-check both packages, tests included (strict flags below)
npm run lint         # Biome with --write over packages/ and tools/
npm run lint:check   # Biome, read-only; any warning fails it
npm run format
npm test             # Jest in every workspace (never `npx jest`: the script sets --experimental-vm-modules)
npm run check        # build, test:check, lint:check, check:graph, check:shape, check:packed, check:publish (no Jest)
npm run test:stand   # the library's stand suites against UAA and Keycloak in Docker (needs Docker)
npm run test:live    # the library's live suite against real systems (each case skips, saying why, where it cannot run)
npm run test:live:x509  # an x509 XSUAA key against a real BTP subaccount (cf login; XSUAA_CF_API/ORG/SPACE)

# One package, one file, one case
npm test -w @mcp-abap-adt/auth-broker
npm test -w @mcp-abap-adt/auth-broker -- AuthBroker.test.ts -t "name of the case"
npm test -w @mcp-abap-adt/auth-broker-cli
```

- `check:graph` (`tools/check-graph.js`): runtime files (src outside `__tests__`) import only their package's allowlist, declare it in `dependencies`, and use every dependency; tests import only what the package declares. The library imports the contract packages, `auth-providers` and `auth-errors`, never `auth-stores`; the CLI adds the library, `auth-stores`, `@xmldom/xmldom` and `dotenv`.
- `check:shape` (`tools/check-provider-shape.mjs`, a byte-identical copy of auth-errors 2.1.1's, pinned by `src/__tests__/tools/shapeCheckCopy.test.ts`): rules 4, 5, 6 over both packages' `src`.
- `check:packed` (`tools/check-packed.js`): the bin smoke check — pack both, install the tarballs into an empty directory, run `mcp-auth --version` (the CLI's version), `help` and `mcp-auth <subcommand> --help` for every subcommand, check that `mcp-sso` is not installed and the library loads with no `bin`. Needs the network.
- `check:publish` (`tools/test-publish-changed.js`): the release tool against fixture repositories.
- `release:publish` (`tools/publish-changed.js`): publishes exactly the versions the registry lacks, in workspace order (broker, then CLI), after one `npm run check`; refuses an untagged version. Tags are `<dir>-v<version>` (`auth-broker-v…`, `auth-broker-cli-v…`); the `v*` tags are the single package's history. Never `npm publish` a workspace by hand.

## Architecture

### The library (`packages/auth-broker/src/`)

- `AuthBroker.ts` — the class: `getProvider`, the token API, `flush`, `createTokenRefresher`, `getConnectionConfig` / `getAuthorizationConfig`; the two resolution paths; the write path (`writeSecret`).
- `destinations.ts` — the provider each destination states (`basicProvider`, `sncProvider`, `uaaProvider`, `oidcProvider`, `samlProvider`, `handedOverProvider`), each row's refusal (`uaaRefusal`, `oidcRefusal`, `samlRefusal`: every missing field and option named in one `DestinationConfigError`), `renewalFor`, `persistenceFor` (auth-providers' `refreshStatePersistence` over the broker's write), `constructed` (a provider constructor's throw → `DestinationConfigError` naming the store fields, the failure carried).
- `binding.ts` / `bindingOf.ts` — the binding: `issuedFor` canonical (`resourceUri`, 4.x's form), `issuedBy` the version-2 record (`bindingRecord`: `mcp-abap-adt-binding/2;<row>;<eleven exact, encodeURIComponent-encoded address fields>;<trust digest>`), `trustDigest` (SHA-256 of the row's non-secret trust input), `fullyStated`, `boundHere`, `couldBeSeeded`, `strategyBinding`, `consumerBinding`; `bindingOf(means, client)` — the record for the row the means state. Compared by exact equality, never parsed, no regular expression.
- `buildIdentity.ts` — what a build read (`IdentityRecorder`, `StoreReads`): every field of every store answer a builder reads, recorded through one accessor and compared exactly on every call; secrets in memory only.
- `SessionWriter.ts` — one plain queue per destination (in order, one at a time; a failed write pending until the next write or `retry` / `flush`; no timer), `SessionWriteFailure`.
- `clientAuthentication.ts` — `ClientAuthenticationStrategy`, `fromServiceKeyCertificate()`, `fromServiceKeySecret({ encoding })`, the guard `resolveClientAuthentication`, `clientIdentity`.
- `DestinationConfigError.ts` — the class (`destination`, `missingFields`, optional carried `error: IAuthProviderError`) and the structural `isDestinationConfigError`.
- `quietLogger.ts` — every log line through one guard: a logger that throws or rejects changes no outcome.
- `contractShape.ts` — `asContract`, the one bridge from `?: T | undefined` to a contract's `?: T`.

**`getProvider(destination, { signal? })`** reads the means from the key store only (`getConnectionConfig`; `getAuthorizationConfig` for the client; `getClientCertificate` only when a `clientAuthentication` strategy asks) and the secret from the session store only (`loadSession`) — never one from the other's fields, never inferred from which fields are present. Every `authType` / `grantType` pair is built: `basic`, `snc`, `jwt`/`none`, `saml`/`none`, the UAA grants `authorization_code`, `client_credentials`, `passcode`, the OIDC grants `oidc_authorization_code`, `device_code`, `password`, `token_exchange`, and `saml2_pure`, `saml2_bearer` (the validator composed from the destination's trust and the consumer's replay store). Each collaborator option (`authorization(destination, grant)`, `oidcAuthorization`, `deviceCodePresenter`, `samlCookies`, `assertionReplayStore`) is called once per build and never disposed. No row requires `serviceUrl` and no provider is given it — the broker reads it, with `sapClient`, only for the binding.

**Renewal and persistence (no defaults).** Every token row takes `renewal(destination, grant)` (called once per build, after every other check, its answer passed unchanged) and persists through `refreshStatePersistence(write, { onWriteFailure })`. A token row without `renewal` or `onWriteFailure` is refused naming them, beside every other missing field, before any collaborator is called. `authDebug: config.authDebug === true` reaches every token provider the broker builds; nothing reads the environment.

**One write, one `saveSession`, every field stated** (auth-stores 4 merges): a credential write states the token or cookies, `expiresAt` (the report's), the refresh token the build owns or `''` (`ownedAfter`: a string written makes it owned, `null` makes it none, `undefined` writes the owned one or `''` — never read from the store at write time), `issuedFor` (`''` when absent) and `issuedBy`; `saml2_pure` cookies write `refreshToken: ''`; a discard before any credential writes only `refreshToken: ''`. A destination the key store now states `basic` / `snc` is not written. A write of a build older than the newest build of the same path that has written is dropped (`submit`, per-path generations).

**`onWriteFailure`.** `'fail'`: the call whose write did not land fails (`classify(error, 'persisting-tokens')`), and `getProvider` / `getToken` / `refreshToken` run `settlePending` on entry and right before success — `writer.retry(destination)` awaits every write queued before it and retries the pending one; still failing → refused. `'continue'`: one `warn` line (`logFields`), the call goes on. The writer never rejects; `flush()` rejects with an `AggregateError` of `SessionWriteFailure`s.

**A provider is never changed.** Two paths per destination, each with its own `sharedAttempt` slot, cache entry, identity and generation counter: the row path (`getProvider`, the token API without `provider`) and the consumer path (the token API with `provider`). Every call re-reads (`StoreReads`) and compares the cached build's identity; changed → a new build. A row build is seeded from the session only at the destination's first build in this broker (`seeded: !everBuilt`) and only when `boundHere` (fully stated, `issuedFor` canonical-equal, `issuedBy` exactly equal); otherwise it starts with nothing (`boundOrDiscarded`: a `warn` where a secret could ever be seeded, else `debug`). The consumer factory is handed the means and the client through allowlists (`consumerClient`, `consumerSeed`) — never a stored secret — and is never seeded; an instance whose identity changed is refused (`instanceRefused`) until a new broker. The `none` rows (`handedOverProvider`) refuse a mismatch naming `issuedFor` / `issuedBy`.

**Cancellation.** Every slot uses one pattern: `start` never throws — it resolves a frozen `SlotOutcome` that the waiter unwraps outside `join` (`joined`), so `DestinationConfigError`s, store errors and provider failures reach every waiter as the same object, and the only failure `sharedAttempt` itself gives is `aborted`. A commit (cache set, generation taken) runs only if the attempt was not aborted. `getProvider` attaches its signal to the token / SNC provider answered (`parties.attach`); the token API never attaches and passes its signal to `getTokens({ signal })`. `waitFor` makes each wait on the write queue a waiter of its own slot; `stillWanted` refuses success after a late abort. `ClientAuthenticationContext.signal` is the build's attempt. No timer, no `AbortSignal.timeout`, no `timeoutMs` anywhere in `src` (a source test).

**Errors.** A provider's failure is relayed as the same object. The broker reads a caught value only through `readFailure` / `isAuthProviderFailure` / `classify` — never `instanceof`, `message`, `name` or `stack` (`sources.test.ts`). Its own failures are auth-errors' (`authError['request-failed']({ operation: 'token-source', problem: 'no-access-token' })`, `classify(storeError, 'persisting-tokens')`, `aborted`). `DestinationConfigError` carries names only, and `error` when a provider's or a strategy's failure caused it. A store's read failure other than `FILE_NOT_FOUND` reaches the caller as the store raised it.

**Client authentication** (`clientAuthentication`): called once per build for every row whose client authenticates (the UAA and OIDC grants, `saml2_bearer`) with `{ destination, grant, client (allowlisted: uaaUrl, uaaClientId, uaaClientSecret), readCertificate() (lazy, memoised), signal }`. Its answer goes to the provider as `clientAuthentication` with no `clientSecret`; the row's client is the identity (`clientIdentity`). The guard turns any throw into `DestinationConfigError(['clientAuthentication'])` — a shipped factory's own refusal (recognised by a module-private `WeakMap`) in the broker's words, anything else `the clientAuthentication strategy failed`, carrying `readFailure(thrown, 'client-authentication-strategy')`. When the build read the certificate client its `certUrl` is in the record and its certificate in the trust digest; on this path a resource neither side states matches (`strategyBinding`).

**Stores** (contracts from `@mcp-abap-adt/interfaces-auth-broker` 1.3; implementations in `@mcp-abap-adt/auth-stores` 4, which the library's runtime never imports): `IServiceKeyStore` — the means (read-only to the broker; optionally `getClientCertificate`); `ISessionStore` — the secret and its binding. The store contract the docs state: `saveSession` settles, keeps `issuedFor` / `issuedBy` byte for byte, takes `refreshToken: ''` as clearing.

**Providers** (from `@mcp-abap-adt/auth-providers` 6, a runtime dependency): `getProvider` constructs them by name (`BasicAuthProvider`, `SncLogonProvider`, `TokenAuthProvider`, `SamlAuthProvider`, `AuthorizationCodeProvider`, `ClientCredentialsProvider`, `UaaPasscodeProvider`, the four OIDC providers, `Saml2PureProvider`, `Saml2BearerProvider`); none is re-exported. The token API with a consumer `provider` takes any `IRefreshableTokenProvider`.

### The CLI (`packages/auth-broker-cli/src/`)

- `mcp-auth.ts` — the one bin: help per subcommand, `--version`, then `runMcpAuth` (no subcommand / `auth-code`) or `runMcpSso` (`oidc`, `saml2-pure`, `saml2-bearer` — 2.x's `mcp-sso`, in the same process), each under `underInterrupt`.
- `subcommandArgs.ts` — the parser (`parseCommandLine(args)`, no `process.argv`), `UsageError` branded by a module-private symbol (`isUsageError`); `--protocol` refused, `--dev` an unknown option.
- `source.ts` — the three sources: `--service-key` (always a new pair), `--env <path>` (the exact file: reuse / refresh / login, written back), `--destination <name>` (`--destination-dir`, else `AUTH_BROKER_PATH` split by plain code as the server's `getPlatformPaths`, else `~/.config/mcp-abap-adt` / `<home>/Documents/mcp-abap-adt`). One per run; means flags and `--config` refused beside a session file; `--cookie` only over a cookie session.
- `runMcpAuth.ts` — the UAA row through the broker's `getToken` (no factory of its own); `generateEnv.ts` / `generate-env-from-service-key.ts` — the `tsx` development script (not compiled), always a login.
- `runMcpSso.ts`, `mcpSsoConfig.ts` (the row a run states, `buildCollaborators`, the SAML strategies, `declaredAcs` — a pasted login declares its ACS, no localhost fallback), `samlMetadata.ts` (an XML parser, `@xmldom/xmldom`; redirects checked hop by hop under the run's signal).
- `browser.ts` — `browserFor(name, platform)`: `--browser` names mapped per `process.platform` to auth-providers' six launchers; `--browser-program`; any other platform refuses a named browser.
- `interrupt.ts` (`underInterrupt`: one `AbortController` per run; `SIGINT` / `SIGTERM` abort it → 130 / 143 after the run settled; a second signal exits at once; `SIGHUP` 129; every listener removed after), `workDir.ts` (a private `mkdtemp` directory, removed on every exit).
- `output.ts` — stdout only for help and `--version`; `createCliLogger` (stderr, `info`, `debug` with `--verbose`); `printFailure` / `failureLines` (auth-errors' words, a `DestinationConfigError`'s message, a usage error's fixed words, never a stack or a foreign message); `writeFailureLines`.
- `destination.ts` — the two stores over one `<destination>.env` (`openDestination`), `completeMeans`, `flushed`, the output copy, the JSON export (`authenticatedJsonOutput`), `SAP_UAA_BASIC_ENCODING` (`setFileVariable` / `readFileVariable` through `dotenv.parse`) — a line only the CLI reads; `sessionClientAuth.ts`; `clientAuthentication.ts` (`--client-auth`, `--basic-encoding`, `--cert-path`, `--key-path`).

Every run builds its broker with `renewal: () => refreshThenLogin()`, `onWriteFailure: 'fail'`, `authDebug` only with `--auth-debug`, and every collaborator the grant needs, each ending with the run's signal. It writes the means first through `EnvDestinationStore.setDestination` and the secret only through the broker's persistence — the one exception is `saml2-pure --cookie` (`saml` / `none`), whose cookies the CLI writes with the library's `bindingOf(means)` and `refreshToken: ''`. It works on a copy in its work directory and copies the output only after `flush()`; a failure exits 1 and writes nothing. The CLI imports `AuthBroker` from `@mcp-abap-adt/auth-broker` by name, never by a path into its `dist`; `--version` reads the CLI's own manifest.

```bash
mcp-auth --service-key ./key.json --output ./mcp.env --type xsuaa
mcp-auth --env ./mcp.env --type xsuaa
mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
```

## Testing

Tests live in each package's `src/__tests__/` (see `docs/development/TESTING.md`):
- Library (`src/__tests__/broker/`), need nothing: stores are in-memory fakes of the contract or auth-stores 4 in temporary directories; providers are real; token grants talk to a token endpoint the test starts on 127.0.0.1 (`helpers/tokenEndpoint.ts`, which also serves OIDC discovery and device authorization, can prefix what it issues and withhold a response); the SAML grants validate assertions from `@mcp-abap-adt/auth-mocks`. By concern: `getProvider*.test.ts` (rows, tokens, binding, OIDC/SAML), `bindingRecord.test.ts`, `identityRebuild.test.ts`, `buildIdentity.test.ts`, `consumerIdentity.test.ts`, `twoPaths.test.ts`, `sessionWrites.test.ts`, `writeQueue.test.ts`, `ownedAfterDiscard.test.ts`, `renewal.test.ts`, `cancellation.test.ts`, `errors.test.ts`, `debug.test.ts`, `sources.test.ts` (source rules: no timers, no error `instanceof` / `message`), the client-authentication suites, `tokenApiShared.test.ts`, `tokenProviderFactory.test.ts`, `ownKeys.test.ts`, `connection14.test.ts` (end to end over `@mcp-abap-adt/connection` 14), `AuthBroker.test.ts`; `AuthBroker.integration.test.ts` reads real files only when `packages/auth-broker/tests/test-config.yaml` exists. `src/__tests__/tools/shapeCheckCopy.test.ts` pins the shape check's copy.
- **The broker stand** (`packages/auth-broker/tests/stand/`; `npm run test:stand` starts it, runs `src/__tests__/stand/` and stops what it started; CI's `broker-stand` job): Cloud Foundry UAA and Keycloak in Docker, auth-providers' stand copied whole and owned here (committed fixtures, trusted by nothing but the local stand). `uaaGrants`, `oidcGrants`, `samlGrants` — each states `renewal` and `onWriteFailure`, reads the session file back, and asserts the version-2 record. `formLogin.ts` plays the user on the login pages — never a browser.
- **Live** (not in `npm test`, not in CI): `src/__tests__/live/getProvider.live.test.ts` (`npm run test:live`: `basic` over HTTP and RFC, `snc` over RFC, `jwt` / `authorization_code` through connection 14; each case reads only the `AUTH_BROKER_LIVE_*` variables it names and skips with the reason elsewhere) and `x509.live.test.ts` (`npm run test:live:x509`: refuses unless `cf target` equals `XSUAA_CF_API` / `_ORG` / `_SPACE`; touches only what its ledger `tests/live/x509/.local/owned` records).
- CLI (`packages/auth-broker-cli/src/__tests__/`), need nothing: the runs go in-process against a local token endpoint (`helpers/localServer.ts`) in temporary directories, with test doubles for every interactive step. `subcommandArgs.test.ts` checks every 2.x `mcp-sso` form against 2.1.0's parser kept as an oracle (`helpers/mcpSso210.ts`); `sources.test.ts`, `interrupt.test.ts` (signals during each kind of login, the port bound afterwards), `outputStreams.test.ts` (the built bin's stdout / stderr), `printFailure.test.ts`, `authDebugFlag.test.ts`, `browser.test.ts`, `samlAcs.test.ts`, `terminalPrompts.test.ts`, `runMcpAuth.test.ts`, `runMcpSso.test.ts`, `generateEnv.test.ts`, `mcpSsoConfig.test.ts`, `mcpSsoSamlProviders.test.ts`, `samlMetadata.test.ts`, `fileVariables.test.ts`.
- Tests run sequentially (`maxWorkers: 1`). A rejection expectation is attached before it is triggered; a released port is proved by binding it.

## Code Style

- Biome for linting and formatting (2-space indent, single quotes, semicolons)
- Strict TypeScript (`tsconfig.base.json`, both packages, src and tests): `strict` plus `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. In src no `!`, no `any`, no new `as`: a possibly-absent element is handled explicitly. This repository's own optional fields are `?: T | undefined`; a contract type declaring `?: T` built with an explicit `undefined` goes through `asContract` (`src/contractShape.ts`, one per package) — never by dropping the key: own keys are behaviour (`ownKeys.test.ts`)
- Biome: `noExplicitAny` is an error outside the tests (off in tests, as are `noNonNullAssertion` and the unused-variable rules); `lint:check` runs with `--error-on-warnings`
- No regular expression over stored or untrusted text in src (URLs, the binding record, metadata, `.env` lines, `AUTH_BROKER_PATH`): plain string code or a real parser
- CommonJS module output targeting ES2022

## Plans and Specs

Working documents (goals, specs, plans) under `docs/superpowers/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once one has been fully implemented OR cancelled, delete it, at the latest before the release that ships the work; what it still owes the future goes into that PR's description first. History lives in git; the directory exists only while it holds work in progress.
