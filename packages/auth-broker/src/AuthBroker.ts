/**
 * AuthBroker: tokens for a destination, from a provider, kept in a session store.
 *
 * The broker orchestrates and nothing more. It resolves what the stores know
 * about a destination, hands it to the provider, asks the provider for a token
 * and writes the answer back. Whether a token is still valid, whether to use the
 * refresh token or log in, and how a login is conducted (browser, headless,
 * pasted code) are the provider's decisions — made by its strategy — and the
 * broker does not repeat or override any of them.
 */

import type {
  IRefreshableTokenProvider,
  ITokenRefresher,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import { STORE_ERROR_CODES } from '@mcp-abap-adt/interfaces-auth';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';

const noOpLogger: ILogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * Builds the provider for one destination, from what the stores hold for it.
 *
 * - `authConfig`: the UAA credentials — from the session when it holds them,
 *   else from the service key — with the refresh token the session stored, or
 *   `null` when neither store has credentials (a SAML flow needs none).
 * - `connConfig`: the session's connection config, with `serviceUrl` resolved
 *   and the last token the session stored, so the provider can reuse it while
 *   it is valid.
 *
 * Called once per destination; the broker keeps the provider it returns.
 */
export type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
) => IRefreshableTokenProvider;

/**
 * Configuration object for the AuthBroker constructor
 */
export interface AuthBrokerConfig {
  /** Session store (required) — where tokens and the refresh token are kept */
  sessionStore: ISessionStore;
  /** Service key store (optional) — UAA credentials and the service URL */
  serviceKeyStore?: IServiceKeyStore;
  /**
   * The token provider, or a factory building one per destination.
   *
   * An instance is used as given, for every destination. A factory is seeded
   * with what the stores hold for the destination (see `TokenProviderFactory`).
   */
  provider: IRefreshableTokenProvider | TokenProviderFactory;
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * AuthBroker manages authentication tokens for destinations
 */
export class AuthBroker {
  private readonly logger: ILogger;
  private readonly serviceKeyStore: IServiceKeyStore | undefined;
  private readonly sessionStore: ISessionStore;
  private readonly provider: IRefreshableTokenProvider | TokenProviderFactory;
  private readonly providers = new Map<string, IRefreshableTokenProvider>();

  /**
   * @param config Stores and the provider (instance or factory)
   * @param logger Optional logger. Nothing the broker logs contains a token.
   */
  constructor(config: AuthBrokerConfig, logger?: ILogger) {
    if (!config) {
      throw new Error('AuthBroker: config parameter is required');
    }
    const { sessionStore, serviceKeyStore, provider } = config;
    if (!sessionStore) {
      throw new Error('AuthBroker: sessionStore is required');
    }
    if (!provider) {
      throw new Error('AuthBroker: provider is required');
    }
    for (const method of [
      'getAuthorizationConfig',
      'getConnectionConfig',
      'setAuthorizationConfig',
      'setConnectionConfig',
      'loadSession',
      'saveSession',
    ] as const) {
      if (typeof sessionStore[method] !== 'function') {
        throw new Error(
          `AuthBroker: sessionStore.${method} must be a function`,
        );
      }
    }
    if (typeof provider !== 'function') {
      if (typeof provider.getTokens !== 'function') {
        throw new Error('AuthBroker: provider.getTokens must be a function');
      }
      if (typeof provider.refreshTokens !== 'function') {
        throw new Error(
          'AuthBroker: provider.refreshTokens must be a function',
        );
      }
    }
    if (serviceKeyStore) {
      for (const method of [
        'getServiceKey',
        'getAuthorizationConfig',
        'getConnectionConfig',
      ] as const) {
        if (typeof serviceKeyStore[method] !== 'function') {
          throw new Error(
            `AuthBroker: serviceKeyStore.${method} must be a function`,
          );
        }
      }
    }

    this.sessionStore = sessionStore;
    this.serviceKeyStore = serviceKeyStore;
    this.provider = provider;
    this.logger = logger ?? noOpLogger;
    this.logger.debug('[AuthBroker] Broker initialized', {
      hasServiceKeyStore: !!serviceKeyStore,
      providerForm: typeof provider === 'function' ? 'factory' : 'instance',
    });
  }

