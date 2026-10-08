/**
 * The token API's consumer factory beside a `clientAuthentication` strategy:
 * the broker resolves the strategy and the client identity before it calls the
 * factory, hands both over as an optional fourth argument — never PEM — and
 * binds what the factory's provider obtains to that identity. A throw from the
 * strategy or the factory is a `DestinationConfigError` in fixed words.
 *
 * Without a strategy the call is 4.0.0's: three arguments, and nothing
 * certificate-related is asked.
 */

import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IClientAuthentication,
  IRefreshableTokenProvider,
  IRequestTarget,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IClientCertificate,
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import {
  AuthBroker,
  type ClientAuthenticationContext,
  type ClientAuthenticationStrategy,
  DestinationConfigError,
  type TokenProviderFactory,
} from '../../index';
import { record } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'X509';
const REDIRECT = 'http://localhost/callback';
const FACTORY_SECRET = 'factory-said-S3CRET';

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  await endpoint.close();
});

const means = (extra: Partial<IConnectionConfig> = {}): IConnectionConfig => ({
  authType: 'jwt',
  grantType: 'authorization_code',
  serviceUrl: 'https://abap.example.com',
  sapClient: '100',
  ...extra,
});

function certificate(
  extra: Partial<IClientCertificate> = {},
): IClientCertificate {
  return {
    uaaUrl: endpoint.url,
    clientId: 'cert-client',
    certificate:
      '-----BEGIN CERTIFICATE-----\nnot-read\n-----END CERTIFICATE-----',
    key: '-----BEGIN PRIVATE KEY-----\nnot-read\n-----END PRIVATE KEY-----',
    certUrl: 'https://cert.example.com',
    ...extra,
  };
}

/**
 * What the token API writes beside a consumer factory's result for the
 * certificate client: the consumer path's record — the means' row, the
 * client id and `uaaUrl` the factory was handed, no trust.
 */
const certClientRecord = (clientId = 'cert-client') =>
  record(
    'provider/jwt/authorization_code',
    { clientId, uaaUrl: endpoint.url },
    '',
  );

const SECRET_CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'secret-client',
  uaaClientSecret: 'secret-of-the-client',
};

/** One session store over a map, shared by every broker a test builds. */
function sessions(): {
  store: ISessionStore;
  held: () => IConfig | undefined;
} {
  const map = new Map<string, IConfig>();
  const store: ISessionStore = {
    loadSession: async (d) => {
      const s = map.get(d);
      return s ? { ...s } : null;
    },
    saveSession: async (d, c) => {
      map.set(d, { ...(c as IConfig) });
    },
    getAuthorizationConfig: async () => null,
    getConnectionConfig: async () => null,
    setAuthorizationConfig: async () => {},
    setConnectionConfig: async () => {},
    deleteSession: async (d) => {
      map.delete(d);
    },
  };
  return { store, held: () => map.get(D) };
}

function keyStore(
  client: IAuthorizationConfig | null,
  cert: IClientCertificate | null,
  stated: IConnectionConfig = means(),
): IServiceKeyStore & { getClientCertificate: jest.Mock } {
  return {
    getServiceKey: async () => null,
    getAuthorizationConfig: async () => client,
    getConnectionConfig: async () => stated,
    getClientCertificate: jest.fn(async () => cert),
  };
}

const answer: IClientAuthentication = {
  authenticate: async () => ({
    headers: { Authorization: 'Strategy the-consumers-answer' },
  }),
};

/** A strategy that reads the certificate, as `fromServiceKeyCertificate` does. */
const certificateStrategy: ClientAuthenticationStrategy = async (
  context: ClientAuthenticationContext,
) => {
  await context.readCertificate();
  return answer;
};

/** A provider that answers one token, as a consumer's would. */
function tokenProvider(token: string): IRefreshableTokenProvider {
  const result: ITokenResult = {
    authorizationToken: token,
    authType: 'authorization_code',
  };
  return {
    getTokens: async () => result,
    refreshTokens: async () => result,
  };
}

/** A provider that answers one token with a refresh token. */
function refreshingProviderOf(
  token: string,
  refreshToken: string,
): IRefreshableTokenProvider {
  const result: ITokenResult = {
    authorizationToken: token,
    refreshToken,
    authType: 'authorization_code',
  };
  return {
    getTokens: async () => result,
    refreshTokens: async () => result,
  };
}

/** A user that logs in: records each time it is asked. */
function user(): { strategy: IAuthorizationStrategy<string>; asked: number } {
  const state = {
    asked: 0,
    strategy: {
      authorize: async (request: AuthorizationRequest) => {
        state.asked += 1;
        await request.buildAuthorizationUrl(REDIRECT);
        return { payload: 'the-code', redirectUri: REDIRECT };
      },
      dispose: async () => {},
    } as IAuthorizationStrategy<string>,
  };
  return state;
}

/** The bearer token a provider puts on a request. */
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

