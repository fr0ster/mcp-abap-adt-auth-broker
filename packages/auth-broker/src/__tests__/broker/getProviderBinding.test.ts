/**
 * A stored secret is bound to the resource it was obtained for and to the
 * issuer and client that issued it (spec §4.5, §6, §13; plan D9).
 *
 * The broker computes `issuedFor` (from `serviceUrl` and `sapClient`) and
 * `issuedBy` (from `uaaUrl` and `uaaClientId`) from the key store's means,
 * canonicalises the session's values, and seeds a provider only when both are
 * equal. Otherwise the secret — refresh token included — is not used: a fresh
 * login, and a log line that carries no value. `persist` writes both with the
 * secret. A `none` destination presents a credential it cannot obtain again,
 * so a mismatch there is a `DestinationConfigError` naming the field.
 *
 * The expected URIs are written out literally here, never computed by the
 * broker's own function: a test that used it would agree with any bug in it.
 *
 * Stores are in-memory fakes of the contract — and, for the legacy file, the
 * real `AbapSessionStore` of auth-stores 3.1.0; providers are real, against a
 * local token endpoint; nothing opens a browser.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ABAP_SESSION_VARS, AbapSessionStore } from '@mcp-abap-adt/auth-stores';
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
import { AuthBroker, bindingOf, DestinationConfigError } from '../../index';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
/** The canonical `issuedFor` of SERVICE_URL with client 100. */
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
/** An XSUAA-style client id: `!` is what encodeURIComponent and URLSearchParams encode differently. */
const CLIENT_ID = 'sb-broker!t42';
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';
const REDIRECT = 'http://localhost/callback';
const DISCARDED = `[AuthBroker] ${D}: secret bound to another resource, discarded`;

type SeededGrant = 'authorization_code' | 'passcode';

let endpoint: TokenEndpoint;
/** The canonical `issuedBy` of the endpoint and CLIENT_ID. */
let BY: string;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
  // 127.0.0.1 with an explicit port; `!` re-encoded by URLSearchParams.
  BY = `${endpoint.url}?client_id=sb-broker%21t42`;
});

afterEach(async () => {
  await endpoint.close();
});

function means(
  grant: string,
  extra: Partial<IConnectionConfig> = {},
): IConnectionConfig {
  return {
    authType: 'jwt',
    grantType: grant as IConnectionConfig['grantType'],
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
    uaaClientId: CLIENT_ID,
    uaaClientSecret: CLIENT_SECRET,
    ...extra,
  };
}

function keyStore(
  conn: IConnectionConfig | null,
  auth: IAuthorizationConfig | null,
): IServiceKeyStore {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => auth),
    getConnectionConfig: jest.fn(async (_d: string) => conn),
  };
}

/** A session store over a map; `saveSession` replaces the session with what it is given. */
function sessionStore(initial: IConfig | null): {
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

function recordingLogger(): jest.Mocked<ILogger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function allLogged(logger: jest.Mocked<ILogger>): string {
  return JSON.stringify([
    logger.debug.mock.calls,
    logger.info.mock.calls,
    logger.warn.mock.calls,
    logger.error.mock.calls,
  ]);
}

function strategy(): jest.Mocked<IAuthorizationStrategy<string>> {
  return {
    authorize: jest.fn(async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    }),
    dispose: jest.fn(async () => {}),
  };
}

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

function broker(
  grant: string,
  session: IConfig | null,
  options: {
    conn?: IConnectionConfig | null;
    auth?: IAuthorizationConfig | null;
    sessions?: ISessionStore;
  } = {},
) {
  const sessions = sessionStore(session);
  const logger = recordingLogger();
  const login = strategy();
  const b = new AuthBroker(
    {
      sessionStore: options.sessions ?? sessions.store,
      serviceKeyStore: keyStore(
        options.conn === undefined ? means(grant) : options.conn,
        options.auth === undefined ? client() : options.auth,
      ),
      authorization: () => login,
    },
    logger,
  );
  return { broker: b, logger, login, ...sessions };
}

