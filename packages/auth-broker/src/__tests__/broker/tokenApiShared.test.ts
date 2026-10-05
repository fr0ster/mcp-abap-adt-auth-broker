/**
 * The token API without a consumer provider: `getToken`,
 * `refreshToken` and `createTokenRefresher` ask the very provider
 * `getProvider` hands out for the destination — one per destination, one token,
 * one refresh token, one renewal in flight — and write nothing themselves: the
 * provider's `onTokens` does. A failure of that write still reaches
 * the token API's caller, as in 3.x.
 *
 * The stores are in-memory fakes of the contract; the providers are real
 * (auth-providers 5) against a local token endpoint, driven through
 * `IAuthProvider` and the token API only.
 */

import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AuthBroker, DestinationConfigError } from '../../index';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com';
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  jest.useRealTimers();
  await endpoint.close();
});

function client(): IAuthorizationConfig {
  return {
    uaaUrl: endpoint.url,
    uaaClientId: 'broker-client',
    uaaClientSecret: 'S3CRET-client',
  };
}

/** What a secret obtained for the means below is bound to. */
const FOR = 'https://abap.example.com:443';
const by = () => `${endpoint.url}?client_id=broker-client`;

function keyStore(
  conn: IConnectionConfig | null,
  auth: IAuthorizationConfig | null = client(),
): jest.Mocked<IServiceKeyStore> {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => auth),
    getConnectionConfig: jest.fn(async (_d: string) => conn),
  };
}

/** A session store over a map; `saveSession` replaces what is held. */
function sessionStore(initial: IConfig | null = null): {
  store: jest.Mocked<ISessionStore>;
  held: () => IConfig | undefined;
} {
  const sessions = new Map<string, IConfig>();
  if (initial) sessions.set(D, { ...initial });
  const store: jest.Mocked<ISessionStore> = {
    loadSession: jest.fn(async (d: string) => {
      const s = sessions.get(d);
      return s ? { ...s } : null;
    }),
    saveSession: jest.fn(async (d: string, c: unknown) => {
      sessions.set(d, { ...(c as IConfig) });
    }),
    getAuthorizationConfig: jest.fn(async (_d: string) => null),
    getConnectionConfig: jest.fn(async (d: string) => sessions.get(d) ?? null),
    setAuthorizationConfig: jest.fn(
      async (_d: string, _c: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_d: string, _c: IConnectionConfig) => {},
    ),
  };
  return { store, held: () => sessions.get(D) };
}

/** A strategy that refuses every login: the provider must live on what it holds. */
function refusingStrategy(): IAuthorizationStrategy<string> {
  return {
    authorize: async (_request: AuthorizationRequest) => {
      throw new Error('no login here');
    },
  };
}

/** The bearer token a provider put on one request. */
async function bearer(provider: IAuthProvider): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  const request: IRequestTarget = {
    header: (name, value) => {
      headers[name] = value;
    },
    cookies: () => {},
  };
  expect(await provider.authorize(request)).toEqual({ ok: true });
  return headers.Authorization?.replace(/^Bearer /, '');
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a DestinationConfigError');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DestinationConfigError);
  return error as DestinationConfigError;
}

/** A `client_credentials` destination: no session read, a token at the first ask. */
function clientCredentials() {
  const { store, held } = sessionStore();
  const broker = new AuthBroker({
    sessionStore: store,
    serviceKeyStore: keyStore({
      authType: 'jwt',
      grantType: 'client_credentials',
      serviceUrl: SERVICE_URL,
    }),
  });
  return { broker, store, held };
}

/** An `authorization_code` destination seeded with a valid token and a refresh token. */
function seededAuthorizationCode() {
  const stored = jwtExpiringIn(3600, { jti: 'stored' });
  const { store, held } = sessionStore({
    authorizationToken: stored,
    refreshToken: 'stored-refresh',
    issuedFor: FOR,
    issuedBy: by(),
  });
  const broker = new AuthBroker({
    sessionStore: store,
    serviceKeyStore: keyStore({
      authType: 'jwt',
      grantType: 'authorization_code',
      serviceUrl: SERVICE_URL,
    }),
    authorization: () => refusingStrategy(),
  });
  return { broker, store, held, stored };
}

