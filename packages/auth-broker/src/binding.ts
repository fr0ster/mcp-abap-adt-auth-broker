/**
 * A secret is bound to the resource it was obtained for and to everything that
 * decides where it goes and whose it is.
 *
 * The session store keeps two strings beside the secret, and the broker uses a
 * stored secret only when both equal what this destination's means give:
 *
 * - **`issuedFor`**, the resource: `serviceUrl` with the SAP client, in the
 *   canonical form 4.x wrote (`resourceUri`). Both sides are canonicalised
 *   before they are compared, so a stored value written by any 4.x-era
 *   consumer compares equal.
 * - **`issuedBy`**, a versioned record only the broker produces
 *   (`bindingRecord`):
 *
 *   ```
 *   mcp-abap-adt-binding/2;<row>;<eleven address fields>;<trust>
 *   ```
 *
 *   `row` is `authType/grantType` (or `provider/…` for the token API's
 *   consumer provider); each address field is the exact string the row hands
 *   its provider — `encodeURIComponent`-encoded, `""` when it hands none, never
 *   canonicalised — in the fixed order of `RECORD_FIELDS`; `trust` is the
 *   SHA-256 of the row's non-secret trust input (`trustDigest`), or `""`.
 *   The record is compared by exact equality and never parsed, split or
 *   matched; no regular expression touches it.
 *
 * No secret takes part in either string, nor a hash of one: a hash in a
 * session file can be checked offline against guesses.
 */

import { createHash } from 'node:crypto';
import type {
  IConfig,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';

/** What a binding reads of a client: who it is, never its secret. */
export type BoundClient = Pick<IAuthorizationConfig, 'uaaUrl' | 'uaaClientId'>;

/**
 * The certificate client a build read for the `clientAuthentication`
 * strategy, as the store answered it: where its token endpoint is, and its
 * public certificate — never its key.
 */
export interface BoundCertificate {
  readonly certUrl: unknown;
  readonly certificate: unknown;
}

/** The record's version tag; a later format is `mcp-abap-adt-binding/3`. */
const RECORD_VERSION = 'mcp-abap-adt-binding/2';

/** What the trust input is hashed under, before its JSON. */
const TRUST_PREFIX = 'mcp-abap-adt-binding/2/trust\n';

/** The eleven address fields of the record, in their fixed order. */
export const RECORD_FIELDS = [
  'clientId',
  'uaaUrl',
  'oidcIssuerUrl',
  'oidcTokenEndpoint',
  'oidcAuthorizationEndpoint',
  'oidcDeviceAuthorizationEndpoint',
  'oidcAudience',
  'samlIdpSsoUrl',
  'samlAcsUrl',
  'samlTokenUrl',
  'certUrl',
] as const;

/** The address values a row hands its provider; any one may be absent. */
export type RecordFields = Partial<
  Record<(typeof RECORD_FIELDS)[number], unknown>
>;

function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

const HIGH_SURROGATE_FIRST = 0xd800;
const LOW_SURROGATE_FIRST = 0xdc00;
const SURROGATE_LAST = 0xdfff;

/**
 * `encodeURIComponent(value)`, total: a lone surrogate — on which the
 * platform function throws — is written `%uXXXX`, which no
 * `encodeURIComponent` output contains (its `%` is always followed by two hex
 * digits), so two different strings never encode equal. Linear in the length.
 */
function encodeField(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    // A lone surrogate: encode unit by unit below.
  }
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= HIGH_SURROGATE_FIRST && unit < LOW_SURROGATE_FIRST) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= LOW_SURROGATE_FIRST && next <= SURROGATE_LAST) {
        out += encodeURIComponent(value.slice(i, i + 2));
        i += 1;
        continue;
      }
    }
    if (unit >= HIGH_SURROGATE_FIRST && unit <= SURROGATE_LAST) {
      out += `%u${unit.toString(16).toUpperCase()}`;
      continue;
    }
    out += encodeURIComponent(value.charAt(i));
  }
  return out;
}

/**
 * The `issuedBy` record: the version, the row, the eleven address fields in
 * their fixed order — each the exact string, encoded, `""` when absent or
 * `''` — and the trust digest. Every field is always present, and none holds
 * `;`, so the string is unambiguous without being parsed.
 */
