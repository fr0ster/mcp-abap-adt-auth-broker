/**
 * AuthBroker: the credential for a destination, and tokens for one.
 *
 * `getProvider` builds the `IAuthProvider` a destination states, from the
 * means its service key store holds and the secret its session store holds.
 * Every token provider it builds renews through the consumer's `renewal` and
 * writes what it obtains back to the session store through auth-providers'
 * `refreshStatePersistence` — the secret alone, through one plain queue per
 * destination (`SessionWriter`): a failed write stays pending until the
 * destination's next write or `flush()`, and means what the consumer's
 * `onWriteFailure` says; `flush()` reports what is still pending.
 * The token API (`getToken`, `refreshToken`, `createTokenRefresher`) asks that
 * same provider — the row path's — or, when the consumer gives one, the
 * consumer's provider — the consumer path's, resolved, cached and bound on its
 * own — whose every answer it writes through the same write path.
 *
 * A provider is never changed (§6.2): every call re-reads what its path's
 * provider was built from and builds a new one, starting with nothing, when
 * anything of it changed (`buildIdentity.ts`).
 *
 * The broker orchestrates and nothing more. It resolves what the stores know
 * about a destination, hands it to the provider, asks the provider for a token
 * and writes the answer back. Whether a token is still valid, whether to use the
 * refresh token or log in, and how a login is conducted (browser, headless,
 * pasted code) are the provider's decisions — made by its strategy — and the
 * broker does not repeat or override any of them.
 */

import {
  type AttemptContext,
  AuthProviderFailure,
  authError,
  classify,
  type SharedAttempt,
  sharedAttempt,
} from '@mcp-abap-adt/auth-errors';
import type {
  IDeviceCodePresenter,
  OidcCallbackResult,
  PersistedTokens,
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
import type {
  IClientCertificate,
  IConfig,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  type Binding,
  boundHere,
  consumerBinding,
  couldBeSeeded,
  strategyBinding,
} from './binding';
import { consumerRow, destinationBinding } from './bindingOf';
import {
  type BuildIdentity,
  IdentityRecorder,
  type SourceName,
  StoreReads,
} from './buildIdentity';
import {
  type ClientAuthenticationStrategy,
  type ClientIdentity,
  clientAuthenticationContext,
  clientIdentity,
  contextClient,
  resolveClientAuthentication,
} from './clientAuthentication';
import { asContract } from './contractShape';
import { DestinationConfigError } from './DestinationConfigError';
import {
  type Attachable,
  basicProvider,
  handedOverProvider,
  isOidcGrant,
  isSamlGrant,
  isUaaGrant,
  isWriteFailurePolicy,
  oidcProvider,
  oidcRefusal,
  optionsLacking,
  type RenewalOption,
  type RowBuild,
  type RowClient,
  samlProvider,
  samlRefusal,
  sncProvider,
  statedAuthType,
  statedGrant,
  type TokenGrant,
  uaaProvider,
  uaaRefusal,
} from './destinations';
import { quietLogger } from './quietLogger';
import { SessionWriter, type WriteOutcome } from './SessionWriter';

/**
 * What queuing a write came to: written (landed, or the store's error), or
 * dropped — a retired build's write, never written (§5.3).
 */
type Submitted =
  | ({ readonly written: true } & WriteOutcome)
  | { readonly written: false };

const DROPPED: Submitted = Object.freeze({ written: false });

import type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';

/** What a caller of `getProvider`, the token API and `flush()` may pass (§7). */
export interface BrokerCallOptions {
  /**
   * This caller no longer needs the answer: an abort releases this caller
   * alone, with auth-errors' `aborted` failure (`interactive-login`), while
   * the work it waited on runs on for the others. No bound of the broker's
   * own: a caller that wants one passes `AbortSignal.timeout(ms)`.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A shared start's answer (§7.1): never thenable — no `then` member, frozen.
 * Every start of the broker's slots resolves one and never throws, so the
 * only failure a waiter gets from `sharedAttempt` itself is `aborted`; what
 * the work threw is carried out as a value and rethrown, unchanged, outside
 * `join`.
 */
type SlotOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly thrown: unknown };

/** `work`'s result or what it threw, as a frozen outcome; never rejects. */
async function outcomeOf<T>(work: () => Promise<T>): Promise<SlotOutcome<T>> {
  try {
    return Object.freeze({ ok: true, value: await work() });
  } catch (thrown) {
    return Object.freeze({ ok: false, thrown });
  }
}

/**
 * Joins `slot` with `start`'s work and the caller's signal, and unwraps the
 * outcome outside `join`: the value, or the very value the work threw.
 */
async function joined<T>(
  slot: SharedAttempt<SlotOutcome<T>>,
  work: (attempt: AttemptContext) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const outcome = await slot.join(
    (attempt) => outcomeOf(() => work(attempt)),
    signal,
  );
  if (!outcome.ok) throw outcome.thrown;
  return outcome.value;
}

/**
 * One wait of one caller — on the write queue, or a store read outside a
 * resolution — as a waiter of a slot of its own (§7.5): the caller's signal
 * releases that caller only, and the work runs on.
 */
function waitFor<T>(
  work: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  return joined(
    sharedAttempt<SlotOutcome<T>>('persisting-tokens'),
    work,
    signal,
  );
}

/**
 * Rejects `aborted` when the caller's signal has aborted by now — after its
 * last wait, before its success — through the same one implementation: a
 * waiter that joins with an aborted signal is refused at once.
 */
async function stillWanted(signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined) await waitFor(async () => undefined, signal);
}

/** The provider a token API call is answered by, asked with the call's signal. */
function tokenOptions(
  signal: AbortSignal | undefined,
): [] | [{ signal: AbortSignal }] {
  return signal === undefined ? [] : [{ signal }];
}

