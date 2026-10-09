/**
 * §10 (D24): one command. Every 2.x `mcp-sso` form of §11.2's table, given as
 * its `mcp-auth` form, yields the options 2.1.0's `mcp-sso` parse yields for
 * the original — the oracle is 2.1.0's parser, copied apart from the code
 * under test (`helpers/mcpSso210.ts`). `--protocol` is refused naming it; a
 * `--config` file naming another subcommand is refused naming `--config`;
 * `saml2-bearer` needs no `--dev`, and `--dev` is an unknown option like any
 * other. The parser takes an argument array and reads no `process.argv`; the
 * package installs one bin, `mcp-auth`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyFileConfig,
  type McpSsoOptions,
  normalizeProviderConfig,
} from '../mcpSsoConfig';
import {
  isUsageError,
  type ParsedCommand,
  parseCommandLine,
  parseSubcommandArgs,
  SUBCOMMANDS,
  type Subcommand,
  UsageError,
} from '../subcommandArgs';
import { parse210 } from './helpers/mcpSso210';

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Every flag 2.1.0's `mcp-sso` read that takes a value, each given once — of
 * the three sources one, `--service-key`: two together are a usage error
 * (D25), tested below.
 */
const VALUE_FLAGS = [
  ['--output', './sso.env'],
  ['--service-key', './sso.json'],
  ['--type', 'xsuaa'],
  ['--format', 'json'],
  ['--service-url', 'https://svc.example.com'],
  ['--browser', 'firefox'],
  ['--redirect-port', '61002'],
  ['--redirect-uri', 'http://localhost:61002/callback'],
  ['--issuer', 'https://issuer.example.com'],
  ['--authorization-endpoint', 'https://issuer.example.com/authorize'],
  ['--token-endpoint', 'https://issuer.example.com/token'],
  ['--device-authorization-endpoint', 'https://issuer.example.com/device'],
  ['--client-id', 'the-client'],
  ['--client-secret', 'the-client-secret'],
  // Comma and whitespace separated, empty entries among them.
  ['--scopes', 'openid, profile  email,,offline_access'],
  ['--scope', 'read'],
  ['--code', 'the-code'],
  ['--username', 'the-user'],
  ['--password', 'the-password'],
  ['--passcode', 'the-passcode'],
  ['--subject-token', 'the-subject'],
  ['--subject-token-type', 'urn:ietf:params:oauth:token-type:jwt'],
  ['--audience', 'the-audience'],
  ['--actor-token', 'the-actor'],
  ['--actor-token-type', 'urn:ietf:params:oauth:token-type:access_token'],
  ['--idp-sso-url', 'https://idp.example.com/sso'],
  ['--sp-entity-id', 'the-sp'],
  ['--acs-url', 'https://uaa.example.com/saml/SSO/alias/x'],
  ['--relay-state', 'the-relay'],
  ['--assertion-flow', 'manual'],
  ['--assertion', 'PHNhbWxwOlJlc3BvbnNlLz4='],
  ['--cookie', 'SAP_SESSIONID=abc; path=/'],
  ['--uaa-url', 'https://uaa.example.com'],
  ['--saml-metadata', './sp-metadata.xml'],
  ['--idp-cert', './idp-a.pem'],
  ['--idp-cert', './idp-b.pem'],
  ['--idp-entity-id', 'https://idp.example.com/metadata'],
  ['--idp-metadata', 'https://idp.example.com/saml2/metadata'],
  ['--authn-request-id', '_req1'],
] as const;

/** Every 2.1.0 flag at once, and `--idp-initiated`, the one with no value. */
const EVERY_FLAG = [...VALUE_FLAGS.flat(), '--idp-initiated'];

/** A few of a typical command line. */
const TYPICAL = [
  '--issuer',
  'https://issuer.example.com',
  '--client-id',
  'the-client',
  '--output',
  './sso.env',
  '--type',
  'xsuaa',
];

/** One row of §11.2's table: the 2.x form, the subcommand and its arguments. */
type Form = [label: string, original: string[], Subcommand, string[]];

