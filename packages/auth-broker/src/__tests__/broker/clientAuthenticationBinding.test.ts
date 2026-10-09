/**
 * The session binding of a destination whose client authenticates through the
 * consumer's strategy: `issuedBy` is the row's record, naming the client
 * identity — the secret client when the key store has one, else the
 * certificate client's `uaaUrl` and `clientId` — and, when the build read the
 * certificate client, its `certUrl`, with its public certificate in the trust
 * digest; never the PEM itself, never the key. A token stored for one client
 * identity seeds a broker built later for the same one, and no other (Review
 * Focus 2).
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
import { uaaRecord } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'X509';
const REDIRECT = 'http://localhost/callback';
const FOR = 'https://abap.example.com:443?sap-client=100';
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';
const CERTIFICATE_PEM =
  '-----BEGIN CERTIFICATE-----\nnot-read\n-----END CERTIFICATE-----';
const KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nnot-read\n-----END PRIVATE KEY-----';

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
    certificate: CERTIFICATE_PEM,
    key: KEY_PEM,
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

/** The record of the `authorization_code` row for the certificate client. */
const certRecord = (
  uaaUrl: string,
  clientId = 'cert-client',
  certUrl = 'https://cert.example.com',
) =>
  uaaRecord('authorization_code', uaaUrl, clientId, {
    certUrl,
    certificate: CERTIFICATE_PEM,
  });

/** The record of the `authorization_code` row for the secret client. */
const secretRecord = () =>
  uaaRecord('authorization_code', endpoint.url, 'secret-client');

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
  stated: IConnectionConfig = means,
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
    ...STATED,
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
  it('stores its tokens with the record of its issuer, client and certUrl — never the PEM, never the key', async () => {
    const { store, held } = sessions();
    await loggedIn(store);

    expect(held()).toEqual({
      authorizationToken: endpoint.issued[0],
      refreshToken: 'refresh-1',
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: certRecord(endpoint.url),
    });
    expect(JSON.stringify(held())).not.toContain('BEGIN');
    expect(JSON.stringify(held())).not.toContain('not-read');
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
      certRecord(endpoint.url, 'another-cert-client'),
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
    expect(held()?.issuedBy).toBe(certRecord(other.url));
  });

  it.each([
    ['certUrl', { certUrl: 'https://cert.example.com/' }],
    [
      'the certificate',
      {
        certificate:
          '-----BEGIN CERTIFICATE-----\nanother\n-----END CERTIFICATE-----',
      },
    ],
  ] as [string, Partial<IClientCertificate>][])(
    'is refused after %s changes, the client unchanged: a fresh login, the old refresh token not spent',
    async (_label, change) => {
      const { store } = sessions();
      await loggedIn(store);

      const login = user();
      const again = broker(
        store,
        keyStore(null, certificate(change)),
        login,
        certificateStrategy,
      );
      const provider = await again.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(login.asked).toBe(1);
      expect(JSON.stringify(endpoint.requests)).not.toContain('refresh-1');
    },
  );
});

