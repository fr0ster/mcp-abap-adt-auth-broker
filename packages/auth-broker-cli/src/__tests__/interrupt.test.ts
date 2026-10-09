/**
 * §10.4, D18: a login ends only when the user ends it.
 *
 * - One interrupt per run: `SIGINT` / `SIGTERM` abort the run's controller,
 *   whose signal every wait of the run takes; the run settles `aborted`, the
 *   command prints "the authorization was aborted" — no stack trace — removes
 *   its work directory, writes no output and exits 130 / 143.
 * - A second signal exits at once, the work directory removed; `SIGHUP` exits
 *   129 at once, as 2.x did.
 * - After the run every listener it added is gone.
 * - No bound: a login nobody ends keeps waiting, its port held.
 *
 * The bin cases spawn the package's own built `mcp-auth` under `node` and
 * signal ITS pid — never this process. Every child still alive after a case
 * is killed by its pid. The work directory lives under the child's `TMPDIR`,
 * a directory of the test's own, so "removed" is that directory empty.
 *
 * `generate-env` is a development script compiled into no bin: it runs in
 * process, under the same interrupt, its signals emitted by a host of the
 * test's own (a signal to this process would end the test run).
 */

// A terminal that shows the question on stderr and never answers it: a paste
// waits until its signal abandons the read (which closes the interface).
jest.mock('node:readline', () => ({
  createInterface: () => {
    const onClose: Array<() => void> = [];
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (prompt: string) => {
        process.stderr.write(prompt);
      },
      close: () => {
        for (const listener of onClose.splice(0)) listener();
      },
    };
  },
}));

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import { browserCallbackStrategy } from '@mcp-abap-adt/auth-providers';
import type { IAuthorizationStrategy } from '@mcp-abap-adt/interfaces-auth';
import { generateEnvStrategy, runGenerateEnv } from '../generateEnv';
import { type InterruptHost, underInterrupt } from '../interrupt';
import {
  buildOidcBrowserAuthorization,
  buildPasscodeAuthorization,
  buildSamlAuthorization,
  type McpSsoOptions,
} from '../mcpSsoConfig';
import { authCodeStrategy, type McpAuthOptions } from '../runMcpAuth';
import { isUsageError } from '../subcommandArgs';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'dist', 'mcp-auth.js');
/** The generate-env script, run as `npm run generate-env` runs it: through tsx. */
const SCRIPT = path.join(
  PACKAGE_ROOT,
  'src',
  'generate-env-from-service-key.ts',
);
/** The script has no `--redirect-port`: its callback is the strategy's default. */
const DEFAULT_CALLBACK_PORT = 61001;
const IDP_CERT = path.join(__dirname, 'fixtures', 'certificates', 'server.crt');

const ABORTED = '❌ the authorization was aborted';
const STACK = '\n    at ';
const UNTOUCHED = 'UNTOUCHED-OUTPUT-MARKER\n';

let root: string;
let children: ChildProcess[];
let servers: http.Server[];

beforeAll(() => {
  if (!fs.statSync(BIN, { throwIfNoEntry: false })) {
    throw new Error(`${BIN} is missing: run npm run build first`);
  }
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-interrupt-'));
  children = [];
  servers = [];
});

afterEach(async () => {
  for (const child of children) {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      process.kill(child.pid, 'SIGKILL');
    }
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A port no one listens on. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Binds `port` on every address and releases it: resolves `true` when it
 * could be bound, `false` when someone still holds it.
 */
async function canBind(port: number): Promise<boolean> {
  const probe = net.createServer();
  const bound = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, () => resolve(true));
  });
  if (bound) await new Promise<void>((resolve) => probe.close(() => resolve()));
  return bound;
}

/** Yields to the event loop until `check` holds; the test's timeout bounds it. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * A token server that never grants: a device authorization at `/device`
 * (poll every second), and `authorization_pending` for every token request.
 */
