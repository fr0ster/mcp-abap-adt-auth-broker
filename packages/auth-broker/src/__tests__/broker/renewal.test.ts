/**
 * §4 — renewal is the consumer's choice: `renewal(destination, grant)` is
 * called once per build of every token row and its answer reaches the
 * provider as it is; there is no default. §5.4's first paragraph — a
 * destination that writes a secret needs `onWriteFailure`, also without a
 * default.
 *
 * A renewal strategy that answers `stop` makes the provider decline at once
 * (`renewal-declined`) with nothing sent, so every row is driven without a
 * server, a browser or an identity provider.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import {
  createInMemoryReplayStore,
  refreshOnly,
  refreshThenLogin,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IRefreshableTokenProvider,
  IRenewalStrategy,
} from '@mcp-abap-adt/interfaces-auth';
import type { IConnectionConfig } from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import {
  AuthBroker,
  type AuthBrokerConfig,
  DestinationConfigError,
  type TokenGrant,
} from '../../index';
import { fakeKeyStore, fakeSessionStore } from '../helpers/fakeStores';

const D = 'DEST';
const CERT = readFileSync(
  join(__dirname, '..', 'fixtures', 'certificates', 'client.crt'),
  'utf8',
);
const MARKER = 'M4RKER-of-the-renewal-option';
const RESOURCE = 'https://abap.example.com';
const CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'client',
  uaaClientSecret: 'secret',
};

const OIDC = {
  oidcTokenEndpoint: 'https://idp.example.com/token',
  oidcAuthorizationEndpoint: 'https://idp.example.com/authorize',
  oidcDeviceAuthorizationEndpoint: 'https://idp.example.com/device',
};
const SAML = {
  samlIdpSsoUrl: 'https://idp.example.com/sso',
  samlSpEntityId: 'sp',
  samlIdpEntityId: 'idp',
  samlAcsUrl: 'https://abap.example.com/acs',
  samlIdpCertificates: [CERT],
};

/** Each token row, with the means it needs. */
const ROWS: Array<[TokenGrant, IConnectionConfig]> = [
  ['authorization_code', { authType: 'jwt' }],
  ['client_credentials', { authType: 'jwt' }],
  ['passcode', { authType: 'jwt' }],
  ['oidc_authorization_code', { authType: 'jwt', ...OIDC }],
  ['device_code', { authType: 'jwt', ...OIDC }],
  ['password', { authType: 'jwt', ...OIDC, username: 'u', password: 'p' }],
  [
    'token_exchange',
    {
      authType: 'jwt',
      ...OIDC,
      oidcSubjectToken: 'subject',
      oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    },
  ],
  ['saml2_pure', { authType: 'saml', ...SAML }],
  ['saml2_bearer', { authType: 'saml', ...SAML }],
];

/** An authorization strategy that must never be asked. */
function unusedStrategy<T>(): jest.Mocked<IAuthorizationStrategy<T>> {
  return {
    authorize: jest.fn(async (_request: AuthorizationRequest) => {
      throw new Error('the authorization strategy was asked');
    }),
  };
}

/** Every collaborator a row may need, each a spy. */
function collaborators() {
  const authorization = unusedStrategy<string>();
  const oidcAuthorization = unusedStrategy<{ code: string }>();
  return {
    authorization: jest.fn(() => authorization),
    oidcAuthorization: jest.fn(
      () =>
        oidcAuthorization as unknown as IAuthorizationStrategy<
          import('@mcp-abap-adt/auth-providers').OidcCallbackResult
        >,
    ),
    deviceCodePresenter: jest.fn(() => ({ present: async () => {} })),
    samlCookies: jest.fn(() => async () => 'cookie'),
    assertionReplayStore: jest.fn(() => createInMemoryReplayStore()),
    strategy: authorization,
  };
}

function broker(
  means: IConnectionConfig,
  options: Partial<AuthBrokerConfig>,
  client: IAuthorizationConfig | null = CLIENT,
) {
  const keyStore = fakeKeyStore({ serviceUrl: RESOURCE, ...means }, client);
  const { strategy: _strategy, ...given } = collaborators();
  return {
    keyStore,
    broker: new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: keyStore,
      ...given,
      ...options,
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (thrown: unknown) => thrown,
  );
}

