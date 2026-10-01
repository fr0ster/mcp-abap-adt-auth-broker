/**
 * @mcp-abap-adt/auth-broker
 * Per-destination token broker: sessions and service keys from stores,
 * tokens from an injected provider, results persisted.
 */

// Contract types re-exported for convenience, each from the package that
// declares it: tokens from `interfaces-auth`, `AuthType` and
// `IAuthorizationConfig` from `interfaces-auth-sap`, the store contracts from
// `interfaces-auth-broker`, `ILogger` from `interfaces-utils`.
export type { ITokenRefresher } from '@mcp-abap-adt/interfaces-auth';
export type { AuthType } from '@mcp-abap-adt/interfaces-auth-sap';
export type { ILogger } from '@mcp-abap-adt/interfaces-utils';
export {
  AuthBroker,
  type AuthBrokerConfig,
  type TokenProviderFactory,
} from './AuthBroker';
// Token provider interface
export type {
  IRefreshableTokenProvider,
  ITokenProvider,
  ITokenResult,
  TokenProviderOptions,
} from './providers';
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