function formsWith(rest: readonly string[]): Form[] {
  const forms: Form[] = [];
  for (const flow of ['browser', 'device', 'password', 'token_exchange']) {
    forms.push([
      `mcp-sso oidc --flow ${flow}`,
      ['oidc', '--flow', flow, ...rest],
      'oidc',
      ['--flow', flow, ...rest],
    ]);
    forms.push([
      `mcp-sso --protocol oidc --flow ${flow}`,
      ['--protocol', 'oidc', '--flow', flow, ...rest],
      'oidc',
      ['--flow', flow, ...rest],
    ]);
  }
  forms.push(
    [
      'mcp-sso saml2 --flow pure',
      ['saml2', '--flow', 'pure', ...rest],
      'saml2-pure',
      [...rest],
    ],
    [
      'mcp-sso --protocol saml2 --flow pure',
      ['--protocol', 'saml2', '--flow', 'pure', ...rest],
      'saml2-pure',
      [...rest],
    ],
    ['mcp-sso bearer', ['bearer', ...rest], 'saml2-bearer', [...rest]],
    [
      'mcp-sso saml2 --flow bearer',
      ['saml2', '--flow', 'bearer', ...rest],
      'saml2-bearer',
      [...rest],
    ],
    [
      'mcp-sso --protocol saml2 --flow bearer',
      ['--protocol', 'saml2', '--flow', 'bearer', ...rest],
      'saml2-bearer',
      [...rest],
    ],
  );
  return forms;
}

function ssoOptions(parsed: ParsedCommand): McpSsoOptions {
  if (parsed.kind !== 'sso') {
    throw new Error(`expected an sso subcommand, got ${parsed.kind}`);
  }
  return parsed.options;
}

