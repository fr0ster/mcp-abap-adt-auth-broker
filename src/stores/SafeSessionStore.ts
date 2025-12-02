/**
 * In-memory implementation of SessionStore
 * 
 * Stores session data in memory (Map). Data is lost after application restart.
 * This is a secure implementation that doesn't persist sensitive data to disk.
 */

import { ISessionStore } from './interfaces';
import { EnvConfig } from '../types';

/**
 * In-memory session store implementation
 * 
 * Stores session data in a Map. All data is lost when the application restarts.
 * This is the default secure implementation that doesn't write sensitive data to files.
 */
export class SafeSessionStore implements ISessionStore {
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
   * @param config Session configuration to save
   */
  async saveSession(destination: string, config: EnvConfig): Promise<void> {
    this.sessions.set(destination, config);
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL")
   */
  async deleteSession(destination: string): Promise<void> {
    this.sessions.delete(destination);
  }
}

