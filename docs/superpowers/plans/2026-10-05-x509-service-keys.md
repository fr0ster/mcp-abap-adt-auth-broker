# x509 service keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan lists steps, files, interfaces and what each test proves; code is written at implementation, test first.

**Goal:** an XSUAA x509 service key gets a provider and a token through the broker and its CLI, with the client authentication chosen by the consumer as a strategy; the broker moves to auth-providers 5.3.0.

**Architecture:** `interfaces-auth-broker` adds `IClientCertificate` and an optional `IServiceKeyStore.getClientCertificate`; `auth-stores` answers it for x509 keys and a certificate `EnvDestinationStore` (never through `getAuthorizationConfig`); the broker takes a guarded `clientAuthentication` strategy, ships two fail-closed factories, passes the answer to every client-authenticating row and the consumer factory, and binds sessions to the client identity; the CLI gains explicit flags and never copies key material.

**Tech Stack:** TypeScript, Jest (`npm test` per repo — never `npx jest`), Biome, npm workspaces (broker), BTP trial (live, opt-in).

**Spec:** `docs/superpowers/specs/2026-10-05-x509-service-keys-design.md`, answering `docs/superpowers/2026-10-05-x509-service-keys-goal.md` (its "Holds throughout" and "Decided" bind every task).

## Global Constraints

