/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { validateToken } from './tokenValidator';
import { refreshJwtToken } from './tokenRefresher';
import { startBrowserAuth } from './browserAuth';
import { getCachedToken, setCachedToken, clearCache, clearAllCache } from './cache';
import { resolveSearchPaths } from './pathResolver';
import { EnvConfig, ServiceKey } from './types';
import { Logger, defaultLogger } from './logger';
import { ServiceKeyStore, SessionStore } from './stores/interfaces';
import { FileServiceKeyStore, FileSessionStore } from './stores';

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private searchPaths: string[];
  private browser: string | undefined;
  private logger: Logger;
  private serviceKeyStore: ServiceKeyStore;
  private sessionStore: SessionStore;

  /**
   * Create a new AuthBroker instance
   * @param searchPathsOrStores Optional search paths for .env and .json files (backward compatibility),
   *                            OR object with custom stores.
   *                            If string/array: creates default file-based stores with these paths.
   *                            If object: uses provided stores (searchPaths ignored).
   *                            Priority for searchPaths:
   *                            1. Constructor parameter (highest)
   *                            2. AUTH_BROKER_PATH environment variable (colon/semicolon-separated)
   *                            3. Current working directory (lowest)
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance. If not provided, uses default logger.
   */
  constructor(
    searchPathsOrStores?: string | string[] | { serviceKeyStore?: ServiceKeyStore; sessionStore?: SessionStore },
    browser?: string,
    logger?: Logger
  ) {
    // Handle backward compatibility: if first param is string/array, treat as searchPaths
    if (typeof searchPathsOrStores === 'string' || Array.isArray(searchPathsOrStores) || searchPathsOrStores === undefined) {
      this.searchPaths = resolveSearchPaths(searchPathsOrStores);
      // Create default file-based stores
      this.serviceKeyStore = new FileServiceKeyStore(this.searchPaths);
      this.sessionStore = new FileSessionStore(this.searchPaths);
    } else {
      // New API: stores provided
      this.searchPaths = resolveSearchPaths(undefined); // Still resolve for backward compatibility in internal functions
      this.serviceKeyStore = searchPathsOrStores.serviceKeyStore || new FileServiceKeyStore();
      this.sessionStore = searchPathsOrStores.sessionStore || new FileSessionStore();
    }
    
    this.browser = browser || 'system';
    this.logger = logger || defaultLogger;
  }

  /**
   * Get authentication token for destination.
   * Tries to load from session store, validates it, and refreshes if needed.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if neither session data nor service key found
   */
  async getToken(destination: string): Promise<string> {
    // Check cache first
    const cachedToken = getCachedToken(destination);
    if (cachedToken) {
      // Validate cached token
      const envConfig = await this.sessionStore.loadSession(destination);
      if (envConfig) {
        const isValid = await validateToken(cachedToken, envConfig.sapUrl);
        if (isValid) {
          return cachedToken;
        }
        // Token expired, remove from cache
      }
    }

    // Load from session store
    const envConfig = await this.sessionStore.loadSession(destination);
    if (envConfig && envConfig.jwtToken) {
      // Validate token
      const isValid = await validateToken(envConfig.jwtToken, envConfig.sapUrl);
      if (isValid) {
        setCachedToken(destination, envConfig.jwtToken);
        return envConfig.jwtToken;
      }
    }

    // Token not found or expired, check if we have service key for browser auth
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      // No service key and no valid token - throw error with helpful message
      const searchPaths = this.getSearchPathsForError();
      const searchedPaths = searchPaths.map(p => `  - ${p}`).join('\n');
      throw new Error(
        `No authentication found for destination "${destination}". ` +
        `Neither ${destination}.env file nor ${destination}.json service key found.\n` +
        `Please create one of:\n` +
        `  - ${destination}.env (with SAP_JWT_TOKEN)\n` +
        `  - ${destination}.json (service key)\n` +
        `Searched in:\n${searchedPaths}`
      );
    }

    // Try to refresh (will use browser auth if no refresh token)
    const newToken = await this.refreshTokenInternal(destination, serviceKey, envConfig);
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
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      const searchPaths = this.getSearchPathsForError();
      const searchedPaths = searchPaths.map(p => `  - ${p}`).join('\n');
      throw new Error(
        `Service key file not found for destination "${destination}".\n` +
        `Please create file: ${destination}.json\n` +
        `Searched in:\n${searchedPaths}`
      );
    }

    // Load existing session (for refresh token)
    const envConfig = await this.sessionStore.loadSession(destination);

    return this.refreshTokenInternal(destination, serviceKey, envConfig);
  }

  /**
   * Internal refresh token implementation
   * @private
   */
  private async refreshTokenInternal(
    destination: string,
    serviceKey: ServiceKey,
    envConfig: EnvConfig | null
  ): Promise<string> {
    // Extract UAA configuration
    const { url: uaaUrl, clientid: clientId, clientsecret: clientSecret } = serviceKey.uaa;
    if (!uaaUrl || !clientId || !clientSecret) {
      throw new Error(
        `Invalid service key for destination "${destination}". ` +
        `Missing required UAA fields: url, clientid, clientsecret`
      );
    }

    // Validate SAP URL early (before starting browser auth or refresh)
    const sapUrl = serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
    if (!sapUrl) {
      throw new Error(
        `Service key for destination "${destination}" does not contain SAP URL. ` +
        `Expected field: url, abap.url, or sap_url`
      );
    }

    // Try to load existing refresh token from session store
    let refreshTokenValue: string | undefined = envConfig?.refreshToken;

    let result: { accessToken: string; refreshToken?: string };

    // If no refresh token, start browser authentication flow
    if (!refreshTokenValue) {
      this.logger.debug(`No refresh token found for destination "${destination}". Starting browser authentication...`);
      result = await startBrowserAuth(serviceKey, this.browser || 'system', this.logger);
    } else {
      // Refresh token using refresh token
      result = await refreshJwtToken(refreshTokenValue, uaaUrl, clientId, clientSecret);
    }

    // Save new token to session store
    await this.sessionStore.saveSession(destination, {
      sapUrl,
      jwtToken: result.accessToken,
      refreshToken: result.refreshToken || refreshTokenValue,
      uaaUrl,
      uaaClientId: clientId,
      uaaClientSecret: clientSecret,
      sapClient: envConfig?.sapClient,
      language: envConfig?.language,
    });

    // Update cache with new token
    setCachedToken(destination, result.accessToken);

    return result.accessToken;
  }

  /**
   * Get SAP URL for destination.
   * Tries to load from session store first, then from service key store.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to SAP URL string, or undefined if not found
   */
  async getSapUrl(destination: string): Promise<string | undefined> {
    // Try to load from session store first
    const envConfig = await this.sessionStore.loadSession(destination);
    if (envConfig?.sapUrl) {
      return envConfig.sapUrl;
    }

    // Try service key store
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (serviceKey) {
      return serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
    }

    return undefined;
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

  /**
   * Get search paths for error messages (from file stores if available)
   * @private
   */
  private getSearchPathsForError(): string[] {
    // Try to get search paths from file stores
    if (this.serviceKeyStore instanceof FileServiceKeyStore) {
      return this.serviceKeyStore.getSearchPaths();
    }
    if (this.sessionStore instanceof FileSessionStore) {
      return this.sessionStore.getSearchPaths();
    }
    // Fallback to stored searchPaths (for backward compatibility)
    return this.searchPaths;
  }
}
