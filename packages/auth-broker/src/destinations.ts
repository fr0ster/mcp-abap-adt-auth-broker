/**
 * What a destination states, and the provider it states (spec §3.1, §4.1).
 *
 * Two fields choose the provider — `authType` and, for `jwt` and `saml`,
 * `grantType` — and nothing else: no field's presence or absence is ever
 * read to pick a row (H1). Both come from the key store's means.
 */

import {
  AuthorizationCodeProvider,
  BasicAuthProvider,
  ClientCredentialsProvider,
  createSignedAssertionValidator,
  createSignedResponseValidator,
  type IDeviceCodePresenter,
  OidcBrowserProvider,
  type OidcCallbackResult,
  OidcDeviceFlowProvider,
  OidcPasswordProvider,
  OidcTokenExchangeProvider,
  Saml2BearerProvider,
  Saml2PureProvider,
  SamlAuthProvider,
  SncLogonProvider,
  TokenAuthProvider,
  UaaPasscodeProvider,
  ValidationError,
} from '@mcp-abap-adt/auth-providers';
import type {
  IAssertionReplayStore,
  IAssertionValidator,
  IAuthorizationStrategy,
  IAuthProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  DestinationGrant,
  IConfig,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { type Binding, sameIssuer, sameResource } from './binding';
import { DestinationConfigError } from './DestinationConfigError';

type StatedAuthType = NonNullable<IConnectionConfig['authType']>;

/** The pairs of spec §3.1. `basic` and `snc` read no grant. */
const GRANTS: Readonly<Record<'jwt' | 'saml', readonly DestinationGrant[]>> = {
  jwt: [
    'authorization_code',
    'client_credentials',
    'passcode',
    'oidc_authorization_code',
    'device_code',
    'password',
    'token_exchange',
    'none',
  ],
  saml: ['saml2_pure', 'saml2_bearer', 'none'],
};

const AUTH_TYPES: readonly StatedAuthType[] = ['basic', 'jwt', 'saml', 'snc'];

/** A stored string that counts as present: `''` is missing (spec §4.4). */
function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** The stated `authType`, or the error naming it. */
export function statedAuthType(
  destination: string,
  means: IConnectionConfig | null,
): StatedAuthType {
  const authType = means?.authType;
  if (!present(authType)) {
    throw new DestinationConfigError(
      destination,
      ['authType'],
      means
        ? 'the key store states no authType'
        : 'the key store has no means for this destination',
    );
  }
  if (!AUTH_TYPES.includes(authType as StatedAuthType)) {
    throw new DestinationConfigError(
      destination,
      ['authType'],
      `authType is not one of ${AUTH_TYPES.join(', ')}`,
    );
  }
  return authType as StatedAuthType;
}

/** The stated grant of a `jwt` or `saml` destination, or the error naming it. */
export function statedGrant(
  destination: string,
  authType: 'jwt' | 'saml',
  means: IConnectionConfig,
): DestinationGrant {
  const grantType = means.grantType;
  if (!present(grantType)) {
    throw new DestinationConfigError(
      destination,
      ['grantType'],
      `a ${authType} destination must state its grantType`,
    );
  }
  if (!GRANTS[authType].includes(grantType as DestinationGrant)) {
    throw new DestinationConfigError(
      destination,
      ['grantType'],
      `grantType is not one a ${authType} destination allows (${GRANTS[authType].join(', ')})`,
    );
  }
  return grantType as DestinationGrant;
}

/** The names of the fields among `names` that `source` lacks or holds as `''`. */
function missing<T extends object>(
  source: T | null,
  names: (keyof T & string)[],
) {
  return names.filter((name) => !present(source?.[name]));
}

/** `basic` → `BasicAuthProvider(username, password)`, from the means alone. */
export function basicProvider(
  destination: string,
  means: IConnectionConfig,
): IAuthProvider {
  const lacking = missing(means, ['username', 'password']);
  if (lacking.length > 0) {
    throw new DestinationConfigError(
      destination,
      lacking,
      'a basic destination needs a user and a password',
    );
  }
  return new BasicAuthProvider(
    means.username as string,
    means.password as string,
  );
}

/** The provider's own config names, mapped to the store fields they come from. */
const SNC_FIELDS: Readonly<Record<string, string>> = {
  partnerName: 'sncPartnerName',
  qop: 'sncQop',
  myName: 'sncMyName',
  sncLib: 'sncLib',
};

/**
 * `snc` → the Secure Login Client recipe, from the four SNC fields. Only the
 * partner name is required: the contract says the library is discovered when
 * `sncLib` is absent and the user's name taken from the credential when
 * `sncMyName` is, and the provider documents its own `qop` default.
 */
export function sncProvider(
  destination: string,
  means: IConnectionConfig,
  logger: ILogger,
): IAuthProvider {
  if (!present(means.sncPartnerName)) {
    throw new DestinationConfigError(
      destination,
      ['sncPartnerName'],
      'an snc destination needs the system’s SNC name',
    );
  }
  try {
    return SncLogonProvider.forSecureLoginClient({
      partnerName: means.sncPartnerName,
      qop: present(means.sncQop) ? means.sncQop : undefined,
      sncLib: present(means.sncLib) ? means.sncLib : undefined,
      myName: present(means.sncMyName) ? means.sncMyName : undefined,
      logger,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new DestinationConfigError(
        destination,
        (error.missingFields ?? []).map((field) => SNC_FIELDS[field] ?? field),
        'the SNC provider refused the destination’s SNC settings',
      );
    }
    throw error;
  }
}

/**
 * `none` → the credential handed over, from the session: the only way in, so
 * required. Read from the secret alone — the means are not a seed.
 *
 * The broker did not obtain it and cannot obtain it again, so a binding that
 * does not match is refused, never discarded (spec §4.5 item 4): `issuedFor`
 * must always equal the destination's resource — it is what stops the
 * credential going to another one; `issuedBy` is compared only when the means
 * state an issuer.
 */
export function handedOverProvider(
  destination: string,
  authType: 'jwt' | 'saml',
  secret: IConfig | null,
  binding: Binding,
): IAuthProvider {
  const credential =
    authType === 'jwt' ? secret?.authorizationToken : secret?.sessionCookies;
  if (!present(credential)) {
    throw new DestinationConfigError(
      destination,
      [authType === 'jwt' ? 'authorizationToken' : 'sessionCookies'],
      authType === 'jwt'
        ? 'a jwt destination with grantType none needs the token in its session'
        : 'a saml destination with grantType none needs the cookies in its session',
    );
  }
  const unbound: string[] = [];
  if (!sameResource(secret, binding)) unbound.push('issuedFor');
  if (binding.issuerStated && !sameIssuer(secret, binding)) {
    unbound.push('issuedBy');
  }
  if (unbound.length > 0) {
    throw new DestinationConfigError(
      destination,
      unbound,
      'the credential in the session is not bound to this destination’s means',
    );
  }
  return authType === 'jwt'
    ? TokenAuthProvider.fixed(credential)
    : new SamlAuthProvider(credential);
}

/** The UAA grants: one client, one token endpoint (`<uaaUrl>/oauth/token`). */
export type UaaGrant = 'authorization_code' | 'client_credentials' | 'passcode';

export function isUaaGrant(grant: DestinationGrant): grant is UaaGrant {
  return (
    grant === 'authorization_code' ||
    grant === 'client_credentials' ||
    grant === 'passcode'
  );
}

/** What a UAA row is built from (spec §4.1). */
export interface UaaRow {
  destination: string;
  grant: UaaGrant;
  /** The client, from the key store's `getAuthorizationConfig`. */
  client: IAuthorizationConfig | null;
  /** The session secret — the seed; `null` when there is no session. */
  secret: IConfig | null;
  /** The consumer's `authorization` option. */
  authorization:
    | ((
        destination: string,
        grant: 'authorization_code' | 'passcode',
      ) => IAuthorizationStrategy<string>)
    | undefined;
  logger: ILogger;
  onTokens: (result: ITokenResult) => Promise<void>;
}

/**
 * `jwt` / `authorization_code` → `AuthorizationCodeProvider`,
 * `client_credentials` → `ClientCredentialsProvider`, `passcode` →
 * `UaaPasscodeProvider`: the client from the key store, the seed from the
 * session (not for `client_credentials`, whose row takes the client alone).
 *
 * Every field and option the row lacks is named in one error, before the
 * consumer's `authorization` is called. `serviceUrl` is not among them: the
 * providers read the client and `uaaUrl` only (plan D8). `uaaClientSecret: ''` is a public
 * client: `passcode` takes it as no secret; the other two rows' providers
 * require a secret, so for them `''` is missing.
 */
export function uaaProvider(row: UaaRow): IAuthProvider {
  const { destination, grant, client, secret } = row;
  const lacking: string[] = [];
  if (!present(client?.uaaUrl)) lacking.push('uaaUrl');
  if (!present(client?.uaaClientId)) lacking.push('uaaClientId');
  if (grant !== 'passcode' && !present(client?.uaaClientSecret)) {
    lacking.push('uaaClientSecret');
  }
  if (grant !== 'client_credentials' && !row.authorization) {
    lacking.push('authorization');
  }
  if (lacking.length > 0) {
    throw new DestinationConfigError(
      destination,
      lacking,
      `a jwt destination with grantType ${grant} lacks what its grant needs`,
    );
  }
  const uaaUrl = client?.uaaUrl as string;
  const clientId = client?.uaaClientId as string;
  const clientSecret = present(client?.uaaClientSecret)
    ? client.uaaClientSecret
    : undefined;
  const hooks = { onTokens: row.onTokens };

  if (grant === 'client_credentials') {
    return new ClientCredentialsProvider({
      uaaUrl,
      clientId,
      clientSecret: clientSecret as string,
      logger: row.logger,
      ...hooks,
    });
  }

  const seed = tokenSeed(secret);
  // Checked above: the rows that reach here need it.
  const authorization = (
    row.authorization as NonNullable<UaaRow['authorization']>
  )(destination, grant);
  if (grant === 'authorization_code') {
    return new AuthorizationCodeProvider({
      uaaUrl,
      clientId,
      clientSecret: clientSecret as string,
      authorization,
      ...seed,
      logger: row.logger,
      ...hooks,
    });
  }
  return new UaaPasscodeProvider({
    uaaUrl,
    clientId,
    clientSecret,
    authorization,
    ...seed,
    logger: row.logger,
    ...hooks,
  });
}

/** The seed of a token provider: the stored token, its refresh token and expiry. */
function tokenSeed(secret: IConfig | null): {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
} {
  return {
    accessToken: present(secret?.authorizationToken)
      ? secret.authorizationToken
      : undefined,
    refreshToken: present(secret?.refreshToken)
      ? secret.refreshToken
      : undefined,
    expiresAt:
      typeof secret?.expiresAt === 'number' ? secret.expiresAt : undefined,
  };
}

/** A stored string, or `undefined` for one absent or `''`. */
function stated(value: unknown): string | undefined {
  return present(value) ? value : undefined;
}

/** The OIDC grants: a client, and an issuer or explicit endpoints. */
export type OidcGrant =
  | 'oidc_authorization_code'
  | 'device_code'
  | 'password'
  | 'token_exchange';

export function isOidcGrant(grant: DestinationGrant): grant is OidcGrant {
  return (
    grant === 'oidc_authorization_code' ||
    grant === 'device_code' ||
    grant === 'password' ||
    grant === 'token_exchange'
  );
}

/**
 * The endpoints each OIDC row reads when the means state no issuer to
 * discover them from — the ones its provider asks discovery for otherwise.
 */
const OIDC_ENDPOINTS: Readonly<
  Record<OidcGrant, readonly (keyof IConnectionConfig & string)[]>
> = {
  oidc_authorization_code: ['oidcAuthorizationEndpoint', 'oidcTokenEndpoint'],
  device_code: ['oidcDeviceAuthorizationEndpoint', 'oidcTokenEndpoint'],
  password: ['oidcTokenEndpoint'],
  token_exchange: ['oidcTokenEndpoint'],
};

/** What an OIDC row is built from (spec §4.1). */
export interface OidcRow {
  destination: string;
  grant: OidcGrant;
  means: IConnectionConfig;
  /** The client, from the key store's `getAuthorizationConfig`. */
  client: IAuthorizationConfig | null;
  /** The session secret — the seed; `null` when there is none, or it is not bound here. */
  secret: IConfig | null;
  oidcAuthorization:
    | ((destination: string) => IAuthorizationStrategy<OidcCallbackResult>)
    | undefined;
  deviceCodePresenter:
    | ((destination: string) => IDeviceCodePresenter)
    | undefined;
  logger: ILogger;
  onTokens: (result: ITokenResult) => Promise<void>;
}

/**
 * `jwt` / `oidc_authorization_code` → `OidcBrowserProvider`, `device_code` →
 * `OidcDeviceFlowProvider`, `password` → `OidcPasswordProvider`,
 * `token_exchange` → `OidcTokenExchangeProvider`: the client id (and secret,
 * `''` being a public client) from the key store's client, the grant's data
 * from its `oidc*` fields, the seed from the session.
 *
 * The endpoints: `oidcIssuerUrl`, from which the provider discovers them, or
 * every explicit endpoint the row uses — without either the error names the
 * issuer and the endpoints missing. Every field and option the row lacks is
 * named in one error, before any collaborator is called. `token_exchange`
 * takes one scope string: the stored scopes joined by a space.
 */
export function oidcProvider(row: OidcRow): IAuthProvider {
  const { destination, grant, means, client } = row;
  const lacking: string[] = [];
  if (!present(client?.uaaClientId)) lacking.push('uaaClientId');
  if (!present(means.oidcIssuerUrl)) {
    const endpoints = OIDC_ENDPOINTS[grant].filter(
      (name) => !present(means[name]),
    );
    if (endpoints.length > 0) lacking.push('oidcIssuerUrl', ...endpoints);
  }
  if (grant === 'password') {
    lacking.push(...missing(means, ['username', 'password']));
  }
  if (grant === 'token_exchange') {
    lacking.push(
      ...missing(means, ['oidcSubjectToken', 'oidcSubjectTokenType']),
    );
  }
  if (grant === 'oidc_authorization_code' && !row.oidcAuthorization) {
    lacking.push('oidcAuthorization');
  }
  if (grant === 'device_code' && !row.deviceCodePresenter) {
    lacking.push('deviceCodePresenter');
  }
  if (lacking.length > 0) {
    throw new DestinationConfigError(
      destination,
      lacking,
      `a jwt destination with grantType ${grant} lacks what its grant needs`,
    );
  }
  const scopes =
    Array.isArray(means.oidcScopes) && means.oidcScopes.length > 0
      ? means.oidcScopes
      : undefined;
  const common = {
    issuerUrl: stated(means.oidcIssuerUrl),
    clientId: client?.uaaClientId as string,
    clientSecret: stated(client?.uaaClientSecret),
    tokenEndpoint: stated(means.oidcTokenEndpoint),
    ...tokenSeed(row.secret),
    logger: row.logger,
    onTokens: row.onTokens,
  };

  switch (grant) {
    case 'oidc_authorization_code':
      return new OidcBrowserProvider({
        ...common,
        scopes,
        authorizationEndpoint: stated(means.oidcAuthorizationEndpoint),
        // Checked above.
        authorization: (
          row.oidcAuthorization as NonNullable<OidcRow['oidcAuthorization']>
        )(destination),
      });
    case 'device_code':
      return new OidcDeviceFlowProvider({
        ...common,
        scopes,
        deviceAuthorizationEndpoint: stated(
          means.oidcDeviceAuthorizationEndpoint,
        ),
        presenter: (
          row.deviceCodePresenter as NonNullable<OidcRow['deviceCodePresenter']>
        )(destination),
      });
    case 'password':
      return new OidcPasswordProvider({
        ...common,
        scopes,
        username: means.username as string,
        password: means.password as string,
      });
    case 'token_exchange':
      return new OidcTokenExchangeProvider({
        ...common,
        scope: scopes?.join(' '),
        subjectToken: means.oidcSubjectToken as string,
        subjectTokenType: means.oidcSubjectTokenType as string,
        audience: stated(means.oidcAudience),
        actorToken: stated(means.oidcActorToken),
        actorTokenType: stated(means.oidcActorTokenType),
      });
  }
}

/** The SAML grants: an identity provider's assertion, validated first. */
export type SamlGrant = 'saml2_pure' | 'saml2_bearer';

export function isSamlGrant(grant: DestinationGrant): grant is SamlGrant {
  return grant === 'saml2_pure' || grant === 'saml2_bearer';
}

/** What a SAML row is built from (spec §4.1). */
export interface SamlRow {
  destination: string;
  grant: SamlGrant;
  means: IConnectionConfig;
  /** `saml2_bearer`'s client, from the key store; `null` for `saml2_pure`. */
  client: IAuthorizationConfig | null;
  /** The session secret — the seed; `null` when there is none, or it is not bound here. */
  secret: IConfig | null;
  authorization:
    | ((
        destination: string,
        grant: SamlGrant,
      ) => IAuthorizationStrategy<string>)
    | undefined;
  samlCookies:
    | ((destination: string) => (samlResponse: string) => Promise<string>)
    | undefined;
  assertionReplayStore:
    | ((destination: string) => IAssertionReplayStore)
    | undefined;
  logger: ILogger;
  onTokens: (result: ITokenResult) => Promise<void>;
}

/**
 * `saml` / `saml2_pure` → `Saml2PureProvider`, `saml2_bearer` →
 * `Saml2BearerProvider`, each validating the assertion before anything uses
 * it, with the validator the broker composes from the destination's trust and
 * the consumer's replay store: `createSignedResponseValidator` for
 * `saml2_pure` — the Response signed, as the cookies' system receives it whole
 * — and `createSignedAssertionValidator` for `saml2_bearer`, whose token
 * endpoint gets the Assertion alone (auth-providers' own pairing). The
 * expected issuer is `samlIdpEntityId`.
 *
 * `saml2_pure` is seeded with the stored cookies and `expiresAt`;
 * `saml2_bearer` with the stored token, its refresh token and expiry, and
 * takes the client (`uaaUrl`, `uaaClientId`; `uaaClientSecret` `''` a public
 * client) and `samlTokenUrl` when stated.
 *
 * Every field and option the row lacks is named in one error, before any
 * collaborator is called; so is a `samlClockSkewMs` that is not a whole number
 * of milliseconds, and a certificate the validator cannot read — by name, never
 * the value.
 */
export function samlProvider(row: SamlRow): IAuthProvider {
  const { destination, grant, means, client } = row;
  const lacking: string[] = missing(means, [
    'samlIdpSsoUrl',
    'samlSpEntityId',
    'samlIdpEntityId',
  ]);
  const certificates = means.samlIdpCertificates;
  if (
    !Array.isArray(certificates) ||
    certificates.length === 0 ||
    !certificates.every(present)
  ) {
    lacking.push('samlIdpCertificates');
  }
  if (grant === 'saml2_bearer') {
    lacking.push(...missing(client, ['uaaUrl', 'uaaClientId']));
  }
  if (!row.authorization) lacking.push('authorization');
  if (grant === 'saml2_pure' && !row.samlCookies) lacking.push('samlCookies');
  if (!row.assertionReplayStore) lacking.push('assertionReplayStore');
  if (lacking.length > 0) {
    throw new DestinationConfigError(
      destination,
      lacking,
      `a saml destination with grantType ${grant} lacks what its grant needs`,
    );
  }
  const skew = means.samlClockSkewMs;
  if (skew !== undefined && !(Number.isInteger(skew) && skew >= 0)) {
    throw new DestinationConfigError(
      destination,
      ['samlClockSkewMs'],
      'samlClockSkewMs is not a whole, non-negative number of milliseconds',
    );
  }

  const replayStore = (
    row.assertionReplayStore as NonNullable<SamlRow['assertionReplayStore']>
  )(destination);
  const createValidator =
    grant === 'saml2_pure'
      ? createSignedResponseValidator
      : createSignedAssertionValidator;
  let assertionValidator: IAssertionValidator;
  try {
    assertionValidator = createValidator({
      idpCertificates: certificates as string[],
      clockSkewMs: skew,
      replayStore,
    });
  } catch {
    // The validator's own message may quote what it could not read; the
    // error names the field only.
    throw new DestinationConfigError(
      destination,
      ['samlIdpCertificates'],
      'a SAML signing certificate the destination states is not a valid X.509 certificate',
    );
  }
  const common = {
    idpSsoUrl: means.samlIdpSsoUrl as string,
    spEntityId: means.samlSpEntityId as string,
    acsUrl: stated(means.samlAcsUrl),
    relayState: stated(means.samlRelayState),
    idpEntityId: means.samlIdpEntityId as string,
    idpInitiated: means.samlIdpInitiated === true,
    assertionValidator,
    authorization: (row.authorization as NonNullable<SamlRow['authorization']>)(
      destination,
      grant,
    ),
    logger: row.logger,
    onTokens: row.onTokens,
  };

  if (grant === 'saml2_pure') {
    const secret = row.secret;
    return new Saml2PureProvider({
      ...common,
      cookieProvider: (row.samlCookies as NonNullable<SamlRow['samlCookies']>)(
        destination,
      ),
      accessToken: stated(secret?.sessionCookies),
      expiresAt:
        typeof secret?.expiresAt === 'number' ? secret.expiresAt : undefined,
    });
  }
  return new Saml2BearerProvider({
    ...common,
    tokenUrl: stated(means.samlTokenUrl),
    uaaUrl: client?.uaaUrl as string,
    clientId: client?.uaaClientId as string,
    clientSecret: stated(client?.uaaClientSecret),
    ...tokenSeed(row.secret),
  });
}
