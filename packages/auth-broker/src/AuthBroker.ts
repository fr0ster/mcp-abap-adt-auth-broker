/**
 * AuthBroker: the credential for a destination, and tokens for one.
 *
 * `getProvider` builds the `IAuthProvider` a destination states, from the
 * means its service key store holds and the secret its session store holds.
 * Every token provider it builds writes what it obtains back to the session
 * store through `onTokens` — the secret alone, retried by the broker when the
 * store fails (`SessionWriter`); `flush()` reports what is still pending.
 * The token API (`getToken`, `refreshToken`, `createTokenRefresher`) asks that
 * same provider — one per destination, shared — or, when the consumer gives
 * one, the consumer's provider, whose every answer it writes through the same
 * path.
 *
 * The broker orchestrates and nothing more. It resolves what the stores know
 * about a destination, hands it to the provider, asks the provider for a token
 * and writes the answer back. Whether a token is still valid, whether to use the
 * refresh token or log in, and how a login is conducted (browser, headless,
 * pasted code) are the provider's decisions — made by its strategy — and the
 * broker does not repeat or override any of them.
 */

import type {
  IDeviceCodePresenter,
  OidcCallbackResult,
} from '@mcp-abap-adt/auth-providers';
import type {
  IAssertionReplayStore,
  IAuthorizationStrategy,
  IAuthProvider,
  IClientAuthentication,
  IRefreshableTokenProvider,
  ITokenRefresher,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import { STORE_ERROR_CODES } from '@mcp-abap-adt/interfaces-auth';
import type { IConfig } from '@mcp-abap-adt/interfaces-auth-broker';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  type Binding,
  boundHere,
  consumerBinding,
  strategyBinding,
} from './binding';
import { destinationBinding } from './bindingOf';
import {
  type ClientAuthenticationStrategy,
  type ClientIdentity,
  clientAuthenticationContext,
  clientIdentity,
  contextClient,
  resolveClientAuthentication,
} from './clientAuthentication';
import { DestinationConfigError } from './DestinationConfigError';
import {
  basicProvider,
  handedOverProvider,
  isOidcGrant,
  isSamlGrant,
  isUaaGrant,
  oidcProvider,
  type RowClient,
  samlProvider,
  sncProvider,
  statedAuthType,
  statedGrant,
  uaaProvider,
} from './destinations';
import { SessionWriter } from './SessionWriter';
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
 * - `client` (optional): passed only beside a `clientAuthentication` strategy,
 *   for a destination whose grant authenticates a client — the strategy's
 *   answer, the client identity and the bound refresh token; never PEM. See
 *   `TokenProviderClient`. Without a strategy the factory gets three
 *   arguments, as 4.0.0.
 *
 * Called once per destination; the broker keeps the provider it returns.
 */
export type TokenProviderFactory = (
  destination: string,
  authConfig: IAuthorizationConfig | null,
  connConfig: IConnectionConfig,
  client?: TokenProviderClient,
) => IRefreshableTokenProvider;

/**
 * The token API factory's fourth argument — present only when the broker was
 * given a `clientAuthentication` strategy and the destination states a grant
 * whose client authenticates; without one the factory is called with three
 * arguments, as 4.0.0. It never carries a certificate, a key or a secret.
 */
export interface TokenProviderClient {
  /** The strategy's answer, resolved before the factory is called. */
  readonly clientAuthentication?: IClientAuthentication;
  /**
   * The client's identity — the secret client's `uaaUrl` when the stores hold
   * one, else the certificate client's; absent when there is neither.
   */
  readonly uaaUrl?: string;
  /** The client id beside `uaaUrl`, from the same client. */
  readonly clientId?: string;
  /**
   * The refresh token the session stored, only when the session is bound to
   * this resource and this client identity — as `authConfig` carries it on
   * the strategy path for a secret client, so a certificate client, whose
   * `authConfig` is `null`, gets it too.
   */
  readonly refreshToken?: string;
}

/** The grants whose provider takes an `IAuthorizationStrategy<string>`. */
export type StrategyGrant =
  | 'authorization_code'
  | 'passcode'
  | 'saml2_pure'
  | 'saml2_bearer';

/**
 * Configuration object for the AuthBroker constructor
 */
export interface AuthBrokerConfig {
  /**
   * Session store (required) — the session secret: the token or cookies,
   * `expiresAt`, the refresh token.
   */
  sessionStore: ISessionStore;
  /**
   * Service key store — the means: `authType`, `grantType`, the client,
   * basic's user and password, the SNC fields, `serviceUrl`. `getProvider`
   * needs it: there is no other source of means.
   */
  serviceKeyStore?: IServiceKeyStore;
  /**
   * The token API's source: the token provider, or a factory building one per
   * destination. Not used by `getProvider`, which builds what the destination
   * states.
   *
   * An instance is used as given, for every destination. A factory is seeded
   * with what the stores hold for the destination (see `TokenProviderFactory`).
   */
  provider?: IRefreshableTokenProvider | TokenProviderFactory;

