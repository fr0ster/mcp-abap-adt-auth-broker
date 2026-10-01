/**
 * Storage interfaces for AuthBroker
 *
 * Store implementations are in separate packages:
 * - @mcp-abap-adt/auth-stores-btp - BTP and ABAP stores
 */

export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './interfaces';
