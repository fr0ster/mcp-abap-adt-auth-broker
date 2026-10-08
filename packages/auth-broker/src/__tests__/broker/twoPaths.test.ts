/**
 * Two paths, two providers (§7.1, §5.5).
 *
 * The row path — `getProvider`, and the token API without a `provider`
 * option — and the consumer path — the token API with one — each resolve,
 * cache and identify their own provider. With a consumer `provider`
 * configured, a `getProvider` and a `getToken` for one destination get two
 * different providers, each writing the session with its own record through
 * its own persistence path; a change of the means rebuilds each at its own
 * next call; and a build of one path never retires the other path's writes.
 *
 * The stores are in-memory stand-ins of the contract; the row's provider is
 * real, against a local token endpoint; the consumer's is a test double.
 * Expected records are assembled from the spec's grammar
 * (`helpers/bindingRecord`). Nothing opens a browser.
 */

import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AuthBroker, type TokenProviderFactory } from '../../index';
import { record, uaaRecord } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'TRIAL';
const CLIENT = 'sb-broker!t42';
const REDIRECT = 'http://localhost/callback';

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  await endpoint.close();
});

interface KeyState {
  means: Record<string, unknown>;
  client: IAuthorizationConfig;
}

function keyStore(state: KeyState): IServiceKeyStore {
  return {
    getServiceKey: async () => null,
    getConnectionConfig: async () => ({ ...state.means }) as IConnectionConfig,
    getAuthorizationConfig: async () => ({ ...state.client }),
  };
}

/** The contract's merge, recording every write in the order it landed. */
function sessionStore(): { store: ISessionStore; writes: IConfig[] } {
  let session: Record<string, unknown> = {};
  const writes: IConfig[] = [];
  return {
    writes,
    store: {
      loadSession: async () => ({ ...session }) as IConfig,
      saveSession: async (_d, config) => {
        writes.push({ ...(config as IConfig) });
        const next = { ...session };
        for (const [field, value] of Object.entries(config as object)) {
          if (value === undefined) continue;
          if (value === '') delete next[field];
          else next[field] = value;
        }
        session = next;
      },
      getAuthorizationConfig: async () => null,
      getConnectionConfig: async () => null,
      setAuthorizationConfig: async () => {},
      setConnectionConfig: async () => {},
    },
  };
}

/** A consumer's provider handing out `<label>-<n>`. */
function consumerProvider(label: string): IRefreshableTokenProvider {
  let n = 0;
  const answer = async (): Promise<ITokenResult> => {
    n += 1;
    return {
      authorizationToken: `${label}-${n}`,
      authType: 'authorization_code',
      expiresIn: 3600,
    };
  };
  return { getTokens: answer, refreshTokens: answer };
}

function setup(provider: 'factory' | 'instance') {
  const state: KeyState = {
    means: {
      authType: 'jwt',
      grantType: 'authorization_code',
      serviceUrl: 'https://abap.example.com/sap/bc/adt',
      sapClient: '100',
    },
    client: {
      uaaUrl: endpoint.url,
      uaaClientId: CLIENT,
      uaaClientSecret: 'S3CRET',
    },
  };
  const sessions = sessionStore();
  const builtByFactory: IRefreshableTokenProvider[] = [];
  const factory = jest.fn<
    ReturnType<TokenProviderFactory>,
    Parameters<TokenProviderFactory>
  >(() => {
    const built = consumerProvider(`factory${builtByFactory.length + 1}`);
    builtByFactory.push(built);
    return built;
  });
  const instance = consumerProvider('instance');
  const strategy: IAuthorizationStrategy<string> = {
    authorize: async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    },
    dispose: async () => {},
  };
  const authorization = jest.fn(() => strategy);
  const broker = new AuthBroker({
    ...STATED,
    sessionStore: sessions.store,
    serviceKeyStore: keyStore(state),
    authorization,
    provider: provider === 'factory' ? factory : instance,
  });
  return {
    state,
    sessions,
    factory,
    builtByFactory,
    instance,
    authorization,
    broker,
  };
}