  // Collaborators — each a function of the destination, called once when that
  // destination's provider is built, each required only by the grants that
  // use it. The broker supplies no default and disposes none.

  /** The interactive strategy of the UAA code, passcode and SAML grants. */
  authorization?: (
    destination: string,
    grant: StrategyGrant,
  ) => IAuthorizationStrategy<string>;
  /** The interactive strategy of the OIDC authorization code grant. */
  oidcAuthorization?: (
    destination: string,
  ) => IAuthorizationStrategy<OidcCallbackResult>;
  /** Where the device flow shows the user its code. */
  deviceCodePresenter?: (destination: string) => IDeviceCodePresenter;
  /** `saml2_pure`: turns the SAMLResponse into the system's session cookies. */
  samlCookies?: (
    destination: string,
  ) => (samlResponse: string) => Promise<string>;
  /** The replay store the SAML assertion validators share. */
  assertionReplayStore?: (destination: string) => IAssertionReplayStore;
  /**
   * How a destination's client authenticates to the authorization server, for
   * every grant that authenticates one (`ClientAuthenticationGrant`). Called
   * once when the destination's provider is built, with the client the key
   * store answers and its certificate, read only if the strategy asks.
   *
   * A given strategy always answers one, or throws: there is no "nothing"
   * answer, so an explicit choice never falls back to the secret. A throw
   * becomes a `DestinationConfigError` naming `clientAuthentication`, in fixed
   * words. Absent: the client secret, as in 4.0.0, and nothing
   * certificate-related is read. Shipped: `fromServiceKeyCertificate()`,
   * `fromServiceKeySecret({ encoding })`.
   *
   * It applies to the providers the broker builds: `getProvider`'s, and the
   * token API's `provider` factory, which gets its answer as a fourth
   * argument (`TokenProviderClient`) for a grant that authenticates a client.
   * An instance given as `provider` is already composed by the consumer, so
   * the token API uses it as given and calls no strategy for it.
   */
  clientAuthentication?: ClientAuthenticationStrategy;
}

/** The session secret's fields on a connection config — never means. */
/** The session's side: the secret and what it is bound to. */
const SECRET_FIELDS = [
  'authorizationToken',
  'sessionCookies',
  'expiresAt',
  'issuedFor',
  'issuedBy',
] as const;
const isSecretField = (field: string): boolean =>
  (SECRET_FIELDS as readonly string[]).includes(field);

/** A connection config without the session secret's fields or a refresh token. */
function withoutSecret(
  config: IConnectionConfig | null,
): Partial<IConnectionConfig> {
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(config ?? {})) {
    if (!isSecretField(field) && field !== 'refreshToken') kept[field] = value;
  }
  return kept as Partial<IConnectionConfig>;
}

/** When the result expires, in epoch ms: its own `expiresAt`, else `expiresIn` from now. */
function expiryOf(result: ITokenResult): number | undefined {
  if (typeof result.expiresAt === 'number') return result.expiresAt;
  if (typeof result.expiresIn === 'number') {
    return Date.now() + Math.round(result.expiresIn * 1000);
  }
  return undefined;
}

/** A token result to write, with the binding it is written with. */
interface BoundResult {
  /** What is written: the result with its expiry fixed when it arrived. */
  result: ITokenResult;
  /**
   * The result as the provider handed it over — the object the provider also
   * returns from `getTokens()` / `refreshTokens()`, so the token API can find
   * the outcome of its write. Never the copy above.
   */
  original: ITokenResult;
  binding: Binding;
  /**
   * Which stored refresh token a result without one carries forward: only one
   * bound where this secret is (`bound`: the providers the broker builds, and
   * a consumer's factory beside a `clientAuthentication` strategy — a secret
   * is reused only where it is bound), or whichever the session holds (`any`:
   * a consumer's provider without a strategy, which the token API seeds with
   * it whatever its binding, as 3.x did).
   */
  carry: 'bound' | 'any';
}

/**
 * A consumer's provider as taken into use for one destination, with the
 * binding fixed then: the resource and the issuer it was built
 * — or, for an instance, first asked — for. Every result it answers for this
 * destination is written with this binding, never one recomputed from means
 * read later: a changed URL or client does not re-label a secret obtained
 * before it; like any other change to a destination, it is picked up by a new
 * broker.
 */
interface ConsumerBuilt {
  provider: IRefreshableTokenProvider;
  binding: Binding;
  /**
   * `any` as 4.0.0 (the provider was seeded with whatever the session held);
   * `bound` on the strategy path, whose provider was seeded only with a
   * session bound to this resource and client identity.
   */
  carry: 'bound' | 'any';
}

/** A provider `getProvider` built that obtains tokens: a token provider. */
function obtainsTokens(
  provider: IAuthProvider,
): provider is IAuthProvider & IRefreshableTokenProvider {
  const candidate = provider as Partial<IRefreshableTokenProvider>;
  return (
    typeof candidate.getTokens === 'function' &&
    typeof candidate.refreshTokens === 'function'
  );
}

