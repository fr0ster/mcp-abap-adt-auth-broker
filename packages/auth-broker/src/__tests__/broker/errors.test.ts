/**
 * §3 — what the broker relays, and how it reads a failure: through
 * auth-errors only, never by class, so a failure of another installed copy of
 * auth-errors reads the same; its own refusals carry the provider's error.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AuthProviderFailure,
  authError,
  isAuthProviderFailure,
  readFailure,
} from '@mcp-abap-adt/auth-errors';
import {
  createInMemoryReplayStore,
  refreshThenLogin,
  tlsClientCertificate,
} from '@mcp-abap-adt/auth-providers';
import type {
  IAuthProviderError,
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type { IConnectionConfig } from '@mcp-abap-adt/interfaces-auth-broker';
import {
  AuthBroker,
  type AuthBrokerConfig,
  DestinationConfigError,
  fromServiceKeyCertificate,
  isDestinationConfigError,
  SessionWriteFailure,
} from '../../index';
import { fakeKeyStore, fakeSessionStore } from '../helpers/fakeStores';

/**
 * Every value a broker slot's `start` resolves, as auth-errors' real
 * `sharedAttempt` receives it: the wrapper only records it (§7.1's outcome
 * shape is asserted on what it saw).
 */
const slotOutcomes: unknown[] = [];
jest.mock('@mcp-abap-adt/auth-errors', () => {
  const actual = jest.requireActual('@mcp-abap-adt/auth-errors');
  return {
    ...actual,
    sharedAttempt: (operation: string) => {
      const slot = actual.sharedAttempt(operation);
      return Object.freeze({
        join: (
          start: (context: unknown) => Promise<unknown>,
          signal?: AbortSignal,
        ) =>
          slot.join(
            (context: unknown) =>
              start(context).then((outcome) => {
                slotOutcomes.push(outcome);
                return outcome;
              }),
            signal,
          ),
      });
    },
  };
});

const D = 'DEST';
const FIXTURES = join(__dirname, '..', 'fixtures', 'certificates');
const CERT = readFileSync(join(FIXTURES, 'client.crt'), 'utf8');
const KEY = readFileSync(join(FIXTURES, 'client.key'), 'utf8');
const EXPIRED_CERT = readFileSync(join(FIXTURES, 'expired.crt'), 'utf8');
const EXPIRED_KEY = readFileSync(join(FIXTURES, 'expired.key'), 'utf8');
const NOT_A_CERT =
  '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

const UAA_MEANS: IConnectionConfig = {
  authType: 'jwt',
  grantType: 'client_credentials',
  serviceUrl: 'https://abap.example.com',
};

/** Every option a token destination needs, stated. */
function stated(config: AuthBrokerConfig): AuthBrokerConfig {
  return {
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
    ...config,
  };
}

/** What the promise rejected with; fails the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (thrown: unknown) => thrown,
  );
}

/** A consumer provider instance whose every call rejects with `thrown`. */
function failingProvider(thrown: unknown): IRefreshableTokenProvider {
  return {
    getTokens: async () => {
      throw thrown;
    },
    refreshTokens: async () => {
      throw thrown;
    },
  };
}

const FAILURES: Array<[string, () => AuthProviderFailure]> = [
  [
    'configuration',
    () =>
      new AuthProviderFailure(
        authError.configuration({
          case: 'required-fields-missing' as const,
          fields: ['clientId' as const],
        }),
      ),
  ],
  [
    'request-failed',
    () =>
      new AuthProviderFailure(
        authError['request-failed']({
          operation: 'token-request',
          problem: 'refused',
        }),
      ),
  ],
  [
    'interactive-login',
    () =>
      new AuthProviderFailure(
        authError['interactive-login']({ outcome: 'aborted' }),
      ),
  ],
  [
    'credential-refused',
    () =>
      new AuthProviderFailure(
        authError['credential-refused']({ credential: 'refresh-token' }),
      ),
  ],
  [
    'unknown',
    () => new AuthProviderFailure(authError.unknown({ operation: 'refresh' })),
  ],
];

