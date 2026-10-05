/**
 * The client-authentication strategy: the two shipped factories, the context
 * the broker hands a strategy, and the guard that turns any throw of a
 * strategy into a `DestinationConfigError` in fixed words.
 *
 * The factories run the real auth-providers 5.3.0 `tlsClientCertificate` and
 * `clientSecretBasic` — nothing of auth-providers is mocked. The certificate is
 * a throwaway self-signed one (`../fixtures/certificates`). The stores are
 * in-memory fakes of the contract.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { CertificateMaterialError } from '@mcp-abap-adt/auth-providers';
import type {
  IClientAuthentication,
  ITokenRequestDraft,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IClientCertificate,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  AuthBroker,
  type ClientAuthenticationContext,
  DestinationConfigError,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '../../index';

const D = 'X509';
const FIXTURES = join(__dirname, '..', 'fixtures', 'certificates');
const CERT = readFileSync(join(FIXTURES, 'client.crt'), 'utf8');
const KEY = readFileSync(join(FIXTURES, 'client.key'), 'utf8');
/** A value no error, message or log line may ever carry. */
const MARKER = 'MARKER-must-not-leak-7f3a';

const CERTIFICATE: IClientCertificate = {
  uaaUrl: 'https://tenant.authentication.example.com',
  clientId: 'sb-x509-client',
  certificate: CERT,
  key: KEY,
  certUrl: 'https://tenant.authentication.cert.example.com',
};

const SECRET_CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://tenant.authentication.example.com',
  uaaClientId: 'sb-secret-client',
  uaaClientSecret: 'a+b%c',
};

const DRAFT: ITokenRequestDraft = {
  endpoint: 'https://tenant.authentication.example.com/oauth/token',
  clientId: 'sb-x509-client',
  grantType: 'client_credentials',
};

function context(
  extra: Partial<ClientAuthenticationContext> = {},
): ClientAuthenticationContext {
  return {
    destination: D,
    grant: 'client_credentials',
    client: null,
    readCertificate: async () => CERTIFICATE,
    ...extra,
  };
}

const means: IConnectionConfig = {
  authType: 'jwt',
  grantType: 'client_credentials',
  serviceUrl: 'https://abap.example.com',
};

/** A key store; `certificate` absent leaves `getClientCertificate` out. */
function keyStore(
  client: IAuthorizationConfig | null,
  certificate?: () => Promise<IClientCertificate | null>,
  stated: IConnectionConfig = means,
): jest.Mocked<IServiceKeyStore> {
  const store: jest.Mocked<IServiceKeyStore> = {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => client),
    getConnectionConfig: jest.fn(async (_d: string) => stated),
  };
  if (certificate) {
    store.getClientCertificate = jest.fn(async (_d: string) => certificate());
  }
  return store;
}

function sessionStore(): jest.Mocked<ISessionStore> {
  return {
    loadSession: jest.fn(async (_d: string) => null),
    saveSession: jest.fn(async (_d: string, _c: unknown) => {}),
    getAuthorizationConfig: jest.fn(async (_d: string) => null),
    getConnectionConfig: jest.fn(async (_d: string) => null),
    setAuthorizationConfig: jest.fn(
      async (_d: string, _c: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_d: string, _c: IConnectionConfig) => {},
    ),
    deleteSession: jest.fn(async (_d: string) => {}),
  };
}

