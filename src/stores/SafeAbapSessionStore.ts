/**
 * Safe ABAP Session Store - in-memory session storage for ABAP connections
 * 
 * Stores full ABAP configuration (EnvConfig) in memory only.
 * Does not persist to disk - suitable for secure environments.
 * This is separate from SafeXsuaaSessionStore for type safety.
 */

import { ISessionStore } from './interfaces';
import { EnvConfig } from '../types';

/**
 * Safe ABAP Session store implementation
 * 
 * Stores session data in memory only (no file I/O).
 * Suitable for secure environments where tokens should not be persisted to disk.
 */
export class SafeAbapSessionStore implements ISessionStore {
  private sessions: Map<string, EnvConfig> = new Map();

  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns EnvConfig object or null if not found
   */
  async loadSession(destination: string): Promise<EnvConfig | null> {
    return this.sessions.get(destination) || null;
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @param config Session configuration to save (must be EnvConfig for ABAP)
   */
  async saveSession(destination: string, config: EnvConfig | any): Promise<void> {
    // Type guard - ensure it's EnvConfig
    if (!config || typeof config !== 'object' || !('sapUrl' in config)) {
      throw new Error('SafeAbapSessionStore can only store EnvConfig (ABAP) sessions');
    }
    this.sessions.set(destination, config as EnvConfig);
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL")
   */
  async deleteSession(destination: string): Promise<void> {
    this.sessions.delete(destination);
  }

  /**
   * Clear all sessions
   */
  clearAll(): void {
    this.sessions.clear();
  }
}

