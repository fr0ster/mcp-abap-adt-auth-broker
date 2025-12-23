/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import {
  type ILogger,
  type ITokenRefresher,
  STORE_ERROR_CODES,
} from '@mcp-abap-adt/interfaces';
import type { ITokenProvider } from './providers';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';

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
 * Type for errors with code property
 */
type ErrorWithCode = Error & {
  code: string;
  message?: string;
  filePath?: string;
  missingFields?: string[];
  destination?: string;
};

/**
 * Helper function to check if error has a code property
 */
// biome-ignore lint/suspicious/noExplicitAny: Helper function needs to accept any error type
function hasErrorCode(error: any): error is ErrorWithCode {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

/**
 * Helper function to get error message safely
 */
// biome-ignore lint/suspicious/noExplicitAny: Helper function needs to accept any error type
function getErrorMessage(error: any): string {
  return error instanceof Error ? error.message : String(error);
}

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
  constructor(config: AuthBrokerConfig, browser?: string, logger?: ILogger) {
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
      throw new Error(
        'AuthBroker: sessionStore.getAuthorizationConfig must be a function',
      );
    }
    if (typeof sessionStore.getConnectionConfig !== 'function') {
      throw new Error(
        'AuthBroker: sessionStore.getConnectionConfig must be a function',
      );
    }
    if (typeof sessionStore.setAuthorizationConfig !== 'function') {
      throw new Error(
        'AuthBroker: sessionStore.setAuthorizationConfig must be a function',
      );
    }
    if (typeof sessionStore.setConnectionConfig !== 'function') {
      throw new Error(
        'AuthBroker: sessionStore.setConnectionConfig must be a function',
      );
    }

    // Check tokenProvider methods (required)
    if (typeof tokenProvider.getConnectionConfig !== 'function') {
      throw new Error(
        'AuthBroker: tokenProvider.getConnectionConfig must be a function',
      );
    }
    // validateToken is optional, so we don't check it

    // Check serviceKeyStore methods (if provided)
    if (serviceKeyStore) {
      if (typeof serviceKeyStore.getServiceKey !== 'function') {
        throw new Error(
          'AuthBroker: serviceKeyStore.getServiceKey must be a function',
        );
      }
      if (typeof serviceKeyStore.getAuthorizationConfig !== 'function') {
        throw new Error(
          'AuthBroker: serviceKeyStore.getAuthorizationConfig must be a function',
        );
      }
      if (typeof serviceKeyStore.getConnectionConfig !== 'function') {
        throw new Error(
          'AuthBroker: serviceKeyStore.getConnectionConfig must be a function',
        );
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
      `AuthBroker initialized: sessionStore(ok), serviceKeyStore(${hasServiceKeyStore ? 'ok' : 'none'}), tokenProvider(ok)`,
    );
  }

  /**
   * Load session data (connection and authorization configs)
   */
  private async loadSessionData(destination: string): Promise<{
    connConfig: IConnectionConfig | null;
    authConfig: IAuthorizationConfig | null;
  }> {
    let connConfig: IConnectionConfig | null = null;
    let authConfig: IAuthorizationConfig | null = null;

    try {
      connConfig = await this.sessionStore.getConnectionConfig(destination);
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(
            `Session file not found for ${destination}: ${error.filePath || 'unknown path'}`,
          );
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(
            `Failed to parse session file for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
          );
        } else {
          this.logger?.warn(
            `Failed to get connection config from session store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      } else {
        this.logger?.warn(
          `Failed to get connection config from session store for ${destination}: ${getErrorMessage(error)}`,
        );
      }
    }

    try {
      authConfig = await this.sessionStore.getAuthorizationConfig(destination);
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(
            `Session file not found for ${destination}: ${error.filePath || 'unknown path'}`,
          );
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(
            `Failed to parse session file for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
          );
        } else {
          this.logger?.warn(
            `Failed to get authorization config from session store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      } else {
        this.logger?.warn(
          `Failed to get authorization config from session store for ${destination}: ${getErrorMessage(error)}`,
        );
      }
    }

    return { connConfig, authConfig };
  }

  /**
   * Get serviceUrl from session or service key store
   */
  private async getServiceUrl(
    destination: string,
    connConfig: IConnectionConfig | null,
  ): Promise<string> {
    let serviceUrl = connConfig?.serviceUrl;

    if (!serviceUrl && this.serviceKeyStore) {
      try {
        const serviceKeyConnConfig =
          await this.serviceKeyStore.getConnectionConfig(destination);
        serviceUrl = serviceKeyConnConfig?.serviceUrl;
        if (serviceUrl) {
          this.logger?.debug(
            `serviceUrl not in session for ${destination}, found in serviceKeyStore`,
          );
        }
      } catch (error: any) {
        if (hasErrorCode(error)) {
          if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
            this.logger?.debug(
              `Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`,
            );
          } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
            this.logger?.warn(
              `Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
            );
          } else {
            this.logger?.warn(
              `Failed to get serviceUrl from service key store for ${destination}: ${getErrorMessage(error)}`,
            );
          }
        } else {
          this.logger?.warn(
            `Failed to get serviceUrl from service key store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      }
    }

    if (!serviceUrl) {
      this.logger?.error(
        `Session for destination "${destination}" is missing required field 'serviceUrl'. SessionStore must contain initial session with serviceUrl${this.serviceKeyStore ? ' or serviceKeyStore must contain serviceUrl' : ''}.`,
      );
      throw new Error(
        `Session for destination "${destination}" is missing required field 'serviceUrl'. ` +
          `SessionStore must contain initial session with serviceUrl${this.serviceKeyStore ? ' or serviceKeyStore must contain serviceUrl' : ''}.`,
      );
    }

    return serviceUrl;
  }

  /**
   * Get UAA credentials from session or service key
   */
  private async getUaaCredentials(
    destination: string,
    authConfig: IAuthorizationConfig | null,
  ): Promise<IAuthorizationConfig> {
    if (
      authConfig?.uaaUrl &&
      authConfig?.uaaClientId &&
      authConfig?.uaaClientSecret
    ) {
      return authConfig;
    }

    if (!this.serviceKeyStore) {
      throw new Error(
        `UAA credentials not found for ${destination}. Session has no UAA credentials and serviceKeyStore is not available.`,
      );
    }

    let serviceKeyAuthConfig: IAuthorizationConfig | null = null;
    try {
      serviceKeyAuthConfig =
        await this.serviceKeyStore.getAuthorizationConfig(destination);
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
          this.logger?.debug(
            `Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`,
          );
        } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
          this.logger?.warn(
            `Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
          );
        } else {
          this.logger?.warn(
            `Failed to get UAA credentials from service key store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      } else {
        this.logger?.warn(
          `Failed to get UAA credentials from service key store for ${destination}: ${getErrorMessage(error)}`,
        );
      }
    }

    const uaaCredentials = authConfig || serviceKeyAuthConfig;
    if (
      !uaaCredentials ||
      !uaaCredentials.uaaUrl ||
      !uaaCredentials.uaaClientId ||
      !uaaCredentials.uaaClientSecret
    ) {
      throw new Error(
        `UAA credentials not found for ${destination}. Session has no UAA credentials${this.serviceKeyStore ? ' and serviceKeyStore has no UAA credentials' : ' and serviceKeyStore is not available'}.`,
      );
    }

    return uaaCredentials;
  }

  /**
   * Save token and config to session
   */
  private async saveTokenToSession(
    destination: string,
    connectionConfig: IConnectionConfig,
    authorizationConfig: IAuthorizationConfig,
  ): Promise<void> {
    try {
      await this.sessionStore.setConnectionConfig(
        destination,
        connectionConfig,
      );
    } catch (error: any) {
      this.logger?.error(
        `Failed to save connection config to session for ${destination}: ${getErrorMessage(error)}`,
      );
      throw new Error(
        `Failed to save connection config for destination "${destination}": ${getErrorMessage(error)}`,
      );
    }

    try {
      await this.sessionStore.setAuthorizationConfig(
        destination,
        authorizationConfig,
      );
    } catch (error: any) {
      this.logger?.error(
        `Failed to save authorization config to session for ${destination}: ${getErrorMessage(error)}`,
      );
      throw new Error(
        `Failed to save authorization config for destination "${destination}": ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Initialize session from service key (Step 0)
   */
  private async initializeSessionFromServiceKey(
    destination: string,
    serviceUrl: string,
  ): Promise<string> {
    if (!this.serviceKeyStore) {
      throw new Error(
        `Cannot initialize session for destination "${destination}": authorizationToken is empty, UAA credentials are empty, and serviceKeyStore is not available. Provide serviceKeyStore to initialize from service key.`,
      );
    }

    const serviceKeyAuthConfig =
      await this.serviceKeyStore.getAuthorizationConfig(destination);
    if (
      !serviceKeyAuthConfig ||
      !serviceKeyAuthConfig.uaaUrl ||
      !serviceKeyAuthConfig.uaaClientId ||
      !serviceKeyAuthConfig.uaaClientSecret
    ) {
      throw new Error(
        `Service key for destination "${destination}" does not contain UAA credentials`,
      );
    }

    if (!this.allowBrowserAuth) {
      const error = new Error(
        `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. Either enable browser auth or provide a valid session with token.`,
      ) as Error & { code: string; destination: string };
      error.code = 'BROWSER_AUTH_REQUIRED';
      error.destination = destination;
      this.logger?.error(
        `Step 0: Browser auth required but disabled for ${destination}`,
      );
      throw error;
    }

    this.logger?.debug(
      `Step 0: Authenticating via provider (browser) for ${destination} using service key UAA credentials`,
    );

    const getConnectionConfig = this.tokenProvider.getConnectionConfig;
    if (!getConnectionConfig) {
      throw new Error(
        'AuthBroker: tokenProvider.getConnectionConfig is required',
      );
    }
    let tokenResult: Awaited<ReturnType<typeof getConnectionConfig>>;
    try {
      tokenResult = await getConnectionConfig(serviceKeyAuthConfig, {
        browser: this.browser,
        logger: this.logger,
      });
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === 'VALIDATION_ERROR') {
          throw new Error(
            `Cannot initialize session for destination "${destination}": provider validation failed - missing ${error.missingFields?.join(', ') || 'required fields'}`,
          );
        } else if (error.code === 'BROWSER_AUTH_ERROR') {
          throw new Error(
            `Cannot initialize session for destination "${destination}": browser authentication failed - ${getErrorMessage(error)}`,
          );
        } else if (
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND'
        ) {
          throw new Error(
            `Cannot initialize session for destination "${destination}": network error - cannot reach authentication server (${error.code})`,
          );
        }
      }
      throw new Error(
        `Cannot initialize session for destination "${destination}": provider error - ${getErrorMessage(error)}`,
      );
    }

    const token = tokenResult.connectionConfig.authorizationToken;
    if (!token) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }

    const tokenLength = token.length;
    this.logger?.info(
      `Step 0: Token initialized for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`,
    );

    // Get serviceUrl from service key store if not in connectionConfig
    const serviceKeyConnConfig =
      await this.serviceKeyStore.getConnectionConfig(destination);
    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...tokenResult.connectionConfig,
      serviceUrl:
        tokenResult.connectionConfig.serviceUrl ||
        serviceKeyConnConfig?.serviceUrl ||
        serviceUrl,
    };

    await this.saveTokenToSession(destination, connectionConfigWithServiceUrl, {
      ...serviceKeyAuthConfig,
      refreshToken:
        tokenResult.refreshToken || serviceKeyAuthConfig.refreshToken,
    });

    return token;
  }

  /**
   * Validate existing token (Step 1)
   */
  private async validateExistingToken(
    destination: string,
    token: string,
    serviceUrl: string,
  ): Promise<boolean> {
    if (!this.tokenProvider?.validateToken) {
      return false;
    }

    try {
      const isValid = await this.tokenProvider.validateToken(token, serviceUrl);
      if (isValid) {
        this.logger?.info(
          `Step 1: Token valid for ${destination}: token(${token.length} chars)`,
        );
        return true;
      }
      this.logger?.debug(
        `Step 1: Token invalid for ${destination}, continuing to refresh`,
      );
      return false;
    } catch (error: any) {
      // Validation failed due to network/server error - log and continue to refresh
      this.logger?.warn(
        `Step 1: Token validation failed for ${destination} (network error): ${getErrorMessage(error)}. Continuing to refresh.`,
      );
      return false;
    }
  }

  /**
   * Refresh token from session (Step 2a)
   */
  private async refreshTokenFromSession(
    destination: string,
    uaaCredentials: IAuthorizationConfig,
    refreshToken: string,
    serviceUrl: string,
  ): Promise<string> {
    this.logger?.debug(
      `Step 2a: Trying refreshTokenFromSession for ${destination}`,
    );

    const authConfigWithRefresh = { ...uaaCredentials, refreshToken };
    const refreshTokenFromSession = this.tokenProvider.refreshTokenFromSession;
    if (!refreshTokenFromSession) {
      throw new Error(
        'AuthBroker: tokenProvider.refreshTokenFromSession is required',
      );
    }
    let tokenResult: Awaited<ReturnType<typeof refreshTokenFromSession>>;

    try {
      tokenResult = await refreshTokenFromSession(authConfigWithRefresh, {
        browser: this.browser,
        logger: this.logger,
      });
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND'
        ) {
          this.logger?.debug(
            `Step 2a: Network error during refreshTokenFromSession for ${destination}: ${error.code}. Trying refreshTokenFromServiceKey`,
          );
          throw error; // Re-throw to trigger fallback to Step 2b
        }
      }
      throw error; // Re-throw other errors
    }

    const token = tokenResult.connectionConfig.authorizationToken;
    if (!token) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }

    const tokenLength = token.length;
    this.logger?.info(
      `Step 2a: Token refreshed from session for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`,
    );

    // Get serviceUrl from session or service key
    let serviceKeyServiceUrl: string | undefined;
    if (this.serviceKeyStore) {
      try {
        const serviceKeyConn =
          await this.serviceKeyStore.getConnectionConfig(destination);
        serviceKeyServiceUrl = serviceKeyConn?.serviceUrl;
      } catch (error: any) {
        this.logger?.debug(
          `Could not get serviceUrl from service key store: ${getErrorMessage(error)}`,
        );
      }
    }
    const finalServiceUrl =
      tokenResult.connectionConfig.serviceUrl ||
      serviceUrl ||
      serviceKeyServiceUrl;

    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...tokenResult.connectionConfig,
      serviceUrl: finalServiceUrl,
    };

    const authorizationConfig: IAuthorizationConfig = {
      ...uaaCredentials,
      refreshToken: tokenResult.refreshToken || refreshToken,
    };

    await this.saveTokenToSession(
      destination,
      connectionConfigWithServiceUrl,
      authorizationConfig,
    );

    return token;
  }

  /**
   * Refresh token from service key (Step 2b)
   */
  private async refreshTokenFromServiceKey(
    destination: string,
    uaaCredentials: IAuthorizationConfig,
    serviceUrl: string,
  ): Promise<string> {
    if (!this.allowBrowserAuth) {
      const error = new Error(
        `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. Token refresh via session failed and browser auth is not allowed. Either enable browser auth or ensure a valid refresh token exists in session.`,
      ) as Error & { code: string; destination: string };
      error.code = 'BROWSER_AUTH_REQUIRED';
      error.destination = destination;
      this.logger?.error(
        `Step 2b: Browser auth required but disabled for ${destination}`,
      );
      throw error;
    }

    this.logger?.debug(
      `Step 2b: Trying refreshTokenFromServiceKey for ${destination}`,
    );

    const refreshTokenFromServiceKey =
      this.tokenProvider.refreshTokenFromServiceKey;
    if (!refreshTokenFromServiceKey) {
      throw new Error(
        'AuthBroker: tokenProvider.refreshTokenFromServiceKey is required',
      );
    }
    let tokenResult: Awaited<ReturnType<typeof refreshTokenFromServiceKey>>;
    try {
      tokenResult = await refreshTokenFromServiceKey(uaaCredentials, {
        browser: this.browser,
        logger: this.logger,
      });
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === 'VALIDATION_ERROR') {
          throw new Error(
            `Token refresh failed: Missing required fields in authConfig - ${error.missingFields?.join(', ')}`,
          );
        } else if (error.code === 'BROWSER_AUTH_ERROR') {
          throw new Error(
            `Token refresh failed: Browser authentication failed or was cancelled - ${getErrorMessage(error)}`,
          );
        } else if (
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND'
        ) {
          throw new Error(
            `Token refresh failed: Network error - ${error.code}: Cannot reach authentication server`,
          );
        } else if (error.code === 'SERVICE_KEY_ERROR') {
          throw new Error(
            `Token refresh failed: Service key not found or invalid for ${destination}`,
          );
        }
      }
      throw new Error(
        `Token refresh failed for ${destination}: ${getErrorMessage(error)}`,
      );
    }

    const token = tokenResult.connectionConfig.authorizationToken;
    if (!token) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }

    const tokenLength = token.length;
    this.logger?.info(
      `Step 2b: Token refreshed from service key for ${destination}: token(${tokenLength} chars), hasRefreshToken(${!!tokenResult.refreshToken})`,
    );

    // Get serviceUrl from session or service key
    let serviceKeyServiceUrl: string | undefined;
    if (this.serviceKeyStore) {
      try {
        const serviceKeyConn =
          await this.serviceKeyStore.getConnectionConfig(destination);
        serviceKeyServiceUrl = serviceKeyConn?.serviceUrl;
      } catch (error: any) {
        this.logger?.debug(
          `Could not get serviceUrl from service key store: ${getErrorMessage(error)}`,
        );
      }
    }
    const finalServiceUrl =
      tokenResult.connectionConfig.serviceUrl ||
      serviceUrl ||
      serviceKeyServiceUrl;

    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...tokenResult.connectionConfig,
      serviceUrl: finalServiceUrl,
    };

    const authorizationConfig: IAuthorizationConfig = {
      ...uaaCredentials,
      refreshToken: tokenResult.refreshToken || uaaCredentials.refreshToken,
    };

    await this.saveTokenToSession(
      destination,
      connectionConfigWithServiceUrl,
      authorizationConfig,
    );

    return token;
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

    // Load session data
    const { connConfig, authConfig } = await this.loadSessionData(destination);

    // Get serviceUrl (required)
    const serviceUrl = await this.getServiceUrl(destination, connConfig);

    // Check if we have token or UAA credentials
    const hasToken = !!connConfig?.authorizationToken;
    const hasUaaCredentials = !!(
      authConfig?.uaaUrl &&
      authConfig?.uaaClientId &&
      authConfig?.uaaClientSecret
    );

    this.logger?.debug(
      `Session check for ${destination}: hasToken(${hasToken}), hasUaaCredentials(${hasUaaCredentials}), serviceUrl(${serviceUrl ? 'yes' : 'no'})`,
    );

    // Step 0: Initialize Session with Token (if needed)
    if (!hasToken && !hasUaaCredentials) {
      try {
        return await this.initializeSessionFromServiceKey(
          destination,
          serviceUrl,
        );
      } catch (error: any) {
        // Re-throw BROWSER_AUTH_REQUIRED error without wrapping
        if (hasErrorCode(error) && error.code === 'BROWSER_AUTH_REQUIRED') {
          throw error;
        }
        // Handle typed store errors
        if (hasErrorCode(error)) {
          if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
            throw new Error(
              `Cannot initialize session for destination "${destination}": service key file not found`,
            );
          } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
            throw new Error(
              `Cannot initialize session for destination "${destination}": service key parsing failed - ${getErrorMessage(error)}`,
            );
          } else if (error.code === STORE_ERROR_CODES.INVALID_CONFIG) {
            throw new Error(
              `Cannot initialize session for destination "${destination}": invalid service key - missing ${error.missingFields?.join(', ') || 'required fields'}`,
            );
          }
        }
        throw error;
      }
    }

    // Step 1: Validate existing token
    if (hasToken && connConfig?.authorizationToken) {
      const isValid = await this.validateExistingToken(
        destination,
        connConfig.authorizationToken,
        serviceUrl,
      );
      if (isValid) {
        return connConfig.authorizationToken;
      }
      // If no validation or validation failed, continue to refresh
      if (!this.tokenProvider?.validateToken) {
        this.logger?.info(
          `Token found for ${destination} (no validation): token(${connConfig.authorizationToken.length} chars)`,
        );
        return connConfig.authorizationToken;
      }
    }

    // Step 2: Refresh Token Flow
    this.logger?.debug(`Step 2: Attempting token refresh for ${destination}`);

    const uaaCredentials = await this.getUaaCredentials(
      destination,
      authConfig,
    );

    // Step 2a: Try refresh from session (if refresh token exists)
    const refreshToken = authConfig?.refreshToken;
    if (refreshToken) {
      try {
        return await this.refreshTokenFromSession(
          destination,
          uaaCredentials,
          refreshToken,
          serviceUrl,
        );
      } catch (error: any) {
        this.logger?.debug(
          `Step 2a: refreshTokenFromSession failed for ${destination}: ${getErrorMessage(error)}, trying refreshTokenFromServiceKey`,
        );
        // Continue to try service key refresh
      }
    } else {
      this.logger?.debug(
        `Step 2a: No refresh token in session for ${destination}, skipping to service key refresh`,
      );
    }

    // Step 2b: Try refresh from service key (browser authentication)
    return await this.refreshTokenFromServiceKey(
      destination,
      uaaCredentials,
      serviceUrl,
    );
  }

  /**
   * Force refresh token for destination.
   * Uses refresh token from session if available, otherwise uses UAA credentials from session or service key.
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to new JWT token string
   */
  async refreshToken(destination: string): Promise<string> {
    this.logger?.debug(
      `Force refreshing token for destination: ${destination}`,
    );

    // Call getToken to trigger full refresh flow
    return this.getToken(destination);
  }

  /**
   * Get authorization configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns Promise that resolves to IAuthorizationConfig or null if not found
   */
  async getAuthorizationConfig(
    destination: string,
  ): Promise<IAuthorizationConfig | null> {
    this.logger?.debug(`Getting authorization config for ${destination}`);

    // Try session store first (has tokens)
    this.logger?.debug(
      `Checking session store for authorization config: ${destination}`,
    );
    let sessionAuthConfig: IAuthorizationConfig | null = null;
    try {
      sessionAuthConfig =
        await this.sessionStore.getAuthorizationConfig(destination);
    } catch (error: any) {
      this.logger?.warn(
        `Failed to get authorization config from session store for ${destination}: ${getErrorMessage(error)}`,
      );
    }
    if (sessionAuthConfig) {
      this.logger?.debug(
        `Authorization config from session for ${destination}: hasUaaUrl(${!!sessionAuthConfig.uaaUrl}), hasRefreshToken(${!!sessionAuthConfig.refreshToken})`,
      );
      return sessionAuthConfig;
    }

    // Fall back to service key store (has UAA credentials) if available
    if (this.serviceKeyStore) {
      this.logger?.debug(
        `Checking service key store for authorization config: ${destination}`,
      );
      let serviceKeyAuthConfig: IAuthorizationConfig | null = null;
      try {
        serviceKeyAuthConfig =
          await this.serviceKeyStore.getAuthorizationConfig(destination);
      } catch (error: any) {
        // Handle typed store errors
        if (hasErrorCode(error)) {
          if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
            this.logger?.debug(
              `Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`,
            );
          } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
            this.logger?.warn(
              `Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
            );
          } else {
            this.logger?.warn(
              `Failed to get authorization config from service key store for ${destination}: ${getErrorMessage(error)}`,
            );
          }
        } else {
          this.logger?.warn(
            `Failed to get authorization config from service key store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      }
      if (serviceKeyAuthConfig) {
        this.logger?.debug(
          `Authorization config from service key for ${destination}: hasUaaUrl(${!!serviceKeyAuthConfig.uaaUrl})`,
        );
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
  async getConnectionConfig(
    destination: string,
  ): Promise<IConnectionConfig | null> {
    this.logger?.debug(`Getting connection config for ${destination}`);

    // Try session store first (has tokens and URLs)
    let sessionConnConfig: IConnectionConfig | null = null;
    try {
      sessionConnConfig =
        await this.sessionStore.getConnectionConfig(destination);
    } catch (error: any) {
      this.logger?.warn(
        `Failed to get connection config from session store for ${destination}: ${getErrorMessage(error)}`,
      );
    }
    if (sessionConnConfig) {
      this.logger?.debug(
        `Connection config from session for ${destination}: token(${sessionConnConfig.authorizationToken?.length || 0} chars), serviceUrl(${sessionConnConfig.serviceUrl ? 'yes' : 'no'})`,
      );
      return sessionConnConfig;
    }

    // Fall back to service key store (has URLs but no tokens) if available
    if (this.serviceKeyStore) {
      let serviceKeyConnConfig: IConnectionConfig | null = null;
      try {
        serviceKeyConnConfig =
          await this.serviceKeyStore.getConnectionConfig(destination);
      } catch (error: any) {
        // Handle typed store errors
        if (hasErrorCode(error)) {
          if (error.code === STORE_ERROR_CODES.FILE_NOT_FOUND) {
            this.logger?.debug(
              `Service key file not found for ${destination}: ${error.filePath || 'unknown path'}`,
            );
          } else if (error.code === STORE_ERROR_CODES.PARSE_ERROR) {
            this.logger?.warn(
              `Failed to parse service key for ${destination}: ${error.filePath || 'unknown path'} - ${getErrorMessage(error)}`,
            );
          } else {
            this.logger?.warn(
              `Failed to get connection config from service key store for ${destination}: ${getErrorMessage(error)}`,
            );
          }
        } else {
          this.logger?.warn(
            `Failed to get connection config from service key store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      }
      if (serviceKeyConnConfig) {
        this.logger?.debug(
          `Connection config from service key for ${destination}: serviceUrl(${serviceKeyConnConfig.serviceUrl ? 'yes' : 'no'}), token(none)`,
        );
        return serviceKeyConnConfig;
      }
    } else {
      this.logger?.debug(`Service key store not available for ${destination}`);
    }

    this.logger?.debug(`No connection config found for ${destination}`);
    return null;
  }

  /**
   * Create a token refresher for a specific destination.
   *
   * The token refresher is designed to be injected into JwtAbapConnection via DI,
   * allowing the connection to handle token refresh transparently without knowing
   * about authentication internals.
   *
   * **Usage:**
   * ```typescript
   * const broker = new AuthBroker(config);
   * const tokenRefresher = broker.createTokenRefresher('TRIAL');
   * const connection = new JwtAbapConnection(config, tokenRefresher);
   * ```
   *
   * @param destination Destination name (e.g., "TRIAL")
   * @returns ITokenRefresher implementation for the given destination
   */
  createTokenRefresher(destination: string): ITokenRefresher {
    const broker = this;

    return {
      /**
       * Get current valid token.
       * Returns cached token if valid, otherwise refreshes and returns new token.
       */
      async getToken(): Promise<string> {
        return broker.getToken(destination);
      },

      /**
       * Force refresh token and save to session store.
       * Always performs refresh, ignoring cached token validity.
       */
      async refreshToken(): Promise<string> {
        return broker.refreshToken(destination);
      },
    };
  }
}