function recordingLogger(): { logger: ILogger; lines: () => string } {
  const seen: unknown[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      seen.push(level, ...args);
  return {
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
    lines: () => inspect(seen, { depth: 10 }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

/** Everything an error could show: message, String, stack, every own field, inspect. */
function everythingIn(error: unknown): string {
  const e = error as Record<string, unknown>;
  const parts = [String(error), (error as Error).stack, inspect(error)];
  for (const name of Object.getOwnPropertyNames(e)) {
    parts.push(JSON.stringify(e[name]));
  }
  return parts.join('\n');
}

/** The guard's error: a DestinationConfigError naming clientAuthentication, no cause. */
function expectGuarded(error: unknown, words: string): void {
  expect(error).toBeInstanceOf(DestinationConfigError);
  const e = error as DestinationConfigError;
  expect(e.destination).toBe(D);
  expect(e.missingFields).toEqual(['clientAuthentication']);
  expect(e.message).toBe(`Destination "${D}": ${words} (clientAuthentication)`);
  expect('cause' in e).toBe(false);
}

describe('fromServiceKeyCertificate()', () => {
  it('answers tls_client_auth against certUrl + /oauth/token with the key’s PEM, unchanged', async () => {
    const auth = await fromServiceKeyCertificate()(context());
    expect(await auth.authenticate(DRAFT)).toEqual({
      endpoint: 'https://tenant.authentication.cert.example.com/oauth/token',
      parameters: { client_id: 'sb-x509-client' },
    });
    expect(await auth.tlsMaterial?.()).toEqual({ cert: CERT, key: KEY });
  });

  it('throws "the destination has no client certificate" when the store answers null', async () => {
    const error = await rejection(
      fromServiceKeyCertificate()(
        context({ readCertificate: async () => null }),
      ),
    );
    expect((error as Error).message).toBe(
      'the destination has no client certificate',
    );
  });

  it('refuses a malformed PEM before answering — the material is checked inside the factory', async () => {
    const readCertificate = async () => ({
      ...CERTIFICATE,
      certificate: `-----BEGIN CERTIFICATE-----\n${MARKER}\n-----END CERTIFICATE-----\n`,
      key: `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`,
    });
    const error = await rejection(
      fromServiceKeyCertificate()(context({ readCertificate })),
    );
    expect(everythingIn(error)).not.toContain(MARKER);
  });
});

describe('fromServiceKeySecret({ encoding })', () => {
  it("answers client_secret_basic with the id and secret as given for 'raw'", async () => {
    const auth = await fromServiceKeySecret({ encoding: 'raw' })(
      context({ client: SECRET_CLIENT }),
    );
    const answer = await auth.authenticate({
      ...DRAFT,
      clientId: 'sb-secret-client',
    });
    expect(answer.headers?.Authorization).toBe(
      `Basic ${Buffer.from('sb-secret-client:a+b%c').toString('base64')}`,
    );
  });

  it("answers client_secret_basic with each component form-encoded for 'form'", async () => {
    const auth = await fromServiceKeySecret({ encoding: 'form' })(
      context({ client: SECRET_CLIENT }),
    );
    const answer = await auth.authenticate({
      ...DRAFT,
      clientId: 'sb-secret-client',
    });
    expect(answer.headers?.Authorization).toBe(
      `Basic ${Buffer.from('sb-secret-client:a%2Bb%25c').toString('base64')}`,
    );
  });

  it('throws "the destination has no client secret" without a secret client', async () => {
    const error = await rejection(
      fromServiceKeySecret({ encoding: 'raw' })(context({ client: null })),
    );
    expect((error as Error).message).toBe(
      'the destination has no client secret',
    );
  });

  it('throws "the destination has no client secret" for an empty secret', async () => {
    const error = await rejection(
      fromServiceKeySecret({ encoding: 'raw' })(
        context({ client: { ...SECRET_CLIENT, uaaClientSecret: '' } }),
      ),
    );
    expect((error as Error).message).toBe(
      'the destination has no client secret',
    );
  });

  it('requires encoding at run time too: none, or another value, is refused when the factory is made', () => {
    expect(() =>
      fromServiceKeySecret({} as unknown as { encoding: 'raw' }),
    ).toThrow("fromServiceKeySecret: encoding must be 'raw' or 'form'");
    expect(() =>
      fromServiceKeySecret({ encoding: 'base64' } as unknown as {
        encoding: 'raw';
      }),
    ).toThrow("fromServiceKeySecret: encoding must be 'raw' or 'form'");
    expect(() =>
      fromServiceKeySecret(undefined as unknown as { encoding: 'raw' }),
    ).toThrow("fromServiceKeySecret: encoding must be 'raw' or 'form'");
  });
});

describe('getProvider with a clientAuthentication strategy: the context', () => {
  it('reads the certificate only when the strategy asks, and once per build however often it asks', async () => {
    const store = keyStore(SECRET_CLIENT, async () => CERTIFICATE);
    const seen: ClientAuthenticationContext[] = [];
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: store,
      clientAuthentication: async (ctx) => {
        seen.push(ctx);
        const a = await ctx.readCertificate();
        const b = await ctx.readCertificate();
        expect(b).toBe(a);
        return fromServiceKeySecret({ encoding: 'raw' })(ctx);
      },
    });
    await broker.getProvider(D);
    expect(store.getClientCertificate).toHaveBeenCalledTimes(1);
    expect(store.getClientCertificate).toHaveBeenCalledWith(D);
    expect(seen).toHaveLength(1);
    expect(seen[0].destination).toBe(D);
    expect(seen[0].grant).toBe('client_credentials');
    expect(seen[0].client).toEqual(SECRET_CLIENT);
  });

  it('reads no certificate for a strategy that does not ask', async () => {
    const store = keyStore(SECRET_CLIENT, async () => CERTIFICATE);
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: store,
      clientAuthentication: fromServiceKeySecret({ encoding: 'raw' }),
    });
    await broker.getProvider(D);
    expect(store.getClientCertificate).not.toHaveBeenCalled();
  });

  it('without a strategy calls nothing certificate-related (4.0.0)', async () => {
    const store = keyStore(SECRET_CLIENT, async () => CERTIFICATE);
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: store,
    });
    await broker.getProvider(D);
    expect(store.getClientCertificate).not.toHaveBeenCalled();
  });

  it('a store implementing no getClientCertificate: the certificate factory refuses in fixed words, the secret factory still works', async () => {
    const certificate = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: fromServiceKeyCertificate(),
    });
    expectGuarded(
      await rejection(certificate.getProvider(D)),
      'the clientAuthentication strategy refused: the destination has no client certificate',
    );

    const secret = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: fromServiceKeySecret({ encoding: 'raw' }),
    });
    await expect(secret.getProvider(D)).resolves.toBeDefined();
  });

  it('a store answering null: the certificate factory refuses in fixed words', async () => {
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT, async () => null),
      clientAuthentication: fromServiceKeyCertificate(),
    });
    expectGuarded(
      await rejection(broker.getProvider(D)),
      'the clientAuthentication strategy refused: the destination has no client certificate',
    );
  });

  it('a destination without a secret client: the secret factory refuses in fixed words', async () => {
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(null),
      clientAuthentication: fromServiceKeySecret({ encoding: 'raw' }),
    });
    expectGuarded(
      await rejection(broker.getProvider(D)),
      'the clientAuthentication strategy refused: the destination has no client secret',
    );
  });
});

