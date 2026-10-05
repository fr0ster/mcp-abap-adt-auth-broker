/**
 * The session binding of a destination whose client authenticates through the
 * consumer's strategy: `issuedBy` names the issuer and the client identity —
 * the secret client when the key store has one, else the certificate client's
 * `uaaUrl` and `clientId` — never PEM. A token stored for one client identity
 * seeds a broker built later for the same one, and no other (Review Focus 2).
 *
 * The providers are real (auth-providers 5.3.0) against local token endpoints;
 * the strategy's answer authenticates with a header of its own.
 */

import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IClientAuthentication,
  IRequestTarget,
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
} from '../../index';
import {
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'X509';
const REDIRECT = 'http://localhost/callback';
const FOR = 'https://abap.example.com:443?sap-client=100';
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';

let endpoint: TokenEndpoint;
let other: TokenEndpoint;

beforeEach(async () => {
  [endpoint, other] = await Promise.all([
    startTokenEndpoint(),
    startTokenEndpoint(),
  ]);
});

afterEach(async () => {
  await Promise.all([endpoint.close(), other.close()]);
});

const means: IConnectionConfig = {
  authType: 'jwt',
  grantType: 'authorization_code',
  serviceUrl: 'https://abap.example.com',
  sapClient: '100',
};

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

const secretClient = (
  extra: Partial<IAuthorizationConfig> = {},
): IAuthorizationConfig => ({
  uaaUrl: endpoint.url,
  uaaClientId: 'secret-client',
  uaaClientSecret: CLIENT_SECRET,
  ...extra,
});

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
): IServiceKeyStore & { getClientCertificate: jest.Mock } {
  return {
    getServiceKey: async () => null,
    getAuthorizationConfig: async () => client,
    getConnectionConfig: async () => means,
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

function broker(
  store: ISessionStore,
  keys: IServiceKeyStore,
  login: { strategy: IAuthorizationStrategy<string> },
  clientAuthentication?: ClientAuthenticationStrategy,
): AuthBroker {
  return new AuthBroker({
    sessionStore: store,
    serviceKeyStore: keys,
    authorization: () => login.strategy,
    ...(clientAuthentication ? { clientAuthentication } : {}),
  });
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

/** Logs in once with a certificate client; returns the stored session. */
async function loggedIn(store: ISessionStore) {
  const login = user();
  const first = broker(
    store,
    keyStore(null, certificate()),
    login,
    certificateStrategy,
  );
  const provider = await first.getProvider(D);
  expect(await provider.prepare()).toEqual({ ok: true });
  await first.flush();
  return login;
}

describe('the binding of a certificate client', () => {
  it('stores its tokens with issuedBy = its issuer and client — never PEM', async () => {
    const { store, held } = sessions();
    await loggedIn(store);

    expect(held()).toEqual({
      authorizationToken: endpoint.issued[0],
      refreshToken: 'refresh-1',
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: `${endpoint.url}?client_id=cert-client`,
    });
    expect(JSON.stringify(held())).not.toContain('BEGIN');
  });

  it('is reused by a broker recreated for the same certificate client: no login, no request', async () => {
    const { store, held } = sessions();
    await loggedIn(store);
    const stored = held()?.authorizationToken;
    const requests = endpoint.requests.length;

    const login = user();
    const again = broker(
      store,
      keyStore(null, certificate()),
      login,
      certificateStrategy,
    );
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });

    expect(await bearer(provider)).toBe(stored);
    expect(login.asked).toBe(0);
    expect(endpoint.requests).toHaveLength(requests);
  });

  it('is refused after the client id changes: a fresh login, the old refresh token not spent', async () => {
    const { store, held } = sessions();
    await loggedIn(store);

    const login = user();
    const again = broker(
      store,
      keyStore(null, certificate({ clientId: 'another-cert-client' })),
      login,
      certificateStrategy,
    );
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await again.flush();

    expect(login.asked).toBe(1);
    expect(endpoint.requests.at(-1)?.grantType).toBe('authorization_code');
    expect(held()?.issuedBy).toBe(
      `${endpoint.url}?client_id=another-cert-client`,
    );
  });

  it('is refused after the issuer changes: a fresh login at the new one', async () => {
    const { store, held } = sessions();
    await loggedIn(store);

    const login = user();
    const again = broker(
      store,
      keyStore(null, certificate({ uaaUrl: other.url })),
      login,
      certificateStrategy,
    );
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await again.flush();

    expect(login.asked).toBe(1);
    expect(other.requests.map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    expect(held()?.issuedBy).toBe(`${other.url}?client_id=cert-client`);
  });
});

describe('a destination switched between a secret and a certificate (Review Focus 2)', () => {
  it('secret → certificate: the session the secret client obtained is not reused', async () => {
    const { store, held } = sessions();
    const before = broker(store, keyStore(secretClient(), null), user());
    expect(await (await before.getProvider(D)).prepare()).toEqual({
      ok: true,
    });
    await before.flush();
    expect(held()?.issuedBy).toBe(`${endpoint.url}?client_id=secret-client`);
    const secretToken = held()?.authorizationToken;

    const login = user();
    const after = broker(
      store,
      keyStore(null, certificate()),
      login,
      certificateStrategy,
    );
    const provider = await after.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await after.flush();

    expect(login.asked).toBe(1);
    expect(await bearer(provider)).not.toBe(secretToken);
    expect(held()?.issuedBy).toBe(`${endpoint.url}?client_id=cert-client`);
  });

  it('certificate → secret: the session the certificate client obtained is not reused', async () => {
    const { store, held } = sessions();
    await loggedIn(store);
    const certToken = held()?.authorizationToken;

    const login = user();
    const after = broker(store, keyStore(secretClient(), null), login);
    const provider = await after.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await after.flush();

    expect(login.asked).toBe(1);
    expect(await bearer(provider)).not.toBe(certToken);
    expect(held()?.issuedBy).toBe(`${endpoint.url}?client_id=secret-client`);
  });
});

describe('with a strategy and a secret client', () => {
  it('binds to the secret client, and reads no certificate', async () => {
    const { store, held } = sessions();
    const keys = keyStore(
      secretClient(),
      certificate({ clientId: 'cert-client' }),
    );
    const b = broker(store, keys, user(), async () => answer);
    expect(await (await b.getProvider(D)).prepare()).toEqual({ ok: true });
    await b.flush();

    expect(held()?.issuedBy).toBe(`${endpoint.url}?client_id=secret-client`);
    expect(keys.getClientCertificate).not.toHaveBeenCalled();
  });
});
