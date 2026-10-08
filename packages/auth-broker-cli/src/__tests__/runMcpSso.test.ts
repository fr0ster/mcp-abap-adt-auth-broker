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
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
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
  it('writes jwt / device_code; the presenter it states shows the code on its logger', async () => {
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
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('USER-CODE-42'),
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

describe('mcp-auth oidc --env with a destination written for another grant', () => {
  it("keeps none of the other grant's means: the password goes when the grant changes", async () => {
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
    const previous = path.join(root, `${DEST}.env`);
    fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
    fs.rmSync(workDir, { recursive: true });
    fs.mkdirSync(workDir);

    server.answer('/tx', tokenAnswer('tx'));
    await expect(
      run(
        options({
          envFilePath: previous,
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
    // The system's own means stay.
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