async function pendingServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(req.url?.startsWith('/device') ? 200 : 400, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify(
          req.url?.startsWith('/device')
            ? {
                device_code: 'device-code',
                user_code: 'USER-CODE',
                verification_uri: 'https://verify.example.com',
                interval: 1,
                expires_in: 3600,
              }
            : { error: 'authorization_pending' },
        ),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** What a spawned command runs: node's arguments before the command's, and where. */
interface Entry {
  nodeArgs: string[];
  cwd: string;
}

/**
 * Runs `entry` — the built bin, unless stated — under `node`, its `TMPDIR`
 * the test's `tmp`, its stdin a pipe left open (a paste waits on it). Once
 * `waiting` sees the login wait on stderr, sends `signals` to the child's
 * pid, one after the other.
 */
function runUntilSignalled(
  args: string[],
  waiting: (stderr: string) => boolean,
  signals: NodeJS.Signals[],
  tmp: string,
  entry?: Entry,
): Promise<Exit> {
  const { nodeArgs, cwd } = entry ?? { nodeArgs: [BIN], cwd: root };
  const child = spawn(process.execPath, [...nodeArgs, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  let sent = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (!sent && waiting(stderr) && child.pid !== undefined) {
      sent = true;
      for (const signal of signals) process.kill(child.pid, signal);
    }
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

interface LoginKind {
  name: string;
  /** The command line, given the callback port and the token server. */
  args: (port: number, server: string) => string[];
  /** The login waits: its prompt is on stderr. */
  waiting: string;
  /** Whether the login holds the callback port while it waits. */
  listens: boolean;
}

const SAML = (port: number) => [
  'saml2-pure',
  '--idp-sso-url',
  'https://idp.example.com/sso',
  '--sp-entity-id',
  'my-sp',
  '--idp-cert',
  IDP_CERT,
  '--idp-entity-id',
  'https://idp.example.com',
  '--service-url',
  'https://abap.example.com',
  '--redirect-port',
  String(port),
];

const KINDS: LoginKind[] = [
  {
    name: 'mcp-auth browser login',
    args: (port, server) => [
      '--service-key',
      serviceKey(server),
      '--browser',
      'none',
      '--redirect-port',
      String(port),
    ],
    waiting: '/oauth/authorize?',
    listens: true,
  },
  {
    name: 'mcp-auth oidc browser',
    args: (port, server) => [
      'oidc',
      '--flow',
      'browser',
      '--authorization-endpoint',
      `${server}/authorize`,
      '--token-endpoint',
      `${server}/token`,
      '--client-id',
      'cli',
      '--service-url',
      'https://abap.example.com',
      '--browser',
      'none',
      '--redirect-port',
      String(port),
    ],
    waiting: '/authorize?',
    listens: true,
  },
  {
    name: 'mcp-auth saml2-pure browser',
    args: (port) => [...SAML(port), '--browser', 'none'],
    waiting: 'SAMLRequest=',
    listens: true,
  },
  {
    name: 'mcp-auth saml2-pure manual SAML paste',
    args: (port) => [
      ...SAML(port),
      '--assertion-flow',
      'manual',
      '--acs-url',
      'https://acs.example.com/saml/acs',
    ],
    waiting: 'Paste the SAMLResponse',
    listens: false,
  },
  {
    name: 'mcp-auth oidc passcode paste',
    args: (_port, server) => [
      'oidc',
      '--flow',
      'password',
      '--uaa-url',
      server,
      '--client-id',
      'cli',
      '--client-secret',
      'client-secret',
      '--service-url',
      'https://abap.example.com',
    ],
    waiting: 'Paste the Temporary Authentication Code',
    listens: false,
  },
  {
    name: 'mcp-auth oidc device code',
    args: (_port, server) => [
      'oidc',
      '--flow',
      'device',
      '--device-authorization-endpoint',
      `${server}/device`,
      '--token-endpoint',
      `${server}/token`,
      '--client-id',
      'cli',
      '--service-url',
      'https://abap.example.com',
    ],
    waiting: 'USER-CODE',
    listens: false,
  },
];

/** An ABAP-format service key for `server`'s UAA. */
function serviceKey(server: string): string {
  const file = path.join(root, 'TRIAL.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: { url: server, clientid: 'key-client', clientsecret: 'secret' },
      abap: { url: 'https://abap.example.com' },
    }),
  );
  return file;
}

describe('the built bin: a signal to its pid ends the waiting login', () => {
  for (const kind of KINDS) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      it(`${kind.name}, ${signal}: aborted, exit ${EXIT_CODES[signal]}, no stack, port free, work directory gone, output untouched`, async () => {
        const server = await pendingServer();
        const port = await freePort();
        const tmp = path.join(root, 'tmp');
        fs.mkdirSync(tmp);
        const output = path.join(root, 'out', 'TRIAL.env');
        fs.mkdirSync(path.dirname(output));
        fs.writeFileSync(output, UNTOUCHED);
        const exit = await runUntilSignalled(
          [...kind.args(port, server), '--output', output],
          (stderr) => stderr.includes(kind.waiting),
          [signal],
          tmp,
        );
        expect(exit.signal).toBeNull();
        expect(exit.code).toBe(EXIT_CODES[signal]);
        expect(exit.stderr).toContain(ABORTED);
        expect(exit.stderr).not.toContain(STACK);
        expect(exit.stdout).toBe('');
        // After the child's exit the OS has freed its sockets whatever the
        // strategy did: this proves the process ended, no more. That the
        // strategy releases the port as its login settles — the process
        // still alive — is proven in process: the strategies' cases and
        // generate-env's, each binding once right after the abort settled.
        if (kind.listens) expect(await canBind(port)).toBe(true);
        expect(fs.readdirSync(tmp)).toEqual([]);
        expect(fs.readFileSync(output, 'utf8')).toBe(UNTOUCHED);
      }, 20_000);
    }
  }
});

