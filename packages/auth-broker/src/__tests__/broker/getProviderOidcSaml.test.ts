/**
 * getProvider for the OIDC grants — `jwt` / `oidc_authorization_code`,
 * `device_code`, `password`, `token_exchange` — and the SAML grants —
 * `saml` / `saml2_pure`, `saml2_bearer`.
 *
 * The stores are in-memory fakes of the contract; the providers are real
 * (auth-providers 5.2) against a local token endpoint, and are only ever driven
 * through `IAuthProvider`. The SAML assertions come from
 * `@mcp-abap-adt/auth-mocks`' identity provider — signed by a key of its own,
 * never by this file. Every interactive part is a test double: a strategy that
 * fetches what a browser would have been sent to, a presenter that records the
 * code, a cookie function that records the SAMLResponse. Nothing here opens a
 * browser.
 */

import {
  type MockSamlIdp,
  type SamlVariant,
  startMockSamlIdp,
} from '@mcp-abap-adt/auth-mocks';
import {
  createInMemoryReplayStore,
  type DeviceCodePrompt,
  type IDeviceCodePresenter,
  type OidcCallbackResult,
} from '@mcp-abap-adt/auth-providers';
import type {
  AssertionReplayKey,
  AuthorizationRequest,
  IAssertionReplayStore,
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
import { asContract, type WithUndefined } from '../../contractShape';
import {
  AuthBroker,
  type AuthBrokerConfig,
  DestinationConfigError,
  type StrategyGrant,
} from '../../index';
import {
  oidcRecord,
  record,
  samlBearerRecord,
  samlPureRecord,
} from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

/** Means secrets: they never reach the session, an error or a log line. */
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';
const USER_PASSWORD = 'S3CRET-password-must-not-leak';
const SUBJECT_TOKEN = 'S3CRET-subject-token-must-not-leak';
const ACTOR_TOKEN = 'S3CRET-actor-token-must-not-leak';
const SERVICE_URL = 'https://abap.example.com';
const REDIRECT = 'http://localhost/callback';
const D = 'DEST';
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

/** The resource these means name, canonical. */
const FOR = 'https://abap.example.com:443?sap-client=100';

type OidcGrant =
  | 'oidc_authorization_code'
  | 'device_code'
  | 'password'
  | 'token_exchange';
type SamlGrant = 'saml2_pure' | 'saml2_bearer';

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  await endpoint.close();
});

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
    deleteSession: jest.fn(async (_d: string) => {}),
  };
  return { store, held: () => sessions.get(D) };
}

function silentLogger(): jest.Mocked<ILogger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

/** What a provider put on one request: its bearer token and its cookies. */
async function presented(
  provider: IAuthProvider,
): Promise<{ bearer?: string | undefined; cookies?: string | undefined }> {
  const headers: Record<string, string> = {};
  let cookies: string | undefined;
  const request: IRequestTarget = {
    header: (name, value) => {
      headers[name] = value;
    },
    cookies: (value) => {
      cookies = value;
    },
  };
  expect(await provider.authorize(request)).toEqual({ ok: true });
  return { bearer: headers.Authorization?.replace(/^Bearer /, ''), cookies };
}

const bearer = async (provider: IAuthProvider) =>
  (await presented(provider)).bearer;

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

// ---------------------------------------------------------------- OIDC

/** The means of an OIDC destination, as a key store states them. */
function oidcMeans(
  grant: OidcGrant,
  extra: WithUndefined<Partial<IConnectionConfig>> = {},
): IConnectionConfig {
  const base: IConnectionConfig = {
    authType: 'jwt',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    oidcIssuerUrl: endpoint.url,
    oidcScopes: ['openid', 'profile'],
  };
  if (grant === 'password') {
    base.username = 'alice';
    base.password = USER_PASSWORD;
  }
  if (grant === 'token_exchange') {
    base.oidcSubjectToken = SUBJECT_TOKEN;
    base.oidcSubjectTokenType = 'urn:ietf:params:oauth:token-type:access_token';
  }
  return asContract<IConnectionConfig>({ ...base, ...extra });
}

function oidcClient(
  extra: Partial<IAuthorizationConfig> = {},
): IAuthorizationConfig {
  return {
    uaaUrl: '',
    uaaClientId: 'oidc-client',
    uaaClientSecret: CLIENT_SECRET,
    ...extra,
  };
}

/** The `issuedBy` record of an OIDC row with these means and the client. */
const oidcBy = (
  grant: OidcGrant = 'password',
  means: IConnectionConfig = oidcMeans(grant),
  clientId = 'oidc-client',
) => oidcRecord(grant, means, clientId);

/** An OIDC strategy that plays the user: it records the URL and returns a code. */
function oidcStrategy(): {
  strategy: jest.Mocked<IAuthorizationStrategy<OidcCallbackResult>>;
  urls: string[];
} {
  const urls: string[] = [];
  const strategy: jest.Mocked<IAuthorizationStrategy<OidcCallbackResult>> = {
    authorize: jest.fn(async (request: AuthorizationRequest) => {
      urls.push(await request.buildAuthorizationUrl(REDIRECT));
      return { payload: { code: 'the-code' }, redirectUri: REDIRECT };
    }),
    dispose: jest.fn(async () => {}),
  };
  return { strategy, urls };
}

/** A presenter that records each prompt, as a user would read it. */
function recordingPresenter(): {
  presenter: jest.Mocked<IDeviceCodePresenter>;
  prompts: DeviceCodePrompt[];
} {
  const prompts: DeviceCodePrompt[] = [];
  return {
    prompts,
    presenter: {
      present: jest.fn(async (prompt: DeviceCodePrompt) => {
        prompts.push(prompt);
      }),
    },
  };
}

