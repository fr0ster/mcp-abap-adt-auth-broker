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
 *
 * AUTH_BROKER_LIVE_KEYS_DIR is a directory of `<destination>.env` files read by
 * auth-stores 3's `EnvDestinationStore` — the means (`SAP_URL`,
 * `SAP_AUTH_TYPE`, `SAP_CLIENT`, `SAP_USERNAME` / `SAP_PASSWORD`, the
 * `SAP_SNC_*` keys). The address the connector dials is read from the same
 * means (`serviceUrl`, `sapClient`); the RFC system number is derived from the
 * URL's port by connection 10 unless `SAP_SYSNR` is set.
 *
 * Nothing here prints a value from the store: only status codes and sizes.
 *
 * The `jwt` / `authorization_code` case (a refused token renewed in
 * `rejected()` and persisted) needs the provider 4c builds, and joins then.
 */

import { createRequire } from 'node:module';
// connection 10 loads without the RFC addon: rfcConversationFrom requires it
// only when a conversation is opened, so the HTTP case runs where it is absent.
import {
  AdtOnPremConnector,
  OnPremHttpTransport,
  RfcTransport,
  rfcConversationFrom,
} from '@mcp-abap-adt/connection';
import type { IConnectionConfig } from '@mcp-abap-adt/interfaces-auth-broker';
// auth-stores 3 under an npm alias, for this file only: the library's other
// suites stay on auth-stores 1.x until step 4e (plan decision D7).
import { EnvDestinationStore, SafeAbapSessionStore } from 'auth-stores-3';
import { DefaultLogger, getLogLevel } from '@mcp-abap-adt/logger';
import { AuthBroker } from '../../index';

/** The logger the other suites use (createTestLogger's base), always on here: a live run's result is the point. */
const log = new DefaultLogger(getLogLevel());

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
  return rfcUnavailable();
}

/** Run the block, or skip it with the reason in its title and in the log. */
function describeWhere(
  title: string,
  unavailable: string | null,
  body: () => void,
): void {
  if (unavailable) {
    log.info(`skipped: ${title} — ${unavailable}`);
    describe.skip(`${title} — skipped: ${unavailable}`, body);
  } else {
    describe(title, body);
  }
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