describe('the token API factory without a strategy', () => {
  it('is called with exactly three arguments, and nothing certificate-related is asked', async () => {
    const { store } = sessions();
    const keys = keyStore(SECRET_CLIENT, null);
    keys.getClientCertificate.mockImplementation(async () => {
      throw new Error('getClientCertificate must not be called');
    });
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
    });

    await broker.getToken(D);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toHaveLength(3);
    expect(factory.mock.calls[0]![1]).toEqual(SECRET_CLIENT);
    expect(keys.getClientCertificate).not.toHaveBeenCalled();
  });

  it('a throwing factory throws as 4.0.0: its own error, not the guarded one', async () => {
    const { store } = sessions();
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(SECRET_CLIENT, null),
      provider: () => {
        throw new Error(FACTORY_SECRET);
      },
    });

    await expect(broker.getToken(D)).rejects.toThrow(FACTORY_SECRET);
  });
});

describe('the token API factory beside a strategy', () => {
  it("gets a fourth argument: the strategy's answer and the certificate client's identity — never PEM", async () => {
    const { store } = sessions();
    const keys = keyStore(null, certificate());
    const contexts: ClientAuthenticationContext[] = [];
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
      clientAuthentication: async (context) => {
        contexts.push(context);
        return certificateStrategy(context);
      },
    });

    await broker.getToken(D);

    expect(factory).toHaveBeenCalledTimes(1);
    const [, authConfig, , client] = factory.mock.calls[0]!;
    expect(authConfig).toBeNull();
    expect(client).toEqual({
      clientAuthentication: answer,
      uaaUrl: endpoint.url,
      clientId: 'cert-client',
    });
    expect(client?.clientAuthentication).toBe(answer);
    expect(JSON.stringify(client)).not.toContain('-----BEGIN');
    expect(JSON.stringify(factory.mock.calls[0])).not.toContain('-----BEGIN');
    // The context: the stated grant and the secret client (none); the
    // certificate read once, memoised for the identity.
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.grant).toBe('authorization_code');
    expect(contexts[0]!.client).toBeNull();
    expect(keys.getClientCertificate).toHaveBeenCalledTimes(1);
  });

  it("a secret client: the fourth argument carries the secret client's identity, the third argument as 4.0.0", async () => {
    const { store } = sessions();
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(SECRET_CLIENT, certificate()),
      provider: factory,
      clientAuthentication: async () => answer,
    });

    await broker.getToken(D);

    const [, authConfig, , client] = factory.mock.calls[0]!;
    expect(authConfig).toEqual(SECRET_CLIENT);
    expect(client).toEqual({
      clientAuthentication: answer,
      uaaUrl: SECRET_CLIENT.uaaUrl,
      clientId: SECRET_CLIENT.uaaClientId,
    });
  });

  it("a certificate destination's tokens carry the consumer path's record, and a getProvider broker recreated for the same client does not reuse them", async () => {
    const { store, held } = sessions();
    const token = jwtExpiringIn(3600, { jti: 'token-api' });
    const tokenApi = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: () => tokenProvider(token),
      clientAuthentication: certificateStrategy,
    });

    await expect(tokenApi.getToken(D)).resolves.toBe(token);
    await tokenApi.flush();

    expect(held()).toEqual(
      expect.objectContaining({
        authorizationToken: token,
        issuedFor: 'https://abap.example.com:443?sap-client=100',
        issuedBy: certClientRecord(),
      }),
    );
    expect(JSON.stringify(held())).not.toContain('BEGIN');

    // A getProvider broker recreated for the same certificate client builds
    // the row `jwt/authorization_code`: another record — the consumer path's
    // token does not seed it, the user logs in.
    const login = user();
    const again = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      authorization: () => login.strategy,
      clientAuthentication: certificateStrategy,
    });
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    expect(login.asked).toBe(1);
    expect(await bearer(provider)).not.toBe(token);
  });

  it('a recreated broker for another certificate client id does not reuse them', async () => {
    const { store } = sessions();
    const token = jwtExpiringIn(3600, { jti: 'token-api' });
    const tokenApi = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: () => tokenProvider(token),
      clientAuthentication: certificateStrategy,
    });
    await tokenApi.getToken(D);
    await tokenApi.flush();

    const login = user();
    const again = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(
        null,
        certificate({ clientId: 'another-cert-client' }),
      ),
      authorization: () => login.strategy,
      clientAuthentication: certificateStrategy,
    });
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    expect(login.asked).toBe(1);
    expect(await bearer(provider)).not.toBe(token);
  });

  /** A provider that answers one token with a refresh token. */
  function refreshingProvider(
    token: string,
    refreshToken: string,
  ): IRefreshableTokenProvider {
    const result: ITokenResult = {
      authorizationToken: token,
      refreshToken,
      authType: 'authorization_code',
    };
    return {
      getTokens: async () => result,
      refreshTokens: async () => result,
    };
  }

  it("a certificate client's stored refresh token does not reach the factory after the broker is recreated: the consumer path is never seeded", async () => {
    const { store, held } = sessions();
    const first = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => refreshingProvider(jwtExpiringIn(3600), 'refresh-cert-1'));
    const tokenApi = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: first,
      clientAuthentication: certificateStrategy,
    });
    await tokenApi.getToken(D);
    await tokenApi.flush();
    expect(held()?.refreshToken).toBe('refresh-cert-1');
    // Nothing stored yet when the first factory was built.
    expect(first.mock.calls[0]![3]).not.toHaveProperty('refreshToken');

    const again = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const recreated = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: again,
      clientAuthentication: certificateStrategy,
    });
    await recreated.getToken(D);

    const [, authConfig, , client] = again.mock.calls[0]!;
    expect(authConfig).toBeNull();
    expect(client).toEqual({
      clientAuthentication: answer,
      uaaUrl: endpoint.url,
      clientId: 'cert-client',
    });
    expect(JSON.stringify(again.mock.calls[0])).not.toContain('refresh-cert-1');
    expect(JSON.stringify(again.mock.calls[0])).not.toContain('-----BEGIN');
  });

  it('a secret client never gets the stored refresh token through authConfig, with a strategy or without one (§5.5)', async () => {
    for (const clientAuthentication of [undefined, certificateStrategy]) {
      const { store } = sessions();
      const first = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore(SECRET_CLIENT, null),
        provider: () =>
          refreshingProvider(jwtExpiringIn(3600), 'refresh-secret-1'),
        ...(clientAuthentication ? { clientAuthentication } : {}),
      });
      await first.getToken(D);
      await first.flush();

      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => tokenProvider(jwtExpiringIn(3600)));
      const recreated = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore(SECRET_CLIENT, null),
        provider: factory,
        ...(clientAuthentication ? { clientAuthentication } : {}),
      });
      await recreated.getToken(D);

      expect(factory.mock.calls[0]![1]).toEqual({
        ...SECRET_CLIENT,
        refreshToken: undefined,
      });
      if (!clientAuthentication) {
        expect(factory.mock.calls[0]).toHaveLength(3);
      }
    }
  });

  /** Stores a session through the token API for `keys`; returns the store. */
  async function storedThrough(
    keys: IServiceKeyStore,
    refreshToken: string,
    clientAuthentication: ClientAuthenticationStrategy | undefined,
  ) {
    const { store, held } = sessions();
    const first = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: () => refreshingProvider(jwtExpiringIn(3600), refreshToken),
      ...(clientAuthentication ? { clientAuthentication } : {}),
    });
    await first.getToken(D);
    await first.flush();
    expect(held()?.refreshToken).toBe(refreshToken);
    return store;
  }

  /** The factory call of a token-API broker built over `store` for `keys`. */
  async function factoryCall(
    store: ISessionStore,
    keys: IServiceKeyStore,
    clientAuthentication: ClientAuthenticationStrategy | undefined,
  ) {
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
      ...(clientAuthentication ? { clientAuthentication } : {}),
    });
    await broker.getToken(D);
    expect(factory).toHaveBeenCalledTimes(1);
    return factory.mock.calls[0]!;
  }

  it("a certificate client's refresh token does not reach the factory for another client id", async () => {
    const store = await storedThrough(
      keyStore(null, certificate()),
      'refresh-of-A',
      certificateStrategy,
    );

    const call = await factoryCall(
      store,
      keyStore(null, certificate({ clientId: 'cert-client-B' })),
      certificateStrategy,
    );

    expect(call[1]).toBeNull();
    expect(call[3]).toEqual({
      clientAuthentication: answer,
      uaaUrl: endpoint.url,
      clientId: 'cert-client-B',
    });
    expect(JSON.stringify(call)).not.toContain('refresh-of-A');
  });

  it("a certificate client's refresh token does not reach the factory for another issuer", async () => {
    const store = await storedThrough(
      keyStore(null, certificate()),
      'refresh-of-A',
      certificateStrategy,
    );

    const call = await factoryCall(
      store,
      keyStore(null, certificate({ uaaUrl: 'https://other-uaa.example.com' })),
      certificateStrategy,
    );

    expect(call[3]).toEqual({
      clientAuthentication: answer,
      uaaUrl: 'https://other-uaa.example.com',
      clientId: 'cert-client',
    });
    expect(JSON.stringify(call)).not.toContain('refresh-of-A');
  });

  it('a secret client: a session bound to another client gives no refresh token, with a strategy or without one', async () => {
    const other: IAuthorizationConfig = {
      ...SECRET_CLIENT,
      uaaClientId: 'another-secret-client',
    };

    const withStrategy = await factoryCall(
      await storedThrough(
        keyStore(SECRET_CLIENT, null),
        'refresh-of-A',
        certificateStrategy,
      ),
      keyStore(other, null),
      certificateStrategy,
    );
    expect(withStrategy[1]).toEqual(expect.objectContaining(other));
    expect(withStrategy[1]?.refreshToken).toBeUndefined();
    expect(JSON.stringify(withStrategy)).not.toContain('refresh-of-A');

    // Without a strategy as well: the consumer path is never seeded (§5.5).
    const without = await factoryCall(
      await storedThrough(
        keyStore(SECRET_CLIENT, null),
        'refresh-of-A',
        undefined,
      ),
      keyStore(other, null),
      undefined,
    );
    expect(without).toHaveLength(3);
    expect(without[1]?.refreshToken).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain('refresh-of-A');
  });

  it('basic and snc destinations are refused by the token API itself, before the strategy', async () => {
    for (const authType of ['basic', 'snc'] as const) {
      const { store } = sessions();
      const strategy = jest.fn(certificateStrategy);
      const factory = jest.fn<
        IRefreshableTokenProvider,
        Parameters<TokenProviderFactory>
      >(() => tokenProvider(jwtExpiringIn(3600)));
      const keys = keyStore(SECRET_CLIENT, certificate(), {
        authType,
        serviceUrl: 'https://abap.example.com',
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keys,
        provider: factory,
        clientAuthentication: strategy,
      });

      const error = await broker.getToken(D).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DestinationConfigError);
      expect((error as DestinationConfigError).missingFields).toEqual([
        'authType',
      ]);
      expect((error as Error).message).toContain(
        `the token API serves no ${authType} destination`,
      );
      expect(strategy).not.toHaveBeenCalled();
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it('a 4.0.0-shaped factory (three parameters) keeps working', async () => {
    const { store } = sessions();
    const token = jwtExpiringIn(3600);
    const seen: Array<IAuthorizationConfig | null> = [];
    const threeParameters = (
      _destination: string,
      authConfig: IAuthorizationConfig | null,
      _connConfig: IConnectionConfig,
    ): IRefreshableTokenProvider => {
      seen.push(authConfig);
      return tokenProvider(token);
    };
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: threeParameters,
      clientAuthentication: certificateStrategy,
    });

    await expect(broker.getToken(D)).resolves.toBe(token);
    expect(seen).toEqual([null]);
  });

  it('a throwing factory is the guarded DestinationConfigError: fixed words, no cause, and the next call builds again', async () => {
    const { store } = sessions();
    let calls = 0;
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: () => {
        calls += 1;
        if (calls === 1) throw new Error(FACTORY_SECRET);
        return tokenProvider(jwtExpiringIn(3600));
      },
      clientAuthentication: certificateStrategy,
    });

    const error = await broker.getToken(D).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationConfigError);
    const refusal = error as DestinationConfigError;
    expect(refusal.message).toBe(
      `Destination "${D}": the token provider factory failed beside the clientAuthentication strategy (provider, clientAuthentication)`,
    );
    expect(refusal.message).not.toContain(FACTORY_SECRET);
    expect('cause' in refusal).toBe(false);

    await expect(broker.getToken(D)).resolves.toEqual(expect.any(String));
    expect(calls).toBe(2);
  });

  it('a throwing strategy is the guarded DestinationConfigError, and the factory is never called', async () => {
    const { store } = sessions();
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: factory,
      clientAuthentication: async () => {
        throw new Error('strategy-said-S3CRET');
      },
    });

    const error = await broker.getToken(D).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationConfigError);
    expect((error as DestinationConfigError).missingFields).toEqual([
      'clientAuthentication',
    ]);
    expect((error as Error).message).not.toContain('strategy-said-S3CRET');
    expect(factory).not.toHaveBeenCalled();
  });

  it('a destination that states no grant is refused before the strategy: it would be told none', async () => {
    const { store } = sessions();
    const strategy = jest.fn(certificateStrategy);
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate(), {
        serviceUrl: 'https://abap.example.com',
      }),
      provider: factory,
      clientAuthentication: strategy,
    });

    const error = await broker.getToken(D).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationConfigError);
    expect((error as DestinationConfigError).missingFields).toEqual([
      'authType',
      'grantType',
    ]);
    expect(strategy).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('a grant that authenticates no client (saml2_pure) never calls the strategy: three arguments, as 4.0.0', async () => {
    const { store } = sessions();
    const strategy = jest.fn(certificateStrategy);
    const keys = keyStore(SECRET_CLIENT, certificate(), {
      authType: 'saml',
      grantType: 'saml2_pure',
      serviceUrl: 'https://abap.example.com',
    });
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
      clientAuthentication: strategy,
    });

    await broker.getToken(D);

    expect(strategy).not.toHaveBeenCalled();
    expect(keys.getClientCertificate).not.toHaveBeenCalled();
    expect(factory.mock.calls[0]).toHaveLength(3);
  });

  describe('a resource neither side states (Ruling 14)', () => {
    // A service URL with no canonical form binds no resource, as the CLI's
    // XSUAA placeholder: the session is stored without `issuedFor`.
    const unstated = () => means({ serviceUrl: '<SERVICE_URL>' });

    it('the same client: the consumer path is still never seeded — its refresh token reaches no argument', async () => {
      const store = await storedThrough(
        keyStore(null, certificate(), unstated()),
        'refresh-of-A',
        certificateStrategy,
      );
      const session = await store.loadSession(D);
      // Written as '' — no resource — never left to the merge (§5.2).
      expect(session?.issuedFor).toBe('');
      expect(session?.issuedBy).toBe(certClientRecord());

      const call = await factoryCall(
        store,
        keyStore(null, certificate(), unstated()),
        certificateStrategy,
      );
      expect(call[3]).toEqual({
        clientAuthentication: answer,
        uaaUrl: endpoint.url,
        clientId: 'cert-client',
      });
      expect(JSON.stringify(call)).not.toContain('refresh-of-A');
    });

    it('the same client: a result without a refresh token does not carry the stored one', async () => {
      const store = await storedThrough(
        keyStore(null, certificate(), unstated()),
        'refresh-of-A',
        certificateStrategy,
      );
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore(null, certificate(), unstated()),
        provider: () => tokenProvider(jwtExpiringIn(3600)),
        clientAuthentication: certificateStrategy,
      });
      await broker.refreshToken(D);
      await broker.flush();
      expect((await store.loadSession(D))?.refreshToken).toBe('');
    });

    it('no client identity: a session stating neither resource nor issuer is not bound', async () => {
      const { store } = sessions();
      await store.saveSession(D, {
        authorizationToken: jwtExpiringIn(3600),
        refreshToken: 'refresh-of-nobody',
      } as IConfig);
      const call = await factoryCall(
        store,
        keyStore(null, null, unstated()),
        async () => answer,
      );
      expect(call[1]).toBeNull();
      expect(call[3]).toEqual({ clientAuthentication: answer });
      expect(JSON.stringify(call)).not.toContain('refresh-of-nobody');
    });

    it('the same client: the stored access token does not seed the factory', async () => {
      const { store } = secretSessions();
      const first = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore(null, certificate(), unstated()),
        provider: () => refreshingProvider(jwtExpiringIn(3600), 'refresh-of-A'),
        clientAuthentication: certificateStrategy,
      });
      await first.getToken(D);
      await first.flush();
      const stored = (await store.loadSession(D))?.authorizationToken;
      expect(stored).toBeDefined();

      const call = await factoryCall(
        store,
        keyStore(null, certificate(), unstated()),
        certificateStrategy,
      );
      expect(call[2]).not.toHaveProperty('authorizationToken');
      expect(JSON.stringify(call)).not.toContain(stored as string);
    });

    it('another client: not bound', async () => {
      const store = await storedThrough(
        keyStore(null, certificate(), unstated()),
        'refresh-of-A',
        certificateStrategy,
      );
      const call = await factoryCall(
        store,
        keyStore(null, certificate({ clientId: 'cert-client-B' }), unstated()),
        certificateStrategy,
      );
      expect(call[3]).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(call)).not.toContain('refresh-of-A');
    });

    it('a session stored with no resource, a destination stating one: not bound', async () => {
      const store = await storedThrough(
        keyStore(null, certificate(), unstated()),
        'refresh-of-A',
        certificateStrategy,
      );
      const call = await factoryCall(
        store,
        keyStore(null, certificate()),
        certificateStrategy,
      );
      expect(call[3]).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(call)).not.toContain('refresh-of-A');
    });

    it('a session stored with a resource, a destination stating none: not bound', async () => {
      const store = await storedThrough(
        keyStore(null, certificate()),
        'refresh-of-A',
        certificateStrategy,
      );
      expect((await store.loadSession(D))?.issuedFor).toBeDefined();
      const call = await factoryCall(
        store,
        keyStore(null, certificate(), unstated()),
        certificateStrategy,
      );
      expect(call[3]).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(call)).not.toContain('refresh-of-A');
    });
  });
});