describe('the built bin: a signal ends a stalled SAML metadata fetch', () => {
  /**
   * A metadata server that stalls: never answering the headers, or sending
   * them and a first chunk of the body and then nothing. Once it has done
   * that much, `signal` goes to the child's pid.
   */
  async function stallingServer(
    stall: 'headers' | 'body',
    deliver: () => void,
  ): Promise<string> {
    const server = http.createServer((_req, res) => {
      if (stall === 'body') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.write('<md:EntityDescriptor');
      }
      deliver();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  for (const stall of ['headers', 'body'] as const) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      it(`stalled ${stall}, ${signal}: aborted, exit ${EXIT_CODES[signal]}, no stack, work directory gone, output untouched`, async () => {
        const tmp = path.join(root, 'tmp');
        fs.mkdirSync(tmp);
        const output = path.join(root, 'out', 'TRIAL.env');
        fs.mkdirSync(path.dirname(output));
        fs.writeFileSync(output, UNTOUCHED);
        let child: ChildProcess | undefined;
        const metadata = await stallingServer(stall, () => {
          if (child?.pid !== undefined) process.kill(child.pid, signal);
        });
        child = spawn(
          process.execPath,
          [
            BIN,
            'saml2-pure',
            '--idp-metadata',
            `${metadata}/saml2/metadata`,
            '--assertion-flow',
            'manual',
            '--acs-url',
            'https://acs.example.com/saml/acs',
            '--sp-entity-id',
            'my-sp',
            '--service-url',
            'https://abap.example.com',
            '--output',
            output,
          ],
          {
            cwd: root,
            env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: tmp },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        children.push(child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        const exit = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          child?.on('error', reject);
          child?.on('close', (code, killed) =>
            resolve({ code, signal: killed }),
          );
        });
        expect(exit.signal).toBeNull();
        expect(exit.code).toBe(EXIT_CODES[signal]);
        expect(stderr).toContain(ABORTED);
        expect(stderr).not.toContain(STACK);
        expect(stderr).not.toContain('SAML metadata');
        expect(stdout).toBe('');
        expect(fs.readdirSync(tmp)).toEqual([]);
        expect(fs.readFileSync(output, 'utf8')).toBe(UNTOUCHED);
      }, 20_000);
    }
  }
});

