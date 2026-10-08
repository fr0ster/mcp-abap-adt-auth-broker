/**
 * The SAML destinations mcp-sso writes, built by the real broker into the real
 * auth-providers SAML providers — no mock of either package. What this pins,
 * without an identity provider:
 *
 * - missing trust material fails before anything is written, with a
 *   SamlTrustMissingError naming what is missing;
 * - with --idp-initiated the CLI's strategy never calls
 *   buildAuthorizationUrl, which auth-providers refuses for an IdP-initiated
 *   login: the login gets as far as validating the pasted assertion;
 * - the trust the CLI writes reaches the validator the broker builds: the
 *   signature is checked against the certificates written, and the validator
 *   is the kind the flow needs — bearer requires the Assertion signed, pure
 *   the Response.
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
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { readFailure } from '@mcp-abap-adt/auth-errors';
import {
  generateKeyMaterial,
  type KeyMaterial,
  signXml,
} from '@mcp-abap-adt/auth-mocks';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { completeMeans } from '../destination';
import {
  buildCollaborators,
  buildDestinationMeans,
  type McpSsoOptions,
  SamlTrustMissingError,
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
    uaaUrl: 'https://uaa.invalid',
    clientId: 'bearer-client',
    ...overrides,
  };
}

const silentLogger: ILogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * What a run does up to the login: the destination written through the key
 * store, then the provider the broker builds for it with the CLI's
 * collaborators.
 */
async function providerFor(
  flow: 'bearer' | 'pure',
  options: McpSsoOptions,
): Promise<{ getTokens: () => Promise<unknown> }> {
  const run = { ...options, flow };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-dest-'));
  dirs.push(dir);
  const keyStore = new EnvDestinationStore(dir);
  await keyStore.setDestination(
    'dest',
    completeMeans(buildDestinationMeans(run)),
  );
  const broker = new AuthBroker({
    sessionStore: new AbapSessionStore(dir),
    serviceKeyStore: keyStore,
    ...buildCollaborators(run, silentLogger),
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
  });
  return (await broker.getProvider('dest')) as never;
}

const dirs: string[] = [];

/** What a saml-assertion refusal says: its rule and the check it belongs to. */
interface AssertionRefusal {
  readonly check: string;
  readonly rule: string;
}

/**
 * The saml-assertion failure of the provider the broker built, read through
 * auth-errors — never by class: the workspace installs auth-providers once
 * per package, so no class of this file's copy would match.
 */
function expectAssertionRefusal(refusal: unknown): AssertionRefusal {
  const error = readFailure(refusal, 'validating-assertion');
  expect(error.kind).toBe('saml-assertion');
  const facts = error.facts as { check?: unknown; rule?: unknown };
  expect(typeof facts.check).toBe('string');
  expect(typeof facts.rule).toBe('string');
  return { check: String(facts.check), rule: String(facts.rule) };
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

    it('without trust material, the run fails with a SamlTrustMissingError naming each field', async () => {
      let caught: unknown;
      try {
        await providerFor(flow, samlOptions());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SamlTrustMissingError);
      expect((caught as SamlTrustMissingError).missingFields).toEqual([
        'idpCertificates',
        'idpEntityId',
      ]);
    });

    it('without certificates, nothing is built', async () => {
      await expect(
        providerFor(
          flow,
          samlOptions({ idpEntityId: 'https://idp.example/metadata' }),
        ),
      ).rejects.toThrow('missing idpCertificates');
    });

    it('with --idp-cert, --idp-entity-id and --idp-initiated, the login reaches assertion validation', async () => {
      const provider = await providerFor(
        flow,
        samlOptions({
          idpCertificateFiles: [certFile],
          idpEntityId: 'https://idp.example/metadata',
          idpInitiated: true,
          assertionFlow: 'manual',
        }),
      );
      // A configuration failure here would mean the strategy asked for an
      // authorization URL; the pasted document is refused by the validator
      // instead, before anything is sent anywhere.
      const refusal = await provider.getTokens().catch((error) => error);
      expect(expectAssertionRefusal(refusal).check).toBe('document');
    });
  },
);

describe.each([
  ['bearer' as const, 'saml2_bearer'],
  ['pure' as const, 'saml2_pure'],
])('the %s destination, read back through the key store', (flow, grant) => {
  it('holds saml / its grant, the trust and the request settings mcp-sso stated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-means-'));
    dirs.push(dir);
    const keyStore = new EnvDestinationStore(dir);
    await keyStore.setDestination(
      'dest',
      completeMeans(
        buildDestinationMeans(
          samlOptions({
            flow,
            idpCertificates: [TEST_IDP_CERT.trim()],
            idpEntityId: 'https://idp.example/metadata',
            idpInitiated: true,
            relayState: 'rs',
          }),
        ),
      ),
    );
    const means = await keyStore.getConnectionConfig('dest');
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'saml',
        grantType: grant,
        samlIdpSsoUrl: 'https://idp.example/sso',
        samlSpEntityId: 'https://uaa.example/entity',
        samlAcsUrl: 'https://uaa.example/oauth/token/alias/x',
        samlIdpEntityId: 'https://idp.example/metadata',
        samlIdpCertificates: [TEST_IDP_CERT.trim()],
        samlIdpInitiated: true,
        samlRelayState: 'rs',
      }),
    );
    if (flow === 'bearer') {
      expect(means?.samlTokenUrl).toBe('https://uaa.invalid/oauth/token');
      expect(await keyStore.getAuthorizationConfig('dest')).toEqual({
        uaaUrl: 'https://uaa.invalid',
        uaaClientId: 'bearer-client',
        uaaClientSecret: '',
      });
    }
  });
});

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

describe('the validator the broker builds from the trust mcp-sso writes, against a signed assertion', () => {
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
  ): Promise<AssertionRefusal> {
    mockPasted.value = assertionSignedResponse(signedBy);
    const provider = await providerFor(
      flow,
      samlOptions({
        idpCertificateFiles: [trustedCertFile],
        idpEntityId: IDP_ENTITY_ID,
        idpInitiated: true,
        assertionFlow: 'manual',
      }),
    );
    const refusal = await provider.getTokens().catch((error) => error);
    return expectAssertionRefusal(refusal);
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
    expect(refusal.rule).toBe('response-not-signed');
  });
});