/** What the consumer factory's credentials are composed from. */
interface AuthorizationRead {
  readonly sessionAuth: IAuthorizationConfig | null;
  readonly keyAuth: IAuthorizationConfig | null;
  readonly session: IConfig | null;
  /** Whether `session` was read: not when the session held its own client. */
  readonly sessionRead: boolean;
}

/** The refresh token a stored session holds, unchecked. */
function storedRefreshTokenOf(session: IConfig | null): string | undefined {
  return typeof session?.refreshToken === 'string'
    ? session.refreshToken
    : undefined;
}

/**
 * The 3.x composition, the no-strategy path: the session's client as it is,
 * else the key store's with `refreshToken` — the one given, else the key's
 * own. (The strategy path takes `strategyAuthorization`.)
 */
function composeAuthorization(
  read: AuthorizationRead,
  refreshToken: string | undefined,
): IAuthorizationConfig | null {
  if (read.sessionAuth) return read.sessionAuth;
  if (!read.keyAuth) return null;
  return {
    ...read.keyAuth,
    refreshToken: refreshToken ?? read.keyAuth.refreshToken,
  };
}

/**
 * The client on the `clientAuthentication` strategy path: the session's own
 * client, else the key store's, carrying only `refreshToken` — the one the
 * session read whose binding was checked holds, when bound — never a refresh
 * token either client read carried itself.
 */
function strategyAuthorization(
  read: AuthorizationRead,
  refreshToken: string | undefined,
): IAuthorizationConfig | null {
  // The same allowlist the strategy is told (`contextClient`): nothing else a
  // store's authorization-config read carried reaches the factory.
  const client = contextClient(read.sessionAuth ?? read.keyAuth);
  return client ? { ...client, refreshToken } : null;
}

/** A stored string that counts as present: `''` is none. */
function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** A result carrying a token, or the 3.x error for one that carries none. */
function checked(
  destination: string,
  result: ITokenResult | undefined,
): ITokenResult & { authorizationToken: string } {
  if (!result?.authorizationToken) {
    throw new Error(
      `Token provider did not return authorization token for destination "${destination}"`,
    );
  }
  return result as ITokenResult & { authorizationToken: string };
}

/**
 * AuthBroker manages authentication tokens for destinations
 */
export class AuthBroker {
  private readonly logger: ILogger;
  private readonly serviceKeyStore: IServiceKeyStore | undefined;
  private readonly sessionStore: ISessionStore;
  private readonly provider:
    | IRefreshableTokenProvider
    | TokenProviderFactory
    | undefined;
  /** A consumer factory's providers: the promise of the build, as `built`. */
  private readonly consumerBuilt = new Map<string, Promise<ConsumerBuilt>>();
  /**
   * One cache per destination, shared by `getProvider` and — when the
   * consumer gives no provider — the token API: the promise of the
   * build, set before its first read.
   */
  private readonly built = new Map<string, Promise<IAuthProvider>>();
  /**
   * The write that failed for a result, keyed on the result the provider
   * handed over and returns, then on the destination it was written
   * for: the token API throws it to its caller, as 3.x did, while the broker
   * keeps retrying. Dropped once a write of that result for that destination
   * lands.
   */
  private readonly failedWrites = new WeakMap<
    ITokenResult,
    Map<string, { error: unknown }>
  >();
  private readonly authorization: AuthBrokerConfig['authorization'];
  private readonly oidcAuthorization: AuthBrokerConfig['oidcAuthorization'];
  private readonly deviceCodePresenter: AuthBrokerConfig['deviceCodePresenter'];
  private readonly samlCookies: AuthBrokerConfig['samlCookies'];
  private readonly assertionReplayStore: AuthBrokerConfig['assertionReplayStore'];
  private readonly clientAuthentication: AuthBrokerConfig['clientAuthentication'];
  /** getProvider's writes of the session secret, retried on their own. */
  private readonly writer: SessionWriter<BoundResult>;

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
    if (provider && typeof provider !== 'function') {
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
    this.authorization = config.authorization;
    this.oidcAuthorization = config.oidcAuthorization;
    this.deviceCodePresenter = config.deviceCodePresenter;
    this.samlCookies = config.samlCookies;
    this.assertionReplayStore = config.assertionReplayStore;
    this.clientAuthentication = config.clientAuthentication;
    this.logger = logger ?? noOpLogger;
    this.writer = new SessionWriter<BoundResult>(async (destination, bound) => {
      try {
        await this.writeSecret(destination, bound);
      } catch (error) {
        // Per destination: one result object may be answered for several
        // (an instance serves every destination), and a write that lands for
        // one says nothing about another's.
        let failures = this.failedWrites.get(bound.original);
        if (!failures) {
          failures = new Map();
          this.failedWrites.set(bound.original, failures);
        }
        failures.set(destination, { error });
        throw error;
      }
      this.failedWrites.get(bound.original)?.delete(destination);
    }, this.logger);
    this.logger.debug('[AuthBroker] Broker initialized', {
      hasServiceKeyStore: !!serviceKeyStore,
      providerForm:
        provider === undefined
          ? 'none'
          : typeof provider === 'function'
            ? 'factory'
            : 'instance',
    });
  }