describe('a provider failure passes as the same object', () => {
  it.each(FAILURES)(
    '%s, from a consumer provider: getToken and refreshToken rethrow it unchanged',
    async (_kind, make) => {
      const failure = make();
      const broker = new AuthBroker(
        stated({
          sessionStore: fakeSessionStore({
            serviceUrl: 'https://abap.example.com',
          }),
          provider: failingProvider(failure),
        }),
      );
      expect(await rejection(broker.getToken(D))).toBe(failure);
      expect(await rejection(broker.refreshToken(D))).toBe(failure);
    },
  );

  it.each(FAILURES)(
    '%s, from a provider getProvider built: the token API rethrows it unchanged',
    async (_kind, make) => {
      const failure = make();
      const broker = new AuthBroker(
        stated({
          sessionStore: fakeSessionStore(),
          serviceKeyStore: fakeKeyStore(UAA_MEANS, {
            uaaUrl: 'https://uaa.example.com',
            uaaClientId: 'client',
            uaaClientSecret: 'secret',
          }),
        }),
      );
      const provider = (await broker.getProvider(
        D,
      )) as unknown as IRefreshableTokenProvider;
      jest.spyOn(provider, 'getTokens').mockRejectedValue(failure);
      jest.spyOn(provider, 'refreshTokens').mockRejectedValue(failure);
      expect(await rejection(broker.getToken(D))).toBe(failure);
      expect(await rejection(broker.refreshToken(D))).toBe(failure);
    },
  );
});

describe('a failure of a second copy of auth-errors, loaded from another path', () => {
  let dir: string;
  let second: any;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'auth-errors-copy-'));
    for (const name of ['auth-errors', 'interfaces-auth']) {
      const original = dirname(
        require.resolve(`@mcp-abap-adt/${name}/package.json`),
      );
      cpSync(original, join(dir, 'node_modules', '@mcp-abap-adt', name), {
        recursive: true,
      });
    }
    second = require(join(dir, 'node_modules', '@mcp-abap-adt', 'auth-errors'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is another class: no instanceof of this copy holds for it', () => {
    const failure = new second.AuthProviderFailure(
      second.authError['credential-refused']({ credential: 'refresh-token' }),
    );
    expect(failure instanceof AuthProviderFailure).toBe(false);
  });

  it('is relayed as it was thrown; isAuthProviderFailure and readFailure read its kind and facts', async () => {
    const failure = new second.AuthProviderFailure(
      second.authError['request-failed']({
        operation: 'token-request',
        problem: 'refused',
        status: 401,
      }),
    );
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore({
          serviceUrl: 'https://abap.example.com',
        }),
        provider: failingProvider(failure),
      }),
    );
    const thrown = await rejection(broker.getToken(D));
    expect(thrown).toBe(failure);
    expect(isAuthProviderFailure(thrown)).toBe(true);
    const error = readFailure(thrown, 'token-source');
    expect(error.kind).toBe('request-failed');
    expect(error.facts).toEqual({
      operation: 'token-request',
      problem: 'refused',
      status: 401,
    });
  });

  it('thrown by a clientAuthentication strategy: carried by kind and facts', async () => {
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore(),
        serviceKeyStore: fakeKeyStore(UAA_MEANS, {
          uaaUrl: 'https://uaa.example.com',
          uaaClientId: 'client',
          uaaClientSecret: 'secret',
        }),
        clientAuthentication: async () => {
          throw new second.AuthProviderFailure(
            second.authError['client-certificate']({ problem: 'expired' }),
          );
        },
      }),
    );
    const thrown = await rejection(broker.getProvider(D));
    expect(isDestinationConfigError(thrown)).toBe(true);
    const error = (thrown as DestinationConfigError).error;
    expect(error?.kind).toBe('client-certificate');
    expect(error?.facts).toEqual({ problem: 'expired' });
  });
});

