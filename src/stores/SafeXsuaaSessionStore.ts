/**
 * Safe XSUAA Session Store - in-memory session storage for XSUAA service connections
 * 
 * Stores simplified XSUAA configuration (BtpSessionConfig) in memory only.
 * Does not persist to disk - suitable for secure environments.
 * This is separate from SafeAbapSessionStore for type safety.
 */

import { ISessionStore } from './interfaces';
import { BtpSessionConfig } from '../types';

/**
 * Safe XSUAA Session store implementation
 * 
 * Stores session data in memory only (no file I/O).
 * Suitable for secure environments where tokens should not be persisted to disk.
 */
export class SafeXsuaaSessionStore implements ISessionStore {
  private sessions: Map<string, BtpSessionConfig> = new Map();

  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "mcp")
   * @returns BtpSessionConfig object or null if not found
   */
  async loadSession(destination: string): Promise<BtpSessionConfig | null> {
    return this.sessions.get(destination) || null;
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "mcp")
   * @param config Session configuration to save (must be BtpSessionConfig for XSUAA)
   */
  async saveSession(destination: string, config: BtpSessionConfig | any): Promise<void> {
    // Type guard - ensure it's BtpSessionConfig, not EnvConfig (ABAP)
    if (!config || typeof config !== 'object') {
      throw new Error('SafeXsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }
    
    // Reject ABAP sessions (EnvConfig has sapUrl, BtpSessionConfig doesn't)
    if ('sapUrl' in config) {
      throw new Error('SafeXsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }
    
    // Ensure it has jwtToken (required for BtpSessionConfig)
    if (!('jwtToken' in config)) {
      throw new Error('SafeXsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }
    
    this.sessions.set(destination, config as BtpSessionConfig);
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "mcp")
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

