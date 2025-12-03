/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { validateToken } from './auth/tokenValidator';
import { getCachedToken, setCachedToken, clearCache, clearAllCache } from './utils/cache';
import { Logger, defaultLogger } from './utils/logger';
import { IServiceKeyStore, ISessionStore, IAuthorizationConfig, IConnectionConfig } from './stores/interfaces';
import { AbapServiceKeyStore, AbapSessionStore } from './stores';
import { ITokenProvider, XsuaaTokenProvider, BtpTokenProvider } from './providers';

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private browser: string | undefined;
  private logger: Logger;
  private serviceKeyStore: IServiceKeyStore;
  private sessionStore: ISessionStore;
  private tokenProvider: ITokenProvider;

  /**
   * Create a new AuthBroker instance
   * @param stores Object with stores and token provider
   *               - serviceKeyStore: Store for service keys
   *               - sessionStore: Store for session data
   *               - tokenProvider: Token provider (XsuaaTokenProvider or BtpTokenProvider)
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance. If not provided, uses default logger.
   */
  constructor(
    stores: { serviceKeyStore: IServiceKeyStore; sessionStore: ISessionStore; tokenProvider: ITokenProvider },
    browser?: string,
    logger?: Logger
  ) {
    this.serviceKeyStore = stores.serviceKeyStore;
    this.sessionStore = stores.sessionStore;
    this.tokenProvider = stores.tokenProvider;
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
      // Try to validate cached token if we have connection config
      const connConfig = await this.sessionStore.getConnectionConfig(destination);
      if (connConfig?.serviceUrl) {
        const isValid = await validateToken(cachedToken, connConfig.serviceUrl);
        if (isValid) {
          return cachedToken;
        }
      } else {
        // No service URL - just return cached token (can't validate)
        return cachedToken;
      }
    }

    // Load connection config from session store
    const connConfig = await this.sessionStore.getConnectionConfig(destination);
    if (connConfig?.authorizationToken) {
      // Validate token if we have service URL
      if (connConfig.serviceUrl) {
        const isValid = await validateToken(connConfig.authorizationToken, connConfig.serviceUrl);
        if (isValid) {
          setCachedToken(destination, connConfig.authorizationToken);
          return connConfig.authorizationToken;
        }
      } else {
        // No service URL - just return token (can't validate)
        setCachedToken(destination, connConfig.authorizationToken);
        return connConfig.authorizationToken;
      }
    }

    // Token not found or expired, check if we have service key
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      // No service key and no valid token
      throw new Error(
        `No authentication found for destination "${destination}". ` +
        `No session data and no service key found.`
      );
    }

    // Get authorization config from service key
    const authConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
    }

    // Load existing session for refresh token
    const sessionConfig = await this.sessionStore.loadSession(destination);
    const existingConnConfig = await this.sessionStore.getConnectionConfig(destination);
    
    // Get connection config from service key
    const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
    
    // Get refresh token from session and merge with auth config
    const sessionObj = sessionConfig && typeof sessionConfig === 'object' ? sessionConfig as { refreshToken?: string } : null;
    const refreshToken = sessionObj?.refreshToken || authConfig.refreshToken;
    const authConfigWithRefresh = { ...authConfig, refreshToken };

    // Get connection config with token from provider
    const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
      browser: this.browser,
      logger: this.logger,
    });
    const connConfigWithToken = tokenResult.connectionConfig;

    // Update or create session with new token
    const currentSession = await this.sessionStore.loadSession(destination);
    if (currentSession && typeof currentSession === 'object') {
      // Session exists - update it
      if (existingConnConfig) {
        await this.sessionStore.setConnectionConfig(destination, {
          ...existingConnConfig,
          authorizationToken: connConfigWithToken.authorizationToken,
        });
      } else {
        await this.sessionStore.setConnectionConfig(destination, {
          ...connConfigWithToken,
          serviceUrl: serviceKeyConnConfig?.serviceUrl || connConfigWithToken.serviceUrl,
          sapClient: serviceKeyConnConfig?.sapClient || connConfigWithToken.sapClient,
          language: serviceKeyConnConfig?.language || connConfigWithToken.language,
        });
      }

      // Update authorization config with new refresh token if available
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...authConfig,
          refreshToken: tokenResult.refreshToken,
        });
      }
    } else {
      // No session exists - create new one using saveSession
      const newSession: Record<string, unknown> = {
        jwtToken: connConfigWithToken.authorizationToken,
        uaaUrl: authConfig.uaaUrl,
        uaaClientId: authConfig.uaaClientId,
        uaaClientSecret: authConfig.uaaClientSecret,
      };

      // Determine session type based on XSUAA detection
      const isXsuaa = 
        authConfig.uaaUrl.includes('authentication') &&
        serviceKeyConnConfig?.serviceUrl === undefined &&
        !existingConnConfig?.serviceUrl;

      if (isXsuaa) {
        // XSUAA session - mcpUrl is optional, not stored in .env
        if (serviceKeyConnConfig?.serviceUrl) {
          newSession.mcpUrl = serviceKeyConnConfig.serviceUrl;
        }
        // XSUAA doesn't provide refresh token
      } else {
        // ABAP/BTP session
        if (serviceKeyConnConfig?.serviceUrl) {
          // Check if it's BTP (has abapUrl) or ABAP (has sapUrl)
          const serviceKeyObj = serviceKey as { abap?: { url?: string } };
          if (serviceKeyObj.abap?.url) {
            newSession.abapUrl = serviceKeyConnConfig.serviceUrl;
          } else {
            newSession.sapUrl = serviceKeyConnConfig.serviceUrl;
          }
        }
        if (serviceKeyConnConfig?.sapClient) {
          newSession.sapClient = serviceKeyConnConfig.sapClient;
        }
        if (serviceKeyConnConfig?.language) {
          newSession.language = serviceKeyConnConfig.language;
        }
        // Refresh token comes from provider (BtpTokenProvider)
        if (tokenResult.refreshToken) {
          newSession.refreshToken = tokenResult.refreshToken;
        }
      }

      await this.sessionStore.saveSession(destination, newSession);
    }

    // Update cache with new token
    setCachedToken(destination, connConfigWithToken.authorizationToken);

    return connConfigWithToken.authorizationToken;
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
      throw new Error(
        `Service key not found for destination "${destination}".`
      );
    }

    // Get authorization config from service key
    const authConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
    }

    // Load existing session for refresh token
    const sessionConfig = await this.sessionStore.loadSession(destination);
    const existingConnConfig = await this.sessionStore.getConnectionConfig(destination);
    
    // Get connection config from service key
    const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
    
    // Get refresh token from session and merge with auth config
    const sessionObj = sessionConfig && typeof sessionConfig === 'object' ? sessionConfig as { refreshToken?: string } : null;
    const refreshToken = sessionObj?.refreshToken || authConfig.refreshToken;
    const authConfigWithRefresh = { ...authConfig, refreshToken };

    // Get connection config with token from provider
    const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
      browser: this.browser,
      logger: this.logger,
    });
    const connConfigWithToken = tokenResult.connectionConfig;

    // Update or create session with new token
    const currentSession = await this.sessionStore.loadSession(destination);
    if (currentSession && typeof currentSession === 'object') {
      // Session exists - update it
      if (existingConnConfig) {
        await this.sessionStore.setConnectionConfig(destination, {
          ...existingConnConfig,
          authorizationToken: connConfigWithToken.authorizationToken,
        });
      } else {
        await this.sessionStore.setConnectionConfig(destination, {
          ...connConfigWithToken,
          serviceUrl: serviceKeyConnConfig?.serviceUrl || connConfigWithToken.serviceUrl,
          sapClient: serviceKeyConnConfig?.sapClient || connConfigWithToken.sapClient,
          language: serviceKeyConnConfig?.language || connConfigWithToken.language,
        });
      }

      // Update authorization config with new refresh token if available
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...authConfig,
          refreshToken: tokenResult.refreshToken,
        });
      }
    } else {
      // No session exists - create new one using saveSession
      const newSession: Record<string, unknown> = {
        jwtToken: connConfigWithToken.authorizationToken,
        uaaUrl: authConfig.uaaUrl,
        uaaClientId: authConfig.uaaClientId,
        uaaClientSecret: authConfig.uaaClientSecret,
      };

      // Determine session type based on XSUAA detection
      const isXsuaa = 
        authConfig.uaaUrl.includes('authentication') &&
        serviceKeyConnConfig?.serviceUrl === undefined &&
        !existingConnConfig?.serviceUrl;

      if (isXsuaa) {
        // XSUAA session - mcpUrl is optional, not stored in .env
        if (serviceKeyConnConfig?.serviceUrl) {
          newSession.mcpUrl = serviceKeyConnConfig.serviceUrl;
        }
        // XSUAA doesn't provide refresh token
      } else {
        // ABAP/BTP session
        if (serviceKeyConnConfig?.serviceUrl) {
          // Check if it's BTP (has abapUrl) or ABAP (has sapUrl)
          const serviceKeyObj = serviceKey as { abap?: { url?: string } };
          if (serviceKeyObj.abap?.url) {
            newSession.abapUrl = serviceKeyConnConfig.serviceUrl;
          } else {
            newSession.sapUrl = serviceKeyConnConfig.serviceUrl;
          }
        }
        if (serviceKeyConnConfig?.sapClient) {
          newSession.sapClient = serviceKeyConnConfig.sapClient;
        }
        if (serviceKeyConnConfig?.language) {
          newSession.language = serviceKeyConnConfig.language;
        }
        // Refresh token comes from provider (BtpTokenProvider)
        if (tokenResult.refreshToken) {
          newSession.refreshToken = tokenResult.refreshToken;
        }
      }

      await this.sessionStore.saveSession(destination, newSession);
    }

    // Update cache with new token
    setCachedToken(destination, connConfigWithToken.authorizationToken);

    return connConfigWithToken.authorizationToken;
  }

  /**
   * Get authorization configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to IAuthorizationConfig or null if not found
   */
  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    // Try session store first (has tokens)
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    if (sessionAuthConfig) {
      return sessionAuthConfig;
    }
    
    // Fall back to service key store (has UAA credentials)
    return await this.serviceKeyStore.getAuthorizationConfig(destination);
  }

  /**
   * Get connection configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to IConnectionConfig or null if not found
   */
  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    // Try session store first (has tokens and URLs)
    const sessionConnConfig = await this.sessionStore.getConnectionConfig(destination);
    if (sessionConnConfig) {
      return sessionConnConfig;
    }
    
    // Fall back to service key store (has URLs but no tokens)
    return await this.serviceKeyStore.getConnectionConfig(destination);
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
