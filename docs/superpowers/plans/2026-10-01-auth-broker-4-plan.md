# auth-broker 4.0.0 and auth-broker-cli 1.0.0 — implementation plan

**Implements:** `docs/superpowers/specs/2026-10-01-auth-broker-4-design.md` (the
spec), under `docs/superpowers/2026-09-30-auth-broker-4-goal.md` (the goal). The
goal's *Holds throughout* (H0–H6) bind every step; where a step and a hold
disagree, the hold wins and the step changes in review. The plan does not
redesign the spec. Where reading the code showed the spec stale or wrong, the
plan says so under *Spec points found while planning* and either follows the
spec or names the decision the user must take before that step opens — it
never fixes the spec silently.

**Status:** draft for review in #33, with the goal and the spec.

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
- So spec §1.1 is delivered, and its release-order paragraph (§10, *Release
  order*, first sentence) is history. What the spec still names at the old
  location is listed under *Spec points* (items 1, 2, 5).
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
- **Next depends on:** the merge, and decisions D1 and D2 (step 1), D3 (step 2).

## Step 1 — `@mcp-abap-adt/auth-stores` 2.1.0 (spec §1.2)

- **Repository:** `mcp-abap-adt-auth-stores`, worktree `~/prj/.wt-auth-stores-21`,
  branch `feat/destination-grant` from `master` (`2a7fc4b`, 2.0.0).
- **Version: minor (2.1.0), as the spec says.** Evidence:
  - The package re-exports no contract type: `src/index.ts` exports the store
    classes, their aliases, the error classes, loaders, constants and file
    utilities only. Its published declarations *reference*
    `IAuthorizationConfig`, `IConfig`, `IConnectionConfig`, `ISessionStore`,
    `IServiceKeyStore` (`dist/stores/**/*.d.ts`, e.g.
    `dist/stores/abap/AbapSessionStore.d.ts:11`), so moving those imports to
    `interfaces-auth-broker` changes which package names the types, not what a
    consumer can import from auth-stores.
  - The moved types are the 1.1.0 shapes plus optional fields
    (`interfaces-auth-sap` 2.0.0 CHANGELOG: "Moved, unchanged"; the added fields
    are all optional). So a store of 2.1.0 is assignable to 1.1.0's
    `ISessionStore` / `IServiceKeyStore` and accepts every 1.1.0
    `IConnectionConfig`: a consumer still on `interfaces-auth-sap` 1.1.0 compiles
    unchanged. This is proven in the step by a type check (below), not argued.
  - The behaviour changes are additions (new fields kept), or answers where 2.0.0
    returned `null` or threw for data the same store had written (spec §1.2
    items 4 and 5, measured there) — defects of 2.0.0 fixed.
  - This differs from 2.0.0, which its CHANGELOG called breaking because
    `interfaces-auth` 3.0.0 changed shapes the stores used; here no shape the
    stores use changes.
  - If the type check below fails, the version is 3.0.0, and the step's
    migration note says what a consumer on `interfaces-auth-sap` 1.x must change;
    the broker's and CLI's ranges in later steps follow.
- **What changes, by spec section:**
  1. Dependencies: `@mcp-abap-adt/interfaces-auth-broker` `^1.0.0` added;
     `@mcp-abap-adt/interfaces-auth-sap` `^1.1.0` → `^2.0.0`; the seven store
     files and the test helpers import the store contracts from
     `interfaces-auth-broker`, `IAuthorizationConfig` from `interfaces-auth-sap`.
  2. §1.2 item 1 — every §1.1 field kept by `AbapSessionStore`,
     `SafeAbapSessionStore`, `XsuaaSessionStore`, `SafeXsuaaSessionStore`,
     `EnvFileSessionStore`, under the existing field-by-field update rule
     (`''` clears; a list written whole). Key names `SAP_GRANT_TYPE`,
     `SAP_OIDC_*`, `SAP_SAML_*`, `SAP_EXPIRES_AT`; `XSUAA_*` in the XSUAA
     stores; added to the exported `*_CONNECTION_VARS` constants.
  3. §1.2 item 2 — the one-credential rule extended by grant (`jwt`: token,
     `grantType`, `oidc*`, and `username`/`password` only with `grantType:
     'password'`; `saml`: `grantType`, `saml*`, `sessionCookies` for
     `saml2_pure`/`none`, `authorizationToken` for `saml2_bearer`); a write of
     another type drops them.
  4. §1.2 item 3 — `XSUAA_AUTH_TYPE` written and read; a file without it answers
     `jwt`; both service-key stores answer `authType: 'jwt'` from
     `getConnectionConfig`.
  5. §1.2 item 4 — a destination with no credential yet is kept and answered by
     both ABAP session stores; **and by the XSUAA session stores if decision D1
     says so**.
  6. §1.2 item 5 — `uaaClientSecret: ''` kept and returned as a public client by
     all four session stores.
  7. §1.2 item 6 — `expiresAt` kept with its credential, cleared with it.
