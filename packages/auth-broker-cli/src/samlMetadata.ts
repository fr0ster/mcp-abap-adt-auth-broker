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

import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { isBase64Text, isDerCertificate } from './certificateText';
import { systemCodeOf } from './output';
import { UsageError } from './subcommandArgs';
import { withoutTrailingSlashes } from './urlText';

export interface IdpMetadata {
  entityId?: string | undefined;
  /** Base64 DER, one per signing key (several during a key rotation). */
  certificates: string[];
  /** The SSO endpoint for the HTTP-Redirect binding, else HTTP-POST. */
  ssoUrl?: string | undefined;
}

export interface SpMetadata {
  entityId?: string | undefined;
  /** The ACS whose Location is `/oauth/token/alias/…` (the bearer endpoint). */
  bearerAcsUrl?: string | undefined;
}

/**
 * The largest metadata document read, in bytes. One identity provider's or
 * one XSUAA subaccount's metadata is a few kilobytes; a document past this is
 * refused before it is parsed — and a server's answer is never read past it.
 */
export const MAX_METADATA_BYTES = 1024 * 1024;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** SAML 2.0 metadata's namespace: only its elements are read. */
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
/** XML Signature's namespace: `KeyInfo`, `X509Data`, `X509Certificate`. */
const DS = 'http://www.w3.org/2000/09/xmldsig#';

/** The refusal of an oversized document, by the flag that named it. */
const tooLarge = (flag: string) =>
  new UsageError(`${flag}: the metadata is larger than 1 MiB`);

/** Whether `source` names an http(s) URL, read as the scheme's letters. */
function isHttpUrl(source: string): boolean {
  const head = source.slice(0, 8).toLowerCase();
  return head.startsWith('https://') || head.startsWith('http://');
}

/**
 * A response body, read only up to `MAX_METADATA_BYTES`: past it the stream
 * is cancelled and the document refused.
 */
