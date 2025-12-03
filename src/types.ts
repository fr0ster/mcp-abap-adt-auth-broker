/**
 * Type definitions for auth-broker package
 * 
 * Type aliases (type) are defined here. Interfaces are in stores/interfaces.ts.
 */

import type { IAuthorizationConfig, IConnectionConfig } from './stores/interfaces';

/**
 * Configuration - optional composition of authorization and connection configuration
 * Can contain either authorization config, or connection config, or both
 */
export type IConfig = Partial<IAuthorizationConfig> & Partial<IConnectionConfig>;

// Re-export interfaces for convenience
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';