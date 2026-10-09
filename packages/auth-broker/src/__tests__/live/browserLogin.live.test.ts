/**
 * A browser login through the built `mcp-auth` (CLI 3.0.0) with a real
 * browser, a human at the keyboard: the browser the run states opens the
 * login, the person logs in, the CLI writes the `.env`, and that `.env` opens
 * ADT through `getProvider` and connection 14 — the `jwt` case's check
 * (`adtProbe.ts`, shared). This is how the per-platform browser runs of the
 * auth-broker 5.0.0 / CLI 3.0.0 release are measured (macOS, Windows 11,
 * Linux): a test, not hand commands.
 *
 * Not part of `npm test`, not part of CI. Run with `npm run test:live` (from
 * the repository root or from `packages/auth-broker`); `-t "browser login"`
 * runs this suite alone.
 *
 * Runs only when these are set, and is skipped otherwise with the reason in
 * its title:
 *
 *   - AUTH_BROKER_LIVE_BROWSERS: a comma-separated list of what to pass, one
 *     case each, in order — a `--browser` value (`auto`, `system`, `chrome`,
 *     `edge`, `firefox`) or `program:<path or name>` for `--browser-program`
 *     (everything after the first `:`, so a Windows path is whole);
 *   - AUTH_BROKER_LIVE_SERVICE_KEYS_DIR and AUTH_BROKER_LIVE_JWT_DESTINATION:
 *     the destination's SAP service key, `<dir>/<destination>.json` — the
 *     same as the `jwt` case's (a BTP ABAP environment, trial);
 *   - the CLI built (`npm run build`).
 *
 * Setting AUTH_BROKER_LIVE_BROWSERS opens a browser: set it only where a
 * person will log in.
 *
 * Each case runs `node packages/auth-broker-cli/dist/mcp-auth.js
 * --service-key <dir>/<destination>.json --output <tmp>/<name>.env --type abap
 * --browser <item>` (or `--browser-program <program>`) as a child process —
 * `process.execPath`, an argument array, no shell — in a fresh temporary
 * directory removed after the case, and waits for the person: the run has no
 * timeout of its own, only Jest's (LOGIN_TIMEOUT_MS, ten minutes for a human
 * to log in, plus the ADT check). A run still going when Jest gives up is
 * sent SIGTERM in `afterEach` — the CLI's interrupt releases the callback
 * port and removes its work directory — so no process outlives the case.
 * The cases run one after another: they share one callback port (auth-
 * providers' DEFAULT_CALLBACK_PORT), which must be free when the suite starts.
 *
 * Each asserts: exit 0; stdout empty; stderr holds neither the token nor the
 * refresh token the `.env` holds, nor the key's client secret; the `.env`
 * holds SAP_JWT_TOKEN, SAP_REFRESH_TOKEN, SAP_ISSUED_FOR and SAP_ISSUED_BY.
 * Then, on a copy of the `.env` as `<tmp>/sessions/<destination>.env`, the
 * `jwt` case's check: a refused token seeded, the 401 renewed by refresh,
 * 200.
 *
 * Jest prints the received value when a matcher fails: every assertion on a
 * token, a secret or a stream is made on a boolean projection of it. Only
 * safe facts are printed (through `runLog`): the exit code, the size of
 * stdout and stderr, token lengths, the ADT status and size — so the output
 * can be pasted. A failed run is described by its exit status and its `❌`
 * lines, and only when those hold no secret the case knows and no JWT.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeWhere, runLog as log } from '../helpers/describeWhere';
import { expectRefusedTokenRenewed } from './adtProbe';

const env = process.env;

/** packages/auth-broker-cli, beside this package: run, never imported. */
const CLI = path.resolve(__dirname, '../../../../auth-broker-cli');
const MCP_AUTH = path.join(CLI, 'dist', 'mcp-auth.js');

/**
 * Jest's timeout per case: ten minutes for a person to log in in the browser
 * that opens, plus a minute for the ADT check. The run itself has none.
 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CASE_TIMEOUT_MS = LOGIN_TIMEOUT_MS + 60_000;

/** The `--browser` values a case may pass; `none` / `headless` open nothing. */
const BROWSER_VALUES = ['auto', 'system', 'chrome', 'edge', 'firefox'];
const PROGRAM_PREFIX = 'program:';

