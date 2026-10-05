/**
 * An x509 XSUAA service key through the auth chain, against a real XSUAA: the
 * broker with `fromServiceKeyCertificate()`, and the CLI's two commands with
 * `--client-auth certificate`. The key is the one tests/live/x509/setup.sh
 * creates on a BTP trial (`credential-types: ["x509"]`, key parameter
 * `{"credential-type": "x509"}`) and teardown.sh removes; `npm run
 * test:live:x509` does both around this suite and builds first. Not part of
 * `npm test`, not part of CI.
 *
 * Runs only when AUTH_BROKER_LIVE_X509_LOCAL points at the directory setup.sh
 * filled (keys/x509.json, client.crt, client.key) and the CLI is built; the
 * suite's title says why it is skipped otherwise.
 *
 * The CLI runs as a user runs it — `mcp-auth` from its dist, and
 * `generate-env-from-service-key` through tsx, as `npm run generate-env` does
 * — each with a timeout. Both are non-interactive here (client_credentials):
 * no case passes an interactive strategy, and while a command runs this suite
 * holds the callback port a browser login would bind (auth-providers'
 * DEFAULT_CALLBACK_PORT), so one constructed and invoked fails the run.
 *
 * Jest prints the received value when a matcher fails: every assertion on the
 * key's material, a token or a command's output is made on a boolean
 * projection of it, so a failure never echoes a private key, a certificate or
 * a token. A command that fails is described by its exit status and its `❌`
 * lines, and only when those hold no PEM and no JWT.
 */

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CALLBACK_PORT } from '@mcp-abap-adt/auth-providers';
import {
  EnvDestinationStore,
  SafeXsuaaSessionStore,
  XSUAA_DESTINATION_VARS,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { AuthBroker, fromServiceKeyCertificate } from '../../index';
import { describeWhere, runLog as log } from '../helpers/describeWhere';

const LOCAL = process.env.AUTH_BROKER_LIVE_X509_LOCAL;
const DESTINATION = 'x509';
/** packages/auth-broker-cli, beside this package: run, never imported. */
const CLI = path.resolve(__dirname, '../../../../auth-broker-cli');
const MCP_AUTH = path.join(CLI, 'dist', 'mcp-auth.js');
const GENERATE_ENV = path.join(CLI, 'src', 'generate-env-from-service-key.ts');
const COMMAND_TIMEOUT_MS = 60_000;

function unavailable(): string | null {
  if (!LOCAL) {
    return 'AUTH_BROKER_LIVE_X509_LOCAL is not set (npm run test:live:x509 sets it, after creating the trial key)';
  }
  for (const file of [
    path.join('keys', `${DESTINATION}.json`),
    'client.crt',
    'client.key',
  ]) {
    if (!fs.existsSync(path.join(LOCAL, file))) {
      return `${LOCAL} holds no ${file}: run tests/live/x509/setup.sh (npm run test:live:x509 does)`;
    }
  }
  if (!fs.existsSync(MCP_AUTH)) {
    return 'the CLI is not built: npm run build (npm run test:live:x509 does)';
  }
  return null;
}

interface X509Key {
  url: string;
  certurl: string;
  clientid: string;
  certificate: string;
  key: string;
}

/** A token's claims; {} for anything unreadable, whose parse error would quote it. */
const claims = (jwt: unknown): Record<string, unknown> => {
  try {
    return JSON.parse(
      Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'),
    );
  } catch {
    return {};
  }
};

/** The client a token was issued to — XSUAA names it in `client_id` and `cid`. */
const clientOf = (jwt: unknown): unknown => {
  const c = claims(jwt);
  return c.client_id ?? c.cid;
};

/** The base64 body lines of a PEM: any one of them in a text is a leak. */
function pemBodyLines(pem: string): string[] {
  return pem
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 40 && !line.startsWith('-----'));
}

/** `KEY=value` lines of a `.env`, quotes removed. */
function readEnvKeys(file: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === "'" || quote === '"' || quote === '`') &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    keys[match[1]] = value;
  }
  return keys;
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

