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
  SamlAuthProvider,
  SncLogonProvider,
  TokenAuthProvider,
  UaaPasscodeProvider,
  ValidationError,
} from '@mcp-abap-adt/auth-providers';
import type {
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
 */
export function handedOverProvider(
  destination: string,
  authType: 'jwt' | 'saml',
  secret: IConfig | null,
): IAuthProvider {
  if (authType === 'jwt') {
    if (!present(secret?.authorizationToken)) {
      throw new DestinationConfigError(
        destination,
        ['authorizationToken'],
        'a jwt destination with grantType none needs the token in its session',
      );
    }
    return TokenAuthProvider.fixed(secret.authorizationToken);
  }
  if (!present(secret?.sessionCookies)) {
    throw new DestinationConfigError(
      destination,
      ['sessionCookies'],
      'a saml destination with grantType none needs the cookies in its session',
    );
  }
  return new SamlAuthProvider(secret.sessionCookies);
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
      ...hooks,
    });
  }

  const seed = {
    accessToken: present(secret?.authorizationToken)
      ? secret.authorizationToken
      : undefined,
    refreshToken: present(secret?.refreshToken)
      ? secret.refreshToken
      : undefined,
    expiresAt:
      typeof secret?.expiresAt === 'number' ? secret.expiresAt : undefined,
  };
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