describe('fromServiceKeyCertificate: the provider’s client-certificate error, carried', () => {
  /** The error auth-providers' own check gives this material. */
  async function providerError(
    cert: string,
    key: string,
  ): Promise<IAuthProviderError> {
    const thrown = await rejection(
      Promise.resolve(
        tlsClientCertificate({
          material: { cert, key },
          endpoint: 'https://cert.example.com/oauth/token',
        }).tlsMaterial?.(),
      ),
    );
    return readFailure(thrown, 'loading-certificate');
  }

  it.each([
    ['incomplete', CERT, ''],
    ['unusable', NOT_A_CERT, KEY],
    ['expired', EXPIRED_CERT, EXPIRED_KEY],
  ])('%s PEM', async (problem, certificate, key) => {
    const expected = await providerError(certificate, key);
    expect(expected.kind).toBe('client-certificate');
    expect(expected.facts).toEqual({ problem });
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore(),
        serviceKeyStore: fakeKeyStore(UAA_MEANS, null, {
          uaaUrl: 'https://uaa.example.com',
          clientId: 'client',
          certificate,
          key,
          certUrl: 'https://cert.example.com',
        }),
        clientAuthentication: fromServiceKeyCertificate(),
      }),
    );
    const thrown = await rejection(broker.getProvider(D));
    expect(thrown).toBeInstanceOf(DestinationConfigError);
    const error = thrown as DestinationConfigError;
    expect(error.missingFields).toEqual(['clientAuthentication']);
    expect(error.error).toEqual(expected);
    expect(error.message).toContain(expected.reason);
  });
});

describe('a provider’s refusal of the destination’s configuration', () => {
  it('SNC with an invalid sncQop names sncQop and carries the configuration error', async () => {
    const broker = new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: fakeKeyStore({
        authType: 'snc',
        sncPartnerName: 'p:CN=ABC',
        sncQop: '7',
      }),
    });
    const thrown = await rejection(broker.getProvider(D));
    expect(thrown).toBeInstanceOf(DestinationConfigError);
    const error = thrown as DestinationConfigError;
    expect(error.missingFields).toEqual(['sncQop']);
    expect(error.error?.kind).toBe('configuration');
    expect(error.message).not.toContain("'7'");
  });

  it('an unreadable SAML certificate names samlIdpCertificates and carries the validator’s error', async () => {
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore(),
        serviceKeyStore: fakeKeyStore({
          authType: 'saml',
          grantType: 'saml2_pure',
          samlIdpSsoUrl: 'https://idp.example.com/sso',
          samlSpEntityId: 'sp',
          samlIdpEntityId: 'idp',
          samlAcsUrl: 'https://abap.example.com/acs',
          samlIdpCertificates: ['bm90LWEtY2VydGlmaWNhdGU='],
        }),
        authorization: () => ({
          authorize: async () => {
            throw new Error('not called');
          },
        }),
        samlCookies: () => async () => 'cookie',
        assertionReplayStore: () => createInMemoryReplayStore(),
      }),
    );
    const thrown = await rejection(broker.getProvider(D));
    expect(thrown).toBeInstanceOf(DestinationConfigError);
    const error = thrown as DestinationConfigError;
    expect(error.missingFields).toEqual(['samlIdpCertificates']);
    expect(error.error?.kind).toBe('configuration');
    expect(error.error?.facts).toEqual({
      case: 'idp-certificate-invalid',
      fields: ['idpCertificates'],
    });
  });
});

describe('the broker’s own failures', () => {
  it('a consumer provider answering no token: request-failed, no-access-token', async () => {
    const empty: ITokenResult = {
      authorizationToken: '',
      authType: 'client_credentials',
    };
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore({
          serviceUrl: 'https://abap.example.com',
        }),
        provider: {
          getTokens: async () => empty,
          refreshTokens: async () => empty,
        },
      }),
    );
    const thrown = await rejection(broker.getToken(D));
    expect(isAuthProviderFailure(thrown)).toBe(true);
    const error = readFailure(thrown, 'unfamiliar-error');
    expect(error.kind).toBe('request-failed');
    expect(error.facts).toEqual({
      operation: 'token-source',
      problem: 'no-access-token',
    });
    expect(error.reason).toBe('the token source returned no access_token');
  });

  it('a store read failure reaches the caller as the store raised it', async () => {
    const storeError = Object.assign(new Error('the store’s own words'), {
      code: 'EACCES',
    });
    const keyStore = fakeKeyStore(UAA_MEANS);
    keyStore.getConnectionConfig.mockRejectedValue(storeError);
    const broker = new AuthBroker(
      stated({ sessionStore: fakeSessionStore(), serviceKeyStore: keyStore }),
    );
    expect(await rejection(broker.getProvider(D))).toBe(storeError);
    expect(await rejection(broker.getToken(D))).toBe(storeError);
  });
});

