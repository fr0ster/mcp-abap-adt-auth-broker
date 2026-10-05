/**
 * `mcp-auth` end to end against a local UAA token endpoint — no browser: the
 * interactive strategy is the one the caller states, here a static code.
 *
 * Each case pins what the command writes and where: the means (`jwt`, the
 * grant, the client and URL from the service key) read back through the key
 * store; the secret alone in the session store, never the client secret;
 * and the destination a server builds from the output with `getProvider`,
 * which presents the stored token without a new login.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import {
  AuthBroker,
  fromServiceKeyCertificate,
} from '@mcp-abap-adt/auth-broker';
import { staticCodeStrategy } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { type McpAuthOptions, runMcpAuth } from '../runMcpAuth';
import {
  meansKeys,
  readEnvKeys,
  SECRET_FIELDS,
  sessionKeys,
} from './helpers/destinationFiles';
import {
  jwtName,
  type LocalServer,
  startLocalServer,
  tokenAnswer,
} from './helpers/localServer';

const DEST = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com';
const CLIENT_SECRET = 'key-client-secret';

let server: LocalServer;
let root: string;
let workDir: string;
let keysDir: string;
let outDir: string;
let sessionWrites: object[];
let spies: jest.SpyInstance[];
let strategyCalls: number;

beforeEach(async () => {
  server = await startLocalServer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-run-'));
  workDir = path.join(root, 'work');
  keysDir = path.join(root, 'keys');
  outDir = path.join(root, 'out');
  fs.mkdirSync(workDir);
  fs.mkdirSync(keysDir);
  sessionWrites = [];
  strategyCalls = 0;
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never),
  ];
  for (const Store of [AbapSessionStore, XsuaaSessionStore]) {
    const original = Store.prototype.saveSession;
    spies.push(
      jest
        .spyOn(Store.prototype, 'saveSession')
        .mockImplementation(async function (
          this: InstanceType<typeof Store>,
          destination: string,
          config: unknown,
        ) {
          sessionWrites.push(config as object);
          return original.call(this, destination, config as never);
        }),
    );
  }
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function abapKey(): string {
  const file = path.join(keysDir, `${DEST}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: {
        url: server.url,
        clientid: 'key-client',
        clientsecret: CLIENT_SECRET,
      },
      abap: { url: SERVICE_URL },
    }),
  );
  return file;
}

function xsuaaKey(): string {
  const file = path.join(keysDir, `${DEST}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      // An XSUAA URL names `authentication`: the store reads any other `url`
      // as the service's own.
      url: `${server.url}/authentication`,
      clientid: 'key-client',
      clientsecret: CLIENT_SECRET,
    }),
  );
  return file;
}

function options(overrides: Partial<McpAuthOptions>): McpAuthOptions {
  return {
    outputFile: path.join(outDir, `${DEST}.env`),
    authType: 'abap',
    browser: 'none',
    credential: false,
    format: 'env',
    ...overrides,
  };
}

/** The caller's interactive strategy: a code, counted when the provider asks. */
function run(o: McpAuthOptions) {
  return runMcpAuth(o, {
    workDir,
    authorization: () => {
      const inner = staticCodeStrategy({ payload: 'the-code' });
      return {
        authorize: (request) => {
          strategyCalls += 1;
          return inner.authorize(request);
        },
      };
    },
  });
}

function storesOf(type: 'abap' | 'xsuaa') {
  return type === 'abap'
    ? {
        keyStore: new EnvDestinationStore(outDir),
        sessionStore: new AbapSessionStore(outDir),
      }
    : {
        keyStore: new EnvDestinationStore(outDir, {
          variables: XSUAA_DESTINATION_VARS,
        }),
        sessionStore: new XsuaaSessionStore(outDir),
      };
}

