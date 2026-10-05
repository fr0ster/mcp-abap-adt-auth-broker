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
      sessionStore: store,
      serviceKeyStore: keys,
      provider: factory,
    });

    await broker.getToken(D);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toHaveLength(3);
    expect(factory.mock.calls[0][1]).toEqual(SECRET_CLIENT);
    expect(keys.getClientCertificate).not.toHaveBeenCalled();
  });

  it('a throwing factory throws as 4.0.0: its own error, not the guarded one', async () => {
    const { store } = sessions();
    const broker = new AuthBroker({
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
    const [, authConfig, , client] = factory.mock.calls[0];
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
    expect(contexts[0].grant).toBe('authorization_code');
    expect(contexts[0].client).toBeNull();
    expect(keys.getClientCertificate).toHaveBeenCalledTimes(1);
  });

  it("a secret client: the fourth argument carries the secret client's identity, the third argument as 4.0.0", async () => {
    const { store } = sessions();
    const factory = jest.fn<
      IRefreshableTokenProvider,
      Parameters<TokenProviderFactory>
    >(() => tokenProvider(jwtExpiringIn(3600)));
    const broker = new AuthBroker({
      sessionStore: store,
      serviceKeyStore: keyStore(SECRET_CLIENT, certificate()),
      provider: factory,
      clientAuthentication: async () => answer,
    });

    await broker.getToken(D);

    const [, authConfig, , client] = factory.mock.calls[0];
    expect(authConfig).toEqual(SECRET_CLIENT);
    expect(client).toEqual({
      clientAuthentication: answer,
      uaaUrl: SECRET_CLIENT.uaaUrl,
      clientId: SECRET_CLIENT.uaaClientId,
    });
  });

  it("a certificate destination's tokens carry issuedBy = issuer?client_id, and a recreated broker reuses them", async () => {
    const { store, held } = sessions();
    const token = jwtExpiringIn(3600, { jti: 'token-api' });
    const tokenApi = new AuthBroker({
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
        issuedBy: `${endpoint.url}?client_id=cert-client`,
      }),
    );
    expect(JSON.stringify(held())).not.toContain('BEGIN');

    // A broker recreated for the same certificate client seeds it: no login,
    // no request.
    const login = user();
    const again = new AuthBroker({
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      authorization: () => login.strategy,
      clientAuthentication: certificateStrategy,
    });
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    expect(await bearer(provider)).toBe(token);
    expect(login.asked).toBe(0);
    expect(endpoint.requests).toHaveLength(0);
  });

  it('a recreated broker for another certificate client id does not reuse them', async () => {
    const { store } = sessions();
    const token = jwtExpiringIn(3600, { jti: 'token-api' });
    const tokenApi = new AuthBroker({
      sessionStore: store,
      serviceKeyStore: keyStore(null, certificate()),
      provider: () => tokenProvider(token),
      clientAuthentication: certificateStrategy,
    });
    await tokenApi.getToken(D);
    await tokenApi.flush();

    const login = user();
    const again = new AuthBroker({
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
});
