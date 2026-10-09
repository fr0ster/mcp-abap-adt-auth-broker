/**
 * `mcp-auth oidc | saml2-pure` (2.x's `mcp-sso`) end to end, each case's
 * options parsed from its `mcp-auth` form, one case per command row of the README's
 * *What each command writes* table, against a local
 * token endpoint — no browser, no identity provider, no SAP system.
 *
 * Each case pins what the command writes and where:
 * - the means, read back through the key store (`EnvDestinationStore`);
 * - the secret alone in the session store: every session write carries only
 *   the secret and its binding, never a means field and never the client
 *   secret; every key of the output file belongs to one store or the other;
 * - the destination builds: a broker over the output, as a server composes it,
 *   gets a provider from `getProvider` that presents the stored secret without
 *   a new login.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthBroker, bindingOf } from '@mcp-abap-adt/auth-broker';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import type { McpSsoOptions } from '../mcpSsoConfig';
import { runMcpSso } from '../runMcpSso';
import { parseSubcommandArgs, type SsoSubcommand } from '../subcommandArgs';
import {
  CLIENT_CN,
  CLIENT_CRT,
  CLIENT_CRT_PATH,
  CLIENT_KEY_PATH,
  startCertServer,
  trustCertServer,
} from './helpers/certificates';
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

const DEST = 'sso';
const SERVICE_URL = 'https://abap.example.com';

let server: LocalServer;
let root: string;
let workDir: string;
let outDir: string;
let logger: ILogger & { info: jest.Mock };
let sessionWrites: Array<{ destination: string; config: object }>;
let spies: jest.SpyInstance[];

beforeEach(async () => {
  server = await startLocalServer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-run-'));
  workDir = path.join(root, 'work');
  outDir = path.join(root, 'out');
  fs.mkdirSync(workDir);
  logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  sessionWrites = [];
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never),
  ];
  // Every session write the run makes, passed through to the real store.
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
          sessionWrites.push({ destination, config: config as object });
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

function options(overrides: Partial<McpSsoOptions>): McpSsoOptions {
  return {
    authType: 'abap',
    format: 'env',
    outputFile: path.join(outDir, `${DEST}.env`),
    serviceUrl: SERVICE_URL,
    ...overrides,
  };
}

/**
 * What `mcp-auth <subcommand> <args>` parses to — the protocol and flow the
 * subcommand names — so every case runs an `mcp-auth` form.
 */
function form(subcommand: SsoSubcommand, args: string[] = []): McpSsoOptions {
  const parsed = parseSubcommandArgs(subcommand, [
    '--output',
    path.join(outDir, `${DEST}.env`),
    ...args,
  ]);
  if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
  return parsed.options;
}

const run = (o: McpSsoOptions) => runMcpSso(o, { logger, workDir });

function keyStoreOf(type: 'abap' | 'xsuaa') {
  return type === 'abap'
    ? new EnvDestinationStore(outDir)
    : new EnvDestinationStore(outDir, { variables: XSUAA_DESTINATION_VARS });
}

function sessionStoreOf(type: 'abap' | 'xsuaa') {
  return type === 'abap'
    ? new AbapSessionStore(outDir)
    : new XsuaaSessionStore(outDir);
}

/**
 * The split, whatever the row: the file holds only keys one of the two stores
 * owns; every session write carried the secret alone; the session store
 * answers nothing but the secret. A client secret, when one was given, is in
 * the file once — under the means key — and in no session write.
 */
async function expectSplit(type: 'abap' | 'xsuaa', clientSecret?: string) {
  const file = path.join(outDir, `${DEST}.env`);
  const keys = readEnvKeys(file);
  const owned = new Set([...meansKeys(type), ...sessionKeys(type)]);
  expect(Object.keys(keys).filter((key) => !owned.has(key))).toEqual([]);
  for (const { config } of sessionWrites) {
    expect(
      Object.keys(config).filter((field) => !SECRET_FIELDS.includes(field)),
    ).toEqual([]);
    if (clientSecret) {
      expect(JSON.stringify(config)).not.toContain(clientSecret);
    }
  }
  const secret = await sessionStoreOf(type).loadSession(DEST);
  expect(
    Object.keys(secret ?? {}).filter((field) => !SECRET_FIELDS.includes(field)),
  ).toEqual([]);
  if (clientSecret) {
    const holding = Object.entries(keys)
      .filter(([, value]) => value.includes(clientSecret))
      .map(([key]) => key);
    expect(holding).toEqual([
      type === 'abap' ? 'SAP_UAA_CLIENT_SECRET' : 'XSUAA_UAA_CLIENT_SECRET',
    ]);
  }
}

/** A broker over the output, as a server builds it: the provider presents the stored token. */
async function expectServedFromOutput(
  type: 'abap' | 'xsuaa',
  expectedToken: string,
) {
  // `expectedToken` names the JWT the endpoint issued.
  const before = server.requests.length;
  // Collaborators that refuse to be used: a login would reach one.
  const noLogin = {
    authorize: async () => {
      throw new Error('no login expected');
    },
  };
  const broker = new AuthBroker({
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
    sessionStore: sessionStoreOf(type),
    serviceKeyStore: keyStoreOf(type),
    authorization: () => noLogin,
    oidcAuthorization: () => noLogin as never,
    deviceCodePresenter: () => ({
      present: async () => {
        throw new Error('no login expected');
      },
    }),
  });
  const provider = (await broker.getProvider(DEST)) as unknown as {
    getTokens: () => Promise<{ authorizationToken: string }>;
  };
  const result = await provider.getTokens();
  expect(jwtName(result.authorizationToken)).toBe(expectedToken);
  expect(server.requests.length).toBe(before);
}