function oidcBroker(
  grant: OidcGrant,
  options: {
    session?: IConfig | null;
    conn?: IConnectionConfig | null;
    auth?: IAuthorizationConfig | null;
    withCollaborators?: boolean;
    logger?: ILogger;
  } = {},
) {
  const sessions = sessionStore(options.session ?? null);
  const keys = keyStore(
    options.conn === undefined ? oidcMeans(grant) : options.conn,
    options.auth === undefined ? oidcClient() : options.auth,
  );
  const oidc = oidcStrategy();
  const device = recordingPresenter();
  const oidcAuthorization = jest.fn((_d: string) => oidc.strategy);
  const deviceCodePresenter = jest.fn((_d: string) => device.presenter);
  const config: AuthBrokerConfig = {
    sessionStore: sessions.store,
    serviceKeyStore: keys,
  };
  if (options.withCollaborators !== false) {
    config.oidcAuthorization = oidcAuthorization;
    config.deviceCodePresenter = deviceCodePresenter;
  }
  const broker = new AuthBroker({ ...STATED, ...config }, options.logger);
  return {
    broker,
    keys,
    oidcAuthorization,
    deviceCodePresenter,
    oidc,
    device,
    ...sessions,
  };
}

describe('getProvider — the OIDC grants', () => {
  describe('jwt / password', () => {
    it('without a session logs in at prepare() with the stored user, client and scopes, found through the stored issuer', async () => {
      const { broker, held } = oidcBroker('password');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests).toEqual([
        {
          grantType: 'password',
          params: {
            grant_type: 'password',
            username: 'alice',
            password: USER_PASSWORD,
            client_id: 'oidc-client',
            scope: 'openid profile',
          },
          authorization: basicAuth('oidc-client', CLIENT_SECRET),
        },
      ]);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        refreshToken: 'refresh-1',
        issuedFor: FOR,
        issuedBy: oidcBy(),
      });
    });

    it('takes the explicit token endpoint without an issuer, and binds to the client and that endpoint, exactly', async () => {
      const conn = oidcMeans('password', {
        oidcTokenEndpoint: `${endpoint.url}/oauth/token`,
      });
      delete conn.oidcIssuerUrl;
      const { broker, held } = oidcBroker('password', {
        conn,
        auth: oidcClient({ uaaUrl: 'https://IdP.example.com:443/' }),
      });

      expect(await (await broker.getProvider(D)).prepare()).toEqual({
        ok: true,
      });

      expect(endpoint.requests.map((r) => r.grantType)).toEqual(['password']);
      // uaaUrl is no address an OIDC provider receives: not in the record.
      expect(held()?.issuedBy).toBe(
        record(
          'jwt/password',
          {
            clientId: 'oidc-client',
            oidcTokenEndpoint: `${endpoint.url}/oauth/token`,
          },
          [
            ['oidcScopes', ['openid', 'profile']],
            ['username', 'alice'],
            ['clientCertificate', null],
          ],
        ),
      );
    });

    it('takes a public client — uaaClientSecret "" — as no secret', async () => {
      const { broker } = oidcBroker('password', {
        auth: oidcClient({ uaaClientSecret: '' }),
      });

      await (await broker.getProvider(D)).prepare();

      expect(endpoint.requests[0]!.authorization).toBeUndefined();
      expect(endpoint.requests[0]!.params.client_id).toBe('oidc-client');
    });
  });

  describe('jwt / oidc_authorization_code', () => {
    it('logs in through the consumer’s oidcAuthorization with PKCE at the stored endpoints', async () => {
      const conn = oidcMeans('oidc_authorization_code', {
        oidcAuthorizationEndpoint: 'https://login.example.com/authorize',
        oidcTokenEndpoint: `${endpoint.url}/oauth/token`,
      });
      const { broker, oidcAuthorization, oidc, held } = oidcBroker(
        'oidc_authorization_code',
        { conn },
      );

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(oidcAuthorization.mock.calls).toEqual([[D]]);
      expect(oidc.urls).toHaveLength(1);
      const url = new URL(oidc.urls[0]!);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://login.example.com/authorize',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: 'code',
        // 6.0.0: every OIDC authorization URL carries this attempt's state.
        state: expect.any(String),
        client_id: 'oidc-client',
        redirect_uri: REDIRECT,
        scope: 'openid profile',
        code_challenge: expect.any(String),
        code_challenge_method: 'S256',
      });
      expect(endpoint.requests).toEqual([
        {
          grantType: 'authorization_code',
          params: {
            grant_type: 'authorization_code',
            code: 'the-code',
            redirect_uri: REDIRECT,
            code_verifier: expect.any(String),
            client_id: 'oidc-client',
          },
          authorization: basicAuth('oidc-client', CLIENT_SECRET),
        },
      ]);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(held()?.issuedBy).toBe(oidcBy('oidc_authorization_code', conn));
      expect(oidc.strategy.dispose).not.toHaveBeenCalled();
    });
  });

  describe('jwt / device_code', () => {
    it('shows the code through the consumer’s presenter and polls the stored endpoint', async () => {
      const { broker, deviceCodePresenter, device, held } =
        oidcBroker('device_code');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(deviceCodePresenter.mock.calls).toEqual([[D]]);
      expect(endpoint.deviceRequests).toEqual([
        { client_id: 'oidc-client', scope: 'openid profile' },
      ]);
      expect(device.prompts).toEqual([
        {
          verificationUri: `${endpoint.url}/verify`,
          verificationUriComplete: `${endpoint.url}/verify?user_code=USER-1`,
          userCode: 'USER-1',
          expiresInSeconds: 600,
        },
      ]);
      expect(endpoint.requests).toEqual([
        {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          params: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: 'device-1',
            client_id: 'oidc-client',
          },
          authorization: basicAuth('oidc-client', CLIENT_SECRET),
        },
      ]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
    });
  });

  describe('jwt / device_code with an issuer and one explicit endpoint', () => {
    // auth-providers 5.2.1 discovers the endpoint not given; 5.2.0 skipped
    // discovery unless both were missing, and prepare() refused before any
    // request — the broker builds the row the same either way.
    it.each([
      [
        'the token endpoint',
        () => ({ oidcDeviceAuthorizationEndpoint: `${endpoint.url}/device` }),
      ],
      [
        'the device endpoint',
        () => ({ oidcTokenEndpoint: `${endpoint.url}/oauth/token` }),
      ],
    ])(
      'discovers %s it was not given, shows the code and obtains a token',
      async (_missing, explicit) => {
        const { broker, device, held } = oidcBroker('device_code', {
          conn: oidcMeans('device_code', explicit()),
        });

        const provider = await broker.getProvider(D);
        expect(await provider.prepare()).toEqual({ ok: true });

        expect(endpoint.deviceRequests).toHaveLength(1);
        expect(device.prompts).toHaveLength(1);
        expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      },
    );
  });

  describe('jwt / token_exchange', () => {
    it('exchanges the stored subject and actor tokens, with the scopes joined by a space', async () => {
      const conn = oidcMeans('token_exchange', {
        oidcScopes: ['openid', 'profile', 'email'],
        oidcAudience: 'the-audience',
        oidcActorToken: ACTOR_TOKEN,
        oidcActorTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      });
      const { broker, held, store } = oidcBroker('token_exchange', { conn });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests).toEqual([
        {
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
          params: {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: SUBJECT_TOKEN,
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            client_id: 'oidc-client',
            scope: 'openid profile email',
            audience: 'the-audience',
            actor_token: ACTOR_TOKEN,
            actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          },
          authorization: basicAuth('oidc-client', CLIENT_SECRET),
        },
      ]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      // The subject token is means: it is sent, never written.
      expect(JSON.stringify(store.saveSession.mock.calls)).not.toContain(
        SUBJECT_TOKEN,
      );
      expect(JSON.stringify(store.saveSession.mock.calls)).not.toContain(
        ACTOR_TOKEN,
      );
    });

    it('leaves the scope out when the means state none', async () => {
      const conn = oidcMeans('token_exchange');
      delete conn.oidcScopes;
      const { broker } = oidcBroker('token_exchange', { conn });

      await (await broker.getProvider(D)).prepare();

      expect(endpoint.requests[0]!.params.scope).toBeUndefined();
    });
  });

  describe.each([
    'oidc_authorization_code',
    'device_code',
    'password',
  ] as const)('%s seeded from the session', (grant) => {
    it('presents the stored token and asks no one', async () => {
      const stored = jwtExpiringIn(3600, { jti: 'stored' });
      const { broker, oidc, device } = oidcBroker(grant, {
        session: {
          authorizationToken: stored,
          refreshToken: 'stored-rt',
          issuedFor: FOR,
          issuedBy: oidcBy(grant),
        },
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(await bearer(provider)).toBe(stored);
      expect(endpoint.requests).toEqual([]);
      expect(oidc.strategy.authorize).not.toHaveBeenCalled();
      expect(device.presenter.present).not.toHaveBeenCalled();
    });

    it('reuses an opaque stored token until the stored expiresAt', async () => {
      const { broker } = oidcBroker(grant, {
        session: {
          authorizationToken: 'opaque-stored-token',
          expiresAt: Date.now() + 3_600_000,
          issuedFor: FOR,
          issuedBy: oidcBy(grant),
        },
      });

      const provider = await broker.getProvider(D);
      await provider.prepare();

      expect(endpoint.requests).toEqual([]);
      expect(await bearer(provider)).toBe('opaque-stored-token');
    });

    it('is not seeded from a session bound to another client: a fresh login, never the stored refresh token', async () => {
      const { broker, held } = oidcBroker(grant, {
        session: {
          authorizationToken: jwtExpiringIn(3600, { jti: 'foreign' }),
          refreshToken: 'foreign-rt',
          issuedFor: FOR,
          issuedBy: oidcBy(grant, oidcMeans(grant), 'another-client'),
        },
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]!.params.refresh_token).toBeUndefined();
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(held()?.issuedBy).toBe(oidcBy(grant));
    });
  });

  it('token_exchange is never seeded: a session holding its exact record still gets a fresh exchange', async () => {
    const stored = jwtExpiringIn(3600, { jti: 'stored' });
    const { broker, held } = oidcBroker('token_exchange', {
      session: {
        authorizationToken: stored,
        refreshToken: 'stored-rt',
        issuedFor: FOR,
        issuedBy: oidcBy('token_exchange'),
      },
    });

    const provider = await broker.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]);
    expect(JSON.stringify(endpoint.requests)).not.toContain('stored-rt');
    expect(await bearer(provider)).toBe(endpoint.issued[0]);
    expect(held()?.issuedBy).toBe(oidcBy('token_exchange'));
  });

  describe.each([
    'oidc_authorization_code',
    'device_code',
    'password',
  ] as const)('%s after a 401', (grant) => {
    it('renews by the stored refresh token, and the new token reaches the session store', async () => {
      const refused = jwtExpiringIn(3600, { jti: 'refused' });
      const { broker, held, store } = oidcBroker(grant, {
        session: {
          authorizationToken: refused,
          refreshToken: 'stored-rt',
          issuedFor: FOR,
          issuedBy: oidcBy(grant),
        },
      });
      const provider = await broker.getProvider(D);
      expect(await bearer(provider)).toBe(refused);

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

      expect(endpoint.requests).toEqual([
        {
          grantType: 'refresh_token',
          params: {
            grant_type: 'refresh_token',
            refresh_token: 'stored-rt',
            client_id: 'oidc-client',
          },
          authorization: basicAuth('oidc-client', CLIENT_SECRET),
        },
      ]);
      expect(store.saveSession).toHaveBeenCalledTimes(1);
      const [, written] = store.saveSession.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(Object.keys(written).sort()).toEqual([
        'authorizationToken',
        'expiresAt',
        'issuedBy',
        'issuedFor',
        'refreshToken',
      ]);
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(JSON.stringify(store.saveSession.mock.calls)).not.toContain(
        CLIENT_SECRET,
      );
    });
  });

  it('token_exchange after a 401 exchanges again: it has no refresh grant', async () => {
    const { broker, held } = oidcBroker('token_exchange', {
      session: {
        authorizationToken: jwtExpiringIn(3600, { jti: 'refused' }),
        issuedFor: FOR,
        issuedBy: oidcBy('token_exchange'),
      },
    });
    const provider = await broker.getProvider(D);

    expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]);
    expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
  });

  describe('DestinationConfigError', () => {
    it.each([
      ['oidc_authorization_code', ['oidcAuthorization']],
      ['device_code', ['deviceCodePresenter']],
    ] as const)(
      '%s without its collaborator option names %j',
      async (grant, missing) => {
        const { broker } = oidcBroker(grant, { withCollaborators: false });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(missing);
      },
    );

    it.each(['password', 'token_exchange'] as const)(
      '%s needs no collaborator',
      async (grant) => {
        const { broker } = oidcBroker(grant, { withCollaborators: false });
        expect(await (await broker.getProvider(D)).prepare()).toEqual({
          ok: true,
        });
      },
    );

    it.each([
      [
        'oidc_authorization_code',
        ['oidcAuthorizationEndpoint', 'oidcTokenEndpoint'],
      ],
      ['device_code', ['oidcDeviceAuthorizationEndpoint', 'oidcTokenEndpoint']],
      ['password', ['oidcTokenEndpoint']],
      ['token_exchange', ['oidcTokenEndpoint']],
    ] as const)(
      '%s with neither the issuer nor its endpoints names the issuer and %j',
      async (grant, endpoints) => {
        const conn = oidcMeans(grant, { oidcIssuerUrl: '' });
        const { broker } = oidcBroker(grant, { conn });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(['oidcIssuerUrl', ...endpoints]);
      },
    );

    it.each([
      'oidc_authorization_code',
      'device_code',
      'password',
      'token_exchange',
    ] as const)('%s without a client names uaaClientId', async (grant) => {
      const { broker } = oidcBroker(grant, { auth: null });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual(['uaaClientId']);
    });

    it('password without the user names username and password, and quotes nothing', async () => {
      const { broker } = oidcBroker('password', {
        conn: oidcMeans('password', { username: '', password: undefined }),
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual(['username', 'password']);
      expect(everythingIn(error)).not.toContain(CLIENT_SECRET);
    });

    it('token_exchange without a subject names the subject token and its type, and quotes nothing', async () => {
      const { broker } = oidcBroker('token_exchange', {
        conn: oidcMeans('token_exchange', {
          oidcSubjectToken: '',
          oidcSubjectTokenType: undefined,
          oidcActorToken: ACTOR_TOKEN,
        }),
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual([
        'oidcSubjectToken',
        'oidcSubjectTokenType',
      ]);
      expect(everythingIn(error)).not.toContain(ACTOR_TOKEN);
      expect(everythingIn(error)).not.toContain(CLIENT_SECRET);
    });

    it('names every missing field and option in one error', async () => {
      const { broker } = oidcBroker('device_code', {
        conn: oidcMeans('device_code', { oidcIssuerUrl: undefined }),
        auth: null,
        withCollaborators: false,
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual([
        'uaaClientId',
        'oidcIssuerUrl',
        'oidcDeviceAuthorizationEndpoint',
        'oidcTokenEndpoint',
        'deviceCodePresenter',
      ]);
    });
  });

  it('a headless refusing strategy: prepare() answers Oops, and no word of what it threw', async () => {
    class HeadlessRefusal extends Error {}
    const sessions = sessionStore();
    const logger = silentLogger();
    const broker = new AuthBroker(
      {
        ...STATED,
        sessionStore: sessions.store,
        serviceKeyStore: keyStore(
          oidcMeans('oidc_authorization_code'),
          oidcClient(),
        ),
        oidcAuthorization: () => ({
          authorize: async () => {
            throw new HeadlessRefusal(`no user here ${CLIENT_SECRET}`);
          },
        }),
      },
      logger,
    );

    const outcome = await (await broker.getProvider(D)).prepare();

    // auth-providers' fixed wording, with the label it allows for a class
    // that is not its own: "unknown error" — never the thrown message.
    expect(outcome).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        kind: 'unknown',
        reason: expect.stringContaining('(unknown error)'),
      }),
    });
    const said = JSON.stringify([
      outcome,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
      logger.debug.mock.calls,
    ]);
    expect(said).not.toContain('no user here');
    expect(said).not.toContain(CLIENT_SECRET);
    expect(sessions.store.saveSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- SAML

const IDP_ENTITY = 'urn:test:idp';
const SP_ENTITY = 'urn:test:sp';
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';
/** What a `saml2_pure` session's `issuedBy` must hold: its record. */
const acsBy = () => samlPureRecord(samlMeans('saml2_pure', signsResponse));
const COOKIES = 'SAP_SESSIONID_ABC_100=stand-in; MYSAPSSO2=stand-in';

/** Two identity providers: one signs the Response, the other the Assertion alone. */
let signsResponse: MockSamlIdp;
let signsAssertion: MockSamlIdp;
/** Another identity provider's certificate: trusted by nothing it signs. */
let stranger: MockSamlIdp;

beforeAll(async () => {
  const common = { issuer: IDP_ENTITY, audience: SP_ENTITY, acsUrls: [ACS] };
  [signsResponse, signsAssertion, stranger] = await Promise.all([
    startMockSamlIdp({ ...common, signWhat: 'response' }),
    startMockSamlIdp({ ...common, signWhat: 'assertion' }),
    startMockSamlIdp(common),
  ]);
});

afterAll(async () => {
  await Promise.all([
    signsResponse.close(),
    signsAssertion.close(),
    stranger.close(),
  ]);
});

/**
 * A SAML strategy that plays the browser: it asks for the AuthnRequest URL for
 * the ACS, fetches it from the identity provider, and takes the SAMLResponse
 * out of the form the IdP answers with — what a browser would post.
 */
function samlStrategy(): {
  strategy: jest.Mocked<IAuthorizationStrategy<string>>;
  responses: string[];
} {
  const responses: string[] = [];
  const strategy: jest.Mocked<IAuthorizationStrategy<string>> = {
    authorize: jest.fn(async (request: AuthorizationRequest) => {
      const url = await request.buildAuthorizationUrl(ACS);
      const html = await (await fetch(url)).text();
      const payload = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1];
      if (!payload) throw new Error(`no SAMLResponse from the IdP: ${html}`);
      responses.push(payload);
      return { payload, redirectUri: ACS };
    }),
    dispose: jest.fn(async () => {}),
  };
  return { strategy, responses };
}

/** A replay store that records each key it is asked about. */
function recordingReplayStore(): {
  store: IAssertionReplayStore;
  keys: AssertionReplayKey[];
} {
  const inner = createInMemoryReplayStore();
  const keys: AssertionReplayKey[] = [];
  return {
    keys,
    store: {
      recordIfUnseen: async (key, retainUntil) => {
        keys.push(key);
        return inner.recordIfUnseen(key, retainUntil);
      },
    },
  };
}

function samlMeans(
  grant: SamlGrant,
  idp: MockSamlIdp,
  extra: Partial<IConnectionConfig> = {},
): IConnectionConfig {
  return {
    authType: 'saml',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    samlIdpSsoUrl: `${idp.url}/sso`,
    samlIdpEntityId: IDP_ENTITY,
    samlIdpCertificates: [idp.certificatePem],
    samlSpEntityId: SP_ENTITY,
    samlAcsUrl: ACS,
    ...extra,
  };
}

function bearerClient(
  extra: Partial<IAuthorizationConfig> = {},
): IAuthorizationConfig {
  return {
    uaaUrl: endpoint.url,
    uaaClientId: 'saml-client',
    uaaClientSecret: CLIENT_SECRET,
    ...extra,
  };
}

/** What a `saml2_bearer` session's `issuedBy` must hold: its record. */
const bearerBy = (clientId = 'saml-client') =>
  samlBearerRecord(
    samlMeans('saml2_bearer', signsAssertion),
    endpoint.url,
    clientId,
  );

function samlBroker(
  grant: SamlGrant,
  options: {
    idp?: MockSamlIdp;
    session?: IConfig | null;
    conn?: IConnectionConfig | null;
    auth?: IAuthorizationConfig | null;
    without?: (keyof AuthBrokerConfig)[];
    logger?: ILogger;
  } = {},
) {
  const idp =
    options.idp ?? (grant === 'saml2_pure' ? signsResponse : signsAssertion);
  const sessions = sessionStore(options.session ?? null);
  const keys = keyStore(
    options.conn === undefined ? samlMeans(grant, idp) : options.conn,
    options.auth === undefined
      ? grant === 'saml2_bearer'
        ? bearerClient()
        : null
      : options.auth,
  );
  const saml = samlStrategy();
  const replay = recordingReplayStore();
  const received: string[] = [];
  const cookieFunction = jest.fn(async (samlResponse: string) => {
    received.push(samlResponse);
    return COOKIES;
  });
  const authorization = jest.fn(
    (_d: string, _g: StrategyGrant): IAuthorizationStrategy<string> =>
      saml.strategy,
  );
  const samlCookies = jest.fn((_d: string) => cookieFunction);
  const assertionReplayStore = jest.fn((_d: string) => replay.store);
  const config: AuthBrokerConfig = {
    sessionStore: sessions.store,
    serviceKeyStore: keys,
    authorization,
    samlCookies,
    assertionReplayStore,
  };
  for (const option of options.without ?? []) delete config[option];
  const broker = new AuthBroker({ ...STATED, ...config }, options.logger);
  return {
    broker,
    keys,
    idp,
    saml,
    replay,
    received,
    authorization,
    samlCookies,
    cookieFunction,
    assertionReplayStore,
    ...sessions,
  };
}

/** The Issuer of the assertion a SAMLResponse carries. */
function assertionIssuer(samlResponse: string): string | undefined {
  const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  return /<saml:Assertion\b[\s\S]*?<saml:Issuer>([^<]+)</.exec(xml)?.[1];
}

describe('getProvider — the SAML grants', () => {
  describe('saml / saml2_pure', () => {
    it('without a session logs in through the consumer’s strategy, validates, and presents the cookies samlCookies made', async () => {
      const {
        broker,
        authorization,
        samlCookies,
        assertionReplayStore,
        saml,
        received,
        replay,
        held,
      } = samlBroker('saml2_pure');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(authorization.mock.calls).toEqual([[D, 'saml2_pure']]);
      expect(samlCookies.mock.calls).toEqual([[D]]);
      expect(assertionReplayStore.mock.calls).toEqual([[D]]);
      // The cookie function got exactly what the IdP issued, after validation
      // recorded it in the consumer's replay store.
      expect(received).toEqual(saml.responses);
      expect(replay.keys).toEqual([
        { issuer: IDP_ENTITY, assertionId: expect.any(String) },
      ]);
      expect(await presented(provider)).toEqual({
        bearer: undefined,
        cookies: COOKIES,
      });
      expect(held()).toEqual({
        sessionCookies: COOKIES,
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: acsBy(),
      });
      expect(held()?.expiresAt).toBeGreaterThan(Date.now());
    });

    it('writes the cookies as cookies, with expiresAt and the binding — nothing else', async () => {
      const { broker, store } = samlBroker('saml2_pure');

      await (await broker.getProvider(D)).prepare();

      expect(store.saveSession).toHaveBeenCalledTimes(1);
      const [, written] = store.saveSession.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(Object.keys(written).sort()).toEqual([
        'expiresAt',
        'issuedBy',
        'issuedFor',
        'sessionCookies',
      ]);
      expect(store.setConnectionConfig).not.toHaveBeenCalled();
      expect(store.setAuthorizationConfig).not.toHaveBeenCalled();
    });

    it('refuses a response signed by another key: no cookies asked for, nothing written', async () => {
      const { broker, cookieFunction, store } = samlBroker('saml2_pure', {
        conn: samlMeans('saml2_pure', signsResponse, {
          samlIdpCertificates: [stranger.certificatePem],
        }),
      });

      const outcome = await (await broker.getProvider(D)).prepare();

      expect(outcome.ok).toBe(false);
      expect(cookieFunction).not.toHaveBeenCalled();
      expect(store.saveSession).not.toHaveBeenCalled();
    });

    it('requires the Response signed: an IdP that signs the Assertion alone is refused', async () => {
      const { broker, cookieFunction } = samlBroker('saml2_pure', {
        idp: signsAssertion,
      });

      const outcome = await (await broker.getProvider(D)).prepare();

      expect(outcome.ok).toBe(false);
      expect(cookieFunction).not.toHaveBeenCalled();
    });

    it('expects the issuer samlIdpEntityId states', async () => {
      const { broker, cookieFunction } = samlBroker('saml2_pure', {
        conn: samlMeans('saml2_pure', signsResponse, {
          samlIdpEntityId: 'urn:test:another-idp',
        }),
      });

      expect((await (await broker.getProvider(D)).prepare()).ok).toBe(false);
      expect(cookieFunction).not.toHaveBeenCalled();
    });

    it('records each assertion in the consumer’s replay store: one presented twice is refused', async () => {
      const { broker, idp, replay, cookieFunction } = samlBroker('saml2_pure');
      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      idp.repeatLastAssertion();
      expect((await provider.rejected(UNAUTHORIZED)).ok).toBe(false);

      expect(replay.keys).toHaveLength(2);
      expect(replay.keys[1]).toEqual(replay.keys[0]);
      expect(cookieFunction).toHaveBeenCalledTimes(1);
    });

    it('seeded: reuses the stored cookies before expiresAt and asks no one', async () => {
      const { broker, saml, cookieFunction } = samlBroker('saml2_pure', {
        session: {
          sessionCookies: 'STORED=cookie',
          expiresAt: Date.now() + 3_600_000,
          issuedFor: FOR,
          issuedBy: acsBy(),
        },
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect((await presented(provider)).cookies).toBe('STORED=cookie');
      expect(saml.strategy.authorize).not.toHaveBeenCalled();
      expect(cookieFunction).not.toHaveBeenCalled();
    });

    it('seeded: logs in once the stored expiresAt has passed', async () => {
      const { broker, saml, held } = samlBroker('saml2_pure', {
        session: {
          sessionCookies: 'STORED=cookie',
          expiresAt: Date.now() - 1_000,
          issuedFor: FOR,
          issuedBy: acsBy(),
        },
      });

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(saml.strategy.authorize).toHaveBeenCalledTimes(1);
      expect((await presented(provider)).cookies).toBe(COOKIES);
      expect(held()?.sessionCookies).toBe(COOKIES);
    });

    it('a 401 logs in again — SAML has no refresh — and the new cookies reach the session store', async () => {
      const { broker, saml, held } = samlBroker('saml2_pure', {
        session: {
          sessionCookies: 'STORED=cookie',
          expiresAt: Date.now() + 3_600_000,
          issuedFor: FOR,
          issuedBy: acsBy(),
        },
      });
      const provider = await broker.getProvider(D);

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

      expect(saml.strategy.authorize).toHaveBeenCalledTimes(1);
      expect(held()?.sessionCookies).toBe(COOKIES);
    });

    it('cookies set for another ACS are not used: a fresh login', async () => {
      const { broker, saml, held } = samlBroker('saml2_pure', {
        session: {
          sessionCookies: 'FOREIGN=cookie',
          expiresAt: Date.now() + 3_600_000,
          issuedFor: FOR,
          issuedBy: samlPureRecord(
            samlMeans('saml2_pure', signsResponse, {
              samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/200',
            }),
          ),
        },
      });

      const provider = await broker.getProvider(D);
      await provider.prepare();

      expect(saml.strategy.authorize).toHaveBeenCalledTimes(1);
      expect((await presented(provider)).cookies).toBe(COOKIES);
      expect(held()?.issuedBy).toBe(acsBy());
    });

    it('cookies recorded for the ACS written another way — a query, another case — are not used: the record is exact', async () => {
      const { broker, saml } = samlBroker('saml2_pure', {
        session: {
          sessionCookies: 'STORED=cookie',
          expiresAt: Date.now() + 3_600_000,
          issuedFor: FOR,
          issuedBy: samlPureRecord(
            samlMeans('saml2_pure', signsResponse, {
              samlAcsUrl: 'HTTPS://ABAP.example.com/sap/saml2/sp/acs/100/?x=1',
            }),
          ),
        },
      });

      const provider = await broker.getProvider(D);
      await provider.prepare();

      expect(saml.strategy.authorize).toHaveBeenCalledTimes(1);
      expect((await presented(provider)).cookies).toBe(COOKIES);
    });

    it('samlIdpInitiated reaches the provider: a strategy asking for an AuthnRequest URL is refused', async () => {
      const { broker, idp, cookieFunction } = samlBroker('saml2_pure', {
        conn: samlMeans('saml2_pure', signsResponse, {
          samlIdpInitiated: true,
        }),
      });
      const before = idp.requests.length;

      const outcome = await (await broker.getProvider(D)).prepare();

      expect(outcome.ok).toBe(false);
      expect(idp.requests).toHaveLength(before);
      expect(cookieFunction).not.toHaveBeenCalled();
    });
  });

  describe('saml / saml2_bearer', () => {
    it('without a session exchanges the validated assertion at <uaaUrl>/oauth/token and writes the token as a token', async () => {
      const {
        broker,
        authorization,
        assertionReplayStore,
        samlCookies,
        replay,
        saml,
        store,
        held,
      } = samlBroker('saml2_bearer');

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(authorization.mock.calls).toEqual([[D, 'saml2_bearer']]);
      expect(assertionReplayStore.mock.calls).toEqual([[D]]);
      expect(samlCookies).not.toHaveBeenCalled();
      expect(replay.keys).toHaveLength(1);
      expect(endpoint.paths).toEqual(['/oauth/token']);
      expect(endpoint.requests).toEqual([
        {
          grantType: 'urn:ietf:params:oauth:grant-type:saml2-bearer',
          params: {
            grant_type: 'urn:ietf:params:oauth:grant-type:saml2-bearer',
            assertion: expect.any(String),
            client_id: 'saml-client',
          },
          authorization: basicAuth('saml-client', CLIENT_SECRET),
        },
      ]);
      // RFC 7522: the Assertion alone, base64url — taken from what the IdP issued.
      const assertion = Buffer.from(
        endpoint.requests[0]!.params.assertion!,
        'base64url',
      ).toString('utf8');
      expect(assertion).toMatch(/^<saml:Assertion\b/);
      expect(assertionIssuer(saml.responses[0]!)).toBe(IDP_ENTITY);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      const [, written] = store.saveSession.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(Object.keys(written).sort()).toEqual([
        'authorizationToken',
        'expiresAt',
        'issuedBy',
        'issuedFor',
        'refreshToken',
      ]);
      expect(held()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        refreshToken: 'refresh-1',
        issuedFor: FOR,
        issuedBy: bearerBy(),
      });
      expect(JSON.stringify(store.saveSession.mock.calls)).not.toContain(
        CLIENT_SECRET,
      );
    });

    it('posts to samlTokenUrl when the means state it', async () => {
      const { broker } = samlBroker('saml2_bearer', {
        conn: samlMeans('saml2_bearer', signsAssertion, {
          samlTokenUrl: `${endpoint.url}/oauth/token/alias/sp`,
        }),
      });

      await (await broker.getProvider(D)).prepare();

      expect(endpoint.paths).toEqual(['/oauth/token/alias/sp']);
    });

    it('accepts an Assertion signed alone, and refuses one signed by another key', async () => {
      const { broker: accepted } = samlBroker('saml2_bearer');
      expect(await (await accepted.getProvider(D)).prepare()).toEqual({
        ok: true,
      });

      const { broker: refused } = samlBroker('saml2_bearer', {
        conn: samlMeans('saml2_bearer', signsAssertion, {
          samlIdpCertificates: [stranger.certificatePem],
        }),
      });
      expect((await (await refused.getProvider(D)).prepare()).ok).toBe(false);
      expect(endpoint.requests).toHaveLength(1);
    });

    it('seeded: presents the stored token, and a 401 renews by the stored refresh token', async () => {
      const refused = jwtExpiringIn(3600, { jti: 'refused' });
      const { broker, saml, held } = samlBroker('saml2_bearer', {
        session: {
          authorizationToken: refused,
          refreshToken: 'stored-rt',
          issuedFor: FOR,
          issuedBy: bearerBy(),
        },
      });
      const provider = await broker.getProvider(D);
      expect(await bearer(provider)).toBe(refused);

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });

      expect(endpoint.requests.map((r) => r.params)).toEqual([
        {
          grant_type: 'refresh_token',
          refresh_token: 'stored-rt',
          client_id: 'saml-client',
        },
      ]);
      expect(saml.strategy.authorize).not.toHaveBeenCalled();
      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
    });

    it('a token issued to another client is not used: a fresh SAML login', async () => {
      const { broker, saml } = samlBroker('saml2_bearer', {
        session: {
          authorizationToken: jwtExpiringIn(3600, { jti: 'foreign' }),
          refreshToken: 'foreign-rt',
          issuedFor: FOR,
          issuedBy: bearerBy('another-client'),
        },
      });

      await (await broker.getProvider(D)).prepare();

      expect(saml.strategy.authorize).toHaveBeenCalledTimes(1);
      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'urn:ietf:params:oauth:grant-type:saml2-bearer',
      ]);
    });

    it('takes a public client — uaaClientSecret "" — as no secret', async () => {
      const { broker } = samlBroker('saml2_bearer', {
        auth: bearerClient({ uaaClientSecret: '' }),
      });

      await (await broker.getProvider(D)).prepare();

      expect(endpoint.requests[0]!.authorization).toBeUndefined();
    });
  });

  describe('DestinationConfigError', () => {
    it.each([
      ['saml2_pure', ['authorization', 'samlCookies', 'assertionReplayStore']],
      ['saml2_bearer', ['authorization', 'assertionReplayStore']],
    ] as const)(
      '%s without its collaborators names %j',
      async (grant, missing) => {
        const { broker } = samlBroker(grant, {
          without: ['authorization', 'samlCookies', 'assertionReplayStore'],
        });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(missing);
      },
    );

    it.each(['saml2_pure', 'saml2_bearer'] as const)(
      '%s names each SAML field it lacks — "" and an empty certificate list as missing',
      async (grant) => {
        const { broker } = samlBroker(grant, {
          conn: {
            authType: 'saml',
            grantType: grant,
            samlIdpSsoUrl: '',
            samlIdpCertificates: [],
          },
        });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual([
          'samlIdpSsoUrl',
          'samlSpEntityId',
          'samlIdpEntityId',
          'samlIdpCertificates',
        ]);
      },
    );

    it('saml2_bearer without a client names uaaUrl and uaaClientId', async () => {
      const { broker } = samlBroker('saml2_bearer', { auth: null });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual(['uaaUrl', 'uaaClientId']);
    });

    it('saml2_pure reads no client', async () => {
      const { broker, keys } = samlBroker('saml2_pure', { auth: null });
      expect(await (await broker.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
      expect(keys.getAuthorizationConfig).not.toHaveBeenCalled();
    });

    it('a certificate that is not one names samlIdpCertificates, and quotes nothing', async () => {
      const { broker, authorization } = samlBroker('saml2_pure', {
        conn: samlMeans('saml2_pure', signsResponse, {
          samlIdpCertificates: ['bm90LWEtY2VydGlmaWNhdGU='],
        }),
      });
      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual(['samlIdpCertificates']);
      expect(everythingIn(error)).not.toContain('bm90LWEtY2VydGlmaWNhdGU');
      expect(authorization).not.toHaveBeenCalled();
    });

    it.each([-1, 1.5, Number.NaN])(
      'samlClockSkewMs %p names it',
      async (skew) => {
        const { broker } = samlBroker('saml2_pure', {
          conn: samlMeans('saml2_pure', signsResponse, {
            samlClockSkewMs: skew,
          }),
        });
        const error = await refusal(broker.getProvider(D));
        expect(error.missingFields).toEqual(['samlClockSkewMs']);
      },
    );

    it('a stated samlClockSkewMs is accepted', async () => {
      const { broker } = samlBroker('saml2_pure', {
        conn: samlMeans('saml2_pure', signsResponse, {
          samlClockSkewMs: 30_000,
        }),
      });
      expect(await (await broker.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
    });
  });

  it('a headless refusing strategy: prepare() answers Oops, and no word of what it threw', async () => {
    class HeadlessRefusal extends Error {}
    const logger = silentLogger();
    const { broker, authorization, store } = samlBroker('saml2_bearer', {
      logger,
    });
    authorization.mockImplementation(() => ({
      authorize: async () => {
        throw new HeadlessRefusal(`no user here ${CLIENT_SECRET}`);
      },
    }));

    const outcome = await (await broker.getProvider(D)).prepare();

    // auth-providers' fixed wording, with the label it allows for a class
    // that is not its own: "unknown error" — never the thrown message.
    expect(outcome).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        kind: 'unknown',
        reason: expect.stringContaining('(unknown error)'),
      }),
    });
    const said = JSON.stringify([
      outcome,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
      logger.debug.mock.calls,
    ]);
    expect(said).not.toContain('no user here');
    expect(said).not.toContain(CLIENT_SECRET);
    expect(store.saveSession).not.toHaveBeenCalled();
  });
});

/** The variants a test might set are reset, so one test's choice never leaks. */
afterEach(() => {
  for (const idp of [signsResponse, signsAssertion, stranger]) {
    idp?.setVariant('valid' as SamlVariant);
  }
});
