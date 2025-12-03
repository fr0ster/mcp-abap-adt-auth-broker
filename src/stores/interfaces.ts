/**
 * Storage interfaces for AuthBroker
 * 
 * These interfaces allow consumers to provide custom storage implementations
 * for service keys and session data (tokens, configuration).
 */

import { ServiceKey, EnvConfig, BtpSessionConfig } from '../types';

/**
 * Interface for storing and retrieving service keys
 * 
 * Service keys contain UAA credentials and SAP URL for a destination.
 * Default implementation: FileServiceKeyStore (reads from {destination}.json files)
 */
export interface IServiceKeyStore {
  /**
   * Get service key for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns ServiceKey object or null if not found
   */
  getServiceKey(destination: string): Promise<ServiceKey | null>;
}

/**
 * Interface for storing and retrieving session data (tokens, configuration)
 * 
 * Session data can be either:
 * - EnvConfig: Full ABAP configuration (SAP URL, JWT token, refresh token, UAA config, SAP client, language)
 * - BtpSessionConfig: Simplified BTP configuration (MCP URL, JWT token, optional refresh token)
 * 
 * Default implementations:
 * - AbapSessionStore: reads/writes {destination}.env files for ABAP connections
 * - XsuaaSessionStore: reads/writes {destination}.env files for XSUAA service connections
 */
export interface ISessionStore {
  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns EnvConfig or BtpSessionConfig object or null if not found
   */
  loadSession(destination: string): Promise<EnvConfig | BtpSessionConfig | null>;

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config Session configuration to save (EnvConfig or BtpSessionConfig)
   */
  saveSession(destination: string, config: EnvConfig | BtpSessionConfig): Promise<void>;

  /**
   * Delete session for destination (optional)
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   */
  deleteSession?(destination: string): Promise<void>;
}

// Backward compatibility aliases
/** @deprecated Use IServiceKeyStore instead */
export type ServiceKeyStore = IServiceKeyStore;

/** @deprecated Use ISessionStore instead */
export type SessionStore = ISessionStore;