describe('mcp-auth oidc --flow browser (--code)', () => {
  it('writes jwt / oidc_authorization_code with the endpoints and a public client as ""', async () => {
    server.answer('/token', tokenAnswer('oidc'));
    const code = await run(
      options({
        ...form('oidc', ['--flow', 'browser']),
        clientId: 'public-client',
        // An issuer: what a stored token is bound to, beside the client.
        issuerUrl: server.url,
        authorizationEndpoint: `${server.url}/authorize`,
        tokenEndpoint: `${server.url}/token`,
        scopes: ['openid', 'offline_access'],
        code: 'the-code',
      }),
    );
    expect(code).toBe(0);
    expect(server.requests.map((r) => r.form.code)).toEqual(['the-code']);

    const means = await keyStoreOf('abap').getConnectionConfig(DEST);
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'oidc_authorization_code',
        serviceUrl: SERVICE_URL,
        oidcAuthorizationEndpoint: `${server.url}/authorize`,
        oidcTokenEndpoint: `${server.url}/token`,
        oidcScopes: ['openid', 'offline_access'],
      }),
    );
    const client = await keyStoreOf('abap').getAuthorizationConfig(DEST);
    expect(client).toEqual(
      expect.objectContaining({
        uaaClientId: 'public-client',
        uaaClientSecret: '',
      }),
    );
    expect(readEnvKeys(path.join(outDir, `${DEST}.env`))).not.toHaveProperty(
      'SAP_UAA_CLIENT_SECRET',
      '__public__',
    );
    const secret = await sessionStoreOf('abap').loadSession(DEST);
    expect(jwtName(secret?.authorizationToken)).toBe('oidc-access-1');
    expect(secret?.refreshToken).toBe('oidc-refresh-1');
    await expectSplit('abap');
    await expectServedFromOutput('abap', 'oidc-access-1');
  });
});

describe('mcp-auth oidc --flow device', () => {
  it('writes jwt / device_code; the presenter shows the code on stderr', async () => {
    const stderrWrite = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    spies.push(stderrWrite);
    server.answer('/device', {
      body: {
        device_code: 'dev-code',
        user_code: 'USER-CODE-42',
        verification_uri: 'https://idp.example/activate',
        interval: 1,
        expires_in: 600,
      },
    });
    server.answer('/token', tokenAnswer('device'));
    const code = await run(
      options({
        serviceUrl: undefined,
        ...form('oidc', ['--flow', 'device', '--type', 'xsuaa']),
        clientId: 'confidential',
        clientSecret: 'the-client-secret',
        deviceAuthorizationEndpoint: `${server.url}/device`,
        tokenEndpoint: `${server.url}/token`,
      }),
    );
    expect(code).toBe(0);
    // Given no logger, the presenter shows the code on stderr, whatever the
    // log level; never through the CLI's logger.
    expect(
      stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join(''),
    ).toContain('USER-CODE-42');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      'USER-CODE-42',
    );
    const means = await keyStoreOf('xsuaa').getConnectionConfig(DEST);
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'device_code',
        oidcDeviceAuthorizationEndpoint: `${server.url}/device`,
        oidcTokenEndpoint: `${server.url}/token`,
      }),
    );
    await expectSplit('xsuaa', 'the-client-secret');
  });
});

describe('mcp-auth oidc --flow password', () => {
  it('writes jwt / password with the user and password as means', async () => {
    server.answer('/token', tokenAnswer('pw'));
    const code = await run(
      options({
        ...form('oidc', ['--flow', 'password']),
        clientId: 'cli',
        clientSecret: 'cli-secret',
        issuerUrl: server.url,
        tokenEndpoint: `${server.url}/token`,
        username: 'alice',
        password: 'alice-password',
      }),
    );
    expect(code).toBe(0);
    expect(server.requests[0]!.form).toEqual(
      expect.objectContaining({
        grant_type: 'password',
        username: 'alice',
        password: 'alice-password',
      }),
    );
    const means = await keyStoreOf('abap').getConnectionConfig(DEST);
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'password',
        username: 'alice',
        password: 'alice-password',
      }),
    );
    await expectSplit('abap', 'cli-secret');
    await expectServedFromOutput('abap', 'pw-access-1');
  });
});

describe('mcp-auth oidc over an --output written for another grant', () => {
  it("means from flags are a fresh login: none of the other grant's means is kept — the password goes", async () => {
    server.answer('/token', tokenAnswer('pw'));
    await run(
      options({
        ...form('oidc', ['--flow', 'password']),
        clientId: 'cli',
        issuerUrl: server.url,
        tokenEndpoint: `${server.url}/token`,
        username: 'alice',
        password: 'alice-password',
      }),
    );
    server.answer('/tx', tokenAnswer('tx'));
    await expect(
      run(
        options({
          ...form('oidc', ['--flow', 'token_exchange']),
          clientId: 'cli',
          tokenEndpoint: `${server.url}/tx`,
          subjectToken: 'the-subject-token',
        }),
      ),
    ).resolves.toBe(0);
    const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
    expect(keys.SAP_GRANT_TYPE).toBe('token_exchange');
    expect(keys).not.toHaveProperty('SAP_PASSWORD');
    expect(keys).not.toHaveProperty('SAP_USERNAME');
    expect(keys).not.toHaveProperty('SAP_OIDC_ISSUER_URL');
    expect(keys.SAP_URL).toBe(SERVICE_URL);
  });
});

describe('mcp-auth oidc --flow password --passcode', () => {
  it('writes jwt / passcode: the client only, never the one-time code', async () => {
    server.answer('/oauth/token', tokenAnswer('passcode'));
    const code = await run(
      options({
        ...form('oidc', ['--flow', 'password']),
        uaaUrl: server.url,
        clientId: 'cf',
        passcode: 'ONE-TIME-123',
      }),
    );
    expect(code).toBe(0);
    expect(server.requests[0]!.form).toEqual(
      expect.objectContaining({
        grant_type: 'password',
        passcode: 'ONE-TIME-123',
      }),
    );
    expect(server.requests[0]!.form.username).toBeUndefined();
    const means = await keyStoreOf('abap').getConnectionConfig(DEST);
    expect(means).toEqual(
      expect.objectContaining({ authType: 'jwt', grantType: 'passcode' }),
    );
    expect(means?.password).toBeUndefined();
    expect(means?.username).toBeUndefined();
    expect(
      fs.readFileSync(path.join(outDir, `${DEST}.env`), 'utf8'),
    ).not.toContain('ONE-TIME-123');
    expect(await keyStoreOf('abap').getAuthorizationConfig(DEST)).toEqual(
      expect.objectContaining({
        uaaUrl: server.url,
        uaaClientId: 'cf',
        uaaClientSecret: '',
      }),
    );
    await expectSplit('abap');
  });
});

describe('mcp-auth oidc --flow token_exchange', () => {
  it('writes jwt / token_exchange with the subject token and its type', async () => {
    server.answer('/token', tokenAnswer('tx'));
    const code = await run(
      options({
        ...form('oidc', ['--flow', 'token_exchange']),
        clientId: 'cli',
        clientSecret: 'cli-secret',
        tokenEndpoint: `${server.url}/token`,
        subjectToken: 'the-subject-token',
        audience: 'abap',
        scope: 'openid',
      }),
    );
    expect(code).toBe(0);
    const means = await keyStoreOf('abap').getConnectionConfig(DEST);
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'token_exchange',
        oidcSubjectToken: 'the-subject-token',
        oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        oidcAudience: 'abap',
        oidcScopes: ['openid'],
      }),
    );
    await expectSplit('abap', 'cli-secret');
  });
});