/** A stored secret bound as this destination's means bind it. */
function storedSecret(extra: Partial<IConfig> = {}): IConfig {
  return {
    authorizationToken: STORED_TOKEN,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: STORED_RT,
    issuedFor: FOR,
    issuedBy: BY,
    ...extra,
  };
}

const STORED_TOKEN = jwtExpiringIn(3600, {
  jti: 'stored-token-must-not-be-presented',
});
const STORED_RT = 'stored-rt-must-not-be-spent';

/** The grant a fresh login sends to the token endpoint. */
const LOGIN_GRANT: Record<SeededGrant, string> = {
  authorization_code: 'authorization_code',
  passcode: 'password',
};

describe.each(['authorization_code', 'passcode'] as const)(
  'jwt / %s: the stored secret is used only where it is bound',
  (grant: SeededGrant) => {
    it('both stored values equal the computed ones → seeded: the stored token, no request, no login', async () => {
      const { broker: b, login, logger } = broker(grant, storedSecret());

      const provider = await b.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(await bearer(provider)).toBe(STORED_TOKEN);
      expect(endpoint.requests).toEqual([]);
      expect(login.authorize).not.toHaveBeenCalled();
      expect(allLogged(logger)).not.toContain('bound to another resource');
    });

    describe('not seeded — a fresh login, nothing of the old secret used or logged', () => {
      const cases: [
        string,
        () => {
          session: Partial<IConfig>;
          conn?: IConnectionConfig;
          /** The means state no resource: no issuedFor is written. */
          noResource?: true;
        },
      ][] = [
        [
          'issuedFor: a different host',
          () => ({
            session: {
              issuedFor:
                'https://other.example.com:443/sap/bc/adt?sap-client=100',
            },
          }),
        ],
        [
          'issuedFor: a different path',
          () => ({
            session: {
              issuedFor:
                'https://abap.example.com:443/sap/bc/other?sap-client=100',
            },
          }),
        ],
        [
          'issuedFor: a different SAP client',
          () => ({
            session: {
              issuedFor:
                'https://abap.example.com:443/sap/bc/adt?sap-client=200',
            },
          }),
        ],
        [
          'issuedFor: no SAP client stored where the destination states one',
          () => ({
            session: { issuedFor: 'https://abap.example.com:443/sap/bc/adt' },
          }),
        ],
        ['issuedFor absent', () => ({ session: { issuedFor: undefined } })],
        ['issuedFor ""', () => ({ session: { issuedFor: '' } })],
        [
          'issuedFor not a URL',
          () => ({ session: { issuedFor: 'not a url' } }),
        ],
        [
          'serviceUrl absent from the means',
          () => {
            const conn = means(grant);
            delete conn.serviceUrl;
            return { session: {}, conn, noResource: true };
          },
        ],
        [
          'issuedBy: another uaaUrl',
          () => ({
            session: {
              issuedBy:
                'https://uaa.elsewhere.example.com:443?client_id=sb-broker%21t42',
            },
          }),
        ],
        [
          'issuedBy: another client id',
          () => ({
            session: {
              issuedBy: `${endpoint.url}?client_id=sb-other%21t42`,
            },
          }),
        ],
        [
          'issuedBy: the uaaUrl without its client',
          () => ({ session: { issuedBy: endpoint.url } }),
        ],
        ['issuedBy absent', () => ({ session: { issuedBy: undefined } })],
        ['issuedBy ""', () => ({ session: { issuedBy: '' } })],
      ];

      it.each(cases)('%s', async (_label, setup) => {
        const { session, conn, noResource } = setup();
        const stored = storedSecret(session);
        for (const key of Object.keys(session) as (keyof IConfig)[]) {
          if (session[key] === undefined) delete stored[key];
        }
        const {
          broker: b,
          login,
          logger,
          store,
          held,
        } = broker(grant, stored, {
          conn,
        });

        const provider = await b.getProvider(D);
        expect(await provider.prepare()).toEqual({ ok: true });

        // A fresh grant — never the stored refresh token.
        expect(endpoint.requests.map((r) => r.grantType)).toEqual([
          LOGIN_GRANT[grant],
        ]);
        expect(JSON.stringify(endpoint.requests)).not.toContain(STORED_RT);
        expect(login.authorize).toHaveBeenCalledTimes(1);
        // The stored token is never presented.
        expect(await bearer(provider)).toBe(endpoint.issued[0]);

        // One line, the destination's name and fixed words — no argument
        // beside it, and nothing of the secret or the binding anywhere in the
        // log. (The provider logs its own uaaUrl and client id, which are
        // means; a stored issuedBy equal to the bare uaaUrl is that value.)
        expect(logger.warn.mock.calls).toEqual([[DISCARDED]]);
        const logged = allLogged(logger);
        expect(logged.split('bound to another resource')).toHaveLength(2);
        for (const value of [
          STORED_TOKEN,
          STORED_TOKEN.split('.')[1],
          STORED_RT,
          stored.issuedFor,
          stored.issuedBy,
          FOR,
          BY,
          'abap.example.com',
          'sap-client',
          'client_id',
          CLIENT_SECRET,
        ]) {
          if (value && value !== endpoint.url) {
            expect(logged).not.toContain(value);
          }
        }

        // The new secret, written with this destination's binding.
        await b.flush();
        expect(store.saveSession).toHaveBeenCalledTimes(1);
        const expected: IConfig = {
          authorizationToken: endpoint.issued[0],
          expiresAt: expect.any(Number),
          refreshToken: 'refresh-1',
          issuedBy: BY,
        };
        if (!noResource) expected.issuedFor = FOR;
        expect(held()).toEqual(expected);
      });
    });

    describe('seeded — values that canonicalise equal', () => {
      const variants: [
        string,
        () => {
          session?: Partial<IConfig>;
          conn?: Partial<IConnectionConfig>;
          auth?: Partial<IAuthorizationConfig>;
        },
      ][] = [
        [
          'host and scheme case',
          () => ({
            session: {
              issuedFor:
                'HTTPS://ABAP.Example.COM:443/sap/bc/adt?sap-client=100',
            },
          }),
        ],
        [
          'the default port stated against none',
          () => ({
            session: {
              issuedFor: 'https://abap.example.com/sap/bc/adt?sap-client=100',
            },
          }),
        ],
        [
          'a trailing "/" in the stored path',
          () => ({
            session: {
              issuedFor:
                'https://abap.example.com:443/sap/bc/adt/?sap-client=100',
            },
          }),
        ],
        [
          'a trailing "/" and the explicit port in the means',
          () => ({
            conn: { serviceUrl: 'https://abap.example.com:443/sap/bc/adt/' },
          }),
        ],
        [
          'the client as ?sap-client= in the URL instead of sapClient',
          () => ({
            conn: {
              serviceUrl: 'https://abap.example.com/sap/bc/adt?sap-client=100',
              sapClient: undefined,
            },
          }),
        ],
        [
          'sapClient wins over another sap-client in the URL',
          () => ({
            conn: {
              serviceUrl: 'https://abap.example.com/sap/bc/adt?sap-client=200',
            },
          }),
        ],
        [
          'user info, other parameters and a fragment are dropped',
          () => ({
            session: {
              issuedFor:
                'https://me@abap.example.com/sap/bc/adt?x=1&sap-client=100&y=2#top',
            },
          }),
        ],
        [
          'the client id stored unencoded (as auth-stores composes it, encodeURIComponent)',
          () => ({
            session: { issuedBy: `${endpoint.url}?client_id=sb-broker!t42` },
          }),
        ],
        [
          'uaaUrl case and a trailing "/" in the stored issuer',
          () => ({
            session: {
              issuedBy: `${endpoint.url.toUpperCase()}/?client_id=sb-broker%21t42`,
            },
          }),
        ],
        [
          'another parameter beside client_id in the stored issuer',
          () => ({
            session: {
              issuedBy: `${endpoint.url}?zone=a&client_id=sb-broker%21t42`,
            },
          }),
        ],
      ];

      it.each(variants)('%s', async (_label, setup) => {
        const { session = {}, conn = {}, auth = {} } = setup();
        const m = { ...means(grant), ...conn };
        for (const key of Object.keys(conn) as (keyof IConnectionConfig)[]) {
          if (conn[key] === undefined) delete m[key];
        }
        const {
          broker: b,
          login,
          logger,
        } = broker(grant, storedSecret(session), {
          conn: m,
          auth: client(auth),
        });

        const provider = await b.getProvider(D);
        expect(await provider.prepare()).toEqual({ ok: true });

        expect(await bearer(provider)).toBe(STORED_TOKEN);
        expect(endpoint.requests).toEqual([]);
        expect(login.authorize).not.toHaveBeenCalled();
        expect(allLogged(logger)).not.toContain('bound to another resource');
      });
    });

    it('a renewal by the stored refresh token writes both fields again', async () => {
      const { broker: b, store } = broker(grant, storedSecret());
      const provider = await b.getProvider(D);

      expect(
        await provider.rejected({ at: 'request', status: 401, error: null }),
      ).toEqual({ ok: true });

      expect(endpoint.requests.map((r) => r.params)).toEqual([
        { grant_type: 'refresh_token', refresh_token: STORED_RT },
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
      expect(written.issuedFor).toBe(FOR);
      expect(written.issuedBy).toBe(BY);
    });
  },
);

describe('persist writes the binding with every secret, and nothing else', () => {
  it('client_credentials: the secret and both fields, exactly', async () => {
    const { broker: b, store } = broker('client_credentials', null);

    await (await b.getProvider(D)).prepare();
    await b.flush();

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
    expect(written).toEqual({
      authorizationToken: endpoint.issued[0],
      expiresAt: expect.any(Number),
      refreshToken: undefined,
      issuedFor: FOR,
      issuedBy: BY,
    });
  });

  it('a field whose source the means lack is not written at all', async () => {
    const conn = means('client_credentials');
    delete conn.serviceUrl;
    const { broker: b, store } = broker('client_credentials', null, { conn });

    await (await b.getProvider(D)).prepare();
    await b.flush();

    const [, written] = store.saveSession.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect('issuedFor' in written).toBe(false);
    expect(written.issuedBy).toBe(BY);
  });

  it('carries a stored refresh token forward only when it is bound here', async () => {
    const { broker: b, held } = broker('client_credentials', {
      refreshToken: 'bound-rt',
      issuedFor: FOR,
      issuedBy: BY,
    });

    await (await b.getProvider(D)).prepare();
    await b.flush();

    expect(held()?.refreshToken).toBe('bound-rt');
  });

  it.each([
    [
      'another resource',
      { issuedFor: 'https://other.example.com:443?sap-client=100' },
    ],
    [
      'another issuer',
      { issuedBy: 'https://uaa.other.example.com:443?client_id=x' },
    ],
    ['no binding', { issuedFor: undefined, issuedBy: undefined }],
  ])(
    'does not carry a stored refresh token bound to %s into the new secret',
    async (_label, binding) => {
      const { broker: b, held } = broker('client_credentials', {
        refreshToken: 'foreign-rt',
        issuedFor: FOR,
        issuedBy: BY,
        ...binding,
      });

      await (await b.getProvider(D)).prepare();
      await b.flush();

      expect(held()?.authorizationToken).toBe(endpoint.issued[0]);
      expect(held()?.refreshToken).toBeUndefined();
      expect(JSON.stringify(held())).not.toContain('foreign-rt');
    },
  );
});

describe('a session file written before auth-stores 3.1.0 (the real AbapSessionStore)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-binding-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `KEY=value` on a line of its own, the value bare or in the quotes auth-stores picks. */
  function line(key: string, value: string): RegExp {
    const v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${key}=(${v}|'${v}'|\`${v}\`|"${v}")$`, 'm');
  }

  /** What the 3.x CLI and persist left: means and secret in one file, no binding keys. */
  function legacyFile(url: string): void {
    fs.writeFileSync(
      path.join(dir, `${D}.env`),
      [
        `SAP_URL=${url}`,
        'SAP_CLIENT=100',
        'SAP_AUTH_TYPE=jwt',
        `SAP_UAA_URL=${endpoint.url}`,
        `SAP_UAA_CLIENT_ID=${CLIENT_ID}`,
        `SAP_UAA_CLIENT_SECRET=${CLIENT_SECRET}`,
        `SAP_JWT_TOKEN=${STORED_TOKEN}`,
        `SAP_REFRESH_TOKEN=${STORED_RT}`,
        '',
      ].join('\n'),
    );
  }

  it('is seeded when its SAP_URL, SAP_CLIENT and SAP_UAA_* are this destination’s means', async () => {
    legacyFile('https://abap.example.com/sap/bc/adt/');
    const { broker: b, login } = broker('authorization_code', null, {
      sessions: new AbapSessionStore(dir),
    });

    const provider = await b.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });

    expect(await bearer(provider)).toBe(STORED_TOKEN);
    expect(endpoint.requests).toEqual([]);
    expect(login.authorize).not.toHaveBeenCalled();
  });

  it('is not seeded when its SAP_URL names another system; the new secret is written with the binding keys', async () => {
    legacyFile('https://other.example.com/sap/bc/adt');
    const { broker: b } = broker('authorization_code', null, {
      sessions: new AbapSessionStore(dir),
    });

    const provider = await b.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });
    await b.flush();

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    expect(await bearer(provider)).toBe(endpoint.issued[0]);
    const file = fs.readFileSync(path.join(dir, `${D}.env`), 'utf8');
    expect(file).toMatch(line(ABAP_SESSION_VARS.ISSUED_FOR, FOR));
    expect(file).toMatch(line(ABAP_SESSION_VARS.ISSUED_BY, BY));
    expect(file).not.toContain(STORED_RT);
  });
});

