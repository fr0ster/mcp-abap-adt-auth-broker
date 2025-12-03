/**
 * ABAP Session Store - stores full ABAP session configuration
 * 
 * Reads/writes session data from/to {destination}.env files in search paths.
 * Stores full ABAP configuration: SAP URL, JWT token, refresh token, UAA config, SAP client, language.
 */

import { IAuthorizationConfig, IConnectionConfig, ISessionStore } from '../interfaces';
import { IConfig } from '../../types';
import { AbstractJsonSessionStore } from '../AbstractJsonSessionStore';

// Internal type for ABAP session storage
interface AbapSessionData {
  sapUrl: string;
  sapClient?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
  language?: string;
}
import { loadEnvFile } from '../../storage/abap/envLoader';
import { saveTokenToEnv } from '../../storage/abap/tokenStorage';
import { findFileInPaths } from '../../utils/pathResolver';
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
export class AbapSessionStore extends AbstractJsonSessionStore implements ISessionStore {
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
  protected async loadFromFile(filePath: string): Promise<unknown | null> {
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
  protected async saveToFile(filePath: string, config: unknown): Promise<void> {
    // Type guard - ensure it's EnvConfig
    if (!config || typeof config !== 'object' || !('sapUrl' in config)) {
      throw new Error('AbapSessionStore can only store EnvConfig (ABAP) sessions');
    }

    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    const savePath = path.dirname(filePath);

    // Convert to format expected by saveTokenToEnv
    const abapConfig = config as AbapSessionData;
    await saveTokenToEnv(destination, savePath, {
      sapUrl: abapConfig.sapUrl,
      jwtToken: abapConfig.jwtToken,
      refreshToken: abapConfig.refreshToken,
      uaaUrl: abapConfig.uaaUrl,
      uaaClientId: abapConfig.uaaClientId,
      uaaClientSecret: abapConfig.uaaClientSecret,
      sapClient: abapConfig.sapClient,
      language: abapConfig.language,
    });
  }

  /**
   * Load session configuration for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * @param destination Destination name
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
   * Load raw session data (internal representation)
   * Used internally for setAuthorizationConfig and setConnectionConfig
   */
  private async loadRawSession(destination: string): Promise<AbapSessionData | null> {
    const fileName = this.getFileName(destination);
    const sessionPath = findFileInPaths(fileName, this.searchPaths);
    
    if (!sessionPath) {
      return null;
    }
    
    try {
      const raw = await this.loadFromFile(sessionPath);
      if (!raw || !isEnvConfig(raw)) {
        return null;
      }
      return raw;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get authorization configuration with actual values (not file paths)
   * Returns values needed for obtaining and refreshing tokens
   * @param destination Destination name
   * @returns AuthorizationConfig with actual values or null if not found
   */
  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    const sessionConfig = await this.loadRawSession(destination);
    if (!sessionConfig) {
      return null;
    }

    if (!sessionConfig.uaaUrl || !sessionConfig.uaaClientId || !sessionConfig.uaaClientSecret) {
      return null;
    }

    return {
      uaaUrl: sessionConfig.uaaUrl,
      uaaClientId: sessionConfig.uaaClientId,
      uaaClientSecret: sessionConfig.uaaClientSecret,
      refreshToken: sessionConfig.refreshToken,
    };
  }

  /**
   * Get connection configuration with actual values (not file paths)
   * Returns values needed for connecting to services
   * @param destination Destination name
   * @returns ConnectionConfig with actual values or null if not found
   */
  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    const sessionConfig = await this.loadRawSession(destination);
    if (!sessionConfig) {
      return null;
    }

    if (!sessionConfig.jwtToken || !sessionConfig.sapUrl) {
      return null;
    }

    return {
      serviceUrl: sessionConfig.sapUrl,
      authorizationToken: sessionConfig.jwtToken,
      sapClient: sessionConfig.sapClient,
      language: sessionConfig.language,
    };
  }

  /**
   * Set authorization configuration
   * Updates values needed for obtaining and refreshing tokens
   * @param destination Destination name
   * @param config IAuthorizationConfig with values to set
   */
  async setAuthorizationConfig(destination: string, config: IAuthorizationConfig): Promise<void> {
    const current = await this.loadRawSession(destination);
    if (!current) {
      throw new Error(`No session found for destination "${destination}"`);
    }

    // Update authorization fields
    const updated: AbapSessionData = {
      ...current,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
      refreshToken: config.refreshToken || current.refreshToken,
    };
    await this.saveSession(destination, updated);
  }

  /**
   * Set connection configuration
   * Updates values needed for connecting to services
   * @param destination Destination name
   * @param config IConnectionConfig with values to set
   */
  async setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void> {
    const current = await this.loadRawSession(destination);
    if (!current) {
      throw new Error(`No session found for destination "${destination}"`);
    }

    // Update connection fields
    const updated: AbapSessionData = {
      ...current,
      sapUrl: config.serviceUrl || current.sapUrl,
      jwtToken: config.authorizationToken,
      sapClient: config.sapClient !== undefined ? config.sapClient : current.sapClient,
      language: config.language !== undefined ? config.language : current.language,
    };
    
    await this.saveSession(destination, updated);
  }
}

/**
 * Type guard for JsonEnvConfig
 */
function isEnvConfig(config: unknown): config is AbapSessionData {
  if (!config || typeof config !== 'object') return false;
  const obj = config as Record<string, unknown>;
  return 'sapUrl' in obj && 'jwtToken' in obj;
}

