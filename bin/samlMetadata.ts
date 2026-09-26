/**
 * SAML metadata, read for what a SAML run would otherwise be told by hand.
 *
 * Two documents, two sides:
 * - the identity provider's (`--idp-metadata`): its entityID, its signing
 *   certificates and its SSO URL — what the assertion is validated against;
 * - the service provider's, which for XSUAA is `<uaa.url>/saml/metadata`: its
 *   entityID (the assertion's Audience) and the bearer endpoint
 *   `/oauth/token/alias/<alias>`, which is both the assertion's Recipient and
 *   the token endpoint of the saml2-bearer grant.
 *
 * What is read here is trust material. A certificate taken from metadata is
 * only as trustworthy as the channel that delivered it, so a URL must be
 * https; plain http is accepted for loopback hosts only, which is a local test
 * identity provider and nothing else.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export interface IdpMetadata {
  entityId?: string;
  /** Base64 DER, one per signing key (several during a key rotation). */
  certificates: string[];
  /** The SSO endpoint for the HTTP-Redirect binding, else HTTP-POST. */
  ssoUrl?: string;
}

export interface SpMetadata {
  entityId?: string;
  /** The ACS whose Location is `/oauth/token/alias/…` (the bearer endpoint). */
  bearerAcsUrl?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A metadata document from an https URL, a loopback http URL, or a file. */
export async function loadMetadata(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) {
      throw new Error(
        `refusing SAML metadata over ${url.protocol} from ${url.hostname}: it carries the certificates assertions are verified against, so it must come over https`,
      );
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`SAML metadata ${source} answered ${response.status}`);
    }
    return response.text();
  }
  return readFileSync(resolvePath(source), 'utf8');
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function entityIdOf(xml: string): string | undefined {
  const tag = xml.match(/<(?:[\w-]+:)?EntityDescriptor\b[^>]*>/)?.[0];
  return tag ? attribute(tag, 'entityID') : undefined;
}

/** The inner XML of the first `<prefix:name>` element, whatever the prefix. */
function section(xml: string, name: string): string | undefined {
  return xml.match(
    new RegExp(
      `<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    ),
  )?.[1];
}

export function readIdpMetadata(xml: string): IdpMetadata {
  const descriptor = section(xml, 'IDPSSODescriptor');
  if (descriptor === undefined) {
    throw new Error(
      'the metadata has no IDPSSODescriptor: not an identity provider',
    );
  }

  const certificates: string[] = [];
  const keyDescriptors = descriptor.matchAll(
    /<(?:[\w-]+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?KeyDescriptor>/g,
  );
  for (const [, attributes, body] of keyDescriptors) {
    // No `use` means the key serves both purposes (SAML metadata 2.4.1.1).
    if (attribute(attributes, 'use') === 'encryption') continue;
    for (const [, certificate] of body.matchAll(
      /<(?:[\w-]+:)?X509Certificate>([^<]+)</g,
    )) {
      certificates.push(certificate.replace(/\s+/g, ''));
    }
  }

  const ssoServices = [
    ...descriptor.matchAll(/<(?:[\w-]+:)?SingleSignOnService\b[^>]*>/g),
  ].map(([tag]) => ({
    binding: attribute(tag, 'Binding') ?? '',
    location: attribute(tag, 'Location'),
  }));
  const ssoUrl =
    ssoServices.find((s) => s.binding.endsWith(':HTTP-Redirect'))?.location ??
    ssoServices.find((s) => s.binding.endsWith(':HTTP-POST'))?.location;

  return { entityId: entityIdOf(xml), certificates, ssoUrl };
}

export function readSpMetadata(xml: string): SpMetadata {
  const bearerAcsUrl = [
    ...xml.matchAll(/<(?:[\w-]+:)?AssertionConsumerService\b[^>]*>/g),
  ]
    .map(([tag]) => attribute(tag, 'Location'))
    .find((location) => location?.includes('/oauth/token/alias/'));
  return { entityId: entityIdOf(xml), bearerAcsUrl };
}

/** The fields `applySamlMetadata` may fill. */
export interface SamlMetadataTarget {
  protocol?: string;
  flow?: string;
  uaaUrl?: string;
  samlMetadataPath?: string;
  idpMetadata?: string;
  idpEntityId?: string;
  idpCertificates?: string[];
  idpCertificateFiles?: string[];
  idpSsoUrl?: string;
  spEntityId?: string;
  acsUrl?: string;
  tokenEndpoint?: string;
}

/**
 * Fills what the metadata states and the caller did not. An explicit option
 * always wins, and trust is replaced rather than widened: a `--idp-cert`
 * means no certificate from the metadata is trusted alongside it.
 *
 * `explicitTokenEndpoint` is the `--token-endpoint` the user gave, if any —
 * distinct from `options.tokenEndpoint`, which a service key may already have
 * set to the plain `/oauth/token` that a bearer grant must not use.
 */
export async function applySamlMetadata(
  options: SamlMetadataTarget,
  explicitTokenEndpoint: string | undefined,
  load: (source: string) => Promise<string> = loadMetadata,
): Promise<void> {
  if (options.protocol !== 'saml2') return;

  if (options.idpMetadata) {
    const idp = readIdpMetadata(await load(options.idpMetadata));
    options.idpEntityId ??= idp.entityId;
    options.idpSsoUrl ??= idp.ssoUrl;
    if (
      options.idpCertificates === undefined &&
      options.idpCertificateFiles === undefined &&
      idp.certificates.length > 0
    ) {
      options.idpCertificates = idp.certificates;
    }
  }

  if (options.flow !== 'bearer') return;

  // The file wins over the service key's UAA, as an explicit source does.
  const spSource =
    options.samlMetadataPath ??
    (options.uaaUrl
      ? `${options.uaaUrl.replace(/\/+$/, '')}/saml/metadata`
      : undefined);
  if (!spSource) return;

  const sp = readSpMetadata(await load(spSource));
  if (!sp.bearerAcsUrl) {
    throw new Error(
      `${spSource} names no /oauth/token/alias/ endpoint: not an XSUAA service provider's metadata`,
    );
  }
  options.spEntityId ??= sp.entityId;
  options.acsUrl ??= sp.bearerAcsUrl;
  options.tokenEndpoint = explicitTokenEndpoint ?? sp.bearerAcsUrl;
}
