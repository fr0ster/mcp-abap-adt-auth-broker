/**
 * The strategy's answer on every client-authenticating row — the three UAA
 * grants, the four OIDC grants and `saml2_bearer` — and the no-strategy path,
 * which stays 4.0.0's.
 *
 * With a strategy each row's provider gets the answer as `clientAuthentication`
 * and no `clientSecret` (auth-providers 5.3.0 refuses both); its `uaaUrl` and
 * client id come from the secret client, or — when the key store has none —
 * from the certificate client, read once. Without a strategy nothing
 * certificate-related is called: the key store here throws if it is.
 *
 * The providers are real (auth-providers 5.3.0) against a local token
 * endpoint; the strategy's answer is a recording `IClientAuthentication` that
 * authenticates with a header of its own, so what reached the token endpoint
 * shows which way the client authenticated.
 */

import { type MockSamlIdp, startMockSamlIdp } from '@mcp-abap-adt/auth-mocks';
import {
  createInMemoryReplayStore,
  type OidcCallbackResult,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
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
import { clientIdentity } from '../../clientAuthentication';
import {
  AuthBroker,
  type AuthBrokerConfig,
  type ClientAuthenticationContext,
  type ClientAuthenticationStrategy,
  DestinationConfigError,
} from '../../index';
import {
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

const D = 'X509';
const CLIENT_SECRET = 'S3CRET-client-must-not-leak';
const STRATEGY_HEADER = 'Strategy the-consumers-answer';
const SERVICE_URL = 'https://abap.example.com';
const REDIRECT = 'http://localhost/callback';
const HINT = 'a certificate client needs a clientAuthentication strategy';

const IDP_ENTITY = 'urn:test:idp';
const SP_ENTITY = 'urn:test:sp';
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';

type Grant =
  | 'client_credentials'
  | 'authorization_code'
  | 'passcode'
  | 'oidc_authorization_code'
  | 'device_code'
  | 'password'
  | 'token_exchange'
  | 'saml2_bearer';

const GRANTS: Grant[] = [
  'client_credentials',
  'authorization_code',
  'passcode',
  'oidc_authorization_code',
  'device_code',
  'password',
  'token_exchange',
  'saml2_bearer',
];

const isOidc = (grant: Grant) =>
  grant === 'oidc_authorization_code' ||
  grant === 'device_code' ||
  grant === 'password' ||
  grant === 'token_exchange';

let endpoint: TokenEndpoint;
let idp: MockSamlIdp;

beforeAll(async () => {
  idp = await startMockSamlIdp({
    issuer: IDP_ENTITY,
    audience: SP_ENTITY,
    acsUrls: [ACS],
    signWhat: 'assertion',
  });
});

afterAll(async () => {
  await idp.close();
});

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await endpoint.close();
});

function meansOf(grant: Grant): IConnectionConfig {
  const base: IConnectionConfig = {
    authType: grant === 'saml2_bearer' ? 'saml' : 'jwt',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
  };
  if (isOidc(grant)) {
    base.oidcIssuerUrl = endpoint.url;
    base.oidcScopes = ['openid'];
  }
  if (grant === 'password') {
    base.username = 'alice';
    base.password = 'the-users-password';
  }
  if (grant === 'token_exchange') {
    base.oidcSubjectToken = 'the-subject-token';
    base.oidcSubjectTokenType = 'urn:ietf:params:oauth:token-type:access_token';
  }
  if (grant === 'saml2_bearer') {
    Object.assign(base, {
      samlIdpSsoUrl: `${idp.url}/sso`,
      samlIdpEntityId: IDP_ENTITY,
      samlIdpCertificates: [idp.certificatePem],
      samlSpEntityId: SP_ENTITY,
      samlAcsUrl: ACS,
    });
  }
  return base;
}

const secretClient = (): IAuthorizationConfig => ({
  uaaUrl: endpoint.url,
  uaaClientId: 'secret-client',
  uaaClientSecret: CLIENT_SECRET,
});

