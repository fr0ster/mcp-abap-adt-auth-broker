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
 * Configuration object for AuthBroker constructor
 */
export interface AuthBrokerConfig {
  /** Session store (required) - stores and retrieves session data */
  sessionStore: ISessionStore;
  /** Service key store (optional) - stores and retrieves service keys */
  serviceKeyStore?: IServiceKeyStore;
  /** Token provider (required) - handles token refresh and authentication flows */
  tokenProvider: ITokenProvider;
}

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
export class AuthBroker {
  private browser: string | undefined;
  private logger: ILogger;
  private serviceKeyStore: IServiceKeyStore | undefined;
  private sessionStore: ISessionStore;
  private tokenProvider: ITokenProvider;

  /**
   * Create a new AuthBroker instance
   * @param config Configuration object with stores and token provider
   *               - sessionStore: Store for session data (required)
   *               - serviceKeyStore: Store for service keys (optional)
   *               - tokenProvider: Token provider implementing ITokenProvider interface (required)
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, none).
   *                Default: 'system' (system default browser).
   *                Use 'none' to print URL instead of opening browser.
   * @param logger Optional logger instance implementing ILogger interface. If not provided, uses no-op logger.
   */
  constructor(
    config: AuthBrokerConfig,
    browser?: string,
    logger?: ILogger
  ) {
    // Validate that config is provided
    if (!config) {
      throw new Error('AuthBroker: config parameter is required');
    }

    // Validate required sessionStore
    if (!config.sessionStore) {
      throw new Error('AuthBroker: sessionStore is required');
    }

    // Validate required tokenProvider
    if (!config.tokenProvider) {
      throw new Error('AuthBroker: tokenProvider is required');
    }

    // Validate that stores and provider are correctly instantiated (have required methods)
    const sessionStore = config.sessionStore;
    const tokenProvider = config.tokenProvider;
    const serviceKeyStore = config.serviceKeyStore;

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

    // Check serviceKeyStore methods (if provided)
    if (serviceKeyStore) {
      if (typeof serviceKeyStore.getServiceKey !== 'function') {
        throw new Error('AuthBroker: serviceKeyStore.getServiceKey must be a function');
      }
      if (typeof serviceKeyStore.getAuthorizationConfig !== 'function') {
        throw new Error('AuthBroker: serviceKeyStore.getAuthorizationConfig must be a function');
      }
      if (typeof serviceKeyStore.getConnectionConfig !== 'function') {
        throw new Error('AuthBroker: serviceKeyStore.getConnectionConfig must be a function');
      }
    }

    this.serviceKeyStore = serviceKeyStore;
    this.sessionStore = sessionStore;
    this.tokenProvider = tokenProvider;
    this.browser = browser || 'system';
    this.logger = logger || noOpLogger;

    // Log successful initialization
    const hasServiceKeyStore = !!this.serviceKeyStore;
    this.logger?.debug(`AuthBroker initialized: sessionStore(ok), serviceKeyStore(${hasServiceKeyStore ? 'ok' : 'none'}), tokenProvider(ok)`);
  }