describe('the none rows: a handed-over credential is refused, never discarded', () => {
  const SAML_ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';

  function noneBroker(
    authType: 'jwt' | 'saml',
    session: IConfig | null,
    conn: Partial<IConnectionConfig> = {},
    auth: IAuthorizationConfig | null = null,
  ) {
    const m: IConnectionConfig = {
      authType,
      grantType: 'none',
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      ...conn,
    };
    for (const key of Object.keys(conn) as (keyof IConnectionConfig)[]) {
      if (conn[key] === undefined) delete m[key];
    }
    return new AuthBroker({
      sessionStore: sessionStore(session).store,
      serviceKeyStore: keyStore(m, auth),
    });
  }

  async function refusal(promise: Promise<unknown>) {
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
    return [
      String(error),
      (error as Error).stack,
      ...Object.getOwnPropertyNames(e).map((n) => JSON.stringify(e[n])),
    ].join('\n');
  }

  const TOKEN = 'handed-over-token';

  describe('jwt / none', () => {
    it.each([
      ['no issuedBy stored', undefined],
      [
        'a foreign issuedBy stored',
        'https://uaa.other.example.com:443?client_id=x',
      ],
    ])(
      'no issuer in the means and a matching issuedFor → presented (%s)',
      async (_label, issuedBy) => {
        const provider = await noneBroker('jwt', {
          authorizationToken: TOKEN,
          issuedFor: 'https://ABAP.example.com/sap/bc/adt/?sap-client=100',
          ...(issuedBy ? { issuedBy } : {}),
        }).getProvider(D);

        expect(await bearer(provider)).toBe(TOKEN);
      },
    );

    it.each([
      [
        'another host',
        {
          issuedFor: 'https://other.example.com:443/sap/bc/adt?sap-client=100',
        },
        {},
      ],
      [
        'another client',
        { issuedFor: 'https://abap.example.com:443/sap/bc/adt?sap-client=200' },
        {},
      ],
      ['issuedFor absent', {}, {}],
      [
        'serviceUrl absent from the means',
        { issuedFor: FOR },
        { serviceUrl: undefined },
      ],
    ] as [string, Partial<IConfig>, Partial<IConnectionConfig>][])(
      'an issuedFor that does not match (%s) → DestinationConfigError naming issuedFor',
      async (_label, binding, conn) => {
        const error = await refusal(
          noneBroker(
            'jwt',
            { authorizationToken: TOKEN, ...binding },
            conn,
          ).getProvider(D),
        );
        expect(error.missingFields).toEqual(['issuedFor']);
        const all = everythingIn(error);
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain('example.com');
      },
    );

    const ISSUER = {
      uaaUrl: 'https://uaa.example.com',
      uaaClientId: CLIENT_ID,
      uaaClientSecret: '',
    };

    it('an issuer stated by the client and a canonical-equal issuedBy → presented', async () => {
      const provider = await noneBroker(
        'jwt',
        {
          authorizationToken: TOKEN,
          issuedFor: FOR,
          issuedBy: 'HTTPS://uaa.example.com:443/?client_id=sb-broker!t42',
        },
        {},
        ISSUER,
      ).getProvider(D);

      expect(await bearer(provider)).toBe(TOKEN);
    });

    it.each([
      ['another client id', 'https://uaa.example.com:443?client_id=sb-other'],
      [
        'another issuer',
        'https://uaa.other.example.com:443?client_id=sb-broker%21t42',
      ],
      ['issuedBy absent', undefined],
    ])(
      'an issuer stated by the client and issuedBy not matching (%s) → DestinationConfigError naming issuedBy',
      async (_label, issuedBy) => {
        const error = await refusal(
          noneBroker(
            'jwt',
            {
              authorizationToken: TOKEN,
              issuedFor: FOR,
              ...(issuedBy ? { issuedBy } : {}),
            },
            {},
            ISSUER,
          ).getProvider(D),
        );
        expect(error.missingFields).toEqual(['issuedBy']);
        expect(everythingIn(error)).not.toContain('example.com');
      },
    );

    it('an issuer stated by oidcIssuerUrl is compared, with the client id', async () => {
      const broker = (issuedBy: string) =>
        noneBroker(
          'jwt',
          { authorizationToken: TOKEN, issuedFor: FOR, issuedBy },
          { oidcIssuerUrl: 'https://idp.example.com/realms/r/' },
          {
            uaaUrl: 'https://uaa.example.com',
            uaaClientId: 'app',
            uaaClientSecret: '',
          },
        );

      expect(
        await bearer(
          await broker(
            'https://idp.example.com:443/realms/r?client_id=app',
          ).getProvider(D),
        ),
      ).toBe(TOKEN);
      const error = await refusal(
        broker('https://uaa.example.com:443?client_id=app').getProvider(D),
      );
      expect(error.missingFields).toEqual(['issuedBy']);
    });
  });

  describe('saml / none', () => {
    const COOKIES = 'MYSAPSSO2=handed-over';

    it('no samlAcsUrl in the means and a matching issuedFor → presented, whatever issuedBy', async () => {
      const provider = await noneBroker('saml', {
        sessionCookies: COOKIES,
        issuedFor: FOR,
        issuedBy: 'https://elsewhere.example.com:443/acs',
      }).getProvider(D);

      const cookies: string[] = [];
      expect(
        await provider.authorize({
          header: () => {},
          cookies: (c) => cookies.push(c),
        }),
      ).toEqual({ ok: true });
      expect(cookies).toEqual([COOKIES]);
    });

    it('samlAcsUrl stated: an ACS stored with a query and another case → presented', async () => {
      const provider = await noneBroker(
        'saml',
        {
          sessionCookies: COOKIES,
          issuedFor: FOR,
          issuedBy:
            'https://ABAP.example.com:443/sap/saml2/sp/acs/100/?saml2=disabled',
        },
        { samlAcsUrl: SAML_ACS },
      ).getProvider(D);

      const cookies: string[] = [];
      await provider.authorize({
        header: () => {},
        cookies: (c) => cookies.push(c),
      });
      expect(cookies).toEqual([COOKIES]);
    });

    it.each([
      ['another ACS', 'https://abap.example.com:443/sap/saml2/sp/acs/200'],
      ['issuedBy absent', undefined],
    ])(
      'samlAcsUrl stated and issuedBy not matching (%s) → DestinationConfigError naming issuedBy',
      async (_label, issuedBy) => {
        const error = await refusal(
          noneBroker(
            'saml',
            {
              sessionCookies: COOKIES,
              issuedFor: FOR,
              ...(issuedBy ? { issuedBy } : {}),
            },
            { samlAcsUrl: SAML_ACS },
          ).getProvider(D),
        );
        expect(error.missingFields).toEqual(['issuedBy']);
        expect(everythingIn(error)).not.toContain(COOKIES);
      },
    );

    it('an issuedFor that does not match → DestinationConfigError naming issuedFor', async () => {
      const error = await refusal(
        noneBroker('saml', {
          sessionCookies: COOKIES,
          issuedFor: 'https://other.example.com:443/sap/bc/adt?sap-client=100',
        }).getProvider(D),
      );
      expect(error.missingFields).toEqual(['issuedFor']);
    });
  });
});