describe('the generate-env script itself: a signal to its pid ends the waiting login', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal}: aborted, exit ${EXIT_CODES[signal]}, no stack, port free, its work directory gone, the session file untouched`, async () => {
      // The script binds the strategy's default port: it must be free.
      expect(await canBind(DEFAULT_CALLBACK_PORT)).toBe(true);
      const server = await pendingServer();
      const tmp = path.join(root, 'tmp');
      fs.mkdirSync(tmp);
      const sessionPath = path.join(root, 'sessions', 'TRIAL.env');
      fs.mkdirSync(path.dirname(sessionPath));
      fs.writeFileSync(sessionPath, UNTOUCHED);
      const workDirs = () =>
        fs.readdirSync(tmp).filter((name) => name.startsWith('generate-env-'));
      let workDirsWhileWaiting: string[] = [];
      const exit = await runUntilSignalled(
        [
          'TRIAL',
          serviceKey(server),
          sessionPath,
          '--grant',
          'authorization_code',
          '--browser',
          'none',
        ],
        (stderr) => {
          if (!stderr.includes('/oauth/authorize?')) return false;
          workDirsWhileWaiting = workDirs();
          return true;
        },
        [signal],
        tmp,
        { nodeArgs: ['--import', 'tsx', SCRIPT], cwd: PACKAGE_ROOT },
      );
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(EXIT_CODES[signal]);
      expect(exit.stderr).toContain(ABORTED);
      expect(exit.stderr).not.toContain(STACK);
      expect(exit.stdout).toBe('');
      expect(await canBind(DEFAULT_CALLBACK_PORT)).toBe(true);
      // Its work directory existed while the login waited, and is gone.
      expect(workDirsWhileWaiting).toHaveLength(1);
      expect(workDirs()).toEqual([]);
      expect(fs.readFileSync(sessionPath, 'utf8')).toBe(UNTOUCHED);
    }, 30_000);
  }
});

/**
 * Whether a login's rejection says it was aborted: auth-errors' `aborted`,
 * or — the IdP-initiated paste, the CLI's own strategy — the reader's
 * "abandoned" refusal.
 */
function endedByAbort(error: unknown): boolean {
  if (isUsageError(error)) {
    return String((error as Error).message).includes('the read was aborted');
  }
  const failure = readFailure(error, 'authorizing');
  return (
    failure.kind === 'interactive-login' &&
    (failure.facts as { outcome?: string }).outcome === 'aborted'
  );
}

interface BuiltStrategy {
  name: string;
  build: (port: number, signal: AbortSignal) => IAuthorizationStrategy<unknown>;
  /** The port it listens on, or `undefined` for a paste. */
  port: (free: number) => number | undefined;
  /** The login waits: its prompt is on stderr. */
  waiting: string;
}

const AUTH_CODE_OPTIONS: McpAuthOptions = {
  outputFile: 'unused.env',
  authType: 'xsuaa',
  browser: 'none',
  credential: false,
  format: 'env',
};
const SSO_OPTIONS = { authType: 'abap', format: 'env' } as McpSsoOptions;
const SAML_OPTIONS = {
  ...SSO_OPTIONS,
  protocol: 'saml2',
  flow: 'pure',
  browser: 'none',
} as McpSsoOptions;
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';

const STRATEGIES: BuiltStrategy[] = [
  {
    name: 'mcp-auth browser login (authCodeStrategy)',
    build: (port, signal) =>
      authCodeStrategy({ ...AUTH_CODE_OPTIONS, redirectPort: port }, signal),
    port: (free) => free,
    waiting: 'https://idp.example.com/authorize?',
  },
  {
    name: 'generate-env browser login (generateEnvStrategy)',
    build: (_port, signal) => generateEnvStrategy(undefined, signal),
    port: () => DEFAULT_CALLBACK_PORT,
    waiting: 'https://idp.example.com/authorize?',
  },
  {
    name: 'oidc browser',
    build: (port, signal) =>
      buildOidcBrowserAuthorization(
        {
          ...SSO_OPTIONS,
          protocol: 'oidc',
          flow: 'browser',
          browser: 'none',
          redirectPort: port,
        } as McpSsoOptions,
        signal,
      ),
    port: (free) => free,
    waiting: 'https://idp.example.com/authorize?',
  },
  {
    name: 'SAML browser',
    build: (port, signal) =>
      buildSamlAuthorization({ ...SAML_OPTIONS, redirectPort: port }, signal),
    port: (free) => free,
    waiting: 'https://idp.example.com/authorize?',
  },
  {
    name: 'manual SAML paste',
    build: (_port, signal) =>
      buildSamlAuthorization(
        { ...SAML_OPTIONS, assertionFlow: 'manual', acsUrl: ACS },
        signal,
      ),
    port: () => undefined,
    waiting: 'Paste the SAMLResponse',
  },
  {
    name: 'IdP-initiated SAML paste',
    build: (_port, signal) =>
      buildSamlAuthorization(
        {
          ...SAML_OPTIONS,
          flow: 'bearer',
          idpInitiated: true,
          assertionFlow: 'manual',
          acsUrl: ACS,
        },
        signal,
      ),
    port: () => undefined,
    waiting: 'paste the SAMLResponse',
  },
  {
    name: 'passcode paste',
    build: (_port, signal) =>
      buildPasscodeAuthorization(
        { ...SSO_OPTIONS, protocol: 'oidc', flow: 'password' } as McpSsoOptions,
        signal,
      ),
    port: () => undefined,
    waiting: 'Paste the Temporary Authentication Code',
  },
];

describe('each strategy the CLI builds ends on the run’s signal alone', () => {
  // The request's own signal never aborts: no provider stands between the
  // run and the strategy, so only the strategy's `signal` option ends it.
  for (const built of STRATEGIES) {
    it(`${built.name}: the run's signal ends it aborted, its port released before it settled`, async () => {
      const port = built.port(await freePort());
      if (port !== undefined) expect(await canBind(port)).toBe(true);
      const run = new AbortController();
      const stderr = captureStderr();
      let error: unknown;
      try {
        const authorizing = built.build(port ?? 0, run.signal).authorize({
          // A code login's URL must carry `state` and an S256 challenge.
          buildAuthorizationUrl: async (redirectUri) =>
            `https://idp.example.com/authorize?${new URLSearchParams({
              response_type: 'code',
              client_id: 'cli',
              redirect_uri: redirectUri,
              state: 'state-0123456789abcdef0123456789abcdef',
              code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
              code_challenge_method: 'S256',
            })}`,
          signal: new AbortController().signal,
        });
        let done = false;
        const settled = authorizing.then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        void settled.finally(() => {
          done = true;
        });
        await until(() => done || stderr.text().includes(built.waiting));
        // Still waiting when the run aborts: it settled on nothing else.
        expect(done).toBe(false);
        if (port !== undefined) expect(await canBind(port)).toBe(false);
        run.abort();
        error = await settled;
        // Bound once, right after the login settled.
        if (port !== undefined) expect(await canBind(port)).toBe(true);
      } finally {
        // A case that failed leaves no login behind.
        run.abort();
        stderr.restore();
      }
      expect(error).toBeDefined();
      expect(endedByAbort(error)).toBe(true);
    }, 20_000);
  }
});