/**
 * Builds the token API's provider for one destination, from the means and the
 * client — never from a stored secret: the consumer path is never seeded
 * (§5.5). A consumer whose provider must resume after a restart composes that
 * itself: its provider's own seed and persistence.
 *
 * It is handed exactly these, and nothing else a store answered:
 *
 * - `authConfig`: the client, through an allowlist — `uaaUrl`, `uaaClientId`,
 *   `uaaClientSecret` — from the session store when it answers one, else from
 *   the key store; `refreshToken` is a key, never a value. `null` when
 *   neither store has a client (a SAML flow needs none).
 * - `connConfig`: the connection means, through an allowlist — `serviceUrl`
 *   (resolved: the session's, else the key store's), and, as the session
 *   store's connection config states them, `sapClient`, `language`,
 *   `authType` and `grantType`. No token, cookies, expiry, refresh token or
 *   binding, nor any other field.
 * - `client` (`TokenProviderClient`), only beside a `clientAuthentication`
 *   strategy, for a destination whose grant authenticates a client: the
 *   strategy's answer and the client identity (`uaaUrl`, `clientId`); never
 *   PEM, never a secret, never a refresh token. Without a strategy the
 *   factory gets three arguments, as 4.0.0.
 *
 * Called once per build: the broker keeps the provider it returns while what
 * it was handed is unchanged, re-reading it on every token API call (§6.3);
 * when any of it changes, the factory is called again and the new provider
 * starts with nothing.
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
   * Never set — not even as a key: the consumer path is handed no stored
   * secret (§5.5). Kept in the type, which 5.0.0 leaves unchanged (§9).
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
  serviceKeyStore?: IServiceKeyStore | undefined;
  /**
   * The token API's source: the token provider, or a factory building one per
   * destination. Not used by `getProvider`, which builds what the destination
   * states.
   *
   * An instance is used as given, for every destination. A factory is handed
   * the destination's means and client, never a stored secret (see
   * `TokenProviderFactory`).
   */
  provider?: IRefreshableTokenProvider | TokenProviderFactory | undefined;

  // Collaborators — each a function of the destination, called once per build
  // of that destination's provider (again for every new build, §6.2), each
  // required only by the grants that use it. The broker supplies no default
  // and disposes none.

  /** The interactive strategy of the UAA code, passcode and SAML grants. */
  authorization?:
    | ((
        destination: string,
        grant: StrategyGrant,
      ) => IAuthorizationStrategy<string>)
    | undefined;
  /** The interactive strategy of the OIDC authorization code grant. */
  oidcAuthorization?:
    | ((destination: string) => IAuthorizationStrategy<OidcCallbackResult>)
    | undefined;
  /** Where the device flow shows the user its code. */
  deviceCodePresenter?:
    | ((destination: string) => IDeviceCodePresenter)
    | undefined;
  /** `saml2_pure`: turns the SAMLResponse into the system's session cookies. */
  samlCookies?:
    | ((destination: string) => (samlResponse: string) => Promise<string>)
    | undefined;
  /** The replay store the SAML assertion validators share. */
  assertionReplayStore?:
    | ((destination: string) => IAssertionReplayStore)
    | undefined;
  /**
   * How a destination's client authenticates to the authorization server, for
   * every grant that authenticates one (`ClientAuthenticationGrant`). Called
   * once per build of the destination's provider, with the client the key
   * store answers and its certificate, read only if the strategy asks — and
   * then re-read on every call, a change building a new provider (§6.2).
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
  clientAuthentication?: ClientAuthenticationStrategy | undefined;
  /**
   * How the provider the broker builds for a destination renews: called once
   * per build of every token row (the UAA, OIDC and SAML grants), with the
   * destination and the grant it states; the answer is the provider's
   * `renewal`, unchanged. Required for those rows — there is no default: a
   * token row built without it is refused naming `renewal`. `() =>
   * refreshThenLogin()` is what 4.x did; `refreshOnly()` never logs in. Not
   * called for `basic`, `snc` or `none`, nor for the token API's `provider`,
   * which brings its own.
   */
  renewal?: RenewalOption | undefined;
  /**
   * What a session write that did not land means — `'fail'`: the call that
   * caused it fails (`unknown`, `persisting-tokens`), and while the
   * destination's write is pending every `getProvider` / `getToken` /
   * `refreshToken` of it retries the write first, and once more right before
   * it succeeds, and is refused while it fails; `'continue'`: it is logged
   * and the call goes on. Either way the write stays pending until the
   * destination's next write or `flush()` — nothing retries it on its own.
   * Required for every destination
   * that writes a secret — a token row built by `getProvider`, and every call
   * of the token API; no default.
   */
  onWriteFailure?: 'fail' | 'continue' | undefined;
  /**
   * Passed to every token provider the broker builds; on only for `true`
   * itself — absent, `false`, `'true'` or `1` is off. Never read from the
   * environment. With it, a provider's one debug line for a refused token
   * request names the request's secrets in its prepared form (the first and
   * last four characters around a length marker), never the server's text;
   * the line goes to the broker's logger. A consumer's `provider` — an
   * instance or what a factory builds — keeps its own setting.
   */
  authDebug?: boolean | undefined;
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

/**
 * The connection means a strategy-path seed carries — the connection's own,
 * none of them a secret. Everything else a store's connection read answers
 * (credentials, grant data, fields outside the type) stays behind.
 */
const SEED_MEANS = [
  'serviceUrl',
  'sapClient',
  'language',
  'authType',
  'grantType',
] as const;

/**
 * The token API factory's seed: the connection means from an allowlist
 * (`SEED_MEANS`) and nothing else — never the session secret's own fields
 * (`SECRET_FIELDS`), whatever the stored record says: the consumer path is
 * never seeded (§5.5). `serviceUrl` is the one resolved for the destination.
 */
function consumerSeed(
  connConfig: IConnectionConfig | null,
  serviceUrl: string,
): IConnectionConfig {
  const source = (connConfig ?? {}) as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const field of SEED_MEANS) {
    if (source[field] !== undefined) seed[field] = source[field];
  }
  return { ...(seed as IConnectionConfig), serviceUrl };
}

/** When the result expires, in epoch ms: its own `expiresAt`, else `expiresIn` from now. */
function expiryOf(result: ITokenResult): number | undefined {
  if (typeof result.expiresAt === 'number') return result.expiresAt;
  if (typeof result.expiresIn === 'number') {
    return Date.now() + Math.round(result.expiresIn * 1000);
  }
  return undefined;
}

/** One session write, with the binding it is written with. */
interface SecretWrite {
  /**
   * The credential — a token, or `saml2_pure`'s cookies — or `''` when none
   * is held (a refresh token discarded before any credential).
   */
  credential: string;
  /** Whether `credential` is session cookies (`tokenType: 'saml'`). */
  cookies: boolean;
  /** Fixed when the credential arrived, never when a retry writes it. */
  expiresAt: number | undefined;
  /**
   * The refresh token written beside the credential, decided when the write
   * was submitted — the one its build owns, or `''`, which clears the stored
   * one — never read from the store at write time (§5.2).
   */
  refreshToken: string;
  binding: Binding;
}

/**
 * The refresh token a build owns, after one reported refresh token (§5.2): a
 * string written makes it owned; `null` (a discard) writes `''` and makes it
 * none; `undefined` writes the owned one, or `''` when the build owns none.
 */
