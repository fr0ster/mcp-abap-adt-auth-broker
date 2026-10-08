/**
 * The token API with a consumer's own provider: the 3.x behaviour,
 * against mocked stores and providers, and once against auth-stores 3's real
 * `AbapSessionStore` and `EnvDestinationStore` on disk (no network).
 *
 * What changed from 3.x is what is written: the session secret alone —
 * the token or cookies, `expiresAt`, the refresh token, and what the secret is
 * bound to (`issuedFor` / `issuedBy`) — through the broker's one write
 * path, retried when the store fails; never `serviceUrl`, `authType` or a
 * client. What a caller observes is as 3.x: the token, the provider asked as
 * before, the stores read in the 3.x order, a store's failure thrown as raised.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthProviderFailure,
  authError,
  isAuthProviderFailure,
  readFailure,
} from '@mcp-abap-adt/auth-errors';
import {
  ABAP_DESTINATION_VARS,
  ABAP_SESSION_VARS,
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import { AuthBroker, type TokenProviderFactory } from '../../AuthBroker';
import { DestinationConfigError } from '../../DestinationConfigError';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '../../stores/interfaces';
import { record } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import { jwtExpiringIn } from '../helpers/tokenEndpoint';

const SERVICE_URL = 'https://abap.example.com';
/** `SERVICE_URL` as the binding writes it: the canonical URI. */
const SERVICE_URI = 'https://abap.example.com:443';
const KEY_AUTH: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'client-id',
  uaaClientSecret: 'client-secret-from-key',
};
/**
 * The token API's consumer provider, with means that state no row: the record
 * `provider/-` — for a factory with `KEY_AUTH`'s client id and `uaaUrl`, for an
 * instance (handed no client) with none.
 */
const KEY_ISSUER = record(
  'provider/-',
  { clientId: 'client-id', uaaUrl: 'https://uaa.example.com' },
  '',
);
const INSTANCE_BY = record('provider/-', {}, '');

type MockProvider = IRefreshableTokenProvider & {
  getTokens: jest.Mock<Promise<ITokenResult>, []>;
  refreshTokens: jest.Mock<Promise<ITokenResult>, []>;
};

function mockProvider(
  cached: Partial<ITokenResult> = {},
  fresh: Partial<ITokenResult> = {},
): MockProvider {
  return {
    getTokens: jest.fn(async () => ({
      authorizationToken: 'cached-token',
      authType: 'authorization_code' as const,
      ...cached,
    })),
    refreshTokens: jest.fn(async () => ({
      authorizationToken: 'fresh-token',
      authType: 'authorization_code' as const,
      ...fresh,
    })),
  };
}

function mockSessionStore(
  conn: IConnectionConfig | null = null,
  auth: IAuthorizationConfig | null = null,
  session: Record<string, unknown> | null = null,
): jest.Mocked<ISessionStore> {
  return {
    loadSession: jest.fn(async (_destination: string) => session),
    saveSession: jest.fn(async (_destination: string, _config: unknown) => {}),
    getAuthorizationConfig: jest.fn(async (_destination: string) => auth),
    getConnectionConfig: jest.fn(async (_destination: string) => conn),
    setAuthorizationConfig: jest.fn(
      async (_destination: string, _config: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_destination: string, _config: IConnectionConfig) => {},
    ),
  };
}

function mockServiceKeyStore(
  auth: IAuthorizationConfig | null = KEY_AUTH,
  conn: IConnectionConfig | null = { serviceUrl: SERVICE_URL },
): jest.Mocked<IServiceKeyStore> {
  return {
    getServiceKey: jest.fn(async (_destination: string) => null),
    getAuthorizationConfig: jest.fn(async (_destination: string) => auth),
    getConnectionConfig: jest.fn(async (_destination: string) => conn),
  };
}

/** Everything the broker wrote to the session store, as one string. */
function everythingWritten(store: jest.Mocked<ISessionStore>): string {
  return JSON.stringify([
    store.setConnectionConfig.mock.calls,
    store.setAuthorizationConfig.mock.calls,
    store.saveSession.mock.calls,
  ]);
}

/**
 * The fields the last `saveSession` call carried — a field given as
 * `undefined` is not carried (auth-stores 3) — and proof that nothing went
 * through another method.
 */
