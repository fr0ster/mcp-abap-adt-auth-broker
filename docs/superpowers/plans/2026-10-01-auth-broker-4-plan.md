# auth-broker 4.0.0 and the auth-broker-cli release on it — implementation plan

**Implements:** `docs/superpowers/specs/2026-10-01-auth-broker-4-design.md` (the
spec), under `docs/superpowers/2026-09-30-auth-broker-4-goal.md` (the goal). The
goal's *Holds throughout* (H0–H6) bind every step; where a step and a hold
disagree, the hold wins and the step changes in review. The plan does not
redesign the spec. Where reading the code showed the spec stale or wrong, the
plan says so under *Spec points found while planning*: facts were corrected in
the spec in review; design points are named as decisions the user must take
before that step opens — never fixed silently.

**Status:** draft for review in #33, with the goal and the spec; D8 and D9
(2026-10-02) and the steps 4c1–4c3 recorded in #37.

**What a step is here.** Each step is one pull request, reviewed and merged
before the next one opens — across all repositories, this one included. Code
appears at implementation, test-first: the plan names the tests and the rule
each protects, not their bodies. No step carries a time estimate.

## Already done

- **`@mcp-abap-adt/interfaces-auth-sap` 2.0.0 and `@mcp-abap-adt/interfaces-auth-broker`
  1.0.0 are published** (2026-10-01; registry: `interfaces-auth-broker` serves
  `1.0.0`, `interfaces-auth-sap` serves `2.0.0`; tags
  `interfaces-auth-sap-v2.0.0`, `interfaces-auth-broker-v1.0.0` in
  `mcp-abap-adt-interfaces`, merged as `6165673`). Verified against that
  repository:
  - `packages/interfaces-auth-broker/src/index.ts` exports `DestinationGrant`,
    `IConfig`, `IConnectionConfig`, `IServiceKeyStore`, `ISessionStore`,
    `ITokenProviderResult`. `IConnectionConfig` carries every spec §1.1 field
    (`grantType`, `expiresAt`, the ten `oidc*`, the nine `saml*`) beside the
    1.1.0 fields; `DestinationGrant` is the spec's ten values. It depends on
    `interfaces-auth-sap` `^2.0.0` only, for `IAuthorizationConfig`.
  - `packages/interfaces-auth-sap/src/index.ts` (2.0.0) keeps `AuthType`,
    `AUTH_TYPE_XSUAA`, `AUTH_TYPES`, `IAuthorizationConfig`,
    `ICertificateMaterialLoader`, `ISapConfig`, `SapAuthType`,
    `SapConnectionType`, the validation types. `git diff
    interfaces-auth-sap-v1.1.0 interfaces-auth-sap-v2.0.0` touches no file that
    holds `IAuthorizationConfig`, `ISapConfig` or `ICertificateMaterialLoader`:
    those shapes are identical in 1.1.0 and 2.0.0.
- So spec §1.1 is delivered; the spec and the goal now record it (see *Spec
  points*).
- **The split is released ahead of 4.0.0** (decided by the user 2026-10-01,
  after step 3): `@mcp-abap-adt/auth-broker` **3.1.0** — no `bin`, the library
  API unchanged, `axios`, the logger, `auth-stores` and `auth-providers` out of
  its dependencies — and `@mcp-abap-adt/auth-broker-cli` **1.0.0** — the 3.x
  commands as they are — depending on `@mcp-abap-adt/auth-broker` `^3.1.0`.
  Both versions are set in step 3's PR (#34); tags `auth-broker-v3.1.0` and
  `auth-broker-cli-v1.0.0` on its merge commit, one `release:publish` run,
  library first. Consequences, carried into the steps below: step 5 becomes a
  later CLI version (not 1.0.0); step 7 releases `auth-broker` 4.0.0 with that
  CLI version; the CLI's range on the library is `^3.1.0` until step 7 raises it
  to `^4.0.0`; R5 no longer holds after the publish.
- Goal path steps 1–3a (interfaces-auth 3.0.0, auth-providers 5.0.1,
  connection 10.0.2, auth-stores 2.0.0) are released, as the goal says.

## Rules every step follows

- **Location.** A worktree per step, never a branch switch in a main checkout
  (parallel sessions use them). auth-broker and auth-providers:
  `<repo>/.worktrees/<name>` (gitignored in both). auth-stores has no
  gitignored `.worktrees/`: `~/prj/.wt-<name>`. Branch from the repository's
  default branch (`master` in auth-stores and auth-providers, `main` in
  auth-broker), freshly pulled.
- **Test first.** For each rule a step introduces: the test is written, run and
  seen red for the reason the rule names, then the code makes it green.
- **Load-bearing proof.** Before the PR goes to review, each rule the step lists
  is broken on purpose — one conjunct at a time where a rule has several — the
  named test goes red with the fragment only that rule produces, and the code
  is restored. The PR description lists each break and the test that caught it.
- **Gate** (in the step's worktree, never in a main checkout — the main
  checkouts hold `tests/test-config.yaml`, and auth-providers' `npm test` there
  reaches live systems): the repository's own build, type check, lint and test
  commands, named per step. All green before the push.
- **Docs.** Every document the change touches — README, everything under
  `docs/`, `CLAUDE.md`/`AGENTS.md` where they describe the changed behaviour,
  usage examples — not only the CHANGELOG. Changes go under `[Unreleased]`
  until the step that releases them. A breaking release carries a migration
  note.