async function boundedText(response: Response, flag: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let read: Awaited<ReturnType<typeof reader.read>>;
    try {
      read = await reader.read();
    } catch (error) {
      throw new UsageError(
        `${flag}: the metadata could not be fetched${systemCodeOf(error)}`,
      );
    }
    const { done, value } = read;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(flag);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A metadata document from an https URL, a loopback http URL, or a file.
 * `flag` is where the source came from (`--idp-metadata`, `--saml-metadata`,
 * `--service-key`): a failure of the CLI's own read or fetch is refused naming
 * it — the path the user gave, or no URL at all (it may carry a query or
 * userinfo) — with an allowlisted system code, never the failure's message.
 * A document larger than `MAX_METADATA_BYTES` is refused, never read whole.
 */
export async function loadMetadata(
  source: string,
  flag: string,
): Promise<string> {
  if (isHttpUrl(source)) {
    const url = new URL(source);
    if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) {
      throw new UsageError(
        `${flag}: refusing SAML metadata over ${url.protocol}: it carries the certificates assertions are verified against, so it must come over https`,
      );
    }
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new UsageError(
        `${flag}: the metadata could not be fetched${systemCodeOf(error)}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UsageError(
        `${flag}: the metadata server answered ${response.status}`,
      );
    }
    return boundedText(response, flag);
  }
  const file = resolvePath(source);
  const unreadable = (error: unknown) =>
    new UsageError(`${flag}: ${file} cannot be read${systemCodeOf(error)}`);
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    throw unreadable(error);
  }
  if (size > MAX_METADATA_BYTES) throw tooLarge(flag);
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw unreadable(error);
  }
}

/** The refusal of a document the parser faulted on: nothing of it quoted. */
const notWellFormed = (flag: string) =>
  new UsageError(`${flag}: the metadata is not well-formed XML`);

/**
 * `xml` parsed strictly: a DOCTYPE — the door to entity expansion and
 * external entities — is refused before the parser sees the document, and so
 * is one larger than `MAX_METADATA_BYTES`; any fault of the parser, at any
 * level, is a refusal, never a repaired document, and the parser writes
 * nothing to the console.
 */
function parseMetadata(xml: string, flag: string): Element {
  if (Buffer.byteLength(xml, 'utf8') > MAX_METADATA_BYTES) {
    throw tooLarge(flag);
  }
  if (xml.toUpperCase().includes('<!DOCTYPE')) {
    throw new UsageError(
      `${flag}: the metadata carries a DOCTYPE, which SAML metadata never needs: refused before it is parsed`,
    );
  }
  let root: Element | null;
  try {
    root = new DOMParser({
      onError: () => {
        throw notWellFormed(flag);
      },
    }).parseFromString(xml, 'text/xml').documentElement;
  } catch {
    // xmldom may wrap what `onError` threw in an error quoting the document.
    throw notWellFormed(flag);
  }
  if (root === null) throw notWellFormed(flag);
  return root;
}

/** Whether `node` is a metadata element (`md:<name>`), or `ds:<name>`. */
function isElement(node: Node, namespace: string, name: string): boolean {
  if (node.nodeType !== node.ELEMENT_NODE) return false;
  const element = node as Element;
  return element.namespaceURI === namespace && element.localName === name;
}

/** The direct children of `parent` that are `<namespace>:<name>`. */
function childrenOf(
  parent: Element,
  namespace: string,
  name: string,
): Element[] {
  const found: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes.item(i);
    if (child !== null && isElement(child, namespace, name)) {
      found.push(child as Element);
    }
  }
  return found;
}

/** How many `<namespace>:<name>` elements there are below `ancestor`. */
function countBelow(
  ancestor: Element,
  namespace: string,
  name: string,
): number {
  return ancestor.getElementsByTagNameNS(namespace, name).length;
}

/** An attribute's value, or `undefined` when the element does not state it. */
function attributeOf(element: Element, name: string): string | undefined {
  return element.hasAttribute(name)
    ? (element.getAttribute(name) ?? undefined)
    : undefined;
}

/**
 * `text` without XML's whitespace — space, tab, line feed, carriage return —
 * in one pass (base64 in metadata wraps). Any other character, a no-break
 * space included, stays and fails the certificate check.
 */
function withoutXmlWhitespace(text: string): string {
  let kept = '';
  for (const character of text) {
    if (
      character !== ' ' &&
      character !== '\t' &&
      character !== '\n' &&
      character !== '\r'
    ) {
      kept += character;
    }
  }
  return kept;
}

/**
 * Every `EntityDescriptor` the document states: the root itself, or the
 * children of an `EntitiesDescriptor` (federation metadata), nested
 * `EntitiesDescriptor`s included. An `EntityDescriptor` anywhere else — inside
 * another entity, an extension — is refused: whose keys it carries is not a
 * question metadata leaves open.
 */
function entitiesOf(root: Element, flag: string): Element[] {
  const entities: Element[] = [];
  // An explicit stack, in document order: a nest as deep as the size limit
  // allows is walked without recursion.
  const pending: Element[] = [root];
  for (;;) {
    const element = pending.pop();
    if (element === undefined) break;
    if (isElement(element, MD, 'EntityDescriptor')) {
      entities.push(element);
      continue;
    }
    if (!isElement(element, MD, 'EntitiesDescriptor')) continue;
    for (let i = element.childNodes.length - 1; i >= 0; i--) {
      const child = element.childNodes.item(i);
      if (child !== null && child.nodeType === child.ELEMENT_NODE) {
        pending.push(child as Element);
      }
    }
  }
  const stated = isElement(root, MD, 'EntityDescriptor') ? 1 : 0;
  if (countBelow(root, MD, 'EntityDescriptor') + stated !== entities.length) {
    throw new UsageError(
      `${flag}: an EntityDescriptor is nested inside another element: refused`,
    );
  }
  return entities;
}

/**
 * The one entity the caller means. With a wanted entityID, the entity with
 * it; without one, the only candidate — several are a question only the
 * caller can answer, and picking the first would trust an identity provider
 * nobody named.
 */
function chooseEntity(
  candidates: Element[],
  wanted: string | undefined,
  role: string,
  flag: string,
  entityFlag: string,
): Element {
  if (wanted !== undefined) {
    const match = candidates.find(
      (entity) => attributeOf(entity, 'entityID') === wanted,
    );
    if (!match) {
      // The entityID the user stated is quoted; the document's are the
      // server's text: counted, never quoted.
      throw new UsageError(
        `${flag}: the metadata has no ${role} with entityID ${JSON.stringify(wanted)}; it describes ${candidates.length}`,
      );
    }
    return match;
  }
  const [only, ...others] = candidates;
  if (only === undefined) {
    throw new UsageError(`${flag}: the metadata describes no ${role}`);
  }
  if (others.length > 0) {
    throw new UsageError(
      `${flag}: the metadata describes ${candidates.length} ${role}s; name the one to use with ${entityFlag}`,
    );
  }
  return only;
}

/** The entity's entityID; an entity that states none is refused. */
function entityIdOf(entity: Element, role: string, flag: string): string {
  const entityId = attributeOf(entity, 'entityID');
  if (entityId === undefined || entityId === '') {
    throw new UsageError(`${flag}: the ${role} states no entityID`);
  }
  return entityId;
}

/**
 * The signing certificates of an `IDPSSODescriptor`: each direct
 * `KeyDescriptor` whose `use` is `signing` or absent (a key without `use`
 * serves both purposes, SAML metadata 2.4.1.1), read only at
 * `KeyDescriptor/ds:KeyInfo/ds:X509Data/ds:X509Certificate`. A
 * `KeyDescriptor` anywhere else in the descriptor is refused.
 */
function signingCertificatesOf(descriptor: Element, flag: string): string[] {
  const keyDescriptors = childrenOf(descriptor, MD, 'KeyDescriptor');
  if (countBelow(descriptor, MD, 'KeyDescriptor') !== keyDescriptors.length) {
    throw new UsageError(
      `${flag}: a KeyDescriptor is nested inside another element: refused`,
    );
  }
  const certificates: string[] = [];
  for (const keyDescriptor of keyDescriptors) {
    const use = attributeOf(keyDescriptor, 'use');
    if (use !== undefined && use !== 'signing') continue;
    for (const keyInfo of childrenOf(keyDescriptor, DS, 'KeyInfo')) {
      for (const x509Data of childrenOf(keyInfo, DS, 'X509Data')) {
        for (const element of childrenOf(x509Data, DS, 'X509Certificate')) {
          const certificate = withoutXmlWhitespace(element.textContent ?? '');
          if (certificate === '') {
            throw new UsageError(
              `${flag}: a signing key states no certificate`,
            );
          }
          if (
            !isBase64Text(certificate) ||
            !isDerCertificate(Buffer.from(certificate, 'base64'))
          ) {
            throw new UsageError(
              `${flag}: a signing key states a certificate that is not an X.509 certificate`,
            );
          }
          certificates.push(certificate);
        }
      }
    }
  }
  return certificates;
}

/** The SSO endpoint for the HTTP-Redirect binding, else HTTP-POST. */
function ssoUrlOf(descriptor: Element): string | undefined {
  const services = childrenOf(descriptor, MD, 'SingleSignOnService').map(
    (service) => ({
      binding: attributeOf(service, 'Binding') ?? '',
      location: attributeOf(service, 'Location'),
    }),
  );
  return (
    services.find((s) => s.binding.endsWith(':HTTP-Redirect'))?.location ??
    services.find((s) => s.binding.endsWith(':HTTP-POST'))?.location
  );
}

/**
 * The identity provider in `xml`: the one whose entityID is `entityId`, or the
 * only one there is. `flag` names the source in every refusal.
 */
export function readIdpMetadata(
  xml: string,
  entityId?: string,
  flag = '--idp-metadata',
): IdpMetadata {
  const root = parseMetadata(xml, flag);
  const candidates = entitiesOf(root, flag).filter(
    (entity) => childrenOf(entity, MD, 'IDPSSODescriptor').length > 0,
  );
  if (candidates.length === 0) {
    throw new UsageError(
      `${flag}: the metadata has no IDPSSODescriptor: not an identity provider`,
    );
  }
  const entity = chooseEntity(
    candidates,
    entityId,
    'identity provider',
    flag,
    '--idp-entity-id',
  );
  const [descriptor, ...more] = childrenOf(entity, MD, 'IDPSSODescriptor');
  if (descriptor === undefined || more.length > 0) {
    throw new UsageError(
      `${flag}: the identity provider has more than one IDPSSODescriptor`,
    );
  }
  return {
    entityId: entityIdOf(entity, 'identity provider', flag),
    certificates: signingCertificatesOf(descriptor, flag),
    ssoUrl: ssoUrlOf(descriptor),
  };
}

/**
 * The bearer ACS of an entity: the `AssertionConsumerService` of its
 * `SPSSODescriptor` whose Location is at `/oauth/token/alias/`.
 */
function bearerAcsOf(entity: Element): string | undefined {
  for (const descriptor of childrenOf(entity, MD, 'SPSSODescriptor')) {
    for (const service of childrenOf(
      descriptor,
      MD,
      'AssertionConsumerService',
    )) {
      const location = attributeOf(service, 'Location');
      if (location?.includes('/oauth/token/alias/')) return location;
    }
  }
  return undefined;
}

/**
 * The XSUAA service provider in `xml`: the entity publishing a bearer ACS,
 * `spEntityId`'s when several do. `flag` names the source in every refusal.
 */
export function readSpMetadata(
  xml: string,
  spEntityId?: string,
  flag = '--saml-metadata',
): SpMetadata {
  const root = parseMetadata(xml, flag);
  const candidates = entitiesOf(root, flag).filter(
    (entity) => bearerAcsOf(entity) !== undefined,
  );
  if (candidates.length === 0) return {};
  const entity = chooseEntity(
    candidates,
    spEntityId,
    'XSUAA service provider',
    flag,
    '--sp-entity-id',
  );
  return {
    entityId: entityIdOf(entity, 'XSUAA service provider', flag),
    bearerAcsUrl: bearerAcsOf(entity),
  };
}

/** The fields `applySamlMetadata` may fill. */
export interface SamlMetadataTarget {
  protocol?: string | undefined;
  flow?: string | undefined;
  uaaUrl?: string | undefined;
  samlMetadataPath?: string | undefined;
  idpMetadata?: string | undefined;
  idpEntityId?: string | undefined;
  idpCertificates?: string[] | undefined;
  idpCertificateFiles?: string[] | undefined;
  idpSsoUrl?: string | undefined;
  spEntityId?: string | undefined;
  acsUrl?: string | undefined;
  tokenEndpoint?: string | undefined;
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
  load: (source: string, flag: string) => Promise<string> = loadMetadata,
): Promise<void> {
  if (options.protocol !== 'saml2') return;

  if (options.idpMetadata) {
    const idp = readIdpMetadata(
      await load(options.idpMetadata, '--idp-metadata'),
      options.idpEntityId,
      '--idp-metadata',
    );
    options.idpEntityId ??= idp.entityId;
    options.idpSsoUrl ??= idp.ssoUrl;
    if (
      options.idpCertificates === undefined &&
      options.idpCertificateFiles === undefined
    ) {
      if (idp.certificates.length === 0) {
        throw new UsageError(
          '--idp-metadata: the identity provider states no signing certificate',
        );
      }
      options.idpCertificates = idp.certificates;
    }
  }

  if (options.flow !== 'bearer') return;

  // The file wins over the service key's UAA, as an explicit source does.
  const spSource =
    options.samlMetadataPath ??
    (options.uaaUrl
      ? `${withoutTrailingSlashes(options.uaaUrl)}/saml/metadata`
      : undefined);
  if (!spSource) return;

  const spFlag =
    options.samlMetadataPath !== undefined
      ? '--saml-metadata'
      : '--service-key';
  const sp = readSpMetadata(
    await load(spSource, spFlag),
    options.spEntityId,
    spFlag,
  );
  if (!sp.bearerAcsUrl) {
    throw new UsageError(
      `${spFlag}: the metadata names no /oauth/token/alias/ endpoint: not an XSUAA service provider's metadata`,
    );
  }
  options.spEntityId ??= sp.entityId;
  options.acsUrl ??= sp.bearerAcsUrl;
  options.tokenEndpoint = explicitTokenEndpoint ?? sp.bearerAcsUrl;
}
