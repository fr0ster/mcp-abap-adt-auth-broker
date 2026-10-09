/**
 * @mcp-abap-adt/auth-broker
 * Per-destination credential broker: `getProvider` builds the `IAuthProvider`
 * a destination states from its key store's means and its session store's
 * secret, and stores back what that provider obtains; the token API serves a
 * token from the same provider, or from one the consumer injects.
 */

// Contract types re-exported for convenience, each from the package that
// declares it: tokens from `interfaces-auth`, `AuthType` and
// `IAuthorizationConfig` from `interfaces-auth-sap`, the store contracts from
// `interfaces-auth-broker`, `ILogger` from `interfaces-utils`.
export type {
  IClientAuthentication,
  IRenewalStrategy,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces-auth';
export type { IClientCertificate } from '@mcp-abap-adt/interfaces-auth-broker';
export type { AuthType } from '@mcp-abap-adt/interfaces-auth-sap';
export type { ILogger } from '@mcp-abap-adt/interfaces-utils';
export {
  AuthBroker,
  type AuthBrokerConfig,
  type BrokerCallOptions,
  type StrategyGrant,
  type TokenProviderClient,
  type TokenProviderFactory,
} from './AuthBroker';
export { bindingOf, type SecretBinding } from './bindingOf';
export {
  type ClientAuthenticationContext,
  type ClientAuthenticationGrant,
  type ClientAuthenticationStrategy,
  type FromServiceKeySecretOptions,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from './clientAuthentication';
export {
  DestinationConfigError,
  type DestinationConfigErrorLike,
  isDestinationConfigError,
} from './DestinationConfigError';
export type { TokenGrant } from './destinations';
// Token provider interface
export type {
  IRefreshableTokenProvider,
  ITokenProvider,
  ITokenResult,
  TokenProviderOptions,
} from './providers';
export { SessionWriteFailure } from './SessionWriter';
// Main interfaces for consumers - stores return values through these
// These are the ONLY types consumers should use
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';
export type { IConfig } from './types';

// Store implementations: `@mcp-abap-adt/auth-stores`, or any `ISessionStore` /
// `IServiceKeyStore`. Provider implementations: `@mcp-abap-adt/auth-providers`.