describe('a certificate destination stating no resource (Ruling 14)', () => {
  // A service URL with no canonical form binds no resource: the session is
  // stored without `issuedFor`, and the issuer and client alone decide.
  const unstated: IConnectionConfig = { ...means, serviceUrl: '<SERVICE_URL>' };

  async function storedFor(store: ISessionStore, stated: IConnectionConfig) {
    const first = broker(
      store,
      keyStore(null, certificate(), stated),
      user(),
      certificateStrategy,
    );
    const provider = await first.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await first.flush();
  }

  async function againFor(
    store: ISessionStore,
    stated: IConnectionConfig,
    cert: IClientCertificate = certificate(),
  ) {
    const login = user();
    const again = broker(
      store,
      keyStore(null, cert, stated),
      login,
      certificateStrategy,
    );
    const provider = await again.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    return { login, provider };
  }

  it('the same client: the stored token is reused — no login, no request', async () => {
    const { store, held } = sessions();
    await storedFor(store, unstated);
    // Written as '' — no resource — never left to the merge.
    expect(held()?.issuedFor).toBe('');
    const stored = held()?.authorizationToken;
    const requests = endpoint.requests.length;

    const { login, provider } = await againFor(store, unstated);
    expect(await bearer(provider)).toBe(stored);
    expect(login.asked).toBe(0);
    expect(endpoint.requests).toHaveLength(requests);
  });

  it('another client: a fresh login', async () => {
    const { store } = sessions();
    await storedFor(store, unstated);
    const { login } = await againFor(
      store,
      unstated,
      certificate({ clientId: 'another-cert-client' }),
    );
    expect(login.asked).toBe(1);
  });

  it('stored with no resource, a destination stating one: a fresh login', async () => {
    const { store } = sessions();
    await storedFor(store, unstated);
    const { login } = await againFor(store, means);
    expect(login.asked).toBe(1);
  });

  it('stored with a resource, a destination stating none: a fresh login', async () => {
    const { store } = sessions();
    await storedFor(store, means);
    const { login } = await againFor(store, unstated);
    expect(login.asked).toBe(1);
  });

  it('without a strategy (4.0.0) a resource neither side states binds nothing: a fresh login', async () => {
    const { store, held } = sessions();
    const keys = () => keyStore(secretClient(), null, unstated);
    const first = broker(store, keys(), user());
    expect(await (await first.getProvider(D)).prepare()).toEqual({ ok: true });
    await first.flush();
    expect(held()?.issuedFor).toBe('');
    expect(held()?.issuedBy).toBe(secretRecord());

    const login = user();
    const again = broker(store, keys(), login);
    expect(await (await again.getProvider(D)).prepare()).toEqual({ ok: true });
    expect(login.asked).toBe(1);
  });

  describe('what the broker logs of a stored secret it does not take', () => {
    const DISCARDED = `[AuthBroker] ${D}: the stored session secret is not recorded as issued under the destination's current means; not used, the provider obtains a new one`;
    const NEVER_SEEDED = `[AuthBroker] ${D}: the destination's means do not state everything a session secret is bound to; a stored one is never used`;

    function logged() {
      const lines: [string, string][] = [];
      const at = (level: string) => (message: string) => {
        lines.push([level, message]);
      };
      return {
        lines,
        logger: {
          debug: at('debug'),
          info: at('info'),
          warn: at('warn'),
          error: at('error'),
        },
      };
    }
    const about = (lines: [string, string][]) =>
      lines.filter(([, m]) => m === DISCARDED || m === NEVER_SEEDED);

    it('with a strategy, another client: the binding can be seeded — one warn', async () => {
      const { store } = sessions();
      await storedFor(store, unstated);
      const { lines, logger } = logged();
      const again = new AuthBroker(
        {
          ...STATED,
          sessionStore: store,
          serviceKeyStore: keyStore(
            null,
            certificate({ clientId: 'another-cert-client' }),
            unstated,
          ),
          authorization: () => user().strategy,
          clientAuthentication: certificateStrategy,
        },
        logger,
      );
      expect(await (await again.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
      expect(about(lines)).toEqual([['warn', DISCARDED]]);
    });

    it('without a strategy, no resource: never seeded — the debug line, no warn', async () => {
      const { store } = sessions();
      const keys = () => keyStore(secretClient(), null, unstated);
      const first = broker(store, keys(), user());
      expect(await (await first.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
      await first.flush();
      const { lines, logger } = logged();
      const again = new AuthBroker(
        {
          ...STATED,
          sessionStore: store,
          serviceKeyStore: keys(),
          authorization: () => user().strategy,
        },
        logger,
      );
      expect(await (await again.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
      expect(about(lines)).toEqual([['debug', NEVER_SEEDED]]);
      expect(lines.filter(([level]) => level === 'warn')).toEqual([]);
    });
  });

  it('a none row stays 4.0.0: a handed-over token stored without a resource is refused', async () => {
    const { store } = sessions();
    await store.saveSession(D, {
      authorizationToken: 'handed-over',
      issuedBy: `mcp-abap-adt-binding/2;jwt/none;secret-client;${encodeURIComponent(endpoint.url)}${';'.repeat(10)}`,
    } as IConfig);
    const keys = keyStore(secretClient(), null, {
      ...unstated,
      grantType: 'none',
    });
    const handedOver = broker(store, keys, user(), certificateStrategy);
    await expect(handedOver.getProvider(D)).rejects.toThrow(
      'the credential in the session is not bound',
    );
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
    expect(held()?.issuedBy).toBe(secretRecord());
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
    expect(held()?.issuedBy).toBe(certRecord(endpoint.url));
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
    expect(held()?.issuedBy).toBe(secretRecord());
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

    expect(held()?.issuedBy).toBe(secretRecord());
    expect(keys.getClientCertificate).not.toHaveBeenCalled();
  });
});