describe('the renewal option reaches every token row', () => {
  it.each(ROWS)(
    '%s: the very strategy, once per build, with its grant',
    async (grant, means) => {
      const strategy: IRenewalStrategy = {
        next: jest.fn(() => ({ next: 'stop' as const })),
      };
      const renewal = jest.fn(
        (_d: string, _g: TokenGrant): IRenewalStrategy => strategy,
      );
      const { broker: b } = broker(
        { ...means, grantType: grant },
        { renewal, onWriteFailure: 'fail' },
      );

      const provider = (await b.getProvider(
        D,
      )) as unknown as IRefreshableTokenProvider;
      expect(await b.getProvider(D)).toBe(provider);
      expect(renewal).toHaveBeenCalledTimes(1);
      expect(renewal).toHaveBeenCalledWith(D, grant);

      const thrown = await rejection(provider.getTokens());
      expect(readFailure(thrown, 'token-source').kind).toBe('renewal-declined');
      expect(strategy.next).toHaveBeenCalled();
    },
  );

  it('refreshOnly(): a renewal never calls the authorization strategy', async () => {
    const all = collaborators();
    const { strategy, ...given } = all;
    const b = new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: fakeKeyStore(
        {
          authType: 'jwt',
          grantType: 'authorization_code',
          serviceUrl: RESOURCE,
        },
        CLIENT,
      ),
      ...given,
      renewal: () => refreshOnly(),
      onWriteFailure: 'fail',
    });
    const thrown = await rejection(b.getToken(D));
    expect(readFailure(thrown, 'token-source').kind).toBe('renewal-declined');
    expect(all.authorization).toHaveBeenCalledTimes(1);
    expect(strategy.authorize).not.toHaveBeenCalled();
  });
});

describe('no renewal option', () => {
  it('a token row is refused naming renewal, with every other missing field, in one error', async () => {
    const { broker: b } = broker(
      { authType: 'jwt', grantType: 'authorization_code' },
      { authorization: undefined, onWriteFailure: 'fail' },
      {
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'c',
        uaaClientSecret: '',
      },
    );
    const thrown = await rejection(b.getProvider(D));
    expect(thrown).toBeInstanceOf(DestinationConfigError);
    expect((thrown as DestinationConfigError).missingFields).toEqual([
      'uaaClientSecret',
      'authorization',
      'renewal',
    ]);
  });

  it('names renewal and onWriteFailure together when both are missing', async () => {
    const { broker: b } = broker(
      { authType: 'jwt', grantType: 'client_credentials' },
      {},
    );
    const thrown = await rejection(b.getProvider(D));
    expect((thrown as DestinationConfigError).missingFields).toEqual([
      'renewal',
      'onWriteFailure',
    ]);
  });

  it('no collaborator is called — the clientAuthentication strategy included — and nothing is cached', async () => {
    const all = collaborators();
    const { strategy: _strategy, ...given } = all;
    const clientAuthentication = jest.fn(async () => {
      throw new Error('the clientAuthentication strategy was called');
    });
    const keyStore = fakeKeyStore(
      {
        authType: 'jwt',
        grantType: 'authorization_code',
        serviceUrl: RESOURCE,
      },
      CLIENT,
    );
    const b = new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: keyStore,
      ...given,
      clientAuthentication,
      onWriteFailure: 'fail',
    });
    for (const _ of [1, 2]) {
      const thrown = await rejection(b.getProvider(D));
      expect((thrown as DestinationConfigError).missingFields).toEqual([
        'renewal',
      ]);
    }
    expect(clientAuthentication).not.toHaveBeenCalled();
    expect(all.authorization).not.toHaveBeenCalled();
    // Nothing cached: each call built again, reading the means again.
    expect(keyStore.getConnectionConfig).toHaveBeenCalledTimes(2);
  });

  it.each<[string, IConnectionConfig, Record<string, unknown> | null]>([
    ['basic', { authType: 'basic', username: 'u', password: 'p' }, null],
    ['snc', { authType: 'snc', sncPartnerName: 'p:CN=ABC' }, null],
    [
      'jwt / none',
      { authType: 'jwt', grantType: 'none' },
      {
        authorizationToken: 'token',
        issuedFor: 'https://abap.example.com:443',
      },
    ],
    [
      'saml / none',
      { authType: 'saml', grantType: 'none' },
      { sessionCookies: 'cookie', issuedFor: 'https://abap.example.com:443' },
    ],
  ])(
    '%s builds without renewal and onWriteFailure',
    async (_row, means, session) => {
      const b = new AuthBroker({
        sessionStore: fakeSessionStore(session),
        serviceKeyStore: fakeKeyStore({ serviceUrl: RESOURCE, ...means }, null),
      });
      await expect(b.getProvider(D)).resolves.toBeDefined();
    },
  );
});

