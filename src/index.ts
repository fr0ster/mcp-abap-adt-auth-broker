/**
 * @mcp-abap-adt/auth-broker
 * JWT authentication broker for MCP ABAP ADT server
 */

export { AuthBroker } from './AuthBroker';
// Main interfaces for consumers - stores return values through these
// These are the ONLY types consumers should use
export type { IAuthorizationConfig, IConnectionConfig, IServiceKeyStore, ISessionStore } from './stores/interfaces';
export type { IConfig } from './types';
// Token provider interface
export type { ITokenProvider, TokenProviderOptions, TokenProviderResult } from './providers';
// Logger (re-exported from @mcp-abap-adt/logger for convenience)
export type { Logger } from '@mcp-abap-adt/logger';

// Store and provider implementations are in separate packages:
// - @mcp-abap-adt/auth-stores-btp - BTP and ABAP stores
// - @mcp-abap-adt/auth-stores-xsuaa - XSUAA stores
// - @mcp-abap-adt/auth-providers - XSUAA and BTP token providers