/**
 * A session store as `SecretSessionStore` answers: `getConnectionConfig`
 * returns the stored secret without its refresh token, so the token API seeds
 * the factory's provider with it.
 */
function secretSessions(): {
  store: ISessionStore;
  held: () => IConfig | undefined;
} {
  const base = sessions();
  base.store.getConnectionConfig = async (d) => {
    const s = await base.store.loadSession(d);
    if (!s) return null;
    const { refreshToken: _omitted, ...rest } = s;
    return rest as IConnectionConfig;
  };
  return base;
}

describe('a session obtained for another client, on the strategy path', () => {
  /** A token-API broker over `store` for `keys`; its factory recorded. */
  async function tokenApi(
    store: ISessionStore,
    keys: IServiceKeyStore,
    answerWith: () => IRefreshableTokenProvider,
    clientAuthentication: ClientAuthenticationStrategy | undefined,
  ) {
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(answerWith);
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
      ...(clientAuthentication ? { clientAuthentication } : {}),
    });
    await broker.getToken(D);
    await broker.flush();
    return factory.mock.calls[0]!;
  }

  const SECRET_KEYS = [
    'authorizationToken',
    'sessionCookies',
    'expiresAt',
    'issuedFor',
    'issuedBy',
  ];

  for (const [what, otherCert] of [
    ['another client id', { clientId: 'cert-client-B' }],
    ['another issuer', { uaaUrl: 'https://other-uaa.example.com' }],
  ] as const) {
    it(`${what}: A's refresh token is not laundered into B's secret, and A's access token does not seed B`, async () => {
      const { store, held } = secretSessions();
      const tokenA = jwtExpiringIn(3600, { jti: 'A' });
      await tokenApi(
        store,
        keyStore(null, certificate()),
        () => refreshingProviderOf(tokenA, 'refresh-of-A'),
        certificateStrategy,
      );
      expect(held()?.refreshToken).toBe('refresh-of-A');

      // B's provider answers no refresh token.
      const tokenB = jwtExpiringIn(3600, { jti: 'B' });
      const callB = await tokenApi(
        store,
        keyStore(null, certificate(otherCert)),
        () => tokenProvider(tokenB),
        certificateStrategy,
      );
      for (const key of SECRET_KEYS) {
        expect(callB[2]).not.toHaveProperty(key);
      }
      expect(JSON.stringify(callB)).not.toContain(tokenA);
      expect(JSON.stringify(callB)).not.toContain('refresh-of-A');
      expect(held()?.authorizationToken).toBe(tokenB);
      expect(held()?.refreshToken).toBe('');
      expect(JSON.stringify(held())).not.toContain('refresh-of-A');

      // The next broker for B: nothing seeds it — not even B's own secret,
      // the consumer path is never seeded — and nothing of A.
      const callB2 = await tokenApi(
        store,
        keyStore(null, certificate(otherCert)),
        () => tokenProvider(tokenB),
        certificateStrategy,
      );
      expect(callB2[3]).not.toHaveProperty('refreshToken');
      for (const key of SECRET_KEYS) {
        expect(callB2[2]).not.toHaveProperty(key);
      }
      expect(JSON.stringify(callB2)).not.toContain(tokenA);
      expect(JSON.stringify(callB2)).not.toContain('refresh-of-A');
    });
  }

  it('the same client: its own access token does not seed the factory, its refresh token is not carried', async () => {
    const { store, held } = secretSessions();
    const tokenA = jwtExpiringIn(3600, { jti: 'A' });
    await tokenApi(
      store,
      keyStore(null, certificate()),
      () => refreshingProviderOf(tokenA, 'refresh-of-A'),
      certificateStrategy,
    );
    const call = await tokenApi(
      store,
      keyStore(null, certificate()),
      () => tokenProvider(tokenA),
      certificateStrategy,
    );
    for (const key of SECRET_KEYS) {
      expect(call[2]).not.toHaveProperty(key);
    }
    expect(call[3]).not.toHaveProperty('refreshToken');
    expect(held()?.refreshToken).toBe('');
  });

  it("without a strategy: A's access token does not seed B, A's refresh token reaches no argument, and B's result without one writes '' (§5.5, D5)", async () => {
    const { store, held } = secretSessions();
    const tokenA = jwtExpiringIn(3600, { jti: 'A' });
    await tokenApi(
      store,
      keyStore(SECRET_CLIENT, null),
      () => refreshingProviderOf(tokenA, 'refresh-of-A'),
      undefined,
    );
    const tokenB = jwtExpiringIn(3600, { jti: 'B' });
    const callB = await tokenApi(
      store,
      keyStore({ ...SECRET_CLIENT, uaaClientId: 'secret-client-B' }, null),
      () => tokenProvider(tokenB),
      undefined,
    );
    expect(callB).toHaveLength(3);
    for (const key of SECRET_KEYS) {
      expect(callB[2]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(callB)).not.toContain(tokenA);
    expect(JSON.stringify(callB)).not.toContain('refresh-of-A');
    expect(held()?.refreshToken).toBe('');
  });

  it("a session store holding its own client: on the strategy path no refresh token reaches the factory — neither the client read's nor the session's, whatever its record", async () => {
    const sessionClient: IAuthorizationConfig = {
      uaaUrl: 'https://uaa.example.com',
      uaaClientId: 'session-client',
      uaaClientSecret: 'session-secret',
      refreshToken: 'refresh-of-session-client',
    };
    const make = (issuedBy: string) => {
      const { store } = secretSessions();
      store.getAuthorizationConfig = async () => sessionClient;
      store.loadSession = async () => ({
        authorizationToken: 'token-of-the-session',
        expiresAt: Date.now() + 3_600_000,
        refreshToken: 'stored-refresh',
        issuedFor: 'https://abap.example.com:443?sap-client=100',
        issuedBy,
      });
      return store;
    };
    const foreign = record(
      'provider/jwt/authorization_code',
      { clientId: 'another-client', uaaUrl: 'https://uaa.example.com' },
      '',
    );
    // Exactly the record this path writes: still not seeded.
    const own = record(
      'provider/jwt/authorization_code',
      { clientId: 'session-client', uaaUrl: 'https://uaa.example.com' },
      '',
    );

    const unbound = await tokenApi(
      make(foreign),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(unbound[1]).toEqual({ ...sessionClient, refreshToken: undefined });
    expect(unbound[3]).not.toHaveProperty('refreshToken');
    for (const key of SECRET_KEYS) {
      expect(unbound[2]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(unbound)).not.toContain('token-of-the-session');

    const bound = await tokenApi(
      make(own),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(bound[1]).toEqual({ ...sessionClient, refreshToken: undefined });
    expect(bound[3]).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(bound)).not.toContain('refresh-of-session-client');
    expect(JSON.stringify(bound)).not.toContain('stored-refresh');
    for (const key of SECRET_KEYS) {
      expect(bound[2]).not.toHaveProperty(key);
    }

    // Without a strategy: the session's client, without its refresh token,
    // and no stored secret in the seed (§5.5).
    const without = await tokenApi(
      make(foreign),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      undefined,
    );
    expect(without[1]).toEqual({ ...sessionClient, refreshToken: undefined });
    for (const key of SECRET_KEYS) {
      expect(without[2]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(without)).not.toContain('token-of-the-session');
  });

  it("a session store holding its own client, rewritten between the reads: resource A's refresh token never reaches resource B's factory", async () => {
    const own = record(
      'provider/jwt/authorization_code',
      { clientId: 'session-client', uaaUrl: 'https://uaa.example.com' },
      '',
    );
    // getAuthorizationConfig reads the client while the session is A's: it
    // carries A's refresh token. Another process then writes B's session —
    // the same client, B's resource — which loadSession reads, bound to B.
    const make = (sessionFor: IConfig) => {
      const { store } = secretSessions();
      store.getAuthorizationConfig = async () => ({
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'session-client',
        uaaClientSecret: 'session-secret',
        refreshToken: 'refresh-of-A',
      });
      store.loadSession = async () => sessionFor;
      return store;
    };
    const ofB = {
      refreshToken: 'refresh-of-B',
      expiresAt: Date.now() + 3_600_000,
      issuedFor: 'https://abap.example.com:443?sap-client=100',
      issuedBy: own,
    };

    const rewritten = await tokenApi(
      make(ofB),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(JSON.stringify(rewritten)).not.toContain('refresh-of-A');
    // The consumer path is never seeded: not B's either.
    expect(rewritten[1]?.refreshToken).toBeUndefined();
    expect(rewritten[3]).not.toHaveProperty('refreshToken');

    // A session read bound elsewhere: no refresh token at all.
    const elsewhere = await tokenApi(
      make({
        ...ofB,
        issuedFor: 'https://other.example.com:443?sap-client=100',
      }),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(JSON.stringify(elsewhere)).not.toContain('refresh-of-A');
    expect(elsewhere[1]?.refreshToken).toBeUndefined();
    expect(elsewhere[3]).not.toHaveProperty('refreshToken');
  });

  it('an authorization-config read carrying more than a client: on the strategy path only uaaUrl, uaaClientId, uaaClientSecret and the bound refresh token reach the factory', async () => {
    // Outside the type: a custom store answering a session's secret with its
    // client. None of it is checked by a binding.
    const overfull = {
      uaaUrl: 'https://uaa.example.com',
      uaaClientId: 'session-client',
      uaaClientSecret: 'session-secret',
      refreshToken: 'refresh-of-the-client-read',
      authorizationToken: 'token-of-the-client-read',
      sessionCookies: 'cookies-of-the-client-read',
      expiresAt: 4_102_444_800_000,
    } as IAuthorizationConfig;
    const leaked = [
      'refresh-of-the-client-read',
      'token-of-the-client-read',
      'cookies-of-the-client-read',
      '4102444800000',
    ];
    const overSession = () => {
      const { store } = secretSessions();
      store.getAuthorizationConfig = async () => overfull;
      return store;
    };
    const overKeys = keyStore(overfull, null);

    for (const [sessions, keys] of [
      [overSession(), keyStore(null, null)],
      [secretSessions().store, overKeys],
    ] as const) {
      const call = await tokenApi(
        sessions,
        keys,
        () => tokenProvider(jwtExpiringIn(3600)),
        certificateStrategy,
      );
      expect(Object.keys(call[1] ?? {}).sort()).toEqual([
        'refreshToken',
        'uaaClientId',
        'uaaClientSecret',
        'uaaUrl',
      ]);
      expect(call[1]?.refreshToken).toBeUndefined();
      for (const value of leaked) {
        expect(JSON.stringify([call[1], call[3]])).not.toContain(value);
      }
    }

    // Without a strategy: the same allowlist (§5.5).
    const without = await tokenApi(
      overSession(),
      keyStore(null, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      undefined,
    );
    expect(without[1]?.refreshToken).toBeUndefined();
    for (const value of leaked) {
      expect(JSON.stringify(without)).not.toContain(value);
    }
  });

  it('the seed on the strategy path is an allowlist: extra secrets, PEM-shaped and unknown fields of the connection read never reach the factory', async () => {
    const forCertClient = {
      issuedFor: 'https://abap.example.com:443?sap-client=100',
      issuedBy: certClientRecord(),
    };
    const expiresAt = Date.now() + 3_600_000;
    const extras = {
      uaaClientSecret: 'secret-in-the-connection-read',
      password: 'password-in-the-connection-read',
      oidcSubjectToken: 'subject-in-the-connection-read',
      certificate:
        '-----BEGIN CERTIFICATE-----\nPEM-in-the-read\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\nKEY-in-the-read\n-----END PRIVATE KEY-----',
      refreshToken: 'refresh-in-the-connection-read',
      somethingUnknown: 'unknown-in-the-connection-read',
    };
    const leaked = [
      'secret-in-the-connection-read',
      'password-in-the-connection-read',
      'subject-in-the-connection-read',
      'PEM-in-the-read',
      'KEY-in-the-read',
      'refresh-in-the-connection-read',
      'unknown-in-the-connection-read',
    ];
    const withConnection = (connection: IConnectionConfig) => {
      const { store } = sessions();
      store.getConnectionConfig = async () => connection;
      return store;
    };
    const keys = keyStore(null, certificate());

    const bound = await tokenApi(
      withConnection({
        authorizationToken: 'token-of-the-bound-read',
        expiresAt,
        language: 'EN',
        ...forCertClient,
        ...extras,
      } as IConnectionConfig),
      keys,
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    // The consumer path is never seeded: the means only, even from a read
    // whose record is exactly this path's.
    expect(bound[2]).toEqual(expect.objectContaining({ language: 'EN' }));
    for (const key of SECRET_KEYS) {
      expect(bound[2]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(bound)).not.toContain('token-of-the-bound-read');
    for (const value of leaked) {
      expect(JSON.stringify([bound[1], bound[2], bound[3]])).not.toContain(
        value,
      );
    }
    expect(JSON.stringify(bound[2])).not.toContain('-----BEGIN');

    const unbound = await tokenApi(
      withConnection({
        authorizationToken: 'token-of-the-unbound-read',
        expiresAt,
        language: 'EN',
        issuedFor: forCertClient.issuedFor,
        issuedBy: certClientRecord('another-client'),
        ...extras,
      } as IConnectionConfig),
      keys,
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(unbound[2]).toEqual(expect.objectContaining({ language: 'EN' }));
    for (const key of SECRET_KEYS) {
      expect(unbound[2]).not.toHaveProperty(key);
    }
    for (const value of [...leaked, 'token-of-the-unbound-read']) {
      expect(
        JSON.stringify([unbound[1], unbound[2], unbound[3]]),
      ).not.toContain(value);
    }

    // Without a strategy: the same allowlist (§5.5).
    const without = await tokenApi(
      withConnection({ language: 'EN', ...extras } as IConnectionConfig),
      keyStore(SECRET_CLIENT, null),
      () => tokenProvider(jwtExpiringIn(3600)),
      undefined,
    );
    expect(without[2]).toEqual(expect.objectContaining({ language: 'EN' }));
    for (const value of leaked) {
      expect(JSON.stringify([without[1], without[2]])).not.toContain(value);
    }
  });

  it('each stored secret is judged by the read it came from: a seed read after another process wrote is checked on its own binding', async () => {
    const forA = {
      issuedFor: 'https://abap.example.com:443?sap-client=100',
      issuedBy: certClientRecord(),
    };
    const forB = {
      issuedFor: 'https://abap.example.com:443?sap-client=100',
      issuedBy: certClientRecord('cert-client-B'),
    };
    const expiresAt = Date.now() + 3_600_000;
    /** loadSession answers one secret, getConnectionConfig another. */
    const split = (
      session: IConfig,
      connection: IConnectionConfig,
    ): ISessionStore => {
      const { store } = sessions();
      store.loadSession = async () => session;
      store.getConnectionConfig = async () => connection;
      return store;
    };
    const keysB = keyStore(null, certificate({ clientId: 'cert-client-B' }));

    // The session read says B; the connection read, written meanwhile, holds
    // A's token: A's token does not seed B.
    const staleSeed = await tokenApi(
      split(
        { refreshToken: 'refresh-of-B', expiresAt, ...forB },
        { authorizationToken: 'token-of-A', expiresAt, ...forA },
      ),
      keysB,
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(JSON.stringify(staleSeed[2])).not.toContain('token-of-A');
    for (const key of SECRET_KEYS) {
      expect(staleSeed[2]).not.toHaveProperty(key);
    }
    // Nor B's own refresh token: the consumer path is never seeded.
    expect(staleSeed[3]).not.toHaveProperty('refreshToken');

    // The other way round: the connection read is B's own — and still does
    // not seed; the session read is A's, so its refresh token does not reach
    // the factory.
    const staleRefresh = await tokenApi(
      split(
        { refreshToken: 'refresh-of-A', expiresAt, ...forA },
        { authorizationToken: 'token-of-B', expiresAt, ...forB },
      ),
      keysB,
      () => tokenProvider(jwtExpiringIn(3600)),
      certificateStrategy,
    );
    expect(JSON.stringify(staleRefresh[2])).not.toContain('token-of-B');
    expect(staleRefresh[3]).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(staleRefresh)).not.toContain('refresh-of-A');
  });
});