- **Tests first, and the rule each protects:**
  - per store and per item 1 field group: write, read back through
    `getConnectionConfig` and `loadSession`; a `''` clears; a list replaced
    whole (item 1);
  - a write of another type drops the grant fields; `username`/`password`
    survive in `jwt` only with `grantType: 'password'`; `saml2_bearer` holds a
    token under `saml` (item 2);
  - XSUAA store writes and reads `authType`; a pre-2.1.0 XSUAA file answers
    `jwt`; both service-key stores answer `jwt` (item 3);
  - the measured 2.0.0 cases of §1.2 items 4 and 5 become tests, each first run
    red against 2.0.0 behaviour: `saveSession(d, { serviceUrl, authType: 'jwt',
    grantType, uaaUrl, uaaClientId, uaaClientSecret })` then
    `getConnectionConfig` answers it (both ABAP stores; XSUAA per D1); a public
    client's `getAuthorizationConfig` is not `null` and carries `''` (four
    stores);
  - `expiresAt` written with the token or cookies, cleared when the credential
    is cleared or replaced by another type (item 6);
  - **type compatibility (the version decision):** a `__typechecks__` file
    assigns each store class to `ISessionStore` / `IServiceKeyStore` of
    `interfaces-auth-sap` 1.1.0 (a dev dependency under an npm alias) and passes
    a 1.1.0 `IConnectionConfig` to `setConnectionConfig`; it runs under
    `test:check`.
- **Load-bearing:** remove the grant-field keep in one store (item 1), the
  `grantType: 'password'` condition (item 2), the XSUAA `jwt` default (item 3),
  the credential-less read path (item 4), the `''` secret pass-through (item 5),
  the `expiresAt` clear (item 6); each goes red alone.
- **Gate:** `npm run build`, `npm run test:check`, `npm run lint:check`,
  `npm test` — in the worktree, where `tests/test-config.yaml` is absent and the
  helper falls back to the template (`src/__tests__/helpers/configHelpers.ts:65-110`);
  the gate confirms the integration suites skip on the template, and if any does
  not, that is fixed in this step before anything else.
- **Docs:** README (*Session Stores*, the env formats for ABAP and XSUAA with the
  new keys, the one-credential rule by grant, public client, credential-less
  destination), CHANGELOG 2.1.0 (*Added* / *Fixed*, with the version reasoning
  above in one paragraph), `docs/archive` untouched.
- **Release:** 2.1.0, tag `v2.1.0` on the merge commit, `npm publish` by the
  user; check `npm view @mcp-abap-adt/auth-stores@2.1.0 version` and its
  `dependencies` naming `interfaces-auth-broker`; build and test the tag in the
  main checkout.
