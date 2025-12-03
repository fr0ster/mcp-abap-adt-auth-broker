/**
 * @mcp-abap-adt/auth-broker
 * JWT authentication broker for MCP ABAP ADT server
 */

export { AuthBroker } from './AuthBroker';
// Main interfaces for consumers - stores return values through these
// These are the ONLY types consumers should use
export type { IAuthorizationConfig, IConnectionConfig, IServiceKeyStore, ISessionStore } from './stores/interfaces';
export type { IConfig } from './types';
// Token providers - convert IAuthorizationConfig to IConnectionConfig
export { ITokenProvider, XsuaaTokenProvider, BtpTokenProvider } from './providers';
export type { TokenProviderOptions, TokenProviderResult } from './providers';
export { resolveSearchPaths, findFileInPaths } from './utils/pathResolver';
export { AbapServiceKeyStore, AbapSessionStore, XsuaaServiceKeyStore, XsuaaSessionStore, BtpSessionStore, SafeAbapSessionStore, SafeXsuaaSessionStore, SafeBtpSessionStore } from './stores';

// Service key parsers are internal implementation details - not exported
// Parsers are used internally by stores for parsing service key files
export { loadServiceKey } from './loaders/abap/serviceKeyLoader';

// Constants are internal implementation details - not exported
// All file operations are handled by stores through interfaces
// Consumers should use IServiceKeyStore and ISessionStore interfaces

