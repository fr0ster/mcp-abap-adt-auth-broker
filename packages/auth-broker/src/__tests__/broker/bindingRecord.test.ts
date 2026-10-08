/**
 * The versioned binding record (`issuedBy`, spec §6.1):
 *
 *   mcp-abap-adt-binding/2;<row>;<eleven encoded address fields>;<trust>
 *
 * Each address field is the exact string the row hands its provider,
 * `encodeURIComponent`-encoded, `""` when it hands none; the twelfth field is
 * the SHA-256 of the row's non-secret trust input. The record is compared by
 * exact equality and never parsed.
 *
 * The expected records are assembled here from the spec's grammar — field
 * order, `encodeURIComponent`, the trust serialisation — never by the broker's
 * own functions: a test that used them would agree with any bug in them.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AbapSessionStore,
  EnvFileSessionStore,
  SafeAbapSessionStore,
  SafeXsuaaSessionStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  DestinationGrant,
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  type Binding,
  bindingRecord,
  consumerBinding,
  type RecordFields,
  trustDigest,
} from '../../binding';
import { consumerRow, destinationBinding } from '../../bindingOf';
import { asContract, type WithUndefined } from '../../contractShape';
import { AuthBroker, bindingOf, DestinationConfigError } from '../../index';
import {
  digest,
  RECORD_ORDER as ORDER,
  type RecordField,
  TRUST_PREFIX,
} from '../helpers/bindingRecord';
import { fakeKeyStore, fakeSessionStore } from '../helpers/fakeStores';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

type Field = RecordField;

/** The record as the spec's grammar writes it. */
function expected(
  row: string,
  filled: Partial<Record<Field, string>>,
  trust: string,
): string {
  const fields = ORDER.map((name) => {
    const value = filled[name];
    return value === undefined ? '' : encodeURIComponent(value);
  });
  return ['mcp-abap-adt-binding/2', row, ...fields, trust].join(';');
}

const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
const CERTIFICATE =
  '-----BEGIN CERTIFICATE-----\nMIIBcertificate\n-----END CERTIFICATE-----\n';

/** Every means value a row may read, each a distinct string. */
const ALL: IConnectionConfig = asContract<IConnectionConfig>({
  serviceUrl: SERVICE_URL,
  sapClient: '100',
  oidcIssuerUrl: 'https://idp.example.com/realms/r',
  oidcTokenEndpoint: 'https://idp.example.com/realms/r/token',
  oidcAuthorizationEndpoint: 'https://idp.example.com/realms/r/auth',
  oidcDeviceAuthorizationEndpoint: 'https://idp.example.com/realms/r/device',
  oidcAudience: 'https://audience.example.com',
  oidcScopes: ['openid', 'adt'],
  username: 'alice',
  password: 'PASSWORD-must-not-be-in-the-record',
  oidcSubjectToken: 'SUBJECT-must-not-be-in-the-record',
  oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
  oidcActorToken: 'ACTOR-must-not-be-in-the-record',
  oidcActorTokenType: 'urn:ietf:params:oauth:token-type:access_token',
  samlIdpSsoUrl: 'https://idp.example.com/sso',
  samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
  samlTokenUrl: 'https://uaa.example.com/oauth/token/alias/x',
  samlIdpCertificates: ['CERT-ONE', 'CERT-TWO'],
  samlIdpEntityId: 'https://idp.example.com/entity',
  samlSpEntityId: 'https://abap.example.com/sp',
  samlClockSkewMs: 5000,
  samlIdpInitiated: true,
  samlRelayState: 'relay',
});

const CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'sb-broker!t42',
  uaaClientSecret: 'CLIENT-SECRET-must-not-be-in-the-record',
};

const CERT = { certUrl: 'https://cert.example.com/', certificate: CERTIFICATE };

function bindingFor(
  authType: 'jwt' | 'saml',
  grant: DestinationGrant,
  means: WithUndefined<Partial<IConnectionConfig>> = {},
  client: IAuthorizationConfig | null = CLIENT,
  certificate: typeof CERT | null = null,
): Binding {
  return destinationBinding(
    authType,
    grant,
    asContract<IConnectionConfig>({
      ...ALL,
      authType,
      grantType: grant,
      ...means,
    }),
    client,
    certificate,
  );
}

const SAML_TRUST: [string, unknown][] = [
  ['samlIdpCertificates', ['CERT-ONE', 'CERT-TWO']],
  ['samlIdpEntityId', 'https://idp.example.com/entity'],
  ['samlSpEntityId', 'https://abap.example.com/sp'],
  ['samlClockSkewMs', 5000],
  ['samlIdpInitiated', true],
];

