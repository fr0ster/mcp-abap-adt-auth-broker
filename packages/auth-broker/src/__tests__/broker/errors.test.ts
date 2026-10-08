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
} from '../../index';
import { fakeKeyStore, fakeSessionStore } from '../helpers/fakeStores';

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
