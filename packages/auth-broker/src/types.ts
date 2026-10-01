/**
 * Type definitions for auth-broker package
 *
 * The store contracts (`IConfig`, `IConnectionConfig`, `ISessionStore`,
 * `IServiceKeyStore`) come from `@mcp-abap-adt/interfaces-auth-broker`;
 * `IAuthorizationConfig` from `@mcp-abap-adt/interfaces-auth-sap`.
 */

import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';

// Re-export for backward compatibility
export type {
  IAuthorizationConfig,
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
};
