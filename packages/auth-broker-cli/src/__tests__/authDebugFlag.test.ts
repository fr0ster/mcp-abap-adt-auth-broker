/**
 * §10.7, D17: `--auth-debug` hands the broker `authDebug: true` — in
 * `mcp-auth`, every subcommand and `generate-env` — and nothing else does:
 * not `--verbose`, not an environment variable. `--verbose` (and
 * `--auth-debug`, which implies it) sets the CLI logger's level only; the
 * logger writes every level to stderr and reads no environment variable.
 *
 * Each run is read from its command line by the CLI's own parser, so the flag
 * is followed from the argument to the broker's config. The broker is the real
 * one, its constructor wrapped to record what each run hands it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AuthBrokerConfig } from '@mcp-abap-adt/auth-broker';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { runGenerateEnv } from '../generateEnv';
import { createCliLogger } from '../output';
import { runMcpAuth } from '../runMcpAuth';
import { runMcpSso } from '../runMcpSso';
import { parseCommandLine } from '../subcommandArgs';
import { CLIENT_CRT_PATH } from './helpers/certificates';

const built: Array<{ config: AuthBrokerConfig; logger: ILogger | undefined }> =
  [];

jest.mock('@mcp-abap-adt/auth-broker', () => {
  const actual = jest.requireActual('@mcp-abap-adt/auth-broker');
  class RecordedBroker extends actual.AuthBroker {
    constructor(config: AuthBrokerConfig, logger?: ILogger) {
      built.push({ config, logger });
      super(config, logger);
    }
  }
  return { ...actual, AuthBroker: RecordedBroker };
});

/** Environment variables 2.x or a provider read; 3.0.0 reads none (D17). */
const DEBUG_ENVIRONMENT: Record<string, string> = {
  DEBUG: 'true',
  DEBUG_SSO: 'true',
  DEBUG_AUTH_SSO: 'true',
  DEBUG_AUTH_PROVIDERS: 'true',
  DEBUG_BROWSER_AUTH: 'true',
  DEBUG_AUTH_BROKER: 'true',
  AUTH_DEBUG: 'true',
  LOG_LEVEL: 'debug',
};

let root: string;
let spies: jest.SpyInstance[];
const savedEnvironment = { ...process.env };

beforeEach(() => {
  built.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-debug-flag-'));
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.env = { ...savedEnvironment };
  fs.rmSync(root, { recursive: true, force: true });
});

/** An ABAP-format service key: a client the token endpoint never answers. */
function serviceKey(name: string): string {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: {
        url: 'http://127.0.0.1:9',
        clientid: 'key-client',
        clientsecret: 'key-secret',
      },
      abap: { url: 'https://abap.example.com' },
    }),
  );
  return file;
}

function workDir(): string {
  return fs.mkdtempSync(path.join(root, 'work-'));
}

/** The command line of each command, without the debug flags. */
const COMMANDS: Record<string, () => string[]> = {
  'mcp-auth': () => [
    '--service-key',
    serviceKey('TRIAL'),
    '--output',
    path.join(root, 'out', 'TRIAL.env'),
    '--credential',
  ],
  'mcp-auth auth-code': () => [
    'auth-code',
    '--service-key',
    serviceKey('TRIAL'),
    '--output',
    path.join(root, 'out', 'TRIAL.env'),
    '--credential',
  ],
  'mcp-auth oidc': () => [
    'oidc',
    '--flow',
    'password',
    '--token-endpoint',
    'http://127.0.0.1:9/token',
    '--client-id',
    'cli',
    '--username',
    'alice',
    '--password',
    'alice-password',
    '--service-url',
    'https://abap.example.com',
    '--output',
    path.join(root, 'out', 'sso.env'),
  ],
  'mcp-auth saml2-pure': () => [
    'saml2-pure',
    '--cookie',
    'SAP_SESSIONID=abc',
    '--idp-cert',
    CLIENT_CRT_PATH,
    '--idp-entity-id',
    'https://idp.example.com',
    '--service-url',
    'https://abap.example.com',
    '--output',
    path.join(root, 'out', 'sso.env'),
  ],
  'mcp-auth saml2-bearer': () => [
    'saml2-bearer',
    '--idp-sso-url',
    'http://127.0.0.1:9/sso',
    '--idp-cert',
    CLIENT_CRT_PATH,
    '--idp-entity-id',
    'https://idp.example.com',
    '--idp-initiated',
    '--assertion',
    'PHNhbWxwOlJlc3BvbnNlLz4=',
    '--uaa-url',
    'http://127.0.0.1:9',
    '--saml-metadata',
    path.join(__dirname, 'fixtures', 'xsuaa-sp-metadata.xml'),
    '--client-id',
    'cli',
    '--client-secret',
    'cli-secret',
    '--type',
    'xsuaa',
    '--output',
    path.join(root, 'out', 'sso.env'),
  ],
};

let lastFailure: unknown;

/** Runs a command line as the bin does — parsed, then run — to the broker. */
async function runCommand(args: string[]): Promise<void> {
  const parsed = parseCommandLine(args);
  try {
    if (parsed.kind === 'auth-code') {
      await runMcpAuth(parsed.options, {
        workDir: workDir(),
        authorization: () => {
          throw new Error('no login in this test');
        },
      });
    } else if (parsed.kind === 'sso') {
      await runMcpSso(parsed.options, {
        logger: createCliLogger({ verbose: false }),
        workDir: workDir(),
      });
    } else {
      throw new Error(`not a run: ${parsed.kind}`);
    }
  } catch (error) {
    // The login fails: no endpoint answers. The broker was built first.
    lastFailure = error;
  }
}

