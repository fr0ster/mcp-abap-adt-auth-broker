/**
 * The configs mcpSsoConfig.ts builds, handed to the real auth-providers
 * SAML providers — no mock of the package. What this pins, without an
 * identity provider:
 *
 * - missing trust material fails before construction with a ValidationError
 *   naming what is missing: since auth-providers 5 the CLI builds the
 *   assertion validator itself, from the trust it collects;
 * - with --idp-initiated the CLI's strategy never calls
 *   buildAuthorizationUrl, which auth-providers refuses for an IdP-initiated
 *   login: the login gets as far as validating the pasted assertion;
 * - the validator each flow gets checks the signature against the trusted
 *   certificates, and is the kind its flow needs: bearer requires the
 *   Assertion signed, pure the Response.
 */

// The IdP-initiated strategy reads the pasted SAMLResponse through
// readManualInput; answer it here instead of waiting on a terminal.
const mockPasted = {
  value: Buffer.from('<not-a-saml-response/>').toString('base64'),
};
jest.mock('node:readline', () => ({
  createInterface: () => {
    // Like the real interface, `close()` emits 'close'.
    const onClose: Array<() => void> = [];
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (_prompt: string, answer: (value: string) => void) =>
        answer(mockPasted.value),
      close: () => {
        for (const listener of onClose) listener();
      },
    };
  },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateKeyMaterial,
  type KeyMaterial,
  signXml,
} from '@mcp-abap-adt/auth-mocks';
import {
  AssertionValidationError,
  Saml2BearerProvider,
  Saml2PureProvider,
  ValidationError,
} from '@mcp-abap-adt/auth-providers';
import {
  buildSamlBearerConfig,
  buildSamlPureConfig,
  type McpSsoOptions,
} from '../mcpSsoConfig';

// A self-signed certificate made for this test only; its key was discarded.
const TEST_IDP_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIDGTCCAgGgAwIBAgIUDfBDG1m0wPkxG10US30+wXm9xp4wDQYJKoZIhvcNAQEL\n' +
  'BQAwGzEZMBcGA1UEAwwQbWNwLXNzbyB0ZXN0IElkUDAgFw0yNjA5MjYxMDQ2MDJa\n' +
  'GA8yMTI2MDkwMjEwNDYwMlowGzEZMBcGA1UEAwwQbWNwLXNzbyB0ZXN0IElkUDCC\n' +
  'ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOymnDfgxs4GQ/DUDV7lg+aT\n' +
  'rfbTbeL6kRc/QZcszi+OccChInkmKcly27rtuN9v8ROdlZmndg59jshnu5E4yUFc\n' +
  '7WfaRzVsHtkVRPLnkDnfC/s/3IdsYbgLljWBmxBLXQSV7Xe3kHZxiTt0bALRekGp\n' +
  'grNPBcem7Z48/aLjymFKHHlqqFjjRIDjD7Bgh05OL6KptsNc65ddgC5r1NEuqnjb\n' +
  'Gd9jvomV6HmCuhvIA5APPOo/NdpgnQsdbm52IuVU+C1E9YGfupc1nxlQc90XbU95\n' +
  'HKNyTY7mKDfJdC0a95ZaXpYryZWvL0jBZx4vZKgm3vPwBLNboaEZfVJA6YBlexkC\n' +
  'AwEAAaNTMFEwHQYDVR0OBBYEFAMZt78uLJQTrqAaBxhZfM1mb5PmMB8GA1UdIwQY\n' +
  'MBaAFAMZt78uLJQTrqAaBxhZfM1mb5PmMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI\n' +
  'hvcNAQELBQADggEBAHdySi/l2iXmPqZ8aGmo4y8NjCGkMj8Kw/I8I0rMu6geYKU2\n' +
  'CCLi+YTf6YP7bTHpJHvl12X2tsTigsruqrF8dkDliSeCCD0eVI+H8hFNUuuVcqGg\n' +
  'vCw/+2fWQieGFIVcg9ZAbtSAujw5/0JzytcC5sYrjIPD4EfPeYt91VBzEEtbejOl\n' +
  'kF+Tp2iLGu7x//LJ6+c0oiqgSbA8GXiA6KDGalshOsmpeIXETD1dN9p+KZtGifSK\n' +
  'x3DAHO9BXjA5y1/hu6GwaCKkpLK/7rFagDhAPEh2IJdOuPcKJe8KsQf9luKzN5Dh\n' +
  'q6I45L++OrK5aO6rWRNndOUoe+GWGtRy3O42BSw=\n' +
  '-----END CERTIFICATE-----\n';

function samlOptions(overrides: Partial<McpSsoOptions> = {}): McpSsoOptions {
  return {
    authType: 'xsuaa',
    format: 'env',
    protocol: 'saml2',
    idpSsoUrl: 'https://idp.example/sso',
    spEntityId: 'https://uaa.example/entity',
    acsUrl: 'https://uaa.example/oauth/token/alias/x',
    tokenEndpoint: 'https://uaa.invalid/oauth/token',
    ...overrides,
  };
}

const construct = {
  bearer: (options: McpSsoOptions) =>
    new Saml2BearerProvider(buildSamlBearerConfig(options)),
  pure: (options: McpSsoOptions) =>
    new Saml2PureProvider(buildSamlPureConfig(options)),
};

describe.each([['bearer' as const], ['pure' as const]])(
  'mcp-sso %s config against the real SAML provider',
  (flow) => {
    let tempDir: string;
    let certFile: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-saml-'));
      certFile = path.join(tempDir, 'idp.pem');
      fs.writeFileSync(certFile, TEST_IDP_CERT);
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('without trust material, construction fails with the provider ValidationError', () => {
      let caught: unknown;
      try {
        construct[flow](samlOptions());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).missingFields).toEqual([
        'idpCertificates',
        'idpEntityId',
      ]);
    });

    it('without trust material, no validator is built and no provider constructed', () => {
      expect(() =>
        construct[flow](
          samlOptions({ idpEntityId: 'https://idp.example/metadata' }),
        ),
      ).toThrow('missing idpCertificates');
    });

    it('with --idp-initiated and --authn-request-id, construction fails in the provider', () => {
      expect(() =>
        construct[flow](
          samlOptions({
            idpCertificateFiles: [certFile],
            idpEntityId: 'https://idp.example/metadata',
            idpInitiated: true,
            authnRequestId: '_req1',
          }),
        ),
      ).toThrow(ValidationError);
    });

    it('with --idp-cert, --idp-entity-id and --idp-initiated, the login reaches assertion validation', async () => {
      const provider = construct[flow](
        samlOptions({
          idpCertificateFiles: [certFile],
          idpEntityId: 'https://idp.example/metadata',
          idpInitiated: true,
          assertionFlow: 'manual',
        }),
      );
      // A ValidationError here would mean the strategy asked for an
      // authorization URL; the pasted document is refused by the validator
      // instead, before anything is sent anywhere.
      const refusal = await provider.getTokens().catch((error) => error);
      expect(refusal).toBeInstanceOf(AssertionValidationError);
      expect((refusal as AssertionValidationError).check).toBe('document');
    });
  },
);

