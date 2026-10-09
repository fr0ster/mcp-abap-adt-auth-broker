/**
 * §10.8, D16, D19, H2: what the CLI writes where — observed on the built
 * `mcp-auth` bin, run under `node` as a user runs it, against local token
 * endpoints (nothing leaves the machine; no browser: `--browser none`, and the
 * test itself answers the callback the provider's prompt names).
 *
 * - stdout holds only what `help` and `--version` print; every run's stdout is
 *   empty.
 * - Neither stream holds a token, a refresh token, the client secret, the
 *   authorization code, a password or a marker of the server's text.
 * - `state` and the authorization URL appear on stderr only in the
 *   provider's login prompt — the one place both appear — and never in a log
 *   line, an error or a diagnostic, whatever the log level.
 *
 * `generate-env` is a development script compiled into no bin: it is run in
 * process, its stdout and stderr captured the same way.
 *
 * The bin is the package's `dist`: `npm run build` first. A `dist` older than
 * the sources it is built from fails here, rather than testing stale code.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticCodeStrategy } from '@mcp-abap-adt/auth-providers';
import { runGenerateEnv } from '../generateEnv';
import { readEnvKeys } from './helpers/destinationFiles';
import { jwt, type LocalServer, startLocalServer } from './helpers/localServer';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'dist', 'mcp-auth.js');

const CLIENT_SECRET = 'CLIENT-SECRET-MARKER-7f3a';
const REFRESH = 'REFRESH-MARKER-91c2';
const ACCESS = jwt('ACCESS-MARKER-0b6e');
const CODE = 'CODE-MARKER-55e1';
const PASSWORD = 'PASSWORD-MARKER-4a90';
const SERVER_TEXT = 'SERVER-TEXT-MARKER-3d1c';
const SECRETS = [CLIENT_SECRET, REFRESH, ACCESS, CODE, PASSWORD, SERVER_TEXT];

/** What the token endpoint answers: one token, a refresh token. */
const TOKENS = {
  body: {
    access_token: ACCESS,
    refresh_token: REFRESH,
    token_type: 'bearer',
    expires_in: 3600,
  },
};

/** A refusal whose free text is the server's own. */
const REFUSAL = {
  status: 400,
  body: { error: 'invalid_grant', error_description: SERVER_TEXT },
};

/** Environment variables 2.x or a provider read; 3.0.0 reads none (D17). */
const DEBUG_ENVIRONMENT = {
  DEBUG: 'true',
  DEBUG_SSO: 'true',
  DEBUG_AUTH_SSO: 'true',
  DEBUG_AUTH_PROVIDERS: 'true',
  DEBUG_BROWSER_AUTH: 'true',
  DEBUG_AUTH_BROKER: 'true',
  LOG_LEVEL: 'debug',
};

let server: LocalServer;
let root: string;
let tmp: string;
let children: ChildProcess[];

/** Every `.ts` under `dir`, tests left out, recursively. */
function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourcesUnder(file);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [file]
      : [];
  });
}

/**
 * The sources of `packageDir` whose compiled `dist` file is missing or older:
 * the bin runs the CLI's dist and the workspace-linked broker's dist.
 */
function staleSources(packageDir: string, skip: readonly string[]): string[] {
  const src = path.join(packageDir, 'src');
  return sourcesUnder(src)
    .filter((file) => !skip.includes(path.basename(file)))
    .filter((file) => {
      const output = path.join(
        packageDir,
        'dist',
        path.relative(src, file).replace(/\.ts$/, '.js'),
      );
      const built = fs.statSync(output, { throwIfNoEntry: false });
      return !built || built.mtimeMs < fs.statSync(file).mtimeMs;
    })
    .map((file) => path.relative(path.dirname(packageDir), file));
}

beforeAll(() => {
  if (!fs.statSync(BIN, { throwIfNoEntry: false })) {
    throw new Error(`${BIN} is missing: run npm run build first`);
  }
  const stale = [
    // generate-env is a development script: not built.
    ...staleSources(PACKAGE_ROOT, [
      'generateEnv.ts',
      'generate-env-from-service-key.ts',
    ]),
    ...staleSources(path.join(PACKAGE_ROOT, '..', 'auth-broker'), []),
  ];
  if (stale.length > 0) {
    throw new Error(
      `dist is older than ${stale.join(', ')}: run npm run build first`,
    );
  }
});