describe('the token API on the getProvider cache (no consumer provider)', () => {
  it('getProvider and getToken share one provider: one token, obtained once', async () => {
    const { broker } = clientCredentials();

    const provider = await broker.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    const presented = await bearer(provider);

    await expect(broker.getToken(D)).resolves.toBe(presented);
    await expect(broker.createTokenRefresher(D).getToken()).resolves.toBe(
      presented,
    );
    expect(endpoint.requests).toHaveLength(1);
  });

  it('getToken first, then getProvider: the provider presents the token getToken obtained', async () => {
    const { broker } = clientCredentials();

    const token = await broker.getToken(D);
    const provider = await broker.getProvider(D);

    await expect(bearer(provider)).resolves.toBe(token);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('refreshToken and a 401 in rejected() at once share one renewal: one refresh, one write', async () => {
    const { broker, store, held, stored } = seededAuthorizationCode();
    const provider = await broker.getProvider(D);
    expect(await bearer(provider)).toBe(stored);

    const [outcome, token] = await Promise.all([
      provider.rejected(UNAUTHORIZED),
      broker.refreshToken(D),
    ]);

    expect(outcome).toEqual({ ok: true });
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
    ]);
    expect(endpoint.requests[0]!.params.refresh_token).toBe('stored-refresh');
    expect(token).toBe(endpoint.issued[0]);
    await expect(bearer(provider)).resolves.toBe(token);
    expect(store.saveSession).toHaveBeenCalledTimes(1);
    expect(held()?.authorizationToken).toBe(token);
  });

  it('writes nothing itself: a cache hit writes nothing, a renewal is written once by onTokens', async () => {
    const { broker, store, held, stored } = seededAuthorizationCode();

    await expect(broker.getToken(D)).resolves.toBe(stored);
    expect(store.saveSession).not.toHaveBeenCalled();

    const renewed = await broker.refreshToken(D);
    expect(store.saveSession).toHaveBeenCalledTimes(1);
    expect(held()).toEqual({
      authorizationToken: renewed,
      expiresAt: expect.any(Number),
      refreshToken: 'refresh-1',
      issuedFor: FOR,
      issuedBy: by(),
    });
  });

  it('createTokenRefresher keeps its 3.x contract: getToken() is getToken, refreshToken() a forced renewal', async () => {
    const { broker, stored } = seededAuthorizationCode();
    const refresher = broker.createTokenRefresher(D);

    await expect(refresher.getToken()).resolves.toBe(stored);
    const renewed = await refresher.refreshToken();
    expect(renewed).not.toBe(stored);
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
    ]);
    await expect(refresher.getToken()).resolves.toBe(renewed);
  });

  describe('a write that fails', () => {
    class StoreDiskError extends Error {}

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    it("surfaces from getToken as the store raised it, while the provider keeps the token and the broker's retry writes it", async () => {
      const { broker, store, held } = clientCredentials();
      const disk = new StoreDiskError('disk full');
      store.saveSession.mockRejectedValueOnce(disk);

      await expect(broker.getToken(D)).rejects.toBe(disk);
      expect(endpoint.requests).toHaveLength(1);
      // The token stands: the provider holds it and presents it.
      const provider = await broker.getProvider(D);
      await expect(bearer(provider)).resolves.toBe(endpoint.issued[0]);
      expect(held()).toBeUndefined();

      await jest.advanceTimersByTimeAsync(1_000);

      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(endpoint.requests).toHaveLength(1);
    });

    it('refreshToken surfaces it too; a cache hit afterwards is not a failure', async () => {
      const { broker, store } = seededAuthorizationCode();
      const disk = new StoreDiskError('disk full');
      store.saveSession.mockRejectedValueOnce(disk);

      await expect(broker.refreshToken(D)).rejects.toBe(disk);
      await expect(broker.getToken(D)).resolves.toBe(endpoint.issued[0]);
    });
  });

  describe('destinations the token API does not serve', () => {
    it.each([
      ['basic', { username: 'DEVELOPER', password: 'Pa55-must-not-leak' }],
      [
        'snc',
        {
          sncPartnerName: 'p:CN=E19',
          sncQop: '9',
          sncLib: '/opt/snc/libsapcrypto.so',
        },
      ],
    ] as const)(
      'a %s destination is DestinationConfigError naming authType, and no provider is built or asked',
      async (authType, fields) => {
        const { store } = sessionStore({ authorizationToken: 'never-read' });
        const broker = new AuthBroker({
          sessionStore: store,
          serviceKeyStore: keyStore({
            authType,
            serviceUrl: SERVICE_URL,
            ...fields,
          }),
        });
        const getProvider = jest.spyOn(broker, 'getProvider');

        for (const call of [
          () => broker.getToken(D),
          () => broker.refreshToken(D),
          () => broker.createTokenRefresher(D).getToken(),
        ]) {
          const error = await refusal(call());
          expect(error.missingFields).toEqual(['authType']);
          for (const value of Object.values(fields)) {
            expect(error.message).not.toContain(value);
          }
        }
        expect(getProvider).not.toHaveBeenCalled();
        expect(store.loadSession).not.toHaveBeenCalled();
        expect(store.saveSession).not.toHaveBeenCalled();
      },
    );

    it.each(['jwt', 'saml'] as const)(
      'a %s / none destination has no token to renew: DestinationConfigError naming the provider option, before any provider is built',
      async (authType) => {
        const { store } = sessionStore({
          authorizationToken: 'HANDED-OVER-SECRET',
          sessionCookies: 'SAP_SESSIONID=HANDED-OVER-SECRET',
          issuedFor: FOR,
        });
        const broker = new AuthBroker({
          sessionStore: store,
          serviceKeyStore: keyStore({
            authType,
            grantType: 'none',
            serviceUrl: SERVICE_URL,
          }),
        });
        const getProvider = jest.spyOn(broker, 'getProvider');

        const error = await refusal(broker.getToken(D));
        expect(error.missingFields).toEqual(['provider']);
        expect(error.message).not.toContain('HANDED-OVER-SECRET');
        expect(getProvider).not.toHaveBeenCalled();
        expect(store.saveSession).not.toHaveBeenCalled();
      },
    );

    it('a destination getProvider refuses is refused by the token API the same way', async () => {
      const { store } = sessionStore();
      const broker = new AuthBroker({
        sessionStore: store,
        serviceKeyStore: keyStore({ authType: 'jwt', serviceUrl: SERVICE_URL }),
      });

      const error = await refusal(broker.getToken(D));
      expect(error.missingFields).toEqual(['grantType']);
    });
  });
});
