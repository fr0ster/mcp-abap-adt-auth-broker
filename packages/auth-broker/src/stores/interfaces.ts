/**
 * Storage interfaces for AuthBroker
 *
 * The store contracts come from `@mcp-abap-adt/interfaces-auth-broker`;
 * `IAuthorizationConfig` from `@mcp-abap-adt/interfaces-auth-sap`.
 */

import type {
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';

// Re-export for backward compatibility
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
};
