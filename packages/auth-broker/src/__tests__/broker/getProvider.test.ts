/**
 * getProvider for the destinations that renew nothing — `basic`, `snc`,
 * `jwt`/`none`, `saml`/`none` — and the error a destination that lacks what
 * its type needs gets.
 *
 * The stores are in-memory fakes of the contract; the providers are real
 * (auth-providers 5.1) and are only ever driven through `IAuthProvider`:
 * nothing here branches on, or asserts, the class `getProvider` returned.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { authError } from '@mcp-abap-adt/auth-errors';
import type {
  AuthOutcome,
  IAuthProvider,
  ILogonTarget,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AuthBroker, DestinationConfigError } from '../../index';
import { STATED } from '../helpers/stated';

/** Planted in every stored value that is a secret; must never surface in an error. */
const SENTINEL = 'S3NTINEL-must-not-leak';

const OK: AuthOutcome = { ok: true };

/** A `none` destination's resource, and the canonical `issuedFor` its session holds. */
const RESOURCE = 'https://abap.example.com';
const BOUND_TO = 'https://abap.example.com:443';

/** A key store holding means only: three getters, no way to write. */
function keyStore(
  conn: IConnectionConfig | null,
  auth: IAuthorizationConfig | null = null,
): jest.Mocked<IServiceKeyStore> {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => auth),
    getConnectionConfig: jest.fn(async (_d: string) => conn),
  };
}

/** A session store whose every write is a spy that must stay uncalled in 4b. */
function sessionStore(
  session: IConfig | null = null,
): jest.Mocked<ISessionStore> {
  return {
    loadSession: jest.fn(async (_d: string) => session),
    saveSession: jest.fn(async (_d: string, _c: unknown) => {}),
    getAuthorizationConfig: jest.fn(async (_d: string) =>
      session?.uaaUrl
        ? {
            uaaUrl: session.uaaUrl,
            uaaClientId: session.uaaClientId ?? '',
            uaaClientSecret: session.uaaClientSecret ?? '',
          }
        : null,
    ),
    getConnectionConfig: jest.fn(async (_d: string) => session),
    setAuthorizationConfig: jest.fn(
      async (_d: string, _c: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_d: string, _c: IConnectionConfig) => {},
    ),
    deleteSession: jest.fn(async (_d: string) => {}),
  };
}

function expectNoWrites(store: jest.Mocked<ISessionStore>): void {
  expect(store.saveSession).not.toHaveBeenCalled();
  expect(store.setAuthorizationConfig).not.toHaveBeenCalled();
  expect(store.setConnectionConfig).not.toHaveBeenCalled();
  expect(store.deleteSession).not.toHaveBeenCalled();
}

/** What a provider put on one request. */
async function presented(provider: IAuthProvider): Promise<{
  outcome: AuthOutcome;
  headers: Record<string, string>;
  cookies: string[];
}> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  const request: IRequestTarget = {
    header: (name, value) => {
      headers[name] = value;
    },
    cookies: (value) => {
      cookies.push(value);
    },
  };
  const outcome = await provider.authorize(request);
  return { outcome, headers, cookies };
}

/** What a provider handed a logon. */
async function offered(provider: IAuthProvider): Promise<{
  outcome: AuthOutcome;
  parameters: Record<string, string>[];
}> {
  const parameters: Record<string, string>[] = [];
  const logon: ILogonTarget = {
    tlsMaterial: () => ({
      ok: false,
      refusal: authError['logon-target']({
        wire: 'rfc',
        refused: 'tls-material',
      }),
    }),
    logonParameters: (p) => {
      parameters.push({ ...p });
      return OK;
    },
  };
  const outcome = await provider.establish(logon);
  return { outcome, parameters };
}

