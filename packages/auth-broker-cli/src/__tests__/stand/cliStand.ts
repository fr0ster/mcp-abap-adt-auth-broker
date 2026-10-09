/**
 * What the CLI's stand suites share: the built `mcp-auth` bin run as a child
 * process, the fake browser it is given, and a recording proxy in front of
 * the stand's UAA.
 *
 * - **The bin** is the package's `dist` (`npm run test:stand` builds it
 *   first). It runs under `node` with an environment of its own: `PATH` is an
 *   empty directory, so no browser or URL launcher (`xdg-open`, …) can be
 *   found by name, `HOME` and `TMPDIR` are the test's directory.
 * - **The fake browser** is a node script this module writes, given to the
 *   bin by absolute path (`--browser-program`). It receives the URL as its
 *   argument, hands it to the test over a loopback HTTP inbox and exits; the
 *   test then plays the user on the stand's pages with the library's
 *   `formLogin` (`packages/auth-broker/tests/stand/formLogin.ts`, shared, not
 *   copied) and brings the redirect to the CLI's callback, as a browser
 *   would — or holds the URL without answering.
 * - **The proxy** forwards every request to UAA unchanged but for `Host`,
 *   so UAA builds its own pages and redirects; it records each token request
 *   (its grant and whether it carried a `code_verifier`, never a value), so
 *   a suite can say what the stand's token endpoint saw.
 *
 * Nothing here prints a token, a refresh token or a file's contents.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { authorizeByForm } from '../../../../auth-broker/tests/stand/formLogin';

export const UAA_URL = process.env.UAA_URL?.replace(/\/+$/, '');
export const KEYCLOAK_URL = process.env.KEYCLOAK_URL?.replace(/\/+$/, '');

/** The stand's user, a committed fixture. */
export const USER = { username: 'tester', password: 'tester' };

/** auth-providers' DEFAULT_CALLBACK_PORT: where `mcp-auth` listens by default. */
export const CALLBACK_PORT = 61001;

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
export const BIN = path.join(PACKAGE_ROOT, 'dist', 'mcp-auth.js');

/**
 * Run `body`, or skip it with the reason in its title: the suites say where
 * they run (the stand's URLs set, on Linux — `--browser-program` runs a
 * program by path only there).
 */
export function describeWhere(
  title: string,
  unavailable: string | null,
  body: () => void,
): void {
  if (unavailable) {
    describe.skip(`${title} — skipped: ${unavailable}`, body);
  } else {
    describe(title, body);
  }
}

/** Why these suites cannot run here, or `null`. */
export function standUnavailable(needs: {
  uaa?: boolean;
  keycloak?: boolean;
}): string | null {
  if (needs.uaa && !UAA_URL) {
    return 'UAA_URL is not set: run `npm run test:stand`, which starts the stand in Docker';
  }
  if (needs.keycloak && !KEYCLOAK_URL) {
    return 'KEYCLOAK_URL is not set: run `npm run test:stand`, which starts the stand in Docker';
  }
  if (process.platform !== 'linux') {
    return `--browser-program runs a program by path on linux only, not ${process.platform}`;
  }
  return null;
}

export function requireBuiltBin(): void {
  if (!fs.statSync(BIN, { throwIfNoEntry: false })) {
    throw new Error(`${BIN} is missing: run npm run build first`);
  }
}

/** The URLs the fake browser was handed, in order, and a wait for the next. */
export interface Inbox {
  readonly url: string;
  readonly received: string[];
  next(): Promise<string>;
  close(): Promise<void>;
}