function ownedAfter(
  owned: string | undefined,
  reported: string | null | undefined,
): { written: string; owned: string | undefined } {
  if (present(reported)) return { written: reported, owned: reported };
  if (reported === null) return { written: '', owned: undefined };
  return { written: owned ?? '', owned };
}

/**
 * The two paths a destination's provider is resolved on (§7.1): the row path
 * — `getProvider`, and the token API without a `provider` option — and the
 * consumer path — the token API with one. Each has its own resolution, cache
 * entry, identity and generation counter per destination; they share nothing
 * but the destination's session writes.
 */
type Path = 'row' | 'consumer';

/** One map per path. */
function perPath<T>(): Record<Path, Map<string, T>> {
  return { row: new Map(), consumer: new Map() };
}

/**
 * One path's provider for a destination, as resolved: the provider, what its
 * build read (compared on every call, §6.2), and the generation it took from
 * its path's counter when it was committed (§5.3).
 */
interface Resolved<P> {
  readonly provider: P;
  readonly identity: BuildIdentity;
  readonly generation: number;
}

/**
 * The row path's resolution, with the provider's parties (§7.2): the provider
 * itself when the row it was built from is a token row or `snc`, else
 * `undefined` — decided by the row, never by looking at the instance.
 */
interface RowResolved extends Resolved<IAuthProvider> {
  readonly parties: Attachable | undefined;
}

/** A row build: the provider, and its parties when it has any. */
interface RowBuilt {
  readonly provider: IAuthProvider;
  readonly parties: Attachable | undefined;
}

/**
 * The consumer path's provider, with the binding fixed when it was built — or,
 * for an instance, first used. Every result it answers is written with this
 * binding, never one recomputed from means read later.
 */
interface ConsumerResolved extends Resolved<IRefreshableTokenProvider> {
  readonly binding: Binding;
}

/** A build's generation, known once the build is committed. */
interface Commit {
  generation: number;
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
}

/**
 * The client the consumer path hands its factory and tells its strategy: the
 * session's own client, else the key store's, through the same allowlist the
 * strategy is told (`contextClient`) — with `refreshToken` as a key, never a
 * value: no refresh token either client read carried reaches the factory.
 */
function consumerClient(read: AuthorizationRead): IAuthorizationConfig | null {
  const client = contextClient(read.sessionAuth ?? read.keyAuth);
  return client
    ? asContract<IAuthorizationConfig>({ ...client, refreshToken: undefined })
    : null;
}

/** What the consumer path takes from its stores (`consumerInputs`). */
interface ConsumerInputs {
  readonly means: IConnectionConfig | null;
  readonly serviceUrl: string;
  readonly sapClient: string | undefined;
  readonly row: string;
  readonly client: IAuthorizationConfig | null;
  readonly seed: IConnectionConfig;
}

/**
 * The consumer path's identity (§6.3). A factory's: everything it is handed —
 * the client, the seed — and what its binding is made of — the row, the
 * resource. An instance's, which is handed nothing: the destination's
 * identity it was first used for — the row, the resource, the issuer
 * (`uaaUrl`, `oidcIssuerUrl`) and the client id, no secret.
 */
function consumerIdentity(inputs: ConsumerInputs, instance: boolean): unknown {
  const { row, serviceUrl, sapClient, client } = inputs;
  return instance
    ? {
        row,
        serviceUrl,
        sapClient,
        uaaUrl: client?.uaaUrl,
        clientId: client?.uaaClientId,
        oidcIssuerUrl: inputs.means?.oidcIssuerUrl,
      }
    : { row, serviceUrl, sapClient, client, seed: inputs.seed };
}

/**
 * The token API's refusal of a destination whose means changed under the
 * consumer's instance: the instance cannot be rebuilt, and the identity of
 * the credential it holds is unknown to the broker (§6.3).
 */
