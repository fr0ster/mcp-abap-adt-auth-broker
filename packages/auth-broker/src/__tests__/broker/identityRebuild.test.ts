/**
 * One rule: a provider is never changed — changed means get a new one
 * (§6.2, §6.3).
 *
 * Every call of `getProvider` and of the token API re-reads what the
 * destination's provider was built from — the means, the client, the
 * certificate client the build read — and compares it, value by value, with
 * what the build read. Unchanged: the cached provider. Anything changed, by a
 * single character — an address, the row, trust, a user, a secret: a new
 * provider, which starts with nothing — no token, no refresh token, nothing
 * of the old provider and nothing of a session written under other means. A
 * provider starts from a stored session only at its first build in a broker
 * (a restart, or a first call), and only when the session's binding is
 * exactly its own, fully stated.
 *
 * The stores are in-memory stand-ins of the contract — a key store whose
 * state the test changes between calls, and a session store with the
 * contract's merge; a "restart" is a fresh broker over the same stores. The
 * providers are real, against local token endpoints and a mock SAML identity
 * provider. Expected records are assembled from the spec's grammar
 * (`helpers/bindingRecord`), never by the broker's own function. Nothing opens
 * a browser.
 */

import { createHash } from 'node:crypto';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import { type MockSamlIdp, startMockSamlIdp } from '@mcp-abap-adt/auth-mocks';
import {
  createInMemoryReplayStore,
  type IDeviceCodePresenter,
  type OidcCallbackResult,
  OidcPasswordProvider,
  type OidcPasswordProviderConfig,
  refreshStatePersistence,
  refreshThenLogin,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
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
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  AuthBroker,
  type AuthBrokerConfig,
  type ClientAuthenticationStrategy,
  fromServiceKeySecret,
  type TokenProviderFactory,
} from '../../index';
import {
  oidcRecord,
  record,
  samlBearerRecord,
  samlPureRecord,
  uaaRecord,
} from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenAnswer,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
/** The canonical `issuedFor` of SERVICE_URL with client 100. */
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
const CLIENT = 'sb-broker!t42';
const OTHER_CLIENT = 'sb-other!t7';
const SECRET = 'S3CRET-client-secret-of-37-characters';
const PASSWORD = 'S3CRET-user-password-1234567';
const REDIRECT = 'http://localhost/callback';
const R_OLD = 'R-old-must-never-come-back';

let endpoint: TokenEndpoint;
let other: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
  other = await startTokenEndpoint('other-');
});

afterEach(async () => {
  await endpoint.close();
  await other.close();
});

// ---------------------------------------------------------------------------
// The stores
// ---------------------------------------------------------------------------

/** What the key store answers; a test changes it between calls. */
interface KeyState {
  means: Record<string, unknown>;
  client: IAuthorizationConfig | null;
  certificate?: IClientCertificate | null;
}

/** A key store answering a fresh copy of `state` on every read, as a file store does. */
function keyStore(state: KeyState): jest.Mocked<IServiceKeyStore> {
  const copy = <T>(value: T): T =>
    value === null ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getConnectionConfig: jest.fn(
      async (_d: string) => copy(state.means) as IConnectionConfig,
    ),
    getAuthorizationConfig: jest.fn(async (_d: string) => copy(state.client)),
    getClientCertificate: jest.fn(async (_d: string) =>
      copy(state.certificate ?? null),
    ),
  };
}

/**
 * A session store with the contract's merge and nothing more: a field given
 * sets it, `''` clears it, absent keeps it. Every write it is given is
 * recorded; a restart reads the same state.
 */
function sessionStore(initial: IConfig | null = null): {
  store: ISessionStore;
  held: () => Record<string, unknown> | null;
  writes: IConfig[];
  seed: (session: IConfig) => void;
} {
  let session: Record<string, unknown> | null = initial ? { ...initial } : null;
  const writes: IConfig[] = [];
  return {
    held: () => (session ? { ...session } : null),
    writes,
    seed: (s) => {
      session = { ...s };
    },
    store: {
      loadSession: async () => (session ? ({ ...session } as IConfig) : null),
      saveSession: async (_d, config) => {
        writes.push({ ...(config as IConfig) });
        const next: Record<string, unknown> = { ...(session ?? {}) };
        for (const [field, value] of Object.entries(config as object)) {
          if (value === undefined) continue;
          if (value === '') delete next[field];
          else next[field] = value;
        }
        session = next;
      },
      getAuthorizationConfig: async () => null,
      // As auth-stores' session stores answer: the secret without its
      // refresh token, `null` while none is held.
      getConnectionConfig: async () => connectionOf(session),
      setAuthorizationConfig: async () => {},
      setConnectionConfig: async () => {},
    },
  };
}

/** A session store's connection answer: the session without its refresh token. */
function connectionOf(
  session: Record<string, unknown> | null,
): IConnectionConfig | null {
  if (!session) return null;
  const { refreshToken: _refresh, ...connection } = session;
  return Object.keys(connection).length > 0
    ? (connection as IConnectionConfig)
    : null;
}

function recordingLogger(): ILogger & { lines: () => string } {
  const calls: unknown[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push([level, ...args]);
    };
  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
    lines: () => JSON.stringify(calls),
  };
}

// ---------------------------------------------------------------------------
// The user, as test doubles
// ---------------------------------------------------------------------------

/** A UAA login: the code, as a browser would have brought it back. */
function uaaLogin(): {
  strategy: IAuthorizationStrategy<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    strategy: {
      authorize: async (request: AuthorizationRequest) => {
        calls += 1;
        await request.buildAuthorizationUrl(REDIRECT);
        return { payload: 'the-code', redirectUri: REDIRECT };
      },
      dispose: async () => {},
    },
  };
}

