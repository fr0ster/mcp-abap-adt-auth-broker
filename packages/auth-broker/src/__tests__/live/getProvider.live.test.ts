/**
 * getProvider against real systems (spec §13 *Live*, H6): the provider a
 * destination states, handed to a `@mcp-abap-adt/connection` 10 connector,
 * logs on and is answered.
 *
 * Not part of `npm test`. Run with `npm run test:live` (from the repository
 * root or from `packages/auth-broker`); one case with `-t "<its title>"`.
 *
 * Each case states where it runs and reads only environment variables it
 * names. Where its conditions do not hold it is skipped, with the reason in its
 * title — a case that cannot run on this machine is not a failure:
 *
 *   - `basic` over HTTP: AUTH_BROKER_LIVE_KEYS_DIR, AUTH_BROKER_LIVE_BASIC_DESTINATION
 *   - `basic` over RFC:  AUTH_BROKER_LIVE_KEYS_DIR, AUTH_BROKER_LIVE_RFC_DESTINATION,
 *                        and `@mcp-abap-adt/sap-rfc-lite` built against the NW RFC SDK
 *   - `snc` over RFC:    Windows or macOS with the SAP Secure Login Client logged on,
 *                        AUTH_BROKER_LIVE_KEYS_DIR, AUTH_BROKER_LIVE_SNC_DESTINATION,
 *                        and `@mcp-abap-adt/sap-rfc-lite`
 *   - `jwt` / `authorization_code` over HTTP: a BTP ABAP environment (trial),
 *                        AUTH_BROKER_LIVE_SERVICE_KEYS_DIR, AUTH_BROKER_LIVE_JWT_DESTINATION,
 *                        AUTH_BROKER_LIVE_SESSIONS_DIR
 *
 * AUTH_BROKER_LIVE_KEYS_DIR is a directory of `<destination>.env` files read by
 * auth-stores 3's `EnvDestinationStore` — the means (`SAP_URL`,
 * `SAP_AUTH_TYPE`, `SAP_CLIENT`, `SAP_USERNAME` / `SAP_PASSWORD`, the
 * `SAP_SNC_*` keys). The address the connector dials is read from the same
 * means (`serviceUrl`, `sapClient`); the RFC system number is derived from the
 * URL's port by connection 10 unless `SAP_SYSNR` is set.
 *
 * The `jwt` case's means come from the destination's SAP service key,
 * `<destination>.json` in AUTH_BROKER_LIVE_SERVICE_KEYS_DIR, read by auth-stores
 * 3's `AbapServiceKeyStore`: the client (`uaa.*`), the ABAP URL and client. The
 * grant is stated by whoever builds the store, never read from the key (a SAP
 * key cannot state one): until auth-stores 3.1.0 gives `AbapServiceKeyStore`
 * its `grantType` option, `withGrant` below adds it (plan D8). The URL the
 * connector dials is the key's; `getProvider` needs none (D8). Its session —
 * `<destination>.env` in AUTH_BROKER_LIVE_SESSIONS_DIR, read by auth-stores 3's
 * `AbapSessionStore`, which reads a 2.x/3.x file's secret keys only — must hold
 * a refresh token from an earlier login. The case copies that file to a temporary directory and never
 * writes the original; it seeds the copy with a well-formed JWT the system
 * refuses (an `exp` an hour ahead, so the provider trusts it), and the 401 is
 * renewed by the stored refresh token in `rejected()` — no login, no browser:
 * the `authorization` strategy it passes refuses. Where the server rotates
 * refresh tokens, the run spends the original file's refresh token; log in
 * again afterwards (I have not measured whether XSUAA rotates them).
 *
 * Nothing here prints a value from the store: only status codes and sizes.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
// connection 10 loads without the RFC addon: rfcConversationFrom requires it
// only when a conversation is opened, so the HTTP case runs where it is absent.
import {
  AdtCloudConnector,
  AdtOnPremConnector,
  CloudHttpTransport,
  OnPremHttpTransport,
  RfcTransport,
  rfcConversationFrom,
} from '@mcp-abap-adt/connection';
import type {
  IAuthorizationStrategy,
  IAuthProvider,
  IAuthRejection,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  DestinationGrant,
  IConnectionConfig,
  IServiceKeyStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
// auth-stores 3 under an npm alias, for this file only: the library's other
// suites stay on auth-stores 1.x until step 4e (plan decision D7).
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  EnvDestinationStore,
  SafeAbapSessionStore,
} from 'auth-stores-3';
import { AuthBroker } from '../../index';
import { describeWhere, runLog as log } from '../helpers/describeWhere';

const env = process.env;

/** A silent logger for the connector: the case prints only what it asserts. */
const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** The lightest ADT read connection 10's own live suite measures. */
const PROBE = '/sap/bc/adt/compatibility/graph';

