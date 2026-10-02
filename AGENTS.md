# Repository Guidelines

## Project Structure & Module Organization
- npm workspace (the `mcp-abap-adt-interfaces` layout); the root `package.json` is private and lists the packages in dependency order.
- `packages/auth-broker/` — `@mcp-abap-adt/auth-broker`: `src/` (core `AuthBroker`, providers, stores, types), `src/__tests__/` (Jest), `tests/test-config.yaml.template`, `tests/stand/` (UAA and Keycloak in Docker for the token-grant suites).
- `packages/auth-broker-cli/` — `@mcp-abap-adt/auth-broker-cli`: `src/` (`mcp-auth`, `mcp-sso` and their helpers; `generate-env-from-service-key.ts`), `src/__tests__/`, `tests/keycloak` and `tests/sso-demo` (interactive stands).
- `tools/` — `check-graph.js`, `check-packed.js`, `publish-changed.js`, `test-publish-changed.js`, `version-stats.sh`.
- `dist/` in each package is build output (generated).
- `docs/` includes architecture, installation, usage, and development references.

## Build, Test, and Development Commands
Run from the repository root.
- `npm run build`: Clean, lint, and compile both packages (`tsc -b`).
- `npm run lint` / `npm run lint:check` / `npm run format`: Biome over `packages/` and `tools/`.
- `npm test`: Jest in every workspace, sequentially (VM modules enabled); `npm test -w <package>` for one.
- `npm run test:check`: Typecheck both packages, tests included.
- `npm run check`: build, test:check, lint:check, check:graph, check:packed (bin smoke check, needs the network), check:publish. No Jest.
- `npm run test:live`: the library's live suite (`src/__tests__/live/`, real systems), excluded from `npm test`; each case reads only the environment variables it names and skips, printing why, elsewhere (`docs/development/TESTING.md`).
- `npm run test:stand`: the library's stand suites (`src/__tests__/stand/`) against UAA and Keycloak in Docker — starts the stand, runs them, stops what it started (`stand:up` / `stand:down` to keep it running); needs only Docker.
- `npm run generate-env -w @mcp-abap-adt/auth-broker-cli -- <destination> --grant <authorization_code|client_credentials>`: Generate a destination `.env` from a service key (a `tsx` script, not shipped; the grant is never inferred).
- `mcp-auth` / `mcp-sso` are compiled to `packages/auth-broker-cli/dist/` (no `tsx` at runtime).
- `npm run release:publish`: publish the versions the registry lacks; tags are `<dir>-v<version>`.

## Coding Style & Naming Conventions
- Indentation: 2 spaces, single quotes, semicolons (Biome).
- TypeScript across each package's `src/`; keep files small and focused by concern (`providers/`, `stores/`).
- Tests use `*.test.ts` in the package's `src/__tests__/`.
- Run `npm run lint` before committing to keep style consistent.

## Testing Guidelines
- Jest + ts-jest; tests run sequentially (`maxWorkers: 1`).
- Add tests to the package's `src/__tests__/` and match `**/__tests__/**/*.test.ts`; a test may import only what its package declares.
- Local test setup uses `packages/auth-broker/tests/test-config.yaml` (see template).
- Coverage is configured per package for `src/**/*.ts` excluding tests and d.ts.

## Commit & Pull Request Guidelines
- Commits follow Conventional Commits (e.g., `feat(cli): ...`, `fix: ...`, `chore: ...`).
- Releases are tagged per package: `auth-broker-v<version>`, `auth-broker-cli-v<version>` (the `v*` tags are history).
- PRs should include a short description, motivation, and testing notes.
- If changes affect auth flows or CLI behavior, include example commands or screenshots of output.

## Security & Configuration Tips
- Do not commit `.env` or service key files; keep credentials in local paths.
- Use `AUTH_BROKER_PATH` to point to local destination config directories.
- For debugging, prefer `DEBUG_BROKER=true` with `LOG_LEVEL=debug`.
