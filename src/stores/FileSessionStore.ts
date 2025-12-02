/**
 * File-based implementation of SessionStore
 * 
 * Reads/writes session data from/to {destination}.env files in search paths.
 */

import { ISessionStore } from './interfaces';
import { EnvConfig } from '../types';
import { loadEnvFile } from '../envLoader';
import { saveTokenToEnv } from '../tokenStorage';
import { resolveSearchPaths } from '../pathResolver';

/**
 * File-based session store implementation
 * 
 * Searches for {destination}.env files in configured search paths.
 * Writes to first search path (highest priority).
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class FileSessionStore implements ISessionStore {
  private searchPaths: string[];

  /**
   * Create a new FileSessionStore instance
   * @param searchPaths Optional search paths for .env files.
   *                    Can be a single path (string) or array of paths.
   *                    If not provided, uses AUTH_BROKER_PATH env var or current working directory.
   */
  constructor(searchPaths?: string | string[]) {
    this.searchPaths = resolveSearchPaths(searchPaths);
  }

  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns EnvConfig object or null if not found
   */
  async loadSession(destination: string): Promise<EnvConfig | null> {
    return loadEnvFile(destination, this.searchPaths);
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @param config Session configuration to save
   */
  async saveSession(destination: string, config: EnvConfig): Promise<void> {
    // Save to first search path (highest priority)
    const savePath = this.searchPaths[0];
    
    // Convert EnvConfig to format expected by saveTokenToEnv
    await saveTokenToEnv(destination, savePath, {
      sapUrl: config.sapUrl,
      jwtToken: config.jwtToken,
      refreshToken: config.refreshToken,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
      sapClient: config.sapClient,
      language: config.language,
    });
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL")
   */
  async deleteSession(destination: string): Promise<void> {
    // Find .env file in search paths
    const fileName = `${destination}.env`;
    const { findFileInPaths } = await import('../pathResolver');
    const fs = await import('fs');
    const envFilePath = findFileInPaths(fileName, this.searchPaths);
    
    if (envFilePath && fs.existsSync(envFilePath)) {
      fs.unlinkSync(envFilePath);
    }
  }

  /**
   * Get search paths (for error messages)
   * @returns Array of search paths
   */
  getSearchPaths(): string[] {
    return [...this.searchPaths];
  }
}