  /**
   * A token for the destination: the provider's current one, which it refreshes
   * or obtains by login when it judges the cached one unusable.
   *
   * The result is written to the session store. Errors from the provider
   * (its typed errors included) propagate unchanged.
   */
  async getToken(destination: string): Promise<string> {
    return this.obtain(destination, 'getTokens');
  }

  /**
   * A new token for the destination, never the cached one — for a caller whose
   * token the server has just refused. Calls the provider's `refreshTokens()`,
   * writes the result to the session store and returns it.
   */
  async refreshToken(destination: string): Promise<string> {
    return this.obtain(destination, 'refreshTokens');
  }

  private async obtain(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
  ): Promise<string> {
    const connConfig = await this.read(
      destination,
      'session connection config',
      () => this.sessionStore.getConnectionConfig(destination),
    );
    const serviceUrl = await this.resolveServiceUrl(destination, connConfig);
    const provider = await this.providerFor(
      destination,
      serviceUrl,
      connConfig,
    );

    this.logger.debug(`[AuthBroker] ${method} for ${destination}`);
    const result = await provider[method]();
    if (!result?.authorizationToken) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }
    await this.persist(destination, serviceUrl, connConfig, result);
    return result.authorizationToken;
  }

  private async providerFor(
    destination: string,
    serviceUrl: string,
    connConfig: IConnectionConfig | null,
  ): Promise<IRefreshableTokenProvider> {
    if (typeof this.provider !== 'function') {
      return this.provider;
    }
    const existing = this.providers.get(destination);
    if (existing) {
      return existing;
    }
    const authConfig = await this.resolveAuthorizationConfig(destination);
    const built = this.provider(destination, authConfig, {
      ...(connConfig ?? {}),
      serviceUrl,
    });
    this.providers.set(destination, built);
    this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
      hasCredentials: !!authConfig,
      hasRefreshToken: !!authConfig?.refreshToken,
      hasStoredToken: !!(
        connConfig?.authorizationToken || connConfig?.sessionCookies
      ),
    });
    return built;
  }

  /**
   * The credentials the provider is built with: the session's own when it holds
   * them, else the service key's, carrying the refresh token the session
   * stored. The session keeps a refresh token without credentials when the
   * credentials came from the service key, since the broker does not copy the
   * client secret into it; `loadSession` is where such a token is read.
   */
  private async resolveAuthorizationConfig(
    destination: string,
  ): Promise<IAuthorizationConfig | null> {
    const sessionAuth = await this.read(
      destination,
      'session authorization config',
      () => this.sessionStore.getAuthorizationConfig(destination),
    );
    if (sessionAuth) {
      return sessionAuth;
    }
    const session = await this.read(destination, 'session', () =>
      this.sessionStore.loadSession(destination),
    );
    const storedRefreshToken =
      typeof session?.refreshToken === 'string'
        ? session.refreshToken
        : undefined;
    const serviceKeyStore = this.serviceKeyStore;
    const keyAuth = serviceKeyStore
      ? await this.read(destination, 'service key authorization config', () =>
          serviceKeyStore.getAuthorizationConfig(destination),
        )
      : null;
    if (!keyAuth) {
      return null;
    }
    return {
      ...keyAuth,
      refreshToken: storedRefreshToken ?? keyAuth.refreshToken,
    };
  }

  private async resolveServiceUrl(
    destination: string,
    connConfig: IConnectionConfig | null,
  ): Promise<string> {
    let serviceUrl = connConfig?.serviceUrl;
    const serviceKeyStore = this.serviceKeyStore;
    if (!serviceUrl && serviceKeyStore) {
      const keyConn = await this.read(
        destination,
        'service key connection config',
        () => serviceKeyStore.getConnectionConfig(destination),
      );
      serviceUrl = keyConn?.serviceUrl;
    }
    if (!serviceUrl) {
      throw new Error(
        `Session for destination "${destination}" is missing required field 'serviceUrl'. ` +
          `SessionStore must contain initial session with serviceUrl${this.serviceKeyStore ? ' or serviceKeyStore must contain serviceUrl' : ''}.`,
      );
    }
    return serviceUrl;
  }

  /**
   * Writes the result by its type: a SAML result is session cookies, anything
   * else a bearer token. The refresh token is written only when the result has
   * one, so a provider that returns none does not erase the stored one.
   *
   * `ITokenResult.expiresAt` has no field in `IConnectionConfig` to go to; the
   * provider seeded with the stored token reads the expiry from the JWT itself.
   */
  private async persist(
    destination: string,
    serviceUrl: string,
    connConfig: IConnectionConfig | null,
    result: ITokenResult,
  ): Promise<void> {
    const isSaml = result.tokenType === 'saml';
    await this.sessionStore.setConnectionConfig(destination, {
      ...(connConfig ?? {}),
      serviceUrl,
      authorizationToken: isSaml ? undefined : result.authorizationToken,
      sessionCookies: isSaml ? result.authorizationToken : undefined,
      authType: isSaml ? 'saml' : 'jwt',
    });

    if (result.refreshToken) {
      const sessionAuth = await this.read(
        destination,
        'session authorization config',
        () => this.sessionStore.getAuthorizationConfig(destination),
      );
      if (sessionAuth) {
        // The session holds its own credentials: only the refresh token changes.
        await this.sessionStore.setAuthorizationConfig(destination, {
          ...sessionAuth,
          refreshToken: result.refreshToken,
        });
      } else {
        // The credentials live in the service key and stay there. The session
        // gets the refresh token alone — never the client secret.
        const session = await this.read(destination, 'session', () =>
          this.sessionStore.loadSession(destination),
        );
        await this.sessionStore.saveSession(destination, {
          ...(session ?? {}),
          serviceUrl: session?.serviceUrl ?? serviceUrl,
          refreshToken: result.refreshToken,
        });
      }
    }

    this.logger.info(`[AuthBroker] Token saved for ${destination}`, {
      tokenType: result.tokenType ?? 'jwt',
      authType: result.authType,
      hasRefreshToken: !!result.refreshToken,
      expiresAt: result.expiresAt
        ? new Date(result.expiresAt).toISOString()
        : undefined,
      expiresIn: result.expiresIn,
    });
  }

  /**
   * A store read where absence is an answer and anything else is not.
   *
   * A store says "nothing here" with `null`, or with `FILE_NOT_FOUND`, and the
   * flow goes on to the next source. Any other failure — a service key that is
   * not valid JSON, a file the process may not read — is a different problem
   * with a different fix, and reaches the caller as the store raised it. It
   * used to be logged and answered as absent, so the caller saw only the
   * consequence ("missing required field 'serviceUrl'") and went looking for a
   * file that was there.
   */
  private async read<T>(
    destination: string,
    what: string,
    fn: () => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      if (errorCode(error) === STORE_ERROR_CODES.FILE_NOT_FOUND) {
        this.logger.debug(`No ${what} for ${destination}: file not found`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Authorization configuration for the destination: the session's, else the
   * service key's, else null.
   */
  async getAuthorizationConfig(
    destination: string,
  ): Promise<IAuthorizationConfig | null> {
    const sessionAuth = await this.read(
      destination,
      'session authorization config',
      () => this.sessionStore.getAuthorizationConfig(destination),
    );
    if (sessionAuth) {
      return sessionAuth;
    }
    const serviceKeyStore = this.serviceKeyStore;
    if (!serviceKeyStore) {
      return null;
    }
    return this.read(destination, 'service key authorization config', () =>
      serviceKeyStore.getAuthorizationConfig(destination),
    );
  }

  /**
   * Connection configuration for the destination: the session's, else the
   * service key's (which has URLs but no token), else null.
   */
  async getConnectionConfig(
    destination: string,
  ): Promise<IConnectionConfig | null> {
    const sessionConn = await this.read(
      destination,
      'session connection config',
      () => this.sessionStore.getConnectionConfig(destination),
    );
    if (sessionConn) {
      return sessionConn;
    }
    const serviceKeyStore = this.serviceKeyStore;
    if (!serviceKeyStore) {
      return null;
    }
    return this.read(destination, 'service key connection config', () =>
      serviceKeyStore.getConnectionConfig(destination),
    );
  }

  /**
   * An `ITokenRefresher` for one destination, for injection into a connection:
   * `getToken()` is the broker's `getToken`, `refreshToken()` its forced
   * `refreshToken`.
   */
  createTokenRefresher(destination: string): ITokenRefresher {
    return {
      getToken: () => this.getToken(destination),
      refreshToken: () => this.refreshToken(destination),
    };
  }
}