describe('getProvider with a clientAuthentication strategy: the guard', () => {
  it('a throwing strategy: fixed words, no cause, nothing of the thrown value in the error or a log line', async () => {
    const { logger, lines } = recordingLogger();
    const thrown = new Error(`strategy failed: ${MARKER}`);
    (thrown as Error & { secret: string }).secret = MARKER;
    const broker = new AuthBroker(
      {
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore(SECRET_CLIENT),
        clientAuthentication: async () => {
          throw thrown;
        },
      },
      logger,
    );
    const error = await rejection(broker.getProvider(D));
    expectGuarded(error, 'the clientAuthentication strategy failed');
    expect(everythingIn(error)).not.toContain(MARKER);
    expect(lines()).not.toContain(MARKER);
  });

  it('a strategy throwing a non-Error (a string): the same fixed words', async () => {
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: async () => {
        throw MARKER;
      },
    });
    const error = await rejection(broker.getProvider(D));
    expectGuarded(error, 'the clientAuthentication strategy failed');
    expect(everythingIn(error)).not.toContain(MARKER);
  });

  it('a strategy answering something that is no client authentication: refused in fixed words', async () => {
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: async () =>
        ({ secret: MARKER }) as unknown as IClientAuthentication,
    });
    const error = await rejection(broker.getProvider(D));
    expectGuarded(
      error,
      'the clientAuthentication strategy answered no client authentication',
    );
    expect(everythingIn(error)).not.toContain(MARKER);
  });

  it('a malformed PEM through the real factory and provider: refused at build, not cached, the next getProvider rebuilds', async () => {
    const { logger, lines } = recordingLogger();
    let answers = 0;
    const store = keyStore(SECRET_CLIENT, async () => {
      answers++;
      return answers === 1
        ? {
            ...CERTIFICATE,
            certificate: `-----BEGIN CERTIFICATE-----\n${MARKER}\n-----END CERTIFICATE-----\n`,
            key: `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`,
          }
        : CERTIFICATE;
    });
    const broker = new AuthBroker(
      {
        sessionStore: sessionStore(),
        serviceKeyStore: store,
        clientAuthentication: fromServiceKeyCertificate(),
      },
      logger,
    );

    const error = await rejection(broker.getProvider(D));
    expectGuarded(
      error,
      'the clientAuthentication strategy refused: the client certificate could not be used',
    );
    expect(everythingIn(error)).not.toContain(MARKER);
    expect(lines()).not.toContain(MARKER);

    const provider = await broker.getProvider(D);
    expect(provider).toBeDefined();
    expect(store.getClientCertificate).toHaveBeenCalledTimes(2);
    // Built now, and kept: a third call reads nothing.
    await expect(broker.getProvider(D)).resolves.toBe(provider);
    expect(store.getClientCertificate).toHaveBeenCalledTimes(2);
  });

  it('concurrent getProvider while the strategy throws: one build, the same error to both, not cached, the next call retries', async () => {
    const strategy = jest.fn<
      Promise<IClientAuthentication>,
      [ClientAuthenticationContext]
    >(async () => {
      throw new Error(MARKER);
    });
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: strategy,
    });
    const [a, b] = await Promise.all([
      rejection(broker.getProvider(D)),
      rejection(broker.getProvider(D)),
    ]);
    expect(a).toBe(b);
    expectGuarded(a, 'the clientAuthentication strategy failed');
    expect(strategy).toHaveBeenCalledTimes(1);

    strategy.mockImplementationOnce(fromServiceKeySecret({ encoding: 'raw' }));
    await expect(broker.getProvider(D)).resolves.toBeDefined();
    expect(strategy).toHaveBeenCalledTimes(2);
  });
});