/** Everything an error carries, as one string: message, and every own property. */
function everythingIn(error: unknown): string {
  const e = error as Record<string, unknown>;
  const parts = [
    String(error),
    (error as Error).message,
    (error as Error).stack,
  ];
  for (const name of Object.getOwnPropertyNames(e)) {
    const value = e[name];
    parts.push(
      value instanceof Error
        ? `${value.message} ${value.stack} ${JSON.stringify(value)}`
        : JSON.stringify(value),
    );
  }
  return parts.join('\n');
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

/** A file whose first bytes are an ELF header for this process's architecture. */
function hostArchLibrary(dir: string): string {
  const machine: Record<string, number> = {
    x64: 0x3e,
    arm64: 0xb7,
    ia32: 0x03,
  };
  const head = Buffer.alloc(64);
  head.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  head[4] = process.arch === 'ia32' ? 1 : 2; // class
  head[5] = 1; // little endian
  head.writeUInt16LE(machine[process.arch] ?? 0, 0x12);
  const file = path.join(dir, 'libsapcrypto.so');
  fs.writeFileSync(file, head);
  return file;
}

describe('getProvider', () => {
  describe('basic', () => {
    it('writes the Basic header and offers user and password', async () => {
      const store = sessionStore();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore({
          authType: 'basic',
          serviceUrl: 'https://abap.example.com',
          username: 'DEVELOPER',
          password: SENTINEL,
        }),
      });

      const provider = await broker.getProvider('D');

      expect(await provider.prepare()).toEqual(OK);
      const request = await presented(provider);
      expect(request.outcome).toEqual(OK);
      expect(request.headers.Authorization).toBe(
        `Basic ${Buffer.from(`DEVELOPER:${SENTINEL}`).toString('base64')}`,
      );
      expect(request.cookies).toEqual([]);
      const logon = await offered(provider);
      expect(logon.parameters).toEqual([
        { user: 'DEVELOPER', passwd: SENTINEL },
      ]);
      expectNoWrites(store);
    });

    it('never reads the session: a stored token beside it is not presented', async () => {
      // The type the destination states decides, not the fields beside it.
      const store = sessionStore({
        authorizationToken: 'stray-token',
        sessionCookies: 'stray=cookie',
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore({
          authType: 'basic',
          username: 'DEVELOPER',
          password: 'pw',
          sessionCookies: 'key=cookie',
          authorizationToken: 'key-token',
          grantType: 'none',
        }),
      });

      const request = await presented(await broker.getProvider('D'));

      expect(request.headers.Authorization).toMatch(/^Basic /);
      expect(request.cookies).toEqual([]);
      expect(store.loadSession).not.toHaveBeenCalled();
    });

    it.each([
      [{ username: 'U' }, ['password']],
      [{ password: SENTINEL }, ['username']],
      [{}, ['username', 'password']],
      [{ username: '', password: '' }, ['username', 'password']],
    ])('without %j names %j', async (fields, missing) => {
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore(),
          serviceKeyStore: keyStore({ authType: 'basic', ...fields }),
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(missing);
      expect(error.destination).toBe('D');
      expect(everythingIn(error)).not.toContain(SENTINEL);
    });
  });

  describe('snc', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-snc-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('hands over the SNC logon parameters after prepare()', async () => {
      const sncLib = hostArchLibrary(dir);
      const store = sessionStore();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore({
          authType: 'snc',
          sncPartnerName: 'p:CN=SID, O=ACME',
          sncQop: '3',
          sncLib,
          sncMyName: 'p:CN=ME, O=ACME',
        }),
      });

      const provider = await broker.getProvider('D');

      expect(await provider.prepare()).toEqual(OK);
      const logon = await offered(provider);
      expect(logon.outcome).toEqual(OK);
      expect(logon.parameters).toEqual([
        {
          snc_mode: '1',
          snc_partnername: 'p:CN=SID, O=ACME',
          snc_qop: '3',
          snc_lib: sncLib,
          snc_myname: 'p:CN=ME, O=ACME',
        },
      ]);
      expectNoWrites(store);
      expect(store.loadSession).not.toHaveBeenCalled();
      // On Windows prepare() asks the registry whether the library is the
      // Secure Login Client's: two `reg.exe` queries, each allowed 5 s before
      // the value counts as absent (auth-providers' SncSystem). Usually ~0.1 s,
      // but one slow process start reached Jest's default 5 s. Elsewhere no
      // process is started.
    }, 15_000);

    it('refuses a missing sncLib file at prepare(), naming sncLib', async () => {
      const missing = path.join(dir, 'no-such-library.so');
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore({
          authType: 'snc',
          sncPartnerName: 'p:CN=SID',
          sncLib: missing,
        }),
      });

      const outcome = await (await broker.getProvider('D')).prepare();

      expect(outcome.ok).toBe(false);
      // 6.0.0: the facts name the candidate; its path is a diagnostic.
      const refused = outcome.ok === false ? outcome.refusal : undefined;
      expect(refused?.kind).toBe('snc');
      expect(refused?.facts).toEqual(
        expect.objectContaining({
          problem: 'library-not-found',
          candidates: [{ source: 'sncLib', reason: 'missing' }],
        }),
      );
      expect(refused?.reason).toContain('sncLib (missing)');
    });

    it.each([[{}], [{ sncPartnerName: '' }]])(
      'without sncPartnerName (%j) names it',
      async (fields) => {
        const error = await refusal(
          new AuthBroker({
            ...STATED,
            sessionStore: sessionStore(),
            serviceKeyStore: keyStore({
              authType: 'snc',
              sncLib: '/x',
              password: SENTINEL,
              ...fields,
            }),
          }).getProvider('D'),
        );
        expect(error.missingFields).toEqual(['sncPartnerName']);
        expect(error.cause).toBeUndefined();
        expect(everythingIn(error)).not.toContain(SENTINEL);
      },
    );

    it("turns the provider's own ValidationError into one naming sncQop, and carries none of its text", async () => {
      const QOP_SENTINEL = 'S3NTINEL-qop-must-not-leak';
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore(),
          serviceKeyStore: keyStore({
            authType: 'snc',
            sncPartnerName: 'p:CN=SID',
            sncQop: QOP_SENTINEL,
            password: SENTINEL,
          }),
        }).getProvider('D'),
      );

      expect(error.missingFields).toEqual(['sncQop']);
      // The provider's own message quotes the value it refused, so it is not
      // carried — as cause or anywhere else.
      expect(error.cause).toBeUndefined();
      expect(everythingIn(error)).not.toContain(QOP_SENTINEL);
      expect(everythingIn(error)).not.toContain(SENTINEL);
    });
  });

  describe('none', () => {
    it('jwt/none presents the token the session store holds', async () => {
      const store = sessionStore({
        authorizationToken: 'stored-token',
        expiresAt: Date.now() + 60_000,
        issuedFor: BOUND_TO,
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore({
          authType: 'jwt',
          grantType: 'none',
          serviceUrl: RESOURCE,
        }),
      });

      const provider = await broker.getProvider('D');

      expect(await provider.prepare()).toEqual(OK);
      const request = await presented(provider);
      expect(request.headers).toEqual({ Authorization: 'Bearer stored-token' });
      expect(request.cookies).toEqual([]);
      expectNoWrites(store);
    });

    it('saml/none presents the cookies the session store holds', async () => {
      const store = sessionStore({
        sessionCookies: 'MYSAPSSO2=stored',
        issuedFor: BOUND_TO,
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keyStore({
          authType: 'saml',
          grantType: 'none',
          serviceUrl: RESOURCE,
        }),
      });

      const provider = await broker.getProvider('D');

      expect(await provider.prepare()).toEqual(OK);
      const request = await presented(provider);
      expect(request.cookies).toEqual(['MYSAPSSO2=stored']);
      expect(request.headers).toEqual({});
      expectNoWrites(store);
    });

    it.each([
      ['jwt', 'authorizationToken', null],
      ['jwt', 'authorizationToken', { authorizationToken: '' }],
      ['jwt', 'authorizationToken', { sessionCookies: SENTINEL }],
      ['saml', 'sessionCookies', null],
      ['saml', 'sessionCookies', { sessionCookies: '' }],
      ['saml', 'sessionCookies', { authorizationToken: SENTINEL }],
    ] as const)(
      '%s/none without its credential in the session names %s (session %j)',
      async (authType, field, session) => {
        const error = await refusal(
          new AuthBroker({
            ...STATED,
            sessionStore: sessionStore(session),
            serviceKeyStore: keyStore({ authType, grantType: 'none' }),
          }).getProvider('D'),
        );
        expect(error.missingFields).toEqual([field]);
        expect(everythingIn(error)).not.toContain(SENTINEL);
      },
    );

    it('a session answering FILE_NOT_FOUND is no session', async () => {
      const store = sessionStore();
      store.loadSession.mockRejectedValue(
        Object.assign(new Error('no file'), { code: 'FILE_NOT_FOUND' }),
      );
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: store,
          serviceKeyStore: keyStore({ authType: 'jwt', grantType: 'none' }),
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['authorizationToken']);
    });

    it('a session store failing otherwise is passed on as it raised it', async () => {
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const store = sessionStore();
      store.loadSession.mockRejectedValue(denied);
      await expect(
        new AuthBroker({
          ...STATED,
          sessionStore: store,
          serviceKeyStore: keyStore({ authType: 'jwt', grantType: 'none' }),
        }).getProvider('D'),
      ).rejects.toBe(denied);
    });
  });

  describe('the split: means from the key store, the secret from the session', () => {
    it('ignores means a session store answers: a destination whose means only the session holds names authType', async () => {
      const store = sessionStore({
        authType: 'basic',
        grantType: 'none',
        serviceUrl: 'https://abap.example.com',
        username: 'DEVELOPER',
        password: SENTINEL,
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'client',
        uaaClientSecret: SENTINEL,
        authorizationToken: SENTINEL,
      });
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: store,
          serviceKeyStore: keyStore(null),
        }).getProvider('D'),
      );

      expect(error.missingFields).toEqual(['authType']);
      expect(everythingIn(error)).not.toContain(SENTINEL);
      expectNoWrites(store);
    });

    it('a key store answering FILE_NOT_FOUND is no means', async () => {
      const keys = keyStore(null);
      keys.getConnectionConfig.mockRejectedValue(
        Object.assign(new Error('no file'), { code: 'FILE_NOT_FOUND' }),
      );
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore({ authorizationToken: 't' }),
          serviceKeyStore: keys,
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['authType']);
    });

    it('passes on a key store failing otherwise, as it raised it', async () => {
      const broken = new Error('Invalid JSON in file "D.json"');
      const keys = keyStore(null);
      keys.getConnectionConfig.mockRejectedValue(broken);
      await expect(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore(),
          serviceKeyStore: keys,
        }).getProvider('D'),
      ).rejects.toBe(broken);
    });

    it('does not take a token the key store answers as a seed', async () => {
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore(null),
          serviceKeyStore: keyStore({
            authType: 'jwt',
            grantType: 'none',
            authorizationToken: SENTINEL,
          }),
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['authorizationToken']);
      expect(everythingIn(error)).not.toContain(SENTINEL);
    });

    it('does not take cookies the key store answers as a seed', async () => {
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore(null),
          serviceKeyStore: keyStore({
            authType: 'saml',
            grantType: 'none',
            sessionCookies: SENTINEL,
          }),
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['sessionCookies']);
    });

    it('presents the session secret, never the key store one, when both answer', async () => {
      const provider = await new AuthBroker({
        ...STATED,
        sessionStore: sessionStore({
          authorizationToken: 'from-session',
          issuedFor: BOUND_TO,
        }),
        serviceKeyStore: keyStore({
          authType: 'jwt',
          grantType: 'none',
          serviceUrl: RESOURCE,
          authorizationToken: 'from-key',
        }),
      }).getProvider('D');

      expect((await presented(provider)).headers.Authorization).toBe(
        'Bearer from-session',
      );
    });

    it('the key store offers no write, and the broker writes nothing anywhere', async () => {
      const keys = keyStore({
        authType: 'basic',
        username: 'U',
        password: 'P',
      });
      const store = sessionStore();
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keys,
      });

      const provider = await broker.getProvider('D');
      await provider.prepare();
      await presented(provider);
      await offered(provider);
      await provider.rejected({ at: 'request', status: 401, error: null });

      expect(Object.keys(keys).sort()).toEqual([
        'getAuthorizationConfig',
        'getConnectionConfig',
        'getServiceKey',
      ]);
      expectNoWrites(store);
    });
  });

  describe('DestinationConfigError', () => {
    it('names the serviceKeyStore option when there is none', async () => {
      const store = sessionStore({
        authType: 'basic',
        username: 'U',
        password: SENTINEL,
      });
      const error = await refusal(
        new AuthBroker({ ...STATED, sessionStore: store }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['serviceKeyStore']);
      expect(store.loadSession).not.toHaveBeenCalled();
      expect(everythingIn(error)).not.toContain(SENTINEL);
    });

    it('is the error class it says it is', async () => {
      const error = await refusal(
        new AuthBroker({ ...STATED, sessionStore: sessionStore() }).getProvider(
          'DEST-1',
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('DestinationConfigError');
      expect(error.code).toBe('DESTINATION_CONFIG');
      expect(error.destination).toBe('DEST-1');
      expect(error.message).toContain('DEST-1');
      expect(error.message).toContain('serviceKeyStore');
    });

    it.each([
      ['no means', null],
      [
        'no authType',
        { serviceUrl: 'https://x', username: 'U', password: SENTINEL },
      ],
      [
        'an empty authType',
        { authType: '', username: 'U', password: SENTINEL },
      ],
      [
        'an unknown authType',
        { authType: SENTINEL, username: 'U', password: 'P' },
      ],
    ])('names authType for %s', async (_case, conn) => {
      const error = await refusal(
        new AuthBroker({
          ...STATED,
          sessionStore: sessionStore({ authorizationToken: SENTINEL }),
          serviceKeyStore: keyStore(conn as IConnectionConfig | null),
        }).getProvider('D'),
      );
      expect(error.missingFields).toEqual(['authType']);
      expect(everythingIn(error)).not.toContain(SENTINEL);
    });

    it.each([
      ['jwt', undefined],
      ['jwt', ''],
      ['saml', undefined],
      ['saml', ''],
    ])(
      'names grantType for %s with grantType %j — no grant is guessed',
      async (authType, grantType) => {
        const error = await refusal(
          new AuthBroker({
            ...STATED,
            sessionStore: sessionStore({
              authorizationToken: SENTINEL,
              sessionCookies: SENTINEL,
            }),
            serviceKeyStore: keyStore({
              authType,
              grantType,
            } as IConnectionConfig),
          }).getProvider('D'),
        );
        expect(error.missingFields).toEqual(['grantType']);
        expect(everythingIn(error)).not.toContain(SENTINEL);
      },
    );

    it.each([
      ['jwt', 'saml2_pure'],
      ['jwt', 'saml2_bearer'],
      ['saml', 'authorization_code'],
      ['saml', 'client_credentials'],
      ['saml', 'passcode'],
      ['saml', 'oidc_authorization_code'],
      ['saml', 'device_code'],
      ['saml', 'password'],
      ['saml', 'token_exchange'],
      ['jwt', SENTINEL],
      ['saml', SENTINEL],
    ])(
      'refuses the pair %s / %s, naming grantType',
      async (authType, grantType) => {
        const error = await refusal(
          new AuthBroker({
            ...STATED,
            sessionStore: sessionStore({
              authorizationToken: 'token',
              sessionCookies: 'cookie',
            }),
            serviceKeyStore: keyStore({
              authType,
              grantType,
            } as IConnectionConfig),
          }).getProvider('D'),
        );
        expect(error.missingFields).toEqual(['grantType']);
        expect(everythingIn(error)).not.toContain(SENTINEL);
      },
    );

    it('does not read grantType for basic', async () => {
      const provider = await new AuthBroker({
        ...STATED,
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore({
          authType: 'basic',
          grantType: 'saml2_pure',
          username: 'U',
          password: 'P',
        }),
      }).getProvider('D');
      expect((await presented(provider)).headers.Authorization).toMatch(
        /^Basic /,
      );
    });
  });

  describe('cache', () => {
    it('builds once under concurrent first calls, and hands every caller the same provider', async () => {
      const keys = keyStore({
        authType: 'basic',
        username: 'U',
        password: 'P',
      });
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: sessionStore(),
        serviceKeyStore: keys,
      });

      const [a, b, c] = await Promise.all([
        broker.getProvider('D'),
        broker.getProvider('D'),
        broker.getProvider('D'),
      ]);

      expect(b).toBe(a);
      expect(c).toBe(a);
      expect(await broker.getProvider('D')).toBe(a);
      expect(keys.getConnectionConfig).toHaveBeenCalledTimes(1);
    });

    it('keeps one provider per destination', async () => {
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore({
          authType: 'basic',
          username: 'U',
          password: 'P',
        }),
      });
      expect(await broker.getProvider('A')).not.toBe(
        await broker.getProvider('B'),
      );
    });

    it('builds again on the next call after a build that threw', async () => {
      const keys = keyStore({
        authType: 'basic',
        username: 'U',
        password: 'P',
      });
      keys.getConnectionConfig.mockRejectedValueOnce(new Error('disk hiccup'));
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: sessionStore(),
        serviceKeyStore: keys,
      });

      const first = await Promise.allSettled([
        broker.getProvider('D'),
        broker.getProvider('D'),
      ]);
      expect(first.map((r) => r.status)).toEqual(['rejected', 'rejected']);

      const provider = await broker.getProvider('D');
      expect((await presented(provider)).headers.Authorization).toMatch(
        /^Basic /,
      );
      expect(keys.getConnectionConfig).toHaveBeenCalledTimes(2);
    });
  });
});
