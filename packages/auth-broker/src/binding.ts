/**
 * A secret is bound to the resource it was obtained for and to who issued it.
 *
 * The session store keeps two strings beside the secret — `issuedFor`, the
 * resource, and `issuedBy`, the issuer and its client — and the broker uses a
 * stored secret only when both equal what this destination's means give. The
 * store keeps them as given; the broker canonicalises **both sides** before it
 * compares, with the one function here (the broker's only, decided), so a store
 * need not canonicalise and a legacy file's composed URI compares equal.
 *
 * The canonical URI:
 * - scheme and host lower-cased (by `URL`, for http and https);
 * - the port explicit — `443` for `https`, `80` for `http` when the URL has
 *   none; another scheme keeps the port it states;
 * - the path without a trailing `/` (the root path is empty), its case kept;
 * - one query parameter at most — `sap-client=<n>` for a resource,
 *   `client_id=<id>` for an issuer, none for a SAML ACS — parsed and
 *   re-encoded with `URLSearchParams`, so a value percent-encoded on one side
 *   and plain on the other compares equal;
 * - no user info, no other parameter, no fragment.
 *
 * A URL that does not parse, or has no host, has no canonical form: the
 * binding is then absent, never guessed.
 */

import type {
  IConfig,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { asContract } from './contractShape';

/** What a binding reads of a client: who it is, never its secret. */
export type BoundClient = Pick<IAuthorizationConfig, 'uaaUrl' | 'uaaClientId'>;

/** The default port a URL without one is taken to mean. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'https:': '443',
  'http:': '80',
};

function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The canonical URI of `raw`, keeping only the query parameter `param` — its
 * value `override` when given, else the one `raw` carries.
 */
function canonical(
  raw: unknown,
  param: string | undefined,
  override?: string,
): string | undefined {
  if (!present(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // `URL` lower-cases the scheme, and the host of an http(s) URL. Another
  // scheme's host is kept as written: no form beyond http(s) is defined yet.
  const host = url.hostname;
  if (host === '') return undefined;
  const scheme = url.protocol;
  const port = url.port || DEFAULT_PORTS[scheme] || '';
  const path = url.pathname.replace(/\/+$/, '');
  let query = '';
  if (param) {
    const value = present(override) ? override : url.searchParams.get(param);
    if (present(value)) {
      query = `?${new URLSearchParams([[param, value]]).toString()}`;
    }
  }
  return `${scheme}//${host}${port ? `:${port}` : ''}${path}${query}`;
}

/**
 * The resource: `serviceUrl` with the SAP client as `sap-client` — the
 * destination's `sapClient` when it states one, over a `sap-client` already in
 * the URL. For a stored value, call it without `sapClient`.
 */
export function resourceUri(
  serviceUrl: unknown,
  sapClient?: string,
): string | undefined {
  return canonical(serviceUrl, 'sap-client', sapClient);
}

/**
 * The issuer and its client: the authorization server's base URL with
 * `client_id`. For a stored value, call it without `clientId`.
 */
export function issuerUri(
  issuerUrl: unknown,
  clientId?: string,
): string | undefined {
  return canonical(issuerUrl, 'client_id', clientId);
}

/** The ACS of the system that set SAML session cookies: origin and path. */
export function acsUri(acsUrl: unknown): string | undefined {
  return canonical(acsUrl, undefined);
}

/** How a stored `issuedBy` is read: as an issuer with its client, or as an ACS. */
export type IssuerKind = 'issuer' | 'acs';

/** What this destination's means bind a secret to, canonical; absent where they cannot say. */
export interface Binding {
  issuedFor?: string | undefined;
  issuedBy?: string | undefined;
  /** How the stored `issuedBy` is canonicalised before it is compared. */
  issuerKind: IssuerKind;
  /**
   * The means state an issuer — for a `none` row, whether `issuedBy` is
   * compared at all. True even when the stated URL does not parse: then it
   * matches nothing.
   */
  issuerStated: boolean;
  /**
   * Set on the `clientAuthentication` strategy path only: a resource neither
   * side states — no `issuedFor` computed (no service URL, or one that does
   * not parse, as the CLI's XSUAA placeholder) and none stored — matches, so
   * the issuer and client alone decide. A resource stated on one side only
   * never matches. Without it (the 4.0.0 path) an absent resource matches
   * nothing.
   */
  unstatedResourceMatches?: true;
}

/** The resource the means name: `serviceUrl` with `sapClient`. */
function resourceOf(means: IConnectionConfig): string | undefined {
  return resourceUri(
    means.serviceUrl,
    present(means.sapClient) ? means.sapClient : undefined,
  );
}

/**
 * The UAA grants (`authorization_code`, `client_credentials`, `passcode`) and
 * `saml2_bearer`, whose token UAA issues to its client: the resource, and `uaaUrl` with `uaaClientId` — both required to match.
 */
export function uaaBinding(
  means: IConnectionConfig,
  client: BoundClient | null,
): Binding {
  const stated = present(client?.uaaUrl) && present(client?.uaaClientId);
  return {
    issuedFor: resourceOf(means),
    issuedBy: stated
      ? issuerUri(client?.uaaUrl, client?.uaaClientId)
      : undefined,
    issuerKind: 'issuer',
    issuerStated: stated,
  };
}

/**
 * The OIDC grants: the resource, and the issuer — `oidcIssuerUrl`, else
 * `uaaUrl` — with `uaaClientId`; both required to match. Means that state
 * neither issuer (explicit endpoints alone) bind no stored secret: one is then
 * never seeded.
 */
export function oidcBinding(
  means: IConnectionConfig,
  client: BoundClient | null,
): Binding {
  const issuer = present(means.oidcIssuerUrl)
    ? means.oidcIssuerUrl
    : client?.uaaUrl;
  const stated = present(issuer) && present(client?.uaaClientId);
  return {
    issuedFor: resourceOf(means),
    issuedBy: stated ? issuerUri(issuer, client?.uaaClientId) : undefined,
    issuerKind: 'issuer',
    issuerStated: stated,
  };
}

/**
 * `saml2_pure`: the resource, and the ACS of the system that sets the
 * cookies — `samlAcsUrl`, origin and path; both required to match.
 */
export function samlPureBinding(means: IConnectionConfig): Binding {
  return {
    issuedFor: resourceOf(means),
    issuedBy: acsUri(means.samlAcsUrl),
    issuerKind: 'acs',
    issuerStated: present(means.samlAcsUrl),
  };
}

/**
 * The token API with a consumer's provider: what the broker handed
 * that provider — the `serviceUrl` it resolved, with the SAP client, and for a
 * factory the client it resolved (`uaaUrl` with `uaaClientId`). An instance is
 * handed no client, so no issuer is claimed for what it obtains: `issuedBy` is
 * then absent, and `getProvider` never seeds from that secret.
 */
export function consumerBinding(
  serviceUrl: string,
  sapClient: string | undefined,
  client: BoundClient | null,
): Binding {
  return uaaBinding(
    asContract<IConnectionConfig>({ serviceUrl, sapClient }),
    client,
  );
}

/**
 * A binding on the `clientAuthentication` strategy path: a resource that
 * neither the means nor the stored session state matches, so the issuer and
 * client alone decide (`Binding.unstatedResourceMatches`).
 */
export function strategyBinding(binding: Binding): Binding {
  return { ...binding, unstatedResourceMatches: true };
}

/**
 * A `none` row: the resource always; the issuer only when the means state one
 * — `oidcIssuerUrl` (with `uaaClientId` when stated) or the client (`uaaUrl`
 * and `uaaClientId`) for `jwt`, `samlAcsUrl` for `saml`.
 */
export function handedOverBinding(
  authType: 'jwt' | 'saml',
  means: IConnectionConfig,
  client: BoundClient | null,
): Binding {
  const issuedFor = resourceOf(means);
  if (authType === 'saml') {
    return {
      issuedFor,
      issuedBy: acsUri(means.samlAcsUrl),
      issuerKind: 'acs',
      issuerStated: present(means.samlAcsUrl),
    };
  }
  const clientId = present(client?.uaaClientId)
    ? client.uaaClientId
    : undefined;
  if (present(means.oidcIssuerUrl)) {
    return {
      issuedFor,
      issuedBy: issuerUri(means.oidcIssuerUrl, clientId),
      issuerKind: 'issuer',
      issuerStated: true,
    };
  }
  const stated = present(client?.uaaUrl) && clientId !== undefined;
  return {
    issuedFor,
    issuedBy: stated ? issuerUri(client?.uaaUrl, clientId) : undefined,
    issuerKind: 'issuer',
    issuerStated: stated,
  };
}

/**
 * The stored `issuedFor`, canonicalised, equals the destination's — or, with
 * `unstatedResourceMatches`, neither states one.
 */
export function sameResource(
  stored: IConfig | null,
  binding: Binding,
): boolean {
  if (binding.issuedFor === undefined) {
    return (
      binding.unstatedResourceMatches === true && !present(stored?.issuedFor)
    );
  }
  return resourceUri(stored?.issuedFor) === binding.issuedFor;
}

/** The stored `issuedBy`, canonicalised as the destination's kind, equals it. */
export function sameIssuer(stored: IConfig | null, binding: Binding): boolean {
  if (binding.issuedBy === undefined) return false;
  const read = binding.issuerKind === 'acs' ? acsUri : issuerUri;
  return read(stored?.issuedBy) === binding.issuedBy;
}

/**
 * An obtained secret is this destination's only when **both** stored values
 * equal the computed ones; either absent, on either side, is not a match —
 * save a resource absent on both sides of a strategy-path binding
 * (`unstatedResourceMatches`).
 */
export function boundHere(stored: IConfig | null, binding: Binding): boolean {
  return sameResource(stored, binding) && sameIssuer(stored, binding);
}