type ConnectorConfig = ConstructorParameters<typeof AdtOnPremConnector>[0];

/** The variables among `names` that are not set, or are set to ''. */
function unset(names: string[]): string[] {
  return names.filter((name) => !env[name]);
}

/**
 * Why the RFC wire cannot be taken here, or null when it can. The probe asks
 * from where connection 10 itself will `require` it (`rfcConversationFrom`):
 * the addon is connection's optional dependency, built at install time only
 * when the NW RFC SDK is found (`SAPNWRFC_HOME`), and must also load — which
 * needs the SDK's libraries on the loader path.
 */
function rfcUnavailable(): string | null {
  try {
    createRequire(require.resolve('@mcp-abap-adt/connection'))(
      '@mcp-abap-adt/sap-rfc-lite',
    );
    return null;
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error))
      .split('\n')[0]
      .slice(0, 200);
    return `@mcp-abap-adt/sap-rfc-lite does not load here — install with SAPNWRFC_HOME set to the NW RFC SDK, and put its lib on the loader path (${first})`;
  }
}

function basicHttpUnavailable(): string | null {
  const missing = unset([
    'AUTH_BROKER_LIVE_KEYS_DIR',
    'AUTH_BROKER_LIVE_BASIC_DESTINATION',
  ]);
  return missing.length
    ? `no on-premise destination configured: set ${missing.join(', ')}`
    : null;
}

function basicRfcUnavailable(): string | null {
  const missing = unset([
    'AUTH_BROKER_LIVE_KEYS_DIR',
    'AUTH_BROKER_LIVE_RFC_DESTINATION',
  ]);
  if (missing.length) {
    return `no on-premise RFC destination configured: set ${missing.join(', ')}`;
  }
  return rfcUnavailable();
}

function sncUnavailable(): string | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return `the SAP Secure Login Client exists only on Windows and macOS; this is ${process.platform}`;
  }
  const missing = unset([
    'AUTH_BROKER_LIVE_KEYS_DIR',
    'AUTH_BROKER_LIVE_SNC_DESTINATION',
  ]);
  if (missing.length) {
    return `no SNC destination configured: set ${missing.join(', ')}`;
  }
  // Decided by sncLibrary.setup.ts (the live config's globalSetup): empty
  // when a library was found, else why none was.
  const library = env.AUTH_BROKER_LIVE_SNC_LIBRARY;
  if (library === undefined) {
    return 'the SNC library was not looked for: run through `npm run test:live` (its globalSetup searches for it)';
  }
  if (library) return library;
  return rfcUnavailable();
}

function jwtUnavailable(): string | null {
  const missing = unset([
    'AUTH_BROKER_LIVE_SERVICE_KEYS_DIR',
    'AUTH_BROKER_LIVE_JWT_DESTINATION',
    'AUTH_BROKER_LIVE_SESSIONS_DIR',
  ]);
  return missing.length
    ? `no BTP ABAP destination configured: set ${missing.join(', ')}`
    : null;
}

/** The broker over the means directory; the session store is never read here. */
function brokerAndMeans(): {
  broker: AuthBroker;
  keys: EnvDestinationStore;
} {
  const keys = new EnvDestinationStore(env.AUTH_BROKER_LIVE_KEYS_DIR as string);
  return {
    broker: new AuthBroker({
      serviceKeyStore: keys,
      sessionStore: new SafeAbapSessionStore(),
    }),
    keys,
  };
}

/** Where the connector dials, from the destination's means. */
async function addressOf(
  keys: EnvDestinationStore,
  destination: string,
): Promise<ConnectorConfig> {
  const means: IConnectionConfig | null =
    await keys.getConnectionConfig(destination);
  if (!means?.serviceUrl) {
    throw new Error(
      `destination "${destination}" states no SAP_URL in ${env.AUTH_BROKER_LIVE_KEYS_DIR}`,
    );
  }
  return {
    url: means.serviceUrl,
    client: means.sapClient,
    authType: 'basic',
  };
}