- **Review and merge.** Commits are pushed to the PR branch before any external
  review. I merge, and tag, only on the user's word. The user publishes. After a
  publish: the registry check named in the step, and a build and test of the
  released tag in the main checkout once the worktree is removed (with the
  user's go-ahead where the suite reaches live systems).
- **Next step** opens only after the previous PR is merged (and, where it
  releases, published and checked).

## Step 0 — this PR (#33): goal, spec, plan

- **Repository:** auth-broker, worktree `.worktrees/broker-4`, branch
  `docs/auth-broker-4-goal`.
- **What:** review of this plan; the user's decisions on the open points below
  (*Decisions needed*) recorded in the spec or here before merge.
- **Merge:** on the user's word. Documentation only, no release.
- **Next depends on:** the merge, and decisions D2 and D6 (step 1), D3 (step 2).

## Step 1 — `@mcp-abap-adt/auth-stores` 3.0.0 (spec §1.2)

- **Repository:** `mcp-abap-adt-auth-stores`, worktree `~/prj/.wt-auth-stores-3`,
  branch `feat/means-and-secret` from `master` (`2a7fc4b`, 2.0.0).
- **Version: major (3.0.0)** — spec §1.2 item 5, with the evidence there: the
  session stores refuse means writes 2.0.0 accepted (the 3.x broker's
  `persist`, `src/AuthBroker.ts:301-308`; the 3.x CLI, `bin/mcp-auth.ts:890`,
  `bin/mcp-sso.ts:826`, `:845`, `bin/generate-env-from-service-key.ts:122`),
  stop answering means 2.0.0 answered (read first by the 3.x broker,
  `src/AuthBroker.ts:264-285`, `:378-420`), and the service key stores change
  their answers (`authType` added, `authorizationToken: ''` gone). The
  2.1.0-era type-compatibility check is dropped: it can no longer change the
  version. Decision D2 confirms 3.0.0.
- **What changes, by spec §1.2 item:**
  1. Dependencies: `@mcp-abap-adt/interfaces-auth-broker` `^1.0.0` added;
     `@mcp-abap-adt/interfaces-auth-sap` `^1.1.0` → `^2.0.0`; the store files
     and test helpers import the store contracts from `interfaces-auth-broker`,
     `IAuthorizationConfig` from `interfaces-auth-sap`.
  2. Item 1 — the five session stores (`AbapSessionStore`,
     `SafeAbapSessionStore`, `XsuaaSessionStore`, `SafeXsuaaSessionStore`,
     `EnvFileSessionStore`) hold the secret alone: token or cookies,
     `expiresAt` (`SAP_EXPIRES_AT`, `XSUAA_EXPIRES_AT`), refresh token; no
     `serviceUrl` required or answered; a write carrying any means field is
     refused naming the fields; `setAuthorizationConfig` refuses,
     `getAuthorizationConfig` answers `null`; writing one secret kind clears
     the other; the XSUAA stores keep refusing a session without a token.
  3. Item 2 — 2.x files still read: the session store answers only the secret
     keys; a session write rewrites only secret keys and preserves every other
     line (no `SAP_URL`, no `SAP_AUTH_TYPE`, no clearing of other types' keys).
  4. Item 3 — `AbapServiceKeyStore` and `XsuaaServiceKeyStore` answer
     `authType: 'jwt'`, no `grantType`, and no `authorizationToken`.
  5. Item 4 — the destination store, **as decision D6 settles it**
     (recommended: an `IServiceKeyStore` over `<dir>/<destination>.env` with
     the 2.x key names plus `SAP_GRANT_TYPE`, `SAP_OIDC_*`, `SAP_SAML_*`; the
     public client as `''`; an optional fallback `IServiceKeyStore`; a write
     method of its own outside the contract). New exports: the class and its
     key constants.
- **Tests first, and the rule each protects:**
  - each session store: a write of `{ authorizationToken, expiresAt,
    refreshToken }` with no `serviceUrl` is kept and read back through
    `loadSession` (item 1 — red against 2.0.0, which needs `SAP_URL`);
  - each means field, one test per field group (URL and type, basic, SNC,
    client, OIDC, SAML, `sapClient`/`language`), refused by a session write
    with the field names in the message and no value (item 1);
  - token then cookies clears the token, and back (item 1); an XSUAA session
    without a token is still refused (item 1);
  - a 2.x fixture file with every key: `loadSession` answers only the four
    secret fields; after a session write every non-secret line is byte-for-byte
    unchanged (item 2);
  - both service key stores: `authType: 'jwt'`, `grantType` absent,
    `authorizationToken` absent (item 3);
  - the destination store (per D6): every means field written and read back;
    `uaaClientSecret: ''` answered as a public client; the fallback store fills
    only what the file leaves out; the same 2.x fixture read as means; no
    secret field is answered (item 4);
  - one file shared by both stores (the destination store and the session
    store pointed at the same directory — what a consumer may compose, and
    what step 5's CLI does), in both orders: write a session (token or
    cookies, `expiresAt`, refresh token), then update the means through the
    destination store — every secret key is still there and `loadSession`
    answers it unchanged; write means, then a session — every means key is
    still there and the destination store answers it unchanged; and an
    update of one means field keeps the others (items 2 and 4).
- **Load-bearing:** let the destination store's write rewrite the file with its own keys only, and the shared-file test goes red; accept one means field in a session write (each group
  alone); answer `SAP_URL` from a session; clear another type's keys on a
  session write; answer a `grantType` from a service key; drop the `''`
  pass-through; let the file override nothing / everything in the fallback —
  each red alone.
- **Gate:** `npm run build`, `npm run test:check`, `npm run lint:check`,
  `npm test` — in the worktree, where `tests/test-config.yaml` is absent and the
  helper falls back to the template (`src/__tests__/helpers/configHelpers.ts:65-110`);
  the gate confirms the integration suites skip on the template, and if any does
  not, that is fixed in this step before anything else (R4).
- **Docs:** README (the two roles; *Session Stores* reduced to the secret; the
  destination store and its key names; the 2.x file mapping table of spec §1.2
  item 2; public client), CHANGELOG 3.0.0 (*Breaking*, with a migration note
  for a consumer on the 2.x roles: write means through a key store, read them
  from one), `docs/archive` untouched.
- **Release:** 3.0.0, tag `v3.0.0` on the merge commit, `npm publish` by the
  user; check `npm view @mcp-abap-adt/auth-stores@3.0.0 version` and its
  `dependencies` naming `interfaces-auth-broker`; build and test the tag in the
  main checkout.
- **Next depends on:** 3.0.0 on the registry (the broker's dev dependency and
  the CLI's runtime dependency are `^3.0.0`).

## Step 2 — `@mcp-abap-adt/auth-providers` 5.1.0 (spec §1.3)

- **Repository:** `mcp-abap-adt-auth-providers`, worktree
  `.worktrees/seeded-expiry`, branch `feat/seeded-expiry` from `master`
  (`1cf6767`, 5.0.1).
- **Version: minor.** Additive optional config fields; no export removed.
  Moving `interfaces-auth-sap` to the 2.x line is also minor: auth-providers
  imports only `IAuthorizationConfig`, `ISapConfig`, `ICertificateMaterialLoader`
  from it (`src/providers/AuthorizationCodeProvider.ts:14`,
  `src/auth/browserAuth.ts:6`, `src/credentials/CertificateAuthProvider.ts:9-12`,
  `src/credentials/FileCertificateMaterialLoader.ts:3-6`), all `import type`,
  and none of the three changed between 1.1.0 and 2.0.0 (see *Already done*).
  Nothing that moved to `interfaces-auth-broker` is imported. Range: decision
  D3.
- **What changes:**
  1. `Saml2PureProviderConfig` gains `accessToken?` (the stored cookies) and
     `expiresAt?`; the constructor seeds the cache with them, so a seeded
     provider answers `getTokens()` from them until `expiresAt` (less the
     base's one-minute buffer) and logs in after. `refreshToken?` per decision
     D4.
  2. The JWT providers that take `accessToken?` (`AuthorizationCodeProvider`,
     `UaaPasscodeProvider`, `OidcBrowserProvider`, `OidcDeviceFlowProvider`,
     `OidcPasswordProvider`, `OidcTokenExchangeProvider`,
     `Saml2BearerProvider`) take `expiresAt?`, used only when
     `parseExpirationFromJWT` finds no `exp`.
  3. `interfaces-auth-sap` range (D3). Dev dependency `@mcp-abap-adt/auth-stores`
     unchanged (`packageManifest.test.ts` only requires it present).
- **Tests first:**
  - a seeded `Saml2PureProvider` before `expiresAt`: `getTokens()` returns the
    seed, `authorize()` writes the cookies, the strategy is never called; after
    `expiresAt`: one login through the strategy; seeded without `expiresAt`: a
    login (the base treats it as expired — `BaseTokenProvider.ts:95-96`);
  - each JWT provider: a seed with no `exp` and a future `expiresAt` is reused; a
    seed with an `exp` ignores a conflicting `expiresAt` (the token's own claim
    wins); a seed with neither is renewed;
  - `onTokens` after the seeded provider's login carries the new `expiresAt`.
- **Load-bearing:** drop the Saml2Pure seed; make `expiresAt` override `exp`;
  drop the `expiresAt` fallback in one JWT provider — each red alone.
- **Gate (worktree only):** `npm run build`, `npm run test:check`,
  `npm run lint:check`, `npm test` (integration suites skip without
  `tests/test-config.yaml`; the stand suites without `UAA_URL`/`KEYCLOAK_URL`).
  `npm run test:stand` once, since a provider's seeding changed: it needs only
  Docker.
- **Docs:** README (each affected provider's config table, the SAML-pure
  section's seeding paragraph near `README.md:694-716`), `CLAUDE.md` (the
  `Saml2PureProvider` line in *Token providers* if it describes seeding), CHANGELOG
  5.1.0. `docs/btp-setup.md` and `docs/passwordless-sso.md`: read, changed only
  if they describe seeding (expected not).
- **Release:** 5.1.0, tag `v5.1.0`, `npm publish` by the user; check
  `npm view @mcp-abap-adt/auth-providers@5.1.0 version`; build and test the tag
  in the main checkout with the user's go-ahead (live systems).
- **Next depends on:** 5.1.0 on the registry (step 4's `^5.1.0`). Step 3 does
  not depend on steps 1–2 and could precede them; it follows them only because
  one PR is open at a time.

## Step 3 — auth-broker takes the `mcp-abap-adt-interfaces` layout (spec §11)

**Its own PR, before any feature work.** It is mostly moves (`src/` →
`packages/auth-broker/src/`, `bin/` → `packages/auth-broker-cli/src/`), and git
detects a move only while the file is barely changed. Mixed with the 4.0
changes, every moved file would review as deleted and re-added, and the feature
diff would be unreadable. Alone, the PR reviews as renames plus a small set of
new files (root manifest, tools), and the 3.x behaviour is unchanged — the
existing suites prove it.

- **Repository:** auth-broker, worktree `.worktrees/workspace`, branch
  `chore/workspace-layout` from `main`.
- **What changes (spec §11, *Mirrored here*):**
  1. Private root `package.json` with `workspaces` in dependency order
     (`packages/auth-broker`, `packages/auth-broker-cli`), the root scripts of
     §11 item 2 plus `test`, root dev dependencies (Biome, TypeScript,
     `@types/node`, `semver`, Jest, `ts-jest`, `@types/jest`), one lockfile,
     `tsconfig.base.json`.
  2. `packages/auth-broker`: today's `src/` (library code and its tests),
     `tests/test-config.yaml.template`, README (API part), CHANGELOG (moved,
     history kept), LICENSE, COPYING; `repository.directory`, `homepage`,
     `files: ["dist", …]`, `prepublishOnly: npm run --prefix ../.. check`; no
     `bin`. Its runtime dependencies become what its `src` imports
     (`interfaces-auth`, `interfaces-auth-sap`, `interfaces-utils` at the 3.x
     ranges); `auth-stores` and `auth-providers` become dev dependencies (tests
     import them); `axios` and `@mcp-abap-adt/logger` leave (spec §12 item 5;
     the logger is the CLI's). Version `3.1.0` (decided 2026-10-01; planned
     as staying `3.0.4`), CHANGELOG `[3.1.0]` records the removals and the
     migration.
  3. `packages/auth-broker-cli`: `bin/*.ts` as `src/`, compiled to `dist/`,
     `bin` = `mcp-auth`, `mcp-sso`; the bin tests and fixtures, `tests/keycloak`,
     `tests/sso-demo` and their npm scripts; `generate-env` script. Only the
     changes a move forces (spec §10, first two bullets): `AuthBroker` imported
     from `@mcp-abap-adt/auth-broker` instead of `require`d from a `dist` path
     (`bin/mcp-auth.ts:28-29`, `bin/mcp-sso.ts:38-39`); `getVersion()` reads the
     CLI's manifest. Dependencies: the 3.x set the bins import, plus
     `@mcp-abap-adt/auth-broker` `^3.1.0`. Version `1.0.0`, CHANGELOG
     `[1.0.0]`, README (the `mcp-auth` / `mcp-sso` sections moved
     from the library README).
  4. `tools/`: `publish-changed.js`, `test-publish-changed.js` (copied, the
     interfaces-facade comments removed), `check-graph.js` (allowlist of §11;
     adapted as spec §11 now says, R1), `check-packed.js` (the bin smoke check
     of §10), `version-stats.sh`.
  5. `.github/workflows/release.yml` triggers on `auth-broker-v*` /
     `auth-broker-cli-v*` and packs the workspace the tag names (§11
     *Departures*).
  6. Root README becomes the workspace overview; `CLAUDE.md`, `AGENTS.md`
     describe the layout and the new commands.
- **Released after all (user's decision, 2026-10-01):** the PR sets the library
  to `3.1.0` and the CLI to `1.0.0` with `@mcp-abap-adt/auth-broker` `^3.1.0`;
  both CHANGELOGs dated, the library's with the migration (global installs move
  to the CLI package; a consumer that imported `auth-stores` / `auth-providers`
  through this package's dependencies declares them). Minor, not major: the
  library's API is unchanged; only where the commands install from, and the
  dependencies it pulls in, changed. Until the tags exist `release:publish`
  refuses for missing tags (`tools/publish-changed.js`).
- **Tests first:** `check-packed.js` written first and run red against today's
  single package (a bin that `require`s `dist` by path, a library with `bin`);
  `check-graph.js` red on a library `src` file importing `auth-stores` (H0 made a
  check). The 3.x suites (`AuthBroker.test.ts`, the bin suites) move unchanged
  and stay green — no behaviour change is the claim of this step.
- **Load-bearing:** add an `auth-stores` import to the library's `src` →
  `check:graph` red; put a `bin` back in the library manifest, or the dist-path
  `require` back in a bin → `check:packed` red; the CLI `--version` reading the
  library's manifest → `check:packed` red.
- **Gate (worktree):** `npm ci`, `npm run check` (build, `test:check`,
  `lint:check`, `check:graph`, `check:packed` — needs the network, says so when
  it cannot reach it — `check:publish`), `npm test`.
- **Docs:** root README (overview, install commands for both packages), both
  package READMEs, `docs/architecture/ARCHITECTURE.md` (layout),
  `docs/development/TESTING.md` (commands, where suites now live),
  `docs/installing/INSTALLATION.md` (the CLI's install command and the
  global-install swap), `CLAUDE.md`, `AGENTS.md`.
- **Release:** `auth-broker` 3.1.0 and `auth-broker-cli` 1.0.0 — on the user's
  word, merge; tags `auth-broker-v3.1.0`, `auth-broker-cli-v1.0.0` on the merge
  commit; the user runs `npm run release:publish` (library first). Registry:
  `npm view @mcp-abap-adt/auth-broker@3.1.0 bin dependencies` (no `bin`, no
  `auth-stores`), `npm view @mcp-abap-adt/auth-broker-cli@1.0.0 bin dependencies`,
  then the §10 smoke check against the registry versions in an empty directory.
  Build and test the tags in the main checkout.
- **Next depends on:** the merge.

## Step 4 — `@mcp-abap-adt/auth-broker` 4.0.0, in five PRs (and, between 4c and 4d, three for D8/D9)

All in auth-broker, each in its own worktree under `.worktrees/`, branched from
`main` after the previous merge. Every PR keeps the carried-over §9 suite
(today's `AuthBroker.test.ts`) green — H5 holds at every merge, not only at the
end. Master stays clearly unreleased throughout: the library's version stays
`3.1.0` and the CLI's `1.0.0` (both published, so `release:publish` has nothing
to do) until step 7, and each package's `[Unreleased]` collects the changes. The gate of every
step-4 PR is the step-3 gate: `npm run check` and `npm test` in the worktree.

### 4a — both packages on the new contracts and providers

- **Branch:** `feat/contracts-auth-3`.
- **Why first, and why both packages together:** once the library's types come
  from `interfaces-auth` 3, a CLI still on auth-providers 4 (`interfaces-auth`
  2) cannot pass its provider to `AuthBroker` and `npm run check` builds both —
  so the library's contract bump and the CLI's move to auth-providers 5 land in
  one PR, with no new feature.
- **What changes:**
  - library: `interfaces-auth` `^3.0.0`, `interfaces-auth-sap` `^2.0.0`,
    `interfaces-auth-broker` `^1.0.0`; store contracts imported from
    `interfaces-auth-broker`, `IAuthorizationConfig` and `AuthType` from
    `interfaces-auth-sap`; the 3.x re-exports kept (spec §2), from the new
    sources; dev dependency `auth-providers` `^5.1.0`; dev dependency
    `auth-stores` **stays `^1.2.3`** (decision D7 — it moves in 4e).
    Spec §14 stale comments: `src/index.ts:34-37`, `src/stores/index.ts:4-6`
    (non-existent `auth-stores-btp`/`-xsuaa`), `src/types.ts:4`,
    `src/stores/interfaces.ts:4` (they name `interfaces-auth-broker` for the store
    contracts, as spec §14 now says).
  - CLI (spec §10, third bullet): `auth-providers` `^5.1.0`; `auth-stores`
    **stays `^1.2.3`** (decision D7 — it moves in step 5); its range on `@mcp-abap-adt/auth-broker`
    stays `^3.1.0` (the workspace links the library whatever its range, and
    `check:packed` installs the packed one) until step 7 sets `^4.0.0` — a
    published CLI must never accept a library it was not built against, which
    is why the range moves only in the release that publishes both; the device flow gets
    `consoleDeviceCodePresenter(logger)`; the SAML flows get an
    `assertionValidator` built from the trust the CLI collects
    (`createSignedResponseValidator` for pure, `createSignedAssertionValidator`
    for bearer, `defaultReplayStore`) in place of `idpCertificates`
    (`bin/mcpSsoConfig.ts:595-602` before the move); manual strategies get
    `read: (prompt, signal)`, and `readManualInput` closes its `readline` and
    rejects when the signal aborts.
- **Not in 4a (D7, measured 2026-10-01):** auth-stores 3.0.0. Its session
  stores refuse means and its `setAuthorizationConfig` always refuses, so on
  it the 3.x `persist` (`AuthBroker.ts`, `setConnectionConfig` with
  `serviceUrl`/`authType`, `setAuthorizationConfig`) throws
  `RefusedFieldsError` — the carried-over §9 case *with AbapSessionStore on
  disk* goes red — and every CLI command fails at its first session write
  (`mcp-sso.ts:808`, `:827`, `mcp-auth.ts:872`,
  `generate-env-from-service-key.ts:122`) as well as inside `getToken`. The
  fixes are 4e's (persist writes the secret alone) and step 5's (means to the
  destination store); neither is 4a's.
- **Tests first:** the CLI provider-construction suites (`mcpSsoConfig`,
  `mcpSsoSamlProviders`) assert the presenter, the validator kind per flow and the
  `read` signature, and a SAML fixture signed by another key is refused;
  `readManualInput` rejects on abort and leaves no open `readline` (the input
  stream is closed); the library suite unchanged.
- **Load-bearing:** swap the two validators; drop the abort handling; each red.
- **Docs:** library README and `docs/architecture/EXPORTS.md` (where the
  re-exported types now come from), CLI README (no flag changes; the trust is
  validated), both CHANGELOGs `[Unreleased]`.
- **Next depends on:** the merge.

### 4b — `getProvider` for the destinations that renew nothing; the error; the cache

- **Branch:** `feat/get-provider-core`.
- **What changes:** spec §2 (`getProvider`, `DestinationConfigError`,
  `provider` optional; the collaborator options declared but no row uses them
  yet), §3.1 (the pair table, `authType` + `grantType` only, read from the key
  store), §3.2 (means from the key store only — no fallback to a session's
  means, not even for a 3.x file), §3.3 (means from `IServiceKeyStore`, the
  secret from `loadSession`; the broker's `getConnectionConfig` /
  `getAuthorizationConfig` composed from both; store reads keep the 3.x
  absence rule), §4.1 (how a provider is built from the two stores) rows
  `basic`, `snc`, `jwt`/`none`, `saml`/`none`, §4.2,
  §4.4 (every case that applies to these rows; a constructor's
  `ValidationError` — `sncQop` — becomes a `DestinationConfigError` naming the
  store field, original as `cause`), §7 (the promise cache: set before the first
  read, dropped on a throw). The library gains `auth-providers` `^5.1.0` as a
  runtime dependency (first import).
- **Why this cut:** none of these rows obtains a token, so no provider handed
  out here could renew without being persisted — H3 cannot be violated at this
  merge.
- **Tests first (stores as in-memory fakes of the contract; providers real):**
  - `basic`: the returned provider writes the Basic header and offers
    `{ user, passwd }` — asserted through `IAuthProvider` only, nothing branching
    on the class (spec §13);
  - `snc`: `prepare()` then the logon target receives `snc_partnername`,
    `snc_qop`, `snc_myname`, `snc_lib`, with `sncLib` pointing at a fixture
    whose header is the host's architecture (risk R3); a missing `sncLib` file
    is refused naming `sncLib`;
  - each `none`: presents what the session store holds; without a session it
    is the error naming the field;
  - the split: a session fake answering `authType`, `grantType`, `username` or
    a client is ignored, so a destination whose means only the session holds is
    the error naming `authType`; a key store answering `authorizationToken` is
    not a seed; the key store fake has no write method and a spy shows none
    called;
  - `DestinationConfigError`: no `serviceKeyStore` option, no means, no
    `authType`, an unknown one, `jwt`/`saml`
    without `grantType`, each invalid pair, each missing field of these rows,
    `''` as missing, the `sncQop` constructor error with `cause`;
    `missingFields` asserted, and no stored value appears in the message;
  - H1: a destination whose fields would suggest another type (cookies beside a
    `basic` type) gets the stated type's provider;
  - cache: concurrent first calls build once; a failed build is retried on the
    next call.
- **Load-bearing:** the pair table (allow one invalid pair), the `''`-is-missing
  rule, a fallback to the session's means (add it: the split test goes red),
  the promise cache (set after the `await`, as 3.x did), the value-free
  message — each red alone.
- **Docs:** library README (the destination table for these rows,
  `DestinationConfigError`), `docs/using/USAGE.md` (`getProvider` for basic and
  SNC), `docs/architecture/ARCHITECTURE.md`, `EXPORTS.md`, CHANGELOG.
- **Next depends on:** the merge.

### 4c — persistence through `onTokens`; the UAA grants

- **Branch:** `feat/get-provider-persistence`.
- **What changes:** spec §6 whole (`persist` rules 1–3 — one `saveSession` of
  the secret alone, the stored refresh token carried forward, no means ever
  written, nothing written for `basic`/`snc` — `expiresAt` written, the
  broker's own retry queue — growing delay capped at one minute, `unref()`ed
  timer, latest result replaces a pending one, attempts per destination never
  overlap, failures logged by class name only — and `flush()`); §4.1 rows
  `jwt`/`authorization_code`, `jwt`/`client_credentials`, `jwt`/`passcode` with
  the seed (`expiresAt` included), the logger and `onTokens`; §5 for the
  `authorization` option (called once per build, with the grant; required only
  by its rows; never disposed by the broker); §4.4 for these rows (`uaaUrl`,
  `uaaClientId`, the secret where the provider needs one, the `authorization`
  option by name — **not `serviceUrl`**, D8: the requirement 4c first had is
  removed in the same PR, its test inverted); §3.3 public
  client (`''` from the key store reaches the provider as no secret); §4.1 item
  3 (no session: unseeded, logs in at `prepare()`).
- **Why persistence and the first token rows together:** a token provider handed
  out without `onTokens` would break H3 at this merge.
- **Tests first:**
  - each UAA row obtains from a local token endpoint with exactly the stored
    fields; `authorization` is called with `(destination, grant)`; `passcode`'s
    strategy is handed `<uaaUrl>/passcode`;
  - persistence (spec §13): a renewal through `rejected({ at: 'request',
    status: 401 })` on the returned provider is in the session store afterwards,
    and the `saveSession` call's field set is exactly `{ authorizationToken,
    expiresAt, refreshToken }` — **no client secret** (H4), no `serviceUrl`, no
    `authType`; a result with no refresh token carries the stored one forward;
    no write for a `basic` / `snc` destination (rule 3); a destination with no
    session logs in at `prepare()` and its first secret is written;
  - retry: a store whose write fails once — `onTokens` does not throw, the
    authentication succeeds, and with no further call to the provider (fake
    timers) the same result is written; delays grow and cap; a newer result
    replaces the pending one; two attempts for one destination never overlap;
    the logged failure carries the class name and no message;
  - `flush()` resolves once pending writes land; rejects naming the destination
    when the store still fails; the timer does not keep the process alive.
  - D8: each UAA row with `serviceUrl` absent or `''` in the means is built
    and obtains a token (red while `uaaProvider` required it).
  - live (`npm run test:live` only): the `jwt` / `authorization_code` case
    takes its means from the SAP service key — `AbapServiceKeyStore` over
    `AUTH_BROKER_LIVE_SERVICE_KEYS_DIR`, the grant added by a test-only
    wrapper marked "until auth-stores 3.1.0" — and its session from a
    temporary copy of `AUTH_BROKER_LIVE_SESSIONS_DIR`'s file.
- **Load-bearing:** write `serviceUrl`, then `authType`, then the client
  secret into the session — each alone (the field-set test); drop the carried
  refresh token; drop the `basic`/`snc` guard; remove the retry (write once);
  remove `unref()`; let attempts overlap; require `serviceUrl` again — each
  red alone.
- **Docs:** library README (persistence, `flush()` and when to call it,
  collaborator `authorization`, the UAA rows, no `serviceUrl` needed),
  `docs/using/USAGE.md`, `ARCHITECTURE.md`, `TESTING.md` (the live case's
  service keys), CHANGELOG.
- **Next depends on:** the merge.

### 4c1 — `@mcp-abap-adt/interfaces-auth-broker` 1.1.0 (spec §1.4; D9)

- **Repository:** `mcp-abap-adt-interfaces`, a worktree per its own rules,
  branch `feat/issued-for` from its default branch.
- **What changes:** `IConnectionConfig.issuedFor?: string`, documented as
  "the canonical URI of the resource the secret was obtained for" — the
  canonical form of spec §1.4 (scheme and host lower-cased, explicit port,
  path without a trailing `/`, `sap-client=<n>` when the destination states a
  client) in the doc comment; types only, no function (the interfaces
  package holds no logic). Version 1.1.0, minor.
- **Tests first:** whatever the interfaces repository's own checks hold for an
  added field (its surface/package-map checks list the export unchanged; the
  type compiles in a consumer that sets it).
- **Gate:** that repository's `npm run check`.
- **Release:** tag `interfaces-auth-broker-v1.1.0`, the user publishes;
  `npm view @mcp-abap-adt/interfaces-auth-broker@1.1.0 version`.
- **Next depends on:** 1.1.0 on the registry.

### 4c2 — `@mcp-abap-adt/auth-stores` 3.1.0 (spec §1.5; D8, D9)

- **Repository:** `mcp-abap-adt-auth-stores`, worktree
  `~/prj/.wt-auth-stores-31`, branch `feat/key-store-options-issued-for` from
  `master` (3.0.0).
- **What changes:**
  1. `AbapServiceKeyStore(dir, { grantType?, log? })` and
     `XsuaaServiceKeyStore(dir, { serviceUrl?, grantType?, log? })` — an
     option given is what `getConnectionConfig` answers for that field; the
     3.0.0 `(dir, log)` form keeps working (minor).
  2. The session stores keep `issuedFor` (`SAP_ISSUED_FOR`,
     `XSUAA_ISSUED_FOR`, a field in the in-memory ones): accepted by
     `saveSession`, written and cleared with the credential, answered by
     `loadSession` while a credential is held. Stored as given — the store
     neither canonicalises nor judges it.
  3. Legacy read: a file holding a credential and no `SAP_ISSUED_FOR` answers
     `issuedFor` from `SAP_URL` with `SAP_CLIENT` as `sap-client`
     (`XSUAA_MCP_URL` for the XSUAA stores).
  4. `interfaces-auth-broker` `^1.1.0`.
- **Tests first, and the rule each protects:** each option answered, and its
  absence leaving the 3.0.0 answer (item 1); `issuedFor` written and read back
  with a token and with cookies, cleared by a new credential written without
  it, not answered once the credential is cleared (item 2); a 2.x fixture and
  a 3.0.0-written file each answer `issuedFor` from `SAP_URL` (+ client), and
  a file that has `SAP_ISSUED_FOR` answers it and ignores `SAP_URL` (item 3).
- **Load-bearing:** drop the option (answer the key's reading); keep
  `issuedFor` across a new credential; read `SAP_URL` even when
  `SAP_ISSUED_FOR` is present; drop `SAP_CLIENT` from the legacy URI — each
  red alone.
- **Gate:** as step 1.
- **Docs:** README (the options; `issuedFor` and the legacy reading, with the
  remaining risk of spec §1.5 item 3), CHANGELOG 3.1.0.
- **Release:** tag `v3.1.0`, the user publishes; `npm view
  @mcp-abap-adt/auth-stores@3.1.0 version dependencies`.
- **Next depends on:** 3.1.0 on the registry.

### 4c3 — the broker binds a secret to its resource (spec §4.5, §6; D9)

- **Repository:** auth-broker, branch `feat/secret-bound-to-resource`.
- **What changes:** `interfaces-auth-broker` `^1.1.0`; the dev alias
  `auth-stores-3` `^3.1.0`. One canonicalising function in the library
  (spec §4.5 item 1). `getProvider` computes this destination's resource URI
  from the means (`serviceUrl`, `sapClient`) and seeds a provider only when the
  session's `issuedFor`, canonicalised, equals it; otherwise the secret —
  refresh token included — is not used, and the log says only "secret bound to
  another resource, discarded". `persist` writes `issuedFor` with every
  secret (none when the means state no URL). The `none` rows: as the user
  decides on spec §4.5 item 4 when this step opens. The live case's
  `withGrant` wrapper is replaced by `new AbapServiceKeyStore(dir,
  { grantType: 'authorization_code' })`.
- **Tests first** (spec §13): a mismatched `issuedFor` — a different host, a
  different path, a different client, `issuedFor` absent, `serviceUrl` absent
  — is not seeded: a fresh login (the endpoint sees the grant, never the
  stored refresh token), the stored token never presented, the log line
  carrying neither URI nor any part of the secret, the new secret written
  with this destination's `issuedFor`. Variants that canonicalise equal are
  seeded: host case, scheme case, explicit default port, trailing `/`,
  `sapClient` against `?sap-client=` in the URL. The field-set test now
  expects `issuedFor` beside the secret. The stand suite runs the binding
  against UAA with auth-stores 3.1.0's file stores: a session file bound to
  another URL is not reused.
- **Load-bearing:** seed regardless of `issuedFor`; compare without
  canonicalising; drop the client from the URI; drop the path; write no
  `issuedFor` — each red alone.
- **Docs:** library README (the binding; what a consumer's own session store
  must keep), `USAGE.md`, `ARCHITECTURE.md`, `TESTING.md`, CHANGELOG.
- **Next depends on:** the merge; then 4d.

### 4d — OIDC and SAML grants; the remaining collaborators

- **Branch:** `feat/get-provider-oidc-saml`.
- **What changes:** §4.1 rows `oidc_authorization_code`, `device_code`,
  `password`, `token_exchange`, `saml2_pure` (seeded with `sessionCookies` and
  `expiresAt`, auth-providers 5.1.0), `saml2_bearer` (token persisted to
  the session as a token); §4.1 validator composition (`createSignedResponseValidator` for pure,
  `createSignedAssertionValidator` for bearer, from `samlIdpCertificates`,
  `samlClockSkewMs` and the consumer's replay store; `samlIdpEntityId` as
  expected issuer); §5 options `oidcAuthorization`, `deviceCodePresenter`,
  `samlCookies`, `assertionReplayStore`; §4.4 for these rows (OIDC issuer or
  explicit endpoints; `idpInitiated` with a request ID → `DestinationConfigError`
  with `cause`); `oidcScopes.join(' ')` for `token_exchange`.
- **Tests first:** each row obtains from a local endpoint with exactly the
  stored fields and calls its collaborator (recording strategy, presenter,
  cookie function, replay store); the SAML rows validate a signed fixture
  assertion against `samlIdpCertificates` and refuse one signed by another key;
  a seeded `saml2_pure` destination reuses its cookies before `expiresAt` and
  logs in after; a `saml2_bearer` token is written as a token, `saml2_pure`
  cookies as cookies, each with `expiresAt` and nothing else; each missing collaborator is a
  `DestinationConfigError` naming the option; a headless refusing collaborator
  yields Oops from `prepare()` with the class label and never the message.
- **Stand suites** per decision D5.
- **Load-bearing:** swap the two validators; drop the replay store; join scopes
  with another separator; pass `idpEntityId` from another field — each red.
- **Docs:** library README (all rows of the destination table; every
  collaborator option; headless use), `USAGE.md`, `ARCHITECTURE.md`,
  `EXPORTS.md`, `TESTING.md` (stand suites if D5), CHANGELOG.
- **Next depends on:** the merge.

### 4e — the token API on the shared cache; end to end through connection 10

- **Branch:** `feat/token-api-shared`.
- **What changes:** spec §9 whole — `getProvider` and the token API share the
  §7 cache when no consumer `provider` is given; with one, the token API is as
  3.x (persist after every `getTokens()` / `refreshTokens()`, cache hits
  included — but the secret alone, §6 — and its reads in the 3.x order, session
  then key store, H5); with a broker-built provider the token API writes nothing itself
  and throws the failure recorded for the result it received (the
  `WeakMap<ITokenResult, unknown>`; result identity holds — `BaseTokenProvider`
  passes the same object to `onTokens` and returns it,
  `auth-providers src/providers/BaseTokenProvider.ts:219-247`); the dev
  dependency `auth-stores` moves from `^1.2.3` to `^3.0.0` here (D7), with
  the token API's persist writing the secret alone — the carried-over case
  *with AbapSessionStore on disk* runs against the 3.0.0 store and asserts
  the secret alone in its file; `basic`/`snc`
  destinations — by the key store's `authType` — refused before any provider is asked; destinations whose row is
  not a token provider refused without a consumer `provider`; §4.3 (the README
  states the two-sources case).
- **Tests first:** every row of the §9 table carried over and green — the rows
  that asserted `serviceUrl` / `authType` / the client in the written session
  now assert the secret alone, as spec §9 says; with a consumer `provider` and
  a session store that still answers means, the token API reads them as 3.x
  did; `getProvider`
  and `getToken` share one provider and one renewal (one `onTokens`); the token
  API on a `basic` / `snc` destination throws `DestinationConfigError` and asks
  no provider; a write failure surfaces from `getToken` while the retry goes
  on; **through `connection` 10** (dev dependency): an `AdtCloudConnector` over
  HTTP against a local server answering 401 then 200 and a local token
  endpoint — one renewal, one resend, the new token in the session store (the
  goal's success criterion, spec §13).
- **Load-bearing:** separate caches for `getProvider` and the token API; drop the
  `basic`/`snc` refusal; drop the `WeakMap` lookup — each red.
- **Docs:** library README (token API section, `createTokenRefresher` not
  deprecated, the two-sources note), `USAGE.md`, `TESTING.md`, CHANGELOG
  *Breaking* item 4 (§12).
- **Next depends on:** the merge.

## Step 5 — `@mcp-abap-adt/auth-broker-cli`, the version after 1.0.0 (spec §10)

**Its version** (1.0.0 is the 3.x commands, released with `auth-broker` 3.1.0)
is decided when this step opens, by the CLI's own surface — the commands, their
flags, exit codes and the files they write — not by the library's major: a
**minor** (1.x.0) if every 1.0.0 invocation still runs and writes what a reader
of 1.0.0's output can read; a **major** (2.0.0) if a flag goes or changes
meaning, an invocation that worked now fails, or what a consumer reads changes
incompatibly (the client no longer in the session file, means moved to the key
store, `--passcode` a different grant are the candidates to weigh). The
dependency on `auth-broker` `^4.0.0` alone does not decide it.

- **Repository:** auth-broker, worktree `.worktrees/cli-1`, branch
  `feat/cli-destinations` from `main`.
- **What changes:** the remaining §10 items — each command writes the
  destination's means before the login through the key store's own write
  method (the destination store of D6; the §10 table: `authType`, `grantType`,
  the grant's data, the client) and nothing into the session but what the
  login obtains (the `--cookie` row writes its handed-over cookies to the
  session store itself); the 3.x writes of the client into the session
  (`bin/mcp-auth.ts:890`, `bin/mcp-sso.ts:826`, `:845`,
  `generate-env-from-service-key.ts:122`) go; a public client written
  as `uaaClientSecret: ''` instead of `__public__` stripped afterwards
  (`bin/mcp-sso.ts:836-850`, `:911-920` before the move); `--flow password
  --passcode` becomes the `passcode` grant; `generate-env-from-service-key`
  takes the grant from a flag instead of the key's URL (`:80-83`, `:134-145`, the
  inference H1 forbids); the CLI calls `broker.flush()` before it exits and exits
  non-zero on a failure; `mcp-auth` keeps injecting its own provider (token API
  path). Dependencies as §10 (`auth-broker` at the workspace version, which
  stays `^3.1.0` until step 7 sets `^4.0.0`); `auth-stores` moves from
  `^1.2.3` to `^3.0.0` here (D7), with `EnvDestinationStore` for the means
  and the session stores' new constructors (no `defaultServiceUrl`).
- **Tests first:** one per row of the §10 table — the means each command
  writes read back through the key store, and with the session store as a
  destination `getProvider` builds from (the CLI test builds the provider with
  the step-4 broker); the session store holds no means after any command; the
  public client round-trips as `''`; `--passcode` writes
  `passcode`; `generate-env` without the grant flag refuses, never infers; a
  failing `flush()` gives a non-zero exit; the smoke check of step 3 stays
  green.
- **Load-bearing:** omit `grantType` from one command's write → the read-back
  build fails; restore the URL inference in `generate-env` → red; ignore
  `flush()`'s rejection → red.
- **Depends on decision D6** (which key store the CLI writes means to, and
  where its files live; the `--type xsuaa` rows included).
- **Gate:** step-3 gate.
- **Docs:** CLI README (each command's destination, the install command, the
  `flush` exit code), root README, `docs/installing/INSTALLATION.md`
  (`npm i -g @mcp-abap-adt/auth-broker-cli`), `docs/using/USAGE.md`, CLI CHANGELOG
  `[Unreleased]` for that version.
- **Release:** none here — step 7 publishes both packages in one run.
- **Next depends on:** the merge.

## Step 6 — live checks of H6 (spec §13, *Live*)

- **Repository:** auth-broker, worktree `.worktrees/live`, branch
  `test/live-get-provider`. One PR: the test file
  `packages/auth-broker/src/__tests__/live/getProvider.live.test.ts` and its
  `TESTING.md` section. The runs happen on the PR branch before merge; the PR
  description records each run (where, which system class, result).
- **What the file does:** one case per row; each reads a sessions directory and
  a destination name from environment variables it names, states where it runs,
  and skips elsewhere printing why. No configuration framework. `connection` 10
  and `@mcp-abap-adt/sap-rfc-lite` are dev dependencies.

| Case | Runs where | Skips where, and why |
|---|---|---|
| `basic` over HTTP | this Linux machine, against an on-premise system the user names | without its env variables: "no on-premise destination configured" |
| `basic` over RFC (`rfcConversationFrom`) | this Linux machine with the NW RFC SDK (`~/sap/nwrfcsdk`, `SAPNWRFC_HOME`; `sap-rfc-lite` built in the worktree) | without the SDK: "NW RFC SDK not found" |
| `jwt` / `authorization_code` seeded with a well-formed JWT the system refuses (future `exp`): 401, renewal in `rejected()`, new token in the session file | this Linux machine, against BTP ABAP environment (trial) | without its env variables |
| `snc` over RFC | **Windows** with the SAP Secure Login Client logged on — **run by the user** (macOS also qualifies, per spec) | on Linux: "the SAP Secure Login Client exists only on Windows and macOS" |

- **Load-bearing:** none to break here (the rules are proven in step 4); each
  case's skip message is checked by running it once without its configuration.
- **Gate:** step-3 gate (all live cases skip there); then the live runs.
- **Next depends on:** all four cases green on their systems, recorded in the
  PR; merged.

## Step 7 — release: `auth-broker` 4.0.0 and the step-5 `auth-broker-cli` version

- **Repository:** auth-broker, worktree `.worktrees/release-4`, branch
  `release/4.0.0`.
- **What changes:** library version `4.0.0`, CLI the version step 5 decided,
  with its dependency `@mcp-abap-adt/auth-broker` `^4.0.0`; both CHANGELOGs dated, the library's with
  the §12 *Breaking* list and the migration notes (server, calm-server, global
  `mcp-auth` installs, the means/secret split and how a 3.x session file maps
  onto it, 3.x `jwt`/`saml` files needing `grantType`); a final pass over
  every document §14 lists, against the merged code; **`docs/superpowers/`
  goal, spec and this plan deleted** (what they still owe the future — step 8 —
  goes into this PR's description first).
- **Gate:** step-3 gate, and `npm pack --dry-run` per package listing no
  `docs/superpowers` file.
- **Release:** on the user's word, merge; tags `auth-broker-v4.0.0` and
  `auth-broker-cli-v<that version>` on the merge commit; the user runs
  `npm run release:publish` once — workspace order publishes the library first,
  so the CLI's `^4.0.0` resolves the moment it is published
  (exit 2 means published, not yet served: re-check). Registry: `npm view
  @mcp-abap-adt/auth-broker@4.0.0 bin dependencies` (no `bin`, no `auth-stores`),
  `npm view @mcp-abap-adt/auth-broker-cli@<that version> bin dependencies`, then the smoke check of
  §10 against the registry versions in an empty directory. Build and test the
  tags in the main checkout.

## Step 8 — afterwards (not this plan's scope)

- `mcp-abap-adt` (goal path step 5): the connector from `getProvider`; the
  per-auth-type construction, the `getToken` before connecting and the
  `tokenRefresher` removed; the broker built with `authorization` and the other
  collaborators; a key store for the means (under D6 the destination store,
  falling back to its service key store) and the session store for the
  secret; instead of seeding sessions from service keys it writes `authType:
  'jwt'`, `grantType: 'authorization_code'` as means; its `detectStoreType`
  passes `{ grantType }` to `AbapServiceKeyStore` and `{ serviceUrl,
  grantType }` to `XsuaaServiceKeyStore` (auth-stores 3.1.0, D8) — the URL it
  passed to `BtpSessionStore` in 2.x; `flush()` on `SIGTERM` and before a stdio transport
  closes; its docs install `@mcp-abap-adt/auth-broker-cli`; live check basic
  HTTP and RFC, token, SNC — one code path (spec §12). Its imports of moved types
  (`src/lib/stores/index.ts:24`, `src/lib/auth/brokerFactory.ts:36`) change
  package.
- `mcp-abap-adt-proxy` (`src/proxy/targetUrlSessionStore.ts:23`) and
  `mcp-calm-server` (`src/server/auth/legacyEnvShim.ts:2`,
  `targetUrlSessionStore.ts:6`, `buildBroker.ts:11`) import `ISessionStore` and
  friends from `interfaces-auth-sap`: the path changes to
  `interfaces-auth-broker` when they upgrade; calm-server's `mcp-auth` hints
  name the CLI package. calm-server wraps its session store only to keep the
  `serviceUrl` 3.x writes back out of it (`calm
  src/server/auth/targetUrlSessionStore.ts:12-19`); under the split that wrap
  can become a key store answering the URL *(inference — calm's to design)*.

## Decisions needed (before the step named)

- **D2 — decided 2026-10-01: auth-stores 3.0.0** (step 1). Session
  stores refuse means writes 2.0.0 accepted and stop answering means 2.0.0
  answered; the service key stores change their answers (spec §1.2 item 5,
  with the callers that break). The 2.1.0 type-compatibility check is dropped.
  The one way to stay minor would be to keep accepting and answering means in
  the session stores — which is the split not done.
- **D3 — decided 2026-10-01: `interfaces-auth-sap` `^2.0.0` in auth-providers**
  (step 2), the new line only. The three types it imports are identical in
  1.1.0 and 2.0.0, so a tree that also holds `connection` 10.0.2 (`^1.1.0`)
  gets a second, type-only copy of the package — harmless, and gone when
  connection moves to `^2.0.0` in its next release.
- **D4 — decided 2026-10-01: no `refreshToken?` on `Saml2PureProviderConfig`**
  (step 2). SAML has no refresh token and the provider has no refresh grant
  (`Saml2PureProvider.ts:103-109`); its seed is `accessToken?` (the cookies)
  and `expiresAt?`. Renewing the cookies without the user is a later step of
  its own (spec §15): measure which mechanism the system and the IdP support
  (`IsPassive`, ECP, `MYSAPSSO2`), then implement it.
- **D5 — decided 2026-10-01, revised the same day: the broker's own stand**
  (steps 4c and 4d). Not the auth-providers stand: the broker's tests must
  not depend on another repository. `tests/stand/` here, copied whole from
  auth-providers' `tests/stand/` (compose, scripts, committed realm, UAA
  configuration and test IdP key, a CI job), built in 4c, where the UAA
  grants first need it, and extended in 4d for OIDC and SAML. `saml2_pure` is
  proven with UAA as the SP that turns the SAMLResponse into a session cookie
  (spec §13); SAP ICF's own SAML handling stays unmeasured — no system at hand
  accepts SAML from a test IdP. The CLI's interactive Keycloak stand
  (`packages/auth-broker-cli/tests/keycloak`) is weighed against this one in
  step 5. The local-endpoint unit tests of 4c/4d cover every row regardless.
- **D6 — decided 2026-10-01: yes, a file-backed key store only (step 1, used by steps 5 and 8) — where a destination's means live
  when there is no SAP service key, and where a service key's grant is
  stated.** An auth-stores question, not the broker's: the broker takes any
  `IServiceKeyStore`. A SAP service key cannot state a grant (spec §1.2 item
  3), so without a further store every service-key destination is refused
  naming `grantType`, and basic, SNC, OIDC, SAML and `none` destinations have
  nowhere to state their means. Proposed (spec §1.2 item 4): auth-stores ships
  a destination store — an `IServiceKeyStore` over `<dir>/<destination>.env`
  in the 2.x key names plus `SAP_GRANT_TYPE`, `SAP_OIDC_*`, `SAP_SAML_*`, with
  an optional fallback `IServiceKeyStore` (a SAP key supplies client and URL,
  the file the grant), the public client as `''`, and a write method of its
  own — the file implementation only (decided 2026-10-01: an in-memory key
  store is added when a consumer needs one; auth-stores' in-memory stores are
  session stores only); a folder is only the first, simplest back end, for
  a local user — a SAP Credential Store, a database or anything else is
  another implementation of the same contract, outside this plan. The file
  one's directory is a constructor parameter with no default: the
  consumer composes the stores and so decides where means and secrets live
  (same directory as the sessions, or apart); the broker takes whatever stores
  it is handed. The question left for the user is only whether auth-stores
  ships this implementation. The alternative: a `grantType` option on the SAP
  service key stores (smaller, but it covers only the service key case and
  leaves basic, SNC, OIDC and SAML without a store).

- **D8 — decided 2026-10-02: the resource URL is not authorization data;
  it comes from the consumer's key store** (4c, 4c2, step 8). No token
  provider reads `serviceUrl` — `AuthorizationCodeProvider`,
  `ClientCredentialsProvider` and `UaaPasscodeProvider` take the client and
  `uaaUrl` only (`auth-providers src/providers/AuthorizationCodeProvider.ts:27-31`,
  `ClientCredentialsProvider.ts:20-23`, `UaaPasscodeProvider.ts:26-32`) — so
  `getProvider` does not require it (4c removed the requirement it had added,
  `src/destinations.ts` `uaaProvider`). The connector needs the URL, and the
  broker hands what the key store answers. Where the key store gets it: from
  the consumer's store factory, as before — the server's `detectStoreType`
  (`server src/lib/stores/index.ts:34-97`) picks the store by the key's
  format; an ABAP environment key carries the ABAP URL, an XSUAA/BTP key only
  the authorizing service, so its URL was passed separately (2.x: `new
  BtpSessionStore(dir, serviceUrl)`; 3.0.0 removed it from the session stores
  without moving it). It moves to the key store: auth-stores 3.1.0 gives
  `AbapServiceKeyStore(dir, { grantType })` and `XsuaaServiceKeyStore(dir,
  { serviceUrl, grantType })` — stated by whoever builds the store, so nothing
  is inferred (H1). A SAP key cannot state a grant.
- **D9 — decided 2026-10-02 (refined the same day): a secret is bound to the
  resource it was obtained for** (4c1, 4c2, 4c3). A JWT's audience, cookies'
  host and path, basic's system: presenting a secret to another resource is a
  leak. The session store keeps, beside the secret, `issuedFor` — the
  canonical URI of that resource: scheme and host lower-cased, explicit port,
  path without a trailing `/`, the SAP client as `sap-client=<n>` when the
  destination states one (`https://my-abap.example.com:443/sap/bc/adt?sap-client=100`).
  More than a host because several apps with their own XSUAA share a BTP host
  and cookies carry a `Path` (the path), and clients 100 and 200 are different
  user stores (the client); a URI, not an HTTP URL, so an RFC system could be
  `sap-rfc://host/00?sap-client=100` later (nothing stores an RFC secret
  today). A new optional `IConnectionConfig.issuedFor` in
  `interfaces-auth-broker` 1.1.0; file keys `SAP_ISSUED_FOR` /
  `XSUAA_ISSUED_FOR`. The broker computes it from the means (`serviceUrl` +
  `sapClient`) with one canonicalising function, `persist` writes it with the
  secret and it is cleared with the secret; `getProvider` seeds only when the
  stored `issuedFor` equals it (both canonicalised) — otherwise (different,
  or either absent) the secret is not used, the provider logs in afresh, and
  the log says only "secret bound to another resource, discarded", no values.
  The token's audience stays the resource's to enforce; the broker compares
  two strings and parses no token. Legacy files (2.x/3.0) have no
  `SAP_ISSUED_FOR`: the session store reads their `SAP_URL` (+ `SAP_CLIENT`)
  as `issuedFor`, because the 3.x broker's `persist` wrote `SAP_URL` together
  with the token — it is the URL the token was used for — so existing
  sessions keep working after the upgrade. **Remaining risk:** a legacy
  shared file whose `SAP_URL` was edited by hand before its first renewal
  under the binding (or whose token a 3.0.0 store rewrote after the means
  moved) answers a binding nobody checked, until that renewal writes
  `SAP_ISSUED_FOR`.

- **D7 — decided 2026-10-01: 4a keeps `auth-stores` `^1.2.3`** (the
  library's dev dependency and the CLI's runtime dependency). Measured in
  4a's worktree: on 3.0.0 the 3.x broker's `persist` and every CLI command's
  session writes are refused (`RefusedFieldsError`), so the move cannot both
  compile and keep working before the code that writes the secret alone. The
  library's dev dependency moves in 4e, with that persist; the CLI's in step
  5, with the destination store. On 1.2.3 the library compiles against the
  new contracts and its suite stays green (its `AbapSessionStore` fits the
  `interfaces-auth-broker` types structurally).

## Risks / open points found in the code

- **R1 — `check-graph.js` cannot be copied as is.** The interfaces version walks
  every file under `src` (`mcp-abap-adt-interfaces tools/check-graph.js:54`) and
  compares imports with `dependencies`; here `src/__tests__` imports dev
  dependencies (`auth-stores`, `auth-providers` today, `connection` and
  `sap-rfc-lite` from step 4e/6). Step 3 adapts it: the runtime rule over
  non-test files and `dependencies`; tests may import declared dev dependencies.
- **R2 — the CLI's type coupling forces 4a's shape.** The CLI passes
  auth-providers instances to `AuthBroker`; the moment the library's contract is
  `interfaces-auth` 3 the CLI on auth-providers 4 no longer compiles
  (`bin/mcp-auth.ts:36`, `bin/mcp-sso.ts:44` import auth-providers). Hence 4a
  migrates both at once; if review finds 4a too big, the alternative is the CLI
  migration first, compiled against a temporarily widened library type — not
  proposed.
- **R3 — the SNC unit fixture.** Spec §13 marks as inference that
  `DefaultSncLibraryLocator` accepts a fixture whose header is the host's
  architecture; 4b checks it first, and if the locator needs more than a header
  the test injects the locator's file-system seam (`nodeSncSystem`) instead —
  through `forSecureLoginClient`'s options only if it accepts one; it does not
  today (`auth-providers src/snc/SncLogonProvider.ts:106-121`), so the fallback is
  a fixture file.
- **R4 — the auth-stores gate.** Without `tests/test-config.yaml` the test helper
  loads the template (`src/__tests__/helpers/configHelpers.ts:110`); whether
  every integration suite then skips is not verified. Step 1's gate checks it
  first.
- **R5 — publish-changed refuses an untagged unpublished version.** Planned as
  the guard that kept the CLI's `1.0.0` unpublished through steps 3–6;
  superseded 2026-10-01, when the split was released as `auth-broker` 3.1.0 and
  `auth-broker-cli` 1.0.0 after step 3. It now only refuses between a version
  bump and its tags; during steps 4–6 both versions are on the registry and
  `release:publish` has nothing to publish.

## Spec points found while planning

**Reworked for the means/secret split** (the user's decision of 2026-10-01,
design, not a correction): spec §0 fact 6, §1.2 (auth-stores 3.0.0), §2
(store roles), §3.1–§3.3, §4.1, §4.4, §6, §8 (the split, verified sufficient,
§8.3 open points), §9, §10, §12, §13, §16; in this plan step 1, 4a–4e, 5, 7,
8 and the decisions: D1 (credential-less destinations in the XSUAA session
stores) is removed — the means come from the key store, so no session store
keeps a destination before its first login, and the XSUAA stores' refusal of a
tokenless session stays correct (spec §1.2 item 1); D2 changed; D6 added. The goal is
unchanged: its *Stays* ("the stores and their contracts", "a client secret is
never copied into the session") and H0–H6 hold as written.

**Corrected in the spec and the goal** (facts, not design; commit after this
plan's first version):

1. §8 table — every field now points at `interfaces-auth-broker` 1.0.0
   (`src/auth/IConnectionConfig.ts` lines, `src/session/ISessionStore.ts`), and
   `IAuthorizationConfig` at `interfaces-auth-sap` 2.0.0.
2. §14 — the stale comments name `interfaces-auth-broker` for the store
   contracts and `interfaces-auth-sap` for `IAuthorizationConfig` and
   `AuthType`.
3. §4.1 — the classes are auth-providers 5.1.0 (the `saml2_pure` seed and the
   `expiresAt` fallback).
4. §16 — the dependencies row reads auth-providers ^5.1.0, interfaces-auth-sap
   ^2.0.0, interfaces-auth-broker ^1.0.0, as the goal and §12 item 2.
5. Goal, *What changes* — `authType` lives in `interfaces-auth-broker` 1.0.0
   (moved from `interfaces-auth-sap` 1.1.0, decided 2026-10-01). Nothing else in
   the goal changed.
6. §1.3 — `connection` 10.0.2 has auth-providers only as a dev dependency; its
   runtime takes `interfaces-auth` ^3.0.0 and `interfaces-auth-sap` ^1.1.0.
7. §11 — `check-graph.js` is adapted, not copied: the allowlist and
   declared-and-used rules over non-test files and `dependencies`; tests may
   import declared dev dependencies (R1).
8. §1 and §10 *Release order* — the interfaces releases are recorded as done
   (published 2026-10-01).

**Still open — they wait for the user** (see *Decisions needed*):

- §1.2 item 5 — auth-stores 3.0.0 (D2).
- §1.2 item 4, §10, §12 — the destination store: whether auth-stores ships it,
  and its directory (D6).
- §8.3 — where the contract carries the split only by convention (a client
  with no secret or no UAA URL as `''`; `saveSession`'s merge semantics; doc
  comments describing the 2.x roles). Recorded, not scheduled: a
  documentation-only `interfaces-auth-broker` patch only if the user asks.
- auth-providers' `interfaces-auth-sap` range (D3).
- §1.3 — `refreshToken?` on `Saml2PureProviderConfig`, unused by a provider
  with no refresh grant (D4).
- §13 — the broker's own stand (D5).

## Checklist: goal and spec → step

| Goal hold / item | Delivered by |
|---|---|
| H0 the broker speaks only the store contracts | interfaces (done; sufficient for the split, spec §8.2); step 1 (stores implement the split); step 3 (`check-graph`: no `auth-stores` import in the library); 4b–4e (fakes of the contract in tests) |
| H1 the configuration states the provider | 4b (pair table, `authType` + `grantType` from the key store only, no fallback to a session's means); step 1 (no grant answered from a SAP key); 4c2 (the grant and an XSUAA key's resource URL stated by whoever builds the key store, D8); step 5 (CLI writes both; `generate-env` stops inferring) |
| H2 no implicit defaults | 4a (CLI's presenter, validator, `read`); 4b–4d (every collaborator from the consumer, missing → `DestinationConfigError`) |
| H3 what a provider obtains reaches the session store | 4c (`onTokens`, retry, `flush()`); 4d (OIDC/SAML results); 4e (through connection 10) |
| H4 no secret the broker was not given | 4c (the session gets the secret alone — field-set test and breaks); step 1 (session stores refuse means); step 5 (the CLI writes means to the key store; the user's); 4c1–4c3 (a stored secret presented only to the resource it was obtained for, D9) |
| H5 the token API keeps 3.x | every step-4 PR keeps the §9 suite green; 4e (shared cache, `basic`/`snc` refusal) |
| H6 measured: basic, token, SNC through connection 10 | step 6 (SNC on Windows, by the user) |
| Success: server builds from `getProvider`; a renewal in the connector is in the store; token API as 3.x | 4e (end to end through connection 10, no SAP); step 6 (live); step 8 (the server itself) |
| What changes: dependencies | step 2 (5.1.0); 4a (contracts, `auth-providers` 5.1); 4b (`auth-providers` runtime); step 3 (`auth-stores` dev only); 4e (library's `auth-stores` dev `^3.0.0`, D7); step 5 (CLI's `auth-stores` `^3.0.0`, D7) |
| What changes: the session's `authType` not overwritten | 4c (rule 1, rule 3); 4e (token API refusal) |
| What changes: commands move to the CLI package; layout; `release:publish` | step 3; step 5; step 7 |

| Spec section | Step |
|---|---|
| §0 | evidence only |
| §1.1 | done (interfaces) |
| §1.2 | 1 |
| §1.3 | 2 |
| §1.4 | 4c1 |
| §1.5 | 4c2 |
| §2 | 4b (surface), 4c (`flush`), 4d (options), 4e (`provider` optional for the token API) |
| §3.1, §3.2, §3.3 | 4b (the split's reads); public client and no `serviceUrl` requirement in 4c (D8); `issuedFor` read in 4c3; the token API's 3.x reads in 4e |
| §4.1 | 4b (`basic`, `snc`, `none`), 4c (UAA), 4d (OIDC, SAML) |
| §4.2 | 4b–4d (each provider's own `rejected()`, tested through the contract) |
| §4.3 | 4e |
| §4.4 | 4b, extended per row in 4c and 4d (`serviceUrl` not required, 4c, D8) |
| §4.5 | 4c3 |
| §5 | 4c (`authorization`), 4d (the rest) |
| §6 | 4c; `issuedFor` written with the secret in 4c3 |
| §7 | 4b (promise cache), 4e (shared with the token API) |
| §8 | 1 (stores), done (contract — verified sufficient for the split, §8.2); `issuedFor` 4c1 (contract), 4c2 (stores); §8.3 recorded only |
| §9 | 4e; carried-over suite in every step-4 PR |
| §10 | 3 (move, imports, version), 4a (explicit collaborators), 5 (destinations, flags, `flush`), 7 (release) |
| §11 | 3 |
| §12 | 7 (breaking list, migration notes); 8 (consumers — the server passes `serviceUrl` / `grantType` to its key stores, D8) |
| §13 | 4b–4e (unit, connection 10), 4c (D8; the live jwt case on service keys), 4c3 (the binding tests), 4d (stand, D5), 6 (live) |
| §14 | 4a (stale comments), every step (its docs), 7 (final pass, deletion) |
| §15 | not delivered, by design |
| §16 | this checklist |
