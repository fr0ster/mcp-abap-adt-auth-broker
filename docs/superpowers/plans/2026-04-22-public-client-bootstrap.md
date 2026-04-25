# Public-client Authorization Code Bootstrap — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parameter-driven bootstrap mode to `bin/mcp-auth.ts` that takes `--abap-url --uaa-url --client-id` (no service-key file), runs OAuth2 authorization-code with PKCE via the existing `OidcBrowserProvider`, and writes a valid `BTP_*` `.env` consumable by `mcp-abap-adt`.

**Architecture:** No new providers or stores. CLI bypasses `AuthBroker` and `IServiceKeyStore` for this mode entirely — it instantiates `OidcBrowserProvider` directly with explicit `authorizationEndpoint` / `tokenEndpoint` (so OIDC discovery is skipped), drives the login, and writes env vars using existing `BTP_AUTHORIZATION_VARS` / `BTP_CONNECTION_VARS` constants. Output `.env` has `BTP_UAA_CLIENT_SECRET=` empty.

**Mode boundaries:** Public-client mode always writes `.env` output and always uses browser-based authorization-code + PKCE. In this mode, `--format json`, `--credential`, and `--service-url` are not supported and must be rejected by argument parsing rather than silently ignored.

**Tech Stack:** TypeScript, Node.js, Jest (`ts-jest`), `@mcp-abap-adt/auth-providers` (`OidcBrowserProvider`), `@mcp-abap-adt/auth-stores` (constants only).

---

## File Structure

| File | Responsibility |
|---|---|
| Create: `src/cli/publicClientBootstrap.ts` | Pure module: given `{abapUrl, uaaUrl, clientId, redirectPort, browser}`, run `OidcBrowserProvider` and return `{accessToken, refreshToken?}`. No fs, no process.exit. |
| Create: `src/cli/publicClientEnv.ts` | Pure module: serialize `BTP_*` `.env` content from `{abapUrl, uaaUrl, clientId, accessToken, refreshToken?}`. No fs writes — returns string. |
| Modify: `bin/mcp-auth.ts` | Add `--abap-url`, `--uaa-url`, `--client-id` parsing; new branch in `main()` that calls the two modules above and writes the file. |
| Create: `src/__tests__/cli/publicClientEnv.test.ts` | Unit tests for env serializer. |
| Create: `src/__tests__/cli/publicClientBootstrap.integration.test.ts` | Manual-gated end-to-end against the probed target. |
| Create: `src/__tests__/cli/parseArgs.test.ts` | Unit tests for new CLI arg parsing (mutual exclusion, missing combos). |

The two pure modules under `src/cli/` exist so the bin file stays a thin entrypoint and the logic is unit-testable without spawning processes.

---

## Task 1: Pure env-file serializer

**Files:**
- Create: `src/cli/publicClientEnv.ts`
- Test: `src/__tests__/cli/publicClientEnv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/cli/publicClientEnv.test.ts
import { renderPublicClientEnv } from '../../cli/publicClientEnv';

describe('renderPublicClientEnv', () => {
  it('renders BTP_* vars with empty client_secret', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'https://abap.example/',
      uaaUrl: 'https://uaa.example',
      clientId: 'sb-xs-foo!b1|xsuaa-bar!b2',
      accessToken: 'jwt.access.token',
      refreshToken: 'rt-value',
    });
    expect(out).toContain('BTP_ABAP_URL=https://abap.example/');
    expect(out).toContain('BTP_UAA_URL=https://uaa.example');
    expect(out).toContain('BTP_UAA_CLIENT_ID=sb-xs-foo!b1|xsuaa-bar!b2');
    expect(out).toContain('BTP_UAA_CLIENT_SECRET=');
    expect(out).toContain('BTP_JWT_TOKEN=jwt.access.token');
    expect(out).toContain('BTP_REFRESH_TOKEN=rt-value');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('omits refresh token line when not provided', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'https://abap.example/',
      uaaUrl: 'https://uaa.example',
      clientId: 'cid',
      accessToken: 'jwt',
    });
    expect(out).not.toContain('BTP_REFRESH_TOKEN');
  });

  it('always emits BTP_UAA_CLIENT_SECRET= as the public-client marker', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'a',
      uaaUrl: 'b',
      clientId: 'c',
      accessToken: 'd',
    });
    expect(out).toMatch(/^BTP_UAA_CLIENT_SECRET=$/m);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- publicClientEnv.test.ts`
