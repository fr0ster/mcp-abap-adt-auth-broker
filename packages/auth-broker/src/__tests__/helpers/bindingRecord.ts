/**
 * The `issuedBy` record as the spec's grammar writes it (§6.1), assembled
 * apart from the broker's own function — a test that used that function
 * would agree with any bug in it:
 *
 *   mcp-abap-adt-binding/2;<row>;<eleven encoded address fields>;<trust>
 *
 * Each address field is `encodeURIComponent` of the exact string, `""` when
 * absent; `trust` is the lower-case hex SHA-256 of
 * `"mcp-abap-adt-binding/2/trust\n"` and the JSON of the `[name, value]`
 * pairs, or `""` for a row without trust input.
 */

import { createHash } from 'node:crypto';

/** The eleven address fields, in the spec's order. */
export const RECORD_ORDER = [
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
export type RecordField = (typeof RECORD_ORDER)[number];

export const TRUST_PREFIX = 'mcp-abap-adt-binding/2/trust\n';

/** The spec's trust serialisation, hashed. */
export function digest(pairs: [string, unknown][]): string {
  return createHash('sha256')
    .update(`${TRUST_PREFIX}${JSON.stringify(pairs)}`, 'utf8')
    .digest('hex');
}

/** The record: the row, the given fields, and the trust pairs (or `""`). */
export function record(
  row: string,
  filled: Partial<Record<RecordField, string>>,
  trust: [string, unknown][] | '',
): string {
  const fields = RECORD_ORDER.map((name) => {
    const value = filled[name];
    return value === undefined || value === '' ? '' : encodeURIComponent(value);
  });
  return [
    'mcp-abap-adt-binding/2',
    row,
    ...fields,
    trust === '' ? '' : digest(trust),
  ].join(';');
}

/**
 * A UAA row's record: the client id and `uaaUrl`, and — when the build read a
 * certificate client — its `certUrl` and certificate.
 */
export function uaaRecord(
  grant: 'authorization_code' | 'client_credentials' | 'passcode',
  uaaUrl: string,
  clientId: string,
  certificate?: { certUrl: string; certificate: string },
): string {
  return record(
    `jwt/${grant}`,
    {
      clientId,
      uaaUrl,
      ...(certificate ? { certUrl: certificate.certUrl } : {}),
    },
    [['clientCertificate', certificate ? certificate.certificate : null]],
  );
}

/** The means a row's record reads, as a key store states them. */
export interface RecordMeans {
  oidcIssuerUrl?: string | null | undefined;
  oidcTokenEndpoint?: string | null | undefined;
  oidcAuthorizationEndpoint?: string | null | undefined;
  oidcDeviceAuthorizationEndpoint?: string | null | undefined;
  oidcAudience?: string | null | undefined;
  oidcScopes?: string[] | null | undefined;
  username?: string | null | undefined;
  oidcSubjectTokenType?: string | null | undefined;
  oidcActorTokenType?: string | null | undefined;
  samlIdpSsoUrl?: string | null | undefined;
  samlAcsUrl?: string | null | undefined;
  samlTokenUrl?: string | null | undefined;
  samlIdpCertificates?: string[] | null | undefined;
  samlIdpEntityId?: string | null | undefined;
  samlSpEntityId?: string | null | undefined;
  samlClockSkewMs?: number | null | undefined;
  samlIdpInitiated?: boolean | null | undefined;
}

/** An absent trust value, as the serialisation writes it. */
const orNull = <T>(value: T | null | undefined): T | null =>
  value === undefined ? null : value;

/**
 * An OIDC row's record (§6.1's table): the client id, the issuer, the token
 * endpoint, the grant's own endpoint or audience, `certUrl`; trust the
 * scopes, `username` (password), the token types (token_exchange), the
 * client certificate.
 */
export function oidcRecord(
  grant:
    | 'oidc_authorization_code'
    | 'device_code'
    | 'password'
    | 'token_exchange',
  means: RecordMeans,
  clientId: string,
  certificate?: { certUrl: string; certificate: string },
): string {
  const trust: [string, unknown][] = [['oidcScopes', orNull(means.oidcScopes)]];
  if (grant === 'password') trust.push(['username', orNull(means.username)]);
  if (grant === 'token_exchange') {
    trust.push(
      ['oidcSubjectTokenType', orNull(means.oidcSubjectTokenType)],
      ['oidcActorTokenType', orNull(means.oidcActorTokenType)],
    );
  }
  trust.push([
    'clientCertificate',
    certificate ? certificate.certificate : null,
  ]);
  const filled: Partial<Record<RecordField, string>> = { clientId };
  if (means.oidcIssuerUrl) filled.oidcIssuerUrl = means.oidcIssuerUrl;
  if (means.oidcTokenEndpoint)
    filled.oidcTokenEndpoint = means.oidcTokenEndpoint;
  if (grant === 'oidc_authorization_code' && means.oidcAuthorizationEndpoint) {
    filled.oidcAuthorizationEndpoint = means.oidcAuthorizationEndpoint;
  }
  if (grant === 'device_code' && means.oidcDeviceAuthorizationEndpoint) {
    filled.oidcDeviceAuthorizationEndpoint =
      means.oidcDeviceAuthorizationEndpoint;
  }
  if (grant === 'token_exchange' && means.oidcAudience) {
    filled.oidcAudience = means.oidcAudience;
  }
  if (certificate) filled.certUrl = certificate.certUrl;
  return record(`jwt/${grant}`, filled, trust);
}

/** The SAML trust input, in order. */
function samlTrust(means: RecordMeans): [string, unknown][] {
  return [
    ['samlIdpCertificates', orNull(means.samlIdpCertificates)],
    ['samlIdpEntityId', orNull(means.samlIdpEntityId)],
    ['samlSpEntityId', orNull(means.samlSpEntityId)],
    ['samlClockSkewMs', orNull(means.samlClockSkewMs)],
    ['samlIdpInitiated', orNull(means.samlIdpInitiated)],
  ];
}

/** `saml2_pure`'s record: the IdP's SSO URL and the ACS; the SAML trust. */
export function samlPureRecord(means: RecordMeans): string {
  return record(
    'saml/saml2_pure',
    {
      ...(means.samlIdpSsoUrl ? { samlIdpSsoUrl: means.samlIdpSsoUrl } : {}),
      ...(means.samlAcsUrl ? { samlAcsUrl: means.samlAcsUrl } : {}),
    },
    samlTrust(means),
  );
}

/**
 * `saml2_bearer`'s record: the client id, `uaaUrl`, the IdP, the ACS,
 * `samlTokenUrl`, `certUrl`; the SAML trust and the client certificate.
 */
export function samlBearerRecord(
  means: RecordMeans,
  uaaUrl: string,
  clientId: string,
  certificate?: { certUrl: string; certificate: string },
): string {
  const filled: Partial<Record<RecordField, string>> = { clientId, uaaUrl };
  if (means.samlIdpSsoUrl) filled.samlIdpSsoUrl = means.samlIdpSsoUrl;
  if (means.samlAcsUrl) filled.samlAcsUrl = means.samlAcsUrl;
  if (means.samlTokenUrl) filled.samlTokenUrl = means.samlTokenUrl;
  if (certificate) filled.certUrl = certificate.certUrl;
  return record('saml/saml2_bearer', filled, [
    ...samlTrust(means),
    ['clientCertificate', certificate ? certificate.certificate : null],
  ]);
}