describe('mcp-auth saml2-pure --cookie', () => {
  it('writes saml / none and the handed-over cookies, bound to the service URL', async () => {
    const code = await run(
      options({
        ...form('saml2-pure'),
        cookie: 'SAP_SESSIONID=abc; MYSAPSSO2=def',
      }),
    );
    expect(code).toBe(0);
    const means = await keyStoreOf('abap').getConnectionConfig(DEST);
    expect(means).toEqual({
      authType: 'saml',
      grantType: 'none',
      serviceUrl: SERVICE_URL,
    });
    expect(sessionWrites.map((w) => w.config)).toEqual([
      {
        sessionCookies: 'SAP_SESSIONID=abc; MYSAPSSO2=def',
        refreshToken: '',
        issuedFor: 'https://abap.example.com:443',
        issuedBy: `mcp-abap-adt-binding/2;saml/none${';'.repeat(12)}`,
      },
    ]);
    await expectSplit('abap');
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      sessionStore: sessionStoreOf('abap'),
      serviceKeyStore: keyStoreOf('abap'),
    });
    const provider = await broker.getProvider(DEST);
    const headers: Record<string, string> = {};
    await provider.authorize({
      header: (name: string, value: string) => {
        headers[name] = value;
      },
      cookies: (value: string) => {
        headers.Cookie = value;
      },
    } as never);
    expect(Object.values(headers).join(' ')).toContain('SAP_SESSIONID=abc');
  });
});

describe('mcp-auth saml2-pure --cookie, the SAP client stated in --env', () => {
  it('binds the cookies to the resource with its client: getProvider presents them', async () => {
    const previous = path.join(root, `${DEST}.env`);
    fs.writeFileSync(previous, `SAP_URL=${SERVICE_URL}\nSAP_CLIENT=100\n`);
    const code = await run(
      options({
        envFilePath: previous,
        serviceUrl: undefined,
        ...form('saml2-pure'),
        cookie: 'SAP_SESSIONID=abc',
      }),
    );
    expect(code).toBe(0);
    // The binding the broker computes — never one the CLI composes.
    expect(sessionWrites.map((w) => w.config)).toEqual([
      {
        sessionCookies: 'SAP_SESSIONID=abc',
        // The store merges: SAML has no refresh token, and one stored beside
        // earlier cookies or a token is not this credential's (§5.2).
        refreshToken: '',
        issuedFor: 'https://abap.example.com:443?sap-client=100',
        issuedBy: `mcp-abap-adt-binding/2;saml/none${';'.repeat(12)}`,
      },
    ]);
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      sessionStore: sessionStoreOf('abap'),
      serviceKeyStore: keyStoreOf('abap'),
    });
    await expect(broker.getProvider(DEST)).resolves.toBeDefined();
  });
});

describe('mcp-auth saml2-pure --cookie over a pre-existing session bound to other means (§13.1, the CLI path)', () => {
  it('the store holds the new record and no refresh token; a restart is not seeded with the old one', async () => {
    const previous = path.join(root, `${DEST}.env`);
    const OLD_RECORD = `mcp-abap-adt-binding/2;jwt/authorization_code${';'.repeat(12)}`;
    fs.writeFileSync(
      previous,
      [
        `SAP_URL=${SERVICE_URL}`,
        'SAP_CLIENT=100',
        // A cookie destination whose stored secret is bound to other means.
        'SAP_AUTH_TYPE=saml',
        'SAP_GRANT_TYPE=none',
        'SAP_JWT_TOKEN=T0-OLD-TOKEN',
        'SAP_REFRESH_TOKEN=R-OLD-MARKER',
        'SAP_ISSUED_FOR=https://other.example.com:443',
        `SAP_ISSUED_BY=${OLD_RECORD}`,
        '',
      ].join('\n'),
    );
    const code = await run(
      options({
        envFilePath: previous,
        serviceUrl: undefined,
        ...form('saml2-pure'),
        cookie: 'SAP_SESSIONID=new',
      }),
    );
    expect(code).toBe(0);

    // The resulting store state, not the submitted write.
    const session = await sessionStoreOf('abap').loadSession(DEST);
    expect(session).toEqual(
      expect.objectContaining({
        sessionCookies: 'SAP_SESSIONID=new',
        issuedFor: 'https://abap.example.com:443?sap-client=100',
        issuedBy: `mcp-abap-adt-binding/2;saml/none${';'.repeat(12)}`,
      }),
    );
    expect(session?.refreshToken ?? '').toBe('');
    const file = fs.readFileSync(path.join(outDir, `${DEST}.env`), 'utf8');
    expect(file).not.toContain('R-OLD-MARKER');
    expect(file).not.toContain(OLD_RECORD);

    // A restart: a fresh broker over the same files is seeded with no
    // refresh token — none is left to seed it with.
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      sessionStore: sessionStoreOf('abap'),
      serviceKeyStore: keyStoreOf('abap'),
    });
    await expect(broker.getProvider(DEST)).resolves.toBeDefined();
    const reread = await sessionStoreOf('abap').loadSession(DEST);
    expect(reread?.refreshToken ?? '').toBe('');
    expect(JSON.stringify(reread)).not.toContain('R-OLD-MARKER');
  });
});

describe('a secret the store does not take', () => {
  it('fails the run with persisting-tokens, after flush(): no output written', async () => {
    server.answer('/token', tokenAnswer('lost'));
    jest
      .spyOn(AbapSessionStore.prototype, 'saveSession')
      .mockRejectedValue(new Error('disk full'));
    const thrown = await run(
      options({
        ...form('oidc', ['--flow', 'password']),
        clientId: 'cli',
        tokenEndpoint: `${server.url}/token`,
        username: 'alice',
        password: 'alice-password',
      }),
    ).catch((error: unknown) => error);
    expect(readFailure(thrown, 'unfamiliar-error').facts).toEqual(
      expect.objectContaining({ operation: 'persisting-tokens' }),
    );
    expect(String(thrown)).not.toContain('disk full');
    expect(server.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(outDir, `${DEST}.env`))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('The session was not stored'),
    );
  });
});