- A certificate or its private key never reaches the session store, a log line, a refusal, a thrown message, a `DestinationConfigError`, CLI output, an exported destination, or a file the tool writes (PEM only in the user's own files).
- The consumer chooses, through strategies: no default, no fallback, nothing inferred from a key's shape (inspecting for `certificate`/`key` only to avoid copying is allowed — spec §4).
- Without a strategy: byte-for-byte 4.0.0, and nothing certificate-related is called (no `getClientCertificate`, no file read, no identity resolution).
- Variable names follow `EnvDestinationStore`'s prefix scheme: `SAP_UAA_CLIENT_CERT_PATH` / `SAP_UAA_CLIENT_KEY_PATH` / `SAP_UAA_CERT_URL` (ABAP map), `XSUAA_UAA_…` (XSUAA map); never bare `UAA_…`.
- An x509 client is never answered through `getAuthorizationConfig` (`null`), so no older consumer sees a public client.
- Dependencies only from the npm registry; each repo's release is published before its consumer builds against it; no `"link": true`.
- Versions: interfaces-auth-broker 1.1.0 → 1.2.0; auth-stores 3.2.0 → 3.3.0; auth-broker 4.0.0 → 4.1.0; auth-broker-cli 2.0.0 → 2.1.0.
- Every rule protected by a test is proven load-bearing (break → its test red → revert by editing).
- Live checks run only under `npm run test:live` with the exact `cf target` guard; never in the default run, never in CI.
- One open PR per task; the interfaces and stores changes are parts of this task in their own repositories.

## Review Focus

1. **A store that implements neither new member (a third-party `IServiceKeyStore`) behind a strategy** → `fromServiceKeyCertificate()` refuses in fixed words; the secret factory still works. → Task 4.
2. **A destination switched from a secret to a certificate (or back) with a session already stored** → the old session is not reused across the change of client identity (binding refuses it), and no stale credential of the other kind remains in the `.env`. → Tasks 3 and 5.
3. **Concurrent `getProvider(dest)` calls while the strategy throws** → both receive the same fixed `DestinationConfigError`; the failed build is not cached; the next call retries. → Task 4.
4. **Relative `--cert-path` / `--key-path`, or paths to files that do not exist** → resolved to absolute before writing; missing files refused before anything is written, naming the flag. → Tasks 7 and 8.
5. **A wrapped key whose `credentials` holds PEM with CRLF line endings or a chain** → read as given, handed to `tlsClientCertificate` unchanged (the provider checks it); nothing normalised into a copy. → Task 3 and Task 9 (live).

---

### Task 1: The contract in `@mcp-abap-adt/interfaces-auth-broker` (repo `fr0ster/mcp-abap-adt-interfaces`)

Its own worktree, branch and PR; stops at the user's review; merge, tag and the user's publish on the user's word.

**Files:**
- Create: `packages/interfaces-auth-broker/src/serviceKey/IClientCertificate.ts`
- Modify: `packages/interfaces-auth-broker/src/serviceKey/IServiceKeyStore.ts` (optional `getClientCertificate`), `src/index.ts`, `src/__typechecks__/` (a store with and without the method, a certificate object), `CHANGELOG.md`, README contract list, `package.json` 1.2.0 + lockfile

**Interfaces — Produces:** `IClientCertificate { readonly uaaUrl: string; readonly clientId: string; readonly certificate: string; readonly key: string; readonly certUrl: string }`; `IServiceKeyStore.getClientCertificate?(destination: string): Promise<IClientCertificate | null>` — doc comments as spec §1 (data only; never through `getAuthorizationConfig`).

- [ ] Worktree from `origin/master`; read the repo README; types only.
- [ ] Add the type and the optional member with the spec's doc comments; export.
- [ ] `npm run check` exit 0 (capture the exit code).
- [ ] Commit, push, open the PR; stop for the user's review. After publish: confirm 1.2.0 on the registry.

### Task 2: `EnvDestinationStore` certificate contract (repo `@mcp-abap-adt/auth-stores`)

Starts the auth-stores PR (its own worktree and branch); Task 3 adds to the same PR. Builds against interfaces-auth-broker 1.2.0 from the registry.

**Files:**
- Modify: `src/stores/destination/EnvDestinationStore.ts` (the only file holding the variable map: `MeansField`, `SUFFIXES`, `withPrefix`, `DestinationVariables`, `DestinationMeans`), `package.json` (`@mcp-abap-adt/interfaces-auth-broker ^1.2.0`)
- Test: `src/__tests__/stores/EnvDestinationStore.test.ts`

**Interfaces — Consumes:** Task 1. **Produces:** `EnvDestinationStore.getClientCertificate(destination)`; store-local means fields `uaaClientCertPath`, `uaaClientKeyPath`, `uaaCertUrl` (in `DestinationMeans` for `setDestination`, optional keys in `DestinationVariables`); suffixes `UAA_CLIENT_CERT_PATH`, `UAA_CLIENT_KEY_PATH`, `UAA_CERT_URL` → `SAP_UAA_CLIENT_CERT_PATH`… (ABAP map) and `XSUAA_UAA_CLIENT_CERT_PATH`… (XSUAA map); a custom `variables` map without the three keys → `getClientCertificate` `null`; a store error class with fixed words for incomplete/mixed/unreadable.

- [ ] Tests, each asserting what only its rule produces — every case against the **literal on-disk names** for both default maps (`SAP_UAA_CLIENT_CERT_PATH`…, `XSUAA_UAA_CLIENT_CERT_PATH`…), plus a custom map without the three keys (type-checks; certificate → `null`): none of the three → `getAuthorizationConfig` as 4.0.0 and `getClientCertificate` `null`; all three, no client secret variable (`SAP_UAA_CLIENT_SECRET` / `XSUAA_UAA_CLIENT_SECRET`) → `getAuthorizationConfig` `null` and `getClientCertificate` `{ uaaUrl, clientId, certificate, key, certUrl }` with the files' content; some but not all → both methods throw fixed words naming the missing variables, **no file read** (spied fs); any of them with the client secret variable → both throw fixed words (mixed client), no file read; an unreadable file → fixed words naming the variable, nothing of the path's content; `setDestination` writing a certificate client removes the client secret variable, writing a secret client removes the three (Review Focus 2).
- [ ] Implement; the decision reads only which variables are set.
- [ ] Load-bearing: the mixed check, the partial check, the null-authz rule, the stale-credential removal — each broken, its test red, reverted.
- [ ] `npm test`, test:check, lint; commit.

### Task 3: `XsuaaServiceKeyStore` and its parser read x509 keys (auth-stores, same PR)

**Files:**
- Modify: `src/stores/xsuaa/XsuaaServiceKeyStore.ts`, `src/parsers/xsuaa/XsuaaServiceKeyParser.ts`
- Test: `src/__tests__/stores/xsuaa/XsuaaServiceKeyStore.test.ts`, `src/__tests__/parsers/xsuaa/XsuaaServiceKeyParser.test.ts`

**Interfaces — Produces:** `XsuaaServiceKeyStore.getClientCertificate(destination)`.

- [ ] Tests: a bare and a `credentials`-wrapped x509 key (`url`, `clientid`, `certificate`, `key`, `certurl`, no `clientsecret`) → `getAuthorizationConfig` `null`, `getClientCertificate` the whole client; a secret key → `getClientCertificate` `null` and every other answer exactly as today (existing tests unchanged); a key with both a secret and a complete certificate (SAP's documented `credential-type: x509` shape) → `getAuthorizationConfig` the secret client exactly as 3.2.0, `getClientCertificate` the certificate client, no error; only one of `certificate` / `key` → refused in fixed words; PEM with CRLF and a chain is returned unchanged (Review Focus 5); no store log line contains PEM (marker test).
- [ ] Implement; `AbapServiceKeyStore` untouched.
- [ ] Load-bearing each; `npm test`, test:check, lint.
- [ ] CHANGELOG 3.3.0, README (x509 keys; the `.env` variables), `package.json` 3.3.0 + lockfile; commit, push, open the auth-stores PR; stop for the user's review → merge, tag, user's publish; confirm 3.3.0 on the registry.

### Task 4: Broker — the strategy, the guard, the factories, dependency bump

Back in this PR (`fr0ster/mcp-abap-adt-auth-broker`, worktree `.worktrees/x509-service-keys`).

**Files:**
- Modify: `packages/auth-broker/package.json` (`@mcp-abap-adt/auth-providers ^5.3.0`, `interfaces-auth ^3.2.0`, `interfaces-auth-broker ^1.2.0`; dev `auth-stores ^3.3.0`), `packages/auth-broker-cli/package.json` (`auth-providers ^5.3.0`, `auth-stores ^3.3.0`; its `@mcp-abap-adt/auth-broker` range moves to `^4.1.0` in Task 10, together with the broker's version), root lockfile
- Create: `packages/auth-broker/src/clientAuthentication.ts` (`ClientAuthenticationGrant`, `ClientAuthenticationContext`, `fromServiceKeyCertificate`, `fromServiceKeySecret`, the guard)
- Modify: `packages/auth-broker/src/AuthBroker.ts` (`AuthBrokerConfig.clientAuthentication`), `src/index.ts`
- Test: `packages/auth-broker/src/__tests__/broker/clientAuthentication.test.ts`

**Interfaces — Produces:**
- `type ClientAuthenticationGrant = 'client_credentials' | 'authorization_code' | 'passcode' | 'oidc_authorization_code' | 'device_code' | 'password' | 'token_exchange' | 'saml2_bearer'`
- `interface ClientAuthenticationContext { destination; grant: ClientAuthenticationGrant; client: IAuthorizationConfig | null; readCertificate(): Promise<IClientCertificate | null> }` — `readCertificate` lazy and memoised per build
- `AuthBrokerConfig.clientAuthentication?: (context) => Promise<IClientAuthentication>`
- `fromServiceKeyCertificate(): (context) => Promise<IClientAuthentication>` — `tlsClientCertificate({ material: { cert, key }, endpoint: \`${certUrl}/oauth/token\` })`, then **awaits its `tlsMaterial()` before returning** (5.3.0 validates material lazily, on first use — so validation must happen here, inside the build guard, not later in a cached provider); store without the method or `null` → throws fixed words "the destination has no client certificate"
- `fromServiceKeySecret({ encoding: 'raw' | 'form' }): (context) => Promise<IClientAuthentication>` — `clientSecretBasic(uaaClientSecret, { encoding })`; no secret client or empty secret → throws "the destination has no client secret"; `encoding` required (type and runtime)
- `resolveClientAuthentication(...)` (internal): runs the strategy inside the guard; any throw → `DestinationConfigError` naming `clientAuthentication`, fixed words, **no `cause`**, nothing of the thrown value

- [ ] Bump the dependencies from the registry; lockfile: no `"link": true`, every entry from registry.npmjs.org. Run the existing broker suites (unit) and the broker stand once on 5.3.0 — green before anything else changes; commit the bump alone.
- [ ] Tests: each factory's answer (the `tlsClientCertificate` endpoint is `${certUrl}/oauth/token`; Basic carries the stated encoding); each factory throwing when its client is unavailable (store without the method — Review Focus 1; `null`; empty secret); the guard: a throwing strategy, and a malformed PEM **through the real `fromServiceKeyCertificate()` and the real 5.3.0 provider** (no mock of `tlsClientCertificate`) → `getProvider()` rejects with `DestinationConfigError` with fixed words, no provider is cached, and the next `getProvider()` rebuilds; `cause` absent, no marker of the thrown message in the error, its `String()`, or any log line; `readCertificate` called twice → one store call; concurrent `getProvider` with a throwing strategy → same error, failed build not cached, next call retries (Review Focus 3).
- [ ] Implement; export the types and factories.
- [ ] Load-bearing: the guard, the no-cause rule, the fail-closed factories, the memo — each.
- [ ] `npm test`, test:check, lint; commit.

### Task 5: Broker — every client row, the binding, and no-strategy 4.0.0

**Files:**
- Modify: `packages/auth-broker/src/destinations.ts` (`uaaProvider`, `oidcProvider`, the `saml2_bearer` row), `packages/auth-broker/src/AuthBroker.ts` (`build`: resolve the strategy before the binding and the seed), `packages/auth-broker/src/binding.ts` (identity from the secret client, else the certificate client — on the strategy path only)
- Test: `packages/auth-broker/src/__tests__/broker/clientAuthenticationRows.test.ts`, `…/clientAuthenticationBinding.test.ts`

**Interfaces — Consumes:** Task 4.

- [ ] Tests: with a strategy, each row (`client_credentials`, `authorization_code`, `passcode`, each OIDC grant, `saml2_bearer`) gives its provider `clientAuthentication` and **no** `clientSecret`; `uaaUrl`/`clientId` from the certificate client when the secret client is null; without a strategy every existing test passes unchanged (byte-for-byte 4.0.0) and a **spy store** whose `getClientCertificate` throws if called is never called and no file is read; a certificate-only destination without a strategy → `DestinationConfigError` with the 4.0.0 lacking fields plus the fixed hint about `clientAuthentication`, decided without calling the store; binding: a certificate destination's tokens are stored with `issuedBy` = its issuer and client, reused after the broker is recreated, refused after the issuer or client id changes, and a destination switched secret→certificate does not reuse the old session (Review Focus 2).
- [ ] Implement.
- [ ] Load-bearing: the no-strategy gate (call the store anyway → the spy test red), the no-secret-with-strategy rule, the identity source, each row's wiring.
- [ ] `npm test`, test:check, lint; broker stand once; commit.

### Task 6: Broker — the consumer factory's fourth argument

**Files:**
- Modify: `packages/auth-broker/src/AuthBroker.ts` (`TokenProviderFactory`, `consumerProviderFor` — including `consumerBinding` on the strategy path: the secret client, else the certificate client's `uaaUrl`/`clientId`, as spec §3.2)
- Test: `packages/auth-broker/src/__tests__/broker/tokenProviderFactory.test.ts`

**Interfaces — Produces:** `TokenProviderFactory = (destination, authConfig, connConfig, client?: { clientAuthentication?: IClientAuthentication; uaaUrl?: string; clientId?: string }) => IRefreshableTokenProvider`.

- [ ] Tests: a certificate destination's token-API tokens carry `issuedBy` = issuer?client_id and are reused after the broker is recreated (consumerBinding from the certificate client's identity); without a strategy the factory is called with exactly three arguments (4.0.0); with one, the fourth carries the strategy's answer and the identity (never PEM — assert the argument holds no `-----BEGIN`); a throwing factory → the guarded `DestinationConfigError`; a 4.0.0-shaped factory (three parameters) keeps working.
- [ ] Implement inside the same guard as Task 4.
- [ ] Load-bearing; `npm test`, test:check, lint; commit.

### Task 7: CLI — `mcp-auth`

**Files:**
- Modify: `packages/auth-broker-cli/src/runMcpAuth.ts` (writes the certificate client through `setDestination` with `uaaClientCertPath` / `uaaClientKeyPath` / `uaaCertUrl` — Task 2's fields; flags, the strategy, `withPlaceholderUrl` forwarding `getClientCertificate`, the no-copy rule, exported destination), `packages/auth-broker-cli/src/mcp-auth.ts` (usage/help)
- Test: `packages/auth-broker-cli/src/__tests__/runMcpAuth.test.ts`

**Interfaces — Consumes:** Tasks 4–6.

- [ ] Tests: `--client-auth certificate|secret`, `--basic-encoding raw|form` (required with `secret`), `--cert-path`/`--key-path` (required with `certificate`; relative → absolute; a missing file → refused before anything is written, naming the flag — Review Focus 4); an x509 key with no flag → an error naming the flag; the grant stays the command's (`--credential` → `client_credentials`); the factory receives the fourth argument; **no-copy:** a wrapped x509 key and a wrapped mixed key, each with no flag, `secret` and `certificate`, successful and failing → no file under the work directory or in the exported destination contains `-----BEGIN`; a wrapped secret-only key keeps today's temporary copy; the exported destination carries the paths and `certurl` only.
- [ ] Implement.
- [ ] Load-bearing: the no-copy rule (each flag case), path resolution, the required-flag checks.
- [ ] `npm test`, test:check, lint; commit.

### Task 8: CLI — `generate-env-from-service-key`

**Files:**
- Modify: `packages/auth-broker-cli/src/generateEnv.ts`, `packages/auth-broker-cli/src/generate-env-from-service-key.ts` (usage)
- Test: `packages/auth-broker-cli/src/__tests__/generateEnv.test.ts`

- [ ] Tests: the same flags (with `--grant`); the choice passed into the `AuthBroker` it builds; for `certificate` it writes through `setDestination` with Task 2's fields and the `.env` holds the literal `SAP_UAA_CLIENT_CERT_PATH` / `SAP_UAA_CLIENT_KEY_PATH` (absolute) / `SAP_UAA_CERT_URL` (or the `XSUAA_UAA_…` names when the XSUAA map is used), and no client secret variable; never PEM in any written file; relative paths resolved before writing, missing files refused naming the flag (Review Focus 4); a failed login leaves an existing destination file untouched; a fresh `AuthBroker` over the written `.env` (from its final location) builds the certificate destination.
- [ ] Implement; load-bearing each; `npm test`, test:check, lint; commit.

### Task 9: Live check on the BTP trial

**Files:**
- Create: `tests/live/x509/setup.sh`, `teardown.sh`, `lib.sh`, `xs-security.json` (modelled on auth-providers' `tests/xsuaa/`: exact `XSUAA_CF_API`/`ORG`/`SPACE` guard, `.local/owned` by GUID, teardown also on failure, failed teardown keeps `.local/` and exits non-zero), `.gitignore` entry for its `.local/`
- Create: `packages/auth-broker/src/__tests__/live/x509.live.test.ts`; `package.json` script wiring under `test:live`

- [ ] Setup: an XSUAA instance with `credential-types` including `x509`, a key created with `{"credential-type":"x509"}`, saved owner-only (0600) in `.local/`; PEM fixtures written there for the CLI paths.
- [ ] Cases (spec §6): (a) `AuthBroker` + `XsuaaServiceKeyStore` + `fromServiceKeyCertificate()` → `getProvider(dest).prepare()` Ok and the token API returns a token whose client id is the key's; (b) `mcp-auth --credential --client-auth certificate --cert-path <abs> --key-path <abs>` → a token with that client id, and a fresh broker over its exported destination gets one; (c) `generate-env-from-service-key <dest> <key> <session> --grant client_credentials --client-auth certificate --cert-path <abs> --key-path <abs>` → a path-only `.env`, then a fresh broker over it from its final location gets a token; (d) a failing run leaves the previous destination untouched and prints no PEM. Each run has a timeout; no interactive strategy is constructed or invoked.
- [ ] Assertions never print key material (boolean projections only, as in auth-providers' x509 test).
- [ ] Before any `cf` write: `cf target` equals the trial exactly — the controller confirms with the user, who logs in. Run `npm run test:live` once; teardown removes everything; `cf services` shows only what was there before.
- [ ] Commit.

### Task 10: Documentation, versions, release preparation

**Files:**
- Modify: `packages/auth-broker/README.md`, `packages/auth-broker-cli/README.md` (the strategy, the two factories and composing them, the `.env` variables, the CLI flags, what stays unmeasured: `authorization_code`/`passcode` over x509, ABAP keys with x509), `docs/` pages that describe destinations or service keys, `CLAUDE.md` (collaborators list, the live check), CHANGELOGs, `packages/auth-broker/package.json` 4.1.0, `packages/auth-broker-cli/package.json` 2.1.0 **with `@mcp-abap-adt/auth-broker ^4.1.0`** (it uses the new factories and the factory's fourth argument), lockfile
- Delete: `docs/superpowers/` (goal, spec, plan) after the external review, before merge — what they still owe goes into the PR description first

- [ ] Docs written against the code as built; every README example compiles.
- [ ] Full gates in the worktree: build, test:check, lint, `npm test`; the broker stand once.
- [ ] After the broker 4.1.0 is published and before the CLI is: pack the CLI and install it in a clean directory outside the repo from the registry — it resolves `@mcp-abap-adt/auth-broker` 4.1.0 (never 4.0.0) and `mcp-auth --help` runs.
- [ ] Push; external review; fixes into this PR; merge, tag and the user's publish on the user's word — `auth-broker` and `auth-broker-cli` in dependency order.
