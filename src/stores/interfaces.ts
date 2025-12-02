/**
 * Storage interfaces for AuthBroker
 * 
 * These interfaces allow consumers to provide custom storage implementations
 * for service keys and session data (tokens, configuration).
 */

import { ServiceKey, EnvConfig } from '../types';

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
 * Session data contains JWT tokens, refresh tokens, UAA config, and SAP URL.
 * Default implementation: FileSessionStore (reads/writes {destination}.env files)
 */
export interface ISessionStore {
  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns EnvConfig object or null if not found
   */
  loadSession(destination: string): Promise<EnvConfig | null>;

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @param config Session configuration to save
   */
  saveSession(destination: string, config: EnvConfig): Promise<void>;

  /**
   * Delete session for destination (optional)
   * @param destination Destination name (e.g., "TRIAL")
   */
  deleteSession?(destination: string): Promise<void>;
}

// Backward compatibility aliases
/** @deprecated Use IServiceKeyStore instead */
export type ServiceKeyStore = IServiceKeyStore;

/** @deprecated Use ISessionStore instead */
export type SessionStore = ISessionStore;