describe('a login that throws a falsy value', () => {
  it.each([[undefined], [0], ['']])(
    'getTokens() rejecting with %p fails the run: no output written',
    async (value) => {
      // The broker's own copy of auth-providers: the workspace installs one
      // per package, so the CLI's import would be another class.
      const brokersProviders = require(
        require.resolve('@mcp-abap-adt/auth-providers', {
          paths: [path.dirname(require.resolve('@mcp-abap-adt/auth-broker'))],
        }),
      ) as typeof import('@mcp-abap-adt/auth-providers');
      const spy = jest
        .spyOn(brokersProviders.BaseTokenProvider.prototype, 'getTokens')
        .mockRejectedValue(value);
      try {
        const outcome = await run(
          options({
            ...form('oidc', ['--flow', 'password']),
            clientId: 'cli',
            tokenEndpoint: `${server.url}/token`,
            username: 'alice',
            password: 'alice-password',
          }),
        ).then(
          (code) => ({ resolved: code }),
          (thrown: unknown) => ({ rejected: thrown }),
        );
        expect(outcome).toEqual({ rejected: value });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(outDir, `${DEST}.env`))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    },
  );
});

describe('a refused login', () => {
  it('leaves an existing output byte for byte as it was', async () => {
    const output = path.join(outDir, `${DEST}.env`);
    fs.mkdirSync(outDir, { recursive: true });
    const before = "SAP_URL=https://old.example.com\nSAP_PASSWORD='old'\n";
    fs.writeFileSync(output, before);
    server.answer('/token', { status: 401, body: { error: 'invalid_grant' } });
    await expect(
      run(
        options({
          ...form('oidc', ['--flow', 'password']),
          clientId: 'cli',
          tokenEndpoint: `${server.url}/token`,
          username: 'alice',
          password: 'wrong',
        }),
      ),
    ).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe(before);
  });
});