describe('the guard is total: nothing about the thrown value is trusted', () => {
  function brokerThrowing(thrown: () => unknown): AuthBroker {
    return new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT),
      clientAuthentication: async () => {
        throw thrown();
      },
    });
  }

  it('a thrown Proxy whose getPrototypeOf trap throws: the generic fixed words, no raw error', async () => {
    const error = await rejection(
      brokerThrowing(
        () =>
          new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error(MARKER);
              },
              get() {
                throw new Error(MARKER);
              },
            },
          ),
      ).getProvider(D),
    );
    expectGuarded(error, 'the clientAuthentication strategy failed');
    expect(everythingIn(error)).not.toContain(MARKER);
  });

  it('a CertificateMaterialError carrying its own words: the broker’s words, never the instance’s', async () => {
    const error = await rejection(
      brokerThrowing(() =>
        Object.defineProperty(new CertificateMaterialError(false), 'words', {
          value: { reason: MARKER, hint: MARKER },
        }),
      ).getProvider(D),
    );
    expectGuarded(
      error,
      'the clientAuthentication strategy refused: the client certificate could not be used',
    );
    expect(everythingIn(error)).not.toContain(MARKER);
  });

  it('a CertificateMaterialError whose words and flags are getters that throw: fixed words, no raw error', async () => {
    const error = await rejection(
      brokerThrowing(() => {
        const e = new CertificateMaterialError(true);
        for (const name of ['words', 'incomplete', 'expired']) {
          Object.defineProperty(e, name, {
            get() {
              throw new Error(MARKER);
            },
          });
        }
        return e;
      }).getProvider(D),
    );
    expectGuarded(error, 'the clientAuthentication strategy failed');
    expect(everythingIn(error)).not.toContain(MARKER);
  });

  it('chooses the certificate words by the flags: incomplete, expired', async () => {
    expectGuarded(
      await rejection(
        brokerThrowing(() => new CertificateMaterialError(true)).getProvider(D),
      ),
      'the clientAuthentication strategy refused: the client certificate is incomplete',
    );
    expectGuarded(
      await rejection(
        brokerThrowing(
          () => new CertificateMaterialError(false, true),
        ).getProvider(D),
      ),
      'the clientAuthentication strategy refused: the client certificate has expired',
    );
  });

  it('a factory’s own refusal rewritten by the consumer before rethrowing: the factory’s fixed words', async () => {
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keyStore(SECRET_CLIENT, async () => null),
      clientAuthentication: async (ctx) =>
        fromServiceKeyCertificate()(ctx).catch((e: unknown) => {
          Object.defineProperty(e, 'words', { value: MARKER });
          (e as Error).message = MARKER;
          throw e;
        }),
    });
    const error = await rejection(broker.getProvider(D));
    expectGuarded(
      error,
      'the clientAuthentication strategy refused: the destination has no client certificate',
    );
    expect(everythingIn(error)).not.toContain(MARKER);
  });
});

