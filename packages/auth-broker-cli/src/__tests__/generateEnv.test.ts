/**
 * The `generate-env` development script: the grant is a flag, never read from
 * the service key — 3.x took `client_credentials` from an XSUAA key's URL
 * and `authorization_code` from anything else. What it writes is a destination
 * the broker builds from, with the secret alone in the session.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthBroker,
  fromServiceKeyCertificate,
} from '@mcp-abap-adt/auth-broker';
import {
  refreshThenLogin,
  staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { runGenerateEnv } from '../generateEnv';
import { failureLines } from '../output';
import { isUsageError } from '../subcommandArgs';
import {
  CLIENT_CN,
  CLIENT_CRT,
  CLIENT_CRT_PATH,
  CLIENT_KEY,
  CLIENT_KEY_PATH,
  PEM,
  pemFilesUnder,
  startCertServer,
  trustCertServer,
} from './helpers/certificates';
import { meansKeys, readEnvKeys } from './helpers/destinationFiles';
import {
  jwtName,
  type LocalServer,
  startLocalServer,
  tokenAnswer,
} from './helpers/localServer';

let server: LocalServer;
let root: string;
let spies: jest.SpyInstance[];

beforeEach(async () => {
  server = await startLocalServer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-env-'));
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** An XSUAA key — the shape 3.x read as client_credentials. */
function xsuaaKey(): string {
  const file = path.join(root, 'mcp.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      url: `${server.url}/authentication`,
      clientid: 'key-client',
      clientsecret: 'key-secret',
    }),
  );
  return file;
}

function abapKey(): string {
  const file = path.join(root, 'TRIAL.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: {
        url: server.url,
        clientid: 'key-client',
        clientsecret: 'key-secret',
      },
      abap: { url: 'https://abap.example.com' },
    }),
  );
  return file;
}

let workDir: string;
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(root, 'work-'));
});

const noBrowser = {
  authorization: () => staticCodeStrategy({ payload: 'the-code' }),
  get workDir() {
    return workDir;
  },
};