Expected: FAIL with module-not-found for `../../cli/publicClientEnv`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/publicClientEnv.ts
import {
  BTP_AUTHORIZATION_VARS,
  BTP_CONNECTION_VARS,
} from '@mcp-abap-adt/auth-stores';

export interface PublicClientEnvInput {
  abapUrl: string;
  uaaUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
}

export function renderPublicClientEnv(input: PublicClientEnvInput): string {
  const lines: string[] = [];
  lines.push(`${BTP_CONNECTION_VARS.SERVICE_URL}=${input.abapUrl}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_URL}=${input.uaaUrl}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_CLIENT_ID}=${input.clientId}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=`);
  lines.push(`${BTP_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${input.accessToken}`);
  if (input.refreshToken) {
    lines.push(
      `${BTP_AUTHORIZATION_VARS.REFRESH_TOKEN}=${input.refreshToken}`,
    );
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- publicClientEnv.test.ts`
Expected: PASS, 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/publicClientEnv.ts src/__tests__/cli/publicClientEnv.test.ts
git commit -m "feat(cli): add public-client BTP_* env serializer"
```

---

## Task 2: Pure bootstrap function around `OidcBrowserProvider`

**Files:**
- Create: `src/cli/publicClientBootstrap.ts`

This task has no unit test — the logic is a thin orchestration around `OidcBrowserProvider`. Real verification happens in Task 5 (integration). We still ship the module separately so the bin file is testable.

- [ ] **Step 1: Write the module**

```ts
// src/cli/publicClientBootstrap.ts
import { OidcBrowserProvider } from '@mcp-abap-adt/auth-providers';

export interface PublicClientBootstrapInput {
  uaaUrl: string;
  clientId: string;
  redirectPort?: number;
  browser?: string;
}

export interface PublicClientBootstrapResult {
  accessToken: string;
  refreshToken?: string;
}

export async function bootstrapPublicClient(
  input: PublicClientBootstrapInput,
): Promise<PublicClientBootstrapResult> {
  const base = input.uaaUrl.replace(/\/$/, '');
  const provider = new OidcBrowserProvider({
    clientId: input.clientId,
    authorizationEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    scopes: ['openid'],
    redirectPort: input.redirectPort ?? 3001,
    browser: input.browser ?? 'auto',
  });

  const result = await provider.getTokens();
  if (!result.authorizationToken) {
    throw new Error(
      'OidcBrowserProvider returned no authorizationToken — check client registration',
    );
  }
  return {
    accessToken: result.authorizationToken,
    refreshToken: result.refreshToken,
  };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run test:check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/publicClientBootstrap.ts
git commit -m "feat(cli): add public-client bootstrap wrapper around OidcBrowserProvider"
```

> **Note for the implementer:** The exact method to fetch tokens off `OidcBrowserProvider` is `getTokens()` returning an `ITokenResult` whose `authorizationToken` is the access token (see `OidcBrowserProvider.ts:132-138` and `BaseTokenProvider`). If the actual signature differs (e.g. `getToken()` returning a string), adjust this single call site — the contract of this module stays the same.

---

## Task 3: CLI argument parsing for new mode

**Files:**
- Modify: `bin/mcp-auth.ts` (`McpAuthOptions` interface around line 47, `parseArgs` around line 238)
- Create: `src/__tests__/cli/parseArgs.test.ts`

To make `parseArgs` testable, extract it from the bin file. Move its body into `src/cli/parseArgs.ts` and re-import from the bin.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/cli/parseArgs.test.ts
import { parseArgs } from '../../cli/parseArgs';

describe('parseArgs — public-client mode', () => {
  it('parses --abap-url --uaa-url --client-id --output', () => {
    const opts = parseArgs([
      '--abap-url', 'https://abap.example/',
      '--uaa-url',  'https://uaa.example',
      '--client-id', 'cid',
      '--output',   '/tmp/out.env',
    ]);
    expect(opts.mode).toBe('public-client');
    expect(opts.abapUrl).toBe('https://abap.example/');
    expect(opts.uaaUrl).toBe('https://uaa.example');
    expect(opts.clientId).toBe('cid');
    expect(opts.outputFile).toBe('/tmp/out.env');
  });

  it('rejects --abap-url combined with --service-key', () => {
    expect(() =>
      parseArgs([
        '--abap-url', 'x',
        '--uaa-url', 'y',
        '--client-id', 'z',
        '--service-key', 'k.json',
        '--output', 'o.env',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('requires --uaa-url and --client-id when --abap-url is given', () => {
    expect(() =>
      parseArgs(['--abap-url', 'x', '--output', 'o.env']),
    ).toThrow(/--uaa-url/);
    expect(() =>
      parseArgs(['--abap-url', 'x', '--uaa-url', 'y', '--output', 'o.env']),
    ).toThrow(/--client-id/);
  });

  it('still parses legacy --service-key mode', () => {
    const opts = parseArgs([
      '--service-key', 'key.json',
      '--output', 'o.env',
      '--type', 'xsuaa',
    ]);
    expect(opts.mode).toBe('service-key');
    expect(opts.serviceKeyPath).toBe('key.json');
    expect(opts.authType).toBe('xsuaa');
  });

  it('rejects unsupported flags in public-client mode', () => {
    expect(() =>
      parseArgs([
        '--abap-url', 'x',
        '--uaa-url', 'y',
        '--client-id', 'z',
        '--credential',
        '--output', 'o.env',
      ]),
    ).toThrow(/--credential/);

    expect(() =>
      parseArgs([
        '--abap-url', 'x',
        '--uaa-url', 'y',
        '--client-id', 'z',
        '--format', 'json',
        '--output', 'o.env',
      ]),
    ).toThrow(/--format json/);

    expect(() =>
      parseArgs([
        '--abap-url', 'x',
        '--uaa-url', 'y',
        '--client-id', 'z',
        '--service-url', 'https://ignored.example',
        '--output', 'o.env',
      ]),
    ).toThrow(/--service-url/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- parseArgs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract `parseArgs` into a pure module**

Create `src/cli/parseArgs.ts`. Copy the `McpAuthOptions` interface body and the body of `parseArgs` from `bin/mcp-auth.ts` (lines 47–57 and 238–364). Replace every `process.exit(1)` and `console.error(...)` with `throw new Error('...')` so the function is testable. Add a discriminator field `mode: 'service-key' | 'public-client'`. The full file:

```ts
// src/cli/parseArgs.ts
export interface McpAuthOptions {
  mode: 'service-key' | 'public-client';
  // service-key mode
  serviceKeyPath?: string;
  envFilePath?: string;
  authType: 'abap' | 'xsuaa';
  credential: boolean;
  // public-client mode
  abapUrl?: string;
  uaaUrl?: string;
  clientId?: string;
  // common
  outputFile: string;
  browser: string;
  format: 'json' | 'env';
  serviceUrl?: string;
  redirectPort?: number;
}

export function parseArgs(args: string[]): McpAuthOptions {
  let serviceKeyPath: string | undefined;
  let envFilePath: string | undefined;
  let outputFile: string | undefined;
  let abapUrl: string | undefined;
  let uaaUrl: string | undefined;
  let clientId: string | undefined;
  let authType: 'abap' | 'xsuaa' = 'abap';
  let browser = 'auto';
  let credential = false;
  let format: 'json' | 'env' = 'env';
  let serviceUrl: string | undefined;
  let redirectPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--service-key': serviceKeyPath = next(); break;
      case '--env':         envFilePath   = next(); break;
      case '--output':      outputFile    = next(); break;
      case '--abap-url':    abapUrl       = next(); break;
      case '--uaa-url':     uaaUrl        = next(); break;
      case '--client-id':   clientId      = next(); break;
      case '--type': {
        const t = next();
        if (t !== 'abap' && t !== 'xsuaa') {
          throw new Error(`Invalid auth type: ${t}. Must be 'abap' or 'xsuaa'`);
        }
        authType = t;
        break;
      }
      case '--browser': {
        const b = next();
        const allowed = ['none', 'chrome', 'edge', 'firefox', 'system', 'headless', 'auto'];
        if (!allowed.includes(b)) {
          throw new Error(`Invalid browser: ${b}. Must be one of: ${allowed.join(', ')}`);
        }
        browser = b;
        break;
      }
      case '--format': {
        const f = next();
        if (f !== 'json' && f !== 'env') {
          throw new Error(`Invalid format: ${f}. Must be 'json' or 'env'`);
        }
        format = f;
        break;
      }
      case '--service-url': serviceUrl = next(); break;
      case '--redirect-port': {
        const p = parseInt(next(), 10);
        if (Number.isNaN(p) || p < 1 || p > 65535) {
          throw new Error(`Invalid redirect port. Must be 1..65535`);
        }
        redirectPort = p;
        break;
      }
      case '--credential': credential = true; break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }

  if (!outputFile) throw new Error('--output is required');

  const hasPublicClient = !!abapUrl || !!uaaUrl || !!clientId;
  const hasServiceKey = !!serviceKeyPath || !!envFilePath;

  if (hasPublicClient && hasServiceKey) {
    throw new Error(
      '--abap-url/--uaa-url/--client-id are mutually exclusive with --service-key/--env',
    );
  }

  if (hasPublicClient) {
    if (!abapUrl) throw new Error('--abap-url is required in public-client mode');
    if (!uaaUrl)  throw new Error('--uaa-url is required in public-client mode');
    if (!clientId) throw new Error('--client-id is required in public-client mode');
    if (credential) {
      throw new Error('--credential is not supported in public-client mode');
    }
    if (format !== 'env') {
      throw new Error('--format json is not supported in public-client mode');
    }
    if (serviceUrl) {
      throw new Error('--service-url is not supported in public-client mode; use --abap-url instead');
    }
    return {
      mode: 'public-client',
      abapUrl, uaaUrl, clientId, outputFile,
      authType, browser, credential, format, serviceUrl, redirectPort,
    };
  }

  if (!serviceKeyPath && !envFilePath) {
    throw new Error('Either --service-key or --env (or --abap-url) must be provided');
  }
  return {
    mode: 'service-key',
    serviceKeyPath, envFilePath, outputFile,
    authType, browser, credential, format, serviceUrl, redirectPort,
  };
}
```

- [ ] **Step 4: Replace `parseArgs` in `bin/mcp-auth.ts` with an import**

In `bin/mcp-auth.ts`:
- Delete the local `McpAuthOptions` interface (lines 47–57) and the local `parseArgs` function (lines 238–364).
- Add at top: `import { parseArgs, type McpAuthOptions } from '../src/cli/parseArgs';`
- In `main()` (line ~554), wrap the call: `let options: McpAuthOptions; try { options = parseArgs(hasSubcommand ? rawArgs.slice(1) : rawArgs); } catch (e: any) { console.error('Error:', e.message); console.error('Run "mcp-auth --help" for usage information'); process.exit(1); }`
- Keep the `--help` / `--version` handling in `main()` before the `parseArgs` call (move that block out of the deleted function — it currently lives at the top of `parseArgs`).

- [ ] **Step 5: Run tests and type-check**

Run: `npm test -- parseArgs.test.ts && npm run test:check`
Expected: 5 tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/parseArgs.ts src/__tests__/cli/parseArgs.test.ts bin/mcp-auth.ts
git commit -m "refactor(cli): extract parseArgs; add public-client mode flags"
```

---

## Task 4: Wire the new mode in `bin/mcp-auth.ts`

**Files:**
- Modify: `bin/mcp-auth.ts` (`main()` around line 492)

- [ ] **Step 1: Add the new branch**

After parsing options, but before the existing service-key flow, insert:

```ts
if (options.mode === 'public-client') {
  const { bootstrapPublicClient } = await import('../src/cli/publicClientBootstrap');
  const { renderPublicClientEnv } = await import('../src/cli/publicClientEnv');

  console.log(`📁 Output file: ${path.resolve(options.outputFile)}`);
  console.log(`🌐 ABAP URL: ${options.abapUrl}`);
  console.log(`🛡  UAA URL: ${options.uaaUrl}`);
  console.log(`🆔 Client ID: ${options.clientId}`);
  console.log(`🔑 Flow: authorization_code + PKCE (public client)`);

  const tokens = await bootstrapPublicClient({
    uaaUrl: options.uaaUrl!,
    clientId: options.clientId!,
    redirectPort: options.redirectPort,
    browser: options.browser,
  });

  const envContent = renderPublicClientEnv({
    abapUrl: options.abapUrl!,
    uaaUrl: options.uaaUrl!,
    clientId: options.clientId!,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });

  const outputPath = path.resolve(options.outputFile);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, envContent, 'utf8');

  console.log(`✅ .env file created: ${outputPath}`);
  console.log(`   - BTP_ABAP_URL=${options.abapUrl}`);
  console.log(`   - BTP_UAA_URL=${options.uaaUrl}`);
  console.log(`   - BTP_UAA_CLIENT_ID=${options.clientId}`);
  console.log(`   - BTP_UAA_CLIENT_SECRET= (empty — public client)`);
  console.log(`   - BTP_JWT_TOKEN=${tokens.accessToken.substring(0, 50)}...`);
  if (tokens.refreshToken) {
    console.log(`   - BTP_REFRESH_TOKEN=${tokens.refreshToken.substring(0, 50)}...`);
  } else {
    console.log(`   - (no BTP_REFRESH_TOKEN — XSUAA did not issue one)`);
  }
  process.exit(0);
}
```

- [ ] **Step 2: Update `--help` text**

In `showHelp()`, add a section before the existing "Examples":

```ts
console.log('Public-client mode (no service key — URL + client_id only):');
console.log('  --abap-url <url>        ABAP system URL (required for public-client)');
console.log('  --uaa-url <url>         XSUAA tenant URL (required for public-client)');
console.log('  --client-id <id>        Public OAuth client_id (required for public-client)');
console.log('');
```

And add an example:

```ts
console.log('  # Public-client (no service key)');
console.log(
  '  mcp-auth --abap-url https://...abap.eu10.hana.ondemand.com \\',
);
console.log('           --uaa-url  https://...authentication.eu10.hana.ondemand.com \\');
console.log("           --client-id 'sb-xs-...!b1|xsuaa-abapcp-prod-eu10!b4584' \\");
console.log('           --output ./mcp.env');
console.log('');
```

- [ ] **Step 3: Build the CLI**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Smoke-test argument parsing**

Run: `node dist/bin/mcp-auth.js --help`
Expected: help text includes the new public-client section.

Run: `node dist/bin/mcp-auth.js --abap-url x --uaa-url y --client-id z --service-key k.json --output o.env`
Expected: exits non-zero with `Error: --abap-url/--uaa-url/--client-id are mutually exclusive with --service-key/--env`.

- [ ] **Step 5: Commit**

```bash
git add bin/mcp-auth.ts
git commit -m "feat(cli): wire public-client bootstrap mode"
```

---

## Task 5: Manual integration test (gated like browser test)

**Files:**
- Create: `src/__tests__/cli/publicClientBootstrap.integration.test.ts`

This test is `.skip`-ped by default. The implementer runs it manually after Task 4 with real credentials by removing `.skip`.

- [ ] **Step 1: Write the gated test**

```ts
// src/__tests__/cli/publicClientBootstrap.integration.test.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ABAP_URL   = process.env.TEST_ABAP_URL;
const UAA_URL    = process.env.TEST_UAA_URL;
const CLIENT_ID  = process.env.TEST_CLIENT_ID;

(ABAP_URL && UAA_URL && CLIENT_ID ? describe : describe.skip)(
  'mcp-auth public-client end-to-end (manual)',
  () => {
    it('writes a .env with non-empty BTP_JWT_TOKEN and ABAP GET succeeds', async () => {
      const outDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mcp-auth-'));
      const outFile = path.join(outDir, 'mcp.env');
      const cli = path.resolve(__dirname, '../../../dist/bin/mcp-auth.js');

      const r = spawnSync(process.execPath, [
        cli,
        '--abap-url', ABAP_URL!,
        '--uaa-url',  UAA_URL!,
        '--client-id', CLIENT_ID!,
        '--output', outFile,
      ], { stdio: 'inherit', timeout: 5 * 60 * 1000 });

      expect(r.status).toBe(0);
      const content = fs.readFileSync(outFile, 'utf8');
      expect(content).toMatch(/^BTP_JWT_TOKEN=.+$/m);
      expect(content).toMatch(/^BTP_UAA_CLIENT_SECRET=$/m);
      expect(content).toMatch(`BTP_ABAP_URL=${ABAP_URL}`);

      const jwtLine = content.split('\n').find(l => l.startsWith('BTP_JWT_TOKEN='))!;
      const jwt = jwtLine.split('=', 2)[1];

      const adt = await fetch(`${ABAP_URL!.replace(/\/$/,'')}/sap/bc/adt/discovery`, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/atomsvc+xml' },
      });
      expect(adt.status).toBe(200);
      console.log(`ADT discovery status: ${adt.status}`);
    });
  },
);
```

- [ ] **Step 2: Document how to run it**

Add a top-of-file comment block with:

```
// To run:
//   npm run build
//   TEST_ABAP_URL=https://...abap.eu10.hana.ondemand.com \
//   TEST_UAA_URL=https://...authentication.eu10.hana.ondemand.com \
//   TEST_CLIENT_ID='sb-xs-...|xsuaa-abapcp-prod-eu10!b4584' \
//   npm test -- publicClientBootstrap.integration.test.ts
//
// You will need to log in via the browser when it opens.
// Record whether refresh_token was issued (visible in the .env file).
```

- [ ] **Step 3: Verify the gate works**

Run: `npm test -- publicClientBootstrap.integration.test.ts`
Expected: 1 suite skipped, no failures.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/cli/publicClientBootstrap.integration.test.ts
git commit -m "test(cli): add gated end-to-end test for public-client bootstrap"
```

---

## Task 6: Real-target run and outcome recording

This task has no code — it is a manual verification step that produces evidence for the spec's "Open Risks" section.

- [ ] **Step 1: Run the integration test against the probed system**

Use the URL/`client_id` from the spec's "Probe Findings" section. Run the integration test as documented in Task 5.

- [ ] **Step 2: Verify primary success criteria**

- `.env` file is written.
- `BTP_JWT_TOKEN` is non-empty.
- ADT discovery returned `200` (full success for Phase 1 acceptance).
- If `401`/`403`, record that outcome in the spec as probe evidence, but do **not** mark Phase 1 complete; audience/scope remains unresolved.

- [ ] **Step 3: Record refresh-token outcome**

Inspect the produced `.env`:

- `BTP_REFRESH_TOKEN` present → record "refresh available" in the spec's Open Risks section.
- Not present → record "no refresh; re-auth required under `allowBrowserAuth: false`".

Append a one-paragraph note to the spec's "Open Risks" section under a new sub-heading `Observed at <date>`.

- [ ] **Step 4: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-04-22-url-auth-design.md
git commit -m "docs: record observed end-to-end outcome for public-client target"
```

---

## Task 7: Verify broker can refresh from the produced `.env` (only if refresh token issued)

Skip this task if Task 6 recorded "no refresh".

**Files:**
- Use existing `AuthBroker` and BTP session-store implementation (no new production files unless a tolerance fix is required).

- [ ] **Step 1: Write a small script in the integration test**

Append a second `it(...)` to `publicClientBootstrap.integration.test.ts` that, after the first call wrote the env, constructs `AuthBroker` against that `.env` and calls `getToken(destination)`. Assert it returns a non-empty token without launching a browser.

```ts
it('subsequent broker call refreshes silently when refresh_token was issued', async () => {
  // Re-use outFile from previous it() — restructure with describe/beforeAll if needed.
  // Construct AuthBroker with the same local contracts the produced env is expected
  // to satisfy: a BTP session-store implementation reading that env file plus
  // an OidcBrowserProvider configured for the same public client with browser:'none'.
  // Call broker.getToken(destination); expect a JWT and no browser interaction.
});
```

- [ ] **Step 2: Address any tolerance gap discovered**

If the broker or BTP session-store implementation rejects the empty `BTP_UAA_CLIENT_SECRET`, find the validation site and relax it to "secret optional when client_id present". Also check the broker persistence path: `AuthBroker` currently skips saving authorization config when `uaaClientSecret` is missing, so this condition is an expected hotspot, not a surprise. Add a focused unit test next to the change. Keep the change one-file, one-call-site if possible. If the gap proves wider than one site, stop and revisit the spec — do not start a refactor here.

- [ ] **Step 3: Commit**

```bash
git add ...
git commit -m "feat: tolerate empty BTP_UAA_CLIENT_SECRET for public-client refresh"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md` (broker)

- [ ] **Step 1: Add a "Public-client mode" section**

After the existing service-key example, document the new invocation:

```markdown
### Public-client mode (no service key)

When you have only the ABAP system URL, the XSUAA tenant URL, and a public OAuth client_id (registered with `localhost` redirect):

```bash
mcp-auth --abap-url https://<system>.abap.<region>.hana.ondemand.com \
         --uaa-url  https://<tenant>.authentication.<region>.hana.ondemand.com \
         --client-id '<sb-xs-...|xsuaa-abapcp-prod-<region>!b4584>' \
         --output ./mcp.env
```

A browser opens for login; on success the `.env` file contains `BTP_*` variables with an empty `BTP_UAA_CLIENT_SECRET=` line marking the session as a public-client session. Whether a refresh token is issued depends on the client registration; if it is not, you will be asked to re-authenticate when the access token expires.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document public-client mode in README"
```

---

## Self-Review Notes

- **Spec coverage:** Every Phase 1 spec section is mapped to a task. Phase 2 (YAML config) is intentionally not in this plan.
  - CLI surface → Tasks 3, 4
  - Provider wiring → Task 2
  - Storage → Tasks 1, 7
  - Refresh / `allowBrowserAuth` → Task 7 (and design note in Task 4)
  - Probe-target validation → Tasks 5, 6
- **Placeholders:** Task 7 step 1 intentionally describes the required local contract instead of depending on a specific file in another package. Task 6 has no code because it is a manual verification step.
- **Type consistency:** `bootstrapPublicClient` returns `{accessToken, refreshToken?}`; `renderPublicClientEnv` consumes the same names. `parseArgs` adds a `mode: 'service-key' | 'public-client'` discriminator that the bin file branches on.
- **Tolerance gap risk:** Task 7 explicitly bounds it: if the gap is bigger than one call site, stop and revisit the spec. Check both session-store validation and broker persistence gating around missing `uaaClientSecret`.