function byteSize(data: unknown): number {
  return typeof data === 'string'
    ? Buffer.byteLength(data)
    : Buffer.byteLength(JSON.stringify(data ?? ''));
}

describeWhere(
  'basic over HTTP — an on-premise system (getProvider → connection 10 OnPremHttpTransport)',
  basicHttpUnavailable(),
  () => {
    it('logs on with the provider getProvider built and is answered 200', async () => {
      const destination = env.AUTH_BROKER_LIVE_BASIC_DESTINATION as string;
      const { broker, keys } = brokerAndMeans();
      const config = await addressOf(keys, destination);
      const connector = new AdtOnPremConnector(
        config,
        await broker.getProvider(destination),
        new OnPremHttpTransport(() => ({}), quiet, {
          client: config.client,
          baseUrl: config.url,
        }),
        quiet,
      );
      try {
        await connector.connect();
        const response = await connector.makeAdtRequest({
          method: 'GET',
          url: PROBE,
          headers: { Accept: 'application/xml' },
          timeout: 15_000,
        });
        log.info(
          `basic over HTTP: GET ${PROBE} → ${response.status}, ${byteSize(response.data)} bytes`,
        );
        expect(response.status).toBe(200);
      } finally {
        await connector.disconnect();
      }
    }, 60_000);
  },
);

describeWhere(
  'basic over RFC — an on-premise system with the NW RFC SDK (getProvider → rfcConversationFrom)',
  basicRfcUnavailable(),
  () => {
    it('logs on over RFC with the provider getProvider built and is answered 200', async () => {
      const destination = env.AUTH_BROKER_LIVE_RFC_DESTINATION as string;
      const { broker, keys } = brokerAndMeans();
      const config = await addressOf(keys, destination);
      const connector = new AdtOnPremConnector(
        config,
        await broker.getProvider(destination),
        new RfcTransport(rfcConversationFrom(config), quiet),
        quiet,
      );
      try {
        await connector.connect();
        const response = await connector.makeAdtRequest({
          method: 'GET',
          url: PROBE,
          headers: { Accept: 'application/xml' },
          timeout: 15_000,
        });
        log.info(
          `basic over RFC: GET ${PROBE} → ${response.status}, ${byteSize(response.data)} bytes`,
        );
        expect(response.status).toBe(200);
      } finally {
        await connector.disconnect();
      }
    }, 60_000);
  },
);

describeWhere(
  'snc over RFC — Windows or macOS with the SAP Secure Login Client logged on (getProvider → rfcConversationFrom)',
  sncUnavailable(),
  () => {
    it('logs on without a password and is answered 200', async () => {
      const destination = env.AUTH_BROKER_LIVE_SNC_DESTINATION as string;
      const { broker, keys } = brokerAndMeans();
      const config = await addressOf(keys, destination);
      const connector = new AdtOnPremConnector(
        config,
        await broker.getProvider(destination),
        new RfcTransport(rfcConversationFrom(config), quiet),
        quiet,
      );
      try {
        await connector.connect();
        const response = await connector.makeAdtRequest({
          method: 'GET',
          url: PROBE,
          timeout: 15_000,
        });
        log.info(
          `snc over RFC: GET ${PROBE} → ${response.status}, ${byteSize(response.data)} bytes`,
        );
        expect(response.status).toBe(200);
      } finally {
        await connector.disconnect();
      }
    }, 90_000);
  },
);

