/**
 * `mcp-auth` end to end against a local UAA token endpoint — no browser: the
 * interactive strategy is the one the caller states, here a static code.
 *
 * Each case pins what the command writes and where: the means (`jwt`, the
 * grant, the client and URL from the service key) read back through the key
 * store; the secret alone in the session store, never the client secret (H4);
 * and the destination a server builds from the output with `getProvider`,
 * which presents the stored token without a new login.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
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
