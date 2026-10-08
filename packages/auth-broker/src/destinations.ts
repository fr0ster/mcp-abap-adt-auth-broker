/**
 * What a destination states, and the provider it states.
 *
 * Two fields choose the provider — `authType` and, for `jwt` and `saml`,
 * `grantType` — and nothing else: no field's presence or absence is ever
 * read to pick a row. Both come from the key store's means.
 *
 * Every token row takes the consumer's `renewal` (called once per build, with
 * the destination and its grant) and persists through auth-providers'
 * `refreshStatePersistence` over the broker's write, governed by the
 * consumer's `onWriteFailure`; a row built without either is refused naming
 * it, beside every other missing field, in one error. A failure the broker
 * reads — the SNC provider's, a validator's, a provider constructor's — is
 * read through auth-errors (`readFailure`) and carried by the
 * `DestinationConfigError`, never matched by class.
 */

import { readFailure } from '@mcp-abap-adt/auth-errors';
import {
  AuthorizationCodeProvider,
  type AuthorizationCodeProviderConfig,
  BasicAuthProvider,
  ClientCredentialsProvider,
  createSignedAssertionValidator,
  createSignedResponseValidator,
  type IDeviceCodePresenter,
  OidcBrowserProvider,
  type OidcBrowserProviderConfig,
  type OidcCallbackResult,
  OidcDeviceFlowProvider,
  type OidcDeviceFlowProviderConfig,
  OidcPasswordProvider,
  type OidcPasswordProviderConfig,
  OidcTokenExchangeProvider,
  type OidcTokenExchangeProviderConfig,
  type PersistedTokens,
  refreshStatePersistence,
  Saml2BearerProvider,
  type Saml2BearerProviderConfig,
  Saml2PureProvider,
  type Saml2PureProviderConfig,
  SamlAuthProvider,
  type ShippedValidatorOptions,
  SncLogonProvider,
  TokenAuthProvider,
  UaaPasscodeProvider,
  type UaaPasscodeProviderConfig,
} from '@mcp-abap-adt/auth-providers';
import type {
  IAssertionReplayStore,
  IAssertionValidator,
  IAuthorizationStrategy,
  IAuthProvider,
  IAuthProviderError,
  IClientAuthentication,
  IRenewalStrategy,
  ITokenPersistence,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  DestinationGrant,
  IConfig,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { type Binding, sameRecord, sameResource } from './binding';
import type { ClientIdentity } from './clientAuthentication';
import { asContract } from './contractShape';
import { DestinationConfigError } from './DestinationConfigError';

type StatedAuthType = NonNullable<IConnectionConfig['authType']>;

/** The allowed `authType` / `grantType` pairs. `basic` and `snc` read no grant. */
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

/**
 * `authType` and `grantType` are a `jwt` / `saml` pair of the closed list —
 * so neither holds `;` or `/`. Never throws.
 */
export function isStatedRow(
  authType: unknown,
  grant: unknown,
): grant is DestinationGrant & string {
  if (authType !== 'jwt' && authType !== 'saml') return false;
  return (GRANTS[authType] as readonly unknown[]).includes(grant);
}

/** A stored string that counts as present: `''` is missing. */
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

/**
 * A row's client: the key store's secret client, or — on the strategy path
 * without one — the certificate client's identity, which carries no secret
 * field at all, so it can never pass for a (public) secret client.
 */
export type RowClient = IAuthorizationConfig | ClientIdentity;

/** The secret a row's client holds; an identity holds none. */
function secretOf(client: RowClient | null): string | undefined {
  return client && 'uaaClientSecret' in client
    ? client.uaaClientSecret
    : undefined;
}

/** Added to a row's refusal when it has no client and no strategy was given. */
const CERTIFICATE_HINT =
  'a certificate client needs a clientAuthentication strategy';

/**
 * Whether a client row's refusal gets the hint: no strategy, and no client
 * at all — the key store answered none, or one without a client id. A
 * client that lacks only its secret or its URL is a secret client with a
 * gap, and gets 4.0.0's words alone. Decided from what was read, never by
 * asking the store about a certificate.
 */
function noClientHint(
  clientAuthenticated: boolean,
  client: RowClient | null | undefined,
): boolean {
  return !clientAuthenticated && !present(client?.uaaClientId);
}

/** A client row's refusal: 4.0.0's words, and the hint when `hinted`. */
function clientRowError(
  destination: string,
  lacking: string[],
  reason: string,
  hinted: boolean,
): DestinationConfigError {
  return new DestinationConfigError(
    destination,
    lacking,
    hinted ? `${reason}; ${CERTIFICATE_HINT}` : reason,
  );
}

/** `clientAuthentication` for a provider's config: present only when given. */
function authenticatedBy(
  clientAuthentication: IClientAuthentication | undefined,
): { clientAuthentication?: IClientAuthentication } {
  return clientAuthentication ? { clientAuthentication } : {};
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
    return SncLogonProvider.forSecureLoginClient(
      asContract<Parameters<typeof SncLogonProvider.forSecureLoginClient>[0]>({
        partnerName: means.sncPartnerName,
        qop: present(means.sncQop) ? means.sncQop : undefined,
        sncLib: present(means.sncLib) ? means.sncLib : undefined,
        myName: present(means.sncMyName) ? means.sncMyName : undefined,
        logger,
      }),
    );
  } catch (thrown) {
    // Decided by kind, read through auth-errors — never by class: a failure
    // of another installed copy of auth-errors reads the same.
    const error = readFailure(thrown, 'resolving-snc-library');
    const fields =
      error.kind === 'configuration'
        ? mappedFields(error.facts.fields, SNC_FIELDS)
        : SNC_STORE_FIELDS.filter((field) => present(means[field]));
    throw new DestinationConfigError(
      destination,
      fields,
      'the SNC provider refused the destination’s SNC settings',
      error,
    );
  }
}