async function expectSplit(type: 'abap' | 'xsuaa') {
  const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
  const owned = new Set([...meansKeys(type), ...sessionKeys(type)]);
  expect(Object.keys(keys).filter((key) => !owned.has(key))).toEqual([]);
  expect(sessionWrites.length).toBeGreaterThan(0);
  for (const config of sessionWrites) {
    expect(
      Object.keys(config).filter((field) => !SECRET_FIELDS.includes(field)),
    ).toEqual([]);
    expect(JSON.stringify(config)).not.toContain(CLIENT_SECRET);
  }
  expect(
    Object.entries(keys)
      .filter(([, value]) => value.includes(CLIENT_SECRET))
      .map(([key]) => key),
  ).toEqual([
    type === 'abap' ? 'SAP_UAA_CLIENT_SECRET' : 'XSUAA_UAA_CLIENT_SECRET',
  ]);
}

describe('mcp-auth (authorization_code)', () => {
  it('writes jwt / authorization_code with the key client and URL; the token through the stated strategy', async () => {
    server.answer('/oauth/token', tokenAnswer('uaa'));
    await expect(run(options({ serviceKeyPath: abapKey() }))).resolves.toBe(0);
    expect(strategyCalls).toBe(1);
    expect(server.requests[0].form).toEqual(
      expect.objectContaining({
        grant_type: 'authorization_code',
        code: 'the-code',
      }),
    );

    const { keyStore, sessionStore } = storesOf('abap');
    expect(await keyStore.getConnectionConfig(DEST)).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'authorization_code',
        serviceUrl: SERVICE_URL,
      }),
    );
    expect(await keyStore.getAuthorizationConfig(DEST)).toEqual({
      uaaUrl: server.url,
      uaaClientId: 'key-client',
      uaaClientSecret: CLIENT_SECRET,
    });
    const secret = await sessionStore.loadSession(DEST);
    expect(jwtName(secret?.authorizationToken)).toBe('uaa-access-1');
    expect(secret?.refreshToken).toBe('uaa-refresh-1');
    await expectSplit('abap');

    // The server's view: getProvider over the output reuses the token.
    const before = server.requests.length;
    const broker = new AuthBroker({
      ...storesOf('abap'),
      serviceKeyStore: storesOf('abap').keyStore,
      authorization: () => ({
        authorize: async () => {
          throw new Error('no login expected');
        },
      }),
    });
    const provider = (await broker.getProvider(DEST)) as unknown as {
      getTokens: () => Promise<{ authorizationToken: string }>;
    };
    const reused = await provider.getTokens();
    expect(jwtName(reused.authorizationToken)).toBe('uaa-access-1');
    expect(server.requests.length).toBe(before);
  });

  it('with --env, the stored refresh token renews: no login', async () => {
    server.answer('/oauth/token', tokenAnswer('uaa'));
    await run(options({ serviceKeyPath: abapKey() }));
    const previous = path.join(root, `${DEST}.env`);
    fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
    strategyCalls = 0;

    await expect(
      run(options({ serviceKeyPath: abapKey(), envFilePath: previous })),
    ).resolves.toBe(0);
    expect(strategyCalls).toBe(0);
    expect(server.requests.at(-1)?.form).toEqual(
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'uaa-refresh-1',
      }),
    );
    const renewed = await storesOf('abap').sessionStore.loadSession(DEST);
    expect(jwtName(renewed?.authorizationToken)).toBe('uaa-access-2');
  });

  it('--format json writes the 1.x fields from the stores', async () => {
    server.answer('/oauth/token', tokenAnswer('uaa'));
    const output = path.join(outDir, `${DEST}.json`);
    await expect(
      run(
        options({
          serviceKeyPath: abapKey(),
          format: 'json',
          outputFile: output,
        }),
      ),
    ).resolves.toBe(0);
    const json = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(jwtName(json.accessToken)).toBe('uaa-access-1');
    expect(json).toEqual({
      accessToken: json.accessToken,
      refreshToken: 'uaa-refresh-1',
      serviceUrl: SERVICE_URL,
      uaaUrl: server.url,
      uaaClientId: 'key-client',
      uaaClientSecret: CLIENT_SECRET,
    });
  });
});