- **Next depends on:** 2.1.0 on the registry (the broker's dev dependency and
  the CLI's runtime dependency are `^2.1.0`).

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
     the logger is the CLI's). Version stays `3.0.4`, CHANGELOG `[Unreleased]`
     records the removals.
  3. `packages/auth-broker-cli`: `bin/*.ts` as `src/`, compiled to `dist/`,
     `bin` = `mcp-auth`, `mcp-sso`; the bin tests and fixtures, `tests/keycloak`,
     `tests/sso-demo` and their npm scripts; `generate-env` script. Only the
     changes a move forces (spec §10, first two bullets): `AuthBroker` imported
     from `@mcp-abap-adt/auth-broker` instead of `require`d from a `dist` path
     (`bin/mcp-auth.ts:28-29`, `bin/mcp-sso.ts:38-39`); `getVersion()` reads the
     CLI's manifest. Dependencies: the 3.x set the bins import, plus
     `@mcp-abap-adt/auth-broker` at the workspace's version. Version `1.0.0`,
     CHANGELOG `[Unreleased]`, README (the `mcp-auth` / `mcp-sso` sections moved
     from the library README).
  4. `tools/`: `publish-changed.js`, `test-publish-changed.js` (copied, the
     interfaces-facade comments removed), `check-graph.js` (allowlist of §11;
     adapted per *Spec points* item 9), `check-packed.js` (the bin smoke check
     of §10), `version-stats.sh`.
  5. `.github/workflows/release.yml` triggers on `auth-broker-v*` /
     `auth-broker-cli-v*` and packs the workspace the tag names (§11
     *Departures*).
  6. Root README becomes the workspace overview; `CLAUDE.md`, `AGENTS.md`
     describe the layout and the new commands.
- **Why master stays clearly unreleased:** the library's version is on the
  registry, so `release:publish` skips it; the CLI's `1.0.0` has no tag, so
  `release:publish` refuses (`tools/publish-changed.js:246-252` in interfaces).
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
  `docs/installing/INSTALLATION.md` (no change of content yet: the CLI is not
  published — it says so), `CLAUDE.md`, `AGENTS.md`.
- **Release:** none.
- **Next depends on:** the merge.

## Step 4 — `@mcp-abap-adt/auth-broker` 4.0.0, in five PRs

All in auth-broker, each in its own worktree under `.worktrees/`, branched from
`main` after the previous merge. Every PR keeps the carried-over §9 suite
(today's `AuthBroker.test.ts`) green — H5 holds at every merge, not only at the
end. Master stays clearly unreleased throughout: the library's version stays
`3.0.4` until step 7, and `[Unreleased]` collects the changes. The gate of every
step-4 PR is the step-3 gate: `npm run check` and `npm test` in the worktree.

### 4a — both packages on the new contracts and providers

- **Branch:** `feat/contracts-auth-providers-5`.
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
    sources; dev dependencies `auth-stores` `^2.1.0`, `auth-providers` `^5.1.0`.
    Spec §14 stale comments: `src/index.ts:34-37`, `src/stores/index.ts:4-6`
    (non-existent `auth-stores-btp`/`-xsuaa`), `src/types.ts:4`,
    `src/stores/interfaces.ts:4` (they name `interfaces-auth-broker` for the store
    contracts — *Spec points* item 2).
  - CLI (spec §10, third bullet): `auth-providers` `^5.1.0`, `auth-stores`
    `^2.1.0`, the contract packages; the device flow gets
    `consoleDeviceCodePresenter(logger)`; the SAML flows get an
    `assertionValidator` built from the trust the CLI collects
    (`createSignedResponseValidator` for pure, `createSignedAssertionValidator`
    for bearer, `defaultReplayStore`) in place of `idpCertificates`
    (`bin/mcpSsoConfig.ts:595-602` before the move); manual strategies get
    `read: (prompt, signal)`, and `readManualInput` closes its `readline` and
    rejects when the signal aborts.
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
  yet), §3.1 (the pair table, `authType` + `grantType` only), §3.2 (no rule of
  the broker's own), §3.3 (where each field comes from; store reads keep the 3.x
  absence rule), §4.1 rows `basic`, `snc`, `jwt`/`none`, `saml`/`none`, §4.2,
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
  - each `none`: presents what is stored;
  - `DestinationConfigError`: no `authType`, an unknown one, `jwt`/`saml`
    without `grantType`, each invalid pair, each missing field of these rows,
    `''` as missing, the `sncQop` constructor error with `cause`;
    `missingFields` asserted, and no stored value appears in the message;
  - H1: a destination whose fields would suggest another type (cookies beside a
    `basic` type) gets the stated type's provider;
  - cache: concurrent first calls build once; a failed build is retried on the
    next call.
- **Load-bearing:** the pair table (allow one invalid pair), the `''`-is-missing
  rule, the promise cache (set after the `await`, as 3.x did), the
  value-free message — each red alone.
- **Docs:** library README (the destination table for these rows,
  `DestinationConfigError`), `docs/using/USAGE.md` (`getProvider` for basic and
  SNC), `docs/architecture/ARCHITECTURE.md`, `EXPORTS.md`, CHANGELOG.
- **Next depends on:** the merge.

### 4c — persistence through `onTokens`; the UAA grants

- **Branch:** `feat/get-provider-persistence`.
- **What changes:** spec §6 whole (`persist` rules 1–3, `expiresAt` written, the
  broker's own retry queue — growing delay capped at one minute, `unref()`ed
  timer, latest result replaces a pending one, attempts per destination never
  overlap, failures logged by class name only — and `flush()`); §4.1 rows
  `jwt`/`authorization_code`, `jwt`/`client_credentials`, `jwt`/`passcode` with
  the seed (`expiresAt` included), the logger and `onTokens`; §5 for the
  `authorization` option (called once per build, with the grant; required only
  by its rows; never disposed by the broker); §4.4 for these rows (`uaaUrl`,
  `serviceUrl`, the `authorization` option by name); §3.3 public client (`''`
  reaches the provider as no secret).
- **Why persistence and the first token rows together:** a token provider handed
  out without `onTokens` would break H3 at this merge.
- **Tests first:**
  - each UAA row obtains from a local token endpoint with exactly the stored
    fields; `authorization` is called with `(destination, grant)`; `passcode`'s
    strategy is handed `<uaaUrl>/passcode`;
  - persistence (spec §13): a renewal through `rejected({ at: 'request',
    status: 401 })` on the returned provider is in the session store afterwards,
    with the stated `authType`, the refresh token beside it, **no client
    secret** (H4); a refresh token without session credentials goes through
    `saveSession` alone; nothing written meanwhile is reverted (re-read at write
    time); a `basic` / `snc` session is never overwritten (rule 3);
  - retry: a store whose write fails once — `onTokens` does not throw, the
    authentication succeeds, and with no further call to the provider (fake
    timers) the same result is written; delays grow and cap; a newer result
    replaces the pending one; two attempts for one destination never overlap;
    the logged failure carries the class name and no message;
  - `flush()` resolves once pending writes land; rejects naming the destination
    when the store still fails; the timer does not keep the process alive.
- **Load-bearing:** derive `authType` from the result instead of declaring it;
  drop the `basic`/`snc` guard; write the client secret (H4 branch); remove the
  retry (write once); remove `unref()`; let attempts overlap — each red alone.
- **Docs:** library README (persistence, `flush()` and when to call it,
  collaborator `authorization`, the UAA rows), `docs/using/USAGE.md`,
  `ARCHITECTURE.md`, CHANGELOG.
- **Next depends on:** the merge.

### 4d — OIDC and SAML grants; the remaining collaborators

- **Branch:** `feat/get-provider-oidc-saml`.
- **What changes:** §4.1 rows `oidc_authorization_code`, `device_code`,
  `password`, `token_exchange`, `saml2_pure` (seeded with `sessionCookies` and
  `expiresAt`, auth-providers 5.1.0), `saml2_bearer` (token persisted under
  `saml`); §4.1 validator composition (`createSignedResponseValidator` for pure,
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
  logs in after; a `saml2_bearer` token is stored under `saml`, `saml2_pure`
  cookies as cookies, each with `expiresAt`; each missing collaborator is a
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
  included); with a broker-built provider the token API writes nothing itself
  and throws the failure recorded for the result it received (the
  `WeakMap<ITokenResult, unknown>`; result identity holds — `BaseTokenProvider`
  passes the same object to `onTokens` and returns it,
  `auth-providers src/providers/BaseTokenProvider.ts:219-247`); `basic`/`snc`
  destinations refused before any provider is asked; destinations whose row is
  not a token provider refused without a consumer `provider`; §4.3 (the README
  states the two-sources case).
- **Tests first:** every row of the §9 table carried over and green; `getProvider`
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

## Step 5 — `@mcp-abap-adt/auth-broker-cli` 1.0.0 (spec §10)

- **Repository:** auth-broker, worktree `.worktrees/cli-1`, branch
  `feat/cli-destinations` from `main`.
- **What changes:** the remaining §10 items — each command writes a complete 4.0
  destination before the login (the §10 table: `authType`, `grantType`, the
  grant's data, through the session store's contract); a public client written
  as `uaaClientSecret: ''` instead of `__public__` stripped afterwards
  (`bin/mcp-sso.ts:836-850`, `:911-920` before the move); `--flow password
  --passcode` becomes the `passcode` grant; `generate-env-from-service-key`
  takes the grant from a flag instead of the key's URL (`:80-83`, `:134-145`, the
  inference H1 forbids); the CLI calls `broker.flush()` before it exits and exits
  non-zero on a failure; `mcp-auth` keeps injecting its own provider (token API
  path). Dependencies as §10 (`auth-broker` at the workspace version, which
  becomes `^4.0.0` in step 7).