const certificateClient = (): IClientCertificate => ({
  uaaUrl: endpoint.url,
  clientId: 'cert-client',
  certificate:
    '-----BEGIN CERTIFICATE-----\nnot-read\n-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----\nnot-read\n-----END PRIVATE KEY-----',
  certUrl: 'https://cert.example.com',
});

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

/** A key store; `certificate` undefined makes `getClientCertificate` throw if called. */
function keyStore(
  grant: Grant,
  client: IAuthorizationConfig | null,
  certificate?: IClientCertificate | null,
): jest.Mocked<IServiceKeyStore> & {
  getClientCertificate: jest.Mock;
} {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => client),
    getConnectionConfig: jest.fn(async (_d: string) => meansOf(grant)),
    getClientCertificate: jest.fn(async (_d: string) => {
      if (certificate === undefined) {
        throw new Error('getClientCertificate must not be called');
      }
      return certificate;
    }),
  };
}

/** The consumer's collaborators for every row: each plays its part headless. */
function collaborators(): Partial<AuthBrokerConfig> {
  const codeStrategy: IAuthorizationStrategy<string> = {
    authorize: async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    },
    dispose: async () => {},
  };
  const samlStrategy: IAuthorizationStrategy<string> = {
    authorize: async (request: AuthorizationRequest) => {
      const url = await request.buildAuthorizationUrl(ACS);
      const html = await (await fetch(url)).text();
      const payload = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1];
      if (!payload) throw new Error('no SAMLResponse from the IdP');
      return { payload, redirectUri: ACS };
    },
    dispose: async () => {},
  };
  const oidcStrategy: IAuthorizationStrategy<OidcCallbackResult> = {
    authorize: async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: { code: 'the-code' }, redirectUri: REDIRECT };
    },
    dispose: async () => {},
  };
  return {
    authorization: (_d, grant) =>
      grant === 'saml2_bearer' || grant === 'saml2_pure'
        ? samlStrategy
        : codeStrategy,
    oidcAuthorization: () => oidcStrategy,
    deviceCodePresenter: () => ({ present: async () => {} }),
    assertionReplayStore: () => createInMemoryReplayStore(),
  };
}

/** The strategy's answer: a header of its own, recording every draft. */
function recordingAuthentication(): {
  answer: IClientAuthentication;
  drafts: ITokenRequestDraft[];
} {
  const drafts: ITokenRequestDraft[] = [];
  return {
    drafts,
    answer: {
      authenticate: async (draft) => {
        drafts.push(draft);
        return { headers: { Authorization: STRATEGY_HEADER } };
      },
    },
  };
}