/** An OIDC login: records the authorization URL and returns a code. */
function oidcLogin(): {
  strategy: IAuthorizationStrategy<OidcCallbackResult>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    strategy: {
      authorize: async (request: AuthorizationRequest) => {
        urls.push(await request.buildAuthorizationUrl(REDIRECT));
        return { payload: { code: 'the-code' }, redirectUri: REDIRECT };
      },
      dispose: async () => {},
    },
  };
}

/** A device-code presenter: the user reads the code and approves at once. */
function presenter(): { presenter: IDeviceCodePresenter; shown: () => number } {
  let shown = 0;
  return {
    shown: () => shown,
    presenter: {
      present: async () => {
        shown += 1;
      },
    },
  };
}

/** The Bearer token a provider presents, or `undefined` when it presents none. */
async function bearer(provider: IAuthProvider): Promise<string | undefined> {
  let presented: string | undefined;
  const target: IRequestTarget = {
    header: (name, value) => {
      if (name === 'Authorization') presented = value.slice('Bearer '.length);
    },
    cookies: () => {},
  };
  await provider.authorize(target);
  return presented;
}

/** The cookies a provider presents, or `undefined` when it presents none. */
async function cookiesOf(provider: IAuthProvider): Promise<string | undefined> {
  let presented: string | undefined;
  const target: IRequestTarget = {
    header: () => {},
    cookies: (value) => {
      presented = value;
    },
  };
  await provider.authorize(target);
  return presented;
}

/** A token answer without a refresh token. */
function tokenOnly(jti: string): TokenAnswer & { token: string } {
  const token = jwtExpiringIn(3600, { jti });
  return {
    token,
    status: 200,
    body: { access_token: token, token_type: 'bearer', expires_in: 3600 },
  };
}

/** Nothing any token request either endpoint received holds `value`. */
function sentNowhere(value: string): void {
  expect(JSON.stringify(endpoint.requests)).not.toContain(value);
  expect(JSON.stringify(other.requests)).not.toContain(value);
}

// ---------------------------------------------------------------------------
// The brokers
// ---------------------------------------------------------------------------

interface Harness {
  state: KeyState;
  sessions: ReturnType<typeof sessionStore>;
  login: ReturnType<typeof uaaLogin>;
  oidc: ReturnType<typeof oidcLogin>;
  device: ReturnType<typeof presenter>;
  logger: ReturnType<typeof recordingLogger>;
  /** A broker over the harness's stores: a second call is a restart. */
  broker: (extra?: Partial<AuthBrokerConfig>) => AuthBroker;
}

function harness(
  means: Record<string, unknown>,
  client: IAuthorizationConfig | null,
  session: IConfig | null = null,
): Harness {
  const state: KeyState = { means, client };
  const sessions = sessionStore(session);
  const login = uaaLogin();
  const oidc = oidcLogin();
  const device = presenter();
  const logger = recordingLogger();
  return {
    state,
    sessions,
    login,
    oidc,
    device,
    logger,
    broker: (extra = {}) =>
      new AuthBroker(
        {
          ...STATED,
          sessionStore: sessions.store,
          serviceKeyStore: keyStore(state),
          authorization: () => login.strategy,
          oidcAuthorization: () => oidc.strategy,
          deviceCodePresenter: () => device.presenter,
          ...extra,
        },
        logger,
      ),
  };
}

function uaaMeans(
  grant: 'authorization_code' | 'client_credentials' = 'authorization_code',
): Record<string, unknown> {
  return {
    authType: 'jwt',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
  };
}

function uaaClient(url = endpoint.url, id = CLIENT): IAuthorizationConfig {
  return { uaaUrl: url, uaaClientId: id, uaaClientSecret: SECRET };
}

// ---------------------------------------------------------------------------
// Binding across cached providers
// ---------------------------------------------------------------------------

