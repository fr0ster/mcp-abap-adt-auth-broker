/**
 * Reading SAML metadata for what a run would otherwise be told by hand.
 *
 * The fixtures are real documents with their identities replaced: an SAP
 * Cloud Identity Services tenant's IdP metadata (`/saml2/metadata`) and an
 * XSUAA subaccount's SP metadata (`<uaa.url>/saml/metadata`). Host names,
 * IDs and certificates are substituted; the structure is as served.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSamlTrustArg } from '../../../bin/mcpSsoConfig';
import {
  applySamlMetadata,
  loadMetadata,
  readIdpMetadata,
  readSpMetadata,
  type SamlMetadataTarget,
} from '../../../bin/samlMetadata';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const IAS = fixture('ias-idp-metadata.xml');
const XSUAA = fixture('xsuaa-sp-metadata.xml');

const IAS_URL = 'https://ias-tenant.accounts.example.com/saml2/metadata';
const UAA_URL = 'https://subaccount.authentication.example.com';
const BEARER_ALIAS = `${UAA_URL}/oauth/token/alias/subaccount.aws-live`;

const loaderFor =
  (documents: Record<string, string>) => async (source: string) => {
    const document = documents[source];
    if (document === undefined) throw new Error(`unexpected load: ${source}`);
    return document;
  };

describe('readIdpMetadata', () => {
  it('reads an IAS tenant: entityID, signing certificate, redirect SSO URL', () => {
    const idp = readIdpMetadata(IAS);

    expect(idp.entityId).toBe('https://ias-tenant.accounts.example.com');
    expect(idp.certificates).toHaveLength(1);
    expect(idp.certificates[0]).toMatch(/^MII[A-Za-z0-9+/=]+$/);
    expect(idp.ssoUrl).toMatch(
      /^https:\/\/ias-tenant\.accounts\.example\.com\/saml2\/idp\/sso/,
    );
  });

  it('trusts signing keys and keys without `use`, never an encryption key', () => {
    const idp = readIdpMetadata(`
      <md:EntityDescriptor xmlns:md="m" entityID="https://idp.example">
        <md:IDPSSODescriptor>
          <md:KeyDescriptor use="signing"><ds:X509Certificate>SIGN</ds:X509Certificate></md:KeyDescriptor>
          <md:KeyDescriptor><ds:X509Certificate>BOTH</ds:X509Certificate></md:KeyDescriptor>
          <md:KeyDescriptor use="encryption"><ds:X509Certificate>ENCRYPT</ds:X509Certificate></md:KeyDescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/post"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`);

    expect(idp.certificates).toEqual(['SIGN', 'BOTH']);
    // No redirect binding: the POST one stands in.
    expect(idp.ssoUrl).toBe('https://idp.example/post');
  });

  it('ignores keys of the SP role an IAS document also describes', () => {
    const idp = readIdpMetadata(`
      <EntityDescriptor entityID="https://idp.example">
        <SPSSODescriptor>
          <KeyDescriptor use="signing"><X509Certificate>SP-KEY</X509Certificate></KeyDescriptor>
        </SPSSODescriptor>
        <IDPSSODescriptor>
          <KeyDescriptor use="signing"><X509Certificate>IDP-KEY</X509Certificate></KeyDescriptor>
        </IDPSSODescriptor>
      </EntityDescriptor>`);

    expect(idp.certificates).toEqual(['IDP-KEY']);
  });

  it('refuses a document that is not an identity provider', () => {
    expect(() => readIdpMetadata(XSUAA)).toThrow(/no IDPSSODescriptor/);
  });
});

describe('readSpMetadata', () => {
  it('reads XSUAA: the Audience and the bearer alias', () => {
    expect(readSpMetadata(XSUAA)).toEqual({
      entityId: UAA_URL,
      bearerAcsUrl: BEARER_ALIAS,
    });
  });
});

describe('loadMetadata', () => {
  it('refuses plain http to anything but loopback: it carries trust', async () => {
    await expect(loadMetadata('http://idp.example/metadata')).rejects.toThrow(
      /must come over https/,
    );
  });
});

describe('applySamlMetadata', () => {
  it('fills a bearer run from a service key and the IdP metadata', async () => {
    const options: SamlMetadataTarget = {
      protocol: 'saml2',
      flow: 'bearer',
      uaaUrl: UAA_URL,
      idpMetadata: IAS_URL,
      // What the service-key branch sets, and a bearer grant must not use.
      tokenEndpoint: `${UAA_URL}/oauth/token`,
    };

    await applySamlMetadata(
      options,
      undefined,
      loaderFor({ [IAS_URL]: IAS, [`${UAA_URL}/saml/metadata`]: XSUAA }),
    );

    expect(options.idpEntityId).toBe('https://ias-tenant.accounts.example.com');
    expect(options.idpCertificates).toHaveLength(1);
    expect(options.idpSsoUrl).toMatch(/\/saml2\/idp\/sso/);
    expect(options.spEntityId).toBe(UAA_URL);
    expect(options.acsUrl).toBe(BEARER_ALIAS);
    expect(options.tokenEndpoint).toBe(BEARER_ALIAS);
  });

  it('never overrides what was stated, and never widens trust', async () => {
    // The stated entity IDs are ones the documents describe; what differs is
    // everything else, and none of it may be replaced.
    const options: SamlMetadataTarget = {
      protocol: 'saml2',
      flow: 'bearer',
      uaaUrl: UAA_URL,
      idpMetadata: IAS_URL,
      idpEntityId: 'https://ias-tenant.accounts.example.com',
      idpCertificateFiles: ['./stated.pem'],
      idpSsoUrl: 'https://stated.example/sso',
      spEntityId: UAA_URL,
      acsUrl: 'https://stated.example/acs',
    };

    await applySamlMetadata(
      options,
      'https://stated.example/token',
      loaderFor({ [IAS_URL]: IAS, [`${UAA_URL}/saml/metadata`]: XSUAA }),
    );

    expect(options.idpCertificates).toBeUndefined();
    expect(options.idpSsoUrl).toBe('https://stated.example/sso');
    expect(options.acsUrl).toBe('https://stated.example/acs');
    expect(options.tokenEndpoint).toBe('https://stated.example/token');
  });

  it('refuses metadata that does not describe the stated identity provider', async () => {
    // Taking the SSO URL or keys of an entity other than the one named would
    // trust someone nobody named.
    await expect(
      applySamlMetadata(
        {
          protocol: 'saml2',
          flow: 'pure',
          idpMetadata: IAS_URL,
          idpEntityId: 'https://stated.example',
        },
        undefined,
        loaderFor({ [IAS_URL]: IAS }),
      ),
    ).rejects.toThrow(
      /no identity provider with entityID "https:\/\/stated\.example"/,
    );
  });

  it('reads a --saml-metadata file before the service key', async () => {
    const options: SamlMetadataTarget = {
      protocol: 'saml2',
      flow: 'bearer',
      uaaUrl: 'https://other.example',
      samlMetadataPath: './sp.xml',
    };

    await applySamlMetadata(
      options,
      undefined,
      loaderFor({ './sp.xml': XSUAA }),
    );

    expect(options.acsUrl).toBe(BEARER_ALIAS);
  });

  it('refuses SP metadata with no bearer alias', async () => {
    await expect(
      applySamlMetadata(
        { protocol: 'saml2', flow: 'bearer', uaaUrl: UAA_URL },
        undefined,
        loaderFor({ [`${UAA_URL}/saml/metadata`]: IAS }),
      ),
    ).rejects.toThrow(/no \/oauth\/token\/alias\//);
  });

  it('reads no service-provider metadata for a pure run', async () => {
    const options: SamlMetadataTarget = {
      protocol: 'saml2',
      flow: 'pure',
      uaaUrl: UAA_URL,
      idpMetadata: IAS_URL,
    };

    // Only the IdP document is available: a pure run must not ask for more.
    await applySamlMetadata(options, undefined, loaderFor({ [IAS_URL]: IAS }));

    expect(options.acsUrl).toBeUndefined();
    expect(options.idpCertificates).toHaveLength(1);
  });

  it('does nothing for OIDC', async () => {
    const options: SamlMetadataTarget = {
      protocol: 'oidc',
      idpMetadata: IAS_URL,
    };
    await applySamlMetadata(options, undefined, loaderFor({}));
    expect(options.idpEntityId).toBeUndefined();
  });
});

describe('--idp-metadata', () => {
  it('is parsed as a SAML trust flag', () => {
    const target = {};
    expect(parseSamlTrustArg(target, '--idp-metadata', IAS_URL)).toBe(1);
    expect(target).toEqual({ idpMetadata: IAS_URL });
  });
});

describe('federation metadata (an EntitiesDescriptor of several entities)', () => {
  const idp = (id: string, cert: string) =>
    `<md:EntityDescriptor entityID="${id}"><md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:X509Certificate>${cert}</ds:X509Certificate></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://${cert}.example/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const sp = (id: string) =>
    `<md:EntityDescriptor entityID="${id}"><md:SPSSODescriptor><md:AssertionConsumerService Location="https://sp.example/acs"/></md:SPSSODescriptor></md:EntityDescriptor>`;
  const aggregate = (...entities: string[]) =>
    `<md:EntitiesDescriptor xmlns:md="m" Name="federation">${entities.join('')}</md:EntitiesDescriptor>`;

  it('takes the entityID of the entity whose keys it takes, not the first in the document', () => {
    // The first entity is a service provider: its entityID used to be paired
    // with the identity provider's certificate.
    const read = readIdpMetadata(
      aggregate(sp('https://sp.example'), idp('https://idp-a', 'CERTA')),
    );
    expect(read).toEqual({
      entityId: 'https://idp-a',
      certificates: ['CERTA'],
      ssoUrl: 'https://CERTA.example/sso',
    });
  });

  it('refuses to choose between identity providers nobody named', () => {
    expect(() =>
      readIdpMetadata(
        aggregate(idp('https://idp-a', 'CERTA'), idp('https://idp-b', 'CERTB')),
      ),
    ).toThrow(/2 identity providers.*--idp-entity-id.*idp-a.*idp-b/);
  });

  it('reads the identity provider --idp-entity-id names', () => {
    const read = readIdpMetadata(
      aggregate(idp('https://idp-a', 'CERTA'), idp('https://idp-b', 'CERTB')),
      'https://idp-b',
    );
    expect(read.entityId).toBe('https://idp-b');
    expect(read.certificates).toEqual(['CERTB']);
  });

  it('refuses an entityID the metadata does not describe', () => {
    expect(() =>
      readIdpMetadata(
        aggregate(idp('https://idp-a', 'CERTA')),
        'https://other',
      ),
    ).toThrow(/no identity provider with entityID "https:\/\/other"/);
  });

  it('fills idpEntityId from the chosen entity through applySamlMetadata', async () => {
    const options: SamlMetadataTarget = {
      protocol: 'saml2',
      flow: 'pure',
      idpMetadata: 'fed.xml',
      idpEntityId: 'https://idp-b',
    };
    await applySamlMetadata(
      options,
      undefined,
      loaderFor({
        'fed.xml': aggregate(
          sp('https://sp.example'),
          idp('https://idp-a', 'CERTA'),
          idp('https://idp-b', 'CERTB'),
        ),
      }),
    );
    expect(options.idpCertificates).toEqual(['CERTB']);
    expect(options.idpSsoUrl).toBe('https://CERTB.example/sso');
  });
});