describe('the record round-trips byte for byte through every auth-stores 4.0.0 session store', () => {
  /** Raw values holding / ? & = % ; # and a space, one per field. */
  const raw = (n: number) => `https://f${n}.example/p a?x=1&y=%2F;z#f`;
  const RAW_FIELDS: RecordFields = Object.fromEntries(
    ORDER.map((name, n) => [name, raw(n)]),
  );
  const TRUST = digest([['clientCertificate', CERTIFICATE]]);
  const RECORD = bindingRecord('jwt/authorization_code', RAW_FIELDS, TRUST);
  /** Written out by hand: each raw value through encodeURIComponent. */
  const enc = (n: number) =>
    `https%3A%2F%2Ff${n}.example%2Fp%20a%3Fx%3D1%26y%3D%252F%3Bz%23f`;
  const LITERAL = [
    'mcp-abap-adt-binding/2',
    'jwt/authorization_code',
    ...ORDER.map((_, n) => enc(n)),
    TRUST,
  ].join(';');

  it('is the grammar: twelve fields, every one populated, no encoded field holds ";"', () => {
    expect(RECORD).toBe(LITERAL);
    const parts = RECORD.split(';');
    expect(parts).toHaveLength(14);
    for (const part of parts.slice(2, 13)) {
      expect(part).not.toBe('');
      for (const c of [';', '#', '=', ' ', '&', '?', '/']) {
        expect(part).not.toContain(c);
      }
    }
    expect(parts[13]).toMatch(/^[0-9a-f]{64}$/);
  });

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-record-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const secret = (): IConfig =>
    asContract<IConfig>({
      authorizationToken: 'a-token',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'a-refresh-token',
      issuedFor: FOR,
      issuedBy: RECORD,
    });

  it.each([
    ['AbapSessionStore', (d: string) => new AbapSessionStore(d)],
    ['XsuaaSessionStore', (d: string) => new XsuaaSessionStore(d)],
    [
      'EnvFileSessionStore',
      (d: string) => new EnvFileSessionStore(path.join(d, 'session.env')),
    ],
  ] as [string, (d: string) => ISessionStore][])(
    '%s: a file, read back by a new store instance',
    async (_label, make) => {
      await make(dir).saveSession('TRIAL', secret());
      const read = await make(dir).loadSession('TRIAL');
      expect(read?.issuedBy).toBe(RECORD);
      expect(read?.issuedFor).toBe(FOR);
    },
  );

  it.each([
    ['SafeAbapSessionStore', () => new SafeAbapSessionStore()],
    ['SafeXsuaaSessionStore', () => new SafeXsuaaSessionStore()],
  ] as [string, () => ISessionStore][])(
    '%s: in memory',
    async (_label, make) => {
      const store = make();
      await store.saveSession('TRIAL', secret());
      expect((await store.loadSession('TRIAL'))?.issuedBy).toBe(RECORD);
    },
  );

  it('a lone surrogate is encoded too, distinctly, and never throws', () => {
    const a = bindingRecord('jwt/none', { clientId: 'x\ud800' }, '');
    const b = bindingRecord('jwt/none', { clientId: 'x\udc00' }, '');
    const c = bindingRecord('jwt/none', { clientId: 'x�' }, '');
    expect(new Set([a, b, c]).size).toBe(3);
    for (const record of [a, b, c]) {
      expect(record.split(';')).toHaveLength(14);
    }
  });
});

