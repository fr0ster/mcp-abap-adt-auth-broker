/**
 * AuthBroker against mocked stores and providers, and once against a real
 * AbapSessionStore on disk (no network).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BrowserAuthError,
  ValidationError,
} from '@mcp-abap-adt/auth-providers';
import { AbapSessionStore } from '@mcp-abap-adt/auth-stores';
import type {
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import { AuthBroker, type TokenProviderFactory } from '../../AuthBroker';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '../../stores/interfaces';

const SERVICE_URL = 'https://abap.example.com';
const KEY_AUTH: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'client-id',
  uaaClientSecret: 'client-secret-from-key',
};

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

describe('AuthBroker', () => {
  describe('constructor', () => {
    it('takes a provider instance', () => {
      expect(
        () =>
          new AuthBroker({
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
            sessionStore: mockSessionStore(),
            provider: provider as unknown as IRefreshableTokenProvider,
          }),
      ).toThrow('provider.refreshTokens must be a function');
    });

    it('refuses a missing session store or provider', () => {
      expect(
        () =>
          new AuthBroker({
            sessionStore: undefined as unknown as ISessionStore,
            provider: mockProvider(),
          }),
      ).toThrow('sessionStore is required');
      expect(
        () =>
          new AuthBroker({
            sessionStore: mockSessionStore(),
            provider: undefined as unknown as IRefreshableTokenProvider,
          }),
      ).toThrow('provider is required');
    });

    it('refuses a service key store missing a method', () => {
      const serviceKeyStore = mockServiceKeyStore();
      delete (serviceKeyStore as Partial<IServiceKeyStore>).getServiceKey;
      expect(
        () =>
          new AuthBroker({
            sessionStore: mockSessionStore(),
            serviceKeyStore,
            provider: mockProvider(),
          }),
      ).toThrow('serviceKeyStore.getServiceKey must be a function');
    });
  });

  describe('getToken', () => {
    it('asks the provider once and persists a bearer token with its service URL', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const provider = mockProvider({ refreshToken: 'refresh-1' });
      const broker = new AuthBroker({ sessionStore, provider });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');

      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(provider.refreshTokens).not.toHaveBeenCalled();
      expect(sessionStore.setConnectionConfig).toHaveBeenCalledWith(
        'DEST',
        expect.objectContaining({
          serviceUrl: SERVICE_URL,
          authorizationToken: 'cached-token',
          sessionCookies: undefined,
          authType: 'jwt',
        }),
      );
    });

    it('persists a SAML result as session cookies', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const provider = mockProvider({
        authorizationToken: 'MYSAPSSO2=abc',
        tokenType: 'saml',
        authType: 'user_token',
      });
      const broker = new AuthBroker({ sessionStore, provider });

      await broker.getToken('DEST');

      expect(sessionStore.setConnectionConfig).toHaveBeenCalledWith(
        'DEST',
        expect.objectContaining({
          authorizationToken: undefined,
          sessionCookies: 'MYSAPSSO2=abc',
          authType: 'saml',
        }),
      );
    });

    it('takes the service URL from the service key when the session has none', async () => {
      const sessionStore = mockSessionStore();
      const broker = new AuthBroker({
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });

      await broker.getToken('DEST');

      expect(sessionStore.setConnectionConfig).toHaveBeenCalledWith(
        'DEST',
        expect.objectContaining({ serviceUrl: SERVICE_URL }),
      );
    });

    it('fails without a service URL anywhere, before asking the provider', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
        sessionStore: mockSessionStore(),
        provider,
      });

      await expect(broker.getToken('DEST')).rejects.toThrow(
        "missing required field 'serviceUrl'",
      );
      expect(provider.getTokens).not.toHaveBeenCalled();
    });

    it('updates the refresh token in a session that holds its own credentials', async () => {
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
        sessionStore,
        provider: mockProvider({ refreshToken: 'new-refresh' }),
      });

      await broker.getToken('DEST');

      expect(sessionStore.setAuthorizationConfig).toHaveBeenCalledWith('DEST', {
        ...sessionAuth,
        refreshToken: 'new-refresh',
      });
      expect(sessionStore.saveSession).not.toHaveBeenCalled();
    });

    it('never copies the client secret from the service key into the session', async () => {
      const sessionStore = mockSessionStore(null, null, {
        serviceUrl: SERVICE_URL,
      });
      const broker = new AuthBroker({
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: (_dest, auth) => {
          // The provider does get the secret — from the service key.
          expect(auth?.uaaClientSecret).toBe(KEY_AUTH.uaaClientSecret);
          return mockProvider({ refreshToken: 'refresh-1' });
        },
      });

      await broker.getToken('DEST');

      expect(sessionStore.setAuthorizationConfig).not.toHaveBeenCalled();
      expect(sessionStore.saveSession).toHaveBeenCalledWith(
        'DEST',
        expect.objectContaining({ refreshToken: 'refresh-1' }),
      );
      expect(everythingWritten(sessionStore)).not.toContain(
        KEY_AUTH.uaaClientSecret,
      );
      expect(everythingWritten(sessionStore)).not.toContain('uaaClientSecret');
    });

    it('does not erase the stored refresh token when the result has none', async () => {
      const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
      const broker = new AuthBroker({ sessionStore, provider: mockProvider() });

      await broker.getToken('DEST');

      expect(sessionStore.setAuthorizationConfig).not.toHaveBeenCalled();
      expect(sessionStore.saveSession).not.toHaveBeenCalled();
    });

    it('fails when the provider returns no token', async () => {
      const broker = new AuthBroker({
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: mockProvider({ authorizationToken: '' }),
      });

      await expect(broker.getToken('DEST')).rejects.toThrow(
        'did not return authorization token',
      );
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

    it("prefers the session's own credentials over the service key's", async () => {
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
      const broker = new AuthBroker({
        sessionStore: mockSessionStore(
          { serviceUrl: SERVICE_URL },
          sessionAuth,
        ),
        serviceKeyStore: mockServiceKeyStore(),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory.mock.calls[0][1]).toEqual(sessionAuth);
    });

    it('passes null credentials when no store has any', async () => {
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: factory,
      });

      await broker.getToken('DEST');

      expect(factory.mock.calls[0][1]).toBeNull();
    });

    it('builds once per destination and reuses the provider', async () => {
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const broker = new AuthBroker({
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

    it('builds again after a factory that threw', async () => {
      let calls = 0;
      const broker = new AuthBroker({
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider: () => {
          calls += 1;
          if (calls === 1) {
            throw new ValidationError('Missing clientSecret', ['clientSecret']);
          }
          return mockProvider();
        },
      });

      await expect(broker.getToken('DEST')).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
    });

    it('uses an instance for every destination, as given', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
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
      const broker = new AuthBroker({ sessionStore, provider });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
      await expect(broker.refreshToken('DEST')).resolves.toBe('fresh-token');

      expect(provider.refreshTokens).toHaveBeenCalledTimes(1);
      expect(provider.getTokens).toHaveBeenCalledTimes(1);
      expect(sessionStore.setConnectionConfig).toHaveBeenLastCalledWith(
        'DEST',
        expect.objectContaining({ authorizationToken: 'fresh-token' }),
      );
      expect(sessionStore.saveSession).toHaveBeenLastCalledWith(
        'DEST',
        expect.objectContaining({ refreshToken: 'refresh-2' }),
      );
    });

    it('is what createTokenRefresher().refreshToken() calls', async () => {
      const provider = mockProvider();
      const broker = new AuthBroker({
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
      '%s propagates a BrowserAuthError unchanged',
      async (brokerMethod, providerMethod) => {
        const cause = new Error('No browser in a headless session');
        const error = new BrowserAuthError('Browser login refused', cause);
        const provider = mockProvider();
        provider[providerMethod].mockRejectedValue(error);
        const sessionStore = mockSessionStore({ serviceUrl: SERVICE_URL });
        const broker = new AuthBroker({ sessionStore, provider });

        const thrown = await broker[brokerMethod]('DEST').catch((e) => e);

        expect(thrown).toBe(error);
        expect(thrown).toBeInstanceOf(BrowserAuthError);
        expect(thrown.code).toBe('BROWSER_AUTH_ERROR');
        expect(thrown.cause).toBe(cause);
        expect(sessionStore.setConnectionConfig).not.toHaveBeenCalled();
      },
    );

    it('propagates a ValidationError with its missing fields', async () => {
      const error = new ValidationError('Missing fields', [
        'uaaUrl',
        'clientId',
      ]);
      const provider = mockProvider();
      provider.getTokens.mockRejectedValue(error);
      const broker = new AuthBroker({
        sessionStore: mockSessionStore({ serviceUrl: SERVICE_URL }),
        provider,
      });

      const thrown = await broker.getToken('DEST').catch((e) => e);

      expect(thrown).toBe(error);
      expect(thrown.code).toBe('VALIDATION_ERROR');
      expect(thrown.missingFields).toEqual(['uaaUrl', 'clientId']);
    });

    it('does not ask the provider a second time after a failure', async () => {
      const provider = mockProvider();
      provider.getTokens.mockRejectedValue(new Error('network down'));
      const broker = new AuthBroker({
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
    it('answers an unreadable session as absent and still gets a token', async () => {
      const sessionStore = mockSessionStore();
      sessionStore.getConnectionConfig.mockRejectedValue(
        Object.assign(new Error('no file'), { code: 'FILE_NOT_FOUND' }),
      );
      const broker = new AuthBroker({
        sessionStore,
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });

      await expect(broker.getToken('DEST')).resolves.toBe('cached-token');
    });

    it('getAuthorizationConfig: session first, then service key, then null', async () => {
      const sessionAuth = { ...KEY_AUTH, uaaClientId: 'session' };
      const withSession = new AuthBroker({
        sessionStore: mockSessionStore(null, sessionAuth),
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });
      const withKey = new AuthBroker({
        sessionStore: mockSessionStore(),
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });
      const withNothing = new AuthBroker({
        sessionStore: mockSessionStore(),
        provider: mockProvider(),
      });

      await expect(withSession.getAuthorizationConfig('D')).resolves.toBe(
        sessionAuth,
      );
      await expect(withKey.getAuthorizationConfig('D')).resolves.toEqual(
        KEY_AUTH,
      );
      await expect(withNothing.getAuthorizationConfig('D')).resolves.toBeNull();
    });

    it('getConnectionConfig: session first, then service key, then null', async () => {
      const sessionConn = {
        serviceUrl: 'https://session',
        authorizationToken: 't',
      };
      const withSession = new AuthBroker({
        sessionStore: mockSessionStore(sessionConn),
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });
      const withKey = new AuthBroker({
        sessionStore: mockSessionStore(),
        serviceKeyStore: mockServiceKeyStore(),
        provider: mockProvider(),
      });
      const withNothing = new AuthBroker({
        sessionStore: mockSessionStore(),
        provider: mockProvider(),
      });

      await expect(withSession.getConnectionConfig('D')).resolves.toBe(
        sessionConn,
      );
      await expect(withKey.getConnectionConfig('D')).resolves.toEqual({
        serviceUrl: SERVICE_URL,
      });
      await expect(withNothing.getConnectionConfig('D')).resolves.toBeNull();
    });
  });

  describe('with AbapSessionStore on disk', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes no client secret, and the next broker is seeded with the refresh token it wrote', async () => {
      const serviceKeyStore = mockServiceKeyStore();
      const first = new AuthBroker({
        sessionStore: new AbapSessionStore(dir),
        serviceKeyStore,
        provider: mockProvider({ refreshToken: 'refresh-from-login' }),
      });

      await first.getToken('DEST');

      const file = fs.readFileSync(path.join(dir, 'DEST.env'), 'utf8');
      expect(file).not.toContain(KEY_AUTH.uaaClientSecret);
      expect(file).not.toContain('CLIENT_SECRET');
      expect(file).toContain('refresh-from-login');

      // A new process: a new broker over the same file.
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => mockProvider());
      const second = new AuthBroker({
        sessionStore: new AbapSessionStore(dir),
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
        }),
      );
    });
  });
});