  /**
   * A token for the destination: the provider's current one, which it refreshes
   * or obtains by login when it judges the cached one unusable.
   *
   * Without a consumer `provider`, the provider is the one `getProvider` hands
   * out for the destination — the same instance, so one token and one renewal
   * serve both — and what it obtains is written by its `onTokens`. With one,
   * the consumer's provider is asked and its answer written, as in 3.x — the
   * secret alone.
   *
   * Errors from the provider (its typed errors included) propagate unchanged;
   * so does a store failure, a failed write of the token included — the token
   * stands and the broker keeps retrying the write.
   *
   * @throws DestinationConfigError for a destination the key store states as
   *   `basic` or `snc`, before any provider is asked; without a consumer
   *   `provider`, also for one whose provider obtains no token.
   */
  async getToken(destination: string): Promise<string> {
    return this.obtain(destination, 'getTokens');
  }

  /**
   * A new token for the destination, never the cached one — for a caller whose
   * token the server has just refused. Calls the provider's `refreshTokens()`;
   * a renewal already in flight for the destination is joined, not repeated.
   */
  async refreshToken(destination: string): Promise<string> {
    return this.obtain(destination, 'refreshTokens');
  }

  private async obtain(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
  ): Promise<string> {
    const means = await this.statedForTokens(destination);
    const result = this.provider
      ? await this.obtainFromConsumer(destination, method, means)
      : await this.obtainShared(destination, method, means);
    return result.authorizationToken;
  }

  /**
   * The destination's means, read first: a destination the key store states
   * as `basic` or `snc` holds no token, so the token API refuses it before any
   * provider is asked — it would write a token over a credential that is not
   * one. A key store that states no `authType`, or no key store, is
   * a 3.x setup, served as before.
   */
  private async statedForTokens(
    destination: string,
  ): Promise<IConnectionConfig | null> {
    const serviceKeyStore = this.serviceKeyStore;
    const means = serviceKeyStore
      ? await this.read(destination, 'service key connection config', () =>
          serviceKeyStore.getConnectionConfig(destination),
        )
      : null;
    const authType = means?.authType;
    if (authType === 'basic' || authType === 'snc') {
      throw new DestinationConfigError(
        destination,
        ['authType'],
        `the token API serves no ${authType} destination: it holds no token`,
      );
    }
    return means;
  }

  /** The token API on `getProvider`'s provider. */
  private async obtainShared(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
    means: IConnectionConfig | null,
  ): Promise<ITokenResult & { authorizationToken: string }> {
    if (!this.serviceKeyStore) {
      throw new DestinationConfigError(
        destination,
        ['provider', 'serviceKeyStore'],
        'the token API needs the provider option, or a service key store stating a token grant',
      );
    }
    if (
      (means?.authType === 'jwt' || means?.authType === 'saml') &&
      means.grantType === 'none'
    ) {
      throw new DestinationConfigError(
        destination,
        ['provider'],
        'a none destination presents a handed-over credential and obtains no token: use getProvider, or give the token API the provider option',
      );
    }
    const provider = await this.getProvider(destination);
    if (!obtainsTokens(provider)) {
      throw new DestinationConfigError(
        destination,
        ['provider'],
        'the destination states a credential that obtains no token: use getProvider, or give the token API the provider option',
      );
    }
    this.logger.debug(`[AuthBroker] ${method} for ${destination}`);
    const result = checked(destination, await provider[method]());
    // onTokens wrote it, or failed to: the failure is this caller's too.
    this.throwFailedWrite(destination, result);
    return result;
  }

  /**
   * The token API on the consumer's provider, as 3.x: the session read first,
   * then the key store, for `serviceUrl` and the client; every answer — a
   * cache hit included — written, the secret alone, through the broker's one
   * write path.
   */
  private async obtainFromConsumer(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
    means: IConnectionConfig | null,
  ): Promise<ITokenResult & { authorizationToken: string }> {
    const connConfig = await this.read(
      destination,
      'session connection config',
      () => this.sessionStore.getConnectionConfig(destination),
    );
    const serviceUrl = await this.resolveServiceUrl(destination, connConfig);
    const { provider, binding, carry } = await this.consumerProviderFor(
      destination,
      serviceUrl,
      connConfig,
      means,
    );

    this.logger.debug(`[AuthBroker] ${method} for ${destination}`);
    const result = checked(destination, await provider[method]());
    await this.writer.submit(destination, {
      result: { ...result, expiresAt: expiryOf(result) },
      original: result,
      binding,
      carry,
    });
    this.throwFailedWrite(destination, result);
    return result;
  }

  /** The failure recorded for this result's write here, thrown as the store raised it. */
  private throwFailedWrite(destination: string, result: ITokenResult): void {
    const failed = this.failedWrites.get(result)?.get(destination);
    if (failed) {
      throw failed.error;
    }
  }

