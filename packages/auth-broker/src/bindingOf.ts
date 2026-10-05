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
import type { BoundClient } from './binding';
import {
  type Binding,
  handedOverBinding,
  oidcBinding,
  samlPureBinding,
  uaaBinding,
} from './binding';
import { isOidcGrant } from './destinations';

/**
 * The binding of a `jwt` or `saml` destination with the grant it states: the
 * UAA grants and `saml2_bearer` by `uaaUrl` and the client, the OIDC grants by
 * the issuer and the client, `saml2_pure` by its ACS, and `none` by what the
 * means state.
 */
export function destinationBinding(
  authType: 'jwt' | 'saml',
  grant: DestinationGrant,
  means: IConnectionConfig,
  client: BoundClient | null,
): Binding {
  if (grant === 'none') return handedOverBinding(authType, means, client);
  if (isOidcGrant(grant)) return oidcBinding(means, client);
  if (grant === 'saml2_pure') return samlPureBinding(means);
  return uaaBinding(means, client);
}

/** The two strings a session store keeps beside a secret; absent where the means cannot say. */
export interface SecretBinding {
  issuedFor?: string;
  issuedBy?: string;
}

/**
 * The binding the broker writes beside a secret for a destination with these
 * means and this client — canonical, exactly what `getProvider` compares a
 * stored secret against. For a consumer that hands over a credential the
 * broker cannot obtain (a `none` destination: a token or cookies it was
 * given) and writes it to the session store itself: written with this binding,
 * `getProvider` presents it; written with any other, it refuses.
 *
 * `means` are the key store's (`authType`, `grantType`, `serviceUrl`,
 * `sapClient`, the issuer or ACS); `client` is the key store's client, when the
 * destination has one. A destination that states no `jwt` / `saml` type or no
 * grant binds nothing: `{}`. Never logs, never throws.
 */
export function bindingOf(
  means: IConnectionConfig,
  client: IAuthorizationConfig | null = null,
): SecretBinding {
  const authType = means.authType;
  const grant = means.grantType;
  if ((authType !== 'jwt' && authType !== 'saml') || !grant) return {};
  const { issuedFor, issuedBy } = destinationBinding(
    authType,
    grant,
    means,
    client,
  );
  const binding: SecretBinding = {};
  if (issuedFor !== undefined) binding.issuedFor = issuedFor;
  if (issuedBy !== undefined) binding.issuedBy = issuedBy;
  return binding;
}