/** The four SNC fields of the means, in the order a refusal names them. */
const SNC_STORE_FIELDS = [
  'sncPartnerName',
  'sncQop',
  'sncLib',
  'sncMyName',
] as const;

/**
 * A provider's configuration field names as the store's (or the broker's
 * option names), through a row's map; a name the map does not hold is kept —
 * it is one of interfaces-auth's `CONFIG_FIELDS`, a name, never a value.
 */
function mappedFields(
  fields: readonly string[],
  map: Readonly<Record<string, string>>,
): string[] {
  const names: string[] = [];
  for (const field of fields) {
    const name = map[field] ?? field;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * `none` → the credential handed over, from the session: the only way in, so
 * required. Read from the secret alone — the means are not a seed.
 *
 * The broker did not obtain it and cannot obtain it again, so a binding that
 * does not match is refused, never discarded: `issuedFor` must equal the
 * destination's resource — it is what stops the credential going to another
 * one — and `issuedBy` must be exactly the row's record (§6.5): a credential
 * handed over with a 4.x binding, or none, is refused until it is written
 * again with 5.0.0's `bindingOf`.
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
  if (!sameRecord(secret, binding)) unbound.push('issuedBy');
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

/** Every grant that obtains a secret: `DestinationGrant` without `'none'`. */
export type TokenGrant = Exclude<DestinationGrant, 'none'>;

/** How the consumer's `renewal` option is shaped. */
export type RenewalOption = (
  destination: string,
  grant: TokenGrant,
) => IRenewalStrategy;

/**
 * What every token row takes from the broker beside its own data: the
 * consumer's `renewal` and `onWriteFailure` (each refused by name when
 * absent) and the broker's one write of the destination's session.
 */
export interface TokenRowOptions {
  renewal: RenewalOption | undefined;
  onWriteFailure: 'fail' | 'continue' | undefined;
  /**
   * One session write for the destination: resolves when it landed, rejects
   * with the store's error when it did not.
   */
  write: (tokens: PersistedTokens) => Promise<void>;
  logger: ILogger;
}

/** `onWriteFailure` as given: `'fail'` or `'continue'`, nothing else. */
export function isWriteFailurePolicy(
  value: unknown,
): value is 'fail' | 'continue' {
  return value === 'fail' || value === 'continue';
}

/**
 * The consumer options a token row lacks, by name: `renewal` when it is no
 * function, `onWriteFailure` when it is neither `'fail'` nor `'continue'`.
 * There is no default for either.
 */
export function optionsLacking(
  options: Pick<TokenRowOptions, 'renewal' | 'onWriteFailure'>,
): string[] {
  const lacking: string[] = [];
  if (typeof options.renewal !== 'function') lacking.push('renewal');
  if (!isWriteFailurePolicy(options.onWriteFailure)) {
    lacking.push('onWriteFailure');
  }
  return lacking;
}

/**
 * The row's renewal strategy: `renewal(destination, grant)`, called once per
 * build after every other check has passed. A throw is refused naming
 * `renewal`, carrying what it threw as auth-errors reads it.
 */
function renewalFor(
  destination: string,
  grant: TokenGrant,
  renewal: RenewalOption | undefined,
): IRenewalStrategy {
  try {
    // Checked by optionsLacking before any row gets here.
    return (renewal as RenewalOption)(destination, grant);
  } catch (thrown) {
    throw new DestinationConfigError(
      destination,
      ['renewal'],
      'the renewal option failed',
      readFailure(thrown, 'renewal-strategy'),
    );
  }
}

/**
 * The row's persistence: auth-providers' `refreshStatePersistence` over the
 * broker's write, with the consumer's `onWriteFailure` as given.
 */
function persistenceFor(options: TokenRowOptions): ITokenPersistence {
  return refreshStatePersistence(
    options.write,
    asContract<Parameters<typeof refreshStatePersistence>[1]>({
      // Checked by optionsLacking before any row gets here.
      onWriteFailure: options.onWriteFailure as 'fail' | 'continue',
      logger: options.logger,
    }),
  );
}

/**
 * Builds the provider — the persistence strategy and the constructor —
 * inside one guard: a refusal of the configuration the row gave it is a
 * `DestinationConfigError` naming the store fields (or broker options) its
 * facts name, through the row's field map, carrying the provider's error.
 */
function constructed<P>(
  destination: string,
  fieldMap: Readonly<Record<string, string>>,
  build: () => P,
): P {
  try {
    return build();
  } catch (thrown) {
    const error: IAuthProviderError = readFailure(thrown, 'unfamiliar-error');
    throw new DestinationConfigError(
      destination,
      error.kind === 'configuration'
        ? mappedFields(error.facts.fields, fieldMap)
        : [],
      'the provider refused the configuration the destination states',
      error,
    );
  }
}

/** The fields every token row's provider shares, as the store and the broker name them. */
const COMMON_FIELDS: Readonly<Record<string, string>> = {
  clientId: 'uaaClientId',
  clientSecret: 'uaaClientSecret',
  uaaUrl: 'uaaUrl',
  renewal: 'renewal',
  persistence: 'onWriteFailure',
  onWriteFailure: 'onWriteFailure',
  authorization: 'authorization',
  clientAuthentication: 'clientAuthentication',
};

const OIDC_FIELDS: Readonly<Record<string, string>> = {
  ...COMMON_FIELDS,
  issuerUrl: 'oidcIssuerUrl',
  tokenEndpoint: 'oidcTokenEndpoint',
  authorizationEndpoint: 'oidcAuthorizationEndpoint',
  deviceAuthorizationEndpoint: 'oidcDeviceAuthorizationEndpoint',
  scopes: 'oidcScopes',
  scope: 'oidcScopes',
  audience: 'oidcAudience',
  subjectToken: 'oidcSubjectToken',
  subjectTokenType: 'oidcSubjectTokenType',
  actorToken: 'oidcActorToken',
  actorTokenType: 'oidcActorTokenType',
  authorization: 'oidcAuthorization',
  presenter: 'deviceCodePresenter',
};

const SAML_FIELDS: Readonly<Record<string, string>> = {
  ...COMMON_FIELDS,
  idpSsoUrl: 'samlIdpSsoUrl',
  spEntityId: 'samlSpEntityId',
  acsUrl: 'samlAcsUrl',
  relayState: 'samlRelayState',
  idpEntityId: 'samlIdpEntityId',
  idpInitiated: 'samlIdpInitiated',
  idpCertificates: 'samlIdpCertificates',
  assertionValidator: 'samlIdpCertificates',
  clockSkewMs: 'samlClockSkewMs',
  tokenUrl: 'samlTokenUrl',
  cookieProvider: 'samlCookies',
};

/** The UAA grants: one client, one token endpoint (`<uaaUrl>/oauth/token`). */
export type UaaGrant = 'authorization_code' | 'client_credentials' | 'passcode';

export function isUaaGrant(grant: DestinationGrant): grant is UaaGrant {
  return (
    grant === 'authorization_code' ||
    grant === 'client_credentials' ||
    grant === 'passcode'
  );
}

/**
 * What a token row's check reads of its client and options. `client`
 * `undefined` means "not known yet": the consumer's `clientAuthentication`
 * strategy will tell the client identity, so its fields are not judged.
 */
interface ClientCheck {
  destination: string;
  client: RowClient | null | undefined;
  /** Whether the client authenticates through the consumer's strategy. */
  clientAuthenticated: boolean;
  renewal: RenewalOption | undefined;
  onWriteFailure: 'fail' | 'continue' | undefined;
}

/** What a UAA row's check reads. */
export interface UaaCheck extends ClientCheck {
  grant: UaaGrant;
  /** The consumer's `authorization` option. */
  authorization:
    | ((
        destination: string,
        grant: 'authorization_code' | 'passcode',
      ) => IAuthorizationStrategy<string>)
    | undefined;
}

/** What a UAA row is built from. */
export interface UaaRow
  extends Omit<UaaCheck, 'client' | 'clientAuthenticated'>,
    TokenRowOptions {
  /**
   * The client: the key store's `getAuthorizationConfig` — or, with a
   * strategy and no secret client, the certificate client's identity.
   */
  client: RowClient | null;
  /** The session secret — the seed; `null` when there is no session. */
  secret: IConfig | null;
  /**
   * The consumer strategy's answer. Given, the provider authenticates its
   * client with it and gets no `clientSecret`; absent, 4.0.0's secret.
   */
  clientAuthentication?: IClientAuthentication;
}

/**
 * Every field and option a UAA row lacks, named in one error — or nothing.
 * `serviceUrl` is not among them: the providers read the client and `uaaUrl`
 * only. Without a strategy, `uaaClientSecret: ''` is a public client:
 * `passcode` takes it as no secret; the other two rows' providers require a
 * secret, so for them `''` is missing.
 */
export function uaaRefusal(
  check: UaaCheck,
): DestinationConfigError | undefined {
  const { destination, grant, client, clientAuthenticated } = check;
  const lacking: string[] = [];
  if (client !== undefined) {
    if (!present(client?.uaaUrl)) lacking.push('uaaUrl');
    if (!present(client?.uaaClientId)) lacking.push('uaaClientId');
  }
  if (
    !clientAuthenticated &&
    grant !== 'passcode' &&
    !present(secretOf(client ?? null))
  ) {
    lacking.push('uaaClientSecret');
  }
  if (grant !== 'client_credentials' && !check.authorization) {
    lacking.push('authorization');
  }
  lacking.push(...optionsLacking(check));
  if (lacking.length === 0) return undefined;
  return clientRowError(
    destination,
    lacking,
    `a jwt destination with grantType ${grant} lacks what its grant needs`,
    noClientHint(clientAuthenticated, client),
  );
}

/**
 * `jwt` / `authorization_code` → `AuthorizationCodeProvider`,
 * `client_credentials` → `ClientCredentialsProvider`, `passcode` →
 * `UaaPasscodeProvider`: the client from the key store, the seed from the
 * session (not for `client_credentials`, whose row takes the client alone),
 * the consumer's renewal for this grant, and the broker's persistence.
 *
 * Every field and option the row lacks is named in one error
 * (`uaaRefusal`), before the consumer's `authorization` or `renewal` is
 * called. On the strategy path the client may be a certificate client's
 * identity, which holds no secret field at all (`RowClient`). With the
 * strategy's answer (`clientAuthentication`) no secret is required and none
 * is passed: the provider authenticates its client with the answer.
 */
export function uaaProvider(row: UaaRow): IAuthProvider {
  const { destination, grant, client, secret, clientAuthentication } = row;
  const refusal = uaaRefusal({
    ...row,
    clientAuthenticated: !!clientAuthentication,
  });
  if (refusal) throw refusal;
  const uaaUrl = client?.uaaUrl as string;
  const clientId = client?.uaaClientId as string;
  const clientSecret =
    !clientAuthentication && present(secretOf(client))
      ? secretOf(client)
      : undefined;
  const renewal = renewalFor(destination, grant, row.renewal);
  const hooks = (): {
    renewal: IRenewalStrategy;
    persistence: ITokenPersistence;
    clientAuthentication?: IClientAuthentication;
  } => ({
    renewal,
    persistence: persistenceFor(row),
    ...authenticatedBy(clientAuthentication),
  });

  if (grant === 'client_credentials') {
    return constructed(
      destination,
      COMMON_FIELDS,
      () =>
        new ClientCredentialsProvider({
          uaaUrl,
          clientId,
          ...(clientSecret === undefined ? {} : { clientSecret }),
          logger: row.logger,
          ...hooks(),
        }),
    );
  }

  const seed = tokenSeed(secret);
  // Checked above: the rows that reach here need it.
  const authorization = (
    row.authorization as NonNullable<UaaRow['authorization']>
  )(destination, grant);
  if (grant === 'authorization_code') {
    return constructed(
      destination,
      COMMON_FIELDS,
      () =>
        new AuthorizationCodeProvider(
          asContract<AuthorizationCodeProviderConfig>({
            uaaUrl,
            clientId,
            ...(clientSecret === undefined ? {} : { clientSecret }),
            authorization,
            ...seed,
            logger: row.logger,
            ...hooks(),
          }),
        ),
    );
  }
  return constructed(
    destination,
    COMMON_FIELDS,
    () =>
      new UaaPasscodeProvider(
        asContract<UaaPasscodeProviderConfig>({
          uaaUrl,
          clientId,
          clientSecret,
          authorization,
          ...seed,
          logger: row.logger,
          ...hooks(),
        }),
      ),
  );
}
/** The seed of a token provider: the stored token, its refresh token and expiry. */
function tokenSeed(secret: IConfig | null): {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
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

/** What an OIDC row's check reads. */
export interface OidcCheck extends ClientCheck {
  grant: OidcGrant;
  means: IConnectionConfig;
  oidcAuthorization:
    | ((destination: string) => IAuthorizationStrategy<OidcCallbackResult>)
    | undefined;
  deviceCodePresenter:
    | ((destination: string) => IDeviceCodePresenter)
    | undefined;
}

/** What an OIDC row is built from. */
export interface OidcRow
  extends Omit<OidcCheck, 'client' | 'clientAuthenticated'>,
    TokenRowOptions {
  /** The client, from the key store's `getAuthorizationConfig`. */
  client: RowClient | null;
  /** The session secret — the seed; `null` when there is none, or it is not bound here. */
  secret: IConfig | null;
  /** The consumer strategy's answer: given, it replaces the secret. */
  clientAuthentication?: IClientAuthentication;
}

/**
 * Every field and option an OIDC row lacks, named in one error — or nothing.
 * The endpoints: `oidcIssuerUrl`, from which the provider discovers them, or
 * every explicit endpoint the row uses — without either the error names the
 * issuer and the endpoints missing.
 */
export function oidcRefusal(
  check: OidcCheck,
): DestinationConfigError | undefined {
  const { destination, grant, means, client } = check;
  const lacking: string[] = [];
  if (client !== undefined && !present(client?.uaaClientId)) {
    lacking.push('uaaClientId');
  }
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
  if (grant === 'oidc_authorization_code' && !check.oidcAuthorization) {
    lacking.push('oidcAuthorization');
  }
  if (grant === 'device_code' && !check.deviceCodePresenter) {
    lacking.push('deviceCodePresenter');
  }
  lacking.push(...optionsLacking(check));
  if (lacking.length === 0) return undefined;
  return clientRowError(
    destination,
    lacking,
    `a jwt destination with grantType ${grant} lacks what its grant needs`,
    noClientHint(check.clientAuthenticated, client),
  );
}

/**
 * `jwt` / `oidc_authorization_code` → `OidcBrowserProvider`, `device_code` →
 * `OidcDeviceFlowProvider`, `password` → `OidcPasswordProvider`,
 * `token_exchange` → `OidcTokenExchangeProvider`: the client id (and secret,
 * `''` being a public client) from the key store's client, the grant's data
 * from its `oidc*` fields, the seed from the session, the consumer's renewal
 * for this grant, and the broker's persistence.
 *
 * Every field and option the row lacks is named in one error
 * (`oidcRefusal`), before any collaborator is called. `token_exchange` takes
 * one scope string: the stored scopes joined by a space.
 */
export function oidcProvider(row: OidcRow): IAuthProvider {
  const { destination, grant, means, client } = row;
  const refusal = oidcRefusal({
    ...row,
    clientAuthenticated: !!row.clientAuthentication,
  });
  if (refusal) throw refusal;
  const scopes =
    Array.isArray(means.oidcScopes) && means.oidcScopes.length > 0
      ? means.oidcScopes
      : undefined;
  const renewal = renewalFor(destination, grant, row.renewal);
  const common = () => ({
    issuerUrl: stated(means.oidcIssuerUrl),
    clientId: client?.uaaClientId as string,
    clientSecret: row.clientAuthentication
      ? undefined
      : stated(secretOf(client)),
    ...authenticatedBy(row.clientAuthentication),
    tokenEndpoint: stated(means.oidcTokenEndpoint),
    ...tokenSeed(row.secret),
    logger: row.logger,
    renewal,
    persistence: persistenceFor(row),
  });

  switch (grant) {
    case 'oidc_authorization_code': {
      // Checked above.
      const authorization = (
        row.oidcAuthorization as NonNullable<OidcRow['oidcAuthorization']>
      )(destination);
      return constructed(
        destination,
        OIDC_FIELDS,
        () =>
          new OidcBrowserProvider(
            asContract<OidcBrowserProviderConfig>({
              ...common(),
              scopes,
              authorizationEndpoint: stated(means.oidcAuthorizationEndpoint),
              authorization,
            }),
          ),
      );
    }
    case 'device_code': {
      const presenter = (
        row.deviceCodePresenter as NonNullable<OidcRow['deviceCodePresenter']>
      )(destination);
      return constructed(
        destination,
        OIDC_FIELDS,
        () =>
          new OidcDeviceFlowProvider(
            asContract<OidcDeviceFlowProviderConfig>({
              ...common(),
              scopes,
              deviceAuthorizationEndpoint: stated(
                means.oidcDeviceAuthorizationEndpoint,
              ),
              presenter,
            }),
          ),
      );
    }
    case 'password':
      return constructed(
        destination,
        OIDC_FIELDS,
        () =>
          new OidcPasswordProvider(
            asContract<OidcPasswordProviderConfig>({
              ...common(),
              scopes,
              username: means.username as string,
              password: means.password as string,
            }),
          ),
      );
    case 'token_exchange':
      return constructed(
        destination,
        OIDC_FIELDS,
        () =>
          new OidcTokenExchangeProvider(
            asContract<OidcTokenExchangeProviderConfig>({
              ...common(),
              scope: scopes?.join(' '),
              subjectToken: means.oidcSubjectToken as string,
              subjectTokenType: means.oidcSubjectTokenType as string,
              audience: stated(means.oidcAudience),
              actorToken: stated(means.oidcActorToken),
              actorTokenType: stated(means.oidcActorTokenType),
            }),
          ),
      );
  }
}

/** The SAML grants: an identity provider's assertion, validated first. */
export type SamlGrant = 'saml2_pure' | 'saml2_bearer';

export function isSamlGrant(grant: DestinationGrant): grant is SamlGrant {
  return grant === 'saml2_pure' || grant === 'saml2_bearer';
}

/** What a SAML row's check reads. */
export interface SamlCheck extends ClientCheck {
  grant: SamlGrant;
  means: IConnectionConfig;
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
}

/** What a SAML row is built from. */
export interface SamlRow
  extends Omit<SamlCheck, 'client' | 'clientAuthenticated'>,
    TokenRowOptions {
  /** `saml2_bearer`'s client, from the key store; `null` for `saml2_pure`. */
  client: RowClient | null;
  /** The session secret — the seed; `null` when there is none, or it is not bound here. */
  secret: IConfig | null;
  /** `saml2_bearer`: the consumer strategy's answer; given, it replaces the secret. */
  clientAuthentication?: IClientAuthentication;
}

/** Every field and option a SAML row lacks, named in one error — or nothing. */
export function samlRefusal(
  check: SamlCheck,
): DestinationConfigError | undefined {
  const { destination, grant, means, client } = check;
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
  if (grant === 'saml2_bearer' && client !== undefined) {
    lacking.push(...missing(client, ['uaaUrl', 'uaaClientId']));
  }
  if (!check.authorization) lacking.push('authorization');
  if (grant === 'saml2_pure' && !check.samlCookies) {
    lacking.push('samlCookies');
  }
  if (!check.assertionReplayStore) lacking.push('assertionReplayStore');
  lacking.push(...optionsLacking(check));
  if (lacking.length === 0) return undefined;
  return clientRowError(
    destination,
    lacking,
    `a saml destination with grantType ${grant} lacks what its grant needs`,
    grant === 'saml2_bearer' && noClientHint(check.clientAuthenticated, client),
  );
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
 * takes the client (`uaaUrl`, `uaaClientId`; without a strategy,
 * `uaaClientSecret` `''` a public client; on the strategy path the identity
 * alone, no secret) and `samlTokenUrl` when stated. Both take the consumer's
 * renewal for their grant and the broker's persistence.
 *
 * Every field and option the row lacks is named in one error
 * (`samlRefusal`), before any collaborator is called; so is a
 * `samlClockSkewMs` that is not a whole number of milliseconds, and a
 * certificate the validator cannot read — by name, never the value, the
 * validator's error carried.
 */
export function samlProvider(row: SamlRow): IAuthProvider {
  const { destination, grant, means, client } = row;
  const refusal = samlRefusal({
    ...row,
    clientAuthenticated: !!row.clientAuthentication,
  });
  if (refusal) throw refusal;
  const certificates = means.samlIdpCertificates;
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
    assertionValidator = createValidator(
      asContract<ShippedValidatorOptions>({
        idpCertificates: certificates as string[],
        clockSkewMs: skew,
        replayStore,
      }),
    );
  } catch (thrown) {
    // The field is named, never its value; the validator's error is carried
    // as auth-errors reads it.
    throw new DestinationConfigError(
      destination,
      ['samlIdpCertificates'],
      'a SAML signing certificate the destination states is not a valid X.509 certificate',
      readFailure(thrown, 'validating-assertion'),
    );
  }
  const renewal = renewalFor(destination, grant, row.renewal);
  const authorization = (
    row.authorization as NonNullable<SamlRow['authorization']>
  )(destination, grant);
  const common = () => ({
    idpSsoUrl: means.samlIdpSsoUrl as string,
    spEntityId: means.samlSpEntityId as string,
    acsUrl: stated(means.samlAcsUrl),
    relayState: stated(means.samlRelayState),
    idpEntityId: means.samlIdpEntityId as string,
    idpInitiated: means.samlIdpInitiated === true,
    assertionValidator,
    authorization,
    logger: row.logger,
    renewal,
    persistence: persistenceFor(row),
  });

  if (grant === 'saml2_pure') {
    const secret = row.secret;
    const cookieProvider = (
      row.samlCookies as NonNullable<SamlRow['samlCookies']>
    )(destination);
    return constructed(
      destination,
      SAML_FIELDS,
      () =>
        new Saml2PureProvider(
          asContract<Saml2PureProviderConfig>({
            ...common(),
            cookieProvider,
            accessToken: stated(secret?.sessionCookies),
            expiresAt:
              typeof secret?.expiresAt === 'number'
                ? secret.expiresAt
                : undefined,
          }),
        ),
    );
  }
  return constructed(
    destination,
    SAML_FIELDS,
    () =>
      new Saml2BearerProvider(
        asContract<Saml2BearerProviderConfig>({
          ...common(),
          tokenUrl: stated(means.samlTokenUrl),
          uaaUrl: client?.uaaUrl as string,
          clientId: client?.uaaClientId as string,
          clientSecret: row.clientAuthentication
            ? undefined
            : stated(secretOf(client)),
          ...authenticatedBy(row.clientAuthentication),
          ...tokenSeed(row.secret),
        }),
      ),
  );
}