describe('the trust digest', () => {
  const PAIRS: [string, unknown][] = [
    ...SAML_TRUST,
    ['clientCertificate', CERTIFICATE],
  ];

  it('is the SHA-256 of the spec serialisation, lower-case hex', () => {
    expect(trustDigest(PAIRS)).toBe(digest(PAIRS));
  });

  it('is the same in another process', () => {
    // An independent implementation of the serialisation, in a fresh node
    // process: nothing of this process — no salt, no identity, no order of a
    // Map — takes part.
    const script = [
      "const { createHash } = require('node:crypto');",
      'const pairs = JSON.parse(process.argv[1]);',
      `const prefix = ${JSON.stringify(TRUST_PREFIX)};`,
      "process.stdout.write(createHash('sha256').update(prefix + JSON.stringify(pairs), 'utf8').digest('hex'));",
    ].join('\n');
    const run = spawnSync(
      process.execPath,
      ['-e', script, JSON.stringify(PAIRS)],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(trustDigest(PAIRS));
  });

  const trustOf = (b: Binding) => b.issuedBy.split(';')[13];
  const addressesOf = (b: Binding) =>
    b.issuedBy.split(';').slice(0, 13).join(';');

  it.each([
    [
      'one certificate',
      'saml2_pure',
      { samlIdpCertificates: ['CERT-ONE', 'CERT-THREE'] },
    ],
    [
      'the certificates’ order',
      'saml2_pure',
      { samlIdpCertificates: ['CERT-TWO', 'CERT-ONE'] },
    ],
    [
      'a certificate removed',
      'saml2_bearer',
      { samlIdpCertificates: ['CERT-TWO'] },
    ],
    [
      'the IdP entity id',
      'saml2_pure',
      { samlIdpEntityId: 'https://other.example.com' },
    ],
    [
      'the SP entity id',
      'saml2_bearer',
      { samlSpEntityId: 'https://other.example.com' },
    ],
    ['the clock skew', 'saml2_pure', { samlClockSkewMs: 0 }],
    ['samlIdpInitiated', 'saml2_bearer', { samlIdpInitiated: false }],
    ['samlIdpInitiated absent', 'saml2_pure', { samlIdpInitiated: undefined }],
    ['a scope', 'password', { oidcScopes: ['openid'] }],
    ['the scopes’ order', 'device_code', { oidcScopes: ['adt', 'openid'] }],
    ['the username', 'password', { username: 'bob' }],
    [
      'the subject token type',
      'token_exchange',
      { oidcSubjectTokenType: 'urn:other' },
    ],
    [
      'the actor token type',
      'token_exchange',
      { oidcActorTokenType: 'urn:other' },
    ],
  ] as [string, DestinationGrant, WithUndefined<Partial<IConnectionConfig>>][])(
    '%s changed alone changes it (%s), and nothing else in the record',
    (_label, grant, change) => {
      const authType = grant.startsWith('saml') ? 'saml' : 'jwt';
      const before = bindingFor(authType, grant);
      const after = bindingFor(authType, grant, change);
      expect(trustOf(after)).not.toBe(trustOf(before));
      expect(addressesOf(after)).toBe(addressesOf(before));
    },
  );

  it.each([
    ['authorization_code'],
    ['oidc_authorization_code'],
    ['saml2_bearer'],
  ] as [DestinationGrant][])(
    '%s: the client certificate changed alone changes it',
    (grant) => {
      const authType = grant.startsWith('saml') ? 'saml' : 'jwt';
      const one = bindingFor(authType, grant, {}, CLIENT, CERT);
      const other = bindingFor(authType, grant, {}, CLIENT, {
        ...CERT,
        certificate: `${CERTIFICATE}x`,
      });
      const none = bindingFor(authType, grant, {}, CLIENT, null);
      expect(trustOf(one)).not.toBe(trustOf(other));
      expect(trustOf(one)).not.toBe(trustOf(none));
    },
  );

  it.each([
    ['the password', 'password', { password: 'other' }],
    ['the subject token', 'token_exchange', { oidcSubjectToken: 'other' }],
    ['the actor token', 'token_exchange', { oidcActorToken: 'other' }],
    ['samlRelayState', 'saml2_pure', { samlRelayState: 'other' }],
  ] as [string, DestinationGrant, WithUndefined<Partial<IConnectionConfig>>][])(
    '%s takes no part in it (%s)',
    (_label, grant, change) => {
      const authType = grant.startsWith('saml') ? 'saml' : 'jwt';
      expect(bindingFor(authType, grant, change).issuedBy).toBe(
        bindingFor(authType, grant).issuedBy,
      );
    },
  );

  it('no secret, nor its hash, is in any record', () => {
    const records = [
      bindingFor('jwt', 'password'),
      bindingFor('jwt', 'token_exchange'),
      bindingFor('jwt', 'authorization_code', {}, CLIENT, CERT),
      bindingFor('saml', 'saml2_bearer', {}, CLIENT, CERT),
    ].map((b) => b.issuedBy);
    for (const secret of [
      ALL.password as string,
      ALL.oidcSubjectToken as string,
      ALL.oidcActorToken as string,
      CLIENT.uaaClientSecret,
    ]) {
      for (const algorithm of ['sha256', 'sha1', 'md5']) {
        const hash = createHash(algorithm).update(secret);
        const hex = hash.copy().digest('hex');
        const b64 = hash.digest('base64');
        for (const record of records) {
          expect(record).not.toContain(secret);
          expect(record).not.toContain(encodeURIComponent(secret));
          expect(record).not.toContain(hex);
          expect(record).not.toContain(b64);
        }
      }
    }
  });
});

describe('per row, exactly the fields of §6.1’s table, as the exact strings the provider receives', () => {
  const CLIENT_FIELDS = {
    clientId: 'sb-broker!t42',
    uaaUrl: 'https://uaa.example.com',
  };

  it.each([['authorization_code'], ['client_credentials'], ['passcode']] as [
    DestinationGrant,
  ][])('jwt / %s', (grant) => {
    expect(bindingFor('jwt', grant).issuedBy).toBe(
      expected(
        `jwt/${grant}`,
        CLIENT_FIELDS,
        digest([['clientCertificate', null]]),
      ),
    );
    expect(bindingFor('jwt', grant, {}, CLIENT, CERT).issuedBy).toBe(
      expected(
        `jwt/${grant}`,
        { ...CLIENT_FIELDS, certUrl: 'https://cert.example.com/' },
        digest([['clientCertificate', CERTIFICATE]]),
      ),
    );
  });

  const OIDC_BASE = {
    clientId: 'sb-broker!t42',
    oidcIssuerUrl: 'https://idp.example.com/realms/r',
    oidcTokenEndpoint: 'https://idp.example.com/realms/r/token',
  };
  const SCOPES: [string, unknown] = ['oidcScopes', ['openid', 'adt']];

  it.each([
    [
      'oidc_authorization_code',
      {
        oidcAuthorizationEndpoint: 'https://idp.example.com/realms/r/auth',
      },
      [SCOPES],
    ],
    [
      'device_code',
      {
        oidcDeviceAuthorizationEndpoint:
          'https://idp.example.com/realms/r/device',
      },
      [SCOPES],
    ],
    ['password', {}, [SCOPES, ['username', 'alice']]],
    [
      'token_exchange',
      { oidcAudience: 'https://audience.example.com' },
      [
        SCOPES,
        ['oidcSubjectTokenType', 'urn:ietf:params:oauth:token-type:jwt'],
        ['oidcActorTokenType', 'urn:ietf:params:oauth:token-type:access_token'],
      ],
    ],
  ] as [
    DestinationGrant,
    Partial<Record<Field, string>>,
    [string, unknown][],
  ][])('jwt / %s', (grant, own, trust) => {
    expect(bindingFor('jwt', grant, {}, CLIENT, CERT).issuedBy).toBe(
      expected(
        `jwt/${grant}`,
        { ...OIDC_BASE, ...own, certUrl: 'https://cert.example.com/' },
        digest([...trust, ['clientCertificate', CERTIFICATE]]),
      ),
    );
  });

  it('saml / saml2_pure', () => {
    expect(bindingFor('saml', 'saml2_pure', {}, null).issuedBy).toBe(
      expected(
        'saml/saml2_pure',
        {
          samlIdpSsoUrl: 'https://idp.example.com/sso',
          samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
        },
        digest(SAML_TRUST),
      ),
    );
  });

  it('saml / saml2_bearer', () => {
    expect(bindingFor('saml', 'saml2_bearer', {}, CLIENT, CERT).issuedBy).toBe(
      expected(
        'saml/saml2_bearer',
        {
          ...CLIENT_FIELDS,
          samlIdpSsoUrl: 'https://idp.example.com/sso',
          samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
          samlTokenUrl: 'https://uaa.example.com/oauth/token/alias/x',
          certUrl: 'https://cert.example.com/',
        },
        digest([...SAML_TRUST, ['clientCertificate', CERTIFICATE]]),
      ),
    );
  });

  it('jwt / none: the client, uaaUrl and oidcIssuerUrl as the means state them; no trust', () => {
    expect(bindingFor('jwt', 'none').issuedBy).toBe(
      expected(
        'jwt/none',
        {
          ...CLIENT_FIELDS,
          oidcIssuerUrl: 'https://idp.example.com/realms/r',
        },
        '',
      ),
    );
  });

  it('saml / none: samlAcsUrl; no trust', () => {
    expect(bindingFor('saml', 'none', {}, null).issuedBy).toBe(
      expected(
        'saml/none',
        { samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100' },
        '',
      ),
    );
  });

  const ALL_JWT = asContract<IConnectionConfig>({
    ...ALL,
    authType: 'jwt',
    grantType: 'authorization_code',
  });

  it('the consumer path: provider/<row>; the factory’s client, the instance none; no trust', () => {
    const factory = consumerBinding(
      consumerRow(ALL_JWT),
      SERVICE_URL,
      '100',
      CLIENT,
    );
    expect(factory.issuedBy).toBe(
      expected('provider/jwt/authorization_code', CLIENT_FIELDS, ''),
    );
    expect(factory.issuedFor).toBe(FOR);
    const instance = consumerBinding(
      consumerRow(ALL_JWT),
      SERVICE_URL,
      '100',
      null,
    );
    expect(instance.issuedBy).toBe(
      expected('provider/jwt/authorization_code', {}, ''),
    );
  });

  it.each([
    ['no means', null],
    ['no authType', { grantType: 'authorization_code' }],
    ['no grant', { authType: 'jwt' }],
    ['a pair outside the closed list', { authType: 'jwt', grantType: 'x;y' }],
  ] as [string, IConnectionConfig | null][])(
    'the consumer path with %s: provider/-',
    (_label, means) => {
      expect(consumerRow(means)).toBe('provider/-');
    },
  );

  it.each([
    ['a trailing "/"', 'https://uaa.example.com/'],
    ['a case change', 'https://UAA.example.com'],
    ['an explicit default port', 'https://uaa.example.com:443'],
  ])('%s on an address is another record — no canonicalisation', (_l, url) => {
    const one = bindingFor('jwt', 'client_credentials');
    const other = bindingFor(
      'jwt',
      'client_credentials',
      {},
      {
        ...CLIENT,
        uaaUrl: url,
      },
    );
    expect(other.issuedBy).not.toBe(one.issuedBy);
    expect(other.issuedBy).toContain(encodeURIComponent(url));
  });

  it('a trailing "/" on an OIDC token endpoint is another record', () => {
    expect(
      bindingFor('jwt', 'password', {
        oidcTokenEndpoint: 'https://idp.example.com/realms/r/token/',
      }).issuedBy,
    ).not.toBe(bindingFor('jwt', 'password').issuedBy);
  });

  it.each([
    ['samlIdpSsoUrl', 'saml2_pure'],
    ['samlIdpSsoUrl', 'saml2_bearer'],
    ['samlAcsUrl', 'saml2_pure'],
    ['samlTokenUrl', 'saml2_bearer'],
  ] as [Field, DestinationGrant][])(
    '%s switched (%s) is another record',
    (field, grant) => {
      expect(
        bindingFor('saml', grant, { [field]: 'https://switched.example.com' })
          .issuedBy,
      ).not.toBe(bindingFor('saml', grant).issuedBy);
    },
  );

  it('a field stated as "" is absent', () => {
    expect(
      bindingFor('saml', 'saml2_pure', { samlAcsUrl: '' }, null).issuedBy,
    ).toBe(
      expected(
        'saml/saml2_pure',
        { samlIdpSsoUrl: 'https://idp.example.com/sso' },
        digest(SAML_TRUST),
      ),
    );
  });

  it('the row is in the record: same means, another grant, another record', () => {
    expect(bindingFor('jwt', 'authorization_code').issuedBy).not.toBe(
      bindingFor('jwt', 'client_credentials').issuedBy,
    );
  });
});

describe('fully stated, per §6.1’s table', () => {
  const NO_ISSUER = { oidcIssuerUrl: undefined };
  const fully = (
    authType: 'jwt' | 'saml',
    grant: DestinationGrant,
    means: WithUndefined<Partial<IConnectionConfig>> = {},
    client: IAuthorizationConfig | null = CLIENT,
    certificate: typeof CERT | null = null,
  ) => bindingFor(authType, grant, means, client, certificate).fullyStated;

  it.each([['authorization_code'], ['client_credentials'], ['passcode']] as [
    DestinationGrant,
  ][])('jwt / %s', (grant) => {
    expect(fully('jwt', grant)).toBe(true);
    expect(fully('jwt', grant, {}, CLIENT, CERT)).toBe(true);
    expect(fully('jwt', grant, {}, { ...CLIENT, uaaClientId: '' })).toBe(false);
    expect(fully('jwt', grant, {}, { ...CLIENT, uaaUrl: '' })).toBe(false);
    expect(fully('jwt', grant, {}, null)).toBe(false);
    expect(fully('jwt', grant, {}, CLIENT, { ...CERT, certUrl: '' })).toBe(
      false,
    );
  });

  it('the OIDC rows: the client, and each endpoint or the issuer', () => {
    for (const grant of [
      'oidc_authorization_code',
      'device_code',
      'password',
    ] as const) {
      expect(fully('jwt', grant)).toBe(true);
      // The issuer alone: every endpoint discovered from it.
      expect(
        fully('jwt', grant, {
          oidcTokenEndpoint: undefined,
          oidcAuthorizationEndpoint: undefined,
          oidcDeviceAuthorizationEndpoint: undefined,
        }),
      ).toBe(true);
      expect(fully('jwt', grant, {}, { ...CLIENT, uaaClientId: '' })).toBe(
        false,
      );
      expect(fully('jwt', grant, {}, CLIENT, { ...CERT, certUrl: '' })).toBe(
        false,
      );
      expect(fully('jwt', grant, { ...NO_ISSUER, oidcTokenEndpoint: '' })).toBe(
        false,
      );
    }
    // Issuer-less, explicit endpoints and a client: fully stated.
    expect(fully('jwt', 'password', NO_ISSUER)).toBe(true);
    expect(fully('jwt', 'device_code', NO_ISSUER)).toBe(true);
    expect(fully('jwt', 'oidc_authorization_code', NO_ISSUER)).toBe(true);
    expect(
      fully('jwt', 'oidc_authorization_code', {
        ...NO_ISSUER,
        oidcAuthorizationEndpoint: undefined,
      }),
    ).toBe(false);
    expect(
      fully('jwt', 'device_code', {
        ...NO_ISSUER,
        oidcDeviceAuthorizationEndpoint: undefined,
      }),
    ).toBe(false);
  });

  it('token_exchange: never', () => {
    expect(fully('jwt', 'token_exchange')).toBe(false);
    expect(fully('jwt', 'token_exchange', {}, CLIENT, CERT)).toBe(false);
  });

  it('saml2_bearer: the client, the IdP, and samlTokenUrl or uaaUrl', () => {
    expect(fully('saml', 'saml2_bearer')).toBe(true);
    expect(fully('saml', 'saml2_bearer', { samlTokenUrl: undefined })).toBe(
      true,
    );
    expect(
      fully(
        'saml',
        'saml2_bearer',
        { samlTokenUrl: undefined },
        { ...CLIENT, uaaUrl: '' },
      ),
    ).toBe(false);
    expect(fully('saml', 'saml2_bearer', { samlIdpSsoUrl: '' })).toBe(false);
    expect(
      fully('saml', 'saml2_bearer', {}, { ...CLIENT, uaaClientId: '' }),
    ).toBe(false);
    expect(fully('saml', 'saml2_bearer', { samlAcsUrl: undefined })).toBe(true);
    expect(
      fully('saml', 'saml2_bearer', {}, CLIENT, { ...CERT, certUrl: '' }),
    ).toBe(false);
  });

  it('saml2_pure: the IdP and the ACS', () => {
    expect(fully('saml', 'saml2_pure', {}, null)).toBe(true);
    expect(fully('saml', 'saml2_pure', { samlAcsUrl: undefined }, null)).toBe(
      false,
    );
    expect(fully('saml', 'saml2_pure', { samlIdpSsoUrl: '' }, null)).toBe(
      false,
    );
  });

  it('the consumer factory and the consumer instance: never', () => {
    const row = consumerRow(
      asContract<IConnectionConfig>({
        authType: 'jwt',
        grantType: 'client_credentials',
      }),
    );
    expect(consumerBinding(row, SERVICE_URL, '100', CLIENT).fullyStated).toBe(
      false,
    );
    expect(consumerBinding(row, SERVICE_URL, '100', null).fullyStated).toBe(
      false,
    );
  });
});

describe('a trust input not of its expected shape is refused, never collapsed into the digest', () => {
  const D = 'TRUST';
  const answer = {
    authenticate: async () => ({ headers: { Authorization: 'Strategy x' } }),
  };

  async function refusedFields(
    means: WithUndefined<Partial<IConnectionConfig>>,
    options: {
      certificate?: unknown;
    } = {},
  ): Promise<string[]> {
    const stated = asContract<IConnectionConfig>({ ...ALL, ...means });
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: fakeSessionStore(),
      serviceKeyStore:
        options.certificate === undefined
          ? fakeKeyStore(stated, CLIENT)
          : fakeKeyStore(stated, null, {
              uaaUrl: 'https://uaa.example.com',
              clientId: 'cert-client',
              certificate: options.certificate as string,
              key: 'KEY',
              certUrl: 'https://cert.example.com',
            }),
      authorization: () => ({
        authorize: async () => ({ payload: 'x', redirectUri: 'x' }),
      }),
      samlCookies: () => async () => 'cookies',
      assertionReplayStore: () => ({ recordIfUnseen: async () => true }),
      ...(options.certificate === undefined
        ? {}
        : {
            clientAuthentication: async (context: {
              readCertificate(): Promise<unknown>;
            }) => {
              await context.readCertificate();
              return answer;
            },
          }),
    });
    const error = await broker.getProvider(D).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationConfigError);
    return (error as DestinationConfigError).missingFields;
  }

  const PASSWORD = { authType: 'jwt', grantType: 'password' } as const;

  it.each([
    ['[1]', [1]],
    ['[2]', [2]],
    ['[{}]', [{}]],
    ['a string', 'openid adt'],
  ] as [string, unknown][])(
    'oidcScopes %s → refused naming oidcScopes',
    async (_label, oidcScopes) => {
      expect(
        await refusedFields({
          ...PASSWORD,
          oidcScopes: oidcScopes as string[],
        }),
      ).toEqual(['oidcScopes']);
    },
  );

  it('well-formed distinct scopes give distinct digests; absent scopes build', () => {
    const one = bindingFor('jwt', 'password', { oidcScopes: ['a'] });
    const two = bindingFor('jwt', 'password', { oidcScopes: ['b'] });
    expect(one.issuedBy).not.toBe(two.issuedBy);
  });

  it('oidcActorTokenType not a string → refused naming it', async () => {
    expect(
      await refusedFields({
        authType: 'jwt',
        grantType: 'token_exchange',
        oidcActorTokenType: 7 as unknown as string,
      }),
    ).toEqual(['oidcActorTokenType']);
  });

  it.each([['saml2_pure'], ['saml2_bearer']] as [DestinationGrant][])(
    '%s: samlIdpInitiated not a boolean → refused naming it',
    async (grant) => {
      expect(
        await refusedFields({
          authType: 'saml',
          grantType: grant,
          samlIdpInitiated: 'yes' as unknown as boolean,
        }),
      ).toEqual(['samlIdpInitiated']);
    },
  );

  it.each([
    ['a number', 42],
    ['an object', { pem: 'x' }],
    ['""', ''],
  ])(
    'a certificate client whose certificate is %s → refused naming clientAuthentication',
    async (_label, certificate) => {
      expect(
        await refusedFields(
          { authType: 'jwt', grantType: 'client_credentials' },
          { certificate },
        ),
      ).toEqual(['clientAuthentication']);
    },
  );
});