- **Tests first:** one per row of the §10 table — the file each command writes
  reads back, through the store, as a destination `getProvider` builds from
  (the CLI test builds the provider from the written file with the step-4
  broker); the public client round-trips as `''`; `--passcode` writes
  `passcode`; `generate-env` without the grant flag refuses, never infers; a
  failing `flush()` gives a non-zero exit; the smoke check of step 3 stays
  green.
- **Load-bearing:** omit `grantType` from one command's write → the read-back
  build fails; restore the URL inference in `generate-env` → red; ignore
  `flush()`'s rejection → red.
- **Depends on decision D1** for the `xsuaa` rows (the XSUAA session store must
  keep a destination before its first login).
- **Gate:** step-3 gate.
- **Docs:** CLI README (each command's destination, the install command, the
  `flush` exit code), root README, `docs/installing/INSTALLATION.md`
  (`npm i -g @mcp-abap-adt/auth-broker-cli`), `docs/using/USAGE.md`, CLI CHANGELOG
  1.0.0 draft (the commands shipped in `@mcp-abap-adt/auth-broker` up to 3.0.4).
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

## Step 7 — release: `auth-broker` 4.0.0 and `auth-broker-cli` 1.0.0

- **Repository:** auth-broker, worktree `.worktrees/release-4`, branch
  `release/4.0.0`.