/** What a parse throws, or `undefined`. */
function thrownBy(parse: () => unknown): unknown {
  try {
    parse();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('every 2.x mcp-sso form, as its mcp-auth form, yields 2.1.0’s options', () => {
  describe.each([
    ['a typical command line', TYPICAL],
    ['every flag 2.1.0 read', EVERY_FLAG],
  ])('%s', (_name, rest) => {
    it.each(formsWith(rest))('%s', (_label, original, subcommand, args) => {
      const expected = parse210(original);
      expect(ssoOptions(parseSubcommandArgs(subcommand, args))).toEqual(
        expected,
      );
      // The same through the command line, the subcommand first.
      expect(ssoOptions(parseCommandLine([subcommand, ...args]))).toEqual(
        expected,
      );
    });
  });

  it.each([
    [
      'mcp-sso oidc … --passcode <p>',
      ['oidc', '--flow', 'password', '--passcode', 'p', ...TYPICAL],
      'oidc',
      ['--flow', 'password', '--passcode', 'p', ...TYPICAL],
    ],
    [
      'mcp-sso oidc --flow browser … --code <c>',
      ['oidc', '--flow', 'browser', '--code', 'c', ...TYPICAL],
      'oidc',
      ['--flow', 'browser', '--code', 'c', ...TYPICAL],
    ],
    [
      'mcp-sso saml2 --flow pure … --cookie "<cookies>"',
      ['saml2', '--flow', 'pure', '--cookie', 'A=1; B=2', ...TYPICAL],
      'saml2-pure',
      ['--cookie', 'A=1; B=2', ...TYPICAL],
    ],
  ] as Form[])('%s', (_label, original, subcommand, args) => {
    expect(ssoOptions(parseSubcommandArgs(subcommand, args))).toEqual(
      parse210(original),
    );
  });

  it('saml2-pure takes --flow pure, as 2.x mcp-auth did; another flow is refused naming --flow', () => {
    expect(
      ssoOptions(parseSubcommandArgs('saml2-pure', ['--flow', 'pure'])),
    ).toEqual(parse210(['saml2', '--flow', 'pure']));
    for (const [subcommand, flow] of [
      ['saml2-pure', 'bearer'],
      ['saml2-bearer', 'pure'],
    ] as const) {
      const error = thrownBy(() =>
        parseSubcommandArgs(subcommand, ['--flow', flow]),
      );
      expect(isUsageError(error)).toBe(true);
      expect((error as Error).message).toContain('--flow');
    }
  });
});

describe('--protocol is refused: the subcommand is the protocol', () => {
  it.each(SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'mcp-auth %s --protocol …',
    (subcommand) => {
      for (const protocol of ['oidc', 'saml2']) {
        const error = thrownBy(() =>
          parseSubcommandArgs(subcommand, ['--protocol', protocol, ...TYPICAL]),
        );
        expect(isUsageError(error)).toBe(true);
        expect((error as Error).message).toContain('--protocol');
      }
    },
  );
});

describe('--dev is removed: an unknown option like any other', () => {
  it('saml2-bearer works without --dev', () => {
    const options = ssoOptions(
      parseCommandLine(['saml2-bearer', '--service-key', './k.json']),
    );
    expect(options).toEqual(parse210(['bearer', '--service-key', './k.json']));
    expect(options).toMatchObject({ protocol: 'saml2', flow: 'bearer' });
  });

  it.each(SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'mcp-auth %s --dev is refused naming it',
    (subcommand) => {
      const rest =
        subcommand === 'auth-code'
          ? ['--service-key', './k.json', '--output', './o.env']
          : TYPICAL;
      for (const args of [
        ['--dev', ...rest],
        [...rest, '--dev'],
      ]) {
        const error = thrownBy(() => parseSubcommandArgs(subcommand, args));
        expect(isUsageError(error)).toBe(true);
        expect((error as Error).message).toBe('unknown option: --dev');
      }
    },
  );

  it('an unknown value is refused without repeating it', () => {
    const error = thrownBy(() =>
      parseSubcommandArgs('oidc', ['--flow', 'device', 'a-stray-secret']),
    );
    expect(isUsageError(error)).toBe(true);
    expect((error as Error).message).not.toContain('a-stray-secret');
  });
});

describe('--config belongs to the subcommand its protocol and flow name', () => {
  let root: string;
  let exit: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'subcommand-config-'));
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    error.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const FILES = {
    oidc: { protocol: 'oidc', flow: 'device', clientId: 'from-file' },
    'saml2-pure': {
      protocol: 'saml2',
      flow: 'pure',
      idpSsoUrl: 'https://idp.example.com/sso',
    },
    'saml2-bearer': {
      protocol: 'saml2',
      flow: 'bearer',
      spEntityId: 'from-file',
    },
  } as const;

  /** The options after the file is applied, as `runMcpSso` applies it. */
  function withFile(options: McpSsoOptions, file: object): McpSsoOptions {
    applyFileConfig(options, normalizeProviderConfig(file));
    return options;
  }

  it.each(Object.entries(FILES))(
    'mcp-sso --config <a %s file> … = mcp-auth <its subcommand> --config <file> …',
    (subcommand, file) => {
      const configPath = path.join(root, 'config.json');
      const args = ['--config', configPath, ...TYPICAL];
      expect(
        withFile(
          ssoOptions(parseSubcommandArgs(subcommand as Subcommand, args)),
          file,
        ),
      ).toEqual(withFile(parse210(args), file));
    },
  );

  it.each(
    Object.keys(FILES).flatMap((subcommand) =>
      Object.entries(FILES)
        .filter(([named]) => named !== subcommand)
        .map(([named, file]) => [subcommand, named, file] as const),
    ),
  )(
    'mcp-auth %s --config <a %s file> is refused naming --config',
    (subcommand, _named, file) => {
      const options = ssoOptions(
        parseSubcommandArgs(subcommand as Subcommand, ['--config', 'f.json']),
      );
      expect(() => withFile(options, file)).toThrow('process.exit(1)');
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain('--config');
      expect(error.mock.calls[0]?.[0]).toContain(`mcp-auth ${subcommand}`);
    },
  );

  it('mcp-auth oidc --flow <f> --config <an oidc file of another flow>: the flag wins, as 2.x', () => {
    const args = ['--flow', 'browser', '--config', 'f.json'];
    expect(
      withFile(ssoOptions(parseSubcommandArgs('oidc', args)), FILES.oidc),
    ).toEqual(withFile(parse210(['oidc', ...args]), FILES.oidc));
  });

  it('an oidc file without a flow names mcp-auth oidc: its fields are applied, the flow is --flow', () => {
    const options = withFile(
      ssoOptions(
        parseSubcommandArgs('oidc', ['--flow', 'device', '--config', 'f']),
      ),
      { protocol: 'oidc', clientId: 'from-file', issuerUrl: 'https://i' },
    );
    expect(options).toMatchObject({
      protocol: 'oidc',
      flow: 'device',
      clientId: 'from-file',
      issuerUrl: 'https://i',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([['saml2-pure'], ['saml2-bearer']] as const)(
    'mcp-auth %s --config <a saml2 file without a flow> is refused naming --config and flow',
    (subcommand) => {
      const options = ssoOptions(
        parseSubcommandArgs(subcommand, ['--config', 'f']),
      );
      expect(() =>
        withFile(options, {
          protocol: 'saml2',
          idpSsoUrl: 'https://idp.example.com/sso',
        }),
      ).toThrow('process.exit(1)');
      expect(error).toHaveBeenCalledTimes(1);
      const words = String(error.mock.calls[0]?.[0]);
      expect(words).toContain('--config');
      expect(words).toContain('states no flow');
      expect(words).toContain(`mcp-auth ${subcommand}`);
    },
  );

  it.each(
    SUBCOMMANDS.filter((s) => s !== 'auth-code').flatMap((subcommand) => [
      [
        subcommand,
        'a provider file',
        { provider: { flow: 'pure', config: {} } },
      ],
      [subcommand, 'a flat file', { flow: 'device', clientId: 'c' }],
      [subcommand, 'a file of fields alone', { clientId: 'c' }],
    ]),
  )(
    'mcp-auth %s --config <%s without a protocol> is refused naming --config and protocol',
    (subcommand, _kind, file) => {
      const options = ssoOptions(
        parseSubcommandArgs(subcommand as Subcommand, ['--config', 'f']),
      );
      expect(() => withFile(options, file as object)).toThrow(
        'process.exit(1)',
      );
      expect(error).toHaveBeenCalledTimes(1);
      const words = String(error.mock.calls[0]?.[0]);
      expect(words).toContain('--config');
      expect(words).toContain('states no protocol');
      expect(words).toContain(`mcp-auth ${subcommand}`);
    },
  );
});

describe('help, version and the command', () => {
  it.each([
    [[], { kind: 'help' }],
    [['help'], { kind: 'help' }],
    [['--help'], { kind: 'help', subcommand: 'auth-code' }],
    [['version'], { kind: 'version' }],
    [['--version'], { kind: 'version' }],
    [['-v'], { kind: 'version' }],
    ...SUBCOMMANDS.flatMap((subcommand) => [
      [[subcommand, '--help'], { kind: 'help', subcommand }],
      [[subcommand, '-h'], { kind: 'help', subcommand }],
      [[subcommand], { kind: 'help', subcommand }],
      [[subcommand, '--version'], { kind: 'version' }],
    ]),
  ] as [string[], ParsedCommand][])('mcp-auth %j', (args, expected) => {
    expect(parseCommandLine(args)).toEqual(expected);
  });

  it('a usage error is known by its brand, not its class name or words', () => {
    expect(isUsageError(new UsageError('x'))).toBe(true);
    const lookalike = Object.assign(new Error('unknown option: --dev'), {
      name: 'UsageError',
    });
    expect(isUsageError(lookalike)).toBe(false);
    expect(isUsageError(JSON.parse(JSON.stringify(new UsageError('x'))))).toBe(
      false,
    );
  });

  it('an unknown command is refused, naming the commands', () => {
    for (const command of ['mcp-sso', 'bearer', 'saml2', 'sso']) {
      const error = thrownBy(() => parseCommandLine([command, '--help']));
      expect(isUsageError(error)).toBe(true);
      expect((error as Error).message).toContain(
        'auth-code, oidc, saml2-pure, saml2-bearer',
      );
    }
  });

  it('mcp-auth and mcp-auth auth-code read the same options; --dev is refused there too', () => {
    const args = [
      '--env',
      './o.env',
      '--output',
      './o.env',
      '--type',
      'xsuaa',
      '--credential',
      '--browser',
      'none',
      '--format',
      'json',
      '--service-url',
      'https://svc.example.com',
      '--redirect-port',
      '61002',
      '--client-auth',
      'secret',
      '--basic-encoding',
      'raw',
    ];
    const expected = {
      kind: 'auth-code',
      options: {
        serviceKeyPath: undefined,
        envFilePath: './o.env',
        destination: undefined,
        destinationDir: undefined,
        outputFile: './o.env',
        authType: 'xsuaa',
        browser: 'none',
        browserProgram: undefined,
        credential: true,
        format: 'json',
        serviceUrl: 'https://svc.example.com',
        redirectPort: 61002,
        clientAuth: 'secret',
        basicEncoding: 'raw',
        certPath: undefined,
        keyPath: undefined,
      },
    };
    expect(parseCommandLine(args)).toEqual(expected);
    expect(parseCommandLine(['auth-code', ...args])).toEqual(expected);
    expect(parseSubcommandArgs('auth-code', args)).toEqual(expected);
    // The default browser of a login that opens one: auto.
    const plain = parseCommandLine(['--service-key', 'k', '--output', 'o']);
    expect(plain).toMatchObject({ options: { browser: 'auto' } });
    const dev = thrownBy(() => parseCommandLine([...args, '--dev']));
    expect(isUsageError(dev)).toBe(true);
    expect((dev as Error).message).toBe('unknown option: --dev');
  });
});

describe('the parser reads no process.argv; the package installs mcp-auth alone', () => {
  it('an argument array is all it reads', () => {
    const saved = process.argv;
    process.argv = ['node', 'mcp-auth', '--protocol', 'oidc', '--dev'];
    try {
      expect(
        ssoOptions(parseSubcommandArgs('oidc', ['--flow', 'device'])),
      ).toEqual(parse210(['oidc', '--flow', 'device']));
      expect(parseCommandLine([])).toEqual({ kind: 'help' });
    } finally {
      process.argv = saved;
    }
    const source = fs.readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'subcommandArgs.ts'),
      'utf8',
    );
    expect(source.includes('process.argv')).toBe(false);
  });

  it('bin holds only mcp-auth, and no mcp-sso entry point is left', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    );
    expect(manifest.bin).toEqual({ 'mcp-auth': './dist/mcp-auth.js' });
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'src', 'mcp-sso.ts'))).toBe(
      false,
    );
  });

  it('mcp-auth runs every subcommand in its own process: no child process', () => {
    const source = fs.readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'mcp-auth.ts'),
      'utf8',
    );
    expect(source.includes('child_process')).toBe(false);
    expect(source.includes('spawn')).toBe(false);
  });
});