export function bindingRecord(
  row: string,
  fields: RecordFields,
  trust: string,
): string {
  const parts: string[] = [RECORD_VERSION, row];
  for (const name of RECORD_FIELDS) {
    const value = fields[name];
    parts.push(present(value) ? encodeField(value) : '');
  }
  parts.push(trust);
  return parts.join(';');
}

/** A trust value as hashed: what the means state, or `null` when absent. */
type TrustValue = string | number | boolean | string[] | null;

/**
 * A value of the trust input as the means state it — a string, a number, a
 * boolean, an array of strings — or `null` for an absent one. A row refuses a
 * trust input of any other shape before it builds (`trustShaped`,
 * `samlRefusal`, the certificate check in `getProvider`), so `null` never
 * stands for a malformed value a built provider received; only `bindingOf`,
 * whose means `getProvider` would refuse, can reach it.
 */
function trustValue(value: unknown): TrustValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const copy: string[] = [];
    for (const element of value) {
      if (typeof element !== 'string') return null;
      copy.push(element);
    }
    return copy;
  }
  return null;
}

/**
 * The trust digest: lower-case hex SHA-256 of the UTF-8 bytes of
 * `"mcp-abap-adt-binding/2/trust\n"` and the JSON of the `[name, value]` pairs
 * in the row's fixed order — no trimming, no canonicalisation. JSON of arrays
 * and primitives has one output (lone surrogates escaped), so equal inputs
 * give equal bytes.
 */
export function trustDigest(
  pairs: readonly (readonly [string, unknown])[],
): string {
  const serialised = JSON.stringify(
    pairs.map(([name, value]) => [name, trustValue(value)]),
  );
  return createHash('sha256')
    .update(`${TRUST_PREFIX}${serialised}`, 'utf8')
    .digest('hex');
}

/** What this destination's means bind a secret to. */
export interface Binding {
  /** The canonical resource; absent when the means state none. */
  issuedFor?: string | undefined;
  /** The record: always present — at least the row. */
  issuedBy: string;
  /**
   * The record holds the client the row authenticates and every server
   * address its provider sends a credential to (§6.1's table). Only such a
   * binding is seeded from a stored session, or carries its refresh token.
   */
  fullyStated: boolean;
  /**
   * Set on the `clientAuthentication` strategy path only: a resource neither
   * side states — no `issuedFor` computed and none stored — matches, so the
   * record alone decides. A resource stated on one side only never matches.
   */
  unstatedResourceMatches?: true;
}

/** The default port a URL without one is taken to mean. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'https:': '443',
  'http:': '80',
};

/** `value` without the slashes it ends with, in one backwards pass. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

/**
 * The canonical resource URI, as 4.x wrote it: scheme and host lower-cased
 * (by `URL`, for http and https); the port explicit (`443` / `80` by
 * default); the path without a trailing `/`, its case kept; one query
 * parameter, `sap-client=<n>` — `sapClient` when given, else the one the URL
 * carries — re-encoded with `URLSearchParams`; no user info, no other
 * parameter, no fragment. A URL that does not parse, or has no host, has no
 * canonical form: `undefined`, never guessed. For a stored value, call it
 * without `sapClient`.
 */
export function resourceUri(
  serviceUrl: unknown,
  sapClient?: string,
): string | undefined {
  if (!present(serviceUrl)) return undefined;
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  if (host === '') return undefined;
  const scheme = url.protocol;
  const port = url.port || DEFAULT_PORTS[scheme] || '';
  const path = withoutTrailingSlashes(url.pathname);
  const client = present(sapClient)
    ? sapClient
    : url.searchParams.get('sap-client');
  const query = present(client)
    ? `?${new URLSearchParams([['sap-client', client]]).toString()}`
    : '';
  return `${scheme}//${host}${port ? `:${port}` : ''}${path}${query}`;
}

/** The resource the means name: `serviceUrl` with `sapClient`. */
function resourceOf(means: IConnectionConfig): string | undefined {
  return resourceUri(
    means.serviceUrl,
    present(means.sapClient) ? means.sapClient : undefined,
  );
}

/** The certificate client's public certificate, for the trust input. */
function certificateOf(certificate: BoundCertificate | null): unknown {
  return certificate ? certificate.certificate : null;
}

/** `certUrl` is stated whenever the build read a certificate client. */
function certificateStated(certificate: BoundCertificate | null): boolean {
  return !certificate || present(certificate.certUrl);
}

