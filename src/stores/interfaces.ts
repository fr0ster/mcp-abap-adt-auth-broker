/**
 * Storage interfaces for AuthBroker
 * 
 * All interfaces are defined here. Types (type aliases) are in types.ts.
 */

import type { IConfig } from '../types';

/**
 * Authorization configuration - values needed for obtaining and refreshing tokens
 * Returned by stores with actual values (not file paths)
 */
export interface IAuthorizationConfig {
  /** UAA URL for token refresh */
  uaaUrl: string;
  /** UAA client ID */
  uaaClientId: string;
  /** UAA client secret */
  uaaClientSecret: string;
  /** Refresh token for token renewal (optional) */
  refreshToken?: string;
}

/**
 * Connection configuration - values needed for connecting to services
 * Returned by stores with actual values (not file paths)
 */
export interface IConnectionConfig {
  /** Service URL (SAP/ABAP/MCP URL) - undefined for XSUAA if not provided */
  serviceUrl?: string;
  /** Authorization token (JWT token) */
  authorizationToken: string;
  /** SAP client number (optional, for ABAP/BTP) */
  sapClient?: string;
  /** Language (optional, for ABAP/BTP) */
  language?: string;
}

/**
 * Interface for storing and retrieving service keys
 * 
 * Service keys contain UAA credentials and connection URLs.
 */
export interface IServiceKeyStore {
  /**
   * Get raw service key for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Service key object (implementation-specific) or null if not found
   */
  getServiceKey(destination: string): Promise<IConfig | null>;

  /**
   * Get authorization configuration from service key
   * Returns values needed for obtaining and refreshing tokens
   * @param destination Destination name (e.g., "TRIAL")
   * @returns IAuthorizationConfig with actual values or null if not found
   */
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>;

  /**
   * Get connection configuration from service key
   * Returns values needed for connecting to services
   * @param destination Destination name (e.g., "TRIAL")
   * @returns IConnectionConfig with actual values or null if not found
   */
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;
}

/**
 * Interface for session stores - stores and retrieves session data
 * 
 * Session stores handle loading, saving, and managing session data (tokens, configuration).
 */
export interface ISessionStore {
  /**
   * Load session configuration for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * Can contain either authorization config, or connection config, or both
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IConfig with actual values or null if not found
   */
  loadSession(destination: string): Promise<IConfig | null>;

  /**
   * Save session configuration for destination
   * Accepts IConfig (optional composition) or internal representation (for backward compatibility)
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config IConfig or internal session configuration to save
   */
  saveSession(destination: string, config: IConfig | unknown): Promise<void>;

  /**
   * Delete session for destination (optional)
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   */
  deleteSession?(destination: string): Promise<void>;

  /**
   * Get authorization configuration with actual values (not file paths)
   * Returns values needed for obtaining and refreshing tokens
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IAuthorizationConfig with actual values or null if not found
   */
  getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>;

  /**
   * Get connection configuration with actual values (not file paths)
   * Returns values needed for connecting to services
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IConnectionConfig with actual values or null if not found
   */
  getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;

  /**
   * Set authorization configuration
   * Updates values needed for obtaining and refreshing tokens
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config IAuthorizationConfig with values to set
   */
  setAuthorizationConfig(destination: string, config: IAuthorizationConfig): Promise<void>;

  /**
   * Set connection configuration
   * Updates values needed for connecting to services
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config IConnectionConfig with values to set
   */
  setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void>;
}