const IDP_ENTITY_ID = 'https://idp.example/metadata';

/** A Response whose Assertion alone is signed, as most identity providers send. */
function assertionSignedResponse(key: KeyMaterial): string {
  const now = new Date().toISOString();
  const xml =
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ' +
    'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ' +
    `ID="_response1" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>' +
    `<saml:Assertion ID="_assertion1" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    '<saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject>' +
    '</saml:Assertion></samlp:Response>';
  return Buffer.from(signXml(xml, key)).toString('base64');
}

describe('the validator mcp-sso builds, against a signed assertion', () => {
  let tempDir: string;
  let trusted: KeyMaterial;
  let other: KeyMaterial;
  let trustedCertFile: string;

  beforeAll(() => {
    trusted = generateKeyMaterial();
    other = generateKeyMaterial();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-signed-'));
    trustedCertFile = path.join(tempDir, 'idp.pem');
    fs.writeFileSync(trustedCertFile, trusted.certificatePem);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function refusalOf(
    flow: 'bearer' | 'pure',
    signedBy: KeyMaterial,
  ): Promise<AssertionValidationError> {
    mockPasted.value = assertionSignedResponse(signedBy);
    const provider = construct[flow](
      samlOptions({
        idpCertificateFiles: [trustedCertFile],
        idpEntityId: IDP_ENTITY_ID,
        idpInitiated: true,
        assertionFlow: 'manual',
      }),
    );
    const refusal = await provider.getTokens().catch((error) => error);
    expect(refusal).toBeInstanceOf(AssertionValidationError);
    return refusal as AssertionValidationError;
  }

  it.each([['bearer' as const], ['pure' as const]])(
    '%s refuses an assertion signed by a key it does not trust',
    async (flow) => {
      const refusal = await refusalOf(flow, other);
      expect(refusal.check).toBe('signature');
    },
  );

  it('bearer accepts the signature on the Assertion (saml2-bearer sends the Assertion alone)', async () => {
    const refusal = await refusalOf('bearer', trusted);
    // Refused later, for what the fixture leaves out — past the signature
    // and the signed-element checks.
    expect(['signature', 'signedNode']).not.toContain(refusal.check);
  });

  it('pure requires the Response signed', async () => {
    const refusal = await refusalOf('pure', trusted);
    expect(refusal.check).toBe('signedNode');
    expect(refusal.message).toContain(
      'the signature does not cover the samlp:Response',
    );
  });
});