beforeEach(async () => {
  server = await startLocalServer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-streams-'));
  tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A port no one listens on, for the callback. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** An ABAP-format service key, its client secret a marker. */
function serviceKey(name = 'TRIAL'): string {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: {
        url: server.url,
        clientid: 'key-client',
        clientsecret: CLIENT_SECRET,
      },
      abap: { url: 'https://abap.example.com' },
    }),
  );
  return file;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built bin under `node` with `args`, an environment of its own —
 * only what node needs, plus `env` — and `TMPDIR` inside the test's
 * directory. `onStderr` sees stderr as it grows (to answer a prompt).
 */
function runBin(
  args: string[],
  {
    env = {},
    onStderr,
  }: {
    env?: Record<string, string>;
    onStderr?: (soFar: string) => void;
  } = {},
): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      TMPDIR: tmp,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    onStderr?.(stderr);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Plays the browser: once the provider's prompt shows the authorization URL
 * on stderr, sends its redirect URI the code and the URL's own `state`.
 */
function answerPrompt(code: string): {
  onStderr: (soFar: string) => void;
  prompt: () => { url: string; state: string } | undefined;
} {
  let found: { url: string; state: string } | undefined;
  return {
    prompt: () => found,
    onStderr: (soFar) => {
      if (found) return;
      const line = soFar
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.includes('/oauth/authorize?'));
      if (!line) return;
      const url = new URL(line);
      const state = url.searchParams.get('state') ?? '';
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', state);
      found = { url: line, state };
      fetch(redirect).then(
        (response) => response.arrayBuffer(),
        () => undefined,
      );
    },
  };
}

/** No secret, no server text, on either stream. */
function expectNoSecrets(run: Run): void {
  for (const secret of SECRETS) {
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  }
}

/**
 * The authorization URL and `state` on stderr only in the provider's prompt:
 * one line holding the URL, and no other line holding `state` or the
 * authorization endpoint; never on stdout.
 */
function expectUrlOnlyInPrompt(
  run: Run,
  prompt: { url: string; state: string },
): void {
  expect(prompt.state).not.toBe('');
  expect(run.stdout).not.toContain(prompt.state);
  expect(run.stdout).not.toContain('/oauth/authorize');
  const lines = run.stderr.split('\n');
  const holding = lines.filter(
    (line) => line.includes(prompt.state) || line.includes('/oauth/authorize'),
  );
  expect(holding.map((line) => line.trim())).toEqual([prompt.url]);
  // The prompt is the provider's, never a log line of the CLI's logger.
  expect(holding[0]?.trimStart().startsWith('[')).toBe(false);
}

