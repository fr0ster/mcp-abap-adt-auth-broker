/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { ILogger, IConfig, isNetworkError, STORE_ERROR_CODES } from '@mcp-abap-adt/interfaces';
import { IServiceKeyStore, ISessionStore, IAuthorizationConfig, IConnectionConfig } from './stores/interfaces';
import { ITokenProvider } from './providers';
import axios from 'axios';

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
  /** Token provider (required) - handles token refresh and authentication flows through browser-based authorization (e.g., XSUAA provider) */
  tokenProvider: ITokenProvider;
  /**
   * Allow browser-based authentication (optional, default: true)
   * When false, getToken() will throw BROWSER_AUTH_REQUIRED error instead of blocking on browser auth.
   * Use this for headless/non-interactive environments (e.g., MCP stdio transport).
   */
  allowBrowserAuth?: boolean;
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
  private allowBrowserAuth: boolean;

  /**
   * Create a new AuthBroker instance
   * @param config Configuration object with stores and token provider
   *               - sessionStore: Store for session data (required)
   *               - serviceKeyStore: Store for service keys (optional)
   *               - tokenProvider: Token provider implementing ITokenProvider interface (required) - handles browser-based authorization
   * @param browser Optional browser name for authentication (chrome, edge, firefox, system, headless, none).
   *                Default: 'system' (system default browser).
   *                Use 'headless' for SSH/remote sessions - logs URL and waits for manual callback.
   *                Use 'none' for automated tests - logs URL and rejects immediately.
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

    // Check tokenProvider methods (required)
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
    this.allowBrowserAuth = config.allowBrowserAuth ?? true;

    // Log successful initialization
    const hasServiceKeyStore = !!this.serviceKeyStore;
    this.logger?.debug(
      `AuthBroker initialized: sessionStore(ok), serviceKeyStore(${hasServiceKeyStore ? 'ok' : 'none'}), tokenProvider(ok)`
    );
  }



  /**
   * Get authentication token for destination.
   * Uses tokenProvider for all authentication operations (browser-based authorization).
   * 
   * **Flow:**
   * **Step 0: Initialize Session with Token (if needed)**
   * - Check if session has `authorizationToken` AND UAA credentials
   * - If both are empty AND serviceKeyStore is available:
   *   - Get UAA credentials from service key
   *   - Use tokenProvider for browser-based authentication
   *   - Save token and refresh token to session
   * 
   * **Step 1: Token Validation**
   * - If token exists in session, validate it (if provider supports validation)
   * - If valid → return token
   * - If invalid or no token → continue to refresh
   * 
   * **Step 2: Refresh Token Flow**
   * - Check if refresh token exists in session
   * - If refresh token exists:
   *   - Use tokenProvider to refresh token (browser-based or refresh grant)
   *   - Save new token to session
   *   - Return new token
   * - Otherwise → proceed to Step 3
   * 
   * **Step 3: New Token Flow**
   * - Get UAA credentials from session or service key
   * - Use tokenProvider for browser-based authentication
   * - Save new token to session
   * - Return new token
   * 
   * **Important Notes:**
   * - All authentication is handled by tokenProvider (e.g., XSUAA provider)
   * - Provider uses browser-based authorization to ensure proper role assignment
   * - Direct UAA HTTP requests are not used to avoid role assignment issues
   * 
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to JWT token string
   * @throws Error if session initialization fails or authentication failed
   */
  async getToken(destination: string): Promise<string> {
    this.logger?.debug(`Getting token for destination: ${destination}`);
    
    // Step 0: Initialize Session with Token (if needed)
    let connConfig: IConnectionConfig | null = null;
    let authConfig: IAuthorizationConfig | null = null;
    
    try {
      connConfig = await this.sessionStore.getConnectionConfig(destination);
    } catch (error: any) {
      // Handle typed store errors from session store
      if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
        this.logger?.debug(`Session file not found for ${destination}: ${error.filePath || 'unknown path'}`);
      } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
        this.logger?.warn(`Failed to parse session file for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
      } else {
        this.logger?.warn(`Failed to get connection config from session store for ${destination}: ${error.message}`);
      }
    }
    
    try {
      authConfig = await this.sessionStore.getAuthorizationConfig(destination);
    } catch (error: any) {
      // Handle typed store errors from session store
      if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
        this.logger?.debug(`Session file not found for ${destination}: ${error.filePath || 'unknown path'}`);
      } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
        this.logger?.warn(`Failed to parse session file for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
      } else {
        this.logger?.warn(`Failed to get authorization config from session store for ${destination}: ${error.message}`);
      }
    }
    
    // Check if session has serviceUrl (required)
    // If not in session, try to get it from serviceKeyStore
    let serviceUrl = connConfig?.serviceUrl;
    if (!serviceUrl && this.serviceKeyStore) {
      try {
        const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
        serviceUrl = serviceKeyConnConfig?.serviceUrl;
        if (serviceUrl) {
          this.logger?.debug(`serviceUrl not in session for ${destination}, found in serviceKeyStore`);
        }
      } catch (error: any) {
        // Handle typed store errors
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(`Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`);
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(`Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
        } else {
          this.logger?.warn(`Failed to get serviceUrl from service key store for ${destination}: ${error.message}`);
        }
      }
    }
    
    if (!serviceUrl) {
      this.logger?.error(`Session for destination "${destination}" is missing required field 'serviceUrl'. SessionStore must contain initial session with serviceUrl${this.serviceKeyStore ? ' or serviceKeyStore must contain serviceUrl' : ''}.`);
      throw new Error(
        `Session for destination "${destination}" is missing required field 'serviceUrl'. ` +
        `SessionStore must contain initial session with serviceUrl${this.serviceKeyStore ? ' or serviceKeyStore must contain serviceUrl' : ''}.`
      );
    }

    // Check if we have token or UAA credentials
    const hasToken = !!connConfig?.authorizationToken;
    const hasUaaCredentials = !!(authConfig?.uaaUrl && authConfig?.uaaClientId && authConfig?.uaaClientSecret);
    
    this.logger?.debug(`Step 0: Session check for ${destination}: hasToken(${hasToken}), hasUaaCredentials(${hasUaaCredentials}), serviceUrl(${serviceUrl ? 'yes' : 'no'})`);

    // If token is empty AND UAA fields are empty, try to initialize from service key
    if (!hasToken && !hasUaaCredentials) {
      this.logger?.debug(`Step 0: Token and UAA credentials are empty for ${destination}, attempting initialization from service key`);
      
      if (!this.serviceKeyStore) {
        this.logger?.error(`Step 0: Cannot initialize session for ${destination}: authorizationToken is empty, UAA credentials are empty, and serviceKeyStore is not available`);
        throw new Error(
          `Cannot initialize session for destination "${destination}": authorizationToken is empty, UAA credentials are empty, and serviceKeyStore is not available. ` +
          `Provide serviceKeyStore to initialize from service key.`
        );
      }

      try {
        // Get UAA credentials from service key
        const serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
        if (!serviceKeyAuthConfig || !serviceKeyAuthConfig.uaaUrl || !serviceKeyAuthConfig.uaaClientId || !serviceKeyAuthConfig.uaaClientSecret) {
          this.logger?.error(`Step 0: Service key for ${destination} missing UAA credentials`);
          throw new Error(`Service key for destination "${destination}" does not contain UAA credentials`);
        }

        // Check if browser auth is allowed
        if (!this.allowBrowserAuth) {
          const error = new Error(
            `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. ` +
            `Either enable browser auth or provide a valid session with token.`
          );
          (error as any).code = 'BROWSER_AUTH_REQUIRED';
          (error as any).destination = destination;
          this.logger?.error(`Step 0: Browser auth required but disabled for ${destination}`);
          throw error;
        }

        // Use tokenProvider for browser-based authentication
        this.logger?.debug(`Step 0: Authenticating via provider (browser) for ${destination} using service key UAA credentials`);
        let tokenResult;
        try {
          tokenResult = await this.tokenProvider.getConnectionConfig(serviceKeyAuthConfig, {
            browser: this.browser,
            logger: this.logger,
          });
        } catch (error: any) {
          // Handle provider errors (network, auth, validation)
          if (error.code === 'VALIDATION_ERROR') {
            this.logger?.error(`Step 0: Provider validation error for ${destination}: missing ${error.missingFields?.join(', ') || 'required fields'}`);
            throw new Error(`Cannot initialize session for destination "${destination}": provider validation failed - missing ${error.missingFields?.join(', ') || 'required fields'}`);
          } else if (error.code === 'BROWSER_AUTH_ERROR') {
            this.logger?.error(`Step 0: Browser authentication failed for ${destination}: ${error.message}`);
            throw new Error(`Cannot initialize session for destination "${destination}": browser authentication failed - ${error.message}`);
          } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
            this.logger?.error(`Step 0: Network error for ${destination}: ${error.code}`);
            throw new Error(`Cannot initialize session for destination "${destination}": network error - cannot reach authentication server (${error.code})`);
          }
          this.logger?.error(`Step 0: Provider error for ${destination}: ${error.message}`);
          throw new Error(`Cannot initialize session for destination "${destination}": provider error - ${error.message}`);
        }

        const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
        this.logger?.info(`Step 0: Token initialized for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

        // Get serviceUrl from service key store if not in connectionConfig
        const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
        const connectionConfigWithServiceUrl: IConnectionConfig = {
          ...tokenResult.connectionConfig,
          serviceUrl: tokenResult.connectionConfig.serviceUrl || serviceKeyConnConfig?.serviceUrl || serviceUrl,
        };

        // Save token and UAA credentials to session
        try {
          await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        } catch (error: any) {
          this.logger?.error(`Step 0: Failed to save connection config to session for ${destination}: ${error.message}`);
          throw new Error(`Failed to save connection config for destination "${destination}": ${error.message}`);
        }
        
        try {
          await this.sessionStore.setAuthorizationConfig(destination, {
            ...serviceKeyAuthConfig,
            refreshToken: tokenResult.refreshToken || serviceKeyAuthConfig.refreshToken,
          });
        } catch (error: any) {
          this.logger?.error(`Step 0: Failed to save authorization config to session for ${destination}: ${error.message}`);
          throw new Error(`Failed to save authorization config for destination "${destination}": ${error.message}`);
        }

        return tokenResult.connectionConfig.authorizationToken!;
      } catch (error: any) {
        // Re-throw BROWSER_AUTH_REQUIRED error without wrapping
        if (error.code === 'BROWSER_AUTH_REQUIRED') {
          throw error;
        }

        // Handle typed store errors
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.error(`Step 0: Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`);
          throw new Error(`Cannot initialize session for destination "${destination}": service key file not found`);
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.error(`Step 0: Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
          throw new Error(`Cannot initialize session for destination "${destination}": service key parsing failed - ${error.message}`);
        } else if (error.code === STORE_ERROR_CODES.INVALID_CONFIG) {
          this.logger?.error(`Step 0: Invalid service key config for ${destination}: missing fields ${error.missingFields?.join(', ') || 'unknown'}`);
          throw new Error(`Cannot initialize session for destination "${destination}": invalid service key - missing ${error.missingFields?.join(', ') || 'required fields'}`);
        }

        this.logger?.error(`Step 0: Failed to initialize session for ${destination}: ${error.message}`);
        throw new Error(`Cannot initialize session for destination "${destination}": ${error.message}`);
      }
    }

    // If we have a token, validate it first
    if (hasToken && connConfig?.authorizationToken) {
      this.logger?.debug(`Step 0: Token found for ${destination}, validating`);
      
      // Validate token if provider supports validation and we have service URL
      if (this.tokenProvider?.validateToken && serviceUrl) {
        try {
          const isValid = await this.tokenProvider.validateToken(connConfig.authorizationToken, serviceUrl);
          if (isValid) {
            this.logger?.info(`Step 0: Token valid for ${destination}: token(${connConfig.authorizationToken.length} chars)`);
            return connConfig.authorizationToken;
          }
          this.logger?.debug(`Step 0: Token invalid for ${destination}, continuing to refresh`);
        } catch (error: any) {
          // Validation failed due to network/server error - log and continue to refresh
          this.logger?.warn(`Step 0: Token validation failed for ${destination} (network error): ${error.message}. Continuing to refresh.`);
          // Don't throw - continue to refresh flow
        }
      } else {
        // No service URL or provider doesn't support validation - just return token
        this.logger?.info(`Step 0: Token found for ${destination} (no validation): token(${connConfig.authorizationToken.length} chars)`);
        return connConfig.authorizationToken;
      }
    }

    // Step 2: Refresh Token Flow
    this.logger?.debug(`Step 2: Attempting token refresh for ${destination}`);
    
    // Get UAA credentials from session or service key
    let serviceKeyAuthConfig: IAuthorizationConfig | null = null;
    if (!authConfig && this.serviceKeyStore) {
      try {
        serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
      } catch (error: any) {
        // Handle typed store errors
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(`Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`);
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(`Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
        } else {
          this.logger?.warn(`Failed to get UAA credentials from service key store for ${destination}: ${error.message}`);
        }
      }
    }
    const uaaCredentials = authConfig || serviceKeyAuthConfig;
    
    if (!uaaCredentials || !uaaCredentials.uaaUrl || !uaaCredentials.uaaClientId || !uaaCredentials.uaaClientSecret) {
      const errorMessage = `Step 2: UAA credentials not found for ${destination}. ` +
        `Session has no UAA credentials${this.serviceKeyStore ? ' and serviceKeyStore has no UAA credentials' : ' and serviceKeyStore is not available'}.`;
      
      this.logger?.error(errorMessage);
      throw new Error(errorMessage);
    }

    // Try refresh from session first (if refresh token exists)
    const refreshToken = authConfig?.refreshToken;
    if (refreshToken) {
      try {
        this.logger?.debug(`Step 2a: Trying refreshTokenFromSession for ${destination}`);
        
        const authConfigWithRefresh = { ...uaaCredentials, refreshToken };
        let tokenResult;
        try {
          tokenResult = await this.tokenProvider.refreshTokenFromSession(authConfigWithRefresh, {
            browser: this.browser,
            logger: this.logger,
          });
        } catch (providerError: any) {
          // Handle provider network/auth errors
          if (providerError.code === 'ECONNREFUSED' || providerError.code === 'ETIMEDOUT' || providerError.code === 'ENOTFOUND') {
            this.logger?.debug(`Step 2a: Network error during refreshTokenFromSession for ${destination}: ${providerError.code}. Trying refreshTokenFromServiceKey`);
            throw providerError; // Re-throw to trigger fallback to Step 2b
          }
          throw providerError; // Re-throw other errors
        }

        const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
        this.logger?.info(`Step 2a: Token refreshed from session for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

        // Get serviceUrl from session or service key
        let serviceKeyServiceUrl: string | undefined;
        if (this.serviceKeyStore) {
          try {
            const serviceKeyConn = await this.serviceKeyStore.getConnectionConfig(destination);
            serviceKeyServiceUrl = serviceKeyConn?.serviceUrl;
          } catch (error: any) {
            this.logger?.debug(`Could not get serviceUrl from service key store: ${error.message}`);
          }
        }
        const finalServiceUrl = tokenResult.connectionConfig.serviceUrl || serviceUrl || serviceKeyServiceUrl;

        const connectionConfigWithServiceUrl: IConnectionConfig = {
          ...tokenResult.connectionConfig,
          serviceUrl: finalServiceUrl,
        };

        // Update session with new token
        try {
          await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        } catch (error: any) {
          this.logger?.error(`Step 2a: Failed to save connection config to session for ${destination}: ${error.message}`);
          throw new Error(`Failed to save connection config for destination "${destination}": ${error.message}`);
        }
        
        if (tokenResult.refreshToken) {
          try {
            await this.sessionStore.setAuthorizationConfig(destination, {
              ...uaaCredentials,
              refreshToken: tokenResult.refreshToken,
            });
          } catch (error: any) {
            this.logger?.error(`Step 2a: Failed to save authorization config to session for ${destination}: ${error.message}`);
            throw new Error(`Failed to save authorization config for destination "${destination}": ${error.message}`);
          }
        }

        return tokenResult.connectionConfig.authorizationToken!;
      } catch (error: any) {
        this.logger?.debug(`Step 2a: refreshTokenFromSession failed for ${destination}: ${error.message}, trying refreshTokenFromServiceKey`);
        // Continue to try service key refresh
      }
    } else {
      this.logger?.debug(`Step 2a: No refresh token in session for ${destination}, skipping to service key refresh`);
    }

    // Try refresh from service key (browser authentication)
    // Check if browser auth is allowed
    if (!this.allowBrowserAuth) {
      const error = new Error(
        `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. ` +
        `Token refresh via session failed and browser auth is not allowed. ` +
        `Either enable browser auth or ensure a valid refresh token exists in session.`
      );
      (error as any).code = 'BROWSER_AUTH_REQUIRED';
      (error as any).destination = destination;
      this.logger?.error(`Step 2b: Browser auth required but disabled for ${destination}`);
      throw error;
    }

    try {
      this.logger?.debug(`Step 2b: Trying refreshTokenFromServiceKey for ${destination}`);

      const tokenResult = await this.tokenProvider.refreshTokenFromServiceKey(uaaCredentials, {
        browser: this.browser,
        logger: this.logger,
      });

      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Step 2b: Token refreshed from service key for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

      // Get serviceUrl from session or service key
      let serviceKeyServiceUrl: string | undefined;
      if (this.serviceKeyStore) {
        try {
          const serviceKeyConn = await this.serviceKeyStore.getConnectionConfig(destination);
          serviceKeyServiceUrl = serviceKeyConn?.serviceUrl;
        } catch (error: any) {
          this.logger?.debug(`Could not get serviceUrl from service key store: ${error.message}`);
        }
      }
      const finalServiceUrl = tokenResult.connectionConfig.serviceUrl || serviceUrl || serviceKeyServiceUrl;

      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: finalServiceUrl,
      };

      // Update session with new token
      try {
        await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
      } catch (error: any) {
        this.logger?.error(`Step 2b: Failed to save connection config to session for ${destination}: ${error.message}`);
        throw new Error(`Failed to save connection config for destination "${destination}": ${error.message}`);
      }
      
      if (tokenResult.refreshToken) {
        try {
          await this.sessionStore.setAuthorizationConfig(destination, {
            ...uaaCredentials,
            refreshToken: tokenResult.refreshToken,
          });
        } catch (error: any) {
          this.logger?.error(`Step 2b: Failed to save authorization config to session for ${destination}: ${error.message}`);
          throw new Error(`Failed to save authorization config for destination "${destination}": ${error.message}`);
        }
      }

      return tokenResult.connectionConfig.authorizationToken!;
    } catch (error: any) {
      this.logger?.error(`Step 2b: refreshTokenFromServiceKey failed for ${destination}: ${error.message}`);
      
      // Determine error cause and throw meaningful error
      if (error.code === 'VALIDATION_ERROR') {
        throw new Error(`Token refresh failed: Missing required fields in authConfig - ${error.missingFields?.join(', ')}`);
      } else if (error.code === 'BROWSER_AUTH_ERROR') {
        throw new Error(`Token refresh failed: Browser authentication failed or was cancelled - ${error.message}`);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        throw new Error(`Token refresh failed: Network error - ${error.code}: Cannot reach authentication server`);
      } else if (error.code === 'SERVICE_KEY_ERROR') {
        throw new Error(`Token refresh failed: Service key not found or invalid for ${destination}`);
      }
      
      // Generic error
      throw new Error(`Token refresh failed for ${destination}: ${error.message}`);
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
    
    // Call getToken to trigger full refresh flow
    return this.getToken(destination);
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
    let sessionAuthConfig: IAuthorizationConfig | null = null;
    try {
      sessionAuthConfig = await this.sessionStore.getAuthorizationConfig(destination);
    } catch (error: any) {
      this.logger?.warn(`Failed to get authorization config from session store for ${destination}: ${error.message}`);
    }
    if (sessionAuthConfig) {
      this.logger?.debug(`Authorization config from session for ${destination}: hasUaaUrl(${!!sessionAuthConfig.uaaUrl}), hasRefreshToken(${!!sessionAuthConfig.refreshToken})`);
      return sessionAuthConfig;
    }
    
    // Fall back to service key store (has UAA credentials) if available
    if (this.serviceKeyStore) {
      this.logger?.debug(`Checking service key store for authorization config: ${destination}`);
      let serviceKeyAuthConfig: IAuthorizationConfig | null = null;
      try {
        serviceKeyAuthConfig = await this.serviceKeyStore.getAuthorizationConfig(destination);
      } catch (error: any) {
        // Handle typed store errors
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(`Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`);
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(`Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
        } else {
          this.logger?.warn(`Failed to get authorization config from service key store for ${destination}: ${error.message}`);
        }
      }
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
    let sessionConnConfig: IConnectionConfig | null = null;
    try {
      sessionConnConfig = await this.sessionStore.getConnectionConfig(destination);
    } catch (error: any) {
      this.logger?.warn(`Failed to get connection config from session store for ${destination}: ${error.message}`);
    }
    if (sessionConnConfig) {
      this.logger?.debug(`Connection config from session for ${destination}: token(${sessionConnConfig.authorizationToken?.length || 0} chars), serviceUrl(${sessionConnConfig.serviceUrl ? 'yes' : 'no'})`);
      return sessionConnConfig;
    }
    
    // Fall back to service key store (has URLs but no tokens) if available
    if (this.serviceKeyStore) {
      let serviceKeyConnConfig: IConnectionConfig | null = null;
      try {
        serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      } catch (error: any) {
        // Handle typed store errors
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(`Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`);
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(`Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${error.message}`);
        } else {
          this.logger?.warn(`Failed to get connection config from service key store for ${destination}: ${error.message}`);
        }
      }
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