describe('three sources, one per run (D25)', () => {
  const SOURCES = [
    ['--service-key', './k.json'],
    ['--env', './o.env'],
    ['--destination', 'TRIAL'],
  ] as const;
  const PAIRS = [
    [SOURCES[0], SOURCES[1]],
    [SOURCES[0], SOURCES[2]],
    [SOURCES[1], SOURCES[2]],
  ] as const;

  it.each(SUBCOMMANDS.map((subcommand) => [subcommand]))(
    '%s: two sources together are a usage error naming both',
    (subcommand) => {
      for (const [a, b] of PAIRS) {
        for (const order of [
          [...a, ...b],
          [...b, ...a],
        ]) {
          const error = thrownBy(() =>
            parseSubcommandArgs(subcommand, [...order, '--output', './o.env']),
          );
          expect(isUsageError(error)).toBe(true);
          expect((error as Error).message).toBe(
            `${a[0]} and ${b[0]} are two sources: give one of --service-key, --env and --destination`,
          );
        }
      }
      const all = thrownBy(() =>
        parseSubcommandArgs(subcommand, [...SOURCES.flat(), '--output', 'o']),
      );
      expect((all as Error).message).toBe(
        '--service-key, --env and --destination are three sources: give one of --service-key, --env and --destination',
      );
    },
  );

  it('auth-code: no source is a usage error naming the three', () => {
    const error = thrownBy(() =>
      parseCommandLine(['--output', './o.env', '--credential']),
    );
    expect(isUsageError(error)).toBe(true);
    expect((error as Error).message).toBe(
      'a source is required: --service-key <path>, --env <path> or --destination <name>',
    );
  });

  it('--service-key needs --output; --env and --destination do not', () => {
    const error = thrownBy(() => parseCommandLine(['--service-key', 'k']));
    expect((error as Error).message).toBe(
      '--output is required with --service-key',
    );
    expect(parseCommandLine(['--env', './o.env'])).toMatchObject({
      kind: 'auth-code',
      options: { envFilePath: './o.env', outputFile: undefined },
    });
    expect(
      parseCommandLine([
        '--destination',
        'TRIAL',
        '--destination-dir',
        './dests',
      ]),
    ).toMatchObject({
      kind: 'auth-code',
      options: {
        destination: 'TRIAL',
        destinationDir: './dests',
        outputFile: undefined,
      },
    });
    expect(
      ssoOptions(
        parseSubcommandArgs('oidc', [
          '--flow',
          'device',
          '--destination',
          'TRIAL',
          '--destination-dir',
          './dests',
        ]),
      ),
    ).toMatchObject({ destination: 'TRIAL', destinationDir: './dests' });
  });

  it.each(SUBCOMMANDS.map((subcommand) => [subcommand]))(
    '%s: --destination-dir without --destination is refused',
    (subcommand) => {
      const error = thrownBy(() =>
        parseSubcommandArgs(subcommand, [
          '--env',
          './o.env',
          '--destination-dir',
          './dests',
        ]),
      );
      expect((error as Error).message).toBe(
        '--destination-dir applies only to --destination',
      );
    },
  );

  it.each([['../x'], ['a/b'], ['a\\b'], ['.'], ['..'], ['']])(
    '--destination %p is a name, not a path: refused',
    (name) => {
      const error = thrownBy(() =>
        parseCommandLine(['--destination', name, '--credential']),
      );
      expect(isUsageError(error)).toBe(true);
      expect((error as Error).message).toBe(
        '--destination needs a destination name, not a path',
      );
    },
  );
});