function instanceRefusal(destination: string): DestinationConfigError {
  return new DestinationConfigError(
    destination,
    ['provider'],
    'the destination’s means changed since the provider instance was first used for it',
  );
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

/**
 * A result carrying a token, or the failure for one that carries none:
 * `request-failed`, `token-source`, `no-access-token` — "the token source
 * returned no access_token", minted by auth-errors.
 */
function checked(
  result: ITokenResult | undefined,
): ITokenResult & { authorizationToken: string } {
  if (!result?.authorizationToken) {
    throw new AuthProviderFailure(
      authError['request-failed']({
        operation: 'token-source',
        problem: 'no-access-token',
      }),
    );
  }
  return result as ITokenResult & { authorizationToken: string };
}

/** A token write of the provider's persistence: the report's own facts. */
function persisted(
  tokens: PersistedTokens,
): Pick<SecretWrite, 'credential' | 'cookies' | 'expiresAt'> {
  return {
    credential: tokens.authorizationToken,
    cookies: tokens.tokenType === 'saml',
    expiresAt: tokens.expiresAt,
  };
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
  /** Per (destination, path): the provider handed out while unchanged. */
  private readonly resolvedRow = new Map<string, RowResolved>();
  private readonly resolvedConsumer = new Map<string, ConsumerResolved>();
  /**
   * Per (destination, path): the slot of shared resolutions (§7.1) — every
   * caller of that path is a waiter of its attempt.
   */
  private readonly rowSlots = new Map<
    string,
    SharedAttempt<SlotOutcome<RowResolved>>
  >();
  private readonly consumerSlots = new Map<
    string,
    SharedAttempt<SlotOutcome<ConsumerResolved>>
  >();
  /** The broker-wide slot every `flush()` caller joins (§7.5). */
  private readonly flushSlot =
    sharedAttempt<SlotOutcome<void>>('persisting-tokens');
  /** Per (destination, path): the last generation a build took. */
  private readonly generations = perPath<number>();
  /** Per (destination, path): the newest generation that queued a write. */
  private readonly newestWriter = perPath<number>();
  /**
   * The destinations whose means changed under the consumer's instance: the
   * token API refuses them until a new broker (§6.3).
   */
  private readonly instanceRefused = new Set<string>();
  private readonly authorization: AuthBrokerConfig['authorization'];
  private readonly oidcAuthorization: AuthBrokerConfig['oidcAuthorization'];
  private readonly deviceCodePresenter: AuthBrokerConfig['deviceCodePresenter'];
  private readonly samlCookies: AuthBrokerConfig['samlCookies'];
  private readonly assertionReplayStore: AuthBrokerConfig['assertionReplayStore'];
  private readonly clientAuthentication: AuthBrokerConfig['clientAuthentication'];
  private readonly renewal: AuthBrokerConfig['renewal'];
  private readonly onWriteFailure: AuthBrokerConfig['onWriteFailure'];
  /** `config.authDebug === true`: what every token provider it builds is told. */
  private readonly authDebug: boolean;
  /** Every write of the session secret: one plain queue per destination. */
  private readonly writer: SessionWriter<SecretWrite>;

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
    this.renewal = config.renewal;
    this.onWriteFailure = config.onWriteFailure;
    // Every line the broker writes, and every line of a provider it builds,
    // goes through one guard: a consumer logger that throws or rejects
    // changes no outcome (§8.1).
    this.logger = quietLogger(logger);
    this.authDebug = config.authDebug === true;
    this.writer = new SessionWriter<SecretWrite>(
      (destination, write) => this.writeSecret(destination, write),
      this.logger,
    );
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
   * serve both — and what it obtains is written by its persistence. With one,
   * the consumer's provider is asked and its answer written, as in 3.x — the
   * secret alone.
   *
   * A provider's failure is relayed as the same object; a store's read
   * failure reaches the caller as the store raised it. A write that did not
   * land fails the call under `onWriteFailure: 'fail'` (`unknown`,
   * `persisting-tokens`) — the token stands, and the write stays pending: the
   * destination's next call retries it first and is refused while it fails —
   * and is only logged under `'continue'`.
   *
   * @throws DestinationConfigError for a destination the key store states as
   *   `basic` or `snc`, before any provider is asked; without the
   *   `onWriteFailure` option; without a consumer `provider`, also for one
   *   whose provider obtains no token.
   */
  async getToken(
    destination: string,
    options?: BrokerCallOptions,
  ): Promise<string> {
    return this.obtain(destination, 'getTokens', options?.signal);
  }

  /**
   * A new token for the destination, never the cached one — for a caller whose
   * token the server has just refused. Calls the provider's `refreshTokens()`;
   * a renewal already in flight for the destination is joined, not repeated.
   */
  async refreshToken(
    destination: string,
    options?: BrokerCallOptions,
  ): Promise<string> {
    return this.obtain(destination, 'refreshTokens', options?.signal);
  }

  /**
   * The token API's one body. The call's signal releases this caller from
   * every wait it has — the write checks, the means read, the resolution
   * (whose waiter it is, never attaching: §7.3), its own write — and is
   * passed to the provider's `getTokens` / `refreshTokens`.
   */
  private async obtain(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (this.provider && !isWriteFailurePolicy(this.onWriteFailure)) {
      // Every answer of the consumer's provider is written: what a failed
      // write means is the consumer's to say. (Without one, getProvider's
      // token row refuses the same.)
      throw new DestinationConfigError(
        destination,
        ['onWriteFailure'],
        'the token API writes the session secret: say what a failed write means',
      );
    }
    await this.settlePending(destination, signal);
    // This call's reads: the means once, for the check and the resolution.
    const reads = this.storeReads(destination);
    const means = await waitFor(
      () => this.statedForTokens(destination, reads),
      signal,
    );
    const result = this.provider
      ? await this.obtainFromConsumer(destination, method, reads, signal)
      : await this.obtainShared(destination, method, means, reads, signal);
    // A write queued meanwhile — a discard of the destination's provider the
    // store rejected, say — is caught here (§5.4).
    await this.settlePending(destination, signal);
    // A signal that aborted after the last wait: never success.
    await stillWanted(signal);
    return result.authorizationToken;
  }

  /**
   * Under `onWriteFailure: 'fail'`, a call of the destination is refused while
   * its last write is pending (§5.4) — not yet landed: failed, or still queued
   * or in flight. Asked on entry and right before success: the call awaits
   * every write of the destination queued before this moment, and a failed
   * one that no later write replaced is written once more — the destination's
   * next write, queued like any other. All landed: on entry the call goes on,
   * at the end it returns its success. Still failing: it rejects (`unknown`,
   * `persisting-tokens`). A write queued after the check is not this call's.
   * Under `'continue'` nothing is asked.
   *
   * The one wait is `writer.retry(destination)`'s promise, a waiter of its
   * own slot with the call's signal (§7.5): an abort releases the caller
   * (`aborted`), never with success, and the write runs on.
   */
  private async settlePending(
    destination: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.onWriteFailure !== 'fail') return;
    const outcome = await waitFor(() => this.writer.retry(destination), signal);
    if (!outcome.landed) {
      throw new AuthProviderFailure(
        classify(outcome.error, 'persisting-tokens'),
      );
    }
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
    reads: StoreReads,
  ): Promise<IConnectionConfig | null> {
    const means = this.serviceKeyStore
      ? ((await reads.read('means')) as IConnectionConfig | null)
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

  /**
   * The token API on the row path's provider — the one `getProvider` hands
   * out, resolved the same way, never through `getProvider` itself.
   */
  private async obtainShared(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
    means: IConnectionConfig | null,
    reads: StoreReads,
    signal: AbortSignal | undefined,
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
    // The row path's provider, through a waiter of its slot that never
    // attaches (§7.3): a token call can neither keep a later moment's login
    // alive nor bound it.
    const { provider } = await this.resolveRow(destination, signal, reads);
    if (!obtainsTokens(provider)) {
      throw new DestinationConfigError(
        destination,
        ['provider'],
        'the destination states a credential that obtains no token: use getProvider, or give the token API the provider option',
      );
    }
    this.logger.debug(`[AuthBroker] ${method} for ${destination}`);
    // The provider's failure — a write its persistence awaited included — is
    // relayed as the same object.
    return checked(await provider[method](...tokenOptions(signal)));
  }

  /**
   * The token API on the consumer's provider: resolved on the consumer path,
   * every answer — a cache hit included — written, the secret alone, through
   * the broker's one write path, with the binding fixed when the provider was
   * taken into use.
   */
  private async obtainFromConsumer(
    destination: string,
    method: 'getTokens' | 'refreshTokens',
    reads: StoreReads,
    signal: AbortSignal | undefined,
  ): Promise<ITokenResult & { authorizationToken: string }> {
    const { provider, binding, generation } = await this.resolveConsumer(
      destination,
      reads,
      signal,
    );

    this.logger.debug(`[AuthBroker] ${method} for ${destination}`);
    const result = checked(await provider[method](...tokenOptions(signal)));
    // The call's own write, queued whatever the caller does next, and awaited
    // raced against its signal (§5.5): an abort releases the caller
    // (`aborted`, never success) and the write runs on.
    const queued = this.submit('consumer', destination, generation, {
      credential: result.authorizationToken,
      cookies: result.tokenType === 'saml',
      expiresAt: expiryOf(result),
      // The result is authoritative: no refresh token in it writes `''` — the
      // store merges, and the stored one is never carried (§5.5).
      refreshToken: present(result.refreshToken) ? result.refreshToken : '',
      binding,
    });
    // Handled here too: a wait refused at once (the signal already aborted)
    // never awaits it. It does not reject — the writer never does, and its
    // log lines go through the quiet logger — but nothing here relies on it.
    queued.catch(() => {});
    const outcome = await waitFor(() => queued, signal);
    if (outcome.written && !outcome.landed && this.onWriteFailure === 'fail') {
      throw new AuthProviderFailure(
        classify(outcome.error, 'persisting-tokens'),
      );
    }
    return result;
  }

  /**
   * The slot of one (destination, path)'s resolutions (§7.1): a caller of
   * the path arriving while an attempt is active joins it; when every caller
   * of an attempt has aborted, the attempt leaves the slot at once and the
   * next caller starts afresh. A failed or aborted resolution is not kept.
   */
  private slotOf<T>(
    slots: Map<string, SharedAttempt<SlotOutcome<T>>>,
    destination: string,
  ): SharedAttempt<SlotOutcome<T>> {
    let slot = slots.get(destination);
    if (slot === undefined) {
      slot = sharedAttempt<SlotOutcome<T>>('token-source');
      slots.set(destination, slot);
    }
    return slot;
  }

  /** Whether a build of this path was ever committed for the destination. */
  private everBuilt(path: Path, destination: string): boolean {
    return this.generations[path].has(destination);
  }

  /** A committed build's generation, from its path's counter (§5.3). */
  private nextGeneration(path: Path, destination: string): number {
    const generation = (this.generations[path].get(destination) ?? 0) + 1;
    this.generations[path].set(destination, generation);
    return generation;
  }

  /**
   * Queues one write of a build of `path`. A write of a build older than the
   * newest build of the same path that has queued a write for the destination
   * is dropped — never written, never pending (§5.3); a build of the other
   * path never retires this one. A dropped write is not a failed one: the
   * retired provider's holder keeps it (§6.2), and the destination's session
   * is the newer build's.
   */
  private async submit(
    path: Path,
    destination: string,
    generation: number,
    write: SecretWrite,
  ): Promise<Submitted> {
    const newest = this.newestWriter[path].get(destination) ?? 0;
    if (generation < newest) {
      this.logger.debug(
        `[AuthBroker] A replaced provider's session write for ${destination} dropped`,
      );
      return DROPPED;
    }
    this.newestWriter[path].set(destination, generation);
    return Object.freeze({
      written: true,
      ...(await this.writer.submit(destination, write)),
    });
  }

  /** This call's store reads: each source read at most once. */
  private storeReads(destination: string): StoreReads {
    return new StoreReads((name: SourceName) => {
      const serviceKeyStore = this.serviceKeyStore;
      switch (name) {
        case 'means':
          return serviceKeyStore
            ? this.read(destination, 'means', () =>
                serviceKeyStore.getConnectionConfig(destination),
              )
            : Promise.resolve(null);
        case 'client':
          return serviceKeyStore
            ? this.read(destination, 'client', () =>
                serviceKeyStore.getAuthorizationConfig(destination),
              )
            : Promise.resolve(null);
        case 'certificate':
          return this.read(destination, 'client certificate', async () =>
            serviceKeyStore?.getClientCertificate
              ? serviceKeyStore.getClientCertificate(destination)
              : null,
          );
        case 'sessionConnection':
          return this.read(destination, 'session connection config', () =>
            this.sessionStore.getConnectionConfig(destination),
          );
        case 'sessionClient':
          return this.read(destination, 'session authorization config', () =>
            this.sessionStore.getAuthorizationConfig(destination),
          );
      }
    });
  }

  /**
   * The consumer path's provider for the destination (§6.3): the cached one
   * while everything it was built from is unchanged; else, for a factory, a
   * new build — the factory called again, its provider starting with nothing
   * — and, for an instance, which cannot be rebuilt, a refusal naming
   * `provider` until a new broker.
   */
  private resolveConsumer(
    destination: string,
    reads: StoreReads,
    signal: AbortSignal | undefined,
  ): Promise<ConsumerResolved> {
    const slot = this.slotOf(this.consumerSlots, destination);
    return joined(
      slot,
      async (attempt) => {
        const instance = typeof this.provider !== 'function';
        if (this.instanceRefused.has(destination)) {
          throw instanceRefusal(destination);
        }
        const cached = this.resolvedConsumer.get(destination);
        if (cached) {
          if (await cached.identity.unchanged(reads)) return cached;
          // A doomed attempt changes nothing (§7.1): every caller left while
          // it re-read, and a fresh attempt may have committed meanwhile —
          // the entry is no longer this attempt's to remove. A live attempt
          // is the slot's only one, so the entry is still the one it read.
          if (attempt.signal.aborted) throw attempt.signal.reason;
          this.resolvedConsumer.delete(destination);
          if (instance) {
            this.instanceRefused.add(destination);
            throw instanceRefusal(destination);
          }
        }
        const recorder = new IdentityRecorder(reads);
        const built = await this.buildConsumer(
          destination,
          recorder,
          attempt.signal,
        );
        // The commit, one step, only if the attempt was not aborted: a build
        // every caller left is never cached nor handed out (§7.1).
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const resolved: ConsumerResolved = Object.freeze({
          ...built,
          identity: recorder.seal(),
          generation: this.nextGeneration('consumer', destination),
        });
        this.resolvedConsumer.set(destination, resolved);
        return resolved;
      },
      signal,
    );
  }

  /**
   * Takes the consumer's provider into use for the destination: a factory's
   * build — handed the means and the client, never a stored secret — or an
   * instance as given, handed nothing. The binding is fixed here, from the
   * `serviceUrl` (the session's, else the key store's), the SAP client and
   * the client of this build. Every store answer is read through `recorder`:
   * what it read is the build's identity.
   */
  private async buildConsumer(
    destination: string,
    recorder: IdentityRecorder,
    signal: AbortSignal,
  ): Promise<{ provider: IRefreshableTokenProvider; binding: Binding }> {
    const provider = this.provider as
      | IRefreshableTokenProvider
      | TokenProviderFactory;
    const instance = typeof provider !== 'function';
    // The identity is what this path takes from its stores — never what else
    // the session store holds, which this broker's own writes change (§6.3).
    const inputs = await this.consumerInputs(destination, recorder.reads);
    recorder.derived(consumerIdentity(inputs, instance), async (reads) =>
      consumerIdentity(await this.consumerInputs(destination, reads), instance),
    );
    const { means, serviceUrl, sapClient, row, client, seed } = inputs;
    if (typeof provider !== 'function') {
      return {
        provider,
        binding: consumerBinding(row, serviceUrl, sapClient, null),
      };
    }
    // Never seeded (§5.5): the factory is handed the means and the client
    // only — no stored token, cookies, expiry or refresh token, in any
    // argument, whatever the stored session's record says. The broker
    // cannot know what the factory composes from what it is handed.
    const strategic = await this.consumerClientAuthentication(
      destination,
      means,
      client,
      recorder,
      signal,
    );
    let built: IRefreshableTokenProvider;
    let binding: Binding;
    if (strategic) {
      // The strategy's answer and the client identity, resolved before the
      // factory; the factory called inside the same guard: a throw is fixed
      // words, nothing of the thrown value, no cause. The binding is only
      // ever written, never compared: this path seeds from nothing.
      binding = consumerBinding(row, serviceUrl, sapClient, strategic.identity);
      const fourth: TokenProviderClient = {
        clientAuthentication: strategic.clientAuthentication,
        ...(strategic.identity
          ? {
              uaaUrl: strategic.identity.uaaUrl,
              clientId: strategic.identity.uaaClientId,
            }
          : {}),
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
      binding = consumerBinding(row, serviceUrl, sapClient, client);
      built = provider(destination, client, seed);
    }
    this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
      hasCredentials: !!client,
    });
    return { provider: built, binding };
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
    recorder: IdentityRecorder,
    signal: AbortSignal,
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
    const context = clientAuthenticationContext(
      destination,
      grant,
      client,
      () => recorder.read<IClientCertificate>('certificate'),
      signal,
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
   * key store's client. The stored session is not read: nothing of it is
   * handed to the factory (§5.5). A session store of auth-stores 3
   * answers no client, so the key store's is what is found.
   */
  private async readAuthorization(
    reads: StoreReads,
  ): Promise<AuthorizationRead> {
    const sessionAuth = (await reads.read(
      'sessionClient',
    )) as IAuthorizationConfig | null;
    if (sessionAuth) {
      return { sessionAuth, keyAuth: null };
    }
    const keyAuth = this.serviceKeyStore
      ? ((await reads.read('client')) as IAuthorizationConfig | null)
      : null;
    return { sessionAuth: null, keyAuth };
  }

  /**
   * What the consumer path takes from its stores for one destination, read
   * from `reads` — the same function for a build and for every later call's
   * comparison: the means, the `serviceUrl` (the session's, else the key
   * store's), the SAP client, the row, the client through its allowlist, and
   * the factory's seed of allowlisted connection means.
   */
  private async consumerInputs(
    destination: string,
    reads: StoreReads,
  ): Promise<ConsumerInputs> {
    const means = this.serviceKeyStore
      ? ((await reads.read('means')) as IConnectionConfig | null)
      : null;
    const connConfig = (await reads.read(
      'sessionConnection',
    )) as IConnectionConfig | null;
    const serviceUrl = this.serviceUrlOf(destination, connConfig, means);
    return {
      means,
      serviceUrl,
      sapClient: present(connConfig?.sapClient)
        ? connConfig.sapClient
        : means?.sapClient,
      row: consumerRow(means),
      client: consumerClient(await this.readAuthorization(reads)),
      seed: consumerSeed(connConfig, serviceUrl),
    };
  }

  /**
   * `serviceUrl` for a consumer's provider, in the 3.x order: the session's,
   * else the key store's, else an error before the provider is asked.
   */
  private serviceUrlOf(
    destination: string,
    connConfig: IConnectionConfig | null,
    means: IConnectionConfig | null,
  ): string {
    const serviceUrl = connConfig?.serviceUrl || means?.serviceUrl;
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
   * A provider is never changed (§6.2): every call re-reads what the
   * destination's provider was built from — the means, the client, and the
   * certificate client when the build read it — and answers the cached
   * provider while all of it is unchanged. When anything changed, by a single
   * character, it builds a new provider, which starts with nothing — no token,
   * no refresh token, nothing of the old provider or of a session written
   * under other means — and never hands the old one out again; whoever holds
   * it keeps it, and its writes are dropped once the new one has written.
   * Concurrent calls share one resolution; a resolution that threw is tried
   * again on the next call.
   *
   * A token provider (the UAA, OIDC and SAML grants) is seeded from the
   * session only at its destination's first build in this broker, and only
   * when the stored secret is bound to exactly this build's means (fully
   * stated); it writes every token it obtains — at `prepare()`, on expiry, or
   * in `rejected()` after a 401 — back to the session store before it answers
   * (see `flush()`).
   *
   * `options.signal` releases this caller from every wait (`aborted`), and is
   * attached to the token or SNC provider answered — built or cached — so a
   * login it starts later is aborted once every session holding it has gone
   * (§7.2). Without a signal nothing is attached.
   *
   * @throws DestinationConfigError when the destination lacks what its type
   *   needs — naming the fields or options, never a value.
   */
  async getProvider(
    destination: string,
    options?: BrokerCallOptions,
  ): Promise<IAuthProvider> {
    const signal = options?.signal;
    await this.settlePending(destination, signal);
    const { provider, parties } = await this.resolveRow(destination, signal);
    await this.settlePending(destination, signal);
    // A signal that aborted after the last wait: never success.
    await stillWanted(signal);
    // Attached after the resolution, to the provider answered — built or
    // from the cache — so a login it starts later in a moment is aborted once
    // every session holding it has gone (§7.2). Nothing kept to detach: a
    // session ends by aborting its signal.
    if (signal !== undefined) parties?.attach(signal);
    return provider;
  }

  /**
   * The row path's provider for the destination: the cached one while what
   * its build read is unchanged (§6.2), else a new build, committed with the
   * next generation of the row path.
   */
  private resolveRow(
    destination: string,
    signal: AbortSignal | undefined,
    reads: StoreReads = this.storeReads(destination),
  ): Promise<RowResolved> {
    const slot = this.slotOf(this.rowSlots, destination);
    return joined(
      slot,
      async (attempt) => {
        const cached = this.resolvedRow.get(destination);
        if (cached) {
          if (await cached.identity.unchanged(reads)) return cached;
          // A doomed attempt changes nothing (§7.1): every caller left while
          // it re-read, and a fresh attempt may have committed meanwhile —
          // the entry is no longer this attempt's to remove. A live attempt
          // is the slot's only one, so the entry is still the one it read.
          if (attempt.signal.aborted) throw attempt.signal.reason;
          // Changed: never handed out again.
          this.resolvedRow.delete(destination);
        }
        const recorder = new IdentityRecorder(reads);
        const commit: Commit = { generation: 0 };
        const { provider, parties } = await this.build(destination, recorder, {
          // Only a first build may start from the store; a replacement starts
          // with nothing.
          seeded: !this.everBuilt('row', destination),
          commit,
          signal: attempt.signal,
        });
        // The commit — the cache set, the generation taken — is one step that
        // runs only if the attempt was not aborted: a build every caller left
        // is never cached, never handed out, and, never asked for a token,
        // writes nothing (§7.1).
        if (attempt.signal.aborted) throw attempt.signal.reason;
        commit.generation = this.nextGeneration('row', destination);
        const resolved: RowResolved = Object.freeze({
          provider,
          parties,
          identity: recorder.seal(),
          generation: commit.generation,
        });
        this.resolvedRow.set(destination, resolved);
        return resolved;
      },
      signal,
    );
  }

  /**
   * One build of the destination's row. Every store answer it reads goes
   * through `recorder` — what it read is its identity. `seeded`: whether the
   * build may start from the stored session; `commit`: the generation its
   * writes carry, set when the build is committed; `signal`: the build's
   * attempt, handed to the `clientAuthentication` strategy (D11). Answers
   * the provider and the row it stated.
   */
  private async build(
    destination: string,
    recorder: IdentityRecorder,
    {
      seeded,
      commit,
      signal,
    }: { seeded: boolean; commit: Commit; signal: AbortSignal },
  ): Promise<RowBuilt> {
    const serviceKeyStore = this.serviceKeyStore;
    if (!serviceKeyStore) {
      throw new DestinationConfigError(
        destination,
        ['serviceKeyStore'],
        'getProvider reads the means from a service key store, and none was given',
      );
    }
    const means = await recorder.read<IConnectionConfig>('means');
    const authType = statedAuthType(destination, means);
    // statedAuthType refuses a destination without means.
    const stated = means as IConnectionConfig;

    let provider: IAuthProvider;
    if (authType === 'basic') {
      provider = basicProvider(destination, stated);
    } else if (authType === 'snc') {
      const snc = sncProvider(destination, stated, this.logger);
      this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
        authType,
      });
      return { provider: snc, parties: snc };
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
            : await recorder.read<IAuthorizationConfig>('client');
        // The consumer's renewal and write policy have no default: a row
        // without either is refused — with everything else it lacks, in one
        // error — before any collaborator, the clientAuthentication strategy
        // included, is called.
        if (
          optionsLacking({
            renewal: this.renewal,
            onWriteFailure: this.onWriteFailure,
          }).length > 0
        ) {
          throw this.rowRefusal(destination, grant, stated, secretClient);
        }
        // The consumer's client authentication, resolved inside the guard
        // before any provider exists: a strategy that throws leaves nothing
        // built and nothing cached. Then the client identity the row and the
        // binding take — the secret client, else the certificate client's —
        // so the binding and the seed are chosen from it. Without a strategy
        // nothing of this runs: 4.0.0's client, nothing certificate-related.
        let client: RowClient | null = secretClient;
        let clientAuthentication: IClientAuthentication | undefined;
        // The certificate client, when the build read it: its certUrl and
        // public certificate go into the binding (never its key).
        let certificateRead: Promise<IClientCertificate | null> | undefined;
        if (this.clientAuthentication && grant !== 'saml2_pure') {
          const context = clientAuthenticationContext(
            destination,
            grant,
            secretClient,
            () => {
              certificateRead =
                recorder.read<IClientCertificate>('certificate');
              return certificateRead;
            },
            signal,
          );
          clientAuthentication = await resolveClientAuthentication(
            this.clientAuthentication,
            context,
          );
          client = await clientIdentity(context);
        }
        // A read that failed — and that a consumer's strategy caught — read
        // no certificate client.
        const certificate = certificateRead
          ? await certificateRead.catch(() => null)
          : null;
        // Its certificate is hashed into the binding: one that is no PEM
        // string is refused, never hashed as if the build had read none.
        if (certificate && !present(certificate.certificate)) {
          throw new DestinationConfigError(
            destination,
            ['clientAuthentication'],
            'the client certificate the key store answered holds no certificate',
          );
        }
        const computed = destinationBinding(
          authType,
          grant,
          stated,
          client,
          certificate,
        );
        // The strategy path: a resource neither side states matches.
        const binding = clientAuthentication
          ? strategyBinding(computed)
          : computed;
        // Only a first build reads the session: a replacement for changed
        // means starts with nothing (§6.2). client_credentials takes no seed.
        const stored =
          grant === 'client_credentials' || !seeded
            ? null
            : await this.read(destination, 'session', () =>
                this.sessionStore.loadSession(destination),
              );
        const secret = this.boundOrDiscarded(destination, stored, binding);
        // The refresh token this build owns: the one the builder handed its
        // provider from the checked session (`RowBuild`), then whatever each
        // of its writes made of it — never one read from the store at write
        // time (§5.2, §6.2). Set before the provider can write.
        let owned: string | undefined;
        // The provider's persistence writes through here: resolved when the
        // write landed, rejected with the store's error when it did not —
        // refreshStatePersistence then does what onWriteFailure says.
        const write = async (tokens: PersistedTokens): Promise<void> => {
          const next = ownedAfter(owned, tokens.refreshToken);
          owned = next.owned;
          const outcome = await this.submit(
            'row',
            destination,
            commit.generation,
            {
              ...persisted(tokens),
              refreshToken: next.written,
              binding,
            },
          );
          if (outcome.written && !outcome.landed) throw outcome.error;
        };
        const common = {
          destination,
          client,
          secret,
          ...(clientAuthentication ? { clientAuthentication } : {}),
          renewal: this.renewal,
          onWriteFailure: this.onWriteFailure,
          write,
          logger: this.logger,
          authDebug: this.authDebug,
        };
        let built: RowBuild;
        if (isUaaGrant(grant)) {
          built = uaaProvider({
            ...common,
            grant,
            authorization: this.authorization,
          });
        } else if (isOidcGrant(grant)) {
          built = oidcProvider({
            ...common,
            grant,
            means: stated,
            oidcAuthorization: this.oidcAuthorization,
            deviceCodePresenter: this.deviceCodePresenter,
          });
        } else if (isSamlGrant(grant)) {
          built = samlProvider({
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
        owned = built.seededRefreshToken;
        const tokenProvider = built.provider;
        this.logger.debug(`[AuthBroker] Provider built for ${destination}`, {
          authType,
          grant,
          seeded: !!secret,
        });
        return { provider: tokenProvider, parties: tokenProvider };
      }
      const secret = await this.read(destination, 'session', () =>
        this.sessionStore.loadSession(destination),
      );
      const client =
        authType === 'jwt'
          ? await recorder.read<IAuthorizationConfig>('client')
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
    return { provider, parties: undefined };
  }

  /**
   * A token row's refusal when the consumer's `renewal` or `onWriteFailure`
   * is missing — named beside every other field and option the row lacks, in
   * one error — decided before any collaborator is called. With a
   * clientAuthentication strategy and no secret client, the client's fields
   * are not judged: the strategy would tell the certificate client's.
   */
  private rowRefusal(
    destination: string,
    grant: TokenGrant,
    means: IConnectionConfig,
    secretClient: IAuthorizationConfig | null,
  ): DestinationConfigError {
    const clientAuthenticated =
      !!this.clientAuthentication && grant !== 'saml2_pure';
    const client =
      clientAuthenticated && !secretClient ? undefined : secretClient;
    const check = {
      destination,
      client,
      clientAuthenticated,
      renewal: this.renewal,
      onWriteFailure: this.onWriteFailure,
    };
    const refusal = isUaaGrant(grant)
      ? uaaRefusal({ ...check, grant, authorization: this.authorization })
      : isOidcGrant(grant)
        ? oidcRefusal({
            ...check,
            grant,
            means,
            oidcAuthorization: this.oidcAuthorization,
            deviceCodePresenter: this.deviceCodePresenter,
          })
        : samlRefusal({
            ...check,
            grant,
            means,
            authorization: this.authorization,
            samlCookies: this.samlCookies,
            assertionReplayStore: this.assertionReplayStore,
          });
    return (
      refusal ??
      new DestinationConfigError(
        destination,
        optionsLacking(check),
        `a destination with grantType ${grant} lacks what its grant needs`,
      )
    );
  }

  /**
   * The stored secret when it is bound to this destination's resource and
   * issuer, else `null`: the provider is then built as with no session
   * and logs in afresh — the refresh token is not spent either.
   *
   * A stored credential not taken is logged in fixed words naming the
   * destination only — never a URI, a record or a token: a `warn` when the
   * binding could ever be seeded (`couldBeSeeded`) — the stored secret is not
   * recorded under the current means: another resource, row, client,
   * endpoint or trust, a 4.x record, or none — and a `debug` line when it
   * never could — a row never seeded by design (`token_exchange`), means
   * lacking what the record needs, or no `serviceUrl` — since that holds on
   * every start and nothing was discarded by a change.
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
      if (couldBeSeeded(binding)) {
        this.logger.warn(
          `[AuthBroker] ${destination}: the stored session secret is not recorded as issued under the destination's current means; not used, the provider obtains a new one`,
        );
      } else {
        this.logger.debug(
          `[AuthBroker] ${destination}: the destination's means do not state everything a session secret is bound to; a stored one is never used`,
        );
      }
    }
    return null;
  }

  /**
   * Waits for every session write queued so far and gives each pending one —
   * a write that did not land — one more attempt; rejects naming the
   * destinations whose store still refuses (an `AggregateError` of
   * `SessionWriteFailure`s). Nothing retries a pending write on its own: only
   * the destination's next write or `flush()` does, so call it on shutdown to
   * know whether every token a provider obtained is stored.
   *
   * Every caller joins one broker-wide slot (§7.5): its signal releases that
   * caller alone (`aborted`); the attempts run on, and a write still failing
   * stays pending. The `AggregateError` is rethrown as the same object to
   * every caller (D9).
   */
  flush(options?: BrokerCallOptions): Promise<void> {
    return joined(this.flushSlot, () => this.writer.flush(), options?.signal);
  }

  /**
   * One write of the destination's session secret — and nothing else — in one
   * `saveSession`, built from the write alone: the store merges, so every
   * field that must not survive from an earlier write is stated (§5.2).
   *
   * - A credential: `{ authorizationToken, expiresAt, refreshToken, issuedFor,
   *   issuedBy }`, or for `saml2_pure`'s cookies (`tokenType: 'saml'`)
   *   `{ sessionCookies, expiresAt, refreshToken: '', issuedFor, issuedBy }` —
   *   SAML has no refresh token, and one stored beside earlier cookies or a
   *   token is not this credential's.
   * - `refreshToken`: decided when the write was submitted — the build's own,
   *   or `''`, the store's clearing operation. The store is never read here.
   * - `issuedFor` / `issuedBy`: the binding fixed when the provider was built,
   *   `issuedFor` written as `''` when the means lack its source — never left
   *   out, so no earlier binding survives beside a new credential.
   * - A write that holds no credential (a refresh token discarded before any
   *   was held) writes only `refreshToken: ''`: the stored credential keeps
   *   its own binding — never re-labelled — and loses its refresh token.
   * - `expiresAt`: fixed when the credential arrived.
   * - A destination the key store now states as `basic` or `snc` is not
   *   written: those obtain no session secret.
   */
  private async writeSecret(
    destination: string,
    write: SecretWrite,
  ): Promise<void> {
    const { binding } = write;
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
    if (write.credential === '') {
      await this.sessionStore.saveSession(
        destination,
        asContract<IConfig>({ refreshToken: '' }),
      );
      this.logger.info(`[AuthBroker] Refresh token cleared for ${destination}`);
      return;
    }
    const secret = asContract<IConfig>({
      ...(write.cookies
        ? { sessionCookies: write.credential }
        : { authorizationToken: write.credential }),
      expiresAt: write.expiresAt,
      // saml2_pure: the cookies are the credential, and SAML has none.
      refreshToken: write.cookies ? '' : write.refreshToken,
      issuedFor: binding.issuedFor ?? '',
      issuedBy: binding.issuedBy,
    });
    await this.sessionStore.saveSession(destination, secret);
    this.logger.info(`[AuthBroker] Session secret saved for ${destination}`, {
      credential: write.cookies ? 'cookies' : 'token',
      hasRefreshToken: present(secret.refreshToken),
      expiresAt: write.expiresAt,
    });
  }

  /**
   * An `ITokenRefresher` for one destination, for injection into a connection:
   * `getToken()` is the broker's `getToken`, `refreshToken()` its forced
   * `refreshToken` — each call a waiter with `options.signal` (D10), so a
   * refresher held by a session ends with it.
   */
  createTokenRefresher(
    destination: string,
    options?: BrokerCallOptions,
  ): ITokenRefresher {
    const signal = options?.signal;
    return {
      getToken: () => this.getToken(destination, { signal }),
      refreshToken: () => this.refreshToken(destination, { signal }),
    };
  }
}
