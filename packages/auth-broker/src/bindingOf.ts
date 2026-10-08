/**
 * What a destination's means bind its secret to: the one
 * place the broker chooses which binding a destination has. `getProvider`
 * builds each provider with it, and `persist` writes what it gives beside every
 * secret; `bindingOf` hands the same to a consumer.
 */

import type {
  DestinationGrant,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import {
  type Binding,
  type BoundCertificate,
  type BoundClient,
  handedOverBinding,
  oidcBinding,
  samlBearerBinding,
  samlPureBinding,
  uaaBinding,
} from './binding';
import { isOidcGrant, isStatedRow } from './destinations';

/**
 * The binding of a `jwt` or `saml` destination with the grant it states — a
 * pair of the closed list, checked before (`statedGrant`): the UAA grants,
 * the OIDC grants, `saml2_pure`, `saml2_bearer` and `none`, each with the
 * fields of its row (§6.1). `certificate` is the certificate client the build
 * read for the `clientAuthentication` strategy, or `null` when it read none.
 */
export function destinationBinding(
  authType: 'jwt' | 'saml',
  grant: DestinationGrant,
  means: IConnectionConfig,
  client: BoundClient | null,
  certificate: BoundCertificate | null = null,
): Binding {
  if (grant === 'none') return handedOverBinding(authType, means, client);
  if (isOidcGrant(grant)) {
    return oidcBinding(grant, means, client, certificate);
  }
  if (grant === 'saml2_pure') return samlPureBinding(means);
  if (grant === 'saml2_bearer') {
    return samlBearerBinding(means, client, certificate);
  }
  return uaaBinding(grant, means, client, certificate);
}

/**
 * The row of the token API's consumer provider: `provider/<authType>/<grant>`
 * when the means state a pair of the closed list, else `provider/-`.
 */
export function consumerRow(means: IConnectionConfig | null): string {
  const authType = means?.authType;
  const grant = means?.grantType;
  return isStatedRow(authType, grant)
    ? `provider/${authType}/${grant}`
    : 'provider/-';
}

/** The two strings a session store keeps beside a secret; absent where the means cannot say. */
export interface SecretBinding {
  issuedFor?: string;
  issuedBy?: string;
}

/**
 * The binding the broker writes beside a secret for a destination with these
 * means and this client: `issuedFor` the canonical resource, `issuedBy` the
 * version-2 record of the row the means state, built from `means` and
 * `client` alone.
 *
 * It is exactly what `getProvider` compares for a `none` row — its use: a
 * consumer that hands over a credential the broker cannot obtain (a token or
 * cookies it was given) writes it with this binding, and `getProvider`
 * presents it; written with any other — a 4.x `bindingOf`'s included — it
 * refuses. It is also exactly what `getProvider` writes for a token row built
 * without a `clientAuthentication` strategy.
 *
 * It is **not** what a token row writes beside a `clientAuthentication`
 * strategy: there the row's record also holds what the build read of the
 * certificate client — its `certUrl`, and its certificate in the trust
 * digest — and its client identity may be the certificate client's, none of
 * which `bindingOf` is given. Nor is it the token API's record for a
 * consumer's provider (`provider/…`).
 *
 * `means` are the key store's (`authType`, `grantType`, `serviceUrl`,
 * `sapClient`, the addresses and trust the row reads); `client` is the key
 * store's client, when the destination has one. A destination that states no
 * `jwt` / `saml` type, no grant, or a pair outside the closed list binds
 * nothing: `{}`. Never logs, never throws.
 */
export function bindingOf(
  means: IConnectionConfig,
  client: IAuthorizationConfig | null = null,
): SecretBinding {
  const authType = means.authType;
  const grant = means.grantType;
  if (authType !== 'jwt' && authType !== 'saml') return {};
  if (!isStatedRow(authType, grant)) return {};
  const { issuedFor, issuedBy } = destinationBinding(
    authType,
    grant,
    means,
    client,
  );
  const binding: SecretBinding = { issuedBy };
  if (issuedFor !== undefined) binding.issuedFor = issuedFor;
  return binding;
}
