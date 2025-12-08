/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { ILogger, IConfig } from '@mcp-abap-adt/interfaces';
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

    // Validate that stores and provider are correctly instantiated (have required methods)
    const serviceKeyStore = stores.serviceKeyStore;
    const sessionStore = stores.sessionStore;
    const tokenProvider = stores.tokenProvider;

    // Check serviceKeyStore methods
    if (typeof serviceKeyStore.getServiceKey !== 'function') {
      throw new Error('AuthBroker: serviceKeyStore.getServiceKey must be a function');
    }
    if (typeof serviceKeyStore.getAuthorizationConfig !== 'function') {
      throw new Error('AuthBroker: serviceKeyStore.getAuthorizationConfig must be a function');
    }
    if (typeof serviceKeyStore.getConnectionConfig !== 'function') {
      throw new Error('AuthBroker: serviceKeyStore.getConnectionConfig must be a function');
    }

    // Check sessionStore methods
    if (typeof sessionStore.getAuthorizationConfig !== 'function') {
      throw new Error('AuthBroker: sessionStore.getAuthorizationConfig must be a function');
    }
    if (typeof sessionStore.getConnectionConfig !== 'function') {
      throw new Error('AuthBroker: sessionStore.getConnectionConfig must be a function');
    }
    if (typeof sessionStore.setAuthorizationConfig !== 'function') {
      throw new Error('AuthBroker: sessionStore.setAuthorizationConfig must be a function');
    }
    if (typeof sessionStore.setConnectionConfig !== 'function') {
      throw new Error('AuthBroker: sessionStore.setConnectionConfig must be a function');
    }

    // Check tokenProvider methods
    if (typeof tokenProvider.getConnectionConfig !== 'function') {
      throw new Error('AuthBroker: tokenProvider.getConnectionConfig must be a function');
    }
    // validateToken is optional, so we don't check it

    this.serviceKeyStore = serviceKeyStore;
    this.sessionStore = sessionStore;
    this.tokenProvider = tokenProvider;
    this.browser = browser || 'system';
    this.logger = logger || noOpLogger;

    // Log successful initialization
    this.logger?.debug('AuthBroker initialized: serviceKeyStore(ok), sessionStore(ok), tokenProvider(ok)');
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
    this.logger?.debug(`Getting token for destination: ${destination}`);
    
    // Step 1: Check if session exists and token is valid
    const connConfig = await this.sessionStore.getConnectionConfig(destination);
    if (connConfig?.authorizationToken) {
      this.logger?.debug(`Session found: token(${connConfig.authorizationToken.length} chars), serviceUrl(${connConfig.serviceUrl ? 'yes' : 'no'})`);
      
      // Validate token if provider supports validation and we have service URL
      if (this.tokenProvider.validateToken && connConfig.serviceUrl) {
        this.logger?.debug(`Validating token for ${destination}`);
        const isValid = await this.tokenProvider.validateToken(connConfig.authorizationToken, connConfig.serviceUrl);
        if (isValid) {
          this.logger?.info(`Token valid for ${destination}: token(${connConfig.authorizationToken.length} chars)`);
          return connConfig.authorizationToken;
        }
        this.logger?.debug(`Token invalid for ${destination}, continuing to refresh`);
      } else {
        // No service URL or provider doesn't support validation - just return token
        this.logger?.info(`Token found for ${destination} (no validation): token(${connConfig.authorizationToken.length} chars)`);
        return connConfig.authorizationToken;
      }
    } else {
      this.logger?.debug(`No session found for ${destination}`);
    }

    // Step 2: No valid session, check if we have service key
    this.logger?.debug(`Checking service key for ${destination}`);
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      this.logger?.error(`No service key found for ${destination}`);
      throw new Error(
        `No authentication found for destination "${destination}". ` +
        `No session data and no service key found.`
      );
    }

    // Get authorization config from service key
    const authConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      this.logger?.error(`Service key for ${destination} missing UAA credentials`);
      throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
    }

    this.logger?.debug(`Service key loaded for ${destination}: uaaUrl(${authConfig.uaaUrl.substring(0, 40)}...)`);

    // Get refresh token from session (if exists)
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    const refreshToken = sessionAuthConfig?.refreshToken || authConfig.refreshToken;
    this.logger?.debug(`Refresh token check for ${destination}: hasRefreshToken(${!!refreshToken})`);

    let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
    let lastError: Error | null = null;

    // Step 3: Try to refresh using refresh token (if available) via tokenProvider
    if (refreshToken) {
      try {
        this.logger?.debug(`Trying refresh token flow for ${destination}`);
        const authConfigWithRefresh = { ...authConfig, refreshToken };
        tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
          browser: this.browser,
          logger: this.logger,
        });
        
      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Token refreshed for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);
      
      // Get serviceUrl from service key store if not in connectionConfig (required for ABAP stores)
      // For XSUAA service keys, serviceUrl may not exist, which is fine for BTP/XSUAA stores
      const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl,
      };
        
      // Update or create session with new token (stores handle creation if session doesn't exist)
      await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        if (tokenResult.refreshToken) {
          await this.sessionStore.setAuthorizationConfig(destination, {
            ...authConfig,
            refreshToken: tokenResult.refreshToken,
          });
        }
        
        return tokenResult.connectionConfig.authorizationToken;
      } catch (error: any) {
        lastError = error;
        this.logger?.debug(`Refresh token flow failed for ${destination}: ${error.message}, trying UAA`);
        // Continue to next step
      }
    }

    // Step 4: Try UAA (client_credentials) via tokenProvider (without refresh token)
    // TokenProvider should try client_credentials if refresh token is not provided
    try {
      this.logger?.debug(`Trying UAA (client_credentials) flow for ${destination}`);
      const authConfigWithoutRefresh = { ...authConfig, refreshToken: undefined };
      tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithoutRefresh, {
        browser: this.browser,
        logger: this.logger,
      });
      
      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Token obtained via UAA for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);
      
      // Get serviceUrl from service key store if not in connectionConfig (required for ABAP stores)
      // For XSUAA service keys, serviceUrl may not exist, which is fine for BTP/XSUAA stores
      const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl,
      };
      
      // Update or create session with new token (stores handle creation if session doesn't exist)
      await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...authConfig,
          refreshToken: tokenResult.refreshToken,
        });
      }
      
      return tokenResult.connectionConfig.authorizationToken;
    } catch (error: any) {
      lastError = error;
      this.logger?.debug(`UAA flow failed for ${destination}: ${error.message}, trying browser`);
      // Continue to next step
    }

    // Step 5: Try browser authentication via tokenProvider (should be last resort)
    // TokenProvider should use browser auth if refresh token and client_credentials don't work
    try {
      this.logger?.debug(`Trying browser authentication flow for ${destination}`);
      const authConfigForBrowser = { ...authConfig, refreshToken: undefined };
      tokenResult = await this.tokenProvider.getConnectionConfig(authConfigForBrowser, {
        browser: this.browser,
        logger: this.logger,
      });
      
      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Token obtained via browser for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);
      
      // Get serviceUrl from service key store if not in connectionConfig (required for ABAP stores)
      // For XSUAA service keys, serviceUrl may not exist, which is fine for BTP/XSUAA stores
      const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl,
      };
      
      // Update or create session with new token (stores handle creation if session doesn't exist)
      await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
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
      
      this.logger?.error(`All auth methods failed for ${destination}: refreshToken(${refreshToken ? 'failed' : 'none'}), UAA(${authConfig.uaaUrl && authConfig.uaaClientId && authConfig.uaaClientSecret ? 'failed' : 'missing'}), browser(failed: ${error.message})`);
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
    this.logger?.debug(`Force refreshing token for destination: ${destination}`);
    
    // Load service key
    const serviceKey = await this.serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      this.logger?.error(`Service key not found for ${destination}`);
      throw new Error(
        `Service key not found for destination "${destination}".`
      );
    }

    // Get authorization config from service key
    const authConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      this.logger?.error(`Service key for ${destination} missing UAA credentials`);
      throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
    }

    // Get refresh token from session
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    const refreshToken = sessionAuthConfig?.refreshToken || authConfig.refreshToken;
    this.logger?.debug(`Refresh token check for ${destination}: hasRefreshToken(${!!refreshToken})`);
    
    const authConfigWithRefresh = { ...authConfig, refreshToken };

    // Get connection config with token from provider
    const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
      browser: this.browser,
      logger: this.logger,
    });

    const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
    this.logger?.info(`Token refreshed for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

    // Get serviceUrl from service key store if not in connectionConfig (required for ABAP stores)
    // For XSUAA service keys, serviceUrl may not exist, which is fine for BTP/XSUAA stores
    const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...tokenResult.connectionConfig,
      serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl,
    };
    
    // Update or create session with new token (stores handle creation if session doesn't exist)
    await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
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
    this.logger?.debug(`Getting authorization config for ${destination}`);
    
    // Try session store first (has tokens)
    this.logger?.debug(`Checking session store for authorization config: ${destination}`);
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    if (sessionAuthConfig) {
      this.logger?.debug(`Authorization config from session for ${destination}: hasUaaUrl(${!!sessionAuthConfig.uaaUrl}), hasRefreshToken(${!!sessionAuthConfig.refreshToken})`);
      return sessionAuthConfig;
    }
    
    // Fall back to service key store (has UAA credentials)
    this.logger?.debug(`Checking service key store for authorization config: ${destination}`);
    const serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (serviceKeyAuthConfig) {
      this.logger?.debug(`Authorization config from service key for ${destination}: hasUaaUrl(${!!serviceKeyAuthConfig.uaaUrl})`);
    } else {
      this.logger?.debug(`No authorization config found for ${destination}`);
    }
    return serviceKeyAuthConfig;
  }

  /**
   * Get connection configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to IConnectionConfig or null if not found
   */
  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    this.logger?.debug(`Getting connection config for ${destination}`);
    
    // Try session store first (has tokens and URLs)
    const sessionConnConfig = await this.sessionStore.getConnectionConfig(destination);
    if (sessionConnConfig) {
      this.logger?.debug(`Connection config from session for ${destination}: token(${sessionConnConfig.authorizationToken?.length || 0} chars), serviceUrl(${sessionConnConfig.serviceUrl ? 'yes' : 'no'})`);
      return sessionConnConfig;
    }
    
    // Fall back to service key store (has URLs but no tokens)
    const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
    if (serviceKeyConnConfig) {
      this.logger?.debug(`Connection config from service key for ${destination}: serviceUrl(${serviceKeyConnConfig.serviceUrl ? 'yes' : 'no'}), token(none)`);
    } else {
      this.logger?.debug(`No connection config found for ${destination}`);
    }
    return serviceKeyConnConfig;
  }

}
