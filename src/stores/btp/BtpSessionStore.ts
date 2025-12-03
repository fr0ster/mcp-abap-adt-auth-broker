/**
 * BTP Session Store - stores BTP session data for ABAP system access (full scope)
 * 
 * Stores to {destination}.env files with BTP_* variables:
 * - BTP_ABAP_URL: ABAP system URL (required - from service key or YAML)
 * - BTP_JWT_TOKEN: JWT token for Authorization: Bearer header
 * - BTP_REFRESH_TOKEN: Optional refresh token for token renewal
 * - BTP_UAA_URL: UAA URL for token refresh (from service key)
 * - BTP_UAA_CLIENT_ID: UAA client ID (from service key)
 * - BTP_UAA_CLIENT_SECRET: UAA client secret (from service key)
 * 
 * Note: Uses BTP_* variables for BTP authentication to ABAP systems (full roles and scopes).
 */

import { IAuthorizationConfig, IConnectionConfig, ISessionStore } from '../interfaces';
import { IConfig } from '../../types';
import { AbstractJsonSessionStore } from '../AbstractJsonSessionStore';
import { findFileInPaths } from '../../utils/pathResolver';

// Internal type for BTP session storage
interface BtpSessionData {
  abapUrl: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl: string;
  uaaClientId: string;
  uaaClientSecret: string;
  sapClient?: string;
  language?: string;
}
import { loadBtpEnvFile } from '../../storage/btp/btpEnvLoader';
import { saveBtpTokenToEnv } from '../../storage/btp/btpTokenStorage';
import * as path from 'path';

/**
 * BTP Session Store implementation
 * 
 * Stores session data in {destination}.env files.
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class BtpSessionStore extends AbstractJsonSessionStore implements ISessionStore {
  /**
   * Get file name for destination
   * @param destination Destination name
   * @returns File name (e.g., "btp.env")
   */
  protected getFileName(destination: string): string {
    return `${destination}.env`;
  }

  /**
   * Load session from file
   * @param filePath Path to session file
   * @returns Parsed BtpSessionConfig or null if invalid
   */
  protected async loadFromFile(filePath: string): Promise<unknown | null> {
    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    
    // Load from .env file using BTP env loader (reads BTP_* variables)
    const btpConfig = await loadBtpEnvFile(destination, this.searchPaths);
    if (!btpConfig) {
      return null;
    }

    return btpConfig;
  }

  /**
   * Save session to file
   * @param filePath Path to session file
   * @param config Session configuration to save
   */
  protected async saveToFile(filePath: string, config: unknown): Promise<void> {
    // Type guard - ensure it's BtpSessionConfig, not EnvConfig (ABAP) or XsuaaSessionConfig (XSUAA)
    if (!config || typeof config !== 'object') {
      throw new Error('BtpSessionStore can only store BtpSessionConfig (BTP) sessions');
    }
    
    // Reject ABAP sessions (EnvConfig has sapUrl)
    if ('sapUrl' in config) {
      throw new Error('BtpSessionStore can only store BtpSessionConfig (BTP) sessions');
    }
    
    // Reject XSUAA sessions (XsuaaSessionConfig has mcpUrl but no abapUrl)
    if ('mcpUrl' in config && !('abapUrl' in config)) {
      throw new Error('BtpSessionStore can only store BtpSessionConfig (BTP) sessions');
    }
    
    // Ensure it has abapUrl (required for BtpSessionConfig)
    if (!('abapUrl' in config)) {
      throw new Error('BtpSessionStore can only store BtpSessionConfig (BTP) sessions');
    }

    // Validate required fields
    const configObj = config as Record<string, unknown>;
    if (!configObj.abapUrl || !configObj.jwtToken || !configObj.uaaUrl || !configObj.uaaClientId || !configObj.uaaClientSecret) {
      throw new Error('BTP session config missing required fields: abapUrl, jwtToken, uaaUrl, uaaClientId, uaaClientSecret');
    }

    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    const savePath = path.dirname(filePath);

    // Save using BTP token storage (writes BTP_* variables)
    await saveBtpTokenToEnv(destination, savePath, config as BtpSessionData);
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
   * Used internally for getAuthorizationConfig, getConnectionConfig, setAuthorizationConfig and setConnectionConfig
   */
  private async loadRawSession(destination: string): Promise<BtpSessionData | null> {
    const fileName = this.getFileName(destination);
    const sessionPath = findFileInPaths(fileName, this.searchPaths);
    
    if (!sessionPath) {
      return null;
    }
    
    try {
      const raw = await this.loadFromFile(sessionPath);
      if (!raw || !isBtpSessionConfig(raw)) {
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

    if (!sessionConfig.jwtToken || !sessionConfig.abapUrl) {
      return null;
    }

    return {
      serviceUrl: sessionConfig.abapUrl,
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
    const updated: BtpSessionData = {
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
    const updated: BtpSessionData = {
      ...current,
      abapUrl: config.serviceUrl || current.abapUrl,
      jwtToken: config.authorizationToken,
      sapClient: config.sapClient !== undefined ? config.sapClient : current.sapClient,
      language: config.language !== undefined ? config.language : current.language,
    };
    
    await this.saveSession(destination, updated);
  }
}

/**
 * Type guard for BtpSessionConfig
 */
function isBtpSessionConfig(config: unknown): config is BtpSessionData {
  if (!config || typeof config !== 'object') return false;
  const obj = config as Record<string, unknown>;
  return 'abapUrl' in obj && 'jwtToken' in obj;
}