describe('stdout: only help and --version', () => {
  it.each([
    [['--help']],
    [['help']],
    [['oidc', '--help']],
    [['saml2-pure', '--help']],
    [['saml2-bearer', '--help']],
    [['auth-code', '--help']],
    [['--version']],
    [['version']],
  ])(
    'mcp-auth %j: what was asked for on stdout, nothing on stderr',
    async (args) => {
      const run = await runBin(args);
      expect(run.code).toBe(0);
      expect(run.stdout).not.toBe('');
      expect(run.stderr).toBe('');
    },
  );

  it('a usage error: words on stderr, stdout empty, exit 1', async () => {
    const run = await runBin(['--no-such-flag']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown option: --no-such-flag');
  });
});

describe('mcp-auth (authorization code), --browser none', () => {
  it('stdout empty; no secret on either stream; the URL and state only in the provider prompt', async () => {
    server.answer('/oauth/token', TOKENS);
    const output = path.join(root, 'out', 'TRIAL.env');
    const port = await freePort();
    const browser = answerPrompt(CODE);
    const run = await runBin(
      [
        '--service-key',
        serviceKey(),
        '--output',
        output,
        '--browser',
        'none',
        '--redirect-port',
        String(port),
      ],
      { onStderr: browser.onStderr },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expectNoSecrets(run);
    const prompt = browser.prompt();
    if (!prompt) throw new Error('no prompt on stderr');
    expectUrlOnlyInPrompt(run, prompt);
    // The run did what it says: the output holds the token.
    expect(readEnvKeys(output).SAP_JWT_TOKEN).toBe(ACCESS);
    // Its work directory is gone.
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("at the default level the provider's waiting line and SSH-tunnel hint reach stderr — a remote user needs them; no debug line", async () => {
    server.answer('/oauth/token', TOKENS);
    const port = await freePort();
    const browser = answerPrompt(CODE);
    const run = await runBin(
      [
        '--service-key',
        serviceKey(),
        '--output',
        path.join(root, 'out', 'TRIAL.env'),
        '--browser',
        'none',
        '--redirect-port',
        String(port),
      ],
      { onStderr: browser.onStderr },
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(
      `Waiting for callback on http://localhost:${port}/callback`,
    );
    expect(run.stderr).toContain(`ssh -L ${port}:localhost:${port}`);
    expect(run.stderr).not.toContain('[debug]');
    expectNoSecrets(run);
    const prompt = browser.prompt();
    if (!prompt) throw new Error('no prompt on stderr');
    expectUrlOnlyInPrompt(run, prompt);
  });

  it('at the default level an authorization URL that cannot be shown is said so on stderr', async () => {
    const key = path.join(root, 'TRIAL.json');
    fs.writeFileSync(
      key,
      JSON.stringify({
        uaa: {
          // Not an http(s) URL: the provider's prompt refuses to show it.
          url: 'ftp://127.0.0.1:1',
          clientid: 'key-client',
          clientsecret: CLIENT_SECRET,
        },
        abap: { url: 'https://abap.example.com' },
      }),
    );
    const port = await freePort();
    const child = { said: false };
    const run = await runBin(
      [
        '--service-key',
        key,
        '--output',
        path.join(root, 'out', 'TRIAL.env'),
        '--browser',
        'none',
        '--redirect-port',
        String(port),
      ],
      {
        onStderr: (soFar) => {
          if (
            !child.said &&
            soFar.includes('is not an http(s) URL that can be shown')
          ) {
            child.said = true;
            // The login waits for a callback no one can reach: end it.
            children.at(-1)?.kill('SIGTERM');
          }
        },
      },
    );
    expect(child.said).toBe(true);
    expect(run.stdout).toBe('');
    expectNoSecrets(run);
  });

  it('--verbose: log lines on stderr, still no secret, the URL and state only in the prompt', async () => {
    server.answer('/oauth/token', TOKENS);
    const port = await freePort();
    const browser = answerPrompt(CODE);
    const run = await runBin(
      [
        '--service-key',
        serviceKey(),
        '--output',
        path.join(root, 'out', 'TRIAL.env'),
        '--browser',
        'none',
        '--redirect-port',
        String(port),
        '--verbose',
      ],
      { onStderr: browser.onStderr },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('[debug]');
    expectNoSecrets(run);
    const prompt = browser.prompt();
    if (!prompt) throw new Error('no prompt on stderr');
    expectUrlOnlyInPrompt(run, prompt);
  });

  it('a refusal with server text: exit 1, the failure on stderr in fixed words, no marker anywhere', async () => {
    server.answer('/oauth/token', REFUSAL);
    const port = await freePort();
    const browser = answerPrompt(CODE);
    const output = path.join(root, 'out', 'TRIAL.env');
    const run = await runBin(
      [
        '--service-key',
        serviceKey(),
        '--output',
        output,
        '--browser',
        'none',
        '--redirect-port',
        String(port),
      ],
      { onStderr: browser.onStderr },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('❌');
    expectNoSecrets(run);
    // No stack trace.
    expect(run.stderr).not.toMatch(/\n\s+at /);
    expect(fs.existsSync(output)).toBe(false);
  });
});

describe('mcp-auth --credential', () => {
  it('stdout empty, no secret on either stream — with the debug environment variables set too', async () => {
    server.answer('/oauth/token', TOKENS);
    for (const env of [{}, DEBUG_ENVIRONMENT]) {
      const run = await runBin(
        [
          '--service-key',
          serviceKey(),
          '--output',
          path.join(root, 'out', 'TRIAL.env'),
          '--credential',
        ],
        { env },
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expectNoSecrets(run);
      // No variable turns the debug lines on (D17).
      expect(run.stderr).not.toContain('[debug]');
    }
  });

  it('a 400 with an error_description marker: without --auth-debug no marker on either stream', async () => {
    server.answer('/oauth/token', REFUSAL);
    const run = await runBin([
      '--service-key',
      serviceKey(),
      '--output',
      path.join(root, 'out', 'TRIAL.env'),
      '--credential',
      '--verbose',
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expectNoSecrets(run);
  });

  it("--auth-debug: the provider's sent line names the client secret in prepared form; never whole, never a token or the server text", async () => {
    server.answer('/oauth/token', REFUSAL);
    const args = [
      '--service-key',
      serviceKey(),
      '--output',
      path.join(root, 'out', 'TRIAL.env'),
      '--credential',
    ];
    // The provider's prepared form: four characters at each edge and the
    // length.
    const prepared = `${CLIENT_SECRET.slice(0, 4)}…${CLIENT_SECRET.slice(-4)} <redacted, ${CLIENT_SECRET.length} chars>`;
    const sentLines = (run: Run) =>
      run.stderr.split('\n').filter((line) => line.includes('"sent"'));

    const debugging = await runBin([...args, '--auth-debug']);
    expect(debugging.code).toBe(1);
    expect(debugging.stdout).toBe('');
    expectNoSecrets(debugging);
    const named = sentLines(debugging);
    expect(named).toHaveLength(1);
    expect(named[0]?.startsWith('[debug]')).toBe(true);
    expect(named[0]).toContain(prepared);
    // The prepared form only in that line.
    expect(
      debugging.stderr.split('\n').filter((line) => line.includes(prepared)),
    ).toEqual(named);

    // Without the flag, even at --verbose: the refusal's facts, no `sent`.
    const verbose = await runBin([...args, '--verbose']);
    expect(verbose.code).toBe(1);
    expectNoSecrets(verbose);
    expect(verbose.stderr).toContain('the token endpoint refused the request');
    expect(sentLines(verbose)).toEqual([]);
    expect(verbose.stderr).not.toContain(prepared);

    // The environment variables alone change nothing.
    const environment = await runBin([...args, '--verbose'], {
      env: DEBUG_ENVIRONMENT,
    });
    expect(environment.stderr).not.toContain(prepared);
  });

  it('--auth-debug on a success: no secret on either stream', async () => {
    server.answer('/oauth/token', TOKENS);
    const run = await runBin([
      '--service-key',
      serviceKey(),
      '--output',
      path.join(root, 'out', 'TRIAL.env'),
      '--credential',
      '--auth-debug',
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expectNoSecrets(run);
  });
});

describe("the CLI's own I/O: refused in its own words naming the flag", () => {
  it('a missing --idp-metadata file: the flag, the path and ENOENT; never the unfamiliar words', async () => {
    const missing = path.join(root, 'nope.xml');
    const run = await runBin([
      'saml2-bearer',
      '--idp-metadata',
      missing,
      '--idp-initiated',
      // The pasted login's ACS: without one, refused before any read.
      '--acs-url',
      'https://uaa.example/oauth/token/alias/x',
      '--output',
      path.join(root, 'out', 'sso.env'),
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(
      `❌ SAML metadata: --idp-metadata: ${missing} cannot be read (ENOENT)`,
    );
    expect(run.stderr).not.toContain('does not know');
  });

  it('an unreachable --idp-metadata URL: the flag and the code, never the URL', async () => {
    const port = await freePort();
    const run = await runBin([
      'saml2-bearer',
      '--idp-metadata',
      `http://127.0.0.1:${port}/meta?sig=SIG-MARKER`,
      '--idp-initiated',
      // The pasted login's ACS: without one, refused before any read.
      '--acs-url',
      'https://uaa.example/oauth/token/alias/x',
      '--output',
      path.join(root, 'out', 'sso.env'),
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      '❌ SAML metadata: --idp-metadata: the metadata could not be fetched (ECONNREFUSED)',
    );
    expect(run.stderr).not.toContain('SIG-MARKER');
    expect(run.stderr).not.toContain(`127.0.0.1:${port}`);
  });

  it.each([
    ['--service-key', ['--service-key', 'nope.json', '--output', 'out/a.env']],
    [
      '--service-key',
      [
        'oidc',
        '--flow',
        'device',
        '--service-key',
        'nope.json',
        '--output',
        'out/a.env',
        '--type',
        'xsuaa',
      ],
    ],
    ['--config', ['oidc', '--config', 'nope.json', '--output', 'out/a.env']],
    [
      '--idp-cert',
      [
        'saml2-pure',
        '--idp-sso-url',
        'https://idp.example/sso',
        '--sp-entity-id',
        'sp',
        '--idp-cert',
        'nope.json',
        '--idp-entity-id',
        'https://idp.example',
        '--service-url',
        'https://abap.example',
        '--output',
        'out/a.env',
      ],
    ],
  ])(
    'a missing %s file: the flag, the path as given and ENOENT',
    async (flag, args) => {
      const run = await runBin(args);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(
        `❌ ${flag}: nope.json cannot be read (ENOENT)`,
      );
      expect(run.stderr).not.toContain('not found');
      expect(fs.existsSync(path.join(root, 'out', 'a.env'))).toBe(false);
    },
  );

  it('an --output that cannot be written: the flag, the path and EACCES', async () => {
    server.answer('/oauth/token', TOKENS);
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    const output = path.join(locked, 'sub', 'TRIAL.env');
    const run = await runBin([
      '--service-key',
      serviceKey(),
      '--output',
      output,
      '--credential',
    ]);
    fs.chmodSync(locked, 0o700);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(
      `❌ --output: ${output} cannot be written (EACCES)`,
    );
    expect(run.stderr).not.toContain('does not know');
    expectNoSecrets(run);
  });
});

describe('mcp-auth oidc --flow password', () => {
  it('stdout empty; no client secret, password, token or server text on either stream', async () => {
    server.answer('/token', TOKENS);
    const args = [
      'oidc',
      '--flow',
      'password',
      '--token-endpoint',
      `${server.url}/token`,
      '--client-id',
      'cli',
      '--client-secret',
      CLIENT_SECRET,
      '--username',
      'alice',
      '--password',
      PASSWORD,
      '--service-url',
      'https://abap.example.com',
      '--output',
      path.join(root, 'out', 'sso.env'),
    ];
    for (const extra of [[], ['--verbose']]) {
      const run = await runBin([...args, ...extra]);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expectNoSecrets(run);
    }
    server.answer('/token', REFUSAL);
    const refused = await runBin(args);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expectNoSecrets(refused);
    expect(refused.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('generate-env, in process', () => {
  /** Everything written to stdout and to stderr, by any route. */
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    const spies = [
      jest.spyOn(console, 'log').mockImplementation((...a) => {
        out.push(a.join(' '));
      }),
      jest.spyOn(console, 'info').mockImplementation((...a) => {
        out.push(a.join(' '));
      }),
      jest.spyOn(console, 'error').mockImplementation((...a) => {
        err.push(a.join(' '));
      }),
      jest.spyOn(console, 'warn').mockImplementation((...a) => {
        err.push(a.join(' '));
      }),
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      }),
      jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      }),
    ];
    return {
      run: (): Run => ({
        code: 0,
        stdout: out.join(''),
        stderr: err.join('\n'),
      }),
      restore: () => {
        for (const spy of spies) spy.mockRestore();
      },
    };
  }

  it.each([
    ['client_credentials', TOKENS, 0],
    ['authorization_code', TOKENS, 0],
    ['client_credentials', REFUSAL, 1],
  ] as const)(
    '--grant %s: stdout empty, no secret on either stream',
    async (grant, answer, code) => {
      server.answer('/oauth/token', answer);
      const workDir = fs.mkdtempSync(path.join(root, 'work-'));
      const streams = capture();
      let exit: number;
      try {
        exit = await runGenerateEnv(
          [
            'TRIAL',
            serviceKey(),
            path.join(root, 'sessions', 'TRIAL.env'),
            '--grant',
            grant,
            '--verbose',
          ],
          {
            workDir,
            authorization: () => staticCodeStrategy({ payload: CODE }),
          },
        );
      } finally {
        streams.restore();
      }
      expect(exit).toBe(code);
      const run = streams.run();
      expect(run.stdout).toBe('');
      expectNoSecrets(run);
    },
  );
});
