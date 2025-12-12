/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import { ILogger, IConfig } from '@mcp-abap-adt/interfaces';
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
  /** Token provider (optional) - handles token refresh and authentication flows. If not provided, direct UAA HTTP requests will be used when UAA credentials are available */
  tokenProvider?: ITokenProvider;
}

/**
 * AuthBroker manages JWT authentication tokens for destinations
 */
/**
 * Result of direct UAA token request
 */
interface UaaTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export class AuthBroker {
  private browser: string | undefined;
  private logger: ILogger;
  private serviceKeyStore: IServiceKeyStore | undefined;
  private sessionStore: ISessionStore;
  private tokenProvider: ITokenProvider | undefined;

  /**
   * Create a new AuthBroker instance
   * @param config Configuration object with stores and token provider
   *               - sessionStore: Store for session data (required)
   *               - serviceKeyStore: Store for service keys (optional)
   *               - tokenProvider: Token provider implementing ITokenProvider interface (optional). If not provided, direct UAA HTTP requests will be used when UAA credentials are available
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

    // Check tokenProvider methods (if provided)
    if (tokenProvider) {
      if (typeof tokenProvider.getConnectionConfig !== 'function') {
        throw new Error('AuthBroker: tokenProvider.getConnectionConfig must be a function');
      }
      // validateToken is optional, so we don't check it
    }

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
    const hasTokenProvider = !!this.tokenProvider;
    this.logger?.debug(`AuthBroker initialized: sessionStore(ok), serviceKeyStore(${hasServiceKeyStore ? 'ok' : 'none'}), tokenProvider(${hasTokenProvider ? 'ok' : 'none'})`);
  }

  /**
   * Refresh token using refresh_token grant type (direct UAA HTTP request)
   * @param refreshToken Refresh token
   * @param authConfig UAA authorization configuration
   * @returns Promise that resolves to new tokens
   */
  private async refreshTokenDirect(refreshToken: string, authConfig: IAuthorizationConfig): Promise<UaaTokenResult> {
    if (!authConfig.uaaUrl || !authConfig.uaaClientId || !authConfig.uaaClientSecret) {
      throw new Error('UAA credentials incomplete: uaaUrl, uaaClientId, and uaaClientSecret are required');
    }

    const tokenUrl = `${authConfig.uaaUrl}/oauth/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);

    const authString = Buffer.from(`${authConfig.uaaClientId}:${authConfig.uaaClientSecret}`).toString('base64');

    try {
      const response = await axios({
        method: 'post',
        url: tokenUrl,
        headers: {
          Authorization: `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: params.toString(),
        timeout: 30000,
      });

      if (response.data && response.data.access_token) {
        return {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token || refreshToken,
          expiresIn: response.data.expires_in,
        };
      } else {
        throw new Error('Response does not contain access_token');
      }
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `Token refresh failed (${error.response.status}): ${JSON.stringify(error.response.data)}`
        );
      } else {
        throw new Error(`Token refresh failed: ${error.message}`);
      }
    }
  }

  /**
   * Get token using client_credentials grant type (direct UAA HTTP request)
   * @param authConfig UAA authorization configuration
   * @returns Promise that resolves to access token
   */
  private async getTokenWithClientCredentials(authConfig: IAuthorizationConfig): Promise<UaaTokenResult> {
    if (!authConfig.uaaUrl || !authConfig.uaaClientId || !authConfig.uaaClientSecret) {
      throw new Error('UAA credentials incomplete: uaaUrl, uaaClientId, and uaaClientSecret are required');
    }

    const tokenUrl = `${authConfig.uaaUrl}/oauth/token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', authConfig.uaaClientId);
    params.append('client_secret', authConfig.uaaClientSecret);

    try {
      const response = await axios({
        method: 'post',
        url: tokenUrl,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: params.toString(),
        timeout: 30000,
      });

      if (response.data && response.data.access_token) {
        return {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
          expiresIn: response.data.expires_in,
        };
      } else {
        throw new Error('Response does not contain access_token');
      }
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `Client credentials authentication failed (${error.response.status}): ${JSON.stringify(error.response.data)}`
        );
      } else {
        throw new Error(`Client credentials authentication failed: ${error.message}`);
      }
    }
  }

  /**
   * Get authentication token for destination.
   * Implements a three-step flow: Step 0 (initialize), Step 1 (refresh), Step 2 (UAA).
   * 
   * **Flow:**
   * **Step 0: Initialize Session with Token (if needed)**
   * - Check if session has `authorizationToken` AND UAA credentials
   * - If both are empty AND serviceKeyStore is available:
   *   - Try direct UAA request from service key (if UAA credentials available)
   *   - If failed and tokenProvider available → use provider
   * - If session has token OR UAA credentials → proceed to Step 1
   * 
   * **Step 1: Refresh Token Flow**
   * - Check if refresh token exists in session
   * - If refresh token exists:
   *   - Try direct UAA refresh (if UAA credentials in session)
   *   - If failed and tokenProvider available → use provider
   *   - If successful → return new token
   * - Otherwise → proceed to Step 2
   * 
   * **Step 2: UAA Credentials Flow**
   * - Check if UAA credentials exist in session or service key
   * - Try direct UAA client_credentials request (if UAA credentials available)
   * - If failed and tokenProvider available → use provider
   * - If successful → return new token
   * - If all failed → return error
   * 
   * **Important Notes:**
   * - If sessionStore contains valid UAA credentials, neither serviceKeyStore nor tokenProvider are required.
   *   Direct UAA HTTP requests will be used automatically.
   * - tokenProvider is only needed when:
   *   - Initializing session from service key via browser authentication (Step 0)
   *   - Direct UAA requests fail and fallback to provider is needed
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
    // If not in session, try to get it from serviceKeyStore
    let serviceUrl = connConfig?.serviceUrl;
    if (!serviceUrl && this.serviceKeyStore) {
      const serviceKeyConnConfig = await this.serviceKeyStore.getConnectionConfig(destination);
      serviceUrl = serviceKeyConnConfig?.serviceUrl;
      if (serviceUrl) {
        this.logger?.debug(`serviceUrl not in session for ${destination}, found in serviceKeyStore`);
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

        // Try direct UAA request first if UAA credentials are available in service key
        let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
        
        try {
          // Use direct UAA HTTP request (preferred when UAA credentials are available)
          this.logger?.debug(`Step 0: Authenticating via direct UAA request for ${destination} using service key UAA credentials`);
          const uaaResult = await this.getTokenWithClientCredentials(serviceKeyAuthConfig);
          tokenResult = {
            connectionConfig: {
              authorizationToken: uaaResult.accessToken,
            },
            refreshToken: uaaResult.refreshToken,
          };
        } catch (directError: any) {
          this.logger?.debug(`Step 0: Direct UAA request failed for ${destination}: ${directError.message}, trying provider`);
          // If direct UAA failed and we have provider, try provider
          if (this.tokenProvider) {
            this.logger?.debug(`Step 0: Authenticating via provider for ${destination} using service key UAA credentials`);
            tokenResult = await this.tokenProvider.getConnectionConfig(serviceKeyAuthConfig, {
              browser: this.browser,
              logger: this.logger,
            });
          } else {
            throw directError; // No provider, re-throw direct error
          }
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
        await this.sessionStore.setConnectionConfig(destination, connectionConfigWithServiceUrl);
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...serviceKeyAuthConfig,
          refreshToken: tokenResult.refreshToken || serviceKeyAuthConfig.refreshToken,
        });

        return tokenResult.connectionConfig.authorizationToken!;
      } catch (error: any) {
        this.logger?.error(`Step 0: Failed to initialize session for ${destination}: ${error.message}`);
        const errorMessage = `Cannot initialize session for destination "${destination}": ${error.message}. ` +
          `Ensure serviceKeyStore contains valid service key with UAA credentials${this.tokenProvider ? ' or provide tokenProvider for alternative authentication' : ''}.`;
        throw new Error(errorMessage);
      }
    }

    // If we have a token, validate it first
    if (hasToken && connConfig.authorizationToken) {
      this.logger?.debug(`Step 0: Token found for ${destination}, validating`);
      
      // Validate token if provider supports validation and we have service URL
      if (this.tokenProvider?.validateToken && serviceUrl) {
        const isValid = await this.tokenProvider.validateToken(connConfig.authorizationToken, serviceUrl);
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
        if (!uaaCredentials || !uaaCredentials.uaaUrl || !uaaCredentials.uaaClientId || !uaaCredentials.uaaClientSecret) {
          throw new Error('UAA credentials not found in session and serviceKeyStore not available');
        }

        let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
        
        // Try direct UAA request if UAA credentials are available
        if (uaaCredentials.uaaUrl && uaaCredentials.uaaClientId && uaaCredentials.uaaClientSecret) {
          try {
            this.logger?.debug(`Step 1: Trying direct UAA refresh for ${destination}`);
            const uaaResult = await this.refreshTokenDirect(refreshToken, uaaCredentials);
            tokenResult = {
              connectionConfig: {
                authorizationToken: uaaResult.accessToken,
              },
              refreshToken: uaaResult.refreshToken,
            };
            this.logger?.debug(`Step 1: Direct UAA refresh succeeded for ${destination}`);
          } catch (directError: any) {
            this.logger?.debug(`Step 1: Direct UAA refresh failed for ${destination}: ${directError.message}, trying provider`);
            // If direct UAA failed and we have provider, try provider
            if (this.tokenProvider) {
              const authConfigWithRefresh = { ...uaaCredentials, refreshToken };
              tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
                browser: this.browser,
                logger: this.logger,
              });
            } else {
              throw directError; // No provider, re-throw direct error
            }
          }
        } else if (this.tokenProvider) {
          // No UAA credentials but have provider
          const authConfigWithRefresh = { ...uaaCredentials, refreshToken };
          tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
            browser: this.browser,
            logger: this.logger,
          });
        } else {
          throw new Error('UAA credentials incomplete and tokenProvider not available');
        }

        const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
        this.logger?.info(`Step 1: Token refreshed for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

        // Get serviceUrl from session or service key (use the one we already have from the beginning of the method)
        const finalServiceUrl = tokenResult.connectionConfig.serviceUrl || 
          serviceUrl ||
          (this.serviceKeyStore ? (await this.serviceKeyStore.getConnectionConfig(destination))?.serviceUrl : undefined);

        const connectionConfigWithServiceUrl: IConnectionConfig = {
          ...tokenResult.connectionConfig,
          serviceUrl: finalServiceUrl,
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
      
      let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
      
      // Try direct UAA request first if UAA credentials are available
      if (uaaCredentials.uaaUrl && uaaCredentials.uaaClientId && uaaCredentials.uaaClientSecret) {
        try {
          this.logger?.debug(`Step 2: Trying direct UAA client_credentials for ${destination}`);
          const uaaResult = await this.getTokenWithClientCredentials(uaaCredentials);
          tokenResult = {
            connectionConfig: {
              authorizationToken: uaaResult.accessToken,
            },
            refreshToken: uaaResult.refreshToken,
          };
          this.logger?.debug(`Step 2: Direct UAA client_credentials succeeded for ${destination}`);
        } catch (directError: any) {
          this.logger?.debug(`Step 2: Direct UAA client_credentials failed for ${destination}: ${directError.message}, trying provider`);
          // If direct UAA failed and we have provider, try provider
          if (this.tokenProvider) {
            const authConfigWithoutRefresh = { ...uaaCredentials, refreshToken: undefined };
            tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithoutRefresh, {
              browser: this.browser,
              logger: this.logger,
            });
          } else {
            throw directError; // No provider, re-throw direct error
          }
        }
      } else if (this.tokenProvider) {
        // No UAA credentials but have provider
        const authConfigWithoutRefresh = { ...uaaCredentials, refreshToken: undefined };
        tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithoutRefresh, {
          browser: this.browser,
          logger: this.logger,
        });
      } else {
        throw new Error('UAA credentials incomplete and tokenProvider not available');
      }

      const tokenLength = tokenResult.connectionConfig.authorizationToken?.length || 0;
      this.logger?.info(`Step 2: Token obtained via UAA for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`);

      // Get serviceUrl from session or service key (use the one we already have from the beginning of the method)
      const finalServiceUrl = tokenResult.connectionConfig.serviceUrl || 
        serviceUrl ||
        (this.serviceKeyStore ? (await this.serviceKeyStore.getConnectionConfig(destination))?.serviceUrl : undefined);

      const connectionConfigWithServiceUrl: IConnectionConfig = {
        ...tokenResult.connectionConfig,
        serviceUrl: finalServiceUrl,
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
    
    let tokenResult: { connectionConfig: IConnectionConfig; refreshToken?: string };
    
    // Try direct UAA request if UAA credentials are available
    if (authConfig.uaaUrl && authConfig.uaaClientId && authConfig.uaaClientSecret && refreshToken) {
      try {
        this.logger?.debug(`Trying direct UAA refresh for ${destination}`);
        const uaaResult = await this.refreshTokenDirect(refreshToken, authConfig);
        tokenResult = {
          connectionConfig: {
            authorizationToken: uaaResult.accessToken,
          },
          refreshToken: uaaResult.refreshToken,
        };
      } catch (directError: any) {
        this.logger?.debug(`Direct UAA refresh failed for ${destination}: ${directError.message}, trying provider`);
        // If direct UAA failed and we have provider, try provider
        if (this.tokenProvider) {
          const authConfigWithRefresh = { ...authConfig, refreshToken };
          tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
            browser: this.browser,
            logger: this.logger,
          });
        } else {
          throw directError; // No provider, re-throw direct error
        }
      }
    } else if (this.tokenProvider) {
      // No UAA credentials or refresh token, but have provider
      const authConfigWithRefresh = { ...authConfig, refreshToken };
      tokenResult = await this.tokenProvider.getConnectionConfig(authConfigWithRefresh, {
        browser: this.browser,
        logger: this.logger,
      });
    } else {
      throw new Error('UAA credentials incomplete and tokenProvider not available');
    }

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