describe('binding across cached providers: each field the build read, changed between two calls', () => {
  const changes: [string, (h: Harness) => void][] = [
    [
      'serviceUrl',
      (h) => {
        h.state.means.serviceUrl = 'https://other.example.com/sap/bc/adt';
      },
    ],
    [
      'sapClient',
      (h) => {
        h.state.means.sapClient = '200';
      },
    ],
    [
      'uaaUrl',
      (h) => {
        h.state.client = uaaClient(other.url);
      },
    ],
    [
      'client id',
      (h) => {
        h.state.client = uaaClient(endpoint.url, OTHER_CLIENT);
      },
    ],
    [
      'grantType',
      (h) => {
        h.state.means.grantType = 'client_credentials';
      },
    ],
  ];

  it.each(changes)(
    'getProvider: %s changed → a new instance, not seeded from the session bound to the old means; unchanged → the same instance',
    async (_field, change) => {
      const h = harness(uaaMeans(), uaaClient());
      const b = h.broker();
      const first = await b.getProvider(D);
      // Unchanged: the very instance.
      expect(await b.getProvider(D)).toBe(first);
      const t1 = await bearer(first);
      expect(t1).toBe(endpoint.issued[0]);
      expect(h.sessions.held()?.refreshToken).toBe('refresh-1');
      const before = endpoint.requests.length;

      change(h);
      const second = await b.getProvider(D);

      expect(second).not.toBe(first);
      expect(await b.getProvider(D)).toBe(second);
      const t2 = await bearer(second);
      expect(t2).toBeDefined();
      expect(t2).not.toBe(t1);
      // Not seeded: neither the stored token presented nor its refresh
      // token sent, to either server.
      expect(JSON.stringify(endpoint.requests.slice(before))).not.toContain(
        'refresh-1',
      );
      expect(JSON.stringify(other.requests)).not.toContain('refresh-1');
      expect(
        [...endpoint.requests.slice(before), ...other.requests].map(
          (r) => r.grantType,
        ),
      ).toEqual([
        h.state.means.grantType === 'client_credentials'
          ? 'client_credentials'
          : 'authorization_code',
      ]);
    },
  );

  /** A consumer's provider: hands out `<label>-<n>` and records each call. */
  function consumerProvider(label: string): IRefreshableTokenProvider & {
    calls: number;
  } {
    const provider = {
      calls: 0,
      getTokens: async (): Promise<ITokenResult> => {
        provider.calls += 1;
        return {
          authorizationToken: `${label}-${provider.calls}`,
          authType: 'authorization_code',
          expiresIn: 3600,
        };
      },
      refreshTokens: async (): Promise<ITokenResult> => provider.getTokens(),
    };
    return provider;
  }

  it.each(changes)(
    'the consumer factory: %s changed → called again, and the new provider answers; unchanged → not called again',
    async (_field, change) => {
      const h = harness(uaaMeans(), uaaClient());
      const built: string[] = [];
      const factory: TokenProviderFactory = jest.fn(() => {
        const label = `built-${built.length + 1}`;
        built.push(label);
        return consumerProvider(label);
      });
      const b = h.broker({ provider: factory });

      await expect(b.getToken(D)).resolves.toBe('built-1-1');
      await expect(b.getToken(D)).resolves.toBe('built-1-2');
      expect(factory).toHaveBeenCalledTimes(1);

      change(h);
      await expect(b.getToken(D)).resolves.toBe('built-2-1');
      await expect(b.getToken(D)).resolves.toBe('built-2-2');
      expect(factory).toHaveBeenCalledTimes(2);
    },
  );

  const instanceReads = changes.filter(([field]) =>
    ['serviceUrl', 'sapClient', 'grantType'].includes(field),
  );

  it.each(instanceReads)(
    'the consumer instance: %s changed → the token API refuses the destination naming provider, until a new broker',
    async (_field, change) => {
      const h = harness(uaaMeans(), uaaClient());
      const instance = consumerProvider('instance');
      const b = h.broker({ provider: instance });
      await expect(b.getToken(D)).resolves.toBe('instance-1');

      change(h);
      const refused = expect(b.getToken(D)).rejects.toMatchObject({
        name: 'DestinationConfigError',
        destination: D,
        missingFields: ['provider'],
      });
      await refused;
      await expect(b.refreshToken(D)).rejects.toMatchObject({
        missingFields: ['provider'],
      });
      expect(instance.calls).toBe(1);

      // A new broker takes the instance into use for the means it now has.
      await expect(h.broker({ provider: instance }).getToken(D)).resolves.toBe(
        'instance-2',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// A changed grant
// ---------------------------------------------------------------------------

describe('a changed grant with the same resource, issuer and client', () => {
  async function userLoggedIn(): Promise<{ h: Harness; tu: string }> {
    const h = harness(uaaMeans('authorization_code'), uaaClient());
    const tu = await h.broker().getToken(D);
    expect(h.sessions.held()).toEqual({
      authorizationToken: tu,
      expiresAt: expect.any(Number),
      refreshToken: 'refresh-1',
      issuedFor: FOR,
      issuedBy: uaaRecord('authorization_code', endpoint.url, CLIENT),
    });
    return { h, tu };
  }

  function expectApplicationToken(h: Harness, tu: string, token: string) {
    expect(token).not.toBe(tu);
    expect(endpoint.requests.at(-1)?.grantType).toBe('client_credentials');
    expect(JSON.stringify(endpoint.requests.slice(1))).not.toContain(
      'refresh-1',
    );
    expect(JSON.stringify(endpoint.requests.slice(1))).not.toContain(tu);
    expect(h.sessions.held()).toEqual({
      authorizationToken: token,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: uaaRecord('client_credentials', endpoint.url, CLIENT),
    });
  }

  it('authorization_code → client_credentials within one broker: the user’s token and refresh token are never used', async () => {
    const h = harness(uaaMeans('authorization_code'), uaaClient());
    const b = h.broker();
    const tu = await b.getToken(D);

    h.state.means.grantType = 'client_credentials';
    const token = await b.getToken(D);

    expectApplicationToken(h, tu, token);
  });

  it('authorization_code → client_credentials after a restart: the same', async () => {
    const { h, tu } = await userLoggedIn();
    h.state.means.grantType = 'client_credentials';

    const token = await h.broker().getToken(D);

    expectApplicationToken(h, tu, token);
  });

  it.each(['within one broker', 'after a restart'])(
    'client_credentials → authorization_code %s: the application token is not seeded — the first renewal logs in',
    async (when) => {
      const h = harness(uaaMeans('client_credentials'), uaaClient());
      const first = h.broker();
      const app = await first.getToken(D);
      h.state.means.grantType = 'authorization_code';

      const b = when === 'after a restart' ? h.broker() : first;
      const provider = await b.getProvider(D);
      const presented = await bearer(provider);

      expect(h.login.calls()).toBe(1);
      expect(presented).not.toBe(app);
      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'client_credentials',
        'authorization_code',
      ]);
      expect(h.sessions.held()?.issuedBy).toBe(
        uaaRecord('authorization_code', endpoint.url, CLIENT),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// OIDC without an issuer: client and endpoint switches
// ---------------------------------------------------------------------------

describe.each(['password', 'device_code'] as const)(
  'an issuer-less OIDC %s destination: client switch and endpoint switch',
  (grant) => {
    function issuerless(): Harness {
      return harness(
        {
          authType: 'jwt',
          grantType: grant,
          serviceUrl: SERVICE_URL,
          sapClient: '100',
          oidcTokenEndpoint: `${endpoint.url}/oauth/token`,
          ...(grant === 'device_code'
            ? { oidcDeviceAuthorizationEndpoint: `${endpoint.url}/device` }
            : { username: 'alice', password: PASSWORD }),
        },
        { uaaUrl: '', uaaClientId: 'client-a', uaaClientSecret: SECRET },
      );
    }

    const switches: [string, (h: Harness) => void][] = [
      [
        'the client id',
        (h) => {
          h.state.client = {
            uaaUrl: '',
            uaaClientId: 'client-b',
            uaaClientSecret: SECRET,
          };
        },
      ],
      [
        'the token endpoint',
        (h) => {
          h.state.means.oidcTokenEndpoint = `${other.url}/oauth/token`;
        },
      ],
    ];

    describe.each(['within one broker', 'after a restart'])('%s', (when) => {
      it.each(switches)(
        '%s switched: T_A is presented nowhere and R_A reaches no token endpoint',
        async (_label, change) => {
          const h = issuerless();
          const first = h.broker();
          const ta = await first.getToken(D);
          expect(h.sessions.held()?.refreshToken).toBe('refresh-1');

          change(h);
          const b = when === 'after a restart' ? h.broker() : first;
          const provider = await b.getProvider(D);
          const presented = await bearer(provider);

          expect(presented).toBeDefined();
          expect(presented).not.toBe(ta);
          sentNowhere('refresh-1');
          expect(
            [...endpoint.requests, ...other.requests].filter(
              (r) => r.grantType === 'refresh_token',
            ),
          ).toEqual([]);
        },
      );
    });

    it('after a restart with the exact same means: seeded — T_A is presented, and its first renewal sends R_A to E1', async () => {
      const h = issuerless();
      const ta = await h.broker().getToken(D);
      const requests = endpoint.requests.length;

      const b = h.broker();
      const provider = await b.getProvider(D);
      expect(await bearer(provider)).toBe(ta);
      expect(endpoint.requests).toHaveLength(requests);

      await b.refreshToken(D);
      const renewal = endpoint.requests.at(-1);
      expect(renewal?.grantType).toBe('refresh_token');
      expect(renewal?.params.refresh_token).toBe('refresh-1');
      expect(other.requests).toEqual([]);
    });
  },
);

// ---------------------------------------------------------------------------
// Rows that are not fully stated
// ---------------------------------------------------------------------------

describe('a row that is not fully stated is never seeded', () => {
  it('saml2_pure without samlAcsUrl: after a restart with unchanged means the stored cookies are presented nowhere; the login is asked', async () => {
    const means = {
      authType: 'saml',
      grantType: 'saml2_pure',
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      samlIdpSsoUrl: 'https://idp.example.com/sso',
      samlIdpEntityId: 'urn:test:idp',
      samlIdpCertificates: [CERT_PEM],
      samlSpEntityId: 'urn:test:sp',
    };
    const h = harness(means, null, {
      sessionCookies: 'MYSAPSSO2=stored-must-not-be-presented',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: samlPureRecord(means),
    });
    let asked = 0;
    const b = h.broker({
      authorization: () => ({
        authorize: async () => {
          asked += 1;
          throw new Error('the user closed the window');
        },
        dispose: async () => {},
      }),
      samlCookies: () => async () => 'never',
      assertionReplayStore: () => createInMemoryReplayStore(),
    });

    const provider = await b.getProvider(D);
    expect(await cookiesOf(provider)).toBeUndefined();
    expect(asked).toBe(1);
  });

  it('the consumer instance and the consumer factory: after a restart the stored token and refresh token reach neither; the result’s own state is written', async () => {
    const h = harness(uaaMeans(), uaaClient(), {
      authorizationToken: 'stored-token-must-not-be-handed',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: record(
        'provider/jwt/authorization_code',
        { clientId: CLIENT, uaaUrl: endpoint.url },
        '',
      ),
    });
    const handed: unknown[][] = [];
    const factory: TokenProviderFactory = (...args) => {
      handed.push(args);
      return {
        getTokens: async () => ({
          authorizationToken: 'factory-token',
          authType: 'authorization_code',
          expiresIn: 3600,
        }),
        refreshTokens: async () => {
          throw new Error('not asked');
        },
      };
    };

    await expect(h.broker({ provider: factory }).getToken(D)).resolves.toBe(
      'factory-token',
    );
    expect(JSON.stringify(handed)).not.toContain(R_OLD);
    expect(JSON.stringify(handed)).not.toContain('stored-token');
    expect(h.sessions.held()?.refreshToken).toBeUndefined();

    h.sessions.seed({
      ...(h.sessions.held() as IConfig),
      refreshToken: R_OLD,
      issuedBy: record('provider/jwt/authorization_code', {}, ''),
    });
    const instance: IRefreshableTokenProvider = {
      getTokens: async () => ({
        authorizationToken: 'instance-token',
        authType: 'authorization_code',
        expiresIn: 3600,
      }),
      refreshTokens: async () => {
        throw new Error('not asked');
      },
    };
    await expect(h.broker({ provider: instance }).getToken(D)).resolves.toBe(
      'instance-token',
    );
    expect(h.sessions.held()?.refreshToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// An issuer-bearing OIDC row: endpoint switches
// ---------------------------------------------------------------------------

describe('an issuer-bearing OIDC row: an endpoint switch, by any character', () => {
  type Switch = {
    label: string;
    grant: 'password' | 'oidc_authorization_code' | 'device_code';
    field: string;
    from: () => string;
    to: () => string;
  };
  const switches: Switch[] = [
    {
      label: 'password: the token endpoint',
      grant: 'password',
      field: 'oidcTokenEndpoint',
      from: () => `${endpoint.url}/oauth/token/e1`,
      to: () => `${endpoint.url}/oauth/token/e2`,
    },
    {
      label: 'oidc_authorization_code: the token endpoint',
      grant: 'oidc_authorization_code',
      field: 'oidcTokenEndpoint',
      from: () => `${endpoint.url}/oauth/token/e1`,
      to: () => `${endpoint.url}/oauth/token/e2`,
    },
    {
      label: 'oidc_authorization_code: the authorization endpoint',
      grant: 'oidc_authorization_code',
      field: 'oidcAuthorizationEndpoint',
      from: () => `${endpoint.url}/authorize`,
      to: () => `${endpoint.url}/authorize2`,
    },
    {
      label: 'device_code: the device authorization endpoint',
      grant: 'device_code',
      field: 'oidcDeviceAuthorizationEndpoint',
      from: () => `${endpoint.url}/device`,
      to: () => `${other.url}/device`,
    },
    {
      label:
        'password: a trailing slash on the token endpoint, served by another handler',
      grant: 'password',
      field: 'oidcTokenEndpoint',
      from: () => `${endpoint.url}/oauth/token`,
      to: () => `${endpoint.url}/oauth/token/`,
    },
  ];

  function issuerBearing(s: Switch): Harness {
    return harness(
      {
        authType: 'jwt',
        grantType: s.grant,
        serviceUrl: SERVICE_URL,
        sapClient: '100',
        oidcIssuerUrl: endpoint.url,
        oidcTokenEndpoint: `${endpoint.url}/oauth/token`,
        ...(s.grant === 'password'
          ? { username: 'alice', password: PASSWORD }
          : {}),
        [s.field]: s.from(),
      },
      { uaaUrl: '', uaaClientId: 'oidc-client', uaaClientSecret: SECRET },
    );
  }

  describe.each(['within one broker', 'after a restart'])('%s', (when) => {
    it.each(switches.map((s) => [s.label, s] as const))(
      '%s: T1 presented nowhere, R1 sent to neither endpoint, the new record stored without R1',
      async (_label, s) => {
        const h = issuerBearing(s);
        const first = h.broker();
        const t1 = await first.getToken(D);
        const paths = endpoint.paths.length;

        h.state.means[s.field] = s.to();
        const b = when === 'after a restart' ? h.broker() : first;
        const provider = await b.getProvider(D);
        const presented = await bearer(provider);

        expect(presented).toBeDefined();
        expect(presented).not.toBe(t1);
        sentNowhere('refresh-1');
        if (s.field === 'oidcTokenEndpoint') {
          const path = new URL(s.to()).pathname;
          expect(endpoint.paths.slice(paths)).toEqual([path]);
        }
        const held = h.sessions.held();
        expect(held?.authorizationToken).toBe(presented);
        expect(held?.refreshToken).not.toBe('refresh-1');
        expect(held?.issuedBy).toBe(
          oidcRecord(
            s.grant,
            {
              oidcIssuerUrl: endpoint.url,
              oidcTokenEndpoint: h.state.means.oidcTokenEndpoint as string,
              oidcAuthorizationEndpoint: h.state.means
                .oidcAuthorizationEndpoint as string | undefined,
              oidcDeviceAuthorizationEndpoint: h.state.means
                .oidcDeviceAuthorizationEndpoint as string | undefined,
              ...(s.grant === 'password' ? { username: 'alice' } : {}),
            },
            'oidc-client',
          ),
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// A user, a secret, a client
// ---------------------------------------------------------------------------

function passwordMeans(): Record<string, unknown> {
  return {
    authType: 'jwt',
    grantType: 'password',
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    oidcIssuerUrl: endpoint.url,
    username: 'alice',
    password: PASSWORD,
  };
}

const oidcClient = (id = 'oidc-client'): IAuthorizationConfig => ({
  uaaUrl: '',
  uaaClientId: id,
  uaaClientSecret: SECRET,
});

describe('another user, a changed secret, another client', () => {
  it.each(['within one broker', 'after a restart'])(
    'another user (password, username changed) %s: the old user’s token and refresh token are never presented or sent',
    async (when) => {
      const h = harness(passwordMeans(), oidcClient());
      const first = h.broker();
      const alice = await first.getToken(D);

      h.state.means.username = 'bob';
      const b = when === 'after a restart' ? h.broker() : first;
      const presented = await bearer(await b.getProvider(D));

      expect(presented).not.toBe(alice);
      sentNowhere('refresh-1');
      expect(endpoint.requests.at(-1)?.params.username).toBe('bob');
    },
  );

  /** Every trace of `secret` a file or a log line could hold. */
  function traces(secret: string): string[] {
    const hashes = ['sha256', 'sha1', 'md5'].flatMap((algorithm) => [
      createHash(algorithm).update(secret).digest('hex'),
      createHash(algorithm).update(secret).digest('base64'),
    ]);
    return [secret, Buffer.from(secret).toString('base64'), ...hashes];
  }

  it.each([
    [
      'the password of a password row',
      () => harness(passwordMeans(), oidcClient()),
      (h: Harness) => {
        h.state.means.password = `${PASSWORD}-new`;
      },
      () => [PASSWORD, `${PASSWORD}-new`],
    ],
    [
      'the client secret of a UAA row',
      () => harness(uaaMeans(), uaaClient()),
      (h: Harness) => {
        h.state.client = { ...uaaClient(), uaaClientSecret: `${SECRET}-new` };
      },
      () => [SECRET, `${SECRET}-new`],
    ],
  ] as const)(
    'a secret changed — %s: within one process a new provider that starts with nothing; no trace of either secret in the session or a log line',
    async (_label, make, change, secrets) => {
      const h = make();
      const b = h.broker();
      const provider = await b.getProvider(D);
      const t1 = await bearer(provider);
      const record = h.sessions.held()?.issuedBy;

      change(h);
      const replaced = await b.getProvider(D);
      expect(replaced).not.toBe(provider);
      const t2 = await bearer(replaced);

      expect(t2).not.toBe(t1);
      sentNowhere('refresh-1');
      // The record does not hold a secret: the same one, yet not seeded.
      expect(h.sessions.held()?.issuedBy).toBe(record);
      const written = JSON.stringify([h.sessions.writes, h.sessions.held()]);
      const logged = h.logger.lines();
      for (const secret of secrets()) {
        for (const trace of traces(secret)) {
          expect(written).not.toContain(trace);
          expect(logged).not.toContain(trace);
        }
        // Nor its length, as a value of any field.
        expect(logged).not.toContain(`:${secret.length}`);
        expect(written).not.toContain(`:${secret.length}`);
      }
    },
  );

  it.each([
    [
      'a UAA row: another client id with the same uaaUrl',
      () => harness(uaaMeans(), uaaClient()),
      (h: Harness) => {
        h.state.client = uaaClient(endpoint.url, OTHER_CLIENT);
      },
    ],
    [
      'an OIDC row: another client id with the same oidcIssuerUrl',
      () => harness(passwordMeans(), oidcClient()),
      (h: Harness) => {
        h.state.client = oidcClient('oidc-other');
      },
    ],
  ] as const)(
    'a client switch keeps 4.x’s strength — %s: not seeded, within one process and after a restart',
    async (_label, make, change) => {
      for (const when of ['within one broker', 'after a restart']) {
        const h = make();
        const first = h.broker();
        const t1 = await first.getToken(D);
        change(h);
        const b = when === 'after a restart' ? h.broker() : first;
        expect(await bearer(await b.getProvider(D))).not.toBe(t1);
        sentNowhere('refresh-1');
        await endpoint.close();
        endpoint = await startTokenEndpoint();
      }
    },
  );

  it('token_exchange never seeds: after a restart with unchanged means it requests a fresh token; the stored one is presented nowhere', async () => {
    const h = harness(
      {
        authType: 'jwt',
        grantType: 'token_exchange',
        serviceUrl: SERVICE_URL,
        sapClient: '100',
        oidcIssuerUrl: endpoint.url,
        oidcSubjectToken: 'S3CRET-subject-token',
        oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      },
      oidcClient(),
    );
    const t1 = await h.broker().getToken(D);

    const presented = await bearer(await h.broker().getProvider(D));

    expect(presented).not.toBe(t1);
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'urn:ietf:params:oauth:grant-type:token-exchange',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]);
    sentNowhere('refresh-1');
  });

  it('a certificate client’s certUrl switch on the clientAuthentication strategy path: not seeded, within one process and after a restart', async () => {
    // A strategy that reads the certificate client — so the build records
    // it — and authenticates with the secret, over plain HTTP.
    const strategy: ClientAuthenticationStrategy = async (context) => {
      await context.readCertificate();
      return fromServiceKeySecret({ encoding: 'form' })(context);
    };
    for (const when of ['within one broker', 'after a restart']) {
      const h = harness(uaaMeans(), uaaClient());
      h.state.certificate = {
        uaaUrl: endpoint.url,
        clientId: CLIENT,
        certificate: CERT_PEM,
        key: 'KEY-never-read-by-the-record',
        certUrl: 'https://cert-1.example.com',
      };
      const first = h.broker({ clientAuthentication: strategy });
      const t1 = await first.getToken(D);
      expect(h.sessions.held()?.issuedBy).toBe(
        uaaRecord('authorization_code', endpoint.url, CLIENT, {
          certUrl: 'https://cert-1.example.com',
          certificate: CERT_PEM,
        }),
      );

      h.state.certificate = {
        ...h.state.certificate,
        certUrl: 'https://cert-2.example.com',
      };
      const b =
        when === 'after a restart'
          ? h.broker({ clientAuthentication: strategy })
          : first;
      expect(await bearer(await b.getProvider(D))).not.toBe(t1);
      sentNowhere('refresh-1');
      await endpoint.close();
      endpoint = await startTokenEndpoint();
    }
  });
});

// ---------------------------------------------------------------------------
// SAML: an IdP switch, a token URL switch, trust
// ---------------------------------------------------------------------------

const IDP_ENTITY = 'urn:test:idp';
const SP_ENTITY = 'urn:test:sp';
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';
const FORM_FIELD = 'name="SAMLResponse" value="';

let idp1: MockSamlIdp;
let idp2: MockSamlIdp;
let bearerIdp1: MockSamlIdp;
let bearerIdp2: MockSamlIdp;
/** Any well-formed certificate, for rows whose IdP is never reached. */
let CERT_PEM: string;

beforeAll(async () => {
  const pure = { issuer: IDP_ENTITY, audience: SP_ENTITY, acsUrls: [ACS] };
  idp1 = await startMockSamlIdp({ ...pure, signWhat: 'response' });
  idp2 = await startMockSamlIdp({ ...pure, signWhat: 'response' });
  bearerIdp1 = await startMockSamlIdp({ ...pure, signWhat: 'assertion' });
  bearerIdp2 = await startMockSamlIdp({ ...pure, signWhat: 'assertion' });
  CERT_PEM = idp1.certificatePem;
});

afterAll(async () => {
  for (const idp of [idp1, idp2, bearerIdp1, bearerIdp2]) await idp.close();
});

/**
 * A SAML login that plays the browser at the IdP `via()` names — the
 * AuthnRequest's query sent to that IdP's `/sso` — and takes the SAMLResponse
 * out of the form it answers with.
 */
function samlLogin(via: () => MockSamlIdp): {
  strategy: IAuthorizationStrategy<string>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    strategy: {
      authorize: async (request: AuthorizationRequest) => {
        const url = new URL(await request.buildAuthorizationUrl(ACS));
        urls.push(url.toString());
        const html = await (
          await fetch(`${via().url}/sso${url.search}`)
        ).text();
        const start = html.indexOf(FORM_FIELD);
        const end = html.indexOf('"', start + FORM_FIELD.length);
        if (start < 0 || end < 0) throw new Error('no SAMLResponse');
        return {
          payload: html.slice(start + FORM_FIELD.length, end),
          redirectUri: ACS,
        };
      },
      dispose: async () => {},
    },
  };
}

function samlHarness(
  grant: 'saml2_pure' | 'saml2_bearer',
  certificates: string[],
  extra: Record<string, unknown> = {},
): Harness & {
  via: { idp: MockSamlIdp };
  saml: ReturnType<typeof samlLogin>;
  samlBroker: () => AuthBroker;
} {
  const via = {
    idp: grant === 'saml2_pure' ? idp1 : bearerIdp1,
  };
  const h = harness(
    {
      authType: 'saml',
      grantType: grant,
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      samlIdpSsoUrl: `${via.idp.url}/sso`,
      samlIdpEntityId: IDP_ENTITY,
      samlIdpCertificates: certificates,
      samlSpEntityId: SP_ENTITY,
      samlAcsUrl: ACS,
      ...extra,
    },
    grant === 'saml2_bearer' ? uaaClient() : null,
  );
  const saml = samlLogin(() => via.idp);
  let cookies = 0;
  const replay = createInMemoryReplayStore();
  return {
    ...h,
    via,
    saml,
    samlBroker: () =>
      h.broker({
        authorization: () => saml.strategy,
        samlCookies: () => async () => {
          cookies += 1;
          return `MYSAPSSO2=cookies-${cookies}`;
        },
        assertionReplayStore: () => replay,
      }),
  };
}

/** What a provider presents: the Bearer token, or the cookies. */
async function presentedBy(
  grant: 'saml2_pure' | 'saml2_bearer',
  provider: IAuthProvider,
): Promise<string | undefined> {
  return grant === 'saml2_pure' ? cookiesOf(provider) : bearer(provider);
}

describe.each(['saml2_pure', 'saml2_bearer'] as const)('saml / %s', (grant) => {
  const first = () => (grant === 'saml2_pure' ? idp1 : bearerIdp1);
  const second = () => (grant === 'saml2_pure' ? idp2 : bearerIdp2);

  it('a removed signing certificate, within one broker: a new provider, not seeded; C1’s assertion refused, C2’s accepted', async () => {
    const h = samlHarness(grant, [
      first().certificatePem,
      second().certificatePem,
    ]);
    const b = h.samlBroker();
    const provider = await b.getProvider(D);
    const c1 = await presentedBy(grant, provider);
    expect(c1).toBeDefined();
    expect(h.saml.urls).toHaveLength(1);

    h.state.means.samlIdpCertificates = [second().certificatePem];
    const replaced = await b.getProvider(D);
    expect(replaced).not.toBe(provider);

    // The new login, signed by C1: refused.
    const refused = await (replaced as unknown as IRefreshableTokenProvider)
      .getTokens()
      .then(
        () => undefined,
        (error: unknown) => readFailure(error, 'unfamiliar-error'),
      );
    expect(refused?.kind).toBe('saml-assertion');
    expect(h.saml.urls).toHaveLength(2);

    // Signed by C2: accepted — and nothing old presented.
    h.via.idp = second();
    const c2 = await presentedBy(grant, replaced);
    expect(c2).toBeDefined();
    expect(c2).not.toBe(c1);
    expect(h.saml.urls).toHaveLength(3);
    sentNowhere('refresh-1');
  });

  it('a removed signing certificate, after a restart: the old session does not seed', async () => {
    const h = samlHarness(grant, [
      first().certificatePem,
      second().certificatePem,
    ]);
    const c1 = await presentedBy(grant, await h.samlBroker().getProvider(D));

    h.state.means.samlIdpCertificates = [second().certificatePem];
    h.via.idp = second();
    const restarted = await h.samlBroker().getProvider(D);
    const c2 = await presentedBy(grant, restarted);

    expect(c2).not.toBe(c1);
    expect(h.saml.urls).toHaveLength(2);
    sentNowhere('refresh-1');
  });

  it.each([
    ['another expected IdP (samlIdpEntityId)', 'samlIdpEntityId'],
    ['an IdP switch (samlIdpSsoUrl)', 'samlIdpSsoUrl'],
  ])(
    '%s, within one broker and after a restart: not seeded — the login is asked, nothing old presented or sent',
    async (_label, field) => {
      for (const when of ['within one broker', 'after a restart']) {
        const h = samlHarness(grant, [first().certificatePem]);
        const b0 = h.samlBroker();
        const old = await presentedBy(grant, await b0.getProvider(D));
        expect(h.saml.urls).toHaveLength(1);

        h.state.means[field] =
          field === 'samlIdpSsoUrl'
            ? `${second().url}/sso`
            : 'urn:test:another-idp';
        const b = when === 'after a restart' ? h.samlBroker() : b0;
        const provider = await b.getProvider(D);
        // The new login is asked whatever comes of it.
        const now = await presentedBy(grant, provider).catch(() => undefined);
        expect(now).not.toBe(old);
        expect(h.saml.urls).toHaveLength(2);
        if (field === 'samlIdpSsoUrl') {
          expect(new URL(h.saml.urls[1] as string).origin).toBe(
            new URL(second().url).origin,
          );
        }
        sentNowhere('refresh-1');
      }
    },
  );

  if (grant === 'saml2_bearer') {
    it.each(['within one broker', 'after a restart'])(
      'a samlTokenUrl switch %s: T1 is not presented and R1 never reaches S2',
      async (when) => {
        const h = samlHarness(grant, [first().certificatePem], {
          samlTokenUrl: `${endpoint.url}/oauth/token/s1`,
        });
        const b0 = h.samlBroker();
        const t1 = await b0.getToken(D);
        expect(endpoint.paths).toEqual(['/oauth/token/s1']);

        h.state.means.samlTokenUrl = `${endpoint.url}/oauth/token/s2`;
        const b = when === 'after a restart' ? h.samlBroker() : b0;
        const t2 = await bearer(await b.getProvider(D));

        expect(t2).not.toBe(t1);
        expect(endpoint.paths).toEqual(['/oauth/token/s1', '/oauth/token/s2']);
        sentNowhere('refresh-1');
        expect(h.sessions.held()?.issuedBy).toBe(
          samlBearerRecord(
            h.state.means as Parameters<typeof samlBearerRecord>[0],
            endpoint.url,
            CLIENT,
          ),
        );
      },
    );
  }
});

// ---------------------------------------------------------------------------
// A provider persists only refresh state it owns, across a rebuild
// ---------------------------------------------------------------------------

describe('a provider persists only refresh state it owns, across a rebuild', () => {
  /** The stored session a first build is seeded with: T_old and R_old, bound here. */
  function seeded(issuedBy: string): IConfig {
    return {
      authorizationToken: jwtExpiringIn(3600, { jti: 'T-old' }),
      expiresAt: Date.now() + 3_600_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy,
    };
  }

  async function replacedThenRestarted(
    h: Harness,
    b: AuthBroker,
    change: () => void,
    restart: () => AuthBroker,
  ): Promise<void> {
    // The first build is seeded with R_old.
    const provider = await b.getProvider(D);
    expect(await bearer(provider)).toBe(
      (h.sessions.held() as Record<string, unknown>).authorizationToken,
    );

    change();
    const answer = tokenOnly('token-only');
    endpoint.answerNext(answer);
    const token = await b.getToken(D);

    // The replacement started with nothing: it logged in, and its token-only
    // result wrote no refresh token — R_old is gone from the store.
    expect(token).toBe(answer.token);
    sentNowhere(R_OLD);
    expect(h.sessions.held()).toEqual({
      authorizationToken: token,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: expect.any(String),
    });
    expect(h.sessions.writes.at(-1)?.refreshToken).toBe('');

    // A restart over the same stores, the record unchanged: R_old reaches no
    // token endpoint, and with no refresh token stored the provider logs in.
    const requests = endpoint.requests.length;
    await restart().refreshToken(D);
    sentNowhere(R_OLD);
    expect(endpoint.requests.length).toBeGreaterThan(requests);
    expect(
      endpoint.requests.slice(requests).map((r) => r.grantType),
    ).not.toContain('refresh_token');
  }

  it('a UAA row whose client secret changes in-process', async () => {
    const h = harness(
      uaaMeans(),
      uaaClient(),
      seeded(uaaRecord('authorization_code', endpoint.url, CLIENT)),
    );
    await replacedThenRestarted(
      h,
      h.broker(),
      () => {
        h.state.client = { ...uaaClient(), uaaClientSecret: `${SECRET}-new` };
      },
      () => h.broker(),
    );
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'authorization_code',
      'authorization_code',
    ]);
  });

  it('an OIDC password row whose password changes in-process', async () => {
    const means = passwordMeans();
    const h = harness(
      means,
      oidcClient(),
      seeded(
        oidcRecord(
          'password',
          { oidcIssuerUrl: endpoint.url, username: 'alice' },
          'oidc-client',
        ),
      ),
    );
    await replacedThenRestarted(
      h,
      h.broker(),
      () => {
        h.state.means.password = `${PASSWORD}-new`;
      },
      () => h.broker(),
    );
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'password',
      'password',
    ]);
  });

  it('a SAML bearer row whose trust changes in-process (samlClockSkewMs)', async () => {
    const h = samlHarness('saml2_bearer', [bearerIdp1.certificatePem]);
    h.sessions.seed(
      seeded(
        samlBearerRecord(
          h.state.means as Parameters<typeof samlBearerRecord>[0],
          endpoint.url,
          CLIENT,
        ),
      ),
    );
    await replacedThenRestarted(
      h,
      h.samlBroker(),
      () => {
        h.state.means.samlClockSkewMs = 5_000;
      },
      () => h.samlBroker(),
    );
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'urn:ietf:params:oauth:grant-type:saml2-bearer',
      'urn:ietf:params:oauth:grant-type:saml2-bearer',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The consumer path is never seeded
// ---------------------------------------------------------------------------

describe('the consumer path is never seeded', () => {
  /**
   * A factory composing an OIDC password provider, as a consumer would: the
   * user and the token endpoint from its own configuration, the client from
   * what the broker hands it.
   */
  function passwordFactory(config: {
    username: string;
    tokenEndpoint: () => string;
  }): { factory: TokenProviderFactory; handed: unknown[][] } {
    const handed: unknown[][] = [];
    const factory: TokenProviderFactory = (...args) => {
      handed.push(JSON.parse(JSON.stringify(args)) as unknown[]);
      const authConfig = args[1];
      return new OidcPasswordProvider({
        tokenEndpoint: config.tokenEndpoint(),
        clientId: authConfig?.uaaClientId ?? 'oidc-client',
        clientSecret: authConfig?.uaaClientSecret,
        username: config.username,
        password: PASSWORD,
        renewal: refreshThenLogin(),
        persistence: refreshStatePersistence(async () => {}, {
          onWriteFailure: 'continue',
        }),
      } as OidcPasswordProviderConfig);
    };
    return { factory, handed };
  }

  it.each([
    ['username changed to bob', { username: 'bob', switchEndpoint: false }],
    ['the token endpoint changed', { username: 'alice', switchEndpoint: true }],
    ['nothing changed', { username: 'alice', switchEndpoint: false }],
  ] as const)(
    'after a restart — %s: the factory is handed no stored token or refresh token, its provider presents neither, Alice’s refresh token is sent nowhere',
    async (_label, after) => {
      const h = harness(uaaMeans(), oidcClient());
      const alice = passwordFactory({
        username: 'alice',
        tokenEndpoint: () => `${endpoint.url}/oauth/token`,
      });
      const ta = await h.broker({ provider: alice.factory }).getToken(D);
      expect(h.sessions.held()?.refreshToken).toBe('refresh-1');

      const next = passwordFactory({
        username: after.username,
        tokenEndpoint: () =>
          after.switchEndpoint
            ? `${other.url}/oauth/token`
            : `${endpoint.url}/oauth/token`,
      });
      const token = await h.broker({ provider: next.factory }).getToken(D);

      expect(token).not.toBe(ta);
      expect(JSON.stringify(next.handed)).not.toContain('refresh-1');
      expect(JSON.stringify(next.handed)).not.toContain(ta);
      sentNowhere('refresh-1');
      expect(
        [...endpoint.requests, ...other.requests].map((r) => r.grantType),
      ).toEqual(['password', 'password']);
    },
  );
});