/** A JWT the system did not issue: well-formed, unsigned, `exp` an hour ahead. */
function refusedJwt(): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    sub: 'auth-broker-live',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.refused`;
}

/** The provider, with every rejection it is handed recorded. */
function recordingRejections(provider: IAuthProvider): {
  provider: IAuthProvider;
  rejections: IAuthRejection[];
} {
  const rejections: IAuthRejection[] = [];
  return {
    rejections,
    provider: {
      kind: provider.kind,
      prepare: () => provider.prepare(),
      establish: (logon) => provider.establish(logon),
      authorize: (request) => provider.authorize(request),
      rejected: (rejection) => {
        rejections.push(rejection);
        return provider.rejected(rejection);
      },
    },
  };
}

/**
 * UNTIL auth-stores 3.1.0 — replaced in the binding step by
 * `new AbapServiceKeyStore(dir, { grantType })`. A key store over SAP service
 * keys whose grant is stated here, by whoever builds it, because a SAP key
 * cannot state one (spec §1.2 item 3). Everything else is the wrapped store's
 * answer, unchanged.
 */
function withGrant(
  keys: IServiceKeyStore,
  grantType: DestinationGrant,
): IServiceKeyStore {
  return {
    getServiceKey: (destination) => keys.getServiceKey(destination),
    getAuthorizationConfig: (destination) =>
      keys.getAuthorizationConfig(destination),
    getConnectionConfig: async (destination) => {
      const means = await keys.getConnectionConfig(destination);
      return means ? { ...means, grantType } : null;
    },
  };
}

/** This case renews by refresh: a login would mean a browser, so it is refused. */
const refuseLogin: IAuthorizationStrategy<string> = {
  authorize: async () => {
    throw new Error(
      'this case renews by the stored refresh token; it never logs in',
    );
  },
};

describeWhere(
  'jwt / authorization_code over HTTP — a BTP ABAP environment (getProvider → connection 10 CloudHttpTransport)',
  jwtUnavailable(),
  () => {
    let copy: string;

    beforeEach(() => {
      copy = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-live-jwt-'));
    });

    afterEach(() => {
      fs.rmSync(copy, { recursive: true, force: true });
    });

    it('a refused token is renewed in rejected(), and the new token is in the session file', async () => {
      const destination = env.AUTH_BROKER_LIVE_JWT_DESTINATION as string;
      const original = path.join(
        env.AUTH_BROKER_LIVE_SESSIONS_DIR as string,
        `${destination}.env`,
      );
      if (!fs.existsSync(original)) {
        throw new Error(
          `no session file for "${destination}" in AUTH_BROKER_LIVE_SESSIONS_DIR: log in once with the CLI`,
        );
      }
      fs.copyFileSync(original, path.join(copy, `${destination}.env`));
      const sessions = new AbapSessionStore(copy);
      const stored = await sessions.loadSession(destination);
      if (!stored?.refreshToken) {
        throw new Error(
          `the session of "${destination}" holds no refresh token: log in again with the CLI`,
        );
      }
      const refused = refusedJwt();
      await sessions.saveSession(destination, {
        authorizationToken: refused,
        refreshToken: stored.refreshToken,
      });

      const keys = withGrant(
        new AbapServiceKeyStore(
          env.AUTH_BROKER_LIVE_SERVICE_KEYS_DIR as string,
        ),
        'authorization_code',
      );
      const broker = new AuthBroker({
        serviceKeyStore: keys,
        sessionStore: sessions,
        authorization: () => refuseLogin,
      });
      const means: IConnectionConfig | null =
        await keys.getConnectionConfig(destination);
      if (!means?.serviceUrl) {
        throw new Error(
          `the service key of "${destination}" in AUTH_BROKER_LIVE_SERVICE_KEYS_DIR states no ABAP URL`,
        );
      }
      const recorded = recordingRejections(
        await broker.getProvider(destination),
      );
      const connector = new AdtCloudConnector(
        { url: means.serviceUrl, client: means.sapClient, authType: 'jwt' },
        recorded.provider,
        new CloudHttpTransport(() => ({}), quiet, {
          client: means.sapClient,
          baseUrl: means.serviceUrl,
        }),
        quiet,
      );
      try {
        await connector.connect();
        const response = await connector.makeAdtRequest({
          method: 'GET',
          url: PROBE,
          headers: { Accept: 'application/xml' },
          timeout: 15_000,
        });
        log.info(
          `jwt over HTTP: ${recorded.rejections.length} rejection(s) (${recorded.rejections
            .map((r) => r.status ?? r.at)
            .join(
              ', ',
            )}); GET ${PROBE} → ${response.status}, ${byteSize(response.data)} bytes`,
        );
        expect(response.status).toBe(200);
      } finally {
        await connector.disconnect();
      }

      expect(recorded.rejections.map((r) => r.status)).toEqual([401]);
      await broker.flush();
      const after = await sessions.loadSession(destination);
      expect(after?.authorizationToken).toEqual(expect.any(String));
      expect(after?.authorizationToken).not.toBe(refused);
      log.info(
        `jwt over HTTP: the session file holds a new token (${after?.authorizationToken?.length} chars)`,
      );
    }, 90_000);
  },
);