describe('a file that is not JSON', () => {
  const MARKER = 'leaked-marker-7f3a';

  /** Everything the run printed, and the error it ended with. */
  async function outcome(o: McpSsoOptions) {
    let thrown: unknown;
    await run(o).catch((error) => {
      thrown = error;
    });
    const printed = [console.log, console.error]
      .flatMap((fn) => (fn as jest.Mock).mock.calls.flat())
      .map(String)
      .join('\n');
    return { thrown: thrown as Error, printed };
  }

  it('--config: refused in fixed words, nothing of the file on the console', async () => {
    const file = path.join(root, 'provider.json');
    fs.writeFileSync(file, `{"clientSecret": "${MARKER}", oops`);
    const { thrown, printed } = await outcome(options({ configPath: file }));
    expect(thrown.message).toBe('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(
      `❌ The config file ${file} cannot be read as JSON`,
    );
    expect(printed).not.toContain(MARKER);
    expect(server.requests).toHaveLength(0);
  });

  it('--service-key: the run fails, nothing of the file on the console or in the error', async () => {
    const file = path.join(root, `${DEST}.json`);
    fs.writeFileSync(file, `{"clientsecret": "${MARKER}", oops`);
    const { thrown, printed } = await outcome(
      options({
        ...form('oidc', ['--flow', 'password', '--type', 'xsuaa']),
        serviceKeyPath: file,
        username: 'alice',
        password: 'pw',
      }),
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(printed).not.toContain(MARKER);
    expect(String(thrown.message)).not.toContain(MARKER);
    expect(String(thrown.stack)).not.toContain(MARKER);
    expect(server.requests).toHaveLength(0);
  });
});

describe('the browser is mapped only for a login that opens one', () => {
  const onFreebsd = (o: McpSsoOptions) =>
    runMcpSso(o, { logger, workDir, platform: 'freebsd' });

  it('a password login on a platform with no launcher runs, whatever --browser says', async () => {
    server.answer('/token', tokenAnswer('pw'));
    for (const browser of [undefined, 'auto', 'chrome']) {
      fs.rmSync(outDir, { recursive: true, force: true });
      await expect(
        onFreebsd(
          options({
            ...form('oidc', ['--flow', 'password']),
            clientId: 'cli',
            clientSecret: 'cli-secret',
            tokenEndpoint: `${server.url}/token`,
            username: 'user',
            password: 'pass',
            browser,
          }),
        ),
      ).resolves.toBe(0);
    }
  });

  it('an OIDC browser login there is refused before anything is written', async () => {
    await expect(
      onFreebsd(
        options({
          ...form('oidc', ['--flow', 'browser']),
          clientId: 'cli',
          authorizationEndpoint: `${server.url}/authorize`,
          tokenEndpoint: `${server.url}/token`,
        }),
      ),
    ).rejects.toThrow('process.exit(1)');
    expect(console.error).toHaveBeenCalledWith(
      '❌ --browser auto has no launcher on this platform; use --browser none',
    );
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });
});

describe('a --config file that does not name the subcommand', () => {
  it.each([
    ['no protocol', { flow: 'device', clientId: 'c' }, 'states no protocol'],
    [
      'a provider without a protocol',
      { provider: { flow: 'device' } },
      'states no protocol',
    ],
    [
      'another subcommand',
      { protocol: 'saml2', flow: 'pure' },
      'names another subcommand',
    ],
    ['no JSON object', [1, 2], 'holds no JSON object'],
  ])(
    '%s: refused naming --config before anything is written',
    async (_kind, content, words) => {
      const file = path.join(root, 'provider.json');
      fs.writeFileSync(file, JSON.stringify(content));
      await expect(
        run(
          options({
            ...form('oidc', ['--flow', 'device', '--config', file]),
          }),
        ),
      ).rejects.toThrow('process.exit(1)');
      const printed = (console.error as jest.Mock).mock.calls.flat().join('\n');
      expect(printed).toContain('--config');
      expect(printed).toContain(words);
      expect(fs.readdirSync(workDir)).toEqual([]);
      expect(server.requests).toHaveLength(0);
    },
  );
});

describe('--service-key whose UAA URL ends in a long run of slashes', () => {
  it('the token and authorization endpoints are composed without them', async () => {
    const uaa = `${server.url}/authentication`;
    const file = path.join(root, `${DEST}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        url: `${uaa}${'/'.repeat(100_000)}`,
        clientid: 'key-client',
        clientsecret: 'key-secret',
      }),
    );
    server.answer('/authentication/oauth/token', tokenAnswer('slashes'));
    const code = await run(
      options({
        serviceUrl: undefined,
        ...form('oidc', ['--flow', 'password', '--type', 'xsuaa']),
        serviceKeyPath: file,
        username: 'alice',
        password: 'alice-password',
      }),
    );
    expect(code).toBe(0);
    expect(server.requests.map((r) => r.path)).toEqual([
      '/authentication/oauth/token',
    ]);
    expect(await keyStoreOf('xsuaa').getConnectionConfig(DEST)).toEqual(
      expect.objectContaining({ oidcTokenEndpoint: `${uaa}/oauth/token` }),
    );
  });
});

describe('three sources, one per run (D25)', () => {
  /** What `mcp-auth <subcommand> <args>` parses to, with no --output added. */
  function bare(subcommand: SsoSubcommand, args: string[]): McpSsoOptions {
    const parsed = parseSubcommandArgs(subcommand, args);
    if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
    return parsed.options;
  }

  /** A password-grant destination from a first login, copied to `<root>/<DEST>.env`. */
  async function previousSession(): Promise<string> {
    server.answer('/token', tokenAnswer('pw'));
    await expect(
      run(
        options({
          ...form('oidc', ['--flow', 'password']),
          clientId: 'cli',
          clientSecret: 'cli-secret',
          issuerUrl: server.url,
          tokenEndpoint: `${server.url}/token`,
          username: 'alice',
          password: 'alice-password',
        }),
      ),
    ).resolves.toBe(0);
    const previous = path.join(root, `${DEST}.env`);
    fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
    return previous;
  }

  function sessionAt(file: string) {
    return new AbapSessionStore(path.dirname(file)).loadSession(
      path.basename(file, '.env'),
    );
  }

  /** The session in `file` holds a token that expired an hour ago. */
  function expire(file: string): void {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => {
        if (line.startsWith('SAP_JWT_TOKEN=')) {
          return `SAP_JWT_TOKEN=${part({ alg: 'none' })}.${part({ sub: 'old', exp: past })}.`;
        }
        if (line.startsWith('SAP_EXPIRES_AT=')) {
          return `SAP_EXPIRES_AT=${past * 1000}`;
        }
        return line;
      });
    fs.writeFileSync(file, lines.join('\n'));
  }

  it('--env alone: the means from the file — a valid token reused, no request, the file as it was', async () => {
    const previous = await previousSession();
    const before = fs.readFileSync(previous);
    const sent = server.requests.length;
    await expect(run(bare('oidc', ['--env', previous]))).resolves.toBe(0);
    expect(server.requests).toHaveLength(sent);
    expect(fs.readFileSync(previous)).toEqual(before);
  });

  it('--env alone, expired: one refresh, written back to the file', async () => {
    const previous = await previousSession();
    expire(previous);
    const sent = server.requests.length;
    await expect(
      run(bare('oidc', ['--flow', 'password', '--env', previous])),
    ).resolves.toBe(0);
    expect(server.requests.slice(sent).map((r) => r.form)).toEqual([
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'pw-refresh-1',
      }),
    ]);
    expect(jwtName((await sessionAt(previous))?.authorizationToken)).toBe(
      'pw-access-2',
    );
  });

  it('--env whose file states another grant than the flow: a usage error naming --env, nothing sent', async () => {
    const previous = await previousSession();
    const sent = server.requests.length;
    const thrown = await run(
      bare('oidc', ['--flow', 'device', '--env', previous]),
    ).catch((e: unknown) => e);
    expect((thrown as Error).message).toBe(
      `--env: the session file states the grant password, not mcp-auth oidc --flow device`,
    );
    expect(server.requests).toHaveLength(sent);
    const pure = await run(bare('saml2-pure', ['--env', previous])).catch(
      (e: unknown) => e,
    );
    expect((pure as Error).message).toBe(
      `--env: the session file states the grant password, not mcp-auth saml2-pure`,
    );
  });

  it('--service-key twice: two logins, each a new pair; the --output session is not read', async () => {
    const key = path.join(root, `${DEST}.json`);
    fs.writeFileSync(
      key,
      JSON.stringify({
        url: `${server.url}/authentication`,
        clientid: 'key-client',
        clientsecret: 'key-secret',
      }),
    );
    server.answer('/authentication/oauth/token', tokenAnswer('key'));
    const o = () =>
      options({
        serviceUrl: undefined,
        ...form('oidc', ['--flow', 'password', '--type', 'xsuaa']),
        serviceKeyPath: key,
        username: 'alice',
        password: 'alice-password',
      });
    await expect(run(o())).resolves.toBe(0);
    await expect(run(o())).resolves.toBe(0);
    expect(server.requests.map((r) => r.form.grant_type)).toEqual([
      'password',
      'password',
    ]);
    const second = await sessionStoreOf('xsuaa').loadSession(DEST);
    expect(jwtName(second?.authorizationToken)).toBe('key-access-2');
  });

  it('--destination: sessions/<name>.env as --env', async () => {
    const previous = await previousSession();
    const dests = path.join(root, 'dests');
    fs.mkdirSync(path.join(dests, 'sessions'), { recursive: true });
    const file = path.join(dests, 'sessions', `${DEST}.env`);
    fs.copyFileSync(previous, file);
    expire(file);
    const sent = server.requests.length;
    await expect(
      run(bare('oidc', ['--destination', DEST, '--destination-dir', dests])),
    ).resolves.toBe(0);
    expect(server.requests.slice(sent).map((r) => r.form.grant_type)).toEqual([
      'refresh_token',
    ]);
    expect(jwtName((await sessionAt(file))?.authorizationToken)).toBe(
      'pw-access-2',
    );
  });

  it('--destination with no session: service-keys/<name>.json, the session written to sessions/<name>.env', async () => {
    const dests = path.join(root, 'dests');
    fs.mkdirSync(path.join(dests, 'service-keys'), { recursive: true });
    fs.writeFileSync(
      path.join(dests, 'service-keys', `${DEST}.json`),
      JSON.stringify({
        url: `${server.url}/authentication`,
        clientid: 'key-client',
        clientsecret: 'key-secret',
      }),
    );
    server.answer('/authentication/oauth/token', tokenAnswer('key'));
    await expect(
      run(
        bare('oidc', [
          '--flow',
          'password',
          '--type',
          'xsuaa',
          '--username',
          'alice',
          '--password',
          'alice-password',
          '--destination',
          DEST,
          '--destination-dir',
          dests,
        ]),
      ),
    ).resolves.toBe(0);
    expect(server.requests.map((r) => r.form.grant_type)).toEqual(['password']);
    const written = await new XsuaaSessionStore(
      path.join(dests, 'sessions'),
    ).loadSession(DEST);
    expect(jwtName(written?.authorizationToken)).toBe('key-access-1');
  });
});

describe('D25: means from flags or --config are like --service-key; --env takes none', () => {
  function bare(subcommand: SsoSubcommand, args: string[]): McpSsoOptions {
    const parsed = parseSubcommandArgs(subcommand, args);
    if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
    return parsed.options;
  }

  const passwordRun = () =>
    options({
      ...form('oidc', ['--flow', 'password']),
      clientId: 'cli',
      clientSecret: 'cli-secret',
      issuerUrl: server.url,
      tokenEndpoint: `${server.url}/token`,
      username: 'alice',
      password: 'alice-password',
    });

  it('means by flags, twice into the same --output: two logins — the existing output session is not read', async () => {
    server.answer('/token', tokenAnswer('pw'));
    await expect(run(passwordRun())).resolves.toBe(0);
    await expect(run(passwordRun())).resolves.toBe(0);
    expect(server.requests.map((r) => r.form.grant_type)).toEqual([
      'password',
      'password',
    ]);
    expect(
      jwtName(
        (await sessionStoreOf('abap').loadSession(DEST))?.authorizationToken,
      ),
    ).toBe('pw-access-2');
  });

  /** A session file of the password grant, from a first login. */
  async function sessionFile(): Promise<string> {
    server.answer('/token', tokenAnswer('pw'));
    await expect(run(passwordRun())).resolves.toBe(0);
    const previous = path.join(root, `${DEST}.env`);
    fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
    return previous;
  }

  const WORDS =
    'the session file holds the means and is used as it is; state the means with --service-key or flags alone instead';

  it.each([
    ['oidc', ['--flow', 'password', '--client-id', 'other'], '--client-id'],
    ['oidc', ['--flow', 'password', '--username', 'bob'], '--username'],
    ['oidc', ['--config', './provider.json'], '--config'],
    ['saml2-pure', ['--idp-entity-id', 'https://idp'], '--idp-entity-id'],
    ['saml2-pure', ['--sp-entity-id', 'my-sp'], '--sp-entity-id'],
    [
      'saml2-pure',
      ['--cookie', 'A=1', '--service-url', 'https://x'],
      '--service-url',
    ],
    ['saml2-bearer', ['--uaa-url', 'https://uaa'], '--uaa-url'],
    ['saml2-bearer', ['--idp-initiated'], '--idp-initiated'],
  ] as [SsoSubcommand, string[], string][])(
    'mcp-auth %s %j beside --env: a usage error naming both, nothing sent or written',
    async (subcommand, args, flag) => {
      const previous = await sessionFile();
      const before = fs.readFileSync(previous);
      const sent = server.requests.length;
      const thrown = await run(
        bare(subcommand, [...args, '--env', previous]),
      ).catch((e: unknown) => e);
      expect((thrown as Error).message).toBe(`${flag} and --env: ${WORDS}`);
      expect(server.requests).toHaveLength(sent);
      expect(fs.readFileSync(previous)).toEqual(before);
    },
  );

  it('a means flag beside a session found by --destination: refused naming --destination', async () => {
    const previous = await sessionFile();
    const dests = path.join(root, 'dests');
    fs.mkdirSync(path.join(dests, 'sessions'), { recursive: true });
    fs.copyFileSync(previous, path.join(dests, 'sessions', `${DEST}.env`));
    const thrown = await run(
      bare('oidc', [
        '--client-id',
        'other',
        '--destination',
        DEST,
        '--destination-dir',
        dests,
      ]),
    ).catch((e: unknown) => e);
    expect((thrown as Error).message).toBe(
      `--client-id and --destination: ${WORDS}`,
    );
  });
});

describe('D25: --cookie hands over the secret — it is no means flag', () => {
  const RECORD = `mcp-abap-adt-binding/2;saml/none${';'.repeat(12)}`;

  function bare(args: string[]): McpSsoOptions {
    const parsed = parseSubcommandArgs('saml2-pure', args);
    if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
    return parsed.options;
  }

  it('--cookie --env alone: bound to the file’s means, SAP client included, written back into that file', async () => {
    const file = path.join(root, `${DEST}.env`);
    fs.writeFileSync(file, `SAP_URL=${SERVICE_URL}\nSAP_CLIENT=100\n`);
    await expect(
      run(bare(['--cookie', 'SAP_SESSIONID=abc', '--env', file])),
    ).resolves.toBe(0);
    const session = await new AbapSessionStore(root).loadSession(DEST);
    expect(session).toEqual(
      expect.objectContaining({
        sessionCookies: 'SAP_SESSIONID=abc',
        issuedFor: 'https://abap.example.com:443?sap-client=100',
        issuedBy: RECORD,
      }),
    );
    expect(readEnvKeys(file).SAP_CLIENT).toBe('100');
  });

  it('--cookie --destination finding a session: written back into sessions/<name>.env', async () => {
    const dests = path.join(root, 'dests');
    const sessions = path.join(dests, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `${DEST}.env`),
      `SAP_URL=${SERVICE_URL}\nSAP_CLIENT=200\n`,
    );
    await expect(
      run(
        bare([
          '--cookie',
          'SAP_SESSIONID=xyz',
          '--destination',
          DEST,
          '--destination-dir',
          dests,
        ]),
      ),
    ).resolves.toBe(0);
    expect(await new AbapSessionStore(sessions).loadSession(DEST)).toEqual(
      expect.objectContaining({
        sessionCookies: 'SAP_SESSIONID=xyz',
        issuedFor: 'https://abap.example.com:443?sap-client=200',
      }),
    );
  });
});

describe('D25 fix round: --cookie only over a cookie session; the exact --env file', () => {
  function bare(subcommand: SsoSubcommand, args: string[]): McpSsoOptions {
    const parsed = parseSubcommandArgs(subcommand, args);
    if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
    return parsed.options;
  }

  /** A populated saml2_pure destination file: system, client, IdP, ACS, trust. */
  async function samlPureFile(): Promise<string> {
    const dir = path.join(root, 'saml');
    fs.mkdirSync(dir, { recursive: true });
    await new EnvDestinationStore(dir).setDestination(DEST, {
      authType: 'saml',
      grantType: 'saml2_pure',
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      samlIdpSsoUrl: 'https://idp.example.com/sso',
      samlIdpEntityId: 'https://idp.example.com/metadata',
      samlIdpCertificates: [CLIENT_CRT],
      samlSpEntityId: 'my-sp',
      samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
      samlRelayState: 'relay',
    } as never);
    return path.join(dir, `${DEST}.env`);
  }

  it('over a populated saml2_pure file: only the auth and grant type change, every other means line kept, the cookies bound and written back', async () => {
    const file = await samlPureFile();
    const before = readEnvKeys(file);
    const beforeLines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    await expect(
      run(bare('saml2-pure', ['--cookie', 'SAP_SESSIONID=new', '--env', file])),
    ).resolves.toBe(0);
    const after = readEnvKeys(file);
    expect(after.SAP_AUTH_TYPE).toBe('saml');
    expect(after.SAP_GRANT_TYPE).toBe('none');
    for (const [key, value] of Object.entries(before)) {
      if (key === 'SAP_GRANT_TYPE') continue;
      expect([key, after[key]]).toEqual([key, value]);
    }
    const added = Object.keys(after).filter((key) => !(key in before));
    expect(added.filter((key) => !sessionKeys('abap').includes(key))).toEqual(
      [],
    );
    // No stray line: every line is a key of one store or a line kept.
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBe(beforeLines.length + added.length);
    const session = await new AbapSessionStore(path.dirname(file)).loadSession(
      DEST,
    );
    expect(session).toEqual(
      expect.objectContaining({
        sessionCookies: 'SAP_SESSIONID=new',
        issuedFor: 'https://abap.example.com:443?sap-client=100',
      }),
    );
  });

  it.each([
    ['authorization_code', 'jwt'],
    ['password', 'jwt'],
    ['saml2_bearer', 'saml'],
  ])(
    'beside a %s session: refused naming --cookie and the grant, the file untouched',
    async (grant, authType) => {
      const file = path.join(root, `${DEST}.env`);
      fs.writeFileSync(
        file,
        `SAP_URL=${SERVICE_URL}\nSAP_AUTH_TYPE=${authType}\nSAP_GRANT_TYPE=${grant}\nSAP_JWT_TOKEN=T\n`,
      );
      const before = fs.readFileSync(file);
      const thrown = await run(
        bare('saml2-pure', ['--cookie', 'A=1', '--env', file]),
      ).catch((e: unknown) => e);
      expect((thrown as Error).message).toBe(
        `--cookie and --env: the session file states the grant ${grant}; cookies are handed over only to a cookie session (saml2_pure or none)`,
      );
      expect(fs.readFileSync(file)).toEqual(before);
      expect(sessionWrites).toEqual([]);
    },
  );

  /** A password-grant session file from a first login, its token expired. */
  async function passwordSession(): Promise<string> {
    server.answer('/token', tokenAnswer('pw'));
    await expect(
      run(
        options({
          ...form('oidc', ['--flow', 'password']),
          clientId: 'cli',
          clientSecret: 'cli-secret',
          issuerUrl: server.url,
          tokenEndpoint: `${server.url}/token`,
          username: 'alice',
          password: 'alice-password',
        }),
      ),
    ).resolves.toBe(0);
    return path.join(outDir, `${DEST}.env`);
  }

  it.each([['.env'], ['session.backup']])(
    '--env reads the exact file given (%s), never an adjacent <name>.env',
    async (fileName) => {
      const source = await passwordSession();
      const dir = path.join(root, 'exact');
      fs.mkdirSync(dir);
      const file = path.join(dir, fileName);
      fs.copyFileSync(source, file);
      const decoy = path.join(
        dir,
        fileName === '.env' ? '.env.env' : 'session.env',
      );
      // Another subcommand's grant: read, it would refuse the run.
      fs.writeFileSync(
        decoy,
        'SAP_AUTH_TYPE=saml\nSAP_GRANT_TYPE=saml2_bearer\n',
      );
      const decoyBefore = fs.readFileSync(decoy);
      const before = fs.readFileSync(file);
      const sent = server.requests.length;
      await expect(run(bare('oidc', ['--env', file]))).resolves.toBe(0);
      expect(server.requests).toHaveLength(sent);
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.readFileSync(decoy)).toEqual(decoyBefore);
    },
  );

  it('an XSUAA_* file without --type xsuaa: the refusal says to add --type xsuaa', async () => {
    const file = path.join(root, `${DEST}.env`);
    fs.writeFileSync(
      file,
      'XSUAA_AUTH_TYPE=jwt\nXSUAA_GRANT_TYPE=password\nXSUAA_UAA_URL=https://uaa\n',
    );
    const thrown = await run(bare('oidc', ['--env', file])).catch(
      (e: unknown) => e,
    );
    expect((thrown as Error).message).toBe(
      '--env: the session file holds XSUAA_* variables: add --type xsuaa',
    );
  });
});

describe('D25: a session file’s client authentication, in every subcommand', () => {
  let certServer: LocalServer;
  trustCertServer();
  beforeEach(async () => {
    certServer = await startCertServer();
  });
  afterEach(async () => {
    await certServer.close();
  });

  const SECRET = 'se+cr%et';

  /**
   * A session file of `grant`, with the client authentication stated, and a
   * session bound to its means whose token expired an hour ago: the run
   * must refresh.
   */
  async function sessionFile(
    grant: 'password' | 'saml2_bearer',
    how: 'certificate' | 'form',
  ): Promise<string> {
    const dir = path.join(root, `session-${grant}-${how}`);
    fs.mkdirSync(dir, { recursive: true });
    const keyStore = new EnvDestinationStore(dir);
    const client =
      how === 'certificate'
        ? {
            uaaUrl: server.url,
            uaaClientId: 'cli',
            uaaCertUrl: certServer.url,
            uaaClientCertPath: CLIENT_CRT_PATH,
            uaaClientKeyPath: CLIENT_KEY_PATH,
          }
        : { uaaUrl: server.url, uaaClientId: 'cli', uaaClientSecret: SECRET };
    const means =
      grant === 'password'
        ? {
            authType: 'jwt',
            grantType: 'password',
            oidcTokenEndpoint: `${server.url}/oauth/token`,
            username: 'alice',
            password: 'alice-password',
          }
        : {
            authType: 'saml',
            grantType: 'saml2_bearer',
            samlIdpSsoUrl: 'https://idp.example.com/sso',
            samlIdpEntityId: 'https://idp.example.com/metadata',
            samlIdpCertificates: [CLIENT_CRT],
            samlSpEntityId: 'my-sp',
            samlAcsUrl: `${server.url}/saml/SSO`,
            samlIdpInitiated: true,
            samlTokenUrl: `${server.url}/oauth/token`,
          };
    await keyStore.setDestination(DEST, {
      serviceUrl: SERVICE_URL,
      ...means,
      ...client,
    } as never);
    const file = path.join(dir, `${DEST}.env`);
    if (how === 'form') {
      fs.appendFileSync(file, 'SAP_UAA_BASIC_ENCODING=form\n');
    }
    // The binding the broker computes for these means, this client and —
    // with a certificate — the certificate it reads (its own function: the
    // record holds the certificate's hash, which no public API computes).
    const stated = (await keyStore.getConnectionConfig(DEST)) ?? {};
    let binding: { issuedFor?: string; issuedBy?: string };
    if (how === 'certificate') {
      const { destinationBinding } = require(
        require.resolve('@mcp-abap-adt/auth-broker/dist/bindingOf'),
      ) as {
        destinationBinding: (...args: unknown[]) => {
          issuedFor?: string;
          issuedBy?: string;
        };
      };
      const certificate = await keyStore.getClientCertificate(DEST);
      binding = destinationBinding(
        stated.authType,
        stated.grantType,
        stated,
        { uaaUrl: certificate?.uaaUrl, uaaClientId: certificate?.clientId },
        certificate,
      );
    } else {
      binding = bindingOf(stated, await keyStore.getAuthorizationConfig(DEST));
    }
    const past = Math.floor(Date.now() / 1000) - 3600;
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    await new AbapSessionStore(dir).saveSession(DEST, {
      authorizationToken: `${part({ alg: 'none' })}.${part({ sub: 'old', exp: past })}.`,
      expiresAt: past * 1000,
      refreshToken: 'stored-refresh',
      issuedFor: binding.issuedFor ?? '',
      issuedBy: binding.issuedBy ?? '',
    } as never);
    return file;
  }

  /**
   * The run's arguments. A login must never wait in a test: a refresh that
   * fails falls through to the grant's login, so each run is handed one that
   * answers at once and fails — the password grant asks no one, and a
   * saml2-bearer run gets an `--assertion` (the secret, no means flag) that
   * no validator accepts — so a regression fails the test, never hangs it.
   */
  function sessionArgs(grant: 'password' | 'saml2_bearer', file: string) {
    return grant === 'saml2_bearer'
      ? ['--env', file, '--assertion', 'not-a-saml-response']
      : ['--env', file];
  }

  const SUBCOMMAND = {
    password: 'oidc',
    saml2_bearer: 'saml2-bearer',
  } as const;

  it.each([['password'], ['saml2_bearer']] as const)(
    '%s session with certificate paths: --env alone refreshes at certurl with the client certificate',
    async (grant) => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      const file = await sessionFile(grant, 'certificate');
      const parsed = parseSubcommandArgs(
        SUBCOMMAND[grant],
        sessionArgs(grant, file),
      );
      if (parsed.kind !== 'sso') throw new Error('not a run');
      await expect(run(parsed.options)).resolves.toBe(0);
      expect(server.requests).toHaveLength(0);
      expect(certServer.requests.map((r) => r.form.grant_type)).toEqual([
        'refresh_token',
      ]);
      expect(certServer.requests[0]!.form.refresh_token).toBe('stored-refresh');
      expect(certServer.requests[0]!.clientCertificate).toBe(CLIENT_CN);
    },
  );

  it.each([
    ['password', 'certificate'],
    ['password', 'form'],
    ['saml2_bearer', 'certificate'],
    ['saml2_bearer', 'form'],
  ] as const)(
    '%s session, %s: --format json --output reproduces the run’s client authentication',
    async (grant, how) => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      server.answer('/oauth/token', tokenAnswer('basic'));
      const file = await sessionFile(grant, how);
      const output = path.join(root, 'json', `${DEST}.json`);
      const parsed = parseSubcommandArgs(SUBCOMMAND[grant], [
        ...sessionArgs(grant, file),
        '--format',
        'json',
        '--output',
        output,
      ]);
      if (parsed.kind !== 'sso') throw new Error('not a run');
      await expect(run(parsed.options)).resolves.toBe(0);
      const json = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(json).toEqual(
        expect.objectContaining(
          how === 'certificate'
            ? {
                uaaUrl: server.url,
                uaaClientId: 'cli',
                uaaClientCertPath: CLIENT_CRT_PATH,
                uaaClientKeyPath: CLIENT_KEY_PATH,
                uaaCertUrl: certServer.url,
              }
            : {
                uaaUrl: server.url,
                uaaClientId: 'cli',
                uaaClientSecret: SECRET,
                uaaBasicEncoding: 'form',
              },
        ),
      );
    },
  );

  it('a hand-edited file: exported certificate paths and the last of two encodings, as the stores read them', async () => {
    certServer.answer('/oauth/token', tokenAnswer('x509'));
    const file = await sessionFile('password', 'certificate');
    const text = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) =>
        line.startsWith('SAP_UAA_CLIENT_') ? `export ${line}` : line,
      )
      .join('\n');
    fs.writeFileSync(file, text);
    const parsed = parseSubcommandArgs('oidc', ['--env', file]);
    if (parsed.kind !== 'sso') throw new Error('not a run');
    await expect(run(parsed.options)).resolves.toBe(0);
    expect(certServer.requests.map((r) => r.form.grant_type)).toEqual([
      'refresh_token',
    ]);
    expect(certServer.requests[0]!.clientCertificate).toBe(CLIENT_CN);

    server.answer('/oauth/token', tokenAnswer('basic'));
    const basic = await sessionFile('password', 'form');
    fs.appendFileSync(
      basic,
      '# changed by hand:\nexport SAP_UAA_BASIC_ENCODING="raw"\nSAP_UAA_BASIC_ENCODING = form # the last wins\n',
    );
    const again = parseSubcommandArgs('oidc', ['--env', basic]);
    if (again.kind !== 'sso') throw new Error('not a run');
    await expect(run(again.options)).resolves.toBe(0);
    expect(server.requests.at(-1)!.authorization).toBe(
      `Basic ${Buffer.from('cli:se%2Bcr%25et').toString('base64')}`,
    );
  });

  it.each([['password'], ['saml2_bearer']] as const)(
    '%s session with a recorded Basic(form) encoding: --env alone refreshes with the form-encoded Basic header',
    async (grant) => {
      server.answer('/oauth/token', tokenAnswer('basic'));
      const file = await sessionFile(grant, 'form');
      const parsed = parseSubcommandArgs(
        SUBCOMMAND[grant],
        sessionArgs(grant, file),
      );
      if (parsed.kind !== 'sso') throw new Error('not a run');
      await expect(run(parsed.options)).resolves.toBe(0);
      expect(server.requests.map((r) => r.form.grant_type)).toEqual([
        'refresh_token',
      ]);
      expect(server.requests[0]!.form).not.toHaveProperty('client_secret');
      expect(server.requests[0]!.authorization).toBe(
        `Basic ${Buffer.from('cli:se%2Bcr%25et').toString('base64')}`,
      );
    },
  );
});