function brokerFor(
  keys: IServiceKeyStore,
  clientAuthentication?: ClientAuthenticationStrategy,
): AuthBroker {
  const config: AuthBrokerConfig = {
    sessionStore: sessionStore(),
    serviceKeyStore: keys,
    ...collaborators(),
  };
  if (clientAuthentication) config.clientAuthentication = clientAuthentication;
  return new AuthBroker(config);
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

/** The client id of each token request's draft — the device authorization left out. */
const tokenDrafts = (drafts: ITokenRequestDraft[]) =>
  drafts
    .filter((d) => d.grantType !== 'device_authorization')
    .map((d) => d.clientId);

/** What reached the token endpoint, in one string. */
const wire = () => JSON.stringify(endpoint.requests);

describe('with a strategy, every client row', () => {
  it.each(GRANTS)(
    '%s: the provider authenticates with the strategy’s answer and holds no secret',
    async (grant) => {
      const keys = keyStore(grant, secretClient());
      const recorded = recordingAuthentication();
      const strategy = jest.fn(async () => recorded.answer);
      const broker = brokerFor(keys, strategy);

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(strategy).toHaveBeenCalledTimes(1);
      expect(endpoint.requests.length).toBeGreaterThan(0);
      for (const request of endpoint.requests) {
        expect(request.authorization).toBe(STRATEGY_HEADER);
        expect(request.params.client_secret).toBeUndefined();
      }
      expect(wire()).not.toContain(CLIENT_SECRET);
      expect(tokenDrafts(recorded.drafts)).toEqual(
        endpoint.requests.map(() => 'secret-client'),
      );
      // The secret client is there: the certificate is not read.
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
    },
  );

  it.each(GRANTS)(
    '%s without a secret client: uaaUrl and client id from the certificate client, read once',
    async (grant) => {
      const keys = keyStore(grant, null, certificateClient());
      const recorded = recordingAuthentication();
      const strategy = jest.fn(async (context: ClientAuthenticationContext) => {
        await context.readCertificate();
        return recorded.answer;
      });
      const broker = brokerFor(keys, strategy);

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(keys.getClientCertificate).toHaveBeenCalledTimes(1);
      expect(endpoint.requests.length).toBeGreaterThan(0);
      expect(endpoint.paths.every((p) => p.startsWith('/oauth/token'))).toBe(
        true,
      );
      for (const request of endpoint.requests) {
        expect(request.authorization).toBe(STRATEGY_HEADER);
      }
      expect(tokenDrafts(recorded.drafts)).toEqual(
        endpoint.requests.map(() => 'cert-client'),
      );
      expect(wire()).not.toContain('BEGIN');
    },
  );

  it('the broker reads the certificate client itself when the strategy did not', async () => {
    const keys = keyStore('client_credentials', null, certificateClient());
    const recorded = recordingAuthentication();
    const broker = brokerFor(keys, async () => recorded.answer);

    const provider = await broker.getProvider(D);
    expect(await provider.prepare()).toEqual({ ok: true });

    expect(keys.getClientCertificate).toHaveBeenCalledTimes(1);
    expect(tokenDrafts(recorded.drafts)).toEqual(['cert-client']);
  });

  it('neither a secret client nor a certificate client: the lacking fields, without the hint', async () => {
    const keys = keyStore('client_credentials', null, null);
    const recorded = recordingAuthentication();
    const broker = brokerFor(keys, async () => recorded.answer);

    const error = await refusal(broker.getProvider(D));
    expect(error.missingFields).toEqual(['uaaUrl', 'uaaClientId']);
    expect(error.message).not.toContain(HINT);
  });

  it.each([
    [
      'the secret client',
      (): IAuthorizationConfig | null => secretClient(),
      'secret-client',
    ],
    [
      'the certificate client',
      (): IAuthorizationConfig | null => null,
      'cert-client',
    ],
  ] as const)(
    'the identity from %s is who the client is — no secret field, no PEM',
    async (_from, client, id) => {
      const identity = await clientIdentity({
        destination: D,
        grant: 'client_credentials',
        client: client(),
        readCertificate: async () => certificateClient(),
      });
      expect(identity).toEqual({ uaaUrl: endpoint.url, uaaClientId: id });
      expect(Object.keys(identity ?? {}).sort()).toEqual([
        'uaaClientId',
        'uaaUrl',
      ]);
    },
  );

  it('a certificate read that fails after the strategy answered is a fixed DestinationConfigError', async () => {
    const keys = keyStore('client_credentials', null);
    keys.getClientCertificate.mockRejectedValue(
      new Error('MARKER-store-failure'),
    );
    const recorded = recordingAuthentication();
    const broker = brokerFor(keys, async () => recorded.answer);

    const error = await refusal(broker.getProvider(D));
    expect(error.missingFields).toEqual(['clientAuthentication']);
    expect(error.message).not.toContain('MARKER');
    expect(error).not.toHaveProperty('cause');
  });
});

describe('without a strategy — 4.0.0', () => {
  function spyOnFiles() {
    const fs = require('node:fs') as typeof import('node:fs');
    return [
      jest.spyOn(fs, 'readFileSync'),
      jest.spyOn(fs, 'readFile'),
      jest.spyOn(fs.promises, 'readFile'),
    ];
  }

  it.each(GRANTS)(
    '%s with a secret client: the secret authenticates, and nothing certificate-related is called',
    async (grant) => {
      const keys = keyStore(grant, secretClient());
      const files = spyOnFiles();
      const broker = brokerFor(keys);

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests.length).toBeGreaterThan(0);
      const basic = `Basic ${Buffer.from(`secret-client:${CLIENT_SECRET}`).toString('base64')}`;
      // 4.0.0's way, whichever the provider uses: the header or the body.
      for (const request of endpoint.requests) {
        expect(
          request.authorization === basic ||
            request.params.client_secret === CLIENT_SECRET,
        ).toBe(true);
      }
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
      for (const spy of files) expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['client_credentials', ['uaaUrl', 'uaaClientId', 'uaaClientSecret']],
    ['authorization_code', ['uaaUrl', 'uaaClientId', 'uaaClientSecret']],
    ['passcode', ['uaaUrl', 'uaaClientId']],
    ['oidc_authorization_code', ['uaaClientId']],
    ['device_code', ['uaaClientId']],
    ['password', ['uaaClientId']],
    ['token_exchange', ['uaaClientId']],
    ['saml2_bearer', ['uaaUrl', 'uaaClientId']],
  ] as const)(
    '%s, a certificate-only destination: the 4.0.0 lacking fields and the hint, without asking the store',
    async (grant, lacking) => {
      const keys = keyStore(grant, null);
      const files = spyOnFiles();
      const broker = brokerFor(keys);

      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toEqual([...lacking]);
      expect(error.message).toContain(HINT);
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
      for (const spy of files) expect(spy).not.toHaveBeenCalled();
    },
  );

  it('a destination lacking something else than its client gets no hint', async () => {
    const keys = keyStore('authorization_code', secretClient());
    const broker = new AuthBroker({
      sessionStore: sessionStore(),
      serviceKeyStore: keys,
    });

    const error = await refusal(broker.getProvider(D));
    expect(error.missingFields).toEqual(['authorization']);
    expect(error.message).not.toContain(HINT);
  });

  it.each([
    [
      'client_credentials',
      { uaaClientSecret: '' },
      'a jwt destination with grantType client_credentials lacks what its grant needs (uaaClientSecret)',
    ],
    [
      'authorization_code',
      { uaaUrl: '' },
      'a jwt destination with grantType authorization_code lacks what its grant needs (uaaUrl)',
    ],
    [
      'passcode',
      { uaaUrl: '', uaaClientSecret: '' },
      'a jwt destination with grantType passcode lacks what its grant needs (uaaUrl)',
    ],
    [
      'saml2_bearer',
      { uaaUrl: '' },
      'a saml destination with grantType saml2_bearer lacks what its grant needs (uaaUrl)',
    ],
  ] as const)(
    '%s, a client with a gap (%j): 4.0.0’s message exactly, no hint',
    async (grant, gap, words) => {
      const keys = keyStore(grant, { ...secretClient(), ...gap });
      const broker = brokerFor(keys);

      const error = await refusal(broker.getProvider(D));
      expect(error.message).toBe(`Destination "${D}": ${words}`);
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
    },
  );

  it.each(['client_credentials', 'password'] as const)(
    '%s, a client without a client id: the hint',
    async (grant) => {
      const keys = keyStore(grant, { ...secretClient(), uaaClientId: '' });
      const broker = brokerFor(keys);

      const error = await refusal(broker.getProvider(D));
      expect(error.missingFields).toContain('uaaClientId');
      expect(error.message).toContain(HINT);
      expect(keys.getClientCertificate).not.toHaveBeenCalled();
    },
  );
});
