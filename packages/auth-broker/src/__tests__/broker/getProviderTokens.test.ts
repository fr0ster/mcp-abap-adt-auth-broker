import { inspect } from 'node:util';
/**
 * getProvider for the UAA grants — `jwt` / `authorization_code`,
 * `client_credentials`, `passcode` — and the persistence every token provider
 * the broker builds gets through `onTokens` (spec §4.1, §4.4, §5, §6).
 *
 * The stores are in-memory fakes of the contract; the providers are real
 * (auth-providers 5.1) against a local token endpoint, and are only ever driven
 * through `IAuthProvider`. The interactive part of a grant is a recording
 * strategy — nothing here opens a browser.
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
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  AuthBroker,
  type AuthBrokerConfig,
  DestinationConfigError,
  type StrategyGrant,
} from '../../index';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

/** The client secret: means, never to reach the session (H4) or an error. */
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';
const SERVICE_URL = 'https://abap.example.com';
const REDIRECT = 'http://localhost/callback';
const D = 'TRIAL';
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

type UaaGrant = 'authorization_code' | 'client_credentials' | 'passcode';

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  jest.useRealTimers();
  await endpoint.close();
});

/** The means of a UAA destination, as a key store states them. */
function means(
  grant: UaaGrant,
  extra: Partial<IConnectionConfig> = {},
): IConnectionConfig {
  return {
    authType: 'jwt',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    ...extra,
  };
}

function client(
  extra: Partial<IAuthorizationConfig> = {},
): IAuthorizationConfig {
  return {
    uaaUrl: endpoint.url,
    uaaClientId: 'broker-client',
    uaaClientSecret: CLIENT_SECRET,
    ...extra,
  };
}

/** A key store holding means only: three getters, no way to write. */
function keyStore(
  conn: IConnectionConfig | null,
  auth: IAuthorizationConfig | null,
): jest.Mocked<IServiceKeyStore> {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => auth),
    getConnectionConfig: jest.fn(async (_d: string) => conn),
  };
}

/**
 * A session store over a map. `saveSession` replaces the destination's session
 * with what it is given, so what the broker writes is exactly what is held.
 */
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
    deleteSession: jest.fn(async (_d: string) => {}),
  };
  return { store, held: () => sessions.get(D) };
}

/** A strategy that plays the user: it records the URL it is sent to and returns `payload`. */
function recordingStrategy(payload = 'the-code'): {
  strategy: jest.Mocked<IAuthorizationStrategy<string>>;
  urls: string[];
} {
  const urls: string[] = [];
  const strategy: jest.Mocked<IAuthorizationStrategy<string>> = {
    authorize: jest.fn(async (request: AuthorizationRequest) => {
      urls.push(await request.buildAuthorizationUrl(REDIRECT));
      return { payload, redirectUri: REDIRECT };
    }),
    dispose: jest.fn(async () => {}),
  };
  return { strategy, urls };
}

function silentLogger(): jest.Mocked<ILogger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
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
  const outcome = await provider.authorize(request);
  expect(outcome).toEqual({ ok: true });
  return headers.Authorization?.replace(/^Bearer /, '');
}

function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