describe('which rows call the strategy, and with which grant', () => {
  const rowsWithoutClient: Array<[string, IConnectionConfig]> = [
    ['saml / saml2_pure', { authType: 'saml', grantType: 'saml2_pure' }],
    [
      'basic',
      {
        authType: 'basic',
        serviceUrl: 'https://abap.example.com',
        username: 'u',
        password: 'p',
      },
    ],
    ['snc', { authType: 'snc' }],
    [
      'jwt / none (handed over)',
      {
        authType: 'jwt',
        grantType: 'none',
        serviceUrl: 'https://a.example.com',
      },
    ],
    [
      'saml / none (handed over)',
      {
        authType: 'saml',
        grantType: 'none',
        serviceUrl: 'https://a.example.com',
      },
    ],
  ];

  it.each(rowsWithoutClient)(
    '%s never calls the strategy',
    async (_name, stated) => {
      const strategy = jest.fn(fromServiceKeySecret({ encoding: 'raw' }));
      const broker = new AuthBroker({
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore(
          SECRET_CLIENT,
          async () => CERTIFICATE,
          stated,
        ),
        clientAuthentication: strategy,
      });
      await Promise.allSettled([broker.getProvider(D)]);
      expect(strategy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['jwt', 'authorization_code'],
    ['jwt', 'passcode'],
    ['jwt', 'password'],
    ['jwt', 'device_code'],
    ['saml', 'saml2_bearer'],
  ] as const)(
    '%s / %s: the context names the stated grant',
    async (authType, grant) => {
      const grants: string[] = [];
      const broker = new AuthBroker({
        sessionStore: sessionStore(),
        serviceKeyStore: keyStore(SECRET_CLIENT, undefined, {
          authType,
          grantType: grant,
          serviceUrl: 'https://abap.example.com',
        }),
        clientAuthentication: async (ctx) => {
          grants.push(ctx.grant);
          return fromServiceKeySecret({ encoding: 'raw' })(ctx);
        },
      });
      await Promise.allSettled([broker.getProvider(D)]);
      expect(grants).toEqual([grant]);
    },
  );
});