describe('bindingOf: the binding a consumer writes beside a credential it hands over', () => {
  // One function behind persist and getProvider's check: these cases pin that
  // what bindingOf answers is what persist writes and what the check accepts.
  it.each([['client_credentials'], ['authorization_code'], ['passcode']])(
    '%s: equals the binding persist writes for the same means and client',
    async (grant) => {
      const { broker: b, store } = broker(grant, null);
      await (await b.getProvider(D)).prepare();
      await b.flush();
      const [, written] = store.saveSession.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(bindingOf(means(grant), client())).toEqual({
        issuedFor: written.issuedFor,
        issuedBy: written.issuedBy,
      });
    },
  );

  it('a none destination: the SAP client is part of the resource', () => {
    expect(
      bindingOf({
        authType: 'saml',
        grantType: 'none',
        serviceUrl: SERVICE_URL,
        sapClient: '100',
      }),
    ).toEqual({ issuedFor: FOR });
  });

  it.each([
    ['saml', { authType: 'saml' as const }],
    [
      'jwt with a client',
      { authType: 'jwt' as const, oidcIssuerUrl: undefined },
    ],
  ])(
    'a none %s credential written with it is presented by getProvider',
    async (_, extra) => {
      const stated = means('none', extra);
      const auth = extra.authType === 'jwt' ? client() : null;
      const credential =
        extra.authType === 'jwt'
          ? { authorizationToken: jwtExpiringIn(3600) }
          : { sessionCookies: 'SAP_SESSIONID=abc' };
      const { broker: b } = broker(
        'none',
        {
          ...credential,
          ...bindingOf(stated, auth),
        },
        { conn: stated, auth },
      );
      await expect(b.getProvider(D)).resolves.toBeDefined();
    },
  );

  it('a none credential bound without the SAP client is refused, naming issuedFor', async () => {
    const stated = means('none', { authType: 'saml' });
    const { broker: b } = broker(
      'none',
      {
        sessionCookies: 'SAP_SESSIONID=abc',
        ...bindingOf({ ...stated, sapClient: undefined }),
      },
      { conn: stated, auth: null },
    );
    const refusal = await b.getProvider(D).catch((error) => error);
    expect(refusal).toBeInstanceOf(DestinationConfigError);
    expect((refusal as DestinationConfigError).missingFields).toEqual([
      'issuedFor',
    ]);
  });

  it('a destination that states no jwt / saml grant binds nothing', () => {
    expect(bindingOf({ authType: 'basic', serviceUrl: SERVICE_URL })).toEqual(
      {},
    );
    expect(bindingOf({ authType: 'jwt', serviceUrl: SERVICE_URL })).toEqual({});
  });
});
