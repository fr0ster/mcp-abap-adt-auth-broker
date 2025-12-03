/**
 * ABAP Session Store - stores full ABAP session configuration
 * 
 * Reads/writes session data from/to {destination}.env files in search paths.
 * Stores full ABAP configuration: SAP URL, JWT token, refresh token, UAA config, SAP client, language.
 */

import { EnvConfig } from '../types';
import { AbstractSessionStore } from './AbstractSessionStore';
import { loadEnvFile } from '../envLoader';
import { saveTokenToEnv } from '../tokenStorage';
import * as path from 'path';

/**
 * ABAP Session store implementation
 * 
 * Searches for {destination}.env files in configured search paths.
 * Writes to first search path (highest priority).
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class AbapSessionStore extends AbstractSessionStore {
  /**
   * Get file name for destination
   * @param destination Destination name
   * @returns File name (e.g., "TRIAL.env")
   */
  protected getFileName(destination: string): string {
    return `${destination}.env`;
  }

  /**
   * Load session from file
   * @param filePath Path to session file
   * @returns Parsed EnvConfig or null if invalid
   */
  protected async loadFromFile(filePath: string): Promise<EnvConfig | null> {
    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    return loadEnvFile(destination, this.searchPaths);
  }

  /**
   * Save session to file
   * @param filePath Path to session file
   * @param config Session configuration to save
   */
  protected async saveToFile(filePath: string, config: EnvConfig | any): Promise<void> {
    // Type guard - ensure it's EnvConfig
    if (!config || typeof config !== 'object' || !('sapUrl' in config)) {
      throw new Error('AbapSessionStore can only store EnvConfig (ABAP) sessions');
    }

    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    const savePath = path.dirname(filePath);

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
}