/**
 * The UAA grants (`authorization_code`, `client_credentials`, `passcode`):
 * the client id and `uaaUrl` as the provider receives them, and `certUrl`
 * when the build read the certificate client; trust is the client
 * certificate. Fully stated with the client, `uaaUrl` and — when read —
 * `certUrl`.
 */
export function uaaBinding(
  grant: string,
  means: IConnectionConfig,
  client: BoundClient | null,
  certificate: BoundCertificate | null,
): Binding {
  return {
    issuedFor: resourceOf(means),
    issuedBy: bindingRecord(
      `jwt/${grant}`,
      {
        clientId: client?.uaaClientId,
        uaaUrl: client?.uaaUrl,
        certUrl: certificate?.certUrl,
      },
      trustDigest([['clientCertificate', certificateOf(certificate)]]),
    ),
    fullyStated:
      present(client?.uaaClientId) &&
      present(client?.uaaUrl) &&
      certificateStated(certificate),
  };
}

/**
 * The OIDC grants: the client id, `oidcIssuerUrl`, `oidcTokenEndpoint`, and
 * the grant's own endpoint (`oidcAuthorizationEndpoint`,
 * `oidcDeviceAuthorizationEndpoint`) or audience (`oidcAudience`), and
 * `certUrl` when read; trust is the scopes, the `password` grant's
 * `username`, the token-exchange token types, and the client certificate.
 *
 * Fully stated with the client, each endpoint the grant sends to — explicit,
 * or the issuer it is discovered from — and `certUrl` when read;
 * `token_exchange` never: its subject token, a secret, decides whose
 * credential it obtains.
 */
export function oidcBinding(
  grant: string,
  means: IConnectionConfig,
  client: BoundClient | null,
  certificate: BoundCertificate | null,
): Binding {
  const issuer = present(means.oidcIssuerUrl);
  const reaches = (endpoint: unknown): boolean => issuer || present(endpoint);
  const trust: [string, unknown][] = [['oidcScopes', means.oidcScopes]];
  if (grant === 'password') trust.push(['username', means.username]);
  if (grant === 'token_exchange') {
    trust.push(
      ['oidcSubjectTokenType', means.oidcSubjectTokenType],
      ['oidcActorTokenType', means.oidcActorTokenType],
    );
  }
  trust.push(['clientCertificate', certificateOf(certificate)]);
  return {
    issuedFor: resourceOf(means),
    issuedBy: bindingRecord(
      `jwt/${grant}`,
      {
        clientId: client?.uaaClientId,
        oidcIssuerUrl: means.oidcIssuerUrl,
        oidcTokenEndpoint: means.oidcTokenEndpoint,
        oidcAuthorizationEndpoint:
          grant === 'oidc_authorization_code'
            ? means.oidcAuthorizationEndpoint
            : undefined,
        oidcDeviceAuthorizationEndpoint:
          grant === 'device_code'
            ? means.oidcDeviceAuthorizationEndpoint
            : undefined,
        oidcAudience:
          grant === 'token_exchange' ? means.oidcAudience : undefined,
        certUrl: certificate?.certUrl,
      },
      trustDigest(trust),
    ),
    fullyStated:
      grant !== 'token_exchange' &&
      present(client?.uaaClientId) &&
      reaches(means.oidcTokenEndpoint) &&
      (grant !== 'oidc_authorization_code' ||
        reaches(means.oidcAuthorizationEndpoint)) &&
      (grant !== 'device_code' ||
        reaches(means.oidcDeviceAuthorizationEndpoint)) &&
      certificateStated(certificate),
  };
}

/** The SAML trust input both SAML grants share, in order. */
function samlTrust(means: IConnectionConfig): [string, unknown][] {
  return [
    ['samlIdpCertificates', means.samlIdpCertificates],
    ['samlIdpEntityId', means.samlIdpEntityId],
    ['samlSpEntityId', means.samlSpEntityId],
    ['samlClockSkewMs', means.samlClockSkewMs],
    ['samlIdpInitiated', means.samlIdpInitiated],
  ];
}

/**
 * `saml2_pure`: the IdP's SSO URL and the ACS of the system that sets the
 * cookies; trust is the SAML trust. Fully stated with both.
 */