interface CommandResult {
  status: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Runs `node <args>` in `cwd` with a timeout, stdout and stderr together. The
 * output is kept for the assertions only — never printed whole.
 */
function runNode(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      // Jest's --experimental-vm-modules is not the CLI's.
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut, output });
    });
  });
}

const tsxCli = (): string =>
  createRequire(path.join(CLI, 'package.json')).resolve('tsx/cli');

const mcpAuth = (args: string[], cwd: string) =>
  runNode([MCP_AUTH, ...args], cwd);

const generateEnv = (args: string[], cwd: string) =>
  runNode([tsxCli(), GENERATE_ENV, ...args], cwd);

/**
 * Holds the port a browser login binds first, for the duration of `body`:
 * an interactive strategy invoked by a command fails it at once ("already in
 * use") instead of opening a browser. Held by someone else already counts.
 */
async function withCallbackPortHeld<T>(body: () => Promise<T>): Promise<T> {
  const server = net.createServer();
  const held = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'EADDRINUSE' ? resolve(false) : reject(error),
    );
    server.listen(DEFAULT_CALLBACK_PORT, () => resolve(true));
  });
  try {
    return await body();
  } finally {
    if (held) await new Promise<void>((done) => server.close(() => done()));
  }
}

describeWhere(
  'x509 XSUAA service key — a BTP trial (broker fromServiceKeyCertificate, mcp-auth and generate-env with --client-auth certificate)',
  unavailable(),
  () => {
    const local = LOCAL as string;
    const keysDir = path.join(local, 'keys');
    const keyFile = path.join(keysDir, `${DESTINATION}.json`);
    const certPath = path.join(local, 'client.crt');
    const keyPath = path.join(local, 'client.key');
    let x509: X509Key;
    let secrets: string[];
    let work: string;

    /** No PEM header and no line of the key's (or any given) PEM body. */
    const pemFree = (text: string, extra: string[] = []): boolean =>
      !text.includes('-----BEGIN') &&
      !text.includes('PRIVATE KEY') &&
      ![...secrets, ...extra].some((line) => text.includes(line));

    const jwtFree = (text: string): boolean =>
      !/eyJ[\w-]{8,}\.eyJ[\w-]{8,}\./.test(text);

    /** What may be said of a failed command: its status and its ❌ lines. */
    const describeRun = (what: string, run: CommandResult): string => {
      const said = run.output
        .split('\n')
        .filter((line) => line.includes('❌'))
        .join(' | ');
      const safe = pemFree(said) && jwtFree(said);
      return `${what}: exit ${run.status}${run.timedOut ? ' (timed out)' : ''} — ${
        safe
          ? said || 'no ❌ line'
          : 'output withheld: it holds key material or a token'
      }`;
    };

    const expectSucceeded = (what: string, run: CommandResult): void => {
      if (run.status !== 0) throw new Error(describeRun(what, run));
    };

    /** The `.env` names the PEM files by path and holds no PEM and no secret. */
    const expectPathsOnly = (file: string): Record<string, string> => {
      const text = fs.readFileSync(file, 'utf8');
      expect(pemFree(text)).toBe(true);
      const keys = readEnvKeys(file);
      expect(keys.XSUAA_UAA_CLIENT_CERT_PATH === certPath).toBe(true);
      expect(keys.XSUAA_UAA_CLIENT_KEY_PATH === keyPath).toBe(true);
      expect(keys.XSUAA_UAA_CERT_URL === x509.certurl).toBe(true);
      expect(keys.XSUAA_UAA_CLIENT_ID === x509.clientid).toBe(true);
      expect('XSUAA_UAA_CLIENT_SECRET' in keys).toBe(false);
      expect(keys.XSUAA_GRANT_TYPE).toBe('client_credentials');
      return keys;
    };

    /** A broker over a written destination, from where it now lives. */
    const freshBroker = (dir: string): AuthBroker =>
      new AuthBroker({
        serviceKeyStore: new EnvDestinationStore(dir, {
          variables: XSUAA_DESTINATION_VARS,
        }),
        sessionStore: new XsuaaSessionStore(dir),
        clientAuthentication: fromServiceKeyCertificate(),
      });

    /** A private key that is not the certificate's: a run with it must fail. */
    const foreignKeyPath = (): { file: string; body: string[] } => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const file = path.join(work, 'foreign.key');
      fs.writeFileSync(file, pem, { mode: 0o600 });
      return { file, body: pemBodyLines(pem) };
    };

    beforeAll(() => {
      // A parse error quotes part of its input — here, part of a private key.
      let key: { credentials?: X509Key } & X509Key;
      try {
        key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      } catch {
        throw new Error('keys/x509.json is not JSON');
      }
      x509 = key.credentials ?? key;
      secrets = [
        ...pemBodyLines(x509.key ?? ''),
        ...pemBodyLines(x509.certificate ?? ''),
      ];
    });

    beforeEach(() => {
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-live-x509-'));
    });

    afterEach(() => {
      fs.rmSync(work, { recursive: true, force: true });
    });

    it('the key holds a certificate, its key and the mTLS host — and no secret; the PEM files are owner-only', () => {
      expect(
        typeof x509.certificate === 'string' &&
          x509.certificate.includes('-----BEGIN CERTIFICATE-----'),
      ).toBe(true);
      expect(
        typeof x509.key === 'string' && x509.key.includes('PRIVATE KEY-----'),
      ).toBe(true);
      expect(x509.certurl).toMatch(/^https:\/\//);
      expect(typeof x509.clientid).toBe('string');
      expect('clientsecret' in x509).toBe(false);
      // setup.sh wrote them as given.
      expect(fs.readFileSync(certPath, 'utf8') === x509.certificate).toBe(true);
      expect(fs.readFileSync(keyPath, 'utf8') === x509.key).toBe(true);
      for (const file of [keyFile, certPath, keyPath]) {
        expect((fs.statSync(file).mode & 0o077) === 0).toBe(true);
      }
    });

    it('(a) AuthBroker + XsuaaServiceKeyStore + fromServiceKeyCertificate(): prepare() is Ok, and the token API returns a token of the key’s client', async () => {
      const broker = new AuthBroker({
        serviceKeyStore: new XsuaaServiceKeyStore(keysDir, {
          grantType: 'client_credentials',
        }),
        sessionStore: new SafeXsuaaSessionStore(),
        clientAuthentication: fromServiceKeyCertificate(),
      });
      const provider = await broker.getProvider(DESTINATION);
      expect(await provider.prepare()).toEqual({ ok: true });

      const token = await broker.getToken(DESTINATION);
      expect(clientOf(token) === x509.clientid).toBe(true);
      expect(claims(token).grant_type).toBe('client_credentials');
      log.info(
        `x509 (a): broker token of the key's client, ${String(token).length} chars`,
      );
    }, 120_000);

    it('(b) mcp-auth --credential --client-auth certificate: a token of the key’s client; a fresh broker over the exported destination gets one', async () => {
      const outDir = path.join(work, 'mcp-auth');
      const output = path.join(outDir, `${DESTINATION}.env`);
      const run = await withCallbackPortHeld(() =>
        mcpAuth(
          [
            '--service-key',
            keyFile,
            '--output',
            output,
            '--type',
            'xsuaa',
            '--credential',
            '--client-auth',
            'certificate',
            '--cert-path',
            certPath,
            '--key-path',
            keyPath,
          ],
          work,
        ),
      );
      expectSucceeded('mcp-auth', run);
      expect(pemFree(run.output)).toBe(true);

      const keys = expectPathsOnly(output);
      expect(clientOf(keys.XSUAA_JWT_TOKEN) === x509.clientid).toBe(true);
      // No PEM anywhere the command wrote.
      for (const file of filesUnder(work)) {
        expect(pemFree(fs.readFileSync(file, 'utf8'))).toBe(true);
      }

      const broker = freshBroker(outDir);
      expect(await (await broker.getProvider(DESTINATION)).prepare()).toEqual({
        ok: true,
      });
      const token = await broker.getToken(DESTINATION);
      expect(clientOf(token) === x509.clientid).toBe(true);
      log.info(
        'x509 (b): mcp-auth wrote paths only; a fresh broker got a token',
      );
    }, 120_000);

    it('(c) generate-env-from-service-key --grant client_credentials --client-auth certificate: a path-only .env; a fresh broker over it, from its final location, gets a token', async () => {
      const written = path.join(work, 'written', `${DESTINATION}.env`);
      const run = await withCallbackPortHeld(() =>
        generateEnv(
          [
            DESTINATION,
            keyFile,
            written,
            '--grant',
            'client_credentials',
            '--client-auth',
            'certificate',
            '--cert-path',
            certPath,
            '--key-path',
            keyPath,
          ],
          work,
        ),
      );
      expectSucceeded('generate-env-from-service-key', run);
      expect(pemFree(run.output)).toBe(true);

      const keys = expectPathsOnly(written);
      expect(clientOf(keys.XSUAA_JWT_TOKEN) === x509.clientid).toBe(true);

      // Moved where it is used: the paths it holds are absolute.
      const finalDir = path.join(work, 'final');
      fs.mkdirSync(finalDir);
      fs.renameSync(written, path.join(finalDir, `${DESTINATION}.env`));
      for (const file of filesUnder(work)) {
        expect(pemFree(fs.readFileSync(file, 'utf8'))).toBe(true);
      }

      const broker = freshBroker(finalDir);
      expect(await (await broker.getProvider(DESTINATION)).prepare()).toEqual({
        ok: true,
      });
      const token = await broker.getToken(DESTINATION);
      expect(clientOf(token) === x509.clientid).toBe(true);
      log.info(
        'x509 (c): generate-env wrote paths only; a fresh broker over the moved .env got a token',
      );
    }, 120_000);

    it('(d) a failing run — a private key that is not the certificate’s — leaves the previous destination untouched and prints no PEM', async () => {
      const foreign = foreignKeyPath();
      const certificateFlags = (key: string) => [
        '--client-auth',
        'certificate',
        '--cert-path',
        certPath,
        '--key-path',
        key,
      ];

      // generate-env: a good run, then the failing one over the same file.
      const session = path.join(work, 'generate-env', `${DESTINATION}.env`);
      const generateArgs = (key: string) => [
        DESTINATION,
        keyFile,
        session,
        '--grant',
        'client_credentials',
        ...certificateFlags(key),
      ];
      expectSucceeded(
        'generate-env (the previous destination)',
        await withCallbackPortHeld(() =>
          generateEnv(generateArgs(keyPath), work),
        ),
      );
      const before = fs.readFileSync(session);
      const failedGenerate = await withCallbackPortHeld(() =>
        generateEnv(generateArgs(foreign.file), work),
      );
      expect(failedGenerate.timedOut).toBe(false);
      expect(failedGenerate.status !== 0).toBe(true);
      expect(pemFree(failedGenerate.output, foreign.body)).toBe(true);
      expect(fs.readFileSync(session).equals(before)).toBe(true);

      // mcp-auth: the same over its --output.
      const output = path.join(work, 'mcp-auth', `${DESTINATION}.env`);
      const mcpAuthArgs = (key: string) => [
        '--service-key',
        keyFile,
        '--output',
        output,
        '--type',
        'xsuaa',
        '--credential',
        ...certificateFlags(key),
      ];
      expectSucceeded(
        'mcp-auth (the previous destination)',
        await withCallbackPortHeld(() => mcpAuth(mcpAuthArgs(keyPath), work)),
      );
      const previous = fs.readFileSync(output);
      const failedMcpAuth = await withCallbackPortHeld(() =>
        mcpAuth(mcpAuthArgs(foreign.file), work),
      );
      expect(failedMcpAuth.timedOut).toBe(false);
      expect(failedMcpAuth.status !== 0).toBe(true);
      expect(pemFree(failedMcpAuth.output, foreign.body)).toBe(true);
      expect(fs.readFileSync(output).equals(previous)).toBe(true);

      // Nothing either command wrote holds PEM — the foreign key file aside.
      for (const file of filesUnder(work).filter((f) => f !== foreign.file)) {
        expect(pemFree(fs.readFileSync(file, 'utf8'), foreign.body)).toBe(true);
      }
      log.info(
        `x509 (d): failing runs exited ${failedGenerate.status} / ${failedMcpAuth.status}; previous destinations untouched`,
      );
    }, 240_000);
  },
);