describe('mcp-auth --credential --type xsuaa', () => {
  it('writes jwt / client_credentials under XSUAA_* keys; a key without a URL writes none', async () => {
    server.answer('/authentication/oauth/token', tokenAnswer('cc', false));
    await expect(
      run(
        options({
          serviceKeyPath: xsuaaKey(),
          authType: 'xsuaa',
          credential: true,
        }),
      ),
    ).resolves.toBe(0);
    expect(strategyCalls).toBe(0);
    expect(server.requests[0].form.grant_type).toBe('client_credentials');
    const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
    expect(keys.XSUAA_AUTH_TYPE).toBe('jwt');
    expect(keys.XSUAA_GRANT_TYPE).toBe('client_credentials');
    expect(keys).not.toHaveProperty('XSUAA_MCP_URL');
    expect(jwtName(keys.XSUAA_JWT_TOKEN)).toBe('cc-access-1');
    await expectSplit('xsuaa');
  });
});

describe('a secret the store does not take', () => {
  it('fails the run and writes no output', async () => {
    server.answer('/oauth/token', tokenAnswer('lost'));
    jest
      .spyOn(AbapSessionStore.prototype, 'saveSession')
      .mockRejectedValue(new Error('disk full'));
    await expect(run(options({ serviceKeyPath: abapKey() }))).rejects.toThrow(
      'disk full',
    );
    expect(server.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(outDir, `${DEST}.env`))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('The session was not stored'),
    );
  });
});

describe('a refused login', () => {
  it('leaves an existing output byte for byte as it was', async () => {
    const output = path.join(outDir, `${DEST}.env`);
    fs.mkdirSync(outDir, { recursive: true });
    const before = 'SAP_URL=https://old.example.com\nSAP_JWT_TOKEN=old\n';
    fs.writeFileSync(output, before);
    server.answer('/oauth/token', {
      status: 401,
      body: { error: 'invalid_client' },
    });
    await expect(
      run(options({ serviceKeyPath: abapKey(), credential: true })),
    ).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe(before);
  });
});

// --- client authentication: --client-auth certificate | secret -------------

const FIXTURES = path.join(__dirname, 'fixtures', 'certificates');
const CLIENT_CRT_PATH = path.join(FIXTURES, 'client.crt');
const CLIENT_KEY_PATH = path.join(FIXTURES, 'client.key');
const CLIENT_CRT = fs.readFileSync(CLIENT_CRT_PATH, 'utf8');
const CLIENT_KEY = fs.readFileSync(CLIENT_KEY_PATH, 'utf8');
const PEM = '-----BEGIN';

/** Every file under `dir`, recursively; none when it does not exist. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** The files under the work and output directories that hold PEM. */
function pemCopies(): string[] {
  return [...filesUnder(workDir), ...filesUnder(outDir)].filter((file) =>
    fs.readFileSync(file, 'utf8').includes(PEM),
  );
}

