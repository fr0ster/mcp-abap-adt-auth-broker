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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthBroker,
  fromServiceKeyCertificate,
} from '@mcp-abap-adt/auth-broker';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import {
  browserCallbackStrategy,
  refreshThenLogin,
  staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { createCliLogger, failureLines } from '../output';
import { type McpAuthOptions, runMcpAuth } from '../runMcpAuth';
import type { SourceEnvironment } from '../source';
import { isUsageError } from '../subcommandArgs';
import {
  CLIENT_CRT,
  CLIENT_CRT_PATH,
  CLIENT_KEY,
  CLIENT_KEY_PATH,
  PEM,
  pemFilesUnder,
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

/**
 * The caller's interactive strategy: a code, counted when the provider asks.
 * `environment` is where `--destination` looks: never the user's own folder.
 */
function run(o: McpAuthOptions, environment?: SourceEnvironment) {
  return runMcpAuth(o, {
    environment: environment ?? {
      home: path.join(root, 'home'),
      platform: 'linux',
      authBrokerPath: undefined,
    },
    // The logger the bin passes: stderr, from warn without --verbose.
    logger: createCliLogger({ verbose: o.verbose === true }),
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

/** Sets one `KEY=value` line of a `.env` file, adding it when absent. */
function rewriteEnvKey(file: string, key: string, value: string): void {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at === -1) lines.splice(lines.length - 1, 0, `${key}=${value}`);
  else lines[at] = `${key}=${value}`;
  fs.writeFileSync(file, lines.join('\n'));
}

/** The session in `file` holds a token that expired an hour ago. */
function expireStoredToken(file: string, type: 'abap' | 'xsuaa'): void {
  const prefix = type === 'abap' ? 'SAP' : 'XSUAA';
  const past = Math.floor(Date.now() / 1000) - 3600;
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  rewriteEnvKey(
    file,
    `${prefix}_JWT_TOKEN`,
    `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: 'expired', exp: past })}.`,
  );
  rewriteEnvKey(file, `${prefix}_EXPIRES_AT`, String(past * 1000));
}

describe('mcp-auth (authorization_code)', () => {
  it('writes jwt / authorization_code with the key client and URL; the token through the stated strategy; a getProvider broker over the output is seeded from it', async () => {
    server.answer('/oauth/token', tokenAnswer('uaa'));
    await expect(run(options({ serviceKeyPath: abapKey() }))).resolves.toBe(0);
    expect(strategyCalls).toBe(1);
    expect(server.requests[0]!.form).toEqual(
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

    // mcp-auth's provider is the broker's UAA row (§10.2): the record is the
    // row's, `jwt/authorization_code` — never the consumer path's.
    expect(
      secret?.issuedBy?.startsWith(
        'mcp-abap-adt-binding/2;jwt/authorization_code;',
      ),
    ).toBe(true);

    // The server's view: getProvider over the output reuses the token.
    const before = server.requests.length;
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
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

  it.each(['env', 'json'] as const)(
    "an --output that cannot be written (--format %s): the flag, the path and its code — never the writer's message",
    async (format) => {
      server.answer('/oauth/token', tokenAnswer('uaa'));
      const locked = path.join(root, 'locked');
      fs.mkdirSync(locked, { mode: 0o500 });
      const output = path.join(locked, 'sub', `${DEST}.${format}`);
      const thrown = await run(
        options({ serviceKeyPath: abapKey(), format, outputFile: output }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      fs.chmodSync(locked, 0o700);
      expect(isUsageError(thrown)).toBe(true);
      expect(failureLines(thrown)).toEqual([
        `❌ --output: ${output} cannot be written (EACCES)`,
      ]);
    },
  );

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

describe('three sources, one per run (D25)', () => {
  /** A first login's destination file, copied to `<root>/<DEST>.env`. */
  async function previousSession(): Promise<string> {
    server.answer('/oauth/token', tokenAnswer('uaa'));
    await expect(run(options({ serviceKeyPath: abapKey() }))).resolves.toBe(0);
    const previous = path.join(root, `${DEST}.env`);
    fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
    strategyCalls = 0;
    return previous;
  }

  /** `--env <file>` alone: no service key, no --output. */
  function envRun(file: string, overrides: Partial<McpAuthOptions> = {}) {
    return options({ envFilePath: file, outputFile: undefined, ...overrides });
  }

  /** The session the file at `file` holds, read through the session store. */
  function sessionAt(file: string) {
    return new AbapSessionStore(path.dirname(file)).loadSession(
      path.basename(file, '.env'),
    );
  }

  describe('--service-key: always a new pair by login', () => {
    it('twice: two logins, each writing a new pair; the existing --output session is not read', async () => {
      server.answer('/oauth/token', tokenAnswer('uaa'));
      const o = options({ serviceKeyPath: abapKey() });
      await expect(run(o)).resolves.toBe(0);
      await expect(run(o)).resolves.toBe(0);
      expect(strategyCalls).toBe(2);
      expect(server.requests.map((r) => r.form.grant_type)).toEqual([
        'authorization_code',
        'authorization_code',
      ]);
      expect(JSON.stringify(server.requests[1])).not.toContain('uaa-refresh-1');
      const second = await storesOf('abap').sessionStore.loadSession(DEST);
      expect(jwtName(second?.authorizationToken)).toBe('uaa-access-2');
      expect(second?.refreshToken).toBe('uaa-refresh-2');
    });
  });

  describe('--env <path>: the session file, written back', () => {
    it('a valid token bound to the file’s means: no request, no login, the file byte for byte as it was', async () => {
      const previous = await previousSession();
      const before = fs.readFileSync(previous);
      const sent = server.requests.length;
      await expect(run(envRun(previous))).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(server.requests).toHaveLength(sent);
      expect(fs.readFileSync(previous)).toEqual(before);
    });

    it('an expired token: one refresh, no login, the new pair written back to the file', async () => {
      const previous = await previousSession();
      expireStoredToken(previous, 'abap');
      const sent = server.requests.length;
      await expect(run(envRun(previous))).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(server.requests.slice(sent).map((r) => r.form)).toEqual([
        expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'uaa-refresh-1',
        }),
      ]);
      const renewed = await sessionAt(previous);
      expect(jwtName(renewed?.authorizationToken)).toBe('uaa-access-2');
      expect(renewed?.refreshToken).toBe('uaa-refresh-2');
    });

    it('a refused refresh: a login, its new pair written back', async () => {
      const previous = await previousSession();
      expireStoredToken(previous, 'abap');
      const login = tokenAnswer('login');
      server.answer('/oauth/token', (form) =>
        form.grant_type === 'refresh_token'
          ? { status: 400, body: { error: 'invalid_grant' } }
          : login(),
      );
      const sent = server.requests.length;
      await expect(run(envRun(previous))).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      expect(server.requests.slice(sent).map((r) => r.form.grant_type)).toEqual(
        ['refresh_token', 'authorization_code'],
      );
      const renewed = await sessionAt(previous);
      expect(jwtName(renewed?.authorizationToken)).toBe('login-access-1');
      expect(renewed?.refreshToken).toBe('login-refresh-1');
    });

    it('a session not bound to the file’s means: a login, its refresh token sent nowhere', async () => {
      const previous = await previousSession();
      // A session written by CLI 2.x: its binding is not a 5.0.0 record.
      rewriteEnvKey(previous, 'SAP_ISSUED_BY', 'key-client');
      const sent = server.requests.length;
      await expect(run(envRun(previous))).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      const after = server.requests.slice(sent);
      expect(after.map((r) => r.form.grant_type)).toEqual([
        'authorization_code',
      ]);
      expect(JSON.stringify(after)).not.toContain('uaa-refresh-1');
      const renewed = await sessionAt(previous);
      expect(jwtName(renewed?.authorizationToken)).toBe('uaa-access-2');
      expect(console.error).toHaveBeenCalledWith(
        `[warn] [AuthBroker] ${DEST}: the stored session secret is not recorded as issued under the destination's current means; not used, the provider obtains a new one`,
      );
    });

    it('with --output: written there, the session file left as it was', async () => {
      const previous = await previousSession();
      expireStoredToken(previous, 'abap');
      const before = fs.readFileSync(previous);
      const output = path.join(root, 'elsewhere', `${DEST}.env`);
      await expect(run(envRun(previous, { outputFile: output }))).resolves.toBe(
        0,
      );
      expect(fs.readFileSync(previous)).toEqual(before);
      expect(jwtName((await sessionAt(output))?.authorizationToken)).toBe(
        'uaa-access-2',
      );
    });

    it('the means come from the file: a flag that states them is refused naming it', async () => {
      const previous = await previousSession();
      const before = fs.readFileSync(previous);
      for (const [flag, overrides] of [
        ['--credential', { credential: true }],
        ['--service-url', { serviceUrl: 'https://other.example.com' }],
        ['--client-auth', { clientAuth: 'certificate' }],
        ['--client-auth', { clientAuth: 'secret', basicEncoding: 'form' }],
        ['--basic-encoding', { basicEncoding: 'raw' }],
        ['--cert-path', { certPath: CLIENT_CRT_PATH }],
        ['--key-path', { keyPath: CLIENT_KEY_PATH }],
      ] as const) {
        const thrown = await run(envRun(previous, overrides)).catch(
          (error: unknown) => error,
        );
        expect(isUsageError(thrown)).toBe(true);
        expect((thrown as Error).message).toBe(
          `${flag} and --env: the session file holds the means and is used as it is; state the means with --service-key instead`,
        );
      }
      expect(fs.readFileSync(previous)).toEqual(before);
    });

    it.each([['.env'], ['session.backup']])(
      'the exact file given (%s): read and written back, an adjacent <name>.env never read',
      async (fileName) => {
        const previous = await previousSession();
        const dir = path.join(root, 'exact');
        fs.mkdirSync(dir);
        const file = path.join(dir, fileName);
        fs.copyFileSync(previous, file);
        expireStoredToken(file, 'abap');
        // A conflicting file where a directory store would look.
        const decoy = path.join(
          dir,
          fileName === '.env' ? '.env.env' : 'session.env',
        );
        fs.writeFileSync(
          decoy,
          'SAP_AUTH_TYPE=jwt\nSAP_GRANT_TYPE=device_code\n',
        );
        const decoyBefore = fs.readFileSync(decoy);
        const sent = server.requests.length;
        await expect(run(envRun(file))).resolves.toBe(0);
        expect(
          server.requests.slice(sent).map((r) => r.form.grant_type),
        ).toEqual(['refresh_token']);
        expect(readEnvKeys(file).SAP_REFRESH_TOKEN).toBe('uaa-refresh-2');
        expect(fs.readFileSync(decoy)).toEqual(decoyBefore);
      },
    );

    it('an XSUAA_* file without --type xsuaa: the refusal says to add --type xsuaa', async () => {
      const file = path.join(root, `${DEST}.env`);
      fs.writeFileSync(
        file,
        'XSUAA_AUTH_TYPE=jwt\nXSUAA_GRANT_TYPE=authorization_code\nXSUAA_UAA_URL=https://uaa\n',
      );
      const thrown = await run(envRun(file)).catch((e: unknown) => e);
      expect((thrown as Error).message).toBe(
        '--env: the session file holds XSUAA_* variables: add --type xsuaa',
      );
    });

    it('no file at the path: a usage error naming --env, nothing sent', async () => {
      const missing = path.join(root, 'missing.env');
      const thrown = await run(envRun(missing)).catch((e: unknown) => e);
      expect(isUsageError(thrown)).toBe(true);
      expect((thrown as Error).message).toBe(
        `--env: no session file at ${missing}`,
      );
      expect(server.requests).toHaveLength(0);
    });

    it('--format json without --output is refused: the session file stays .env', async () => {
      const previous = await previousSession();
      const before = fs.readFileSync(previous);
      const thrown = await run(envRun(previous, { format: 'json' })).catch(
        (e: unknown) => e,
      );
      expect((thrown as Error).message).toBe(
        '--format json needs --output: the session file is written back as .env',
      );
      expect(fs.readFileSync(previous)).toEqual(before);
    });
  });

  describe('--destination <name>: the standard folder', () => {
    const dests = () => path.join(root, 'dests');
    const sessionFile = (base = dests()) =>
      path.join(base, 'sessions', `${DEST}.env`);

    /** A service key at `<base>/service-keys/<DEST>.json`. */
    function keyIn(base: string): void {
      fs.mkdirSync(path.join(base, 'service-keys'), { recursive: true });
      fs.copyFileSync(
        abapKey(),
        path.join(base, 'service-keys', `${DEST}.json`),
      );
    }

    /** A valid session at `<base>/sessions/<DEST>.env`, from a first login. */
    async function sessionIn(base: string): Promise<Buffer> {
      const previous = await previousSession();
      fs.mkdirSync(path.join(base, 'sessions'), { recursive: true });
      fs.copyFileSync(previous, sessionFile(base));
      return fs.readFileSync(sessionFile(base));
    }

    const destinationRun = (overrides: Partial<McpAuthOptions> = {}) =>
      options({
        destination: DEST,
        destinationDir: dests(),
        outputFile: undefined,
        ...overrides,
      });

    it('sessions/<name>.env present: as --env — the valid token reused, no request, the file as it was', async () => {
      const before = await sessionIn(dests());
      keyIn(dests());
      const sent = server.requests.length;
      await expect(run(destinationRun())).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(server.requests).toHaveLength(sent);
      expect(fs.readFileSync(sessionFile())).toEqual(before);
    });

    it('sessions/<name>.env present and expired: refreshed and written back, the key beside it unused', async () => {
      await sessionIn(dests());
      keyIn(dests());
      expireStoredToken(sessionFile(), 'abap');
      const sent = server.requests.length;
      await expect(run(destinationRun())).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(server.requests.slice(sent).map((r) => r.form.grant_type)).toEqual(
        ['refresh_token'],
      );
      expect(
        jwtName((await sessionAt(sessionFile()))?.authorizationToken),
      ).toBe('uaa-access-2');
    });

    it('no session: as --service-key from service-keys/<name>.json — a login, the session written to sessions/<name>.env; the next run reuses it', async () => {
      server.answer('/oauth/token', tokenAnswer('uaa'));
      keyIn(dests());
      await expect(run(destinationRun())).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      expect(server.requests.map((r) => r.form.grant_type)).toEqual([
        'authorization_code',
      ]);
      expect(
        jwtName((await sessionAt(sessionFile()))?.authorizationToken),
      ).toBe('uaa-access-1');

      await expect(run(destinationRun())).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      expect(server.requests).toHaveLength(1);
    });

    it('neither file: a usage error naming the folders looked in, nothing sent', async () => {
      const thrown = await run(destinationRun()).catch((e: unknown) => e);
      expect(isUsageError(thrown)).toBe(true);
      expect((thrown as Error).message).toBe(
        `--destination: ${DEST} is in none of ${path.join(dests(), 'sessions')} (as ${DEST}.env) and ${path.join(dests(), 'service-keys')} (as ${DEST}.json)`,
      );
      expect(server.requests).toHaveLength(0);
    });

    describe('the folder: --destination-dir, else AUTH_BROKER_PATH, else the standard folder', () => {
      const home = () => path.join(root, 'home');
      const standard = () => path.join(home(), '.config', 'mcp-abap-adt');
      const environment = (authBrokerPath?: string): SourceEnvironment => ({
        home: home(),
        platform: 'linux',
        authBrokerPath,
      });

      /** Distinct files per folder: which one the run copied to --output. */
      async function sessionsIn(...bases: string[]): Promise<Buffer[]> {
        const files: Buffer[] = [];
        for (const base of bases) {
          files.push(await sessionIn(base));
          // Each file distinct: a marker line the stores do not read.
          fs.appendFileSync(sessionFile(base), `# ${base}\n`);
          files[files.length - 1] = fs.readFileSync(sessionFile(base));
        }
        return files;
      }

      const output = () => path.join(root, 'out-dest', `${DEST}.env`);

      it('--destination-dir over AUTH_BROKER_PATH', async () => {
        const listed = path.join(root, 'listed');
        const [given] = await sessionsIn(dests(), listed, standard());
        await expect(
          run(destinationRun({ outputFile: output() }), environment(listed)),
        ).resolves.toBe(0);
        expect(fs.readFileSync(output())).toEqual(given);
      });

      it('AUTH_BROKER_PATH over the standard folder', async () => {
        const listed = path.join(root, 'listed');
        const [fromVariable] = await sessionsIn(listed, standard());
        await expect(
          run(
            destinationRun({ destinationDir: undefined, outputFile: output() }),
            environment(listed),
          ),
        ).resolves.toBe(0);
        expect(fs.readFileSync(output())).toEqual(fromVariable);
      });

      it('AUTH_BROKER_PATH with several folders (";" and ":"): read from the first that holds it', async () => {
        const empty = path.join(root, 'empty');
        fs.mkdirSync(empty);
        const second = path.join(root, 'second');
        const third = path.join(root, 'third');
        const [fromSecond] = await sessionsIn(second, third);
        for (const variable of [
          `${empty};${second};${third}`,
          `${empty}:${second}:${third}`,
        ]) {
          await expect(
            run(
              destinationRun({
                destinationDir: undefined,
                outputFile: output(),
              }),
              environment(variable),
            ),
          ).resolves.toBe(0);
          expect(fs.readFileSync(output())).toEqual(fromSecond);
        }
      });

      it('AUTH_BROKER_PATH with several folders: a key found in a later one, the new session written to the first', async () => {
        server.answer('/oauth/token', tokenAnswer('uaa'));
        const first = path.join(root, 'first');
        fs.mkdirSync(first);
        const later = path.join(root, 'later');
        keyIn(later);
        await expect(
          run(
            destinationRun({ destinationDir: undefined }),
            environment(`${first};${later}`),
          ),
        ).resolves.toBe(0);
        expect(strategyCalls).toBe(1);
        expect(
          jwtName((await sessionAt(sessionFile(first)))?.authorizationToken),
        ).toBe('uaa-access-1');
        expect(fs.existsSync(sessionFile(later))).toBe(false);
      });

      it('sessions and service keys are their own lists: a session in a later folder beats a key in the first (as the server)', async () => {
        const first = path.join(root, 'first');
        keyIn(first);
        const later = path.join(root, 'later');
        const [fromLater] = await sessionsIn(later);
        const sent = server.requests.length;
        await expect(
          run(
            destinationRun({ destinationDir: undefined, outputFile: output() }),
            environment(`${first};${later}`),
          ),
        ).resolves.toBe(0);
        expect(server.requests).toHaveLength(sent);
        expect(fs.readFileSync(output())).toEqual(fromLater);
      });

      it('an AUTH_BROKER_PATH entry naming the sessions folder is read as its base (as the server)', async () => {
        const base = path.join(root, 'named');
        const [fromNamed] = await sessionsIn(base);
        await expect(
          run(
            destinationRun({ destinationDir: undefined, outputFile: output() }),
            environment(path.join(base, 'sessions')),
          ),
        ).resolves.toBe(0);
        expect(fs.readFileSync(output())).toEqual(fromNamed);
      });

      it('the standard folder when neither is given', async () => {
        const [fromStandard] = await sessionsIn(standard());
        await expect(
          run(
            destinationRun({ destinationDir: undefined, outputFile: output() }),
            environment(undefined),
          ),
        ).resolves.toBe(0);
        expect(fs.readFileSync(output())).toEqual(fromStandard);
      });
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
    expect(server.requests[0]!.form.grant_type).toBe('client_credentials');
    const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
    expect(keys.XSUAA_AUTH_TYPE).toBe('jwt');
    expect(keys.XSUAA_GRANT_TYPE).toBe('client_credentials');
    expect(keys).not.toHaveProperty('XSUAA_MCP_URL');
    expect(jwtName(keys.XSUAA_JWT_TOKEN)).toBe('cc-access-1');
    // The broker's UAA row obtained it: the row's record, no `provider/`.
    expect(
      keys.XSUAA_ISSUED_BY?.startsWith(
        'mcp-abap-adt-binding/2;jwt/client_credentials;',
      ),
    ).toBe(true);
    await expectSplit('xsuaa');
  });
});

describe('a secret the store does not take', () => {
  it('fails the run and writes no output', async () => {
    server.answer('/oauth/token', tokenAnswer('lost'));
    jest
      .spyOn(AbapSessionStore.prototype, 'saveSession')
      .mockRejectedValue(new Error('disk full'));
    // onWriteFailure: 'fail' — the run fails with persisting-tokens, never
    // with the store's own words.
    const thrown = await run(options({ serviceKeyPath: abapKey() })).catch(
      (error: unknown) => error,
    );
    // The broker's row wrote it: its persistence names the grant.
    expect(readFailure(thrown, 'unfamiliar-error').facts).toEqual({
      operation: 'persisting-tokens',
      grant: 'authorization_code',
    });
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
    'getToken() rejecting with %p fails the run: no output written',
    async (value) => {
      // The broker's token API is the run's one call that obtains a token.
      const spy = jest
        .spyOn(AuthBroker.prototype, 'getToken')
        .mockRejectedValue(value);
      try {
        const outcome = await run(
          options({ serviceKeyPath: abapKey(), credential: true }),
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

/** The files under the work and output directories that hold PEM. */
function pemCopies(): string[] {
  return pemFilesUnder(workDir, outDir);
}

describe('mcp-auth --client-auth', () => {
  let certServer: LocalServer;

  // The HTTPS stand-in for `certurl` is trusted inside this process alone.
  trustCertServer();

  beforeEach(async () => {
    certServer = await startCertServer();
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
      const request = certServer.requests[0]!;
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
      expect(
        keys.XSUAA_ISSUED_BY?.startsWith(
          'mcp-abap-adt-binding/2;jwt/client_credentials;',
        ),
      ).toBe(true);
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
      expect(certServer.requests[0]!.form).toEqual(
        expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'the-code',
        }),
      );
      expect(certServer.requests[0]!.clientCertificate).toBe(
        'mcp-auth-test-client',
      );
      expect(readEnvKeys(path.join(outDir, `${DEST}.env`)).SAP_GRANT_TYPE).toBe(
        'authorization_code',
      );

      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      expireStoredToken(previous, 'abap');
      strategyCalls = 0;
      // --env alone: the client authentication is the file's — its
      // certificate paths — with no flag (D25).
      await expect(
        run(
          options({
            envFilePath: previous,
            outputFile: path.join(outDir, `${DEST}.env`),
          }),
        ),
      ).resolves.toBe(0);
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
        renewal: () => refreshThenLogin(),
        onWriteFailure: 'fail',
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

    it('--type xsuaa with no service URL: an --env rerun refreshes with the stored refresh token', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      const o = options({
        authType: 'xsuaa',
        serviceKeyPath: x509Key(),
        ...certificate,
      });
      await expect(run(o)).resolves.toBe(0);
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys).not.toHaveProperty('XSUAA_MCP_URL');

      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      expireStoredToken(previous, 'xsuaa');
      strategyCalls = 0;
      await expect(
        run(
          options({
            authType: 'xsuaa',
            envFilePath: previous,
            outputFile: path.join(outDir, `${DEST}.env`),
          }),
        ),
      ).resolves.toBe(0);
      expect(strategyCalls).toBe(0);
      expect(certServer.requests.at(-1)?.form).toEqual(
        expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'x509-refresh-1',
        }),
      );
    });

    it('--env <certificate session> --format json --output: the client, both paths and certurl from the session file', async () => {
      certServer.answer('/oauth/token', tokenAnswer('x509'));
      await expect(
        run(
          options({
            serviceKeyPath: x509Key(),
            serviceUrl: SERVICE_URL,
            ...certificate,
          }),
        ),
      ).resolves.toBe(0);
      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      const output = path.join(root, 'json', `${DEST}.json`);
      await expect(
        run(
          options({
            envFilePath: previous,
            outputFile: output,
            format: 'json',
          }),
        ),
      ).resolves.toBe(0);
      const json = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(json).toEqual(
        expect.objectContaining({
          uaaClientId: 'key-client',
          uaaClientCertPath: CLIENT_CRT_PATH,
          uaaClientKeyPath: CLIENT_KEY_PATH,
          uaaCertUrl: certServer.url,
        }),
      );
      expect(JSON.stringify(json)).not.toContain(PEM);
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
      expect(certServer.requests[0]!.clientCertificate).toBe(
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
      expect(certServer.requests[0]!.clientCertificate).toBe(
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
      const request = server.requests[0]!;
      expect(request.form.grant_type).toBe('client_credentials');
      expect(request.form).not.toHaveProperty('client_secret');
      expect(request.authorization).toBe(
        `Basic ${Buffer.from(`key-client:${CLIENT_SECRET}`).toString('base64')}`,
      );
      const keys = readEnvKeys(path.join(outDir, `${DEST}.env`));
      expect(keys.XSUAA_UAA_CLIENT_SECRET).toBe(CLIENT_SECRET);
      expect(keys).not.toHaveProperty('XSUAA_UAA_CLIENT_CERT_PATH');
      expect(keys).not.toHaveProperty('XSUAA_UAA_CERT_URL');
      expect(
        keys.XSUAA_ISSUED_BY?.startsWith(
          'mcp-abap-adt-binding/2;jwt/client_credentials;',
        ),
      ).toBe(true);
      expect(pemCopies()).toEqual([]);
    });

    it('the Basic encoding is recorded in the file and read back: --env alone refreshes with the Basic header, no client_secret in the body', async () => {
      server.answer('/oauth/token', tokenAnswer('basic'));
      // A secret holding '+' and '%': form-encoded, they read %2B and %25 —
      // a request without the recorded encoding sends them as they are.
      const key = path.join(keysDir, `${DEST}.json`);
      fs.writeFileSync(
        key,
        JSON.stringify({
          uaa: {
            url: server.url,
            clientid: 'key-client',
            clientsecret: 'se+cr%et',
          },
          abap: { url: SERVICE_URL },
        }),
      );
      await expect(
        run(
          options({
            serviceKeyPath: key,
            clientAuth: 'secret',
            basicEncoding: 'form',
          }),
        ),
      ).resolves.toBe(0);
      const file = path.join(outDir, `${DEST}.env`);
      expect(readEnvKeys(file).SAP_UAA_BASIC_ENCODING).toBe('form');
      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(file, previous);
      expireStoredToken(previous, 'abap');
      const sent = server.requests.length;
      await expect(
        run(options({ envFilePath: previous, outputFile: undefined })),
      ).resolves.toBe(0);
      expect(strategyCalls).toBe(1);
      const refresh = server.requests.slice(sent);
      expect(refresh.map((r) => r.form.grant_type)).toEqual(['refresh_token']);
      expect(refresh[0]!.form).not.toHaveProperty('client_secret');
      expect(refresh[0]!.authorization).toBe(
        `Basic ${Buffer.from('key-client:se%2Bcr%25et').toString('base64')}`,
      );
      expect(readEnvKeys(previous).SAP_UAA_BASIC_ENCODING).toBe('form');
    });

    it('--format json carries the Basic encoding: from the flag with a key, from the file with --env', async () => {
      server.answer('/oauth/token', tokenAnswer('basic'));
      const jsonOut = path.join(root, 'json', `${DEST}.json`);
      await expect(
        run(
          options({
            serviceKeyPath: abapKey(),
            clientAuth: 'secret',
            basicEncoding: 'form',
            format: 'json',
            outputFile: jsonOut,
          }),
        ),
      ).resolves.toBe(0);
      expect(
        JSON.parse(fs.readFileSync(jsonOut, 'utf8')).uaaBasicEncoding,
      ).toBe('form');
      await expect(
        run(
          options({
            serviceKeyPath: abapKey(),
            clientAuth: 'secret',
            basicEncoding: 'form',
          }),
        ),
      ).resolves.toBe(0);
      const previous = path.join(root, `${DEST}.env`);
      fs.copyFileSync(path.join(outDir, `${DEST}.env`), previous);
      fs.rmSync(jsonOut);
      await expect(
        run(
          options({
            envFilePath: previous,
            outputFile: jsonOut,
            format: 'json',
          }),
        ),
      ).resolves.toBe(0);
      expect(
        JSON.parse(fs.readFileSync(jsonOut, 'utf8')).uaaBasicEncoding,
      ).toBe('form');
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

describe('a service key that is not JSON', () => {
  it.each(['abap', 'xsuaa'] as const)(
    '--type %s: refused in fixed words before anything is written; nothing of the file on the console or in the error',
    async (authType) => {
      const MARKER = 'leaked-marker-7f3a';
      const file = path.join(keysDir, `${DEST}.json`);
      fs.writeFileSync(file, `{"clientsecret": "${MARKER}", oops`);
      let thrown: unknown;
      await run(
        options({ serviceKeyPath: file, authType, credential: true }),
      ).catch((error) => {
        thrown = error;
      });
      expect((thrown as Error).message).toBe(
        `The service key ${file} cannot be read as JSON`,
      );
      expect(fs.readdirSync(workDir)).toEqual([]);
      const printed = [console.log, console.error]
        .flatMap((fn) => (fn as jest.Mock).mock.calls.flat())
        .map(String)
        .join('\n');
      expect(printed).not.toContain(MARKER);
      expect(String((thrown as Error).message)).not.toContain(MARKER);
      expect(String((thrown as Error).stack)).not.toContain(MARKER);
      expect(server.requests).toHaveLength(0);
    },
  );
});

describe('the browser is mapped only for a login that opens one', () => {
  it('--credential on a platform with no launcher runs: no browser is opened, so none is refused', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    for (const browser of ['auto', 'chrome']) {
      fs.rmSync(outDir, { recursive: true, force: true });
      await expect(
        runMcpAuth(
          options({ serviceKeyPath: abapKey(), credential: true, browser }),
          {
            workDir,
            platform: 'freebsd',
            authorization: () => {
              throw new Error('no login expected');
            },
          },
        ),
      ).resolves.toBe(0);
      expect(fs.existsSync(path.join(outDir, `${DEST}.env`))).toBe(true);
    }
  });

  it('the authorization code login there is refused before anything is read or written', async () => {
    await expect(
      runMcpAuth(options({ serviceKeyPath: abapKey(), browser: 'auto' }), {
        workDir,
        platform: 'freebsd',
        authorization: () => {
          throw new Error('no login expected');
        },
      }),
    ).rejects.toThrow(
      '--browser auto has no launcher on this platform; use --browser none',
    );
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(server.requests).toHaveLength(0);
  });
});

describe('mcp-auth: state and PKCE come with the provider (§10.5)', () => {
  it('the URL carries state and an S256 challenge, the exchange its verifier; a callback without the state is refused', async () => {
    server.answer('/oauth/token', tokenAnswer('pkce'));
    const opened: string[] = [];
    const callbacks: Array<{ query: string; status: number }> = [];
    // A browser double: it opens nothing, it plays the user's redirect —
    // first without the state, then as the authorization server sends it.
    const browser = {
      open: async (url: string) => {
        opened.push(url);
        const authorization = new URL(url);
        const redirect = authorization.searchParams.get('redirect_uri') ?? '';
        const state = authorization.searchParams.get('state') ?? '';
        for (const query of [
          'code=the-code',
          `code=the-code&state=${encodeURIComponent(state)}`,
        ]) {
          const response = await fetch(`${redirect}?${query}`);
          await response.text();
          callbacks.push({ query, status: response.status });
        }
      },
    };
    const code = await runMcpAuth(options({ serviceKeyPath: abapKey() }), {
      logger: createCliLogger({ verbose: false }),
      workDir,
      authorization: () =>
        browserCallbackStrategy({ browser, port: 0 } as never),
    });
    expect(code).toBe(0);

    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    expect(state).toEqual(expect.any(String));
    expect(state?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(challenge).toEqual(expect.any(String));

    // The callback without the state is not this login's: refused, and the
    // login went on to the one that carries it.
    expect(callbacks.map((c) => c.status)).toEqual([400, 200]);

    expect(server.requests).toHaveLength(1);
    const exchange = server.requests[0]!.form;
    expect(exchange).toEqual(
      expect.objectContaining({
        grant_type: 'authorization_code',
        code: 'the-code',
      }),
    );
    const verifier = exchange.code_verifier ?? '';
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      challenge,
    );
  });
});