  /**
   * The consumer's provider for the destination, cached per destination as a
   * promise set before its first read and dropped when it throws, so
   * the next call builds again: a factory's build — handed the client resolved
   * then — or an instance as given, for every destination, handed no client.
   * Either way the binding is fixed here, from the `serviceUrl`, SAP client and
   * client of this first call, and kept with the provider.
   */
  private consumerProviderFor(
    destination: string,
    serviceUrl: string,
    connConfig: IConnectionConfig | null,
    means: IConnectionConfig | null,
  ): Promise<ConsumerBuilt> {
    const cached = this.consumerBuilt.get(destination);
    if (cached) {
      return cached;
    }
    const provider = this.provider as
      | IRefreshableTokenProvider
      | TokenProviderFactory;
    const sapClient = present(connConfig?.sapClient)
      ? connConfig.sapClient
      : means?.sapClient;
    const build = Promise.resolve().then(async (): Promise<ConsumerBuilt> => {
      if (typeof provider !== 'function') {
        return {
          provider,
          binding: consumerBinding(serviceUrl, sapClient, null),
          carry: 'any',
        };
      }
      const read = await this.readAuthorization(destination);
      const strategic = await this.consumerClientAuthentication(
        destination,
        means,
        // The strategy is told the client, never a refresh token read with it.
        strategyAuthorization(read, undefined),
      );
      let built: IRefreshableTokenProvider;
      let client: IAuthorizationConfig | null;
      let binding: Binding;
      let carry: ConsumerBuilt['carry'];
      if (strategic) {
        // The strategy's answer and the client identity, resolved before the
        // factory; the factory called inside the same guard: a throw is fixed
        // words, nothing of the thrown value, no cause. The stored refresh
        // token is carried only when the session is bound to this resource
        // and this client identity — never to another authorization server.
        binding = strategyBinding(
          consumerBinding(serviceUrl, sapClient, strategic.identity),
        );
        const session = read.sessionRead
          ? read.session
          : await this.loadStoredSession(destination);
        const bound = !!session && boundHere(session, binding);
        const boundRefreshToken = bound
          ? storedRefreshTokenOf(session)
          : undefined;
        // The client without any refresh token of its own read: a session
        // store's `getAuthorizationConfig` is another read than the session
        // whose binding was checked, and another process may have written
        // between them. The refresh token comes only from that checked read.
        client = strategyAuthorization(read, boundRefreshToken);
        // Each stored secret is judged by the read it came from: the seed's
        // token, cookies and expiry by the binding the connection read itself
        // carries — another process may have written between the two reads —
        // else only the means seed the provider.
        const seed =
          connConfig && boundHere(connConfig, binding)
            ? { ...connConfig, serviceUrl }
            : { ...withoutSecret(connConfig), serviceUrl };
        carry = 'bound';
        const refreshToken = client ? client.refreshToken : boundRefreshToken;
        const fourth: TokenProviderClient = {
          clientAuthentication: strategic.clientAuthentication,
          ...(strategic.identity
            ? {
                uaaUrl: strategic.identity.uaaUrl,
                clientId: strategic.identity.uaaClientId,
              }
            : {}),
          ...(present(refreshToken) ? { refreshToken } : {}),
        };
        try {
          built = provider(destination, client, seed, fourth);
        } catch {
          throw new DestinationConfigError(
            destination,
            ['provider', 'clientAuthentication'],
            'the token provider factory failed beside the clientAuthentication strategy',
          );
        }
      } else {
        // 4.0.0: the stored secret and refresh token carried over as read.
        client = composeAuthorization(read, storedRefreshTokenOf(read.session));
        binding = consumerBinding(serviceUrl, sapClient, client);
        carry = 'any';
        built = provider(destination, client, {
          ...(connConfig ?? {}),
          serviceUrl,
        });
      }
      this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
        hasCredentials: !!client,
        hasRefreshToken: !!client?.refreshToken,
        hasStoredToken: !!(
          connConfig?.authorizationToken || connConfig?.sessionCookies
        ),
      });
      return { provider: built, binding, carry };
    });
    this.consumerBuilt.set(destination, build);
    build.catch(() => {
      if (this.consumerBuilt.get(destination) === build) {
        this.consumerBuilt.delete(destination);
      }
    });
    return build;
  }

  /**
   * The token API's strategy path: with a `clientAuthentication` strategy and a
   * destination stating a grant whose client authenticates, the strategy's
   * answer — resolved inside the guard — and the client identity: the secret
   * client, else the certificate client's, read through the context's memoised
   * `readCertificate`. `null` without a strategy (4.0.0: nothing
   * certificate-related is asked) and for a grant that authenticates no
   * client (`saml2_pure`, `none`), as `getProvider` decides.
   *
   * The strategy is told the grant, so a destination that states none is
   * refused before it is called rather than built without it. (An instance
   * given as `provider` is the consumer's own composition: the strategy
   * applies only to what the broker builds, so it is not used there.)
   */
  private async consumerClientAuthentication(
    destination: string,
    means: IConnectionConfig | null,
    client: IAuthorizationConfig | null,
  ): Promise<{
    clientAuthentication: IClientAuthentication;
    identity: ClientIdentity | null;
  } | null> {
    const strategy = this.clientAuthentication;
    if (!strategy) {
      return null;
    }
    // basic and snc never get here: the token API refuses them first
    // (`statedForTokens`).
    if (!means || (means.authType !== 'jwt' && means.authType !== 'saml')) {
      throw new DestinationConfigError(
        destination,
        ['authType', 'grantType'],
        'a clientAuthentication strategy is told the grant: the destination must state its authType and grantType',
      );
    }
    const grant = statedGrant(destination, means.authType, means);
    if (grant === 'saml2_pure' || grant === 'none') {
      return null;
    }
    const serviceKeyStore = this.serviceKeyStore;
    const context = clientAuthenticationContext(
      destination,
      grant,
      client,
      () =>
        this.read(destination, 'client certificate', async () =>
          serviceKeyStore?.getClientCertificate
            ? serviceKeyStore.getClientCertificate(destination)
            : null,
        ),
    );
    const clientAuthentication = await resolveClientAuthentication(
      strategy,
      context,
    );
    return { clientAuthentication, identity: await clientIdentity(context) };
  }

  /**
   * What a consumer's factory's credentials are composed from, read in the
   * 3.x order: the session's authorization config; only when it has none, the
   * session and then the key store's client. A session store of auth-stores 3
   * answers no client, so the key store's is what is found.
   */
  private async readAuthorization(
    destination: string,
  ): Promise<AuthorizationRead> {
    const sessionAuth = await this.read(
      destination,
      'session authorization config',
      () => this.sessionStore.getAuthorizationConfig(destination),
    );
    if (sessionAuth) {
      return { sessionAuth, keyAuth: null, session: null, sessionRead: false };
    }
    const session = await this.loadStoredSession(destination);
    const serviceKeyStore = this.serviceKeyStore;
    const keyAuth = serviceKeyStore
      ? await this.read(destination, 'service key authorization config', () =>
          serviceKeyStore.getAuthorizationConfig(destination),
        )
      : null;
    return { sessionAuth: null, keyAuth, session, sessionRead: true };
  }

  /** The session the store holds for the destination, or null. */
  private loadStoredSession(destination: string): Promise<IConfig | null> {
    return this.read(destination, 'session', () =>
      this.sessionStore.loadSession(destination),
    );
  }

  /**
   * `serviceUrl` for a consumer's provider, in the 3.x order: the session's,
   * else the key store's, else an error before the provider is asked.
   */
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
   * The destination's client: the service key store's `uaaUrl`, `uaaClientId`
   * and `uaaClientSecret`, with the refresh token the session stores laid over
   * them; `null` when the key store has no client. A client a session store
   * answers is not read, nor a refresh token a key store answers.
   */
  async getAuthorizationConfig(
    destination: string,
  ): Promise<IAuthorizationConfig | null> {
    const serviceKeyStore = this.serviceKeyStore;
    const client = serviceKeyStore
      ? await this.read(destination, 'service key authorization config', () =>
          serviceKeyStore.getAuthorizationConfig(destination),
        )
      : null;
    if (!client) {
      return null;
    }
    const secret = await this.read(destination, 'session', () =>
      this.sessionStore.loadSession(destination),
    );
    const composed: IAuthorizationConfig = {
      uaaUrl: client.uaaUrl,
      uaaClientId: client.uaaClientId,
      uaaClientSecret: client.uaaClientSecret,
    };
    if (secret?.refreshToken !== undefined) {
      composed.refreshToken = secret.refreshToken;
    }
    return composed;
  }

  /**
   * The destination's connection config: the service key store's means with
   * the session's secret (`authorizationToken`, `sessionCookies`,
   * `expiresAt`) and its binding (`issuedFor`, `issuedBy`) laid over them; `null` when neither store holds anything.
   * Means a session store answers are not read, nor a secret a key store
   * answers.
   */
  async getConnectionConfig(
    destination: string,
  ): Promise<IConnectionConfig | null> {
    const serviceKeyStore = this.serviceKeyStore;
    const means = serviceKeyStore
      ? await this.read(destination, 'service key connection config', () =>
          serviceKeyStore.getConnectionConfig(destination),
        )
      : null;
    const secret = await this.read(destination, 'session', () =>
      this.sessionStore.loadSession(destination),
    );
    const composed: IConnectionConfig = {};
    for (const [field, value] of Object.entries(means ?? {})) {
      if (!isSecretField(field) && value !== undefined) {
        (composed as Record<string, unknown>)[field] = value;
      }
    }
    for (const field of SECRET_FIELDS) {
      const value = secret?.[field];
      if (value !== undefined) {
        (composed as Record<string, unknown>)[field] = value;
      }
    }
    return Object.keys(composed).length > 0 ? composed : null;
  }

  /**
   * The credential for the destination, ready for a connector: the provider
   * its configuration states (`authType`, and `grantType` for `jwt` / `saml`),
   * built from the means the service key store holds and the secret the
   * session store holds.
   *
   * One provider per destination for the broker's life: concurrent first calls
   * share one build, and a build that threw is tried again on the next call.
   *
   * A token provider (the UAA, OIDC and SAML grants) is seeded from the
   * session when the stored secret is bound to this destination, and writes
   * every token it obtains — at `prepare()`, on expiry, or in `rejected()` after
   * a 401 — back to the session store before it answers (see `flush()`).
   *
   * @throws DestinationConfigError when the destination lacks what its type
   *   needs — naming the fields or options, never a value.
   */
  getProvider(destination: string): Promise<IAuthProvider> {
    const cached = this.built.get(destination);
    if (cached) {
      return cached;
    }
    // Deferred by one tick, so the promise is in the cache before the build
    // reads anything.
    const build = Promise.resolve().then(() => this.build(destination));
    this.built.set(destination, build);
    build.catch(() => {
      if (this.built.get(destination) === build) {
        this.built.delete(destination);
      }
    });
    return build;
  }

  private async build(destination: string): Promise<IAuthProvider> {
    const serviceKeyStore = this.serviceKeyStore;
    if (!serviceKeyStore) {
      throw new DestinationConfigError(
        destination,
        ['serviceKeyStore'],
        'getProvider reads the means from a service key store, and none was given',
      );
    }
    const means = await this.read(destination, 'means', () =>
      serviceKeyStore.getConnectionConfig(destination),
    );
    const authType = statedAuthType(destination, means);
    // statedAuthType refuses a destination without means.
    const stated = means as IConnectionConfig;

    let provider: IAuthProvider;
    if (authType === 'basic') {
      provider = basicProvider(destination, stated);
    } else if (authType === 'snc') {
      provider = sncProvider(destination, stated, this.logger);
    } else {
      const grant = statedGrant(destination, authType, stated);
      if (grant !== 'none') {
        // A grant that obtains a secret: the row's client (none for
        // saml2_pure), what a secret for this destination is bound to
        // — written with every secret, and required of a stored one
        // before it seeds — and the stored secret when it is.
        const secretClient =
          grant === 'saml2_pure'
            ? null
            : await this.read(destination, 'client', () =>
                serviceKeyStore.getAuthorizationConfig(destination),
              );
        // The consumer's client authentication, resolved inside the guard
        // before any provider exists: a strategy that throws leaves nothing
        // built and nothing cached. Then the client identity the row and the
        // binding take — the secret client, else the certificate client's —
        // so the binding and the seed are chosen from it. Without a strategy
        // nothing of this runs: 4.0.0's client, nothing certificate-related.
        let client: RowClient | null = secretClient;
        let clientAuthentication: IClientAuthentication | undefined;
        if (this.clientAuthentication && grant !== 'saml2_pure') {
          const context = clientAuthenticationContext(
            destination,
            grant,
            secretClient,
            () =>
              this.read(destination, 'client certificate', async () =>
                serviceKeyStore.getClientCertificate
                  ? serviceKeyStore.getClientCertificate(destination)
                  : null,
              ),
          );
          clientAuthentication = await resolveClientAuthentication(
            this.clientAuthentication,
            context,
          );
          client = await clientIdentity(context);
        }
        const computed = destinationBinding(authType, grant, stated, client);
        // The strategy path: a resource neither side states matches.
        const binding = clientAuthentication
          ? strategyBinding(computed)
          : computed;
        const stored =
          grant === 'client_credentials'
            ? null
            : await this.read(destination, 'session', () =>
                this.sessionStore.loadSession(destination),
              );
        const secret = this.boundOrDiscarded(destination, stored, binding);
        // The expiry is fixed when the result arrives, not when a retry
        // finally writes it — on a copy; the outcome of the write is recorded
        // against the result itself, which the provider also returns to the
        // token API.
        const onTokens = (result: ITokenResult) =>
          this.writer.submit(destination, {
            result: { ...result, expiresAt: expiryOf(result) },
            original: result,
            binding,
            carry: 'bound',
          });
        const common = {
          destination,
          client,
          secret,
          ...(clientAuthentication ? { clientAuthentication } : {}),
          logger: this.logger,
          onTokens,
        };
        if (isUaaGrant(grant)) {
          provider = uaaProvider({
            ...common,
            grant,
            authorization: this.authorization,
          });
        } else if (isOidcGrant(grant)) {
          provider = oidcProvider({
            ...common,
            grant,
            means: stated,
            oidcAuthorization: this.oidcAuthorization,
            deviceCodePresenter: this.deviceCodePresenter,
          });
        } else if (isSamlGrant(grant)) {
          provider = samlProvider({
            ...common,
            grant,
            means: stated,
            authorization: this.authorization,
            samlCookies: this.samlCookies,
            assertionReplayStore: this.assertionReplayStore,
          });
        } else {
          // statedGrant admits only the allowed `authType` / `grantType` pairs.
          throw new Error(`unreachable grant ${grant satisfies never}`);
        }
        this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
          authType,
          grant,
          seeded: !!secret,
        });
        return provider;
      }
      const secret = await this.read(destination, 'session', () =>
        this.sessionStore.loadSession(destination),
      );
      const client =
        authType === 'jwt'
          ? await this.read(destination, 'client', () =>
              serviceKeyStore.getAuthorizationConfig(destination),
            )
          : null;
      provider = handedOverProvider(
        destination,
        authType,
        secret,
        destinationBinding(authType, 'none', stated, client),
      );
    }
    this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
      authType,
    });
    return provider;
  }

  /**
   * The stored secret when it is bound to this destination's resource and
   * issuer, else `null`: the provider is then built as with no session
   * and logs in afresh — the refresh token is not spent either. The log line
   * names the destination only: never a URI, never a token.
   */
  private boundOrDiscarded(
    destination: string,
    stored: IConfig | null,
    binding: Binding,
  ): IConfig | null {
    if (!stored || boundHere(stored, binding)) return stored;
    if (
      present(stored.authorizationToken) ||
      present(stored.sessionCookies) ||
      present(stored.refreshToken)
    ) {
      this.logger.warn(
        `[AuthBroker] ${destination}: secret bound to another resource, discarded`,
      );
    }
    return null;
  }

  /**
   * Waits for the session writes still pending — each gets one more attempt —
   * and rejects naming the destinations whose store still refuses. Call it on
   * shutdown to know whether every token a provider obtained is stored; the
   * broker keeps retrying after a rejection.
   */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /**
   * One write of the destination's session secret — and nothing else:
   * `{ authorizationToken, expiresAt, refreshToken, issuedFor, issuedBy }` in
   * one `saveSession` — or, for a `saml2_pure` result (`tokenType: 'saml'`),
   * `{ sessionCookies, expiresAt, issuedFor, issuedBy }`: cookies are written
   * as cookies, every other result as a token (`saml2_bearer` included). No means is ever written: not `serviceUrl`, not
   * `authType`, not the client — they live in the key store, which the broker
   * never writes.
   *
   * - `expiresAt`: fixed by `onTokens` when the result arrived — the result's
   *   own, else the `expiresIn` it reports counted from then (the rule the
   *   provider applies to its own cache).
   * - `refreshToken`: the result's, else the one the session holds, read at
   *   write time, so a result without one does not erase the stored one — for
   *   a provider the broker built, only a stored one bound where this one is:
   *   a refresh token obtained for another resource or from another client is
   *   not carried into this secret. So too for a consumer's factory beside a
   *   `clientAuthentication` strategy, seeded only with a bound session. A
   *   consumer's provider without one was seeded with whatever the session
   *   held, so whatever it holds is carried (4.0.0).
   * - `issuedFor` / `issuedBy`: the binding computed when the provider was
   *   built, each left out when the means lack its source — so the
   *   store clears it.
   * - A destination the key store now states as `basic` or `snc` is not
   *   written: those obtain no session secret.
   */
  private async writeSecret(
    destination: string,
    { result, binding, carry }: BoundResult,
  ): Promise<void> {
    const serviceKeyStore = this.serviceKeyStore;
    const means = serviceKeyStore
      ? await this.read(destination, 'means', () =>
          serviceKeyStore.getConnectionConfig(destination),
        )
      : null;
    if (means?.authType === 'basic' || means?.authType === 'snc') {
      this.logger.warn(
        `[AuthBroker] Not written: ${destination} is a ${means.authType} destination, which holds no session secret`,
      );
      return;
    }
    let secret: IConfig;
    if (result.tokenType === 'saml') {
      // saml2_pure: the cookies are the credential, and SAML has no refresh
      // token to carry.
      secret = {
        sessionCookies: result.authorizationToken,
        expiresAt: result.expiresAt,
      };
    } else {
      const stored = result.refreshToken
        ? null
        : await this.read(destination, 'session', () =>
            this.sessionStore.loadSession(destination),
          );
      const storedRefreshToken =
        present(stored?.refreshToken) &&
        (carry === 'any' || boundHere(stored, binding))
          ? stored.refreshToken
          : undefined;
      secret = {
        authorizationToken: result.authorizationToken,
        expiresAt: result.expiresAt,
        refreshToken: result.refreshToken || storedRefreshToken,
      };
    }
    if (binding.issuedFor !== undefined) secret.issuedFor = binding.issuedFor;
    if (binding.issuedBy !== undefined) secret.issuedBy = binding.issuedBy;
    await this.sessionStore.saveSession(destination, secret);
    this.logger.info(`[AuthBroker] Session secret saved for ${destination}`, {
      credential: secret.sessionCookies !== undefined ? 'cookies' : 'token',
      hasRefreshToken: !!secret.refreshToken,
      expiresAt: result.expiresAt,
    });
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
