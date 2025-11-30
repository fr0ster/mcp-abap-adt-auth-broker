/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadEnvFile } from './envLoader';
import { loadServiceKey } from './serviceKeyLoader';
import { validateToken } from './tokenValidator';
import { refreshJwtToken } from './tokenRefresher';
import { startBrowserAuth } from './browserAuth';
import { getCachedToken, setCachedToken, clearCache, clearAllCache } from './cache';
import { resolveSearchPaths } from './pathResolver';
import { EnvConfig, ServiceKey } from './types';
import { Logger, defaultLogger } from './logger';
import { refreshToken as refreshTokenFunction } from './refreshToken';
import { getToken as getTokenFunction } from './getToken';

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private searchPaths: string[];
  private browser: string | undefined;
  private logger: Logger;

  /**
   * Create a new AuthBroker instance
   * @param searchPaths Optional search paths for .env and .json files.
   *                    Can be a single path (string) or array of paths.
   *                    Priority:
   *                    1. Constructor parameter (highest)
   *                    2. AUTH_BROKER_PATH environment variable (colon/semicolon-separated)
   *                    3. Current working directory (lowest)
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance. If not provided, uses default logger.
   */
  constructor(searchPaths?: string | string[], browser?: string, logger?: Logger) {
    this.searchPaths = resolveSearchPaths(searchPaths);
    this.browser = browser || 'system';
    this.logger = logger || defaultLogger;
  }

  /**
   * Get authentication token for destination.
   * Tries to load from .env file, validates it, and refreshes if needed.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if neither .env file nor service key found
   */
  async getToken(destination: string): Promise<string> {
    // Use getToken function with logger
    return getTokenFunction(destination, this.searchPaths, this.logger);
  }

  /**
   * Force refresh token for destination using service key.
   * If no refresh token exists, starts browser authentication flow.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to new JWT token string
   */
  async refreshToken(destination: string): Promise<string> {
    // Use refreshToken function with logger and browser
    return refreshTokenFunction(destination, this.searchPaths, this.logger);
  }

  /**
   * Get SAP URL for destination.
   * Tries to load from .env file first, then from service key.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to SAP URL string, or undefined if not found
   */
  async getSapUrl(destination: string): Promise<string | undefined> {
    // Try to load from .env file first
    const envConfig = await loadEnvFile(destination, this.searchPaths);
    if (envConfig?.sapUrl) {
      return envConfig.sapUrl;
    }

    // Try service key
    const serviceKey = await loadServiceKey(destination, this.searchPaths);
    if (serviceKey) {
      return serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
    }

    return undefined;
  }

  /**
   * Save token to {destination}.env file
   * Creates .env file similar to sap-abap-auth utility format
   * @private
   */
  private async saveTokenToEnv(
    destination: string,
    savePath: string,
    config: Partial<EnvConfig> & { sapUrl: string; jwtToken: string; language?: string }
  ): Promise<void> {
    // Ensure directory exists
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    const envFilePath = path.join(savePath, `${destination}.env`);
    const tempFilePath = `${envFilePath}.tmp`;

    // Write to temporary file first (atomic write)
    // Format similar to sap-abap-auth utility - always create fresh file
    const envLines: string[] = [];
    
    // Add token expiry information if we can decode JWT
    const jwtExpiry = this.getTokenExpiry(config.jwtToken);
    const refreshExpiry = config.refreshToken ? this.getTokenExpiry(config.refreshToken) : null;
    
    if (jwtExpiry || refreshExpiry) {
      envLines.push('# Token Expiry Information (auto-generated)');
      if (jwtExpiry) {
        envLines.push(`# JWT Token expires: ${jwtExpiry.readableDate} (UTC)`);
        envLines.push(`# JWT Token expires at: ${jwtExpiry.dateString}`);
      } else {
        envLines.push('# JWT Token expiry: Unable to determine (token may not be a standard JWT)');
      }
      if (refreshExpiry) {
        envLines.push(`# Refresh Token expires: ${refreshExpiry.readableDate} (UTC)`);
        envLines.push(`# Refresh Token expires at: ${refreshExpiry.dateString}`);
      } else if (config.refreshToken) {
        envLines.push('# Refresh Token expiry: Unable to determine (token may not be a standard JWT)');
      }
      envLines.push('');
    }
    
    // Write JWT auth parameters (similar to sap-abap-auth format)
    // Required fields
    envLines.push(`SAP_URL=${config.sapUrl}`);
    if (config.sapClient) {
      envLines.push(`SAP_CLIENT=${config.sapClient}`);
    }
    if (config.language) {
      envLines.push(`SAP_LANGUAGE=${config.language}`);
    }
    envLines.push('TLS_REJECT_UNAUTHORIZED=0');
    envLines.push('SAP_AUTH_TYPE=jwt');
    envLines.push(`SAP_JWT_TOKEN=${config.jwtToken}`);
    if (config.refreshToken) {
      envLines.push(`SAP_REFRESH_TOKEN=${config.refreshToken}`);
    }
    if (config.uaaUrl) {
      envLines.push(`SAP_UAA_URL=${config.uaaUrl}`);
    }
    if (config.uaaClientId) {
      envLines.push(`SAP_UAA_CLIENT_ID=${config.uaaClientId}`);
    }
    if (config.uaaClientSecret) {
      envLines.push(`SAP_UAA_CLIENT_SECRET=${config.uaaClientSecret}`);
    }
    
    envLines.push('');
    envLines.push('# For JWT authentication');
    envLines.push('# SAP_USERNAME=your_username');
    envLines.push('# SAP_PASSWORD=your_password');

    const envContent = envLines.join('\n') + '\n';

    // Write to temp file
    fs.writeFileSync(tempFilePath, envContent, 'utf8');

    // Atomic rename
    fs.renameSync(tempFilePath, envFilePath);
  }

  /**
   * Get token expiry information from JWT token
   * @private
   */
  private getTokenExpiry(token: string): { dateString: string; readableDate: string } | null {
    try {
      // JWT tokens have format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }

      // Decode payload (base64url)
      const payload = parts[1];
      // Add padding if needed
      const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
      const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);

      // Check for exp claim
      if (parsed.exp) {
        const expiryDate = new Date(parsed.exp * 1000);
        const readableDate = expiryDate.toLocaleString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: 'UTC',
          timeZoneName: 'short',
        });
        return {
          dateString: expiryDate.toISOString(),
          readableDate: readableDate,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clear cached token for specific destination
   * @param destination Destination name
   */
  clearCache(destination: string): void {
    clearCache(destination);
  }

  /**
   * Clear all cached tokens
   */
  clearAllCache(): void {
    clearAllCache();
  }
}
