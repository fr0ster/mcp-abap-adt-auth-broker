/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { ILogger } from '@mcp-abap-adt/interfaces';
import { IServiceKeyStore, ISessionStore, IAuthorizationConfig, IConnectionConfig } from './stores/interfaces';
import { ITokenProvider } from './providers';

/**
 * No-op logger implementation for default fallback when logger is not provided
 */
const noOpLogger: ILogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private browser: string | undefined;
  private logger: ILogger;
  private serviceKeyStore: IServiceKeyStore;
  private sessionStore: ISessionStore;
  private tokenProvider: ITokenProvider;

  /**
   * Create a new AuthBroker instance
   * @param stores Object with stores and token provider
   *               - serviceKeyStore: Store for service keys
   *               - sessionStore: Store for session data
   *               - tokenProvider: Token provider implementing ITokenProvider interface
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance implementing ILogger interface. If not provided, uses no-op logger.
   */
  constructor(
    stores: { serviceKeyStore: IServiceKeyStore; sessionStore: ISessionStore; tokenProvider: ITokenProvider },
    browser?: string,
    logger?: ILogger
  ) {
    // Validate that stores and provider are provided and not null/undefined
    if (!stores) {
      throw new Error('AuthBroker: stores parameter is required');
    }
    if (!stores.serviceKeyStore) {
      throw new Error('AuthBroker: serviceKeyStore is required');
    }
    if (!stores.sessionStore) {
      throw new Error('AuthBroker: sessionStore is required');
    }
    if (!stores.tokenProvider) {
      throw new Error('AuthBroker: tokenProvider is required');
    }

    this.serviceKeyStore = stores.serviceKeyStore;
    this.sessionStore = stores.sessionStore;
    this.tokenProvider = stores.tokenProvider;
    this.browser = browser || 'system';
    this.logger = logger || noOpLogger;
  }

  /**
   * Get authentication token for destination.
   * Tries to load from session store, validates it, and refreshes if needed using a fallback chain.
   * 
   * **Fallback Chain:**
   * 1. **Check session**: Load token from session store and validate it
   *    - If token is valid, return it immediately
   *    - If token is invalid or missing, continue to next step
   * 
   * 2. **Check service key**: Verify that service key exists
   *    - If no service key found, throw error
   * 
   * 3. **Try refresh token**: If refresh token is available in session, attempt to refresh using it (via tokenProvider)
   *    - If successful, save new token to session and return it
   *    - If failed, continue to next step
   * 
   * 4. **Try UAA (client_credentials)**: Attempt to get token using UAA credentials (via tokenProvider)
   *    - If UAA parameters are available and authentication succeeds, save token to session and return it
   *    - If failed or parameters missing, continue to next step
   * 
   * 5. **Try browser authentication**: Attempt browser-based OAuth2 flow using service key (via tokenProvider)
   *    - If successful, save token and refresh token to session and return it
   *    - If failed, continue to next step
   * 
   * 6. **Throw error**: If all authentication methods failed, throw comprehensive error with details
   * 
   * **Note**: Token validation is performed only when checking existing session (step 1).
   * Tokens obtained through refresh/UAA/browser authentication are not validated before being saved.
   * 
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if neither session data nor service key found, or if all authentication methods failed
   */
  async getToken(destination: string): Promise<string> {
    // Step 1: Check if session exists and token is valid
    const connConfig = await this.sessionStore.getConnectionConfig(destination);
    if (connConfig?.authorizationToken) {
      // Validate token if provider supports validation and we have service URL
      if (this.tokenProvider.validateToken && connConfig.serviceUrl) {
        const isValid = await this.tokenProvider.validateToken(connConfig.authorizationToken, connConfig.serviceUrl);
        if (isValid) {
          return connConfig.authorizationToken;
        }
      } else {
        // No service URL or provider doesn't support validation - just return token
        return connConfig.authorizationToken;
      }
    }

    // Step 2: No valid session, check if we have service key
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

    // Get refresh token from session (if exists)
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    const refreshToken = sessionAuthConfig?.refreshToken || authConfig.refreshToken;

    let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
    let lastError: Error | null = null;

    // Step 3: Try to refresh using refresh token (if available) via tokenProvider
    if (refreshToken) {
      try {
        this.logger.debug(`Attempting to refresh token using refresh token for destination "${destination}"...`);
        const authConfigWithRefresh = { ...authConfig, refreshToken };
        tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
          browser: this.browser,
          logger: this.logger,
        });
        
        this.logger.debug(`Token refreshed successfully using refresh token for destination "${destination}"`);
        
        // Update session with new token
        await this.sessionStore.setConnectionConfig(destination, tokenResult.connectionConfig);
        if (tokenResult.refreshToken) {
          await this.sessionStore.setAuthorizationConfig(destination, {
            ...authConfig,
            refreshToken: tokenResult.refreshToken,
          });
        }
        
        return tokenResult.connectionConfig.authorizationToken;
      } catch (error: any) {
        lastError = error;
        this.logger.debug(`Token refresh failed for destination "${destination}": ${error.message}. Trying without refresh token...`);
        // Continue to next step
      }
    }

    // Step 4: Try UAA (client_credentials) via tokenProvider (without refresh token)
    // TokenProvider should try client_credentials if refresh token is not provided
    try {
      this.logger.debug(`Attempting to get token using UAA (client_credentials) for destination "${destination}"...`);
      const authConfigWithoutRefresh = { ...authConfig, refreshToken: undefined };
      tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithoutRefresh, {
        browser: this.browser,
        logger: this.logger,
      });
      
      this.logger.debug(`Token obtained successfully using UAA for destination "${destination}"`);
      
      // Update session with new token
      await this.sessionStore.setConnectionConfig(destination, tokenResult.connectionConfig);
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...authConfig,
          refreshToken: tokenResult.refreshToken,
        });
      }
      
      return tokenResult.connectionConfig.authorizationToken;
    } catch (error: any) {
      lastError = error;
      this.logger.debug(`UAA authentication failed for destination "${destination}": ${error.message}. Trying browser authentication...`);
      // Continue to next step
    }

    // Step 5: Try browser authentication via tokenProvider (should be last resort)
    // TokenProvider should use browser auth if refresh token and client_credentials don't work
    try {
      this.logger.debug(`Starting browser authentication flow for destination "${destination}"...`);
      const authConfigForBrowser = { ...authConfig, refreshToken: undefined };
      tokenResult = await this.tokenProvider.getConnectionConfig(authConfigForBrowser, {
        browser: this.browser,
        logger: this.logger,
      });
      
      this.logger.debug(`Token obtained successfully using browser authentication for destination "${destination}"`);
      
      // Update session with new token
      await this.sessionStore.setConnectionConfig(destination, tokenResult.connectionConfig);
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...authConfig,
          refreshToken: tokenResult.refreshToken,
        });
      }
      
      return tokenResult.connectionConfig.authorizationToken;
    } catch (error: any) {
      lastError = error;
      // Step 6: All methods failed - throw error
      const errorMessage = `All authentication methods failed for destination "${destination}". ` +
        `Refresh token: ${refreshToken ? 'failed' : 'not available'}. ` +
        `UAA: ${authConfig.uaaUrl && authConfig.uaaClientId && authConfig.uaaClientSecret ? 'failed' : 'parameters missing'}. ` +
        `Browser authentication: failed (${error.message})`;
      
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
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
      throw new Error(
        `Service key not found for destination "${destination}".`
      );
    }

    // Get authorization config from service key
    const authConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
    }

    // Get refresh token from session
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    const authConfigWithRefresh = { ...authConfig, refreshToken: sessionAuthConfig?.refreshToken || authConfig.refreshToken };

    // Get connection config with token from provider
    const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
      browser: this.browser,
      logger: this.logger,
    });

    // Update session with new token
    await this.sessionStore.setConnectionConfig(destination, tokenResult.connectionConfig);
    
    // Update authorization config with new refresh token if available
    if (tokenResult.refreshToken) {
      await this.sessionStore.setAuthorizationConfig(destination, {
        ...authConfig,
        refreshToken: tokenResult.refreshToken,
      });
    }

    return tokenResult.connectionConfig.authorizationToken;
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

}
