/**
 * Storage interfaces for AuthBroker
 *
 * All interfaces are imported from @mcp-abap-adt/interfaces package.
 * Type aliases (type) are in types.ts.
 */

// Import interfaces from shared package
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
};
