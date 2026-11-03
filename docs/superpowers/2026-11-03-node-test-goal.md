# Goal: the test suites run on `node:test`

## Goal

Every repository of the stack runs its tests on Node's built-in test runner, `node:test`, and
no longer depends on Jest. The repositories are:

- this one (the first);
- auth-providers;
- adt-clients and its legacy and strategies packages;
- mcp-abap-adt;
- any other one that uses Jest today.

A test framework that is part of the platform needs nothing installed. It runs the
repositories' ESM and TypeScript without a transform. It leaves cleanup and timing to our
code, not to the framework's internals.

## Why (Measured, 2026-11-03)

- **Selecting tests.**
  - `--testPathIgnorePatterns` replaces the configured ignores instead of adding to them.
  - `--testPathPatterns` is combined with a positional path as OR.

  Both selected live suites against a real system when a single file was meant.
- **Timeouts and cleanup.** When a test runs past its timeout, Jest tears down the test's
  environment while its cleanup still runs. A `require` in the cleanup then answers
  `undefined`, and objects the test created stay on the system.
- **Dependencies.** Jest brings a large dependency tree. A vulnerable `deepmerge` comes through
  `jest-config` with no fixed version.
- **ESM.** One repository loads its suites only with `--experimental-vm-modules`.

## Invariants

- **Nothing a test proves is lost.** Every case keeps what it asserts. A case that cannot be
  moved as it is gets an equivalent one and is named in the PR, not dropped.
- **No test-framework dependency.**
  - The runner, assertions, mocks and timers come from Node: `node:test`, `node:assert` and
    `mock`.
  - A helper we need is our own code in the repository, typed, with no runtime dependency.
- **TypeScript without a transform package.** Tests run through Node's type stripping on the
  Node versions the repositories support. No ts-jest, ts-node or babel.
- **Live tests are chosen explicitly.**
  - A unit run selects no live suite, by construction, and not by an ignore list that a flag
    can replace.
  - One live file or case runs alone with one documented command.
- **Cleanup is the test's own.**
  - A test's cleanup always runs, also after a failure or a timeout, and deletes only what the
    test created.
  - A timeout is the test's or the suite's own setting, never the framework's default.
- **Static types first.** Tests are type-checked as today, and the move adds no cast.
- **One repository at a time.** Each repository moves in its own PR, published as its own
  release when its package changes. The order is from the smallest.

## Open for the spec

- **What `node:test` gives directly, and what needs a helper of ours.** The measured inventory
  of what the suites use decides it:
  - module mocking;
  - fake timers;
  - snapshots;
  - `expect`-style matchers;
  - conditional registration;
  - global setup and teardown.
- **Where the shared helpers live.** In each repository, or in one package of ours that every
  repository depends on from the registry.
- **How the live suites are laid out** so that a unit run cannot select them: separate
  directories, a separate entry or a separate script.
- **Coverage.** Whether we need it and how: `--experimental-test-coverage`.
- **The Node versions supported** and what type stripping requires of the TypeScript the tests
  use: no enums, no parameter properties, no namespaces.