describe('isDestinationConfigError', () => {
  const real = new DestinationConfigError(D, ['authType'], 'fixed words');

  it('is true for the class and for its JSON copy', () => {
    expect(isDestinationConfigError(real)).toBe(true);
    expect(isDestinationConfigError(JSON.parse(JSON.stringify(real)))).toBe(
      true,
    );
  });

  it('is false for look-alikes missing a field, a getter, or anything else', () => {
    const copy = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
    for (const field of ['name', 'code', 'destination', 'missingFields']) {
      const lookAlike = { ...copy };
      delete lookAlike[field];
      expect(isDestinationConfigError(lookAlike)).toBe(false);
    }
    expect(isDestinationConfigError({ ...copy, missingFields: [1] })).toBe(
      false,
    );
    expect(isDestinationConfigError({ ...copy, code: 'OTHER' })).toBe(false);
    const getter = { ...copy };
    Object.defineProperty(getter, 'name', {
      get: () => 'DestinationConfigError',
      enumerable: true,
    });
    expect(isDestinationConfigError(getter)).toBe(false);
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(isDestinationConfigError(hostile)).toBe(false);
    expect(isDestinationConfigError(null)).toBe(false);
    expect(isDestinationConfigError('DestinationConfigError')).toBe(false);
  });
});