describe('a 4.x-format binding reads as unbound', () => {
  const D = 'TRIAL';
  const CLIENT_ID = 'sb-broker!t42';
  const STORED_TOKEN = jwtExpiringIn(3600, { jti: 'stored-4x-token' });
  const STORED_RT = 'stored-4x-refresh-token';
  const REDIRECT = 'http://localhost/callback';
  let endpoint: TokenEndpoint;
  let dir: string;

  beforeEach(async () => {
    endpoint = await startTokenEndpoint();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-4x-'));
  });
  afterEach(async () => {
    await endpoint.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function keyStore(
    conn: IConnectionConfig,
    auth: IAuthorizationConfig | null,
  ): IServiceKeyStore {
    return {
      getServiceKey: async () => null,
      getAuthorizationConfig: async () => auth,
      getConnectionConfig: async () => conn,
    };
  }

  async function memoryStore(initial: IConfig): Promise<ISessionStore> {
    const store = new SafeAbapSessionStore();
    await store.saveSession(D, initial);
    return store;
  }

  function logger(): jest.Mocked<ILogger> {
    return {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  }

  const login = (): IAuthorizationStrategy<string> => ({
    authorize: async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    },
    dispose: async () => {},
  });

  async function bearer(provider: IAuthProvider): Promise<string | undefined> {
    const headers: Record<string, string> = {};
    expect(
      await provider.authorize({
        header: (name, value) => {
          headers[name] = value;
        },
        cookies: () => {},
      }),
    ).toEqual({ ok: true });
    return headers.Authorization?.slice('Bearer '.length);
  }

  it.each([
    ['a bare canonical URI', () => `${endpoint.url}?client_id=sb-broker%21t42`],
    ['no issuedBy', () => undefined],
  ])(
    'a token row with %s: not seeded, logs in, no refresh token sent, one warn line',
    async (_label, issuedBy) => {
      const by = issuedBy();
      const sessions = new SafeAbapSessionStore();
      await sessions.saveSession(
        D,
        asContract<IConfig>({
          authorizationToken: STORED_TOKEN,
          expiresAt: Date.now() + 3_600_000,
          refreshToken: STORED_RT,
          issuedFor: FOR,
          ...(by === undefined ? {} : { issuedBy: by }),
        }),
      );
      const log = logger();
      const broker = new AuthBroker(
        {
          ...STATED,
          sessionStore: sessions,
          serviceKeyStore: keyStore(
            {
              authType: 'jwt',
              grantType: 'authorization_code',
              serviceUrl: SERVICE_URL,
              sapClient: '100',
            },
            {
              uaaUrl: endpoint.url,
              uaaClientId: CLIENT_ID,
              uaaClientSecret: 'secret',
            },
          ),
          authorization: () => login(),
        },
        log,
      );

      const provider = await broker.getProvider(D);
      expect(await provider.prepare()).toEqual({ ok: true });

      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'authorization_code',
      ]);
      expect(JSON.stringify(endpoint.requests)).not.toContain(STORED_RT);
      expect(await bearer(provider)).toBe(endpoint.issued[0]);
      expect(log.warn.mock.calls).toEqual([
        [
          `[AuthBroker] ${D}: the stored session secret is not recorded as issued under the destination's current means; not used, the provider obtains a new one`,
        ],
      ]);
    },
  );

  const NONE_JWT = asContract<IConnectionConfig>({
    authType: 'jwt',
    grantType: 'none',
    serviceUrl: SERVICE_URL,
    sapClient: '100',
  });
  const NONE_CLIENT: IAuthorizationConfig = {
    uaaUrl: 'https://uaa.example.com',
    uaaClientId: CLIENT_ID,
    uaaClientSecret: '',
  };

  it.each([
    [
      'a bare canonical URI',
      'https://uaa.example.com:443?client_id=sb-broker%21t42',
    ],
    ['no issuedBy', undefined],
  ])(
    'a jwt / none row with %s: refused naming issuedBy',
    async (_label, issuedBy) => {
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: await memoryStore(
          asContract<IConfig>({
            authorizationToken: 'handed-over',
            issuedFor: FOR,
            ...(issuedBy === undefined ? {} : { issuedBy }),
          }),
        ),
        serviceKeyStore: keyStore(NONE_JWT, NONE_CLIENT),
      });
      const error = (await broker
        .getProvider(D)
        .catch((e: unknown) => e)) as DestinationConfigError;
      expect(error).toBeInstanceOf(DestinationConfigError);
      expect(error.missingFields).toEqual(['issuedBy']);
    },
  );

  it('a saml / none row with a 4.x ACS binding: refused naming issuedBy', async () => {
    const means = asContract<IConnectionConfig>({
      authType: 'saml',
      grantType: 'none',
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      samlAcsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
    });
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: await memoryStore(
        asContract<IConfig>({
          sessionCookies: 'MYSAPSSO2=handed-over',
          issuedFor: FOR,
          issuedBy: 'https://abap.example.com:443/sap/saml2/sp/acs/100',
        }),
      ),
      serviceKeyStore: keyStore(means, null),
    });
    const error = (await broker
      .getProvider(D)
      .catch((e: unknown) => e)) as DestinationConfigError;
    expect(error).toBeInstanceOf(DestinationConfigError);
    expect(error.missingFields).toEqual(['issuedBy']);
  });

  it.each([
    ['AbapSessionStore', (d: string) => new AbapSessionStore(d)],
    ['XsuaaSessionStore', (d: string) => new XsuaaSessionStore(d)],
    [
      'EnvFileSessionStore',
      (d: string) => new EnvFileSessionStore(path.join(d, 'session.env')),
    ],
  ] as [string, (d: string) => ISessionStore][])(
    '5.0.0’s bindingOf, written through %s, comes back byte for byte and getProvider presents it',
    async (_label, make) => {
      const means = asContract<IConnectionConfig>({
        ...NONE_JWT,
        oidcIssuerUrl: 'https://idp.example.com/realms/r?x=1&y=2',
      });
      const binding = bindingOf(means, NONE_CLIENT);
      expect(
        binding.issuedBy?.startsWith('mcp-abap-adt-binding/2;jwt/none;'),
      ).toBe(true);
      const token = jwtExpiringIn(3600, { jti: 'handed-over' });
      await make(dir).saveSession(
        D,
        asContract<IConfig>({ authorizationToken: token, ...binding }),
      );
      const reread = make(dir);
      const stored = await reread.loadSession(D);
      expect(stored?.issuedBy).toBe(binding.issuedBy);
      expect(stored?.issuedFor).toBe(binding.issuedFor);

      const broker = new AuthBroker({
        ...STATED,
        sessionStore: reread,
        serviceKeyStore: keyStore(means, NONE_CLIENT),
      });
      expect(await bearer(await broker.getProvider(D))).toBe(token);
    },
  );
});