describe('generate-env', () => {
  it.each([
    ['an XSUAA key', 'mcp', xsuaaKey],
    ['an ABAP key', 'TRIAL', abapKey],
  ])(
    'without --grant, refuses %s: nothing inferred, nothing written',
    async (_, name, key) => {
      const session = path.join(root, 'sessions', `${name}.env`);
      await expect(
        runGenerateEnv([name, key(), session], noBrowser),
      ).resolves.toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--grant is required'),
      );
      expect(server.requests).toHaveLength(0);
      expect(fs.existsSync(session)).toBe(false);
    },
  );

  it('a service key path that cannot be read: the argument, the path as given and ENOENT; nothing written', async () => {
    const session = path.join(root, 'sessions', 'mcp.env');
    await expect(
      runGenerateEnv(
        ['mcp', 'nope.json', session, '--grant', 'client_credentials'],
        noBrowser,
      ),
    ).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      '❌ service-key-path: nope.json cannot be read (ENOENT)',
    );
    expect(server.requests).toHaveLength(0);
    expect(fs.existsSync(session)).toBe(false);
  });

  it('refuses a grant a service key client does not serve alone', async () => {
    await expect(
      runGenerateEnv(['mcp', xsuaaKey(), '--grant', 'password'], noBrowser),
    ).resolves.toBe(1);
    expect(server.requests).toHaveLength(0);
  });

  it('writes the grant the flag states — authorization_code for an XSUAA key too', async () => {
    server.answer('/authentication/oauth/token', tokenAnswer('gen'));
    const session = path.join(root, 'sessions', 'mcp.env');
    await expect(
      runGenerateEnv(
        ['mcp', xsuaaKey(), session, '--grant', 'authorization_code'],
        noBrowser,
      ),
    ).resolves.toBe(0);
    expect(server.requests[0]!.form.grant_type).toBe('authorization_code');
    const dir = path.dirname(session);
    const means = await new EnvDestinationStore(dir, {
      variables: XSUAA_DESTINATION_VARS,
    }).getConnectionConfig('mcp');
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'authorization_code',
      }),
    );
    const secret = await new XsuaaSessionStore(dir).loadSession('mcp');
    expect(jwtName(secret?.authorizationToken)).toBe('gen-access-1');
  });

  it('writes client_credentials for an ABAP key when the flag says so', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const session = path.join(root, 'sessions', 'TRIAL.env');
    await expect(
      runGenerateEnv(
        ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
        noBrowser,
      ),
    ).resolves.toBe(0);
    expect(server.requests[0]!.form.grant_type).toBe('client_credentials');
    const dir = path.dirname(session);
    expect(
      await new EnvDestinationStore(dir).getConnectionConfig('TRIAL'),
    ).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'client_credentials',
        serviceUrl: 'https://abap.example.com',
      }),
    );
  });

  it('a secret the store does not take fails the run (onWriteFailure: fail)', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const spy = jest
      .spyOn(AbapSessionStore.prototype, 'saveSession')
      .mockRejectedValue(new Error('disk full'));
    try {
      await expect(
        runGenerateEnv(
          [
            'TRIAL',
            abapKey(),
            path.join(root, 'sessions', 'TRIAL.env'),
            '--grant',
            'client_credentials',
          ],
          noBrowser,
        ),
      ).resolves.toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(server.requests).toHaveLength(1);
    // The login's own call fails with persisting-tokens: the store's words
    // are nowhere.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('persisting the tokens failed'),
    );
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(
      'disk full',
    );
  });

  it('a session path that cannot be written: refused naming it, its path and code', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });
    const session = path.join(locked, 'sub', 'TRIAL.env');
    const thrown = await runGenerateEnv(
      ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
      noBrowser,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    fs.chmodSync(locked, 0o700);
    expect(isUsageError(thrown)).toBe(true);
    expect(failureLines(thrown)).toEqual([
      `❌ the session path: ${session} cannot be written (EACCES)`,
    ]);
  });

  describe('the session file is changed only once the secret is stored', () => {
    const before = [
      'SAP_URL=https://old.example.com',
      'SAP_AUTH_TYPE=jwt',
      'SAP_GRANT_TYPE=password',
      'SAP_USERNAME=alice',
      "SAP_PASSWORD='old-password'",
      'SAP_JWT_TOKEN=old-token',
      '',
    ].join('\n');
    let session: string;
    beforeEach(() => {
      session = path.join(root, 'sessions', 'TRIAL.env');
      fs.mkdirSync(path.dirname(session), { recursive: true });
      fs.writeFileSync(session, before);
    });

    it('a refused or cancelled authorization: exit 1, the file byte for byte as it was', async () => {
      const cancelled = {
        authorization: () => ({
          authorize: async () => {
            throw new Error('the user cancelled the login');
          },
        }),
        workDir,
      };
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'authorization_code'],
          cancelled,
        ),
      ).resolves.toBe(1);
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('a token endpoint that refuses: exit 1, the file unchanged', async () => {
      server.answer('/oauth/token', {
        status: 401,
        body: { error: 'invalid_client' },
      });
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(1);
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('a secret the store does not take: exit 1, the file unchanged', async () => {
      server.answer('/oauth/token', tokenAnswer('cc', false));
      const spy = jest
        .spyOn(AbapSessionStore.prototype, 'saveSession')
        .mockRejectedValue(new Error('disk full'));
      try {
        await expect(
          runGenerateEnv(
            ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
            noBrowser,
          ),
        ).resolves.toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('a valid bound session already at the session path is never read: a new login, the file replaced (D25)', async () => {
      server.answer('/oauth/token', tokenAnswer('uaa'));
      const args = [
        'TRIAL',
        abapKey(),
        session,
        '--grant',
        'authorization_code',
      ];
      await expect(runGenerateEnv(args, noBrowser)).resolves.toBe(0);
      const first = fs.readFileSync(session, 'utf8');
      await expect(runGenerateEnv(args, noBrowser)).resolves.toBe(0);
      expect(server.requests.map((r) => r.form.grant_type)).toEqual([
        'authorization_code',
        'authorization_code',
      ]);
      const second = fs.readFileSync(session, 'utf8');
      expect(second).not.toBe(first);
      expect(second).toContain('SAP_REFRESH_TOKEN=uaa-refresh-2');
    });

    it('success replaces the means and writes the secret', async () => {
      server.answer('/oauth/token', tokenAnswer('cc', false));
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(0);
      const after = fs.readFileSync(session, 'utf8');
      expect(after).toContain('SAP_GRANT_TYPE=client_credentials');
      expect(after).not.toContain('old-password');
    });
  });
});

// --- client authentication: --client-auth certificate | secret -------------

describe('generate-env --client-auth', () => {
  let certServer: LocalServer;
  let sessionDir: string;

  // The HTTPS stand-in for `certurl` is trusted inside this process alone.
  trustCertServer();

  beforeEach(async () => {
    certServer = await startCertServer();
    sessionDir = path.join(root, 'sessions');
  });

  afterEach(async () => {
    await certServer.close();
  });

  const SECRET = 'key-secret';

  /**
   * An XSUAA key carrying a client certificate (`credential-type: x509`);
   * `mixed` adds a client secret.
   */
  function x509Key({ mixed = false }: { mixed?: boolean } = {}): string {
    const file = path.join(root, 'mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: `${server.url}/authentication`,
        clientid: 'key-client',
        ...(mixed ? { clientsecret: SECRET } : {}),
        certificate: CLIENT_CRT,
        key: CLIENT_KEY,
        certurl: certServer.url,
        'credential-type': 'x509',
      }),
    );
    return file;
  }

  /** An ABAP key whose `uaa` client is an x509 one. */
  function abapX509Key(): string {
    const file = path.join(root, 'TRIAL.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        uaa: {
          url: server.url,
          clientid: 'key-client',
          certificate: CLIENT_CRT,
          key: CLIENT_KEY,
          certurl: certServer.url,
        },
        abap: { url: 'https://abap.example.com' },
      }),
    );
    return file;
  }

  const certificate = [
    '--client-auth',
    'certificate',
    '--cert-path',
    CLIENT_CRT_PATH,
    '--key-path',
    CLIENT_KEY_PATH,
  ];

  /** What the run printed, every line. */
  function printed(): string {
    return [console.log, console.error]
      .flatMap((fn) => (fn as jest.Mock).mock.calls.flat())
      .map(String)
      .join('\n');
  }

  /** No PEM in what the run wrote, kept, or printed. */
  function expectNoPem() {
    expect(pemFilesUnder(workDir, sessionDir)).toEqual([]);
    expect(printed()).not.toContain(PEM);
  }

  describe('the flags, checked before anything is written', () => {
    async function refused(args: string[], words: string) {
      const session = path.join(sessionDir, 'mcp.env');
      await expect(
        runGenerateEnv(
          ['mcp', x509Key({ mixed: true }), session, ...args],
          noBrowser,
        ),
      ).resolves.toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(words),
      );
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(0);
    }

    const cc = ['--grant', 'client_credentials'];

    it('an unknown --client-auth is refused naming it', async () => {
      await refused(
        [...cc, '--client-auth', 'none'],
        "--client-auth must be 'certificate' or 'secret'",
      );
    });

    it('a flag with no value is refused naming it', async () => {
      await refused([...cc, '--client-auth'], '--client-auth needs a value');
    });

    it('secret without --basic-encoding names it', async () => {
      await refused(
        [...cc, '--client-auth', 'secret'],
        '--client-auth secret needs --basic-encoding raw|form',
      );
    });

    it('--basic-encoding without --client-auth secret is refused', async () => {
      await refused(
        [...cc, ...certificate, '--basic-encoding', 'raw'],
        '--basic-encoding applies only to --client-auth secret',
      );
    });

    it('certificate without --cert-path names it', async () => {
      await refused(
        [...cc, '--client-auth', 'certificate', '--key-path', CLIENT_KEY_PATH],
        '--client-auth certificate needs --cert-path',
      );
    });

    it('certificate without --key-path names it', async () => {
      await refused(
        [...cc, '--client-auth', 'certificate', '--cert-path', CLIENT_CRT_PATH],
        '--client-auth certificate needs --key-path',
      );
    });

    it('--cert-path / --key-path without --client-auth certificate are refused', async () => {
      await refused(
        [
          ...cc,
          '--client-auth',
          'secret',
          '--basic-encoding',
          'raw',
          '--key-path',
          CLIENT_KEY_PATH,
        ],
        '--key-path apply only to --client-auth certificate',
      );
    });

    it('a --cert-path with no file is refused naming the flag', async () => {
      const missing = path.join(root, 'missing.crt');
      await refused(
        [...cc, ...certificate.slice(0, 3), missing, ...certificate.slice(4)],
        `--cert-path: no file at ${missing}`,
      );
    });

    it('a --key-path with no file is refused naming the flag', async () => {
      const missing = path.join(root, 'missing.key');
      await refused(
        [...cc, ...certificate.slice(0, 5), missing],
        `--key-path: no file at ${missing}`,
      );
    });

    it('a relative --key-path with no file is refused at its absolute path', async () => {
      await refused(
        [...cc, ...certificate.slice(0, 5), 'missing.key'],
        `--key-path: no file at ${path.resolve('missing.key')}`,
      );
    });
  });

  /** An XSUAA x509 key and an ABAP one: the same refusals for both. */
  const x509Keys = [
    ['an XSUAA', 'mcp', () => x509Key()],
    ['an ABAP', 'TRIAL', () => abapX509Key()],
  ] as const;

  it.each([
    ...x509Keys.map(([kind, name, key]) => [kind, '', name, key, false]),
    ...x509Keys.map(([kind, name, key]) => [
      kind,
      ' wrapped in `credentials`',
      name,
      key,
      true,
    ]),
  ] as [string, string, string, () => string, boolean][])(
    '%s x509 key%s with no flag names --client-auth: nothing written',
    async (_, __, name, x509, wrapped) => {
      const session = path.join(sessionDir, `${name}.env`);
      const key = x509();
      if (wrapped) {
        const credentials = JSON.parse(fs.readFileSync(key, 'utf8'));
        fs.writeFileSync(key, JSON.stringify({ credentials }));
      }
      await expect(
        runGenerateEnv(
          [name, key, session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'carries a client certificate and no client secret: state how the client authenticates with --client-auth',
        ),
      );
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(0);
    },
  );

  describe('certificate', () => {
    it('client_credentials at certurl with the certificate; the .env holds absolute paths and certurl, no secret, no PEM', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509', false));
      const relative = (file: string) => path.relative(process.cwd(), file);
      const session = path.join(sessionDir, 'mcp.env');
      await expect(
        runGenerateEnv(
          [
            'mcp',
            x509Key({ mixed: true }),
            session,
            '--grant',
            'client_credentials',
            '--client-auth',
            'certificate',
            '--cert-path',
            relative(CLIENT_CRT_PATH),
            '--key-path',
            relative(CLIENT_KEY_PATH),
          ],
          noBrowser,
        ),
      ).resolves.toBe(0);

      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(1);
      const request = certServer.requests[0]!;
      expect(request.path).toBe('/oauth/token');
      expect(request.form.grant_type).toBe('client_credentials');
      expect(request.form.client_id).toBe('key-client');
      expect(request.form).not.toHaveProperty('client_secret');
      expect(request.authorization).toBeUndefined();
      expect(request.clientCertificate).toBe(CLIENT_CN);

      const keys = readEnvKeys(session);
      expect(keys.XSUAA_AUTH_TYPE).toBe('jwt');
      expect(keys.XSUAA_GRANT_TYPE).toBe('client_credentials');
      expect(keys.XSUAA_UAA_URL).toBe(`${server.url}/authentication`);
      expect(keys.XSUAA_UAA_CLIENT_ID).toBe('key-client');
      expect(keys.XSUAA_UAA_CLIENT_CERT_PATH).toBe(CLIENT_CRT_PATH);
      expect(keys.XSUAA_UAA_CLIENT_KEY_PATH).toBe(CLIENT_KEY_PATH);
      expect(keys.XSUAA_UAA_CERT_URL).toBe(certServer.url);
      expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_SECRET');
      expect(Object.keys(keys).filter((key) => key.startsWith('SAP_'))).toEqual(
        [],
      );
      expect(jwtName(keys.XSUAA_JWT_TOKEN)).toBe('x509-access-1');
      expectNoPem();
    });

    it('an ABAP key: the SAP_UAA_* certificate variables and the service URL; a fresh broker over the .env, from its final location, presents the stored token', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      const session = path.join(sessionDir, 'TRIAL.env');
      await expect(
        runGenerateEnv(
          [
            'TRIAL',
            abapX509Key(),
            session,
            '--grant',
            'authorization_code',
            ...certificate,
          ],
          noBrowser,
        ),
      ).resolves.toBe(0);
      expect(certServer.requests).toHaveLength(1);
      expect(certServer.requests[0]!.form).toEqual(
        expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'the-code',
        }),
      );
      expect(certServer.requests[0]!.clientCertificate).toBe(CLIENT_CN);

      const keys = readEnvKeys(session);
      expect(keys.SAP_URL).toBe('https://abap.example.com');
      expect(keys.SAP_GRANT_TYPE).toBe('authorization_code');
      expect(keys.SAP_UAA_URL).toBe(server.url);
      expect(keys.SAP_UAA_CLIENT_ID).toBe('key-client');
      expect(keys.SAP_UAA_CLIENT_CERT_PATH).toBe(CLIENT_CRT_PATH);
      expect(keys.SAP_UAA_CLIENT_KEY_PATH).toBe(CLIENT_KEY_PATH);
      expect(keys.SAP_UAA_CERT_URL).toBe(certServer.url);
      expect(keys).not.toHaveProperty('SAP_UAA_CLIENT_SECRET');
      expect(
        Object.keys(keys).filter((key) => key.startsWith('XSUAA_')),
      ).toEqual([]);
      expectNoPem();

      // The run's work directory is gone; the .env alone, where it was written.
      fs.rmSync(workDir, { recursive: true, force: true });
      const broker = new AuthBroker({
        renewal: () => refreshThenLogin(),
        onWriteFailure: 'fail',
        sessionStore: new AbapSessionStore(sessionDir),
        serviceKeyStore: new EnvDestinationStore(sessionDir),
        clientAuthentication: fromServiceKeyCertificate(),
        authorization: () => ({
          authorize: async () => {
            throw new Error('no login expected');
          },
        }),
      });
      const provider = (await broker.getProvider('TRIAL')) as unknown as {
        getTokens: () => Promise<{ authorizationToken: string }>;
      };
      const reused = await provider.getTokens();
      expect(jwtName(reused.authorizationToken)).toBe('x509-access-1');
      expect(certServer.requests).toHaveLength(1);
    });

    it("an incomplete certificate client is refused in the store's words — fields named, no PEM — nothing written", async () => {
      const key = x509Key();
      const { certurl: _, ...incomplete } = JSON.parse(
        fs.readFileSync(key, 'utf8'),
      );
      fs.writeFileSync(key, JSON.stringify(incomplete));
      await expect(
        runGenerateEnv(
          [
            'mcp',
            key,
            path.join(sessionDir, 'mcp.env'),
            '--grant',
            'client_credentials',
            ...certificate,
          ],
          noBrowser,
        ),
      ).resolves.toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('is incomplete: certurl missing'),
      );
      expect(printed()).not.toContain(PEM);
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(fs.existsSync(sessionDir)).toBe(false);
      expect(certServer.requests).toHaveLength(0);
    });

    it.each([
      ['an XSUAA', 'mcp', xsuaaKey],
      ['an ABAP', 'TRIAL', abapKey],
    ])(
      '%s key with no certificate client is refused, nothing written',
      async (_, name, key) => {
        const session = path.join(sessionDir, `${name}.env`);
        await expect(
          runGenerateEnv(
            [
              name,
              key(),
              session,
              '--grant',
              'client_credentials',
              ...certificate,
            ],
            noBrowser,
          ),
        ).resolves.toBe(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'carries no client certificate (url, clientid, certificate, key, certurl): --client-auth certificate needs one',
          ),
        );
        expect(fs.readdirSync(workDir)).toEqual([]);
        expect(fs.existsSync(sessionDir)).toBe(false);
        expect(server.requests).toHaveLength(0);
      },
    );
  });

  describe('secret', () => {
    // `+` and `%` read differently raw and form-encoded (RFC 6749 §2.3.1).
    const RESERVED = 'se+cr%et';

    it.each([
      ['raw', `key-client:${RESERVED}`],
      ['form', 'key-client:se%2Bcr%25et'],
    ])(
      'a mixed key with --basic-encoding %s: the secret in a Basic header so encoded; the .env holds the secret and no certificate',
      async (encoding, credential) => {
        server.answer('/authentication/oauth/token', tokenAnswer('cc', false));
        const key = x509Key({ mixed: true });
        const json = JSON.parse(fs.readFileSync(key, 'utf8'));
        fs.writeFileSync(
          key,
          JSON.stringify({ ...json, clientsecret: RESERVED }),
        );
        const session = path.join(sessionDir, 'mcp.env');
        await expect(
          runGenerateEnv(
            [
              'mcp',
              key,
              session,
              '--grant',
              'client_credentials',
              '--client-auth',
              'secret',
              '--basic-encoding',
              encoding,
            ],
            noBrowser,
          ),
        ).resolves.toBe(0);
        expect(certServer.requests).toHaveLength(0);
        const request = server.requests[0]!;
        expect(request.form.grant_type).toBe('client_credentials');
        expect(request.form).not.toHaveProperty('client_secret');
        expect(request.authorization).toBe(
          `Basic ${Buffer.from(credential).toString('base64')}`,
        );
        const keys = readEnvKeys(session);
        expect(keys.XSUAA_UAA_CLIENT_SECRET).toBe(RESERVED);
        expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_CERT_PATH');
        expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_KEY_PATH');
        expect(keys).not.toHaveProperty('XSUAA_UAA_CERT_URL');
        expectNoPem();
      },
    );

    it.each(x509Keys)(
      '%s x509 key without a secret is refused naming --client-auth certificate, nothing written',
      async (_, name, x509) => {
        const session = path.join(sessionDir, `${name}.env`);
        await expect(
          runGenerateEnv(
            [
              name,
              x509(),
              session,
              '--grant',
              'client_credentials',
              '--client-auth',
              'secret',
              '--basic-encoding',
              'raw',
            ],
            noBrowser,
          ),
        ).resolves.toBe(1);
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'a client certificate needs --client-auth certificate',
          ),
        );
        expect(fs.readdirSync(workDir)).toEqual([]);
        expect(fs.existsSync(sessionDir)).toBe(false);
        expect(server.requests).toHaveLength(0);
      },
    );
  });

  describe('a failed login leaves an existing destination file untouched, and no PEM anywhere', () => {
    const before = [
      'XSUAA_UAA_URL=https://old.example.com',
      'XSUAA_UAA_CLIENT_ID=old-client',
      "XSUAA_UAA_CLIENT_SECRET='old-secret'",
      'XSUAA_JWT_TOKEN=old-token',
      '',
    ].join('\n');

    const flags: Record<string, string[]> = {
      'no flag': [],
      secret: ['--client-auth', 'secret', '--basic-encoding', 'raw'],
      certificate,
    };
    for (const [flag, stated] of Object.entries(flags)) {
      for (const outcome of ['granted', 'refused'] as const) {
        it(`a mixed key, ${flag}, ${outcome}`, async () => {
          for (const target of [server, certServer]) {
            target.answer(
              target === server
                ? '/authentication/oauth/token'
                : '/oauth/token',
              outcome === 'granted'
                ? tokenAnswer('t', false)
                : () => ({ status: 401, body: { error: 'invalid_client' } }),
            );
          }
          const session = path.join(sessionDir, 'mcp.env');
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(session, before);
          await expect(
            runGenerateEnv(
              [
                'mcp',
                x509Key({ mixed: true }),
                session,
                '--grant',
                'client_credentials',
                ...stated,
              ],
              noBrowser,
            ),
          ).resolves.toBe(outcome === 'granted' ? 0 : 1);
          expect(server.requests.length + certServer.requests.length).toBe(1);
          if (outcome === 'refused') {
            expect(fs.readFileSync(session, 'utf8')).toBe(before);
          } else {
            // One kind of client: the certificate replaces the old secret.
            const keys = readEnvKeys(session);
            expect(keys.XSUAA_UAA_CLIENT_ID).toBe('key-client');
            if (flag === 'certificate') {
              expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_SECRET');
              expect(keys.XSUAA_UAA_CLIENT_CERT_PATH).toBe(CLIENT_CRT_PATH);
            } else {
              expect(keys.XSUAA_UAA_CLIENT_SECRET).toBe(SECRET);
              expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_CERT_PATH');
            }
          }
          expectNoPem();
        });
      }
    }
  });

  it('an ABAP mixed key with no flag writes the secret client, as the same key without a certificate', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const meansOf = async (extra: object) => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      const file = path.join(root, 'TRIAL.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          uaa: {
            url: server.url,
            clientid: 'key-client',
            clientsecret: SECRET,
            ...extra,
          },
          abap: { url: 'https://abap.example.com' },
        }),
      );
      const session = path.join(sessionDir, 'TRIAL.env');
      await expect(
        runGenerateEnv(
          ['TRIAL', file, session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(0);
      const keys = readEnvKeys(session);
      return Object.fromEntries(
        meansKeys('abap')
          .filter((key) => key in keys)
          .map((key) => [key, keys[key]]),
      );
    };
    const before = await meansOf({});
    expect(before).toEqual(
      expect.objectContaining({
        SAP_URL: 'https://abap.example.com',
        SAP_UAA_URL: server.url,
        SAP_UAA_CLIENT_ID: 'key-client',
        SAP_UAA_CLIENT_SECRET: SECRET,
      }),
    );
    expect(
      await meansOf({
        certificate: CLIENT_CRT,
        key: CLIENT_KEY,
        certurl: certServer.url,
      }),
    ).toEqual(before);
    expect(server.requests.map((r) => r.form.client_secret)).toEqual([
      SECRET,
      SECRET,
    ]);
    expect(certServer.requests).toHaveLength(0);
    expectNoPem();
  });

  it('an XSUAA key: a fresh broker over the .env, from its final location, builds the certificate destination and presents the stored token', async () => {
    certServer.answer('/oauth/token', tokenAnswer('x509'));
    const session = path.join(sessionDir, 'mcp.env');
    await expect(
      runGenerateEnv(
        [
          'mcp',
          x509Key(),
          session,
          '--grant',
          'authorization_code',
          ...certificate,
        ],
        noBrowser,
      ),
    ).resolves.toBe(0);
    expect(certServer.requests).toHaveLength(1);
    expect(certServer.requests[0]!.clientCertificate).toBe(CLIENT_CN);
    expect(readEnvKeys(session).XSUAA_UAA_CERT_URL).toBe(certServer.url);

    // The run's work directory is gone; the .env alone, where it was written.
    fs.rmSync(workDir, { recursive: true, force: true });
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      sessionStore: new XsuaaSessionStore(sessionDir),
      serviceKeyStore: new EnvDestinationStore(sessionDir, {
        variables: XSUAA_DESTINATION_VARS,
      }),
      clientAuthentication: fromServiceKeyCertificate(),
      authorization: () => ({
        authorize: async () => {
          throw new Error('no login expected');
        },
      }),
    });
    const provider = (await broker.getProvider('mcp')) as unknown as {
      getTokens: () => Promise<{ authorizationToken: string }>;
    };
    const reused = await provider.getTokens();
    expect(jwtName(reused.authorizationToken)).toBe('x509-access-1');
    expect(certServer.requests).toHaveLength(1);
  });
});

describe('a service key that is not JSON', () => {
  it('is refused in fixed words: nothing of the file reaches the console', async () => {
    const MARKER = 'leaked-marker-7f3a';
    const file = path.join(root, 'mcp.json');
    fs.writeFileSync(file, `{"clientsecret": "${MARKER}", oops`);
    await expect(
      runGenerateEnv(
        [
          'mcp',
          file,
          path.join(root, 'sessions', 'mcp.env'),
          '--grant',
          'client_credentials',
        ],
        noBrowser,
      ),
    ).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      `❌ The service key ${file} cannot be read as JSON`,
    );
    const printed = [console.log, console.error]
      .flatMap((fn) => (fn as jest.Mock).mock.calls.flat())
      .map(String)
      .join('\n');
    expect(printed).not.toContain(MARKER);
    expect(server.requests).toHaveLength(0);
  });
});
