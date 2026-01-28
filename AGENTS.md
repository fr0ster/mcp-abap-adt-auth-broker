# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript source (core `AuthBroker`, providers, stores, utils, and types).
- `src/__tests__/` holds Jest tests (`*.test.ts`).
- `bin/` contains the CLI entrypoint (`mcp-auth`).
- `dist/` is build output (generated).
- `docs/` includes architecture, installation, usage, and development references.
- `tests/` holds runtime test fixtures/config (`test-config.yaml*`).

## Build, Test, and Development Commands
- `npm run build`: Clean, lint, and compile TypeScript into `dist/`.
- `npm run build:fast`: Compile only (skip clean/lint).
- `npm run lint` / `npm run format`: Run Biome checks/formatting on `src/`.
- `npm test`: Run Jest tests sequentially (VM modules enabled).
- `npm run test:check`: Typecheck app + tests without emitting.
- `npm run generate-env`: Generate `.env` from a service key (see `bin/generate-env-from-service-key.ts`).
- `mcp-auth` CLI requires local dependencies (`npm install` in repo). No global `tsx` is needed.

## Coding Style & Naming Conventions
- Indentation: 2 spaces, single quotes, semicolons (Biome).
- TypeScript across `src/`; keep files small and focused by concern (`providers/`, `stores/`, `utils/`).
- Tests use `*.test.ts` in `src/__tests__/`.
- Run `npm run lint` before committing to keep style consistent.

## Testing Guidelines
- Jest + ts-jest; tests run sequentially (`maxWorkers: 1`).
- Add tests to `src/__tests__/` and match `**/__tests__/**/*.test.ts`.
- Local test setup uses `tests/test-config.yaml` (see template).
- Coverage is configured for `src/**/*.ts` excluding tests and d.ts.

## Commit & Pull Request Guidelines
- Commits follow Conventional Commits (e.g., `feat(cli): ...`, `fix: ...`, `chore: ...`).
- Release commits may use version tags (e.g., `0.2.17`).
- PRs should include a short description, motivation, and testing notes.
- If changes affect auth flows or CLI behavior, include example commands or screenshots of output.

## Security & Configuration Tips
- Do not commit `.env` or service key files; keep credentials in local paths.
- Use `AUTH_BROKER_PATH` to point to local destination config directories.
- For debugging, prefer `DEBUG_BROKER=true` with `LOG_LEVEL=debug`.
