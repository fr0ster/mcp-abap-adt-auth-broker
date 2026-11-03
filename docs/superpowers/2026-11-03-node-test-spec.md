# Spec: the test suites run on `node:test`

Goal: `2026-11-03-node-test-goal.md`. This spec decides what the goal left open, for every
repository. The plan carries it out in this repository first.

## 1. What the suites use (Measured, 2026-11-03, grep over the test files, approximate)

| Feature | mcp-abap-adt | auth-broker | auth-providers | adt-clients |
|---|---|---|---|---|
| test files | 542 | 55 | 140 | 406 |
| `jest.mock` (all with a factory) | 93 | 11 | 28 | 18 |
| `isolateModules` / `resetModules` / `doMock` | 1 / 0 / 0 | 0 | 1 / 3 / 4 | 15 / 0 / 0 |
| `jest.fn` / `spyOn` | 290 / 173 | 182 / 44 | 107 / 28 | 409 / 7 |
| `toHaveBeenCalled*` / `mock.calls` | 417 / 75 | 233 / 108 | 176 / 47 | 184 / 55 |
| fake timers | 114 | 8 | 23 | 11 |
| `it.each` + `describe.each` | 642 | 0 | 303 | 168 |
| `toMatchObject` / `objectContaining`… / `expect.any` | 436 / 118 / 37 | 28 / 93 / 50 | 243 / 16 / 32 | 66 / 107 / 7 |
| `toThrow` / `rejects`+`resolves` | 332 / 360 | 256 / 187 | 64 / 259 | 291 / 242 |
| snapshots, `expect.extend`, `__mocks__` | 0 | 0 | 0 | 0 |

Every repository is CommonJS (`module: CommonJS`). Every one uses Jest 30 with ts-jest,
`testEnvironment: node` and one worker. The source imports relative modules without file
extensions.

auth-broker's 11 `jest.mock` replace:
- `@mcp-abap-adt/auth-providers` (3);
- `@mcp-abap-adt/auth-errors` (1);
- `@mcp-abap-adt/auth-broker` (1, from the CLI);
- `node:readline` (5);
- `../mcpSsoConfig` (1).

## 2. How a test runs: compiled by `tsc`, run by `node --test`

- **Compile first.** A `tsconfig.test.json` that emits compiles the sources and the tests
  into a test-build directory, outside `dist` and ignored by git. `node --test` runs the
  compiled `*.test.js` files there.
- **Why compiled and not type-stripped.** Node's type stripping needs explicit file
  extensions on relative imports, and rejects enums, parameter properties and namespaces.
  - Taking it would mean rewriting the imports of the library sources, not only the tests.
  - Compiling with the `tsc` every repository already has needs no transform package, and
    keeps the CommonJS resolution the packages ship with.
  - The type check and the build of the tests are then one step.
- **Scripts:**
  - `npm test` builds the tests and runs every unit test file;
  - `npm run test:check` stays the type check.
- **Concurrency.** `--test-concurrency=1` where a suite needs order, as `maxWorkers: 1` does
  today; otherwise Node's default.
- **Time limit.** A suite or a test states its own with `{ timeout }`. There is no global
  default of the framework that a test can run past without saying so.

## 3. What replaces Jest's API

- **Runner and structure.** `describe`, `it`, `before`, `after`, `beforeEach` and `afterEach`
  come from `node:test`.
  - `it.skip` and `it.todo` stay.
  - Conditional registration (a helper that answers `it` or `it.skip`) answers
    `node:test`'s `it` or `it.skip`.
  - Table cases: `node:test` has no `each`. A loop over the rows calls `it` once per row,
    with the row's name in the title. No helper is needed.
- **Assertions.**
  - `node:assert/strict` covers equality, `throws`, `rejects` and deep partial matching
    (`assert.partialDeepStrictEqual`, Node 24+).
  - What it lacks is one small module of ours, `test/expect.ts`: the asymmetric matchers
    (`any`, `objectContaining`, `arrayContaining`, `stringContaining`) used inside deep
    comparisons. It is typed, has no dependency, and is tested itself.
  - We do not rebuild Jest's `expect`. A call site moves to the `assert` form, and the
    matchers module is used only where an asymmetric value is compared.
- **Mocks and spies.**
  - `mock.fn` and `mock.method` from `node:test` replace `jest.fn` and `jest.spyOn`.
  - Calls are read from `fn.mock.calls[i].arguments`, compared with `assert`.
  - `toHaveBeenCalledWith` becomes an assertion on the recorded calls. A one-line helper in
    the matchers module reads a call's arguments.
  - `mock.reset` and `mock.restoreAll` replace clear, reset and restore.
- **Module mocking: not used.**
  - `mock.module` needs an experimental flag, so no test depends on it.
  - A test that today replaces a module gets the dependency handed in instead, as
    constructor or factory options, the way providers already take their collaborators.
  - Where the code under test offers no seam:
    - a seam is added in the code, as a typed option defaulting to the real module;
    - the PR names each one;
    - the owner reviews each one, since it is a change to the library.
  - auth-broker's targets: §5.
- **Fake timers.**
  - `mock.timers` from `node:test` (`enable`, `tick`, `setTime`) replaces `useFakeTimers`
    and `advanceTimersByTime`.
  - Where a test needs async ticking (`advanceTimersByTimeAsync`), its helper awaits the
    queued promises between ticks.
  - The plan measures that in this repository's 8 uses before the larger repositories move.
- **Global setup and teardown.** A live run's setup becomes its own entry file, run by the
  live script before the suites, with `--test-global-setup` where the Node version has it.
  Unit runs have none.

## 4. Live suites are separate by construction

- Live suites live under `__tests__/live/` and build into their own directory.
- `npm test` runs only the unit directory, so no flag or ignore list can add a live file.
- `npm run test:live -- <file> [--test-name-pattern <case>]` runs one live file, or one
  case of it, and nothing else. Its documentation shows the one command.

## 5. This repository

- **Packages:** `auth-broker` and `auth-broker-cli`, 55 test files.
- **Module mocks to replace:**
  - `node:readline` in the CLI (5 files): the prompts take a readline factory, defaulting to
    `node:readline`'s `createInterface`.
  - `../mcpSsoConfig` (1): the caller takes the config reader as an option.
  - `@mcp-abap-adt/auth-providers`, `auth-errors` and `auth-broker` (5): the broker and the
    CLI take the provider factory or broker they use as an option, as the broker already
    takes stores and providers.
  - Where a test only needed an error class or a constant from a mocked package, it uses the
    real one.

  Each seam is listed in the PR for the owner.
- **Live suite:** `test:live` and its SNC setup become the live entry of §4.
- Jest, ts-jest and `@types/jest` leave the dependencies, and the lockfile is regenerated by
  npm.

## 6. Coverage

Not a gate today, so none is added. A run can ask for it with
`--experimental-test-coverage` when needed.

## 7. Order across repositories

The order is auth-broker, then the smaller ones (auth-errors, auth-stores, proxy,
auth-mocks), then auth-providers, adt-clients and mcp-abap-adt. Each one gets its own PR
and its own spec addendum for its seams. A repository moves when the one before is released.