/** A host of the test's own: signals are events it emits, `exit` recorded. */
function fakeHost() {
  const emitter = new EventEmitter();
  const exits: Array<{ code: number; workDirLeft: boolean }> = [];
  let workDir: string | undefined;
  const host: InterruptHost = {
    on: (signal, listener) => emitter.on(signal, listener),
    removeListener: (signal, listener) =>
      emitter.removeListener(signal, listener),
    exit: (code) => {
      exits.push({
        code,
        workDirLeft: workDir !== undefined && fs.existsSync(workDir),
      });
    },
  };
  return {
    host,
    emitter,
    exits,
    setWorkDir: (dir: string) => {
      workDir = dir;
    },
  };
}

/** Everything written to stderr (console.error and direct writes), captured. */
function captureStderr() {
  const written: string[] = [];
  const spies = [
    jest.spyOn(console, 'error').mockImplementation((...a) => {
      written.push(`${a.join(' ')}\n`);
    }),
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    }),
  ];
  return {
    text: () => written.join(''),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe('the interrupt, in process', () => {
  const COUNTED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
  const counts = () => COUNTED.map((event) => process.listenerCount(event));

  it('adds its listeners for the run and removes every one afterwards, whether the run resolves or throws', async () => {
    const before = counts();
    let during: number[] = [];
    await expect(
      underInterrupt('interrupt-test', async () => {
        during = counts();
        return 0;
      }),
    ).resolves.toBe(0);
    expect(during).toEqual(before.map((count) => count + 1));
    expect(counts()).toEqual(before);
    const thrown = new Error('the run failed');
    await expect(
      underInterrupt('interrupt-test', async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(counts()).toEqual(before);
  });

  it('the run gets a private work directory, removed when the run ends', async () => {
    let dir = '';
    await underInterrupt('interrupt-test', async ({ workDir }) => {
      dir = workDir;
      expect(fs.statSync(workDir).mode & 0o777).toBe(0o700);
      return 0;
    });
    expect(dir).not.toBe('');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    '%s aborts the run’s signal; once the run settles: aborted, exit %i, the work directory removed',
    async (signal, code) => {
      const { host, emitter, exits } = fakeHost();
      const stderr = captureStderr();
      let dir = '';
      let exitCode: number;
      try {
        exitCode = await underInterrupt(
          'interrupt-test',
          ({ signal: runSignal, workDir }) => {
            dir = workDir;
            return new Promise<number>((_resolve, reject) => {
              runSignal.addEventListener('abort', () =>
                reject(new Error('a foreign message')),
              );
              emitter.emit(signal);
            });
          },
          host,
        );
      } finally {
        stderr.restore();
      }
      expect(exitCode).toBe(code);
      expect(exits).toEqual([]);
      expect(stderr.text()).toContain(ABORTED);
      expect(stderr.text()).not.toContain('a foreign message');
      expect(stderr.text()).not.toContain(STACK);
      expect(fs.existsSync(dir)).toBe(false);
      expect(emitter.listenerCount('SIGINT')).toBe(0);
      expect(emitter.listenerCount('SIGTERM')).toBe(0);
      expect(emitter.listenerCount('SIGHUP')).toBe(0);
    },
  );

  it('a second signal exits at once, the work directory removed before the exit', async () => {
    const { host, emitter, exits, setWorkDir } = fakeHost();
    let release: (code: number) => void = () => undefined;
    const stderr = captureStderr();
    let run: Promise<number>;
    try {
      run = underInterrupt(
        'interrupt-test',
        ({ workDir }) => {
          setWorkDir(workDir);
          // A login that ignores the abort: only a second signal ends it.
          return new Promise<number>((resolve) => {
            release = resolve;
          });
        },
        host,
      );
      await until(() => emitter.listenerCount('SIGINT') > 0);
      emitter.emit('SIGINT');
      expect(exits).toEqual([]);
      emitter.emit('SIGTERM');
      expect(exits).toEqual([{ code: 143, workDirLeft: false }]);
      release(0);
      await run;
    } finally {
      stderr.restore();
    }
  });

  it('SIGHUP exits 129 at once, the work directory removed before the exit', async () => {
    const { host, emitter, exits, setWorkDir } = fakeHost();
    let release: (code: number) => void = () => undefined;
    const run = underInterrupt(
      'interrupt-test',
      ({ workDir }) => {
        setWorkDir(workDir);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      host,
    );
    await until(() => emitter.listenerCount('SIGHUP') > 0);
    emitter.emit('SIGHUP');
    expect(exits).toEqual([{ code: 129, workDirLeft: false }]);
    release(0);
    await run;
  });
});

describe('generate-env under the interrupt, in process', () => {
  /** A key, a session file holding `UNTOUCHED`, and the script's arguments. */
  function generateEnvRun(port: number, server: string) {
    const sessionPath = path.join(root, 'sessions', 'TRIAL.env');
    fs.mkdirSync(path.dirname(sessionPath));
    fs.writeFileSync(sessionPath, UNTOUCHED);
    const args = [
      'TRIAL',
      serviceKey(server),
      sessionPath,
      '--grant',
      'authorization_code',
      '--browser',
      'none',
    ];
    return {
      sessionPath,
      run: (host: InterruptHost) =>
        underInterrupt(
          'generate-env',
          ({ signal, workDir }) =>
            runGenerateEnv(args, {
              workDir,
              signal,
              authorization: (browser, loginSignal) =>
                browserCallbackStrategy({ browser, port, signal: loginSignal }),
            }),
          host,
        ),
    };
  }

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    '%s while the browser login waits: aborted, exit %i, port free, session file untouched',
    async (signal, code) => {
      const server = await pendingServer();
      const port = await freePort();
      const { host, emitter } = fakeHost();
      const { sessionPath, run } = generateEnvRun(port, server);
      const stderr = captureStderr();
      let exitCode: number;
      try {
        const running = run(host);
        await until(() => stderr.text().includes('/oauth/authorize?'));
        expect(await canBind(port)).toBe(false);
        emitter.emit(signal);
        exitCode = await running;
        // Bound once, the run just settled and this process alive: the
        // strategy released its socket before its login settled.
        expect(await canBind(port)).toBe(true);
      } finally {
        stderr.restore();
      }
      expect(exitCode).toBe(code);
      expect(stderr.text()).toContain(ABORTED);
      expect(stderr.text()).not.toContain(STACK);
      expect(fs.readFileSync(sessionPath, 'utf8')).toBe(UNTOUCHED);
    },
    20_000,
  );

  it('no bound: past 300 s the login still waits, its port held; the user then ends it', async () => {
    const server = await pendingServer();
    const port = await freePort();
    const { host, emitter } = fakeHost();
    const { sessionPath, run } = generateEnvRun(port, server);
    const stderr = captureStderr();
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    let exitCode: number;
    try {
      let settled = false;
      const running = run(host).finally(() => {
        settled = true;
      });
      await until(() => stderr.text().includes('/oauth/authorize?'));
      jest.advanceTimersByTime(301_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(await canBind(port)).toBe(false);
      emitter.emit('SIGINT');
      exitCode = await running;
      expect(await canBind(port)).toBe(true);
    } finally {
      jest.useRealTimers();
      stderr.restore();
    }
    expect(exitCode).toBe(130);
    expect(fs.readFileSync(sessionPath, 'utf8')).toBe(UNTOUCHED);
  }, 20_000);
});

describe('sources: no timer bounds a login', () => {
  /** Every `.ts` of the CLI, tests left out. */
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : sources(file);
      }
      return entry.name.endsWith('.ts') ? [file] : [];
    });
  }

  it('the walk finds the CLI’s sources, tests left out', () => {
    const found = sources(path.join(PACKAGE_ROOT, 'src')).map((file) =>
      path.relative(PACKAGE_ROOT, file),
    );
    expect(found).toEqual(
      expect.arrayContaining(
        [
          'interrupt.ts',
          'mcp-auth.ts',
          'mcpSsoConfig.ts',
          'runMcpAuth.ts',
          'runMcpSso.ts',
          'generateEnv.ts',
          'generate-env-from-service-key.ts',
        ].map((file) => path.join('src', file)),
      ),
    );
    expect(found.some((file) => file.includes('__tests__'))).toBe(false);
  });

  it.each([
    'INTERACTIVE_LOGIN_TIMEOUT_MS',
    'AbortSignal.timeout',
    'timeoutMs',
    'setTimeout',
    'setInterval',
  ])('no source of the CLI names %s', (name) => {
    const naming = sources(path.join(PACKAGE_ROOT, 'src')).filter((file) =>
      fs.readFileSync(file, 'utf8').includes(name),
    );
    expect(naming).toEqual([]);
  });

  it.each(['mcp-auth.ts', 'generate-env-from-service-key.ts'])(
    '%s runs its login under the interrupt',
    (file) => {
      const source = fs.readFileSync(
        path.join(PACKAGE_ROOT, 'src', file),
        'utf8',
      );
      expect(source.includes('underInterrupt(')).toBe(true);
    },
  );
});