const rowRecord = () => uaaRecord('authorization_code', endpoint.url, CLIENT);
const consumerRecord = (form: 'factory' | 'instance') =>
  record(
    'provider/jwt/authorization_code',
    form === 'factory' ? { clientId: CLIENT, uaaUrl: endpoint.url } : {},
    '',
  );

const asTokens = (provider: IAuthProvider) =>
  provider as unknown as IRefreshableTokenProvider;

describe.each(['factory', 'instance'] as const)(
  'with a consumer %s configured',
  (form) => {
    it.each(['getProvider first', 'getToken first'])(
      'a concurrent getProvider and getToken (%s): two distinct providers, each writing with its own record through its own path',
      async (order) => {
        const s = setup(form);
        const [provider, token] =
          order === 'getProvider first'
            ? await Promise.all([s.broker.getProvider(D), s.broker.getToken(D)])
            : await Promise.all([
                s.broker.getToken(D),
                s.broker.getProvider(D),
              ]).then(([t, p]) => [p, t] as const);

        // The row's builder ran once, the factory (when there is one) once.
        expect(s.authorization).toHaveBeenCalledTimes(1);
        expect(s.factory).toHaveBeenCalledTimes(form === 'factory' ? 1 : 0);
        // getProvider answered the row's provider, the token API the
        // consumer's.
        expect(provider).not.toBe(s.instance);
        expect(s.builtByFactory).not.toContain(provider);
        expect(token).toBe(form === 'factory' ? 'factory1-1' : 'instance-1');
        // The token API's own write, with the consumer's record.
        expect(s.sessions.writes).toEqual([
          expect.objectContaining({
            authorizationToken: token,
            issuedBy: consumerRecord(form),
          }),
        ]);

        // The row provider's own persistence, with the row's record.
        const rowToken = await asTokens(provider).getTokens();
        expect(rowToken.authorizationToken).toBe(endpoint.issued[0]);
        expect(s.sessions.writes.at(-1)).toEqual(
          expect.objectContaining({
            authorizationToken: endpoint.issued[0],
            refreshToken: 'refresh-1',
            issuedBy: rowRecord(),
          }),
        );

        // Each path keeps its own: the same provider and token source again.
        expect(await s.broker.getProvider(D)).toBe(provider);
        await expect(s.broker.getToken(D)).resolves.toBe(
          form === 'factory' ? 'factory1-2' : 'instance-2',
        );
        expect(s.authorization).toHaveBeenCalledTimes(1);
        expect(s.factory).toHaveBeenCalledTimes(form === 'factory' ? 1 : 0);
      },
    );

    it('a build of one path never drops the other path’s writes: all land, in queue order', async () => {
      const s = setup(form);
      const provider = await s.broker.getProvider(D);

      await asTokens(provider).getTokens();
      await s.broker.getToken(D);
      await asTokens(provider).refreshTokens();
      await s.broker.getToken(D);

      expect(s.sessions.writes.map((w) => w.issuedBy)).toEqual([
        rowRecord(),
        consumerRecord(form),
        rowRecord(),
        consumerRecord(form),
      ]);
    });
  },
);

it('a change of the means rebuilds each path’s provider at its own next call', async () => {
  const s = setup('factory');
  const provider = await s.broker.getProvider(D);
  await expect(s.broker.getToken(D)).resolves.toBe('factory1-1');

  s.state.means.sapClient = '200';

  // The row path rebuilds at getProvider — the factory is not called for it.
  const rebuilt = await s.broker.getProvider(D);
  expect(rebuilt).not.toBe(provider);
  expect(s.authorization).toHaveBeenCalledTimes(2);
  expect(s.factory).toHaveBeenCalledTimes(1);

  // The consumer path rebuilds at its own next call.
  await expect(s.broker.getToken(D)).resolves.toBe('factory2-1');
  expect(s.factory).toHaveBeenCalledTimes(2);
  expect(s.authorization).toHaveBeenCalledTimes(2);
});