/** Runs `generate-env` with `extra` flags, to the broker. */
async function runGenerate(extra: string[]): Promise<void> {
  await runGenerateEnv(
    [
      'TRIAL',
      serviceKey('TRIAL'),
      path.join(root, 'sessions', 'TRIAL.env'),
      '--grant',
      'client_credentials',
      ...extra,
    ],
    {
      workDir: workDir(),
      authorization: () => {
        throw new Error('no login in this test');
      },
    },
  );
}

/** What the one broker a run built was handed as `authDebug`. */
function authDebugOfTheRun(): unknown {
  if (built.length !== 1) {
    throw new Error(
      `${built.length} brokers built; ${JSON.stringify(jest.mocked(console.error).mock.calls)} ${String(lastFailure)}`,
    );
  }
  return built[0]?.config.authDebug;
}

describe('--auth-debug hands the broker authDebug: true', () => {
  it.each(Object.keys(COMMANDS))('%s --auth-debug', async (name) => {
    await runCommand([...(COMMANDS[name] as () => string[])(), '--auth-debug']);
    expect(authDebugOfTheRun()).toBe(true);
  });

  it('generate-env --auth-debug', async () => {
    await runGenerate(['--auth-debug']);
    expect(authDebugOfTheRun()).toBe(true);
  });
});

describe('without it, authDebug is false — --verbose and the environment change nothing', () => {
  it.each(Object.keys(COMMANDS))(
    '%s, %s --verbose, with every debug variable set',
    async (name) => {
      const command = COMMANDS[name] as () => string[];
      await runCommand(command());
      expect(authDebugOfTheRun()).toBe(false);

      built.length = 0;
      await runCommand([...command(), '--verbose']);
      expect(authDebugOfTheRun()).toBe(false);

      built.length = 0;
      Object.assign(process.env, DEBUG_ENVIRONMENT);
      await runCommand(command());
      expect(authDebugOfTheRun()).toBe(false);
    },
  );

  it('generate-env, generate-env --verbose, with every debug variable set', async () => {
    await runGenerate([]);
    expect(authDebugOfTheRun()).toBe(false);
    built.length = 0;
    await runGenerate(['--verbose']);
    expect(authDebugOfTheRun()).toBe(false);
    built.length = 0;
    Object.assign(process.env, DEBUG_ENVIRONMENT);
    await runGenerate([]);
    expect(authDebugOfTheRun()).toBe(false);
  });
});

describe('the flags as the parser reads them', () => {
  it.each(Object.keys(COMMANDS))(
    '%s: --verbose and --auth-debug are present only when given',
    (name) => {
      const command = (COMMANDS[name] as () => string[])();
      const plain = parseCommandLine(command);
      const verbose = parseCommandLine([...command, '--verbose']);
      const debugging = parseCommandLine([...command, '--auth-debug']);
      if (plain.kind === 'help' || plain.kind === 'version') throw new Error();
      if (verbose.kind === 'help' || verbose.kind === 'version')
        throw new Error();
      if (debugging.kind === 'help' || debugging.kind === 'version') {
        throw new Error();
      }
      expect(plain.options).not.toHaveProperty('verbose');
      expect(plain.options).not.toHaveProperty('authDebug');
      expect(verbose.options).toMatchObject({ verbose: true });
      expect(verbose.options).not.toHaveProperty('authDebug');
      expect(debugging.options).toMatchObject({ authDebug: true });
    },
  );
});

describe('the CLI logger', () => {
  function written(verbose: boolean): string[] {
    const lines: string[] = [];
    const logger = createCliLogger({ verbose }, (line) => lines.push(line));
    logger.debug('a debug line');
    logger.info('an info line', { n: 1 });
    logger.warn('a warn line');
    logger.error('an error line');
    return lines;
  }

  it('without --verbose: from info — no debug line', () => {
    expect(written(false)).toEqual([
      '[info] an info line {"n":1}',
      '[warn] a warn line',
      '[error] an error line',
    ]);
  });

  it('with --verbose (or --auth-debug): every level, meta as JSON', () => {
    expect(written(true)).toEqual([
      '[debug] a debug line',
      '[info] an info line {"n":1}',
      '[warn] a warn line',
      '[error] an error line',
    ]);
  });

  it('no environment variable changes its level', () => {
    Object.assign(process.env, DEBUG_ENVIRONMENT);
    expect(written(false)).toEqual([
      '[info] an info line {"n":1}',
      '[warn] a warn line',
      '[error] an error line',
    ]);
  });

  it('writes to stderr by default, never to stdout', () => {
    const out = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      createCliLogger({ verbose: true }).error('to stderr');
      expect(console.error).toHaveBeenCalledWith('[error] to stderr');
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
    }
  });

  it('a meta it cannot render, or a writer that throws, never throws', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const lines: string[] = [];
    createCliLogger({ verbose: true }, (line) => lines.push(line)).info(
      'cyclic',
      cyclic,
    );
    expect(lines).toEqual(['[info] cyclic']);
    expect(() =>
      createCliLogger({ verbose: true }, () => {
        throw new Error('broken pipe');
      }).warn('x'),
    ).not.toThrow();
  });
});