describe('a renewal option that throws', () => {
  it('is refused naming renewal, carrying renewal-strategy, quoting nothing; nothing cached', async () => {
    const renewal = jest.fn((): IRenewalStrategy => {
      throw new Error(MARKER);
    });
    const { broker: b } = broker(
      { authType: 'jwt', grantType: 'client_credentials' },
      { renewal, onWriteFailure: 'fail' },
    );
    for (const _ of [1, 2]) {
      const thrown = await rejection(b.getProvider(D));
      expect(thrown).toBeInstanceOf(DestinationConfigError);
      const error = thrown as DestinationConfigError;
      expect(error.missingFields).toEqual(['renewal']);
      expect(error.error?.kind).toBe('unknown');
      expect(error.error?.facts).toEqual({ operation: 'renewal-strategy' });
      expect(JSON.stringify(error)).not.toContain(MARKER);
      expect(error.message).not.toContain(MARKER);
    }
    expect(renewal).toHaveBeenCalledTimes(2);
  });
});

describe('no onWriteFailure option', () => {
  it('a token row is refused naming onWriteFailure', async () => {
    const { broker: b } = broker(
      { authType: 'jwt', grantType: 'client_credentials' },
      { renewal: () => refreshThenLogin() },
    );
    const thrown = await rejection(b.getProvider(D));
    expect((thrown as DestinationConfigError).missingFields).toEqual([
      'onWriteFailure',
    ]);
  });

  it('the token API with a consumer provider is refused naming onWriteFailure, before the provider is asked', async () => {
    const provider: jest.Mocked<IRefreshableTokenProvider> = {
      getTokens: jest.fn(async () => ({
        authorizationToken: 'token',
        authType: 'client_credentials' as const,
      })),
      refreshTokens: jest.fn(async () => ({
        authorizationToken: 'token',
        authType: 'client_credentials' as const,
      })),
    };
    const b = new AuthBroker({
      sessionStore: fakeSessionStore({ serviceUrl: RESOURCE }),
      provider,
    });
    for (const call of [() => b.getToken(D), () => b.refreshToken(D)]) {
      const thrown = await rejection(call());
      expect((thrown as DestinationConfigError).missingFields).toEqual([
        'onWriteFailure',
      ]);
    }
    expect(provider.getTokens).not.toHaveBeenCalled();
    expect(provider.refreshTokens).not.toHaveBeenCalled();
  });

  it('a value that is neither fail nor continue is no choice', async () => {
    const { broker: b } = broker(
      { authType: 'jwt', grantType: 'client_credentials' },
      {
        renewal: () => refreshThenLogin(),
        onWriteFailure: 'ignore' as unknown as 'fail',
      },
    );
    const thrown = await rejection(b.getProvider(D));
    expect((thrown as DestinationConfigError).missingFields).toEqual([
      'onWriteFailure',
    ]);
  });

  it('basic builds without it', async () => {
    const b = new AuthBroker({
      sessionStore: fakeSessionStore(),
      serviceKeyStore: fakeKeyStore(
        {
          authType: 'basic',
          serviceUrl: RESOURCE,
          username: 'u',
          password: 'p',
        },
        null,
      ),
    });
    await expect(b.getProvider(D)).resolves.toBeDefined();
  });
});
