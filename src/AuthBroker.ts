/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { validateToken } from './tokenValidator';
import { refreshJwtToken } from './tokenRefresher';
import { startBrowserAuth } from './browserAuth';
import { getTokenWithClientCredentials } from './clientCredentialsAuth';
import { getCachedToken, setCachedToken, clearCache, clearAllCache } from './cache';
import { EnvConfig, BtpSessionConfig, ServiceKey } from './types';
import { Logger, defaultLogger } from './logger';
import { IServiceKeyStore, ISessionStore } from './stores/interfaces';
import { AbapServiceKeyStore, AbapSessionStore, XsuaaServiceKeyStore, XsuaaSessionStore } from './stores';
import * as path from 'path';

/**
 * Type guard to check if config is EnvConfig (ABAP)
 */
function isEnvConfig(config: EnvConfig | BtpSessionConfig | null): config is EnvConfig {
  return config !== null && 'sapUrl' in config;
}

/**
 * Type guard to check if config is BtpSessionConfig
 */
function isBtpSessionConfig(config: EnvConfig | BtpSessionConfig | null): config is BtpSessionConfig {
  // BtpSessionConfig has jwtToken (required) and optionally mcpUrl
  // EnvConfig has sapUrl (required) and jwtToken
  // Distinguish by checking for mcpUrl OR by absence of sapUrl
  return config !== null && ('mcpUrl' in config || (!('sapUrl' in config) && 'jwtToken' in config));
}

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private browser: string | undefined;
  private logger: Logger;
  private serviceKeyStore: IServiceKeyStore;
  private sessionStore: ISessionStore;

  /**
   * Create a new AuthBroker instance
   * @param stores Object with custom stores. If not provided, creates default file-based stores.
   *               - serviceKeyStore: Store for service keys (default: AbapServiceKeyStore)
   *               - sessionStore: Store for session data (default: AbapSessionStore)
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance. If not provided, uses default logger.
   */
  constructor(
    stores?: { serviceKeyStore?: IServiceKeyStore; sessionStore?: ISessionStore },
    browser?: string,
    logger?: Logger
  ) {
    this.serviceKeyStore = stores?.serviceKeyStore || new AbapServiceKeyStore();
    this.sessionStore = stores?.sessionStore || new AbapSessionStore();
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
      const sessionConfig = await this.sessionStore.loadSession(destination);
      if (isEnvConfig(sessionConfig)) {
        const isValid = await validateToken(cachedToken, sessionConfig.sapUrl);
        if (isValid) {
          return cachedToken;
        }
        // Token expired, remove from cache
      } else if (isBtpSessionConfig(sessionConfig)) {
        // For BTP, we can't validate token without making a request
        // Just return cached token if it exists
        return cachedToken;
      }
    }

    // Load from session store
    const sessionConfig = await this.sessionStore.loadSession(destination);
    if (isEnvConfig(sessionConfig) && sessionConfig.jwtToken) {
      // Validate token
      const isValid = await validateToken(sessionConfig.jwtToken, sessionConfig.sapUrl);
      if (isValid) {
        setCachedToken(destination, sessionConfig.jwtToken);
        return sessionConfig.jwtToken;
      }
    } else if (isBtpSessionConfig(sessionConfig) && sessionConfig.jwtToken) {
      // For BTP, just return the token (no validation)
      setCachedToken(destination, sessionConfig.jwtToken);
      return sessionConfig.jwtToken;
    }

    // Token not found or expired, check if we have service key for browser auth
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      // No service key and no valid token - throw error with helpful message
      const { sessionPaths, serviceKeyPaths } = this.getSearchedFilePaths(destination);
      const sessionFilesList = sessionPaths.length > 0
        ? `\nSearched for session files:\n${sessionPaths.map(p => `  - ${p}`).join('\n')}`
        : '';
      const serviceKeyFilesList = serviceKeyPaths.length > 0
        ? `\nSearched for service key files:\n${serviceKeyPaths.map(p => `  - ${p}`).join('\n')}`
        : '';
      throw new Error(
        `No authentication found for destination "${destination}".${sessionFilesList}${serviceKeyFilesList}`
      );
    }

    // Try to refresh (will use browser auth if no refresh token)
    // refreshTokenInternal works with any service key that has UAA credentials
    // Check if we have a session config (ABAP or XSUAA)
    const loadedSessionConfig = await this.sessionStore.loadSession(destination);
    
    // If we have a service key with UAA credentials, we can use refreshTokenInternal
    // Service key always has UAA credentials (either ABAP or XSUAA format)
    if (isEnvConfig(loadedSessionConfig)) {
      // ABAP session - use refreshTokenInternal with EnvConfig
      const newToken = await this.refreshTokenInternal(destination, serviceKey, loadedSessionConfig);
      setCachedToken(destination, newToken);
      return newToken;
    } else if (isBtpSessionConfig(loadedSessionConfig)) {
      // XSUAA session - use refreshTokenInternal with isXsuaa = true
      // mcpUrl is optional - not needed for authentication, only for making requests
      // Create temporary EnvConfig for refreshTokenInternal (mcpUrl optional)
      const tempEnvConfig: EnvConfig | null = loadedSessionConfig.mcpUrl ? {
        sapUrl: loadedSessionConfig.mcpUrl, // Use mcpUrl as sapUrl if present
        jwtToken: loadedSessionConfig.jwtToken,
        refreshToken: loadedSessionConfig.refreshToken,
        uaaUrl: serviceKey.uaa.url,
        uaaClientId: serviceKey.uaa.clientid,
        uaaClientSecret: serviceKey.uaa.clientsecret,
      } : null; // No mcpUrl - pass null, refreshTokenInternal will use placeholder
      
      const newToken = await this.refreshTokenInternal(destination, serviceKey, tempEnvConfig, true); // isXsuaa = true
      setCachedToken(destination, newToken);
      
      // Update XSUAA session with new token
      // XsuaaSessionStore will save to .env file with UAA credentials
      await this.sessionStore.saveSession(destination, {
        mcpUrl: loadedSessionConfig.mcpUrl,
        jwtToken: newToken,
        refreshToken: tempEnvConfig?.refreshToken || loadedSessionConfig.refreshToken,
        uaaUrl: serviceKey.uaa.url,
        uaaClientId: serviceKey.uaa.clientid,
        uaaClientSecret: serviceKey.uaa.clientsecret,
      });
      
      return newToken;
    } else {
      // No session config - create new one from service key
      // Determine if this is XSUAA (serviceKey.url is UAA URL) or ABAP
      const isXsuaa = serviceKey.url && serviceKey.url.includes('authentication');
      
      if (isXsuaa) {
        // For XSUAA: service key only provides UAA credentials for authentication to BTP service
        // MCP URL must be provided separately (from YAML config, parameter, or request header)
        // For token refresh, we only need UAA credentials, not MCP URL
        const newToken = await this.refreshTokenInternal(destination, serviceKey, null, true);
        setCachedToken(destination, newToken);
        
        // For XSUAA: don't save session if mcpUrl is not known
        // mcpUrl should be provided from configuration (e.g., btp_url from YAML) or request
        // Session will be saved when mcpUrl is provided
        // For now, just return token - session will be saved later when mcpUrl is known
        
        return newToken;
      } else {
        // For ABAP: serviceKey.url might be SAP URL, but prefer abap.url or sap_url
        const sapUrl = serviceKey.abap?.url || serviceKey.sap_url || (serviceKey.url && !serviceKey.url.includes('authentication') ? serviceKey.url : undefined);
        if (!sapUrl) {
          throw new Error(
            `Service key for destination "${destination}" does not contain SAP URL. ` +
            `Expected field: abap.url or sap_url`
          );
        }
        
        // Use refreshTokenInternal with null config (will trigger browser auth)
        const newToken = await this.refreshTokenInternal(destination, serviceKey, null, false);
        setCachedToken(destination, newToken);
        
        // For ABAP: save session to .env file via AbapSessionStore
        await this.sessionStore.saveSession(destination, {
          sapUrl: sapUrl,
          jwtToken: newToken,
          uaaUrl: serviceKey.uaa.url,
          uaaClientId: serviceKey.uaa.clientid,
          uaaClientSecret: serviceKey.uaa.clientsecret,
        });
        
        return newToken;
      }
    }
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
      const { serviceKeyPaths } = this.getSearchedFilePaths(destination);
      const serviceKeyFilesList = serviceKeyPaths.length > 0
        ? `\nSearched for service key files:\n${serviceKeyPaths.map(p => `  - ${p}`).join('\n')}`
        : '';
      throw new Error(
        `Service key file not found for destination "${destination}".${serviceKeyFilesList}`
      );
    }

    // Load existing session (for refresh token)
    const sessionConfig = await this.sessionStore.loadSession(destination);
    
      // refreshTokenInternal can work with any service key that has UAA credentials
      // If we have XSUAA session, use it (mcpUrl is optional - not needed for authentication)
      if (isBtpSessionConfig(sessionConfig)) {
        // For XSUAA: service key only provides UAA credentials
        // mcpUrl is optional - not part of authentication, only needed for making requests
        // Create temporary EnvConfig for refreshTokenInternal (mcpUrl optional)
        const tempEnvConfig: EnvConfig | null = sessionConfig.mcpUrl ? {
          sapUrl: sessionConfig.mcpUrl, // Use mcpUrl as sapUrl if present
          jwtToken: sessionConfig.jwtToken,
          refreshToken: sessionConfig.refreshToken,
          uaaUrl: serviceKey.uaa.url,
          uaaClientId: serviceKey.uaa.clientid,
          uaaClientSecret: serviceKey.uaa.clientsecret,
        } : null; // No mcpUrl - pass null, refreshTokenInternal will use placeholder
        
        return this.refreshTokenInternal(destination, serviceKey, tempEnvConfig, true);
      }

      // For ABAP or no session, use as-is
      const isXsuaa = serviceKey.url && serviceKey.url.includes('authentication');
      return this.refreshTokenInternal(destination, serviceKey, isEnvConfig(sessionConfig) ? sessionConfig : null, !!isXsuaa);
  }

  /**
   * Internal refresh token implementation
   * @private
   */
  private async refreshTokenInternal(
    destination: string,
    serviceKey: ServiceKey,
    envConfig: EnvConfig | null,
    isXsuaa: boolean = false
  ): Promise<string> {
    // Extract UAA configuration
    const { url: uaaUrl, clientid: clientId, clientsecret: clientSecret } = serviceKey.uaa;
    if (!uaaUrl || !clientId || !clientSecret) {
      throw new Error(
        `Invalid service key for destination "${destination}". ` +
        `Missing required UAA fields: url, clientid, clientsecret`
      );
    }

    // For XSUAA: service key only provides UAA credentials, no SAP URL needed
    // MCP URL must be provided separately (from YAML config, parameter, or request header)
    // For ABAP: validate SAP URL early (before starting browser auth or refresh)
    let sapUrl: string | undefined;
    if (!isXsuaa) {
      // For ABAP: serviceKey.url might be SAP URL, but prefer abap.url or sap_url
      sapUrl = serviceKey.abap?.url || serviceKey.sap_url || (serviceKey.url && !serviceKey.url.includes('authentication') ? serviceKey.url : undefined);
      if (!sapUrl) {
        throw new Error(
          `Service key for destination "${destination}" does not contain SAP URL. ` +
          `Expected field: abap.url or sap_url`
        );
      }
    } else {
      // For XSUAA: get sapUrl from envConfig (which contains mcpUrl from session/config)
      // If not available, we can't proceed - MCP URL must be provided separately
      sapUrl = envConfig?.sapUrl;
      if (!sapUrl) {
        // For browser auth, we don't need SAP URL - only UAA credentials
        // But for token refresh, we need it from session/config
        sapUrl = 'https://placeholder.mcp.url'; // Will be set when MCP URL is known
      }
    }

    // Try to load existing refresh token from session store
    let refreshTokenValue: string | undefined = envConfig?.refreshToken;

    let result: { accessToken: string; refreshToken?: string };

    // For XSUAA: use client_credentials grant type (no browser, no refresh token needed)
    if (isXsuaa) {
      this.logger.debug(`Using client_credentials grant type for XSUAA destination "${destination}"...`);
      const clientCredentialsResult = await getTokenWithClientCredentials(uaaUrl, clientId, clientSecret);
      result = {
        accessToken: clientCredentialsResult.accessToken,
        // XSUAA client_credentials doesn't provide refresh token
      };
    } else if (!refreshTokenValue) {
      // For ABAP: if no refresh token, start browser authentication flow
      this.logger.debug(`No refresh token found for destination "${destination}". Starting browser authentication...`);
      result = await startBrowserAuth(serviceKey, this.browser || 'system', this.logger);
    } else {
      // For ABAP: refresh token using refresh token
      result = await refreshJwtToken(refreshTokenValue, uaaUrl, clientId, clientSecret);
    }

    // Save new token to session store
    if (isXsuaa) {
      // For XSUAA: save as BtpSessionConfig
      // mcpUrl is optional - it's not part of authentication, only needed for making requests
      // Save session even without mcpUrl (tokens and UAA credentials are what matter)
      await this.sessionStore.saveSession(destination, {
        mcpUrl: sapUrl && sapUrl !== 'https://placeholder.mcp.url' ? sapUrl : undefined,
        jwtToken: result.accessToken,
        refreshToken: result.refreshToken || refreshTokenValue,
        uaaUrl,
        uaaClientId: clientId,
        uaaClientSecret: clientSecret,
      });
    } else {
      // For ABAP: save as EnvConfig with sapUrl
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
    }

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
    const sessionConfig = await this.sessionStore.loadSession(destination);
    if (isEnvConfig(sessionConfig) && sessionConfig.sapUrl) {
      return sessionConfig.sapUrl;
    }
    if (isBtpSessionConfig(sessionConfig) && sessionConfig.mcpUrl) {
      return sessionConfig.mcpUrl;
    }

    // Try service key store
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (serviceKey) {
      // For XSUAA: service key only provides UAA credentials for authentication to BTP service
      // MCP URL is NOT in service key - it must come from session, YAML config, parameter, or request header
      const isXsuaa = serviceKey.url && serviceKey.url.includes('authentication');
      if (isXsuaa) {
        // For XSUAA, URL should come from session or configuration, not service key
        // Service key contains only UAA credentials
        return undefined;
      }
      // For ABAP: serviceKey.url might be SAP URL, but prefer abap.url or sap_url
      return serviceKey.abap?.url || serviceKey.sap_url || (serviceKey.url && !serviceKey.url.includes('authentication') ? serviceKey.url : undefined);
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
   * Get searched file paths for error messages (shows actual file paths that were checked)
   * @private
   */
  private getSearchedFilePaths(destination: string): { sessionPaths: string[]; serviceKeyPaths: string[] } {
    const sessionPaths: string[] = [];
    const serviceKeyPaths: string[] = [];

    // Get session file paths that were searched
    if (this.sessionStore instanceof AbapSessionStore || this.sessionStore instanceof XsuaaSessionStore) {
      const searchPaths = this.sessionStore.getSearchPaths();
      const fileName = this.sessionStore instanceof AbapSessionStore 
        ? `${destination}.env`
        : `${destination}.env`; // Both use .env now
      searchPaths.forEach(searchPath => {
        sessionPaths.push(path.join(searchPath, fileName));
      });
    }

    // Get service key file paths that were searched
    if (this.serviceKeyStore instanceof AbapServiceKeyStore || this.serviceKeyStore instanceof XsuaaServiceKeyStore) {
      const searchPaths = this.serviceKeyStore.getSearchPaths();
      const fileName = `${destination}.json`;
      searchPaths.forEach(searchPath => {
        serviceKeyPaths.push(path.join(searchPath, fileName));
      });
    }

    return { sessionPaths, serviceKeyPaths };
  }
}