async function refusal(
  promise: Promise<unknown>,
): Promise<DestinationConfigError> {
  const error = await promise.then(
    () => {
      throw new Error('expected getProvider to throw');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DestinationConfigError);
  return error as DestinationConfigError;
}

function everythingIn(error: unknown): string {
  const e = error as Record<string, unknown>;
  const parts = [String(error), (error as Error).stack];
  for (const name of Object.getOwnPropertyNames(e)) {
    parts.push(JSON.stringify(e[name]));
  }
  return parts.join('\n');
}

/** A broker over the fakes, with an `authorization` option recording its calls. */
function brokerFor(
  grant: UaaGrant,
  options: {
    session?: IConfig | null;
    conn?: IConnectionConfig | null;
    auth?: IAuthorizationConfig | null;
    strategy?: IAuthorizationStrategy<string>;
    withAuthorization?: boolean;
    logger?: ILogger;
  } = {},
) {
  const sessions = sessionStore(options.session ?? null);
  const keys = keyStore(
    options.conn === undefined ? means(grant) : options.conn,
    options.auth === undefined ? client() : options.auth,
  );
  const recorded = recordingStrategy();
  const strategy = options.strategy ?? recorded.strategy;
  const authorization = jest.fn((_d: string, _g: StrategyGrant) => strategy);
  const config: AuthBrokerConfig = {
    sessionStore: sessions.store,
    serviceKeyStore: keys,
  };
  if (options.withAuthorization !== false) {
    config.authorization = authorization;
  }
  const broker = new AuthBroker(config, options.logger);
  return { broker, keys, authorization, urls: recorded.urls, ...sessions };
}

describe('getProvider — the UAA grants', () => {
  describe('jwt / authorization_code', () => {
    it('without a session logs in at prepare() through the consumer’s strategy, with the stored client', async () => {
      const { broker, authorization, urls, held } =
        brokerFor('authorization_code');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(authorization.mock.calls).toEqual([[D, 'authorization_code']]);
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0]);
      expect(`${url.origin}${url.pathname}`).toBe(
        `${endpoint.url}/oauth/authorize`,
      );
      expect(url.searchParams.get('client_id')).toBe('broker-client');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(endpoint.requests).toEqual([
        {
          grantType: 'authorization_code',
          params: {
            grant_type: 'authorization_code',
            code: 'the-code',
            redirect_uri: REDIRECT,
          },
          authorization: basicAuth('broker-client', CLIENT_SECRET),
        },
      ]);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        refreshToken: 'refresh-1',
      });
    });

    it('seeded from the session: presents the stored token and asks no one', async () => {
      const stored = jwtExpiringIn(3600, { jti: 'stored' });
      const { strategy } = recordingStrategy();
      const { broker, store } = brokerFor('authorization_code', {
        session: { authorizationToken: stored, refreshToken: 'stored-rt' },
        strategy,
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(await bearer(provider)).toBe(stored);
      expect(endpoint.requests).toEqual([]);
      expect(strategy.authorize).not.toHaveBeenCalled();
      expect(store.saveSession).not.toHaveBeenCalled();
    });

    it('calls authorization once per build and never disposes what it returns', async () => {
      const { strategy } = recordingStrategy();
      const { broker, authorization } = brokerFor('authorization_code', {
        strategy,
      });

      const [a, b] = await Promise.all([
        broker.getProvider(D),
        broker.getProvider(D),
      ]);
      expect(b).toBe(a);
      await a.prepare();
      await a.rejected(UNAUTHORIZED);

      expect(authorization).toHaveBeenCalledTimes(1);
      expect(strategy.dispose).not.toHaveBeenCalled();
    });
  });

  describe('jwt / passcode', () => {
    it('hands the strategy <uaaUrl>/passcode and exchanges the code it returns', async () => {
      const { broker, authorization, urls, held } = brokerFor('passcode');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(authorization.mock.calls).toEqual([[D, 'passcode']]);
      expect(urls).toEqual([`${endpoint.url}/passcode`]);
      expect(endpoint.requests).toEqual([
        {
          grantType: 'password',
          params: { grant_type: 'password', passcode: 'the-code' },
          authorization: basicAuth('broker-client', CLIENT_SECRET),
        },
      ]);
      expect(held()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        refreshToken: 'refresh-1',
      });
    });

    it('takes a public client — uaaClientSecret "" — as no secret', async () => {
      const { broker } = brokerFor('passcode', {
        auth: client({ uaaClientSecret: '' }),
      });

      await (await broker.getProvider(D)).prepare();

      expect(endpoint.requests[0].authorization).toBe(
        basicAuth('broker-client', ''),
      );
    });
  });

  describe('jwt / client_credentials', () => {
    it('obtains a client token with the stored client and needs no collaborator', async () => {
      const { broker, held } = brokerFor('client_credentials', {
        withAuthorization: false,
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests).toEqual([
        {
          grantType: 'client_credentials',
          params: {
            grant_type: 'client_credentials',
            client_id: 'broker-client',
            client_secret: CLIENT_SECRET,
          },
          authorization: undefined,
        },
      ]);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
    });

    it('hands the provider the broker’s logger: its lines arrive whole, with no token in them', async () => {
      const logger = silentLogger();
      const { broker } = brokerFor('client_credentials', {
        withAuthorization: false,
        logger,
      });

      await (await broker.getProvider(D)).prepare();

      const token = endpoint.issued[0];
      const redacted = `<redacted, ${token.length} chars>`;
      expect(logger.info.mock.calls).toEqual(
        expect.arrayContaining([
          ['[BaseTokenProvider] No usable refresh token, performing login'],
          [
            '[BaseTokenProvider] Login completed',
            { newToken: redacted, newRefreshToken: undefined },
          ],
        ]),
      );
      const everything = JSON.stringify([
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.debug.mock.calls,
      ]);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain(token.split('.')[1]);
      expect(everything).not.toContain(CLIENT_SECRET);
    });

    it('is not seeded: the row takes the client alone (spec §4.1)', async () => {
      const { broker } = brokerFor('client_credentials', {
        session: { authorizationToken: jwtExpiringIn(3600) },
      });

      const provider = await broker.getProvider(D);
      await provider.prepare();

      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'client_credentials',
      ]);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
    });
  });

  describe.each(['authorization_code', 'passcode'] as const)(
    'the %s seed carries expiresAt',
    (grant) => {
      it('reuses an opaque stored token until the stored expiresAt', async () => {
        const { broker } = brokerFor(grant, {
          session: {
            authorizationToken: 'opaque-stored-token',
            expiresAt: Date.now() + 3_600_000,
            refreshToken: 'stored-rt',
          },
        });

        const provider = await broker.getProvider(D);
        await provider.prepare();

        expect(endpoint.requests).toEqual([]);
        expect(await bearer(provider)).toBe('opaque-stored-token');
      });

      it('renews an opaque stored token with no expiresAt, by its stored refresh token', async () => {
        const { broker } = brokerFor(grant, {
          session: {
            authorizationToken: 'opaque-stored-token',
            refreshToken: 'stored-rt',
          },
        });

        const provider = await broker.getProvider(D);
        await provider.prepare();

        expect(endpoint.requests.map((r) => r.params)).toEqual([
          { grant_type: 'refresh_token', refresh_token: 'stored-rt' },
        ]);
        expect(await bearer(provider)).toBe(endpoint.issued[0]);
      });
    },
  );

  // Plan D8: the resource URL is not authorization data. No UAA provider
  // reads it — the client and uaaUrl are all a grant needs — so a destination
  // whose means state no serviceUrl still gets its provider, and it obtains a
  // token. The connector needs the URL; the consumer takes it from its key
  // store.
  describe('the resource URL is not authorization data (D8)', () => {
    it.each(
      (
        ['authorization_code', 'client_credentials', 'passcode'] as const
      ).flatMap((grant) => [
        [grant, 'absent', undefined],
        [grant, '""', ''],
      ]) as [UaaGrant, string, string | undefined][],
    )(
      '%s with serviceUrl %s in the means is built and obtains a token',
      async (grant, _label, serviceUrl) => {
        const conn = means(grant);
        if (serviceUrl === undefined) delete conn.serviceUrl;
        else conn.serviceUrl = serviceUrl;
        const { broker, held } = brokerFor(grant, { conn });

        const provider = await broker.getProvider(D);
        expect(await provider.prepare()).toEqual({ ok: true });

        expect(endpoint.requests.map((r) => r.grantType)).toEqual([
          grant === 'passcode' ? 'password' : grant,
        ]);
        expect(await bearer(provider)).toBe(endpoint.issued[0]);
        await broker.flush();
        expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      },
    );
  });

  describe('DestinationConfigError', () => {
    const grants: UaaGrant[] = [
      'authorization_code',
      'client_credentials',
      'passcode',
    ];

    it.each([
      ['authorization_code', ['uaaUrl', 'uaaClientId', 'uaaClientSecret']],
      ['client_credentials', ['uaaUrl', 'uaaClientId', 'uaaClientSecret']],
      ['passcode', ['uaaUrl', 'uaaClientId']],
    ] as const)(
      '%s without a client in the key store names %j',
      async (grant, missing) => {
        const { broker } = brokerFor(grant, { auth: null });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(missing);
      },
    );

    it.each(grants)('%s takes "" as missing', async (grant) => {
      const { broker } = brokerFor(grant, {
        auth: client({ uaaUrl: '', uaaClientId: '' }),
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual(['uaaUrl', 'uaaClientId']);
      expect(everythingIn(error)).not.toContain(CLIENT_SECRET);
    });

    it.each(['authorization_code', 'client_credentials'] as const)(
      '%s cannot take a public client: uaaClientSecret "" is missing',
      async (grant) => {
        const { broker } = brokerFor(grant, {
          auth: client({ uaaClientSecret: '' }),
        });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(['uaaClientSecret']);
      },
    );

    it.each(['authorization_code', 'passcode'] as const)(
      '%s without the authorization option names it',
      async (grant) => {
        const { broker } = brokerFor(grant, { withAuthorization: false });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(['authorization']);
        expect(error.message).toContain('authorization');
      },
    );

    it('does not read the client from the session store', async () => {
      const sessions = sessionStore({ authorizationToken: 't' });
      sessions.store.getAuthorizationConfig.mockResolvedValue(client());
      const broker = new AuthBroker({
        sessionStore: sessions.store,
        serviceKeyStore: keyStore(means('client_credentials'), null),
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual([
        'uaaUrl',
        'uaaClientId',
        'uaaClientSecret',
      ]);
      expect(sessions.store.getAuthorizationConfig).not.toHaveBeenCalled();
    });
  });
});

describe('persistence through onTokens (spec §6)', () => {
  /** A destination seeded with a token the server will refuse, and a refresh token. */
  function seeded(grant: UaaGrant = 'authorization_code', logger?: ILogger) {
    const refused = jwtExpiringIn(3600, { jti: 'refused' });
    const built = brokerFor(grant, {
      session: {
        authorizationToken: refused,
        expiresAt: Date.now() + 3_600_000,
        refreshToken: 'stored-rt',
      },
      logger,
    });
    return { ...built, refused };
  }

  it('a 401 through rejected() renews once, and the new token reaches the session store', async () => {
    const { broker, store, held, refused } = seeded();
    const provider = await broker.getProvider(D);
    expect(await bearer(provider)).toBe(refused);

    expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

    expect(endpoint.requests).toEqual([
      {
        grantType: 'refresh_token',
        params: { grant_type: 'refresh_token', refresh_token: 'stored-rt' },
        authorization: basicAuth('broker-client', CLIENT_SECRET),
      },
    ]);
    expect(store.saveSession).toHaveBeenCalledTimes(1);
    expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
    expect(await bearer(provider)).toBe(endpoint.issued[0]);
  });

  it('writes the secret and nothing else: no client secret, no serviceUrl, no authType (H4)', async () => {
    const { broker, store } = seeded();
    const provider = await broker.getProvider(D);
    const before = Date.now();
    await provider.rejected(UNAUTHORIZED);
    const after = Date.now();

    expect(store.saveSession).toHaveBeenCalledTimes(1);
    const [destination, written] = store.saveSession.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(destination).toBe(D);
    expect(Object.keys(written).sort()).toEqual([
      'authorizationToken',
      'expiresAt',
      'refreshToken',
    ]);
    expect(written.authorizationToken).toBe(endpoint.issued[0]);
    expect(written.refreshToken).toBe('refresh-1');
    // The token's own exp, an hour on, as the provider reads it (whole seconds).
    expect(written.expiresAt).toBeGreaterThanOrEqual(
      before + 3_599_000 - 1_000,
    );
    expect(written.expiresAt).toBeLessThanOrEqual(after + 3_600_000);
    const everything = JSON.stringify(store.saveSession.mock.calls);
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(SERVICE_URL);
    expect(everything).not.toContain('broker-client');
    expect(store.setConnectionConfig).not.toHaveBeenCalled();
    expect(store.setAuthorizationConfig).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  });

  it('carries the stored refresh token forward when the result has none', async () => {
    const { broker, held } = brokerFor('client_credentials', {
      session: { refreshToken: 'kept-rt' },
    });

    await (await broker.getProvider(D)).prepare();

    expect(held()).toEqual({
      authorizationToken: endpoint.issued[0],
      expiresAt: expect.any(Number),
      refreshToken: 'kept-rt',
    });
  });

  it('takes an empty refresh token in a result as none, and keeps the stored one', async () => {
    const { broker, held } = brokerFor('authorization_code', {
      session: { refreshToken: 'kept-rt' },
    });
    // The stored refresh token is refused; the login then answers ''.
    endpoint.answerNext({ status: 400, body: { error: 'invalid_grant' } });
    endpoint.answerNext({
      status: 200,
      body: {
        access_token: jwtExpiringIn(3600, { jti: 'no-rt' }),
        refresh_token: '',
      },
    });

    await (await broker.getProvider(D)).prepare();

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
      'authorization_code',
    ]);
    expect(held()?.refreshToken).toBe('kept-rt');
  });

  it.each(['basic', 'snc'] as const)(
    'writes nothing once the key store states %s for the destination',
    async (authType) => {
      const { broker, keys, store } = seeded();
      const provider = await broker.getProvider(D);
      // The destination is rewritten from outside after the build.
      keys.getConnectionConfig.mockResolvedValue({
        authType,
        username: 'U',
        password: 'P',
        sncPartnerName: 'p:CN=SID',
      });

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

      expect(endpoint.requests).toHaveLength(1);
      expect(store.saveSession).not.toHaveBeenCalled();
      await expect(broker.flush()).resolves.toBeUndefined();
    },
  );

  describe('a write that fails', () => {
    class StoreDiskError extends Error {}

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    it('does not fail the authentication, and is retried by the broker with no further call to the provider', async () => {
      const { broker, store, held } = seeded();
      store.saveSession.mockRejectedValueOnce(new StoreDiskError('disk full'));
      const provider = await broker.getProvider(D);

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()?.authorizationToken).not.toBe(endpoint.issued[0]);

      await jest.advanceTimersByTimeAsync(1_000);

      expect(store.saveSession).toHaveBeenCalledTimes(2);
      expect(store.saveSession.mock.calls[1]).toEqual(
        store.saveSession.mock.calls[0],
      );
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(endpoint.requests).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(600_000);
      expect(store.saveSession).toHaveBeenCalledTimes(2);
    });

    it('retries with a growing delay: one second, doubling, capped at one minute', async () => {
      const { broker, store } = seeded();
      store.saveSession.mockRejectedValue(new StoreDiskError('disk full'));
      const provider = await broker.getProvider(D);
      await provider.rejected(UNAUTHORIZED);

      const attemptsAt: number[] = [];
      const start = Date.now();
      store.saveSession.mockImplementation(async () => {
        attemptsAt.push(Date.now() - start);
        throw new StoreDiskError('disk full');
      });
      await jest.advanceTimersByTimeAsync(300_000);

      expect(attemptsAt.slice(0, 9)).toEqual([
        1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000, 243_000,
      ]);
    });

    it('logs the failure by its class name, never its message', async () => {
      const logger = silentLogger();
      const { broker, store } = seeded('authorization_code', logger);
      store.saveSession.mockRejectedValueOnce(
        new StoreDiskError(`disk full ${CLIENT_SECRET}`),
      );

      await (await broker.getProvider(D)).rejected(UNAUTHORIZED);

      const logged = JSON.stringify([
        logger.warn.mock.calls,
        logger.error.mock.calls,
        logger.info.mock.calls,
        logger.debug.mock.calls,
      ]);
      expect(logged).toContain('StoreDiskError');
      expect(logged).not.toContain('disk full');
      expect(logged).not.toContain(CLIENT_SECRET);
    });

    it('a newer result replaces the pending one: only the latest is ever written', async () => {
      const { broker, store, held } = seeded();
      store.saveSession.mockRejectedValueOnce(new StoreDiskError('disk full'));
      const provider = await broker.getProvider(D);

      await provider.rejected(UNAUTHORIZED); // token-1: its write fails
      await provider.rejected(UNAUTHORIZED); // token-2: written
      await jest.advanceTimersByTimeAsync(600_000);

      const written = store.saveSession.mock.calls.map(
        ([, c]) => (c as IConfig).authorizationToken,
      );
      expect(written).toEqual([endpoint.issued[0], endpoint.issued[1]]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[1]);
    });

    it('never runs two writes for one destination at once', async () => {
      const { broker, store } = seeded();
      let running = 0;
      let most = 0;
      let release: () => void = () => {};
      const sessions: IConfig[] = [];
      store.saveSession.mockImplementation(async (_d, c) => {
        running += 1;
        most = Math.max(most, running);
        try {
          if (sessions.length === 0) {
            sessions.push(c as IConfig);
            throw new StoreDiskError('disk full');
          }
          if (sessions.length === 1) {
            sessions.push(c as IConfig);
            // The timer's retry hangs until released.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return;
          }
          sessions.push(c as IConfig);
        } finally {
          running -= 1;
        }
      });
      const provider = await broker.getProvider(D);
      await provider.rejected(UNAUTHORIZED); // token-1 fails
      await jest.advanceTimersByTimeAsync(1_000); // retry of token-1 hangs

      const second = provider.rejected(UNAUTHORIZED); // token-2 waits its turn
      await jest.advanceTimersByTimeAsync(10);
      expect(sessions).toHaveLength(2);
      release();
      expect(await second).toEqual({ ok: true });

      expect(most).toBe(1);
      expect(sessions.map((s) => s.authorizationToken)).toEqual([
        endpoint.issued[0],
        endpoint.issued[0],
        endpoint.issued[1],
      ]);
    });
  });

  describe('flush()', () => {
    class StoreDiskError extends Error {}

    it('resolves at once with nothing pending', async () => {
      const { broker } = seeded();
      await expect(broker.flush()).resolves.toBeUndefined();
    });

    it('resolves once the pending write lands', async () => {
      const { broker, store, held } = seeded();
      store.saveSession.mockRejectedValueOnce(new StoreDiskError('disk full'));
      await (await broker.getProvider(D)).rejected(UNAUTHORIZED);
      expect(held()?.authorizationToken).not.toBe(endpoint.issued[0]);

      await expect(broker.flush()).resolves.toBeUndefined();

      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(store.saveSession).toHaveBeenCalledTimes(2);
    });

    it('rejects naming the destination while the store still fails', async () => {
      const { broker, store } = seeded();
      store.saveSession.mockRejectedValue(new StoreDiskError('disk full'));
      await (await broker.getProvider(D)).rejected(UNAUTHORIZED);

      const flushed = await broker.flush().catch((e: unknown) => e);

      expect(flushed).toBeInstanceOf(Error);
      expect((flushed as Error).message).toContain(`"${D}"`);
      expect(store.saveSession).toHaveBeenCalledTimes(2);
      store.saveSession.mockResolvedValue(undefined);
      await expect(broker.flush()).resolves.toBeUndefined();
    });

    it("carries no store message: each failure is the destination and the error's class", async () => {
      const { broker, store } = seeded();
      store.saveSession.mockRejectedValue(
        new StoreDiskError('cannot save TOKEN_SENTINEL'),
      );
      await (await broker.getProvider(D)).rejected(UNAUTHORIZED);

      const flushed = (await broker.flush().catch((e: unknown) => e)) as
        | AggregateError
        | undefined;

      expect(flushed).toBeInstanceOf(AggregateError);
      expect(inspect(flushed, { depth: 10 })).not.toContain('TOKEN_SENTINEL');
      expect(flushed?.errors.map((e: Error) => e.message)).toEqual([
        `"${D}": StoreDiskError`,
      ]);
    });

    it('the retry timer does not keep the process alive', async () => {
      const { broker, store } = seeded();
      const provider = await broker.getProvider(D);
      store.saveSession.mockRejectedValueOnce(new StoreDiskError('disk full'));
      // Only the timers started while the failed write is handled.
      const timers: { timer: NodeJS.Timeout; ms?: number }[] = [];
      const realSetTimeout = global.setTimeout;
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        const timer = realSetTimeout(fn, ms);
        timers.push({ timer, ms });
        return timer;
      }) as typeof setTimeout);
      try {
        await provider.rejected(UNAUTHORIZED);
      } finally {
        spy.mockRestore();
      }

      const retry = timers.filter(({ ms }) => ms === 1_000);
      expect(retry).toHaveLength(1);
      expect(retry[0].timer.hasRef()).toBe(false);
      await broker.flush();
    });
  });
});