function lastWrite(store: jest.Mocked<ISessionStore>): Record<string, unknown> {
  expect(store.setConnectionConfig).not.toHaveBeenCalled();
  expect(store.setAuthorizationConfig).not.toHaveBeenCalled();
  const calls = store.saveSession.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return Object.fromEntries(
    Object.entries(calls[calls.length - 1]![1] as object).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

describe('AuthBroker', () => {
  describe('constructor', () => {
    it('takes a provider instance', () => {
      expect(
        () =>
          new AuthBroker({
            ...STATED,
            sessionStore: mockSessionStore(),
            provider: mockProvider(),
          }),
      ).not.toThrow();
    });

    it('takes a provider factory', () => {
      const factory: TokenProviderFactory = () => mockProvider();
      expect(
        () =>
          new AuthBroker({
            ...STATED,
            sessionStore: mockSessionStore(),
            provider: factory,
          }),
      ).not.toThrow();
    });

    it('refuses a provider that cannot refresh', () => {
      const provider = { getTokens: jest.fn() };
      expect(
        () =>
          new AuthBroker({
            ...STATED,
            sessionStore: mockSessionStore(),
            provider: provider as unknown as IRefreshableTokenProvider,
          }),
      ).toThrow('provider.refreshTokens must be a function');
    });

    it('refuses a missing session store', () => {
      expect(
        () =>
          new AuthBroker({
            ...STATED,
            sessionStore: undefined as unknown as ISessionStore,
            provider: mockProvider(),
          }),
      ).toThrow('sessionStore is required');
    });

    it('takes no provider: getProvider needs none', () => {
      expect(
        () => new AuthBroker({ ...STATED, sessionStore: mockSessionStore() }),
      ).not.toThrow();
    });

    it('without a provider or a key store, the token API names both options', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const broker = new AuthBroker({ ...STATED, sessionStore });

      for (const call of [
        () => broker.getToken('DEST'),
        () => broker.refreshToken('DEST'),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DestinationConfigError);
        expect((error as DestinationConfigError).missingFields).toEqual([
          'provider',
          'serviceKeyStore',
        ]);
      }
      expect(everythingWritten(sessionStore)).toBe('[[],[],[]]');
    });

    it('logs the provider option as it is: none, factory or instance', () => {
      const forms: Array<[string, unknown]> = [
        ['none', undefined],
        ['factory', (() => mockProvider()) as TokenProviderFactory],
        ['instance', mockProvider()],
      ];
      for (const [form, provider] of forms) {
        const logger = {
          debug: jest.fn(),
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        };
        new AuthBroker(
          {
            ...STATED,
            sessionStore: mockSessionStore(),
            provider: provider as IRefreshableTokenProvider | undefined,
          },
          logger,
        );
        expect(logger.debug).toHaveBeenCalledWith(
          '[AuthBroker] Broker initialized',
          expect.objectContaining({ providerForm: form }),
        );
      }
    });

    it('refuses a service key store missing a method', () => {
      const serviceKeyStore = mockServiceKeyStore();
      delete (serviceKeyStore as Partial<IServiceKeyStore>).getServiceKey;
      expect(
        () =>
          new AuthBroker({
            ...STATED,
            sessionStore: mockSessionStore(),
            serviceKeyStore,
            provider: mockProvider(),
          }),
      ).toThrow('serviceKeyStore.getServiceKey must be a function');
    });
  });

  describe('getToken', () => {
    it('asks the provider once and writes the bearer token: the secret alone, with the resource it was obtained for', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const provider = mockProvider({ refreshToken: 'refresh-1' });
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');

      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(provider.refreshTokens).not.toHaveBeenCalled();
      // No serviceUrl, no authType (3.x wrote both); an instance is handed no
      // client by the broker, so its record names no client.
      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: 'refresh-1',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
    });

    it('writes a SAML result as session cookies', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const provider = mockProvider({
        authorizationToken: 'MYSAPSSO2=abc',
        tokenType: 'saml',
        authType: 'user_token',
        expiresAt: 1_900_000_000_000,
      });
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      await broker.getToken('DEST');

      expect(lastWrite(sessionStore)).toEqual({
        sessionCookies: 'MYSAPSSO2=abc',
        expiresAt: 1_900_000_000_000,
        refreshToken: '',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
    });

    it('takes the service URL from the service key when the session has none, and writes it nowhere', async () => {
      const sessionStore = mockSessionStore();
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory.mock.calls[0]![2]).toEqual(
        expect.objectContaining({ serviceUrl: SERVICE_URL }),
      );
      // A factory is handed the client: the issuer it is bound to.
      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: '',
        issuedFor: SERVICE_URI,
        issuedBy: KEY_ISSUER,
      });
    });

    it('binds an instance’s token to no client: the broker hands an instance no client, whatever the key store states', async () => {
      const sessionStore = mockSessionStore();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });

      await broker.getToken('DEST');

      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: '',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
    });

    it('fails without a service URL anywhere, before asking the provider', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(),
        provider,
      });

      await expect(broker.getToken('DEST')).rejects.toThrow(
        "missing required field 'serviceUrl'",
      );
      expect(provider.getTokens).not.toHaveBeenCalled();
    });

    it('writes a new refresh token as part of the secret, never through the client the session holds', async () => {
      const sessionAuth: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'session-client',
        uaaClientSecret: 'session-secret',
        refreshToken: 'old-refresh',
      };
      const sessionStore = mockSessionStore(
        { serviceUrl: SERVICE_URL },
        sessionAuth,
      );
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        provider: mockProvider({ refreshToken: 'new-refresh' }),
      });

      await broker.getToken('DEST');

      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: 'new-refresh',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
      expect(everythingWritten(sessionStore)).not.toContain('session-secret');
    });

    it('never copies the client secret from the service key into the session', async () => {
      const sessionStore = mockSessionStore(null, null, {
        serviceUrl: SERVICE_URL,
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: (_dest, auth) => {
          // The provider does get the secret — from the service key.
          expect(auth?.uaaClientSecret).toBe(KEY_AUTH.uaaClientSecret);
          return mockProvider({ refreshToken: 'refresh-1' });
        },
      });

      await broker.getToken('DEST');

      expect(lastWrite(sessionStore)).toEqual(
        expect.objectContaining({ refreshToken: 'refresh-1' }),
      );
      expect(everythingWritten(sessionStore)).not.toContain(
        KEY_AUTH.uaaClientSecret,
      );
      expect(everythingWritten(sessionStore)).not.toContain('uaaClientSecret');
    });

    it('writes refreshToken "" when the result has none: the stored one is never carried (D5)', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL }, null, {
        refreshToken: 'stored-refresh',
        issuedFor: 'https://elsewhere.example.com:443',
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        provider: mockProvider(),
      });

      await broker.getToken('DEST');

      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: '',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
      expect(everythingWritten(sessionStore)).not.toContain('stored-refresh');
    });

    it('writes after every call, cache hits included', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const provider = mockProvider();
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      await broker.getToken('DEST');
      await broker.getToken('DEST');

      expect(provider.getTokens).toHaveBeenCalledTimes(2);
      expect(sessionStore.saveSession).toHaveBeenCalledTimes(2);
    });

    it('fails when the provider returns no token', async () => {
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: mockProvider({ authorizationToken: '' }),
      });

      const thrown = await broker.getToken('DEST').catch((e: unknown) => e);
      expect(readFailure(thrown, 'unfamiliar-error').facts).toEqual({
        operation: 'token-source',
        problem: 'no-access-token',
      });
    });
  });

  describe('a destination stated basic or snc', () => {
    it.each(['basic', 'snc'] as const)(
      'is refused before any provider is asked, and nothing is written: %s',
      async (authType) => {
        const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
        const instance = mockProvider();
        const factory = jest.fn<
          IRefreshableTokenProvider,
          Parameters<TokenProviderFactory>
        >(() => mockProvider());
        const keys = mockServiceKeyStore(KEY_AUTH, {
          serviceUrl: SERVICE_URL,
          authType,
          username: 'DEVELOPER',
        });

        for (const provider of [instance, factory]) {
          const broker = new AuthBroker({
            ...STATED,
            sessionStore,
            serviceKeyStore: keys,
            provider,
          });
          const refresher = broker.createTokenRefresher('DEST');
          for (const call of [
            () => broker.getToken('DEST'),
            () => broker.refreshToken('DEST'),
            () => refresher.getToken(),
            () => refresher.refreshToken(),
          ]) {
            const error = await call().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(DestinationConfigError);
            expect((error as DestinationConfigError).missingFields).toEqual([
              'authType',
            ]);
            expect(String(error)).not.toContain('DEVELOPER');
          }
        }
        expect(instance.getTokens).not.toHaveBeenCalled();
        expect(instance.refreshTokens).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(everythingWritten(sessionStore)).toBe('[[],[],[]]');
      },
    );

    it('a key store that states no authType — a 3.x setup — is served as in 3.x', async () => {
      const sessionStore = mockSessionStore();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(KEY_AUTH, {
          serviceUrl: SERVICE_URL,
        }),
        provider: mockProvider(),
      });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
    });
  });

  describe('the binding is fixed when the provider is built', () => {
    /** A session store over a map: what is written is what a new broker reads. */
    function mapSessionStore(conn: () => IConnectionConfig | null) {
      const held = new Map<string, Record<string, unknown>>();
      const store = mockSessionStore();
      store.getConnectionConfig.mockImplementation(async () => conn());
      store.loadSession.mockImplementation(
        async (d: string) => held.get(d) ?? null,
      );
      store.saveSession.mockImplementation(async (d: string, c: unknown) => {
        held.set(d, { ...(c as Record<string, unknown>) });
      });
      return { store, held };
    }

    it('a changed serviceUrl does not re-label what the cached factory provider obtained, and a fresh broker does not seed it for the new resource', async () => {
      let serviceUrl = SERVICE_URL;
      const { store, held } = mapSessionStore(() => ({ serviceUrl }));
      const token = jwtExpiringIn(3600, { jti: 'obtained-for-A' });
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider({ authorizationToken: token }));
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: mockServiceKeyStore(),
        provider: factory,
      });

      await broker.getToken('DEST');
      serviceUrl = 'https://other.example.com';
      await broker.getToken('DEST');

      expect(factory).toHaveBeenCalledTimes(1);
      expect(store.saveSession).toHaveBeenCalledTimes(2);
      for (const [, written] of store.saveSession.mock.calls) {
        expect(written).toEqual(
          expect.objectContaining({
            authorizationToken: token,
            issuedFor: SERVICE_URI,
            issuedBy: KEY_ISSUER,
          }),
        );
      }

      // A new process whose means now name the other resource: the stored
      // token was obtained for SERVICE_URL, so it is not seeded — a login is
      // asked for instead.
      const login = jest.fn(async () => {
        throw new Error('login refused');
      });
      const fresh = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: mockServiceKeyStore(KEY_AUTH, {
          authType: 'jwt',
          grantType: 'authorization_code',
          serviceUrl,
        }),
        authorization: () => ({ authorize: login }),
      });
      const outcome = await (await fresh.getProvider('DEST')).prepare();
      expect(outcome.ok).toBe(false);
      expect(login).toHaveBeenCalledTimes(1);
      expect(held.get('DEST')?.authorizationToken).toBe(token);
    });

    it('a changed client does not re-label what the cached factory provider obtained', async () => {
      const keys = mockServiceKeyStore();
      const store = mockSessionStore({ serviceUrl: SERVICE_URL });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keys,
        provider: () => mockProvider(),
      });

      await broker.getToken('DEST');
      keys.getAuthorizationConfig.mockResolvedValue({
        uaaUrl: 'https://other-uaa.example.com',
        uaaClientId: 'other-client',
        uaaClientSecret: 'other-secret',
      });
      await broker.getToken('DEST');

      expect(store.saveSession).toHaveBeenCalledTimes(2);
      for (const [, written] of store.saveSession.mock.calls) {
        expect(written).toEqual(
          expect.objectContaining({
            issuedFor: SERVICE_URI,
            issuedBy: KEY_ISSUER,
          }),
        );
      }
    });

    it('an instance: the binding is fixed at the destination’s first call', async () => {
      let conn: IConnectionConfig = {
        serviceUrl: SERVICE_URL,
        sapClient: '100',
      };
      const store = mockSessionStore();
      store.getConnectionConfig.mockImplementation(async () => conn);
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        provider: mockProvider(),
      });

      await broker.getToken('DEST');
      conn = { serviceUrl: 'https://other.example.com', sapClient: '200' };
      await broker.getToken('DEST');

      for (const [, written] of store.saveSession.mock.calls) {
        expect(written).toEqual(
          expect.objectContaining({
            issuedFor: `${SERVICE_URI}?sap-client=100`,
          }),
        );
      }
    });
  });

  describe('a write that fails (onWriteFailure: fail)', () => {
    class StoreDiskError extends Error {}

    /** The call's failure for a write that did not land: never the store's error itself. */
    function expectPersistingFailed(thrown: unknown, storeError: unknown) {
      expect(thrown).not.toBe(storeError);
      expect(isAuthProviderFailure(thrown)).toBe(true);
      const error = readFailure(thrown, 'unfamiliar-error');
      expect(error.kind).toBe('unknown');
      expect(error.facts).toEqual({ operation: 'persisting-tokens' });
    }

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("fails getToken's caller with persisting-tokens, and the broker keeps retrying it", async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const disk = new StoreDiskError('disk full');
      sessionStore.saveSession.mockRejectedValueOnce(disk);
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        provider: mockProvider({ refreshToken: 'refresh-1' }),
      });

      expectPersistingFailed(
        await broker.getToken('DEST').catch((e: unknown) => e),
        disk,
      );
      expect(sessionStore.saveSession).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);

      expect(sessionStore.saveSession).toHaveBeenCalledTimes(2);
      expect(sessionStore.saveSession.mock.calls[1]).toEqual(
        sessionStore.saveSession.mock.calls[0],
      );
      await expect(broker.flush()).resolves.toBeUndefined();
    });

    it('a write that lands for one destination does not hide a failed write for another (the record is per destination)', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const diskA = new StoreDiskError('disk full for A');
      let failA = true;
      let aFailed!: () => void;
      const aHasFailed = new Promise<void>((resolve) => {
        aFailed = resolve;
      });
      sessionStore.saveSession.mockImplementation(async (d: string) => {
        if (d === 'A' && failA) {
          failA = false;
          aFailed();
          throw diskA;
        }
        // B lands after A failed: it must not clear A's record.
        if (d === 'B') await aHasFailed;
      });
      const shared: ITokenResult = {
        authorizationToken: 'shared-object',
        authType: 'authorization_code',
      };
      const provider = mockProvider();
      provider.getTokens.mockResolvedValue(shared);
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      const [a, b] = await Promise.allSettled([
        broker.getToken('A'),
        broker.getToken('B'),
      ]);

      expect(a.status).toBe('rejected');
      expectPersistingFailed((a as PromiseRejectedResult).reason, diskA);
      expect(b).toEqual({ status: 'fulfilled', value: 'shared-object' });
      // A later write for A lands: A's record is cleared.
      await expect(broker.getToken('A')).resolves.toBe('shared-object');
    });

    it('a later write that lands is not reported as the earlier failure', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      sessionStore.saveSession.mockRejectedValueOnce(new StoreDiskError('x'));
      const result: ITokenResult = {
        authorizationToken: 'same-object',
        authType: 'authorization_code',
      };
      // An instance answering the very same result object every time.
      const provider = mockProvider();
      provider.getTokens.mockResolvedValue(result);
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      const thrown = await broker.getToken('DEST').catch((e: unknown) => e);
      expect(isAuthProviderFailure(thrown)).toBe(true);
      await expect(broker.getToken('DEST')).resolves.toBe('same-object');
    });
  });

  describe('provider factory', () => {
    it('is seeded with the service URL, the stored token and the stored refresh token', async () => {
      const sessionStore = mockSessionStore(
        { serviceUrl: SERVICE_URL, authorizationToken: 'stored-access' },
        null,
        { serviceUrl: SERVICE_URL, refreshToken: 'stored-refresh' },
      );
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory).toHaveBeenCalledWith(
        'DEST',
        { ...KEY_AUTH, refreshToken: 'stored-refresh' },
        expect.objectContaining({
          serviceUrl: SERVICE_URL,
          authorizationToken: 'stored-access',
        }),
      );
    });

    it("prefers the session's own credentials over the service key's — a session store that still answers means is read as 3.x read it", async () => {
      const sessionAuth: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.session',
        uaaClientId: 'session-client',
        uaaClientSecret: 'session-secret',
        refreshToken: 'session-refresh',
      };
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const sessionStore = mockSessionStore(
        { serviceUrl: SERVICE_URL, sapClient: '200' },
        sessionAuth,
      );
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(KEY_AUTH, {
          serviceUrl: 'https://key.example.com',
        }),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory.mock.calls[0]![1]).toEqual(sessionAuth);
      expect(factory.mock.calls[0]![2]).toEqual(
        expect.objectContaining({ serviceUrl: SERVICE_URL, sapClient: '200' }),
      );
      // Bound to what the provider was handed: the session's URL and client.
      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'cached-token',
        refreshToken: '',
        issuedFor: `${SERVICE_URI}?sap-client=200`,
        issuedBy: record(
          'provider/-',
          { clientId: 'session-client', uaaUrl: 'https://uaa.session' },
          '',
        ),
      });
    });

    it('passes null credentials when no store has any', async () => {
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory.mock.calls[0]![1]).toBeNull();
    });

    it('builds once per destination and reuses the provider', async () => {
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: factory,
      });

      await broker.getToken('A');
      await broker.getToken('A');
      await broker.refreshToken('A');
      await broker.getToken('B');

      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory.mock.calls.map((call) => call[0])).toEqual(['A', 'B']);
    });

    it('builds once for concurrent first calls (the promise cache)', async () => {
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        serviceKeyStore: mockServiceKeyStore(),
        provider: factory,
      });

      await Promise.all([
        broker.getToken('A'),
        broker.refreshToken('A'),
        broker.getToken('A'),
      ]);

      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('builds again after a factory that threw', async () => {
      let calls = 0;
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: () => {
          calls += 1;
          if (calls === 1) {
            throw new AuthProviderFailure(
              authError.configuration({
                case: 'required-fields-missing' as const,
                fields: ['clientSecret' as const],
              }),
            );
          }
          return mockProvider();
        },
      });

      await expect(broker.getToken('DEST')).rejects.toBeInstanceOf(
        AuthProviderFailure,
      );
      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
    });

    it('uses an instance for every destination, as given', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider,
      });

      await broker.getToken('A');
      await broker.getToken('B');

      expect(provider.getTokens).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshToken', () => {
    it('forces a new token even while the cached one is valid', async () => {
      const sessionStore = mockSessionStore({
        serviceUrl: SERVICE_URL,
        authorizationToken: 'cached-token',
      });
      const provider = mockProvider({}, { refreshToken: 'refresh-2' });
      const broker = new AuthBroker({ ...STATED, sessionStore, provider });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
      await expect(broker.refreshToken('DEST')).resolves.toBe('fresh-token');

      expect(provider.refreshTokens).toHaveBeenCalledTimes(1);
      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(lastWrite(sessionStore)).toEqual({
        authorizationToken: 'fresh-token',
        refreshToken: 'refresh-2',
        issuedFor: SERVICE_URI,
        issuedBy: INSTANCE_BY,
      });
    });

    it('is what createTokenRefresher().refreshToken() calls', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider,
      });
      const refresher = broker.createTokenRefresher('DEST');

      await expect(refresher.getToken()).resolves.toBe('cached-token');
      await expect(refresher.refreshToken()).resolves.toBe('fresh-token');
      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(provider.refreshTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('provider errors', () => {
    it.each([
      ['getToken', 'getTokens'],
      ['refreshToken', 'refreshTokens'],
    ] as const)(
      '%s propagates an interactive-login failure unchanged',
      async (brokerMethod, providerMethod) => {
        const error = new AuthProviderFailure(
          authError['interactive-login']({ outcome: 'no-terminal' }),
        );
        const provider = mockProvider();
        provider[providerMethod].mockRejectedValue(error);
        const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
        const broker = new AuthBroker({ ...STATED, sessionStore, provider });

        const thrown = await broker[brokerMethod]('DEST').catch((e) => e);

        expect(thrown).toBe(error);
        expect(readFailure(thrown, 'token-source').facts).toEqual({
          outcome: 'no-terminal',
        });
        expect(everythingWritten(sessionStore)).toBe('[[],[],[]]');
      },
    );

    it('propagates a configuration failure with its fields', async () => {
      const error = new AuthProviderFailure(
        authError.configuration({
          case: 'required-fields-missing' as const,
          fields: ['uaaUrl' as const, 'clientId' as const],
        }),
      );
      const provider = mockProvider();
      provider.getTokens.mockRejectedValue(error);
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider,
      });

      const thrown = await broker.getToken('DEST').catch((e) => e);

      expect(thrown).toBe(error);
      expect(readFailure(thrown, 'token-source').facts).toEqual({
        case: 'required-fields-missing',
        fields: ['uaaUrl', 'clientId'],
      });
    });

    it('does not ask the provider a second time after a failure', async () => {
      const provider = mockProvider();
      provider.getTokens.mockRejectedValue(new Error('network down'));
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        serviceKeyStore: mockServiceKeyStore(),
        provider,
      });

      await expect(broker.getToken('DEST')).rejects.toThrow('network down');
      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(provider.refreshTokens).not.toHaveBeenCalled();
    });
  });

  describe('store reads', () => {
    it('answers a missing session file as absent and still gets a token', async () => {
      const sessionStore = mockSessionStore();
      sessionStore.getConnectionConfig.mockRejectedValue(
        Object.assign(new Error('no file'), { code: 'FILE_NOT_FOUND' }),
      );
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
    });

    it('passes an unreadable service key on as the store raised it', async () => {
      // Absence is null or FILE_NOT_FOUND. A key that is there and broken used
      // to be logged and answered as absent, and the caller saw only "missing
      // required field 'serviceUrl'".
      const broken = new Error('Invalid JSON in file "DEST.json"');
      const serviceKeyStore = mockServiceKeyStore();
      serviceKeyStore.getConnectionConfig.mockRejectedValue(broken);
      const provider = mockProvider();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(),
        serviceKeyStore,
        provider,
      });

      await expect(broker.getToken('DEST')).rejects.toBe(broken);
      expect(provider.getTokens).not.toHaveBeenCalled();
    });

    it('passes an unreadable session on as the store raised it', async () => {
      const denied = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
      const sessionStore = mockSessionStore();
      sessionStore.getConnectionConfig.mockRejectedValue(denied);
      const broker = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });

      await expect(broker.getToken('DEST')).rejects.toBe(denied);
    });

    it("getAuthorizationConfig: the key store's client with the session's refresh token, never the session's client", async () => {
      const sessionStore = mockSessionStore(
        null,
        { ...KEY_AUTH, uaaClientId: 'session-client' },
        {
          uaaUrl: 'https://session-uaa',
          uaaClientId: 'session-client',
          uaaClientSecret: 'session-secret',
          refreshToken: 'session-refresh',
        },
      );
      const withBoth = new AuthBroker({
        ...STATED,
        sessionStore,
        serviceKeyStore: mockServiceKeyStore({
          ...KEY_AUTH,
          refreshToken: 'key-refresh',
        }),
      });
      const withKey = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(),
        serviceKeyStore: mockServiceKeyStore({
          ...KEY_AUTH,
          refreshToken: 'key-refresh',
        }),
      });
      const withSessionOnly = new AuthBroker({ ...STATED, sessionStore });

      await expect(withBoth.getAuthorizationConfig('D')).resolves.toEqual({
        ...KEY_AUTH,
        refreshToken: 'session-refresh',
      });
      await expect(withKey.getAuthorizationConfig('D')).resolves.toEqual(
        KEY_AUTH,
      );
      await expect(
        withSessionOnly.getAuthorizationConfig('D'),
      ).resolves.toBeNull();
    });

    it("getConnectionConfig: the key store's means with the session's secret laid over them", async () => {
      const session = {
        serviceUrl: 'https://session',
        authType: 'basic' as const,
        username: 'session-user',
        authorizationToken: 'session-token',
        sessionCookies: 'session=cookie',
        expiresAt: 1234,
        refreshToken: 'session-refresh',
        issuedFor: 'https://session.example:443?sap-client=100',
        issuedBy: 'https://session-uaa.example:443?client_id=session-client',
      };
      const keyConn: IConnectionConfig = {
        serviceUrl: SERVICE_URL,
        authType: 'jwt',
        grantType: 'none',
        sapClient: '100',
        authorizationToken: 'key-token',
        sessionCookies: 'key=cookie',
        expiresAt: 99,
        issuedFor: 'https://key.example:443',
        issuedBy: 'https://key-uaa.example:443?client_id=key-client',
      };
      const withBoth = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(session, null, session),
        serviceKeyStore: mockServiceKeyStore(KEY_AUTH, keyConn),
      });
      const withKey = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(),
        serviceKeyStore: mockServiceKeyStore(KEY_AUTH, keyConn),
      });
      const withSessionOnly = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(session, null, session),
      });
      const withNothing = new AuthBroker({
        ...STATED,
        sessionStore: mockSessionStore(),
        serviceKeyStore: mockServiceKeyStore(null, null),
      });

      await expect(withBoth.getConnectionConfig('D')).resolves.toEqual({
        serviceUrl: SERVICE_URL,
        authType: 'jwt',
        grantType: 'none',
        sapClient: '100',
        authorizationToken: 'session-token',
        sessionCookies: 'session=cookie',
        expiresAt: 1234,
        issuedFor: 'https://session.example:443?sap-client=100',
        issuedBy: 'https://session-uaa.example:443?client_id=session-client',
      });
      await expect(withKey.getConnectionConfig('D')).resolves.toEqual({
        serviceUrl: SERVICE_URL,
        authType: 'jwt',
        grantType: 'none',
        sapClient: '100',
      });
      await expect(withSessionOnly.getConnectionConfig('D')).resolves.toEqual({
        authorizationToken: 'session-token',
        sessionCookies: 'session=cookie',
        expiresAt: 1234,
        issuedFor: 'https://session.example:443?sap-client=100',
        issuedBy: 'https://session-uaa.example:443?client_id=session-client',
      });
      await expect(withNothing.getConnectionConfig('D')).resolves.toBeNull();
    });

    it('getConnectionConfig / getAuthorizationConfig keep the absence rule', async () => {
      const notFound = Object.assign(new Error('no file'), {
        code: 'FILE_NOT_FOUND',
      });
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const absent = mockSessionStore();
      absent.loadSession.mockRejectedValue(notFound);
      const broken = mockSessionStore();
      broken.loadSession.mockRejectedValue(denied);
      const keys = mockServiceKeyStore();

      const tolerant = new AuthBroker({
        ...STATED,
        sessionStore: absent,
        serviceKeyStore: keys,
      });
      await expect(tolerant.getConnectionConfig('D')).resolves.toEqual({
        serviceUrl: SERVICE_URL,
      });
      await expect(tolerant.getAuthorizationConfig('D')).resolves.toEqual(
        KEY_AUTH,
      );

      const strict = new AuthBroker({
        ...STATED,
        sessionStore: broken,
        serviceKeyStore: keys,
      });
      await expect(strict.getConnectionConfig('D')).rejects.toBe(denied);
      await expect(strict.getAuthorizationConfig('D')).rejects.toBe(denied);
    });
  });

  describe('on disk: auth-stores 3 — the means in an EnvDestinationStore, the secret in an AbapSessionStore', () => {
    let keysDir: string;
    let sessionsDir: string;

    beforeEach(() => {
      keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-keys-'));
      sessionsDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'auth-broker-sessions-'),
      );
      const V = ABAP_DESTINATION_VARS;
      fs.writeFileSync(
        path.join(keysDir, 'DEST.env'),
        [
          `${V.serviceUrl}=${SERVICE_URL}`,
          `${V.uaaUrl}=${KEY_AUTH.uaaUrl}`,
          `${V.uaaClientId}=${KEY_AUTH.uaaClientId}`,
          `${V.uaaClientSecret}=${KEY_AUTH.uaaClientSecret}`,
          '',
        ].join('\n'),
      );
    });

    afterEach(() => {
      fs.rmSync(keysDir, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    });

    it('writes the secret alone into the session file, and the next broker is seeded with the refresh token it wrote', async () => {
      const serviceKeyStore = new EnvDestinationStore(keysDir);
      const first = new AuthBroker({
        ...STATED,
        sessionStore: new AbapSessionStore(sessionsDir),
        serviceKeyStore,
        provider: () =>
          mockProvider({
            refreshToken: 'refresh-from-login',
            expiresAt: 1_900_000_000_000,
          }),
      });

      await first.getToken('DEST');

      const file = fs.readFileSync(path.join(sessionsDir, 'DEST.env'), 'utf8');
      const keys = file
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.slice(0, line.indexOf('=')))
        .sort();
      const S = ABAP_SESSION_VARS;
      expect(keys).toEqual(
        [
          S.AUTHORIZATION_TOKEN,
          S.EXPIRES_AT,
          S.ISSUED_BY,
          S.ISSUED_FOR,
          S.REFRESH_TOKEN,
        ].sort(),
      );
      expect(file).toContain('refresh-from-login');
      expect(file).not.toContain(KEY_AUTH.uaaClientSecret);
      const stored = await new AbapSessionStore(sessionsDir).loadSession(
        'DEST',
      );
      expect(stored).toEqual({
        authorizationToken: 'cached-token',
        expiresAt: 1_900_000_000_000,
        refreshToken: 'refresh-from-login',
        issuedFor: SERVICE_URI,
        issuedBy: KEY_ISSUER,
      });
      // The key store's file is never written.
      expect(
        fs.readFileSync(path.join(keysDir, 'DEST.env'), 'utf8'),
      ).not.toContain('refresh-from-login');

      // A new process: a new broker over the same files.
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const second = new AuthBroker({
        ...STATED,
        sessionStore: new AbapSessionStore(sessionsDir),
        serviceKeyStore,
        provider: factory,
      });

      await second.getToken('DEST');

      expect(factory).toHaveBeenCalledWith(
        'DEST',
        { ...KEY_AUTH, refreshToken: 'refresh-from-login' },
        expect.objectContaining({
          serviceUrl: SERVICE_URL,
          authorizationToken: 'cached-token',
          expiresAt: 1_900_000_000_000,
        }),
      );
    });
  });
});
