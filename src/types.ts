/**
 * Type definitions for auth-broker package
 *
 * Type aliases (type) are defined here. Interfaces are imported from @mcp-abap-adt/interfaces.
 */

// Import interfaces from shared package
import type {
  IAuthorizationConfig,
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type {
  IConfig,
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
};