/** A loopback HTTP endpoint the fake browser posts each URL it is given to. */
export async function startInbox(): Promise<Inbox> {
  const received: string[] = [];
  let waiting: ((url: string) => void) | undefined;
  let taken = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(body);
      res.end('ok');
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        taken += 1;
        resolve(body);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    received,
    next: () => {
      if (received.length > taken) {
        const url = received[taken] as string;
        taken += 1;
        return Promise.resolve(url);
      }
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Writes the fake browser into `dir`: a node script (its interpreter by
 * absolute path, so it needs no `PATH`) that posts its one argument — the
 * URL — to the inbox `FAKE_BROWSER_INBOX` names, and exits.
 */
export function writeFakeBrowser(dir: string): string {
  const file = path.join(dir, 'fake-browser');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
// The stand suites' fake browser: hands the URL to the test, opens nothing.
const http = require('node:http');
const request = http.request(process.env.FAKE_BROWSER_INBOX, { method: 'POST' }, (response) => {
  response.resume();
  response.on('end', () => process.exit(0));
});
request.on('error', () => process.exit(1));
request.end(process.argv[2] ?? '');
`,
    { mode: 0o755 },
  );
  return file;
}

/** One run of the bin: its streams as they grow, its end. */
export interface CliRun {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the first stderr line `match` accepts; rejects if the run ends first. */
  stderrLine(match: (line: string) => boolean): Promise<string>;
  /** Writes one line to the run's stdin (a run started with `stdin: true`). */
  answer(line: string): void;
  readonly ended: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Runs the built bin with `args` in `cwd`. `PATH` is `emptyPath` — a
 * directory holding nothing — `HOME` and `TMPDIR` the test's own; `env` adds
 * to that. stdin is a pipe only when `stdin` is asked for.
 */
export function runCli(
  args: string[],
  {
    cwd,
    emptyPath,
    env = {},
    stdin = false,
  }: {
    cwd: string;
    emptyPath: string;
    env?: Record<string, string>;
    stdin?: boolean;
  },
): CliRun {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { PATH: emptyPath, HOME: cwd, TMPDIR: cwd, ...env },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const watchers: Array<() => void> = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
    for (const watcher of [...watchers]) watcher();
  });
  const ended = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        for (const watcher of [...watchers]) watcher();
        resolve({ code, signal });
      });
    },
  );
  const lines = () => stderr.split('\n').map((line) => line.trim());
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    ended,
    answer: (line) => {
      child.stdin?.write(`${line}\n`);
    },
    stderrLine: (match) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = lines().find(match);
          if (found !== undefined) {
            watchers.splice(watchers.indexOf(check), 1);
            resolve(found);
          } else if (child.exitCode !== null || child.signalCode !== null) {
            watchers.splice(watchers.indexOf(check), 1);
            reject(
              new Error(
                `the run ended (${child.exitCode ?? child.signalCode}) before the line was written`,
              ),
            );
          }
        };
        watchers.push(check);
        check();
      }),
  };
}

/**
 * `waited`, or a rejection once `run` ends first — so a run that fails before
 * it opens the browser or prompts fails the case at once, saying so.
 */
export function whileRunning<T>(run: CliRun, waited: Promise<T>): Promise<T> {
  return Promise.race([
    waited,
    run.ended.then(({ code, signal }) => {
      throw new Error(`the run ended (${code ?? signal}) first`);
    }),
  ]);
}

/**
 * Plays the user on an authorization URL the CLI built: logs in on the
 * stand's form (formLogin), then brings the redirect — code and `state` — to
 * the CLI's callback, as the browser would.
 */
export async function playLogin(authorizationUrl: string): Promise<void> {
  const redirectUri = new URL(authorizationUrl).searchParams.get(
    'redirect_uri',
  );
  if (!redirectUri)
    throw new Error('the authorization URL has no redirect_uri');
  const back = await authorizeByForm(authorizationUrl, redirectUri, USER);
  const response = await fetch(back);
  await response.text();
}

/** A token request the proxy forwarded: its grant, never a value. */
export interface SeenTokenRequest {
  grantType: string | null;
  codeVerifier: boolean;
}

/** A recording proxy in front of UAA. */
export interface UaaProxy {
  /** The proxy's URL, with UAA's path: what a service key names. */
  readonly url: string;
  readonly tokenRequests: SeenTokenRequest[];
  close(): Promise<void>;
}

/** Starts a loopback proxy to `uaaUrl` that records every token request. */
export async function startUaaProxy(uaaUrl: string): Promise<UaaProxy> {
  const upstream = new URL(uaaUrl);
  const tokenRequests: SeenTokenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const target = req.url ?? '/';
      if (target.split('?')[0]?.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body.toString('utf8'));
        tokenRequests.push({
          grantType: form.get('grant_type'),
          codeVerifier: form.has('code_verifier'),
        });
      }
      const forwarded = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: req.method,
          path: target,
          headers: { ...req.headers, host: upstream.host },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      forwarded.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      forwarded.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${upstream.pathname.replace(/\/+$/, '')}`,
    tokenRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Binds `port` on both loopback addresses the CLI's listener uses, then
 * frees it: a released port is proved by binding it, never by a log line.
 * `::1` is skipped on a host without IPv6 loopback, as the listener skips it.
 */
export async function bindsPort(port: number): Promise<void> {
  for (const host of ['127.0.0.1', '::1']) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        host === '::1' &&
        (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')
      ) {
        continue;
      }
      throw error;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Every `KEY=value` of a `.env` file, quotes removed. */
export function envKeys(file: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1);
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === "'" || quote === '"' || quote === '`') &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    keys[line.slice(0, eq)] = value;
  }
  return keys;
}

/**
 * stdout empty — it carries only help and `--version` — and none of
 * `secrets` on either stream. Says which stream held one, never the value.
 */
export function expectQuietStreams(run: CliRun, secrets: string[]): void {
  expect(run.stdout()).toBe('');
  secrets.forEach((secret, index) => {
    expect(secret.length).toBeGreaterThan(0);
    const where = [
      run.stdout().includes(secret) ? 'stdout' : '',
      run.stderr().includes(secret) ? 'stderr' : '',
    ].filter(Boolean);
    expect({ secret: index, where }).toEqual({ secret: index, where: [] });
  });
}