  /**
   * Get authentication token for destination.
   * Implements a three-step flow: Step 0 (initialize), Step 1 (refresh), Step 2 (UAA).
   * 
   * **Flow:**
   * **Step 0: Initialize Session with Token (if needed)**
   * - Check if session has `authorizationToken` AND UAA credentials
   * - If both are empty AND serviceKeyStore and tokenProvider are available:
   *   - Initialize token/UAA from service key via provider
   * - If session has token OR UAA credentials → proceed to Step 1
   * 
   * **Step 1: Refresh Token Flow**
   * - Check if refresh token exists in session
   * - If refresh token exists and refresh succeeds → return new token
   * - Otherwise → proceed to Step 2
   * 
   * **Step 2: UAA Credentials Flow**
   * - Check if UAA credentials exist in session
   * - Try to obtain token using UAA
   * - If successful → return new token
   * - If failed → try service key (if available) → return error if all failed
   * 
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if session initialization fails or all authentication methods failed
   */
  async getToken(destination: string): Promise<string> {
    this.logger?.debug(`Getting token for destination: ${destination}`);
    
    // Step 0: Initialize Session with Token (if needed)
    const connConfig = await this.sessionStore.getConnectionConfig(destination);
    const authConfig = await this.sessionStore.getAuthorizationConfig(destination);
    
    // Check if session has serviceUrl (required)
    if (!connConfig?.serviceUrl) {
      this.logger?.error(`Session for destination "${destination}" is missing required field 'serviceUrl'. SessionStore must contain initial session with serviceUrl.`);
      throw new Error(
        `Session for destination "${destination}" is missing required field 'serviceUrl'. ` +
        `SessionStore must contain initial session with serviceUrl.`
      );
    }

    // Check if we have token or UAA credentials
    const hasToken = !!connConfig?.authorizationToken;
    const hasUaaCredentials = !!(authConfig?.uaaUrl && authConfig?.uaaClientId && authConfig?.uaaClientSecret);
    
    this.logger?.debug(`Step 0: Session check for ${destination}: hasToken(${hasToken}), hasUaaCredentials(${hasUaaCredentials}), serviceUrl(${connConfig.serviceUrl ? 'yes' : 'no'})`);

    // If token is empty AND UAA fields are empty, try to initialize from service key
    if (!hasToken && !hasUaaCredentials) {
      this.logger?.debug(`Step 0: Token and UAA credentials are empty for ${destination}, attempting initialization from service key`);
      
      if (!this.serviceKeyStore) {
        this.logger?.error(`Step 0: Cannot initialize session for ${destination}: authorizationToken is empty, UAA credentials are empty, and serviceKeyStore is not available`);
        throw new Error(
          `Cannot initialize session for destination "${destination}": authorizationToken is empty, UAA credentials are empty, and serviceKeyStore is not available. ` +
          `Provide serviceKeyStore and tokenProvider to initialize from service key.`
        );
      }

      try {
        // Get UAA credentials from service key
        const serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
        if (!serviceKeyAuthConfig) {
          this.logger?.error(`Step 0: Service key for ${destination} missing UAA credentials`);
          throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
        }

        this.logger?.debug(`Step 0: Authenticating via provider for ${destination} using service key UAA credentials`);
        
        // Authenticate via provider
        const tokenResult = await this.tokenProvider.getConnectionConfig(serviceKeyAuthConfig, {
          browser: this.browser,
          logger: this.logger,
        });

        const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
        this.logger?.info(`Step 0: Token initialized for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

        // Get serviceUrl from service key store if not in connectionConfig
        const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
        const connectionConfigWithServiceUrl: IConnectionConfig = {
          ...tokenResult.connectionConfig,
          serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl || connConfig.serviceUrl,
        };

        // Save token and UAA credentials to session
        await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...serviceKeyAuthConfig,
          refreshToken: tokenResult.refreshToken || serviceKeyAuthConfig.refreshToken,
        });

        return tokenResult.connectionConfig.authorizationToken!;
      } catch (error: any) {
        this.logger?.error(`Step 0: Failed to initialize session for ${destination}: ${error.message}`);
        throw new Error(
          `Cannot initialize session for destination "${destination}": ${error.message}. ` +
          `Ensure serviceKeyStore contains valid service key with UAA credentials.`
        );
      }
    }

    // If we have a token, validate it first
    if (hasToken && connConfig.authorizationToken) {
      this.logger?.debug(`Step 0: Token found for ${destination}, validating`);
      
      // Validate token if provider supports validation and we have service URL
      if (this.tokenProvider.validateToken && connConfig.serviceUrl) {
        const isValid = await this.tokenProvider.validateToken(connConfig.authorizationToken, connConfig.serviceUrl);
        if (isValid) {
          this.logger?.info(`Step 0: Token valid for ${destination}: token(${connConfig.authorizationToken.length} chars)`);
          return connConfig.authorizationToken;
        }
        this.logger?.debug(`Step 0: Token invalid for ${destination}, continuing to refresh`);
      } else {
        // No service URL or provider doesn't support validation - just return token
        this.logger?.info(`Step 0: Token found for ${destination} (no validation): token(${connConfig.authorizationToken.length} chars)`);
        return connConfig.authorizationToken;
      }
    }

    // Step 1: Refresh Token Flow
    this.logger?.debug(`Step 1: Checking refresh token for ${destination}`);
    const refreshToken = authConfig?.refreshToken;
    
    if (refreshToken) {
      try {
        this.logger?.debug(`Step 1: Trying refresh token flow for ${destination}`);
        
        // Get UAA credentials from session or service key
        const uaaCredentials = authConfig || (this.serviceKeyStore ? await this.serviceKeyStore.getAuthorizationConfig(destination) : null);
        if (!uaaCredentials) {
          throw new Error('UAA credentials not found in session and serviceKeyStore not available');
        }

        const authConfigWithRefresh = { ...uaaCredentials, refreshToken };
        const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
          browser: this.browser,
          logger: this.logger,
        });

        const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
        this.logger?.info(`Step 1: Token refreshed for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

        // Get serviceUrl from session or service key
        const serviceUrl = connConfig.serviceUrl || 
          (this.serviceKeyStore ? (await this.serviceKeyStore.getConnectionConfig(destination))?.serviceUrl : null) ||
          connConfig.serviceUrl;

        const connectionConfigWithServiceUrl: IConnectionConfig = {
          ...tokenResult.connectionConfig,
          serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceUrl,
        };

        // Update session with new token
        await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        if (tokenResult.refreshToken) {
          await this.sessionStore.setAuthorizationConfig(destination, {
            ...uaaCredentials,
            refreshToken: tokenResult.refreshToken,
          });
        }

        return tokenResult.connectionConfig.authorizationToken!;
      } catch (error: any) {
        this.logger?.debug(`Step 1: Refresh token flow failed for ${destination}: ${error.message}, trying Step 2`);
        // Continue to Step 2
      }
    } else {
      this.logger?.debug(`Step 1: No refresh token found for ${destination}, proceeding to Step 2`);
    }

    // Step 2: UAA Credentials Flow
    this.logger?.debug(`Step 2: Checking UAA credentials for ${destination}`);
    
    // Get UAA credentials from session or service key
    const uaaCredentials = authConfig || (this.serviceKeyStore ? await this.serviceKeyStore.getAuthorizationConfig(destination) : null);
    
    if (!uaaCredentials || !uaaCredentials.uaaUrl || !uaaCredentials.uaaClientId || !uaaCredentials.uaaClientSecret) {
      const errorMessage = `Step 2: UAA credentials not found for ${destination}. ` +
        `Session has no UAA credentials${this.serviceKeyStore ? ' and serviceKeyStore has no UAA credentials' : ' and serviceKeyStore is not available'}.`;
      
      this.logger?.error(errorMessage);
      throw new Error(errorMessage);
    }

    try {
      this.logger?.debug(`Step 2: Trying UAA (client_credentials) flow for ${destination}`);
      
      const authConfigWithoutRefresh = { ...uaaCredentials, refreshToken: undefined };
      const tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithoutRefresh, {
        browser: this.browser,
        logger: this.logger,
      });

      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Step 2: Token obtained via UAA for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

      // Get serviceUrl from session or service key
      const serviceUrl = connConfig.serviceUrl || 
        (this.serviceKeyStore ? (await this.serviceKeyStore.getConnectionConfig(destination))?.serviceUrl : null) ||
        connConfig.serviceUrl;

      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceUrl,
      };

      // Update session with new token
      await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
      if (tokenResult.refreshToken) {
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...uaaCredentials,
          refreshToken: tokenResult.refreshToken,
        });
      }

      return tokenResult.connectionConfig.authorizationToken!;
    } catch (error: any) {
      this.logger?.error(`Step 2: UAA flow failed for ${destination}: ${error.message}`);
      
      // If we have serviceKeyStore, we already tried it, so throw error
      const errorMessage = `All authentication methods failed for destination "${destination}". ` +
        `Step 1 (refresh token): ${refreshToken ? 'failed' : 'not available'}. ` +
        `Step 2 (UAA credentials): failed (${error.message}).`;
      
      this.logger?.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Force refresh token for destination.
   * Uses refresh token from session if available, otherwise uses UAA credentials from session or service key.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to new JWT token string
   */
  async refreshToken(destination: string): Promise<string> {
    this.logger?.debug(`Force refreshing token for destination: ${destination}`);
    
    // Get authorization config from session or service key
    const sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    const serviceKeyAuthConfig = this.serviceKeyStore 
      ? await this.serviceKeyStore.getAuthorizationConfig(destination) 
      : null;
    
    const authConfig = sessionAuthConfig || serviceKeyAuthConfig;
    if (!authConfig) {
      this.logger?.error(`Authorization config not found for ${destination}`);
      throw new Error(
        `Authorization config not found for destination "${destination}". ` +
        `Session has no UAA credentials${this.serviceKeyStore ? ' and serviceKeyStore has no UAA credentials' : ' and serviceKeyStore is not available'}.`
      );
    }

    // Get refresh token from session or service key
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

    // Get serviceUrl from session or service key
    const connConfig = await this.sessionStore.getConnectionConfig(destination);
    const serviceKeyConnConfig = this.serviceKeyStore 
      ? await this.serviceKeyStore.getConnectionConfig(destination) 
      : null;
    
    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...tokenResult.connectionConfig,
      serviceUrl: tokenResult.connectionConfig.serviceUrl || 
        connConfig?.serviceUrl || 
        serviceKeyConnConfig?.serviceUrl,
    };
    
    // Update or create session with new token (stores handle creation if session doesn't exist)
    await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
    if (tokenResult.refreshToken) {
      await this.sessionStore.setAuthorizationConfig(destination, {
        ...authConfig,
        refreshToken: tokenResult.refreshToken,
      });
    }

    return tokenResult.connectionConfig.authorizationToken!;
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
    
    // Fall back to service key store (has UAA credentials) if available
    if (this.serviceKeyStore) {
      this.logger?.debug(`Checking service key store for authorization config: ${destination}`);
      const serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
      if (serviceKeyAuthConfig) {
        this.logger?.debug(`Authorization config from service key for ${destination}: hasUaaUrl(${!!serviceKeyAuthConfig.uaaUrl})`);
        return serviceKeyAuthConfig;
      }
    } else {
      this.logger?.debug(`Service key store not available for ${destination}`);
    }
    
    this.logger?.debug(`No authorization config found for ${destination}`);
    return null;
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
    
    // Fall back to service key store (has URLs but no tokens) if available
    if (this.serviceKeyStore) {
      const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      if (serviceKeyConnConfig) {
        this.logger?.debug(`Connection config from service key for ${destination}: serviceUrl(${serviceKeyConnConfig.serviceUrl ? 'yes' : 'no'}), token(none)`);
        return serviceKeyConnConfig;
      }
    } else {
      this.logger?.debug(`Service key store not available for ${destination}`);
    }
    
    this.logger?.debug(`No connection config found for ${destination}`);
    return null;
  }

}
