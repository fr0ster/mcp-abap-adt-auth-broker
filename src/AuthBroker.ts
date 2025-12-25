/**
 * Main AuthBroker class for managing JWT tokens based on destinations
 */

import {
  type ILogger,
  type ITokenRefresher,
  type ITokenResult,
  STORE_ERROR_CODES,
} from '@mcp-abap-adt/interfaces';
import type { ITokenProvider } from './providers';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';
import { formatExpirationDate, formatToken } from './utils/formatting';

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
    if (typeof tokenProvider.getTokens !== 'function') {
      throw new Error('AuthBroker: tokenProvider.getTokens must be a function');
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
    this.logger?.info('[AuthBroker] Broker initialized', {
      hasServiceKeyStore,
      hasSessionStore: true,
      hasTokenProvider: true,
      browser: this.browser,
      allowBrowserAuth: this.allowBrowserAuth,
    });
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
  private async getAuthorizationConfigFromServiceKey(
    destination: string,
  ): Promise<IAuthorizationConfig> {
    if (!this.serviceKeyStore) {
      throw new Error(
        `Authorization config not found for ${destination}. Session has no auth config and serviceKeyStore is not available.`,
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
            `Failed to get authorization config from service key store for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      } else {
        this.logger?.warn(
          `Failed to get authorization config from service key store for ${destination}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (!serviceKeyAuthConfig) {
      throw new Error(
        `Authorization config not found for ${destination}. Session has no auth config${this.serviceKeyStore ? ' and serviceKeyStore has no auth config' : ' and serviceKeyStore is not available'}.`,
      );
    }

    return serviceKeyAuthConfig;
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

  private async requestTokens(
    destination: string,
    sourceLabel: string,
  ): Promise<ITokenResult> {
    this.logger?.info(
      `[AuthBroker] Requesting tokens for ${destination} via ${sourceLabel}`,
    );
    try {
      const getTokens = this.tokenProvider.getTokens;
      if (!getTokens) {
        throw new Error('AuthBroker: tokenProvider.getTokens is required');
      }
      const tokenResult = await getTokens.call(this.tokenProvider);
      const expiresAt = tokenResult.expiresIn
        ? Date.now() + tokenResult.expiresIn * 1000
        : undefined;
      this.logger?.info(`[AuthBroker] Tokens received for ${destination}`, {
        authorizationToken: formatToken(tokenResult.authorizationToken),
        hasRefreshToken: !!tokenResult.refreshToken,
        refreshToken: formatToken(tokenResult.refreshToken),
        authType: tokenResult.authType,
        expiresIn: tokenResult.expiresIn,
        expiresAt: expiresAt ? formatExpirationDate(expiresAt) : undefined,
      });
      return tokenResult;
    } catch (error: any) {
      if (hasErrorCode(error)) {
        if (error.code === 'VALIDATION_ERROR') {
          throw new Error(
            `Token provider validation failed for ${destination}: missing ${error.missingFields?.join(', ') || 'required fields'}`,
          );
        }
        if (error.code === 'BROWSER_AUTH_ERROR') {
          throw new Error(
            `Token provider browser authentication failed for ${destination}: ${getErrorMessage(error)}`,
          );
        }
        if (
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND'
        ) {
          throw new Error(
            `Token provider network error for ${destination}: ${error.code}`,
          );
        }
        if (error.code === 'SERVICE_KEY_ERROR') {
          throw new Error(
            `Token provider service key error for ${destination}: ${getErrorMessage(error)}`,
          );
        }
      }
      throw new Error(
        `Token provider error for ${destination}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async persistTokenResult(
    destination: string,
    serviceUrl: string,
    baseConnConfig: IConnectionConfig | null,
    authConfig: IAuthorizationConfig,
    tokenResult: ITokenResult,
  ): Promise<void> {
    const token = tokenResult.authorizationToken;
    if (!token) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }

    const connectionConfigWithServiceUrl: IConnectionConfig = {
      ...baseConnConfig,
      serviceUrl,
      authorizationToken: token,
      authType: 'jwt',
    };

    const authorizationConfig: IAuthorizationConfig = {
      ...authConfig,
      refreshToken: tokenResult.refreshToken ?? authConfig.refreshToken,
    };

    const expiresAt = tokenResult.expiresIn
      ? Date.now() + tokenResult.expiresIn * 1000
      : undefined;
    this.logger?.info(
      `[AuthBroker] Saving tokens to session for ${destination}`,
      {
        serviceUrl,
        authorizationToken: formatToken(token),
        hasRefreshToken: !!authorizationConfig.refreshToken,
        refreshToken: formatToken(authorizationConfig.refreshToken),
        expiresIn: tokenResult.expiresIn,
        expiresAt: expiresAt ? formatExpirationDate(expiresAt) : undefined,
      },
    );

    await this.saveTokenToSession(
      destination,
      connectionConfigWithServiceUrl,
      authorizationConfig,
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
    this.logger?.info(
      `[AuthBroker] Getting token for destination: ${destination}`,
    );

    // Load session data
    const { connConfig, authConfig } = await this.loadSessionData(destination);

    // Get serviceUrl (required)
    const serviceUrl = await this.getServiceUrl(destination, connConfig);

    // Check if we have token or UAA credentials
    const hasToken = !!connConfig?.authorizationToken;
    const hasAuthConfig = !!authConfig;

    this.logger?.info(`[AuthBroker] Session check for ${destination}`, {
      hasToken,
      hasAuthConfig,
      hasServiceUrl: !!serviceUrl,
      serviceUrl,
      authorizationToken: formatToken(connConfig?.authorizationToken),
      hasRefreshToken: !!authConfig?.refreshToken,
      refreshToken: formatToken(authConfig?.refreshToken),
    });

    // Step 0: Initialize Session with Token (if needed)
    if (!hasToken && !hasAuthConfig) {
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

      const serviceKeyAuthConfig =
        await this.getAuthorizationConfigFromServiceKey(destination);
      const tokenResult = await this.requestTokens(destination, 'serviceKey');
      await this.persistTokenResult(
        destination,
        serviceUrl,
        connConfig,
        serviceKeyAuthConfig,
        tokenResult,
      );

      this.logger?.info(
        `[AuthBroker] Token retrieved for ${destination} (initialized from service key)`,
        {
          authorizationToken: formatToken(tokenResult.authorizationToken),
        },
      );

      return tokenResult.authorizationToken;
    }

    // Step 1: Request tokens via provider (provider handles token lifecycle internally)
    // Broker always calls provider.getTokens() - provider decides whether to return cached token,
    // refresh, or perform login. Consumer doesn't need to know about token issues.
    this.logger?.debug(
      `Step 1: Requesting tokens via provider for ${destination}`,
    );

    let lastError: Error | null = null;
    if (authConfig) {
      if (!this.allowBrowserAuth && !authConfig.refreshToken) {
        const error = new Error(
          `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. Session has no refresh token.`,
        ) as Error & { code: string; destination: string };
        error.code = 'BROWSER_AUTH_REQUIRED';
        error.destination = destination;
        this.logger?.error(
          `Step 2: Browser auth required but disabled for ${destination}`,
        );
        throw error;
      }
      try {
        const tokenResult = await this.requestTokens(destination, 'session');
        await this.persistTokenResult(
          destination,
          serviceUrl,
          connConfig,
          authConfig,
          tokenResult,
        );
        this.logger?.info(
          `[AuthBroker] Token retrieved for ${destination} (via session)`,
          {
            authorizationToken: formatToken(tokenResult.authorizationToken),
          },
        );
        return tokenResult.authorizationToken;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger?.debug(
          `Step 2: Token request via session failed for ${destination}: ${getErrorMessage(error)}, trying service key`,
        );
      }
    }

    if (!this.allowBrowserAuth) {
      const error = new Error(
        `Browser authentication required for destination "${destination}" but allowBrowserAuth is disabled. Token refresh via session failed and browser auth is not allowed. Either enable browser auth or ensure a valid refresh token exists in session.`,
      ) as Error & { code: string; destination: string };
      error.code = 'BROWSER_AUTH_REQUIRED';
      error.destination = destination;
      this.logger?.error(
        `Step 2: Browser auth required but disabled for ${destination}`,
      );
      throw error;
    }

    if (!this.serviceKeyStore) {
      if (lastError) {
        throw lastError;
      }
      throw new Error(
        `Authorization config not found for ${destination}. Session has no auth config and serviceKeyStore is not available.`,
      );
    }

    const serviceKeyAuthConfig =
      await this.getAuthorizationConfigFromServiceKey(destination);
    const tokenResult = await this.requestTokens(destination, 'serviceKey');
    await this.persistTokenResult(
      destination,
      serviceUrl,
      connConfig,
      serviceKeyAuthConfig,
      tokenResult,
    );

    this.logger?.info(
      `[AuthBroker] Token retrieved for ${destination} (fallback to service key)`,
      {
        authorizationToken: formatToken(tokenResult.authorizationToken),
      },
    );

    return tokenResult.authorizationToken;
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
      const tokenLength = sessionConnConfig.authorizationToken?.length || 0;
      const formattedToken = formatToken(sessionConnConfig.authorizationToken);
      this.logger?.debug(
        `Connection config from session for ${destination}: token(${tokenLength} chars${formattedToken ? `, ${formattedToken}` : ''}), serviceUrl(${sessionConnConfig.serviceUrl ? 'yes' : 'no'})`,
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