/** What one item of AUTH_BROKER_LIVE_BROWSERS states. */
type BrowserItem =
  | { item: string; flag: '--browser'; value: string; name: string }
  | { item: string; flag: '--browser-program'; value: string; name: string }
  | { item: string; invalid: string };

function parseItem(item: string, index: number): BrowserItem {
  if (item.startsWith(PROGRAM_PREFIX)) {
    const program = item.slice(PROGRAM_PREFIX.length).trim();
    return program
      ? {
          item,
          flag: '--browser-program',
          value: program,
          name: `${index + 1}-program`,
        }
      : { item, invalid: 'program: names no program' };
  }
  return BROWSER_VALUES.includes(item)
    ? { item, flag: '--browser', value: item, name: `${index + 1}-${item}` }
    : {
        item,
        invalid: `not one of ${BROWSER_VALUES.join(', ')}, nor ${PROGRAM_PREFIX}<path or name>`,
      };
}

const items: BrowserItem[] = (env.AUTH_BROKER_LIVE_BROWSERS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item.length > 0)
  .map(parseItem);

function unavailable(): string | null {
  const missing = [
    'AUTH_BROKER_LIVE_BROWSERS',
    'AUTH_BROKER_LIVE_SERVICE_KEYS_DIR',
    'AUTH_BROKER_LIVE_JWT_DESTINATION',
  ].filter((name) => !env[name]);
  if (missing.length) {
    return `no browser login asked for: set ${missing.join(', ')} (AUTH_BROKER_LIVE_BROWSERS opens a browser — only where a person logs in)`;
  }
  if (items.length === 0) {
    return 'AUTH_BROKER_LIVE_BROWSERS names no browser';
  }
  const key = path.join(
    env.AUTH_BROKER_LIVE_SERVICE_KEYS_DIR as string,
    `${env.AUTH_BROKER_LIVE_JWT_DESTINATION}.json`,
  );
  if (!fs.existsSync(key)) {
    return `no service key ${key}`;
  }
  if (!fs.existsSync(MCP_AUTH)) {
    return 'the CLI is not built: npm run build';
  }
  return null;
}

/**
 * `KEY=value` lines of a `.env`, surrounding quotes removed — plain code
 * over the file the CLI wrote, never printed.
 */
function readEnvValues(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith('#')) continue;
    let value = line.slice(eq + 1);
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === "'" || quote === '"' || quote === '`') &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

/** The key's client secret (`uaa.clientsecret`), or none; never printed. */
function clientSecretOf(keyFile: string): string | undefined {
  // A parse error quotes part of its input — here, part of a secret.
  let key: {
    uaa?: { clientsecret?: unknown };
    credentials?: { uaa?: { clientsecret?: unknown } };
  };
  try {
    key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } catch {
    throw new Error(`${path.basename(keyFile)} is not JSON`);
  }
  const secret = (key.credentials?.uaa ?? key.uaa)?.clientsecret;
  return typeof secret === 'string' && secret ? secret : undefined;
}

/** A JWT's shape (`eyJ….eyJ….`) anywhere in a text. */
const jwtFree = (text: string): boolean =>
  !/eyJ[\w-]{8,}\.eyJ[\w-]{8,}\./.test(text);

interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

