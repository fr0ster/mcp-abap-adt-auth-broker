/**
 * Abstract Safe Session Store - base class for in-memory session stores
 * 
 * Provides common functionality for in-memory session storage.
 * Subclasses implement type-specific validation and conversion logic.
 */

import { ISessionStore, IAuthorizationConfig, IConnectionConfig } from './interfaces';
import { IConfig } from '../types';

/**
 * Abstract base class for safe (in-memory) session stores
 * 
 * Handles common in-memory operations. Subclasses provide type-specific logic.
 */
export abstract class AbstractSafeSessionStore {
  protected sessions: Map<string, unknown> = new Map();

  /**
   * Load raw session data (internal representation)
   * Used internally by getAuthorizationConfig, getConnectionConfig, setAuthorizationConfig, setConnectionConfig
   */
  protected loadRawSession(destination: string): unknown | null {
    return this.sessions.get(destination) || null;
  }

  /**
   * Load session configuration for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IConfig with actual values or null if not found
   */
  async loadSession(destination: string): Promise<IConfig | null> {
    const authConfig = await this.getAuthorizationConfig(destination);
    const connConfig = await this.getConnectionConfig(destination);
    
    // Return null if both are null, otherwise return composition (even if one is null)
    if (!authConfig && !connConfig) {
      return null;
    }
    
    return {
      ...(authConfig || {}),
      ...(connConfig || {}),
    };
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config Session configuration to save (IConfig or internal format)
   */
  async saveSession(destination: string, config: unknown): Promise<void> {
    this.validateSessionConfig(config);
    // Convert IConfig to internal format if needed
    const internalConfig = this.convertToInternalFormat(config);
    this.sessions.set(destination, internalConfig);
  }

  /**
   * Convert IConfig to internal format (override in subclasses if needed)
   * @param config IConfig or internal format
   * @returns Internal format
   */
  protected convertToInternalFormat(config: unknown): unknown {
    // Default: return as-is (subclasses can override)
    return config;
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
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

  /**
   * Get authorization configuration with actual values (not file paths)
   * Returns values needed for obtaining and refreshing tokens
   * Must be implemented by subclasses
   * @param destination Destination name
   * @returns IAuthorizationConfig with actual values or null if not found
   */
  abstract getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>;

  /**
   * Set authorization configuration
   * Updates values needed for obtaining and refreshing tokens
   * Must be implemented by subclasses
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config IAuthorizationConfig with values to set
   */
  abstract setAuthorizationConfig(destination: string, config: IAuthorizationConfig): Promise<void>;

  /**
   * Validate session configuration (must be implemented by subclasses)
   * @param config Session configuration to validate
   * @throws Error if config is invalid for this store type
   */
  protected abstract validateSessionConfig(config: unknown): void;

  /**
   * Check if session config is valid for this store type (must be implemented by subclasses)
   * @param config Session configuration to check
   * @returns true if config is valid for this store type
   */
  protected abstract isValidSessionConfig(config: unknown): boolean;

  /**
   * Get connection configuration with actual values (must be implemented by subclasses)
   * @param destination Destination name
   * @returns IConnectionConfig with actual values or null if not found
   */
  abstract getConnectionConfig(destination: string): Promise<IConnectionConfig | null>;

  /**
   * Set connection configuration (must be implemented by subclasses)
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config IConnectionConfig with values to set
   */
  abstract setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void>;
}

