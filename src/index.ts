/**
 * @mcp-abap-adt/auth-broker
 * JWT authentication broker for MCP ABAP ADT server
 */

export { AuthBroker } from './AuthBroker';
export type { EnvConfig, BtpSessionConfig, ServiceKey } from './types';
export { resolveSearchPaths, findFileInPaths } from './pathResolver';

// Export storage interfaces and implementations
export { IServiceKeyStore, ISessionStore, ServiceKeyStore, SessionStore } from './stores/interfaces';
export { AbapServiceKeyStore, AbapSessionStore, XsuaaServiceKeyStore, XsuaaSessionStore, SafeAbapSessionStore, SafeXsuaaSessionStore } from './stores';

// Export service key parsers
export { IServiceKeyParser, AbapServiceKeyParser, XsuaaServiceKeyParser } from './parsers';
export { loadServiceKey } from './serviceKeyLoader';

// Export constants for environment variables and HTTP headers
export {
  ABAP_ENV_VARS,
  BTP_ENV_VARS,
  ABAP_HEADERS,
  BTP_HEADERS,
  getBtpAuthorizationHeader,
  isAbapEnvVar,
  isBtpEnvVar,
} from './constants';

