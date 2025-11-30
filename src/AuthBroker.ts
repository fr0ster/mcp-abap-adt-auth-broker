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

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private searchPaths: string[];
  private browser: string | undefined;

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
   */
  constructor(searchPaths?: string | string[], browser?: string) {
    this.searchPaths = resolveSearchPaths(searchPaths);
    this.browser = browser || 'system';
  }

  /**
   * Get authentication token for destination.
   * Tries to load from .env file, validates it, and refreshes if needed.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if neither .env file nor service key found
   */
  async getToken(destination: string): Promise<string> {
    // Check cache first
    const cachedToken = getCachedToken(destination);
    if (cachedToken) {
      // Validate cached token
      const envConfig = await loadEnvFile(destination, this.searchPaths);
      if (envConfig) {
        const isValid = await validateToken(cachedToken, envConfig.sapUrl);
        if (isValid) {
          return cachedToken;
        }
        // Token expired, remove from cache
      }
    }

    // Load from .env file
    const envConfig = await loadEnvFile(destination, this.searchPaths);
    if (envConfig && envConfig.jwtToken) {
      // Validate token
      const isValid = await validateToken(envConfig.jwtToken, envConfig.sapUrl);
      if (isValid) {
        setCachedToken(destination, envConfig.jwtToken);
        return envConfig.jwtToken;
      }
    }

    // Token not found or expired, check if we have service key for browser auth
    const serviceKey = await loadServiceKey(destination, this.searchPaths);
    if (!serviceKey) {
      // No service key and no valid token - throw error
      const searchedPaths = this.searchPaths.map(p => `  - ${p}`).join('\n');
      const firstPath = this.searchPaths[0];
      throw new Error(
        `No authentication found for destination "${destination}".\n` +
        `Neither ${destination}.env file nor ${destination}.json service key found.\n` +
        `Please create one of:\n` +
        `  - ${firstPath}/${destination}.env (with SAP_JWT_TOKEN)\n` +
        `  - ${firstPath}/${destination}.json (service key)\n` +
        `Searched in:\n${searchedPaths}`
      );
    }

    // Try to refresh (will use browser auth if no refresh token)
    const newToken = await this.refreshToken(destination);
    setCachedToken(destination, newToken);
    return newToken;
  }

  /**
   * Force refresh token for destination using service key.
   * If no refresh token exists, starts browser authentication flow.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to new JWT token string
   */
  async refreshToken(destination: string): Promise<string> {
    // Load service key
    const serviceKey = await loadServiceKey(destination, this.searchPaths);
    if (!serviceKey) {
      const searchedPaths = this.searchPaths.map(p => `  - ${p}`).join('\n');
      const firstPath = this.searchPaths[0];
      throw new Error(
        `Service key file not found for destination "${destination}".\n` +
        `Please create file: ${firstPath}/${destination}.json\n` +
        `Searched in:\n${searchedPaths}`
      );
    }

    // Extract UAA configuration
    const { url: uaaUrl, clientid: clientId, clientsecret: clientSecret } = serviceKey.uaa;
    if (!uaaUrl || !clientId || !clientSecret) {
      throw new Error(
        `Invalid service key for destination "${destination}". ` +
        `Missing required UAA fields: url, clientid, clientsecret`
      );
    }

    // Try to load existing refresh token from .env file
    const envConfig = await loadEnvFile(destination, this.searchPaths);
    let refreshTokenValue: string | undefined = envConfig?.refreshToken;

    let result: { accessToken: string; refreshToken?: string };

    // If no refresh token, start browser authentication flow
    if (!refreshTokenValue) {
      const browserMsg = this.browser && this.browser !== 'none' 
        ? 'Browser will open automatically.' 
        : 'Please open browser manually.';
      console.log(`🌐 No refresh token for "${destination}". Starting browser auth. ${browserMsg}`);
      result = await startBrowserAuth(serviceKey, this.browser);
    } else {
      // Refresh token using refresh token
      result = await refreshJwtToken(refreshTokenValue, uaaUrl, clientId, clientSecret);
    }

    // Extract SAP URL from service key
    const sapUrl = serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
    if (!sapUrl) {
      throw new Error(
        `Service key for destination "${destination}" does not contain SAP URL. ` +
        `Expected field: url, abap.url, or sap_url`
      );
    }

    // Extract optional fields from service key
    const abapClient = serviceKey.client || serviceKey.abap?.client || serviceKey.sap_client;
    const language = serviceKey.language || serviceKey.abap?.language;

    // Save to first search path (highest priority)
    const savePath = this.searchPaths[0];
    await this.saveTokenToEnv(destination, savePath, {
      sapUrl,
      jwtToken: result.accessToken,
      refreshToken: result.refreshToken || refreshTokenValue,
      uaaUrl,
      uaaClientId: clientId,
      uaaClientSecret: clientSecret,
      sapClient: abapClient,
      language: language,
    });

    // Update cache with new token
    setCachedToken(destination, result.accessToken);

    return result.accessToken;
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