- **What changes:** library version `4.0.0`, CLI `1.0.0` with its dependency
  `@mcp-abap-adt/auth-broker` `^4.0.0`; both CHANGELOGs dated, the library's with
  the §12 *Breaking* list and the migration notes (server, calm-server, global
  `mcp-auth` installs, 3.x session files needing `grantType`); a final pass over
  every document §14 lists, against the merged code; **`docs/superpowers/`
  goal, spec and this plan deleted** (what they still owe the future — step 8 —
  goes into this PR's description first).
- **Gate:** step-3 gate, and `npm pack --dry-run` per package listing no
  `docs/superpowers` file.
- **Release:** on the user's word, merge; tags `auth-broker-v4.0.0` and
  `auth-broker-cli-v1.0.0` on the merge commit; the user runs
  `npm run release:publish` once — workspace order publishes the library first,
  so no registry state has 3.x's `mcp-auth` gone without the CLI present
  (exit 2 means published, not yet served: re-check). Registry: `npm view
  @mcp-abap-adt/auth-broker@4.0.0 bin dependencies` (no `bin`, no `auth-stores`),
  `npm view @mcp-abap-adt/auth-broker-cli@1.0.0 bin`, then the smoke check of
  §10 against the registry versions in an empty directory. Build and test the
  tags in the main checkout.

## Step 8 — afterwards (not this plan's scope)

- `mcp-abap-adt` (goal path step 5): the connector from `getProvider`; the
  per-auth-type construction, the `getToken` before connecting and the
  `tokenRefresher` removed; the broker built with `authorization` and the other
  collaborators; seeded sessions get `authType: 'jwt'`, `grantType:
  'authorization_code'`; `flush()` on `SIGTERM` and before a stdio transport
  closes; its docs install `@mcp-abap-adt/auth-broker-cli`; live check basic
  HTTP and RFC, token, SNC — one code path (spec §12). Its imports of moved types
  (`src/lib/stores/index.ts:24`, `src/lib/auth/brokerFactory.ts:36`) change
  package.
- `mcp-abap-adt-proxy` (`src/proxy/targetUrlSessionStore.ts:23`) and
  `mcp-calm-server` (`src/server/auth/legacyEnvShim.ts:2`,
  `targetUrlSessionStore.ts:6`, `buildBroker.ts:11`) import `ISessionStore` and
  friends from `interfaces-auth-sap`: the path changes to
  `interfaces-auth-broker` when they upgrade; calm-server's `mcp-auth` hints
  name the CLI package.

## Decisions needed (before the step named)

- **D1 (step 1, used by step 5) — credential-less destinations in the XSUAA
  session stores.** Spec §10 has every command write the destination *before*
  the login, including under `--type xsuaa` (`bin/mcp-auth.ts:803`,
  `bin/mcp-sso.ts:796` use `XsuaaSessionStore`), but §1.2 item 4 makes only the
  ABAP session stores keep a destination with no token; `XsuaaSessionStore`
  throws without one (`src/stores/xsuaa/XsuaaSessionStore.ts:138`, measured in
  §1.2 item 4), as does `SafeXsuaaSessionStore` (`:76`). Proposed: step 1 extends
  item 4 to both XSUAA session stores. The alternative — the CLI writes `xsuaa`
  destinations only after the login — makes a failed first login leave no
  destination, unlike `abap`.
- **D2 (step 1) — the version.** Minor by the evidence in step 1, conditional on
  its type-compatibility check; a red check makes it 3.0.0.
- **D3 (step 2) — `interfaces-auth-sap` range in auth-providers.** `^2.0.0`
  (what the task names) or `^1.1.0 || ^2.0.0`. The second is honest — the three
  types it imports are identical in both — and avoids a second copy of the
  package in a tree that also holds `connection` 10.0.2, which depends on
  `^1.1.0`; both are type-only imports, so a second copy costs nothing at run
  time either. Minor in both cases. Proposed: `^1.1.0 || ^2.0.0`.
- **D4 (step 2) — `refreshToken?` on `Saml2PureProviderConfig`.** Spec §1.3
  asks for it, but the provider has no refresh grant (`Saml2PureProvider.ts:103-109`:
  `hasRefreshGrant()` is `false`, `performRefresh()` throws), so a seeded refresh
  token is never used. Proposed: leave it out, and the spec's §1.3 sentence is
  corrected in review.
- **D5 (step 4d) — the auth-providers stand.** Spec §13 proposes, as inference,
  running the broker's OIDC and SAML grants against the auth-providers stand
  (Keycloak, UAA in Docker), gated on `UAA_URL` / `KEYCLOAK_URL`. Not checked:
  whether the stand's committed realm and UAA config hold clients for every
  grant the broker builds. Proposed: 4d adds broker suites gated on those
  variables for the grants the stand's committed configuration already serves,
  started from the auth-providers checkout with `npm run stand:up`; a grant it
  does not serve is named in the PR. The local-endpoint unit tests of 4c/4d cover
  every row regardless.

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
- **R5 — publish-changed refuses an untagged unpublished version.** Steps 3–6
  rely on that refusal to keep the CLI's `1.0.0` from being published early; a
  `release:publish` run during that time fails for the whole repository. That is
  intended (nothing should publish before step 7), and the root README says so
  while it lasts.

## Spec points found while planning (listed, not fixed)

1. **§8 table, column "Where (1.2.0)", and its `IConnectionConfig.ts:15`,
   `:11`, `:13`, `:26-32`, `:9`, `:21` references** point at
   `interfaces-auth-sap` 1.1.0 / an unpublished 1.2.0. The fields are in
   `interfaces-auth-broker` 1.0.0
   (`packages/interfaces-auth-broker/src/auth/IConnectionConfig.ts`).
2. **§14** says `src/types.ts:4` and `src/stores/interfaces.ts:4` should "name
   `interfaces-auth-sap`". Since the split, the store contracts they re-export
   come from `interfaces-auth-broker`; only `IAuthorizationConfig` (and
   `AuthType`, `src/index.ts:10`) stay in `interfaces-auth-sap`. Step 4a follows
   the split.
3. **§4.1** says "All classes are auth-providers 5.0.1"; the `saml2_pure` seed
   and the `expiresAt` fallback need 5.1.0 (§1.3, the broker's `^5.1.0`).
4. **§16**, *What changes* table, dependencies row: "auth-providers ^5.0.1";
   the goal says `^5.1.0` (goal line 60) and §12 item 2 agrees with the goal.
5. **Goal, line 30** names `interfaces-auth-sap` 1.1.0 as where `authType`
   lives; it is `interfaces-auth-broker` 1.0.0 now. The goal is the anchor, so
   this is for the user to correct there.
6. **§1.3, `refreshToken?` on `Saml2PureProviderConfig`** — unused by a provider
   with no refresh grant (D4).
7. **§1.3, "Dependents on `^5.0.1` (connection) take it without a release"** —
   `connection` 10.0.2 has auth-providers only as a dev dependency (registry
   manifest); nothing of connection's runtime depends on it.
8. **§1.2 item 4 vs §10** — credential-less destinations in the XSUAA session
   stores (D1).
9. **§11, `check-graph.js` "copied"** — needs the test/dev-dependency
   adaptation (R1).
10. **§10, *Release order*** still describes the interfaces releases as future.

## Checklist: goal and spec → step

| Goal hold / item | Delivered by |
|---|---|
| H0 the broker speaks only the store contracts | interfaces (done); step 1 (stores implement the contract); step 3 (`check-graph`: no `auth-stores` import in the library); 4b–4e (fakes of the contract in tests) |
| H1 the configuration states the provider | 4b (pair table, `authType` + `grantType` only, no broker rule for legacy files); step 5 (CLI writes both; `generate-env` stops inferring) |
| H2 no implicit defaults | 4a (CLI's presenter, validator, `read`); 4b–4d (every collaborator from the consumer, missing → `DestinationConfigError`) |
| H3 what a provider obtains reaches the session store | 4c (`onTokens`, retry, `flush()`); 4d (OIDC/SAML results); 4e (through connection 10) |
| H4 no secret the broker was not given | 4c (no client secret, test and break); step 5 (the CLI's own writes are the user's) |
| H5 the token API keeps 3.x | every step-4 PR keeps the §9 suite green; 4e (shared cache, `basic`/`snc` refusal) |
| H6 measured: basic, token, SNC through connection 10 | step 6 (SNC on Windows, by the user) |
| Success: server builds from `getProvider`; a renewal in the connector is in the store; token API as 3.x | 4e (end to end through connection 10, no SAP); step 6 (live); step 8 (the server itself) |
| What changes: dependencies | step 2 (5.1.0); 4a (contracts); 4b (`auth-providers` runtime); step 3 (`auth-stores` dev only) |
| What changes: the session's `authType` not overwritten | 4c (rule 1, rule 3); 4e (token API refusal) |
| What changes: commands move to the CLI package; layout; `release:publish` | step 3; step 5; step 7 |

| Spec section | Step |
|---|---|
| §0 | evidence only |
| §1.1 | done (interfaces) |
| §1.2 | 1 |
| §1.3 | 2 |
| §2 | 4b (surface), 4c (`flush`), 4d (options), 4e (`provider` optional for the token API) |
| §3.1, §3.2, §3.3 | 4b; public client in 4c |
| §4.1 | 4b (`basic`, `snc`, `none`), 4c (UAA), 4d (OIDC, SAML) |
| §4.2 | 4b–4d (each provider's own `rejected()`, tested through the contract) |
| §4.3 | 4e |
| §4.4 | 4b, extended per row in 4c and 4d |
| §5 | 4c (`authorization`), 4d (the rest) |
| §6 | 4c |
| §7 | 4b (promise cache), 4e (shared with the token API) |
| §8 | 1 (stores), done (contract) |
| §9 | 4e; carried-over suite in every step-4 PR |
| §10 | 3 (move, imports, version), 4a (explicit collaborators), 5 (destinations, flags, `flush`), 7 (release) |
| §11 | 3 |
| §12 | 7 (breaking list, migration notes); 8 (consumers) |
| §13 | 4b–4e (unit, connection 10), 4d (stand, D5), 6 (live) |
| §14 | 4a (stale comments), every step (its docs), 7 (final pass, deletion) |
| §15 | not delivered, by design |
| §16 | this checklist |
