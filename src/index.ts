/**
 * @mcp-abap-adt/auth-broker
 * JWT authentication broker for MCP ABAP ADT server
 */

// Three contract types re-exported for convenience, each from the package that
// declares it — `@mcp-abap-adt/interfaces` is deleted as of its 52.0.0.
export type { ITokenRefresher } from '@mcp-abap-adt/interfaces-auth';
export type { AuthType } from '@mcp-abap-adt/interfaces-auth-sap';
export type { ILogger } from '@mcp-abap-adt/interfaces-utils';
export { AuthBroker, type AuthBrokerConfig } from './AuthBroker';
// Token provider interface
export type {
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

// Store and provider implementations are in separate packages:
// - @mcp-abap-adt/auth-stores-btp - BTP and ABAP stores
// - @mcp-abap-adt/auth-stores-xsuaa - XSUAA stores
// - @mcp-abap-adt/auth-providers - XSUAA and BTP token providers