describe('error identity through the shared slots (§7.1, §7.5)', () => {
  /** A manual promise. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  async function turns(count = 20): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** A key store whose first means read waits for `held`. */
  function heldKeyStore(held: Promise<void>, means = UAA_MEANS) {
    const store = fakeKeyStore(means, {
      uaaUrl: 'https://uaa.example.com',
      uaaClientId: 'client',
      uaaClientSecret: 'secret',
    });
    store.getConnectionConfig.mockImplementationOnce(async () => {
      await held;
      return means;
    });
    return store;
  }

  it('a DestinationConfigError thrown in the build reaches two waiters as that object', async () => {
    const held = gate();
    const strategyFailure = new AuthProviderFailure(
      authError['client-certificate']({ problem: 'incomplete' }),
    );
    const broker = new AuthBroker(
      stated({
        sessionStore: fakeSessionStore(),
        serviceKeyStore: heldKeyStore(held.promise),
        clientAuthentication: async () => {
          throw strategyFailure;
        },
      }),
    );
    const first = rejection(broker.getProvider(D));
    const second = rejection(broker.getProvider(D));
    await turns();
    held.open();
    const [a, b] = await Promise.all([first, second]);

    expect(b).toBe(a);
    expect(a).toBeInstanceOf(DestinationConfigError);
    const error = a as DestinationConfigError;
    expect(error.destination).toBe(D);
    expect(error.missingFields).toEqual(['clientAuthentication']);
    expect(error.error).toEqual(
      readFailure(strategyFailure, 'unfamiliar-error'),
    );
  });

  it('a store’s own read error reaches two waiters as the store’s object', async () => {
    const held = gate();
    const own = Object.assign(new Error('the key store is broken'), {
      code: 'EIO',
    });
    const store = fakeKeyStore(UAA_MEANS);
    store.getConnectionConfig.mockImplementationOnce(async () => {
      await held.promise;
      throw own;
    });
    const broker = new AuthBroker(
      stated({ sessionStore: fakeSessionStore(), serviceKeyStore: store }),
    );
    const first = rejection(broker.getProvider(D));
    const second = rejection(broker.getProvider(D));
    await turns();
    held.open();
    expect(await first).toBe(own);
    expect(await second).toBe(own);
  });

  it('a provider’s AuthProviderFailure from a build reaches two waiters as that object', async () => {
    const held = gate();
    const failure = new AuthProviderFailure(
      authError['request-failed']({
        operation: 'token-request',
        problem: 'refused',
      }),
    );
    const sessionStore = fakeSessionStore();
    sessionStore.getConnectionConfig.mockImplementationOnce(async () => {
      await held.promise;
      return null;
    });
    const broker = new AuthBroker(
      stated({
        sessionStore,
        serviceKeyStore: fakeKeyStore(UAA_MEANS),
        provider: () => {
          throw failure;
        },
      }),
    );
    const first = rejection(broker.getToken(D));
    const second = rejection(broker.getToken(D));
    await turns();
    held.open();
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
  });

  it('flush()’s rejection is the AggregateError itself, to every waiter', async () => {
    const sessionStore = fakeSessionStore();
    sessionStore.saveSession.mockRejectedValue(
      Object.assign(new Error('disk full'), { code: 'EACCES' }),
    );
    const broker = new AuthBroker({
      onWriteFailure: 'continue',
      sessionStore,
      serviceKeyStore: fakeKeyStore(UAA_MEANS),
      provider: {
        getTokens: async (): Promise<ITokenResult> => ({
          authType: 'client_credentials',
          authorizationToken: 'T',
          expiresIn: 60,
        }),
        refreshTokens: async (): Promise<ITokenResult> => ({
          authType: 'client_credentials',
          authorizationToken: 'T',
          expiresIn: 60,
        }),
      },
    });
    await broker.getToken(D);

    const first = rejection(broker.flush());
    const second = rejection(broker.flush());
    const a = await first;
    expect(await second).toBe(a);
    expect(a).toBeInstanceOf(AggregateError);
    const errors = (a as AggregateError).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SessionWriteFailure);
    expect((errors[0] as SessionWriteFailure).destination).toBe(D);
  });

  it('a waiter that aborts still gets auth-errors’ aborted; the other gets the build’s error', async () => {
    const held = gate();
    const broker = new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: heldKeyStore(held.promise),
    });
    const leaving = new AbortController();
    const first = rejection(broker.getProvider(D, { signal: leaving.signal }));
    const second = rejection(broker.getProvider(D));
    await turns();
    leaving.abort();
    const aborted = await first;
    expect(isAuthProviderFailure(aborted)).toBe(true);
    expect(readFailure(aborted, 'unfamiliar-error')).toEqual(
      readFailure(
        new AuthProviderFailure(
          authError['interactive-login']({ outcome: 'aborted' }),
        ),
        'unfamiliar-error',
      ),
    );
    held.open();
    // No renewal / onWriteFailure: the build's own refusal, as it was made.
    expect(isDestinationConfigError(await second)).toBe(true);
  });

  it('every outcome a slot’s start resolves is frozen and has no then; so is its value', async () => {
    slotOutcomes.length = 0;
    const sessionStore = fakeSessionStore();
    const broker = new AuthBroker(
      stated({
        sessionStore,
        serviceKeyStore: fakeKeyStore({
          authType: 'basic',
          username: 'U',
          password: 'P',
        }),
      }),
    );
    await broker.getProvider(D);
    await rejection(
      new AuthBroker({
        sessionStore,
        serviceKeyStore: fakeKeyStore(UAA_MEANS),
      }).getProvider(D),
    );
    await broker.flush();
    expect(slotOutcomes.length).toBeGreaterThanOrEqual(3);
    for (const outcome of slotOutcomes) {
      expect(typeof outcome).toBe('object');
      expect(Object.isFrozen(outcome)).toBe(true);
      expect('then' in (outcome as object)).toBe(false);
      const value = (outcome as { ok: boolean; value?: unknown }).value;
      if (value !== undefined && typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        expect('then' in value).toBe(false);
      }
    }
    const kinds = slotOutcomes.map((o) => (o as { ok: boolean }).ok);
    expect(kinds).toContain(true);
    expect(kinds).toContain(false);
  });
});
