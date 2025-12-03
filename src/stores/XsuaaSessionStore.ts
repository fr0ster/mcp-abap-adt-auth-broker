/**
 * XSUAA Session Store - stores simplified session data for XSUAA service connections
 * 
 * Stores to {destination}.env files with BTP_* variables:
 * - BTP_URL or BTP_MCP_URL: MCP server URL (from mcpUrl, optional)
 * - BTP_JWT_TOKEN: JWT token for Authorization: Bearer header
 * - BTP_REFRESH_TOKEN: Optional refresh token for token renewal
 * - BTP_UAA_URL: UAA URL for token refresh
 * - BTP_UAA_CLIENT_ID: UAA client ID
 * - BTP_UAA_CLIENT_SECRET: UAA client secret
 * 
 * Note: Uses BTP_* variables instead of SAP_* to distinguish BTP/XSUAA from ABAP.
 */

import { BtpSessionConfig } from '../types';
import { AbstractSessionStore } from './AbstractSessionStore';
import { ISessionStore } from './interfaces';
import { loadBtpEnvFile } from '../btpEnvLoader';
import { saveBtpTokenToEnv } from '../btpTokenStorage';
import * as path from 'path';

/**
 * XSUAA Session Store implementation
 * 
 * Stores session data in {destination}.env files (same format as ABAP).
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class XsuaaSessionStore extends AbstractSessionStore implements ISessionStore {
  /**
   * Get file name for destination
   * @param destination Destination name
   * @returns File name (e.g., "mcp.env")
   */
  protected getFileName(destination: string): string {
    return `${destination}.env`;
  }

  /**
   * Load session from file
   * @param filePath Path to session file
   * @returns Parsed BtpSessionConfig or null if invalid
   */
  protected async loadFromFile(filePath: string): Promise<BtpSessionConfig | null> {
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
  protected async saveToFile(filePath: string, config: BtpSessionConfig | any): Promise<void> {
    // Type guard - ensure it's BtpSessionConfig, not EnvConfig (ABAP)
    if (!config || typeof config !== 'object') {
      throw new Error('XsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }
    
    // Reject ABAP sessions (EnvConfig has sapUrl, BtpSessionConfig doesn't)
    if ('sapUrl' in config) {
      throw new Error('XsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }
    
    // Ensure it has jwtToken (required for BtpSessionConfig)
    if (!('jwtToken' in config)) {
      throw new Error('XsuaaSessionStore can only store BtpSessionConfig (XSUAA) sessions');
    }

    // Validate required fields
    if (!config.jwtToken) {
      throw new Error('XSUAA session config missing required field: jwtToken');
    }
    // mcpUrl is optional - it's not part of authentication, only needed for making requests

    // Extract destination from file path
    const fileName = path.basename(filePath);
    const destination = fileName.replace(/\.env$/, '');
    const savePath = path.dirname(filePath);

    // Save using BTP token storage (writes BTP_* variables)
    await saveBtpTokenToEnv(destination, savePath, config);
  }
}
