/**
 * @mcp-abap-adt/auth-broker
 * JWT authentication broker for MCP ABAP ADT server
 */

// Token refresher interface (re-exported from @mcp-abap-adt/interfaces for convenience)
// Logger interface (re-exported from @mcp-abap-adt/interfaces for convenience)
// AuthType (re-exported from @mcp-abap-adt/interfaces for convenience)
export type {
  AuthType,
  ILogger,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
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