export function samlPureBinding(means: IConnectionConfig): Binding {
  return {
    issuedFor: resourceOf(means),
    issuedBy: bindingRecord(
      'saml/saml2_pure',
      { samlIdpSsoUrl: means.samlIdpSsoUrl, samlAcsUrl: means.samlAcsUrl },
      trustDigest(samlTrust(means)),
    ),
    fullyStated: present(means.samlIdpSsoUrl) && present(means.samlAcsUrl),
  };
}

/**
 * `saml2_bearer`: the client id, `uaaUrl`, the IdP's SSO URL, the ACS,
 * `samlTokenUrl`, and `certUrl` when read; trust is the SAML trust and the
 * client certificate. Fully stated with the client, the IdP, the token
 * endpoint (`samlTokenUrl`, or `uaaUrl`) and — when read — `certUrl`.
 */
export function samlBearerBinding(
  means: IConnectionConfig,
  client: BoundClient | null,
  certificate: BoundCertificate | null,
): Binding {
  return {
    issuedFor: resourceOf(means),
    issuedBy: bindingRecord(
      'saml/saml2_bearer',
      {
        clientId: client?.uaaClientId,
        uaaUrl: client?.uaaUrl,
        samlIdpSsoUrl: means.samlIdpSsoUrl,
        samlAcsUrl: means.samlAcsUrl,
        samlTokenUrl: means.samlTokenUrl,
        certUrl: certificate?.certUrl,
      },
      trustDigest([
        ...samlTrust(means),
        ['clientCertificate', certificateOf(certificate)],
      ]),
    ),
    fullyStated:
      present(client?.uaaClientId) &&
      present(means.samlIdpSsoUrl) &&
      (present(means.samlTokenUrl) || present(client?.uaaUrl)) &&
      certificateStated(certificate),
  };
}

/**
 * A `none` row: the resource, and the record — for `jwt` the client id,
 * `uaaUrl` and `oidcIssuerUrl` as the means state them, for `saml` the ACS;
 * no trust. A handed-over credential is compared by exact equality of the
 * whole record (§6.5); it is never seeded into a renewal, so it is not
 * "fully stated".
 */
export function handedOverBinding(
  authType: 'jwt' | 'saml',
  means: IConnectionConfig,
  client: BoundClient | null,
): Binding {
  const fields: RecordFields =
    authType === 'saml'
      ? { samlAcsUrl: means.samlAcsUrl }
      : {
          clientId: client?.uaaClientId,
          uaaUrl: client?.uaaUrl,
          oidcIssuerUrl: means.oidcIssuerUrl,
        };
  return {
    issuedFor: resourceOf(means),
    issuedBy: bindingRecord(`${authType}/none`, fields, ''),
    fullyStated: false,
  };
}

/**
 * The token API with a consumer's provider: the `serviceUrl` it resolved,
 * with the SAP client, and the record `provider/<row>` — for a factory the
 * client id and `uaaUrl` of the client it was handed, for an instance (handed
 * no client) none; no trust. Never fully stated: the broker cannot know what
 * the factory composes, and an instance is handed no client.
 */
export function consumerBinding(
  row: string,
  serviceUrl: string,
  sapClient: string | undefined,
  client: BoundClient | null,
): Binding {
  return {
    issuedFor: resourceUri(serviceUrl, sapClient),
    issuedBy: bindingRecord(
      row,
      { clientId: client?.uaaClientId, uaaUrl: client?.uaaUrl },
      '',
    ),
    fullyStated: false,
  };
}

/**
 * A binding on the `clientAuthentication` strategy path: a resource that
 * neither the means nor the stored session state matches
 * (`Binding.unstatedResourceMatches`).
 */
export function strategyBinding(binding: Binding): Binding {
  return { ...binding, unstatedResourceMatches: true };
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

/** The stored `issuedBy` is exactly this binding's record. */
export function sameRecord(stored: IConfig | null, binding: Binding): boolean {
  return stored?.issuedBy === binding.issuedBy;
}

/**
 * A stored secret may seed this binding's provider — or have its refresh
 * token carried — only when the binding is fully stated, the resource
 * matches, and the stored `issuedBy` is exactly the record. A session with no
 * `issuedBy`, or a 4.x one, never matches.
 */
export function boundHere(stored: IConfig | null, binding: Binding): boolean {
  return (
    binding.fullyStated &&
    sameResource(stored, binding) &&
    sameRecord(stored, binding)
  );
}