describe('mcp-auth --client-auth', () => {
  let certServer: LocalServer;
  let defaultCas: string[];

  beforeAll(() => {
    // The HTTPS stand-in for `certurl` is trusted inside this process alone.
    defaultCas = tls.getCACertificates('default');
    tls.setDefaultCACertificates([
      ...defaultCas,
      fs.readFileSync(path.join(FIXTURES, 'server.crt'), 'utf8'),
    ]);
  });

  afterAll(() => {
    tls.setDefaultCACertificates(defaultCas);
  });

  beforeEach(async () => {
    certServer = await startLocalServer({
      cert: fs.readFileSync(path.join(FIXTURES, 'server.crt'), 'utf8'),
      key: fs.readFileSync(path.join(FIXTURES, 'server.key'), 'utf8'),
    });
  });

  afterEach(async () => {
    await certServer.close();
  });

  /**
   * A key as Cloud Foundry's binding details answer it: `credentials` beside
   * other fields. (A file holding `credentials` alone is unwrapped by
   * auth-stores' JSON reader before the CLI sees it; this shape is what the
   * CLI unwraps itself.)
   */
  function detailsOf(credentials: object) {
    return { credentials, syslog_drain_url: null, volume_mounts: [] };
  }

  /**
   * An XSUAA key carrying a client certificate (`credential-type: x509`),
   * wrapped in `credentials` or not; `mixed` adds a client secret.
   */
  function x509Key({
    wrapped = true,
    mixed = false,
  }: {
    wrapped?: boolean;
    mixed?: boolean;
  } = {}): string {
    const file = path.join(keysDir, `${DEST}.json`);
    const credentials = {
      url: `${server.url}/authentication`,
      clientid: 'key-client',
      ...(mixed ? { clientsecret: CLIENT_SECRET } : {}),
      certificate: CLIENT_CRT,
      key: CLIENT_KEY,
      certurl: certServer.url,
      'credential-type': 'x509',
    };
    fs.writeFileSync(
      file,
      JSON.stringify(wrapped ? detailsOf(credentials) : credentials),
    );
    return file;
  }

  /** A `credentials`-wrapped XSUAA key with a client secret and no certificate. */
  function wrappedSecretKey(): string {
    const file = path.join(keysDir, `${DEST}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        detailsOf({
          url: `${server.url}/authentication`,
          clientid: 'key-client',
          clientsecret: CLIENT_SECRET,
        }),
      ),
    );
    return file;
  }

  const certificate = {
    clientAuth: 'certificate',
    certPath: CLIENT_CRT_PATH,
    keyPath: CLIENT_KEY_PATH,
  } as const;
  const secret = { clientAuth: 'secret', basicEncoding: 'raw' } as const;

  function xsuaa(overrides: Partial<McpAuthOptions>): McpAuthOptions {
    return options({ authType: 'xsuaa', credential: true, ...overrides });
  }

  describe('the flags, checked before anything is written', () => {
    async function refused(o: McpAuthOptions, flag: string) {
      await expect(run(o)).rejects.toThrow(flag);
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(fs.existsSync(outDir)).toBe(false);
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(0);
    }

    it('secret without --basic-encoding names it', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key({ mixed: true }),
          clientAuth: 'secret',
        }),
        '--basic-encoding',
      );
    });

    it('--basic-encoding without --client-auth secret is refused', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key({ mixed: true }),
          ...certificate,
          basicEncoding: 'raw',
        }),
        '--basic-encoding',
      );
    });

    it('certificate without --cert-path names it', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key(),
          clientAuth: 'certificate',
          keyPath: CLIENT_KEY_PATH,
        }),
        '--cert-path',
      );
    });

    it('certificate without --key-path names it', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key(),
          clientAuth: 'certificate',
          certPath: CLIENT_CRT_PATH,
        }),
        '--key-path',
      );
    });

    it('--cert-path / --key-path without --client-auth certificate are refused', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key({ mixed: true }),
          ...secret,
          certPath: CLIENT_CRT_PATH,
        }),
        '--cert-path',
      );
    });

    it('a --cert-path with no file is refused naming the flag', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key(),
          ...certificate,
          certPath: path.join(root, 'missing.crt'),
        }),
        '--cert-path',
      );
    });

    it('a --key-path with no file is refused naming the flag', async () => {
      await refused(
        xsuaa({
          serviceKeyPath: x509Key(),
          ...certificate,
          keyPath: path.join(root, 'missing.key'),
        }),
        '--key-path',
      );
    });

    it('an x509 key with no flag names --client-auth', async () => {
      await expect(run(xsuaa({ serviceKeyPath: x509Key() }))).rejects.toThrow(
        'carries a client certificate and no client secret: state how the client authenticates with --client-auth',
      );
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(0);
    });
  });

  describe('certificate', () => {
    it('--credential: client_credentials at certurl with the certificate; the .env holds absolute paths and certurl, no secret, no PEM', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509', false));
      const relative = (file: string) => path.relative(process.cwd(), file);
      await expect(
        run(
          xsuaa({
            serviceKeyPath: x509Key({ mixed: true }),
            ...certificate,
            certPath: relative(CLIENT_CRT_PATH),
            keyPath: relative(CLIENT_KEY_PATH),
          }),
        ),
      ).resolves.toBe(0);

      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(1);
      const [request] = certServer.requests;
      expect(request.path).toBe('/oauth/token');
      expect(request.form.grant_type).toBe('client_credentials');
      expect(request.form.client_id).toBe('key-client');
      expect(request.form).not.toHaveProperty('client_secret');
      expect(request.authorization).toBeUndefined();
      expect(request.clientCertificate).toBe('mcp-auth-test-client');

      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys.XSUAA_AUTH_TYPE).toBe('jwt');
      expect(keys.XSUAA_GRANT_TYPE).toBe('client_credentials');
      expect(keys.XSUAA_UAA_URL).toBe(`${server.url}/authentication`);
      expect(keys.XSUAA_UAA_CLIENT_ID).toBe('key-client');
      expect(keys.XSUAA_UAA_CLIENT_CERT_PATH).toBe(CLIENT_CRT_PATH);
      expect(keys.XSUAA_UAA_CLIENT_KEY_PATH).toBe(CLIENT_KEY_PATH);
      expect(keys.XSUAA_UAA_CERT_URL).toBe(certServer.url);
      expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_SECRET');
      expect(jwtName(keys.XSUAA_JWT_TOKEN)).toBe('x509-access-1');
      expect(pemCopies()).toEqual([]);
    });

    it('authorization_code: the code exchanged at certurl with the certificate; --env renews with the stored refresh token; a fresh broker over the output reuses the token', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      const o = options({
        serviceKeyPath: x509Key(),
        serviceUrl: SERVICE_URL,
        ...certificate,
      });
      await expect(run(o)).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      expect(certServer.requests[0].form).toEqual(
        expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'the-code',
        }),
      );
      expect(certServer.requests[0].clientCertificate).toBe(
        'mcp-auth-test-client',
      );
      expect(readEnvKeys(path.join(outDir, `${DEST}.env`)).SAP_GRANT_TYPE).toBe(
        'authorization_code',
      );

      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      strategyCalls = 0;
      await expect(run({ ...o, envFilePath: previous })).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(certServer.requests.at(-1)?.form).toEqual(
        expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'x509-refresh-1',
        }),
      );
      expect(certServer.requests.at(-1)?.clientCertificate).toBe(
        'mcp-auth-test-client',
      );
      expect(pemCopies()).toEqual([]);

      // A fresh broker over the output builds the certificate destination and
      // presents the stored token without a new request.
      const before = certServer.requests.length;
      const { keyStore, sessionStore } = storesOf('abap');
      const broker = new AuthBroker({
        sessionStore,
        serviceKeyStore: keyStore,
        clientAuthentication: fromServiceKeyCertificate(),
        authorization: () => ({
          authorize: async () => {
            throw new Error('no login expected');
          },
        }),
      });
      const provider = (await broker.getProvider(DEST)) as unknown as {
        getTokens: () => Promise<{ authorizationToken: string }>;
      };
      const reused = await provider.getTokens();
      expect(jwtName(reused.authorizationToken)).toBe('x509-access-2');
      expect(certServer.requests).toHaveLength(before);
    });

    it('--type xsuaa with no service URL: an --env rerun refreshes with the stored refresh token (Ruling 14)', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      const o = options({
        authType: 'xsuaa',
        serviceKeyPath: x509Key(),
        ...certificate,
      });
      await expect(run(o)).resolves.toBe(0);
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys).not.toHaveProperty('XSUAA_MCP_URL');
      expect(keys.XSUAA_ISSUED_FOR ?? '').toBe('');

      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      strategyCalls = 0;
      await expect(run({ ...o, envFilePath: previous })).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(certServer.requests.at(-1)?.form).toEqual(
        expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'x509-refresh-1',
        }),
      );
    });

    it('--type abap writes the SAP_UAA_* certificate variables', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509', false));
      await expect(
        run(
          options({
            serviceKeyPath: x509Key(),
            credential: true,
            serviceUrl: SERVICE_URL,
            ...certificate,
          }),
        ),
      ).resolves.toBe(0);
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys.SAP_UAA_CLIENT_CERT_PATH).toBe(CLIENT_CRT_PATH);
      expect(keys.SAP_UAA_CLIENT_KEY_PATH).toBe(CLIENT_KEY_PATH);
      expect(keys.SAP_UAA_CERT_URL).toBe(certServer.url);
      expect(keys).not.toHaveProperty('SAP_UAA_CLIENT_SECRET');
      expect(certServer.requests[0].clientCertificate).toBe(
        'mcp-auth-test-client',
      );
    });

    it('--format json carries the client, the paths and certurl — never PEM', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509', false));
      const output = path.join(outDir, `${DEST}.json`);
      await expect(
        run(
          xsuaa({
            serviceKeyPath: x509Key(),
            ...certificate,
            format: 'json',
            outputFile: output,
          }),
        ),
      ).resolves.toBe(0);
      const json = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(json).toEqual({
        accessToken: json.accessToken,
        uaaUrl: `${server.url}/authentication`,
        uaaClientId: 'key-client',
        uaaClientCertPath: CLIENT_CRT_PATH,
        uaaClientKeyPath: CLIENT_KEY_PATH,
        uaaCertUrl: certServer.url,
      });
      expect(pemCopies()).toEqual([]);
    });
  });

  describe('an ABAP-format key carrying a certificate', () => {
    it('with no flag, answers as the same key without one: the same means — the service URL and the secret client', async () => {
      server.answer('/oauth/token', tokenAnswer('cc', false));
      const abapFormat = (extra: object) => ({
        uaa: {
          url: server.url,
          clientid: 'key-client',
          clientsecret: CLIENT_SECRET,
          ...extra,
        },
        abap: { url: SERVICE_URL, client: '100' },
      });
      const meansOf = async (credentials: object, wrapped: boolean) => {
        fs.rmSync(outDir, { recursive: true, force: true });
        const file = path.join(keysDir, `${DEST}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify(wrapped ? detailsOf(credentials) : credentials),
        );
        await expect(
          run(options({ serviceKeyPath: file, credential: true })),
        ).resolves.toBe(0);
        const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
        return Object.fromEntries(
          meansKeys('abap')
            .filter((key) => key in keys)
            .map((key) => [key, keys[key]]),
        );
      };
      const before = await meansOf(abapFormat({}), false);
      expect(before).toEqual(
        expect.objectContaining({
          SAP_URL: SERVICE_URL,
          SAP_UAA_URL: server.url,
          SAP_UAA_CLIENT_ID: 'key-client',
          SAP_UAA_CLIENT_SECRET: CLIENT_SECRET,
        }),
      );
      for (const wrapped of [false, true]) {
        const carrying = abapFormat({
          certificate: CLIENT_CRT,
          key: CLIENT_KEY,
          certurl: certServer.url,
        });
        expect(await meansOf(carrying, wrapped)).toEqual(before);
      }
      expect(server.requests.map((r) => r.form.client_secret)).toEqual([
        CLIENT_SECRET,
        CLIENT_SECRET,
        CLIENT_SECRET,
      ]);
      expect(pemCopies()).toEqual([]);
    });

    it('with --client-auth certificate, its certificate client is read: XsuaaServiceKeyStore is the store that answers one', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509', false));
      const file = path.join(keysDir, `${DEST}.json`);
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
          abap: { url: SERVICE_URL },
        }),
      );
      await expect(
        run(
          options({ serviceKeyPath: file, credential: true, ...certificate }),
        ),
      ).resolves.toBe(0);
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys.SAP_URL).toBe(SERVICE_URL);
      expect(keys.SAP_UAA_CERT_URL).toBe(certServer.url);
      expect(certServer.requests[0].clientCertificate).toBe(
        'mcp-auth-test-client',
      );
    });
  });

  describe('secret', () => {
    it('a mixed key: client_secret_basic with the stated encoding; the .env holds the secret and no certificate', async () => {
      server.answer('/authentication/oauth/token', tokenAnswer('cc', false));
      await expect(
        run(xsuaa({ serviceKeyPath: x509Key({ mixed: true }), ...secret })),
      ).resolves.toBe(0);
      expect(certServer.requests).toHaveLength(0);
      const [request] = server.requests;
      expect(request.form.grant_type).toBe('client_credentials');
      expect(request.form).not.toHaveProperty('client_secret');
      expect(request.authorization).toBe(
        `Basic ${Buffer.from(`key-client:${CLIENT_SECRET}`).toString('base64')}`,
      );
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys.XSUAA_UAA_CLIENT_SECRET).toBe(CLIENT_SECRET);
      expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_CERT_PATH');
      expect(keys).not.toHaveProperty('XSUAA_UAA_CERT_URL');
      expect(pemCopies()).toEqual([]);
    });

    it('an x509 key without a secret is refused', async () => {
      await expect(
        run(xsuaa({ serviceKeyPath: x509Key(), ...secret })),
      ).rejects.toThrow('a client certificate needs --client-auth certificate');
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests).toHaveLength(0);
    });
  });

  describe('no copy of a key carrying a certificate, whatever the flags', () => {
    const flags = {
      'no flag': {},
      secret,
      certificate,
    } as const;
    for (const [kind, mixed] of [
      ['x509', false],
      ['mixed', true],
    ] as const) {
      for (const [flag, stated] of Object.entries(flags)) {
        for (const outcome of ['granted', 'refused'] as const) {
          it(`a wrapped ${kind} key, ${flag}, ${outcome}: no PEM under the work or output directory`, async () => {
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
            await run(
              xsuaa({ serviceKeyPath: x509Key({ mixed }), ...stated }),
            ).catch(() => undefined);
            expect(pemCopies()).toEqual([]);
            expect(fs.existsSync(path.join(workDir, 'service-keys'))).toBe(
              false,
            );
          });
        }
      }
    }

    it('a certificate under `uaa`, a private key alone or a certificate alone is not copied either', async () => {
      server.answer('/authentication/oauth/token', tokenAnswer('cc', false));
      const client = {
        url: `${server.url}/authentication`,
        clientid: 'key-client',
        clientsecret: CLIENT_SECRET,
      };
      for (const credentials of [
        { uaa: { ...client, certificate: CLIENT_CRT, key: CLIENT_KEY } },
        { ...client, key: CLIENT_KEY },
        { ...client, certificate: CLIENT_CRT },
      ]) {
        const file = path.join(keysDir, `${DEST}.json`);
        fs.writeFileSync(file, JSON.stringify(detailsOf(credentials)));
        await run(xsuaa({ serviceKeyPath: file })).catch(() => undefined);
        expect(pemCopies()).toEqual([]);
        expect(fs.existsSync(path.join(workDir, 'service-keys'))).toBe(false);
      }
    });

    it('a wrapped secret-only key keeps the temporary unwrapped copy', async () => {
      server.answer('/authentication/oauth/token', tokenAnswer('cc', false));
      await expect(
        run(xsuaa({ serviceKeyPath: wrappedSecretKey() })),
      ).resolves.toBe(0);
      const copy = path.join(workDir, 'service-keys', `${DEST}.json`);
      expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({
        url: `${server.url}/authentication`,
        clientid: 'key-client',
        clientsecret: CLIENT_SECRET,
      });
    });
  });
});