describeWhere(
  'browser login — mcp-auth with a real browser, a person logs in (CLI 3.0.0 → .env → getProvider → connection 14)',
  unavailable(),
  () => {
    // Jest collects a skipped block too: no path may be built from an unset variable.
    const keysDir = env.AUTH_BROKER_LIVE_SERVICE_KEYS_DIR ?? '';
    const destination = env.AUTH_BROKER_LIVE_JWT_DESTINATION ?? '';
    const keyFile = path.join(keysDir, `${destination}.json`);
    let work: string;
    let running: ChildProcess | undefined;

    /** Runs `node <MCP_AUTH> <args>` in `work`, until it exits — no timeout. */
    const mcpAuth = (args: string[]): Promise<CommandResult> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MCP_AUTH, ...args], {
          cwd: work,
          // Jest's --experimental-vm-modules is not the CLI's.
          env: { ...process.env, NODE_OPTIONS: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        running = child;
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          running = undefined;
          reject(error);
        });
        child.on('close', (status, signal) => {
          running = undefined;
          resolve({ status, signal, stdout, stderr });
        });
      });

    beforeEach(() => {
      work = fs.mkdtempSync(
        path.join(os.tmpdir(), 'auth-broker-live-browser-'),
      );
    });

    afterEach(async () => {
      // Jest gave up on the person: end the run, and wait for it to end, so
      // the next case finds the callback port free.
      const child = running;
      if (child && child.exitCode === null && child.signalCode === null) {
        const ended = new Promise<void>((done) => child.once('close', done));
        child.kill('SIGTERM');
        await ended;
      }
      fs.rmSync(work, { recursive: true, force: true });
    });

    // Skipped without an item, the block still needs a case to be collected.
    if (items.length === 0) {
      it(`${process.platform}: a login per AUTH_BROKER_LIVE_BROWSERS item`, () => {});
    }

    for (const parsed of items) {
      const title = `${process.platform}: ${parsed.item}`;
      if ('invalid' in parsed) {
        it(title, () => {
          throw new Error(
            `AUTH_BROKER_LIVE_BROWSERS item "${parsed.item}": ${parsed.invalid}`,
          );
        });
        continue;
      }

      it(
        title,
        async () => {
          const output = path.join(work, `${parsed.name}.env`);
          log.info(
            `browser login (${title}): ${parsed.flag} ${parsed.value} — log in in the browser that opens (up to ${LOGIN_TIMEOUT_MS / 60_000} min)`,
          );
          const run = await mcpAuth([
            '--service-key',
            keyFile,
            '--output',
            output,
            '--type',
            'abap',
            parsed.flag,
            parsed.value,
          ]);
          log.info(
            `browser login (${title}): exit ${run.status}${run.signal ? ` (${run.signal})` : ''}; stdout ${Buffer.byteLength(run.stdout)} bytes, stderr ${Buffer.byteLength(run.stderr)} bytes`,
          );

          const secret = clientSecretOf(keyFile);
          const written = fs.existsSync(output) ? readEnvValues(output) : {};
          const secrets = [
            written.SAP_JWT_TOKEN,
            written.SAP_REFRESH_TOKEN,
            secret,
          ].filter((value): value is string => !!value);
          const holdsSecret = (text: string): boolean =>
            secrets.some((value) => text.includes(value));

          if (run.status !== 0) {
            const said = run.stderr
              .split('\n')
              .filter((line) => line.includes('❌'))
              .join(' | ');
            const safe = !holdsSecret(said) && jwtFree(said);
            throw new Error(
              `mcp-auth: exit ${run.status}${run.signal ? ` (${run.signal})` : ''} — ${
                safe
                  ? said || 'no ❌ line'
                  : 'output withheld: it holds a secret or a token'
              }`,
            );
          }
          expect(run.stdout === '').toBe(true);
          expect(holdsSecret(run.stderr)).toBe(false);
          expect(jwtFree(run.stderr)).toBe(true);

          for (const name of [
            'SAP_JWT_TOKEN',
            'SAP_REFRESH_TOKEN',
            'SAP_ISSUED_FOR',
            'SAP_ISSUED_BY',
          ]) {
            expect({ [name]: !!written[name] }).toEqual({ [name]: true });
          }
          log.info(
            `browser login (${title}): token ${written.SAP_JWT_TOKEN?.length} chars, refresh token ${written.SAP_REFRESH_TOKEN?.length} chars`,
          );

          // The jwt case's check, on a copy: the CLI's file is left as written.
          const sessionsDir = path.join(work, 'sessions');
          fs.mkdirSync(sessionsDir);
          fs.copyFileSync(output, path.join(sessionsDir, `${destination}.env`));
          await expectRefusedTokenRenewed({
            sessionsDir,
            serviceKeysDir: keysDir,
            destination,
            label: `browser login (${title})`,
          });
        },
        CASE_TIMEOUT_MS,
      );
    }
  },
);
