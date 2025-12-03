/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { Logger, defaultLogger } from '@mcp-abap-adt/logger';
import { IServiceKeyStore, ISessionStore, IAuthorizationConfig, IConnectionConfig } from './stores/interfaces';
import { ITokenProvider } from './providers';

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
   *               - tokenProvider: Token provider implementing ITokenProvider interface
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
    // Load connection config from session store
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
