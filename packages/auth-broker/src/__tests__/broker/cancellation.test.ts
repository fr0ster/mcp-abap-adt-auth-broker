/**
 * Cancellation.
 *
 * - One resolution per (destination, path) is an auth-errors `sharedAttempt`:
 *   one caller's abort releases that caller only; when every caller has
 *   aborted the attempt leaves the slot at once — a caller arriving meanwhile
 *   builds afresh — and the doomed build is never cached and writes nothing.
 * - `getProvider(…, { signal })` attaches that signal to the token or SNC
 *   provider it answers, built or cached; without a signal nothing is
 *   attached. The token API never attaches: it passes its signal to
 *   `getTokens` / `refreshTokens` only.
 * - The build's attempt signal reaches the `clientAuthentication` strategy.
 * - Every wait on the write queue races its caller's signal: an abort
 *   releases the caller (`aborted`, never success) and the write runs on.
 * - `flush({ signal })` and `createTokenRefresher(…, { signal })`.
 * - No listener is left behind on a signal.
 *
 * The providers are real (auth-providers 6) against a local token endpoint;
 * the stores are in-memory stand-ins whose reads and writes a test can hold.
 * A login is a strategy that binds a real socket and waits until its signal
 * aborts: a released login is proved by binding its port. Nothing opens a
 * browser.
 */

import { getEventListeners } from 'node:events';
import * as net from 'node:net';
import { isAuthProviderFailure, readFailure } from '@mcp-abap-adt/auth-errors';
import {
  BaseTokenProvider,
  refreshThenLogin,
  SncLogonProvider,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IClientAuthentication,
  IRefreshableTokenProvider,
  IRequestTarget,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import {
  AuthBroker,
  type AuthBrokerConfig,
  type ClientAuthenticationContext,
} from '../../index';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenAnswer,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com';
const REDIRECT = 'http://localhost/callback';
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;
const REFUSED: TokenAnswer = { status: 400, body: { error: 'invalid_grant' } };

let endpoint: TokenEndpoint;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await endpoint.close();
});

// ---- helpers ---------------------------------------------------------------

/** A manual promise. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A few turns of the event loop: long enough for settled work to be seen. */
async function turns(count = 20): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Whether `promise` settled within a few turns of the event loop. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await turns();
  return settled;
}

/** Whether the port can be bound now: the socket that held it is released. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Asserts `thrown` is auth-errors' `aborted` failure. */
function expectAborted(thrown: unknown): void {
  expect(isAuthProviderFailure(thrown)).toBe(true);
  const failure = readFailure(thrown, 'unfamiliar-error');
  expect(failure.kind).toBe('interactive-login');
  expect(failure.facts).toEqual(
    expect.objectContaining({ outcome: 'aborted' }),
  );
}

/** What the promise rejected with; fails the test when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (thrown: unknown) => thrown,
  );
}

/** The bearer token a provider put on one request. */
async function bearer(provider: IAuthProvider): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  const request: IRequestTarget = {
    header: (name, value) => {
      headers[name] = value;
    },
    cookies: () => {},
  };
  expect(await provider.authorize(request)).toEqual({ ok: true });
  return headers.Authorization?.slice('Bearer '.length);
}

function client(): IAuthorizationConfig {
  return {
    uaaUrl: endpoint.url,
    uaaClientId: 'broker-client',
    uaaClientSecret: 'S3CRET-client',
  };
}

function means(
  grant: NonNullable<IConnectionConfig['grantType']>,
): IConnectionConfig {
  return { authType: 'jwt', grantType: grant, serviceUrl: SERVICE_URL };
}

/**
 * A key store whose `getConnectionConfig` can be held: `holdNextRead()`
 * withholds the next read's answer until opened.
 */
function keyStore(
  conn: IConnectionConfig,
  auth: IAuthorizationConfig | null = client(),
) {
  const holds: Promise<void>[] = [];
  const store: jest.Mocked<IServiceKeyStore> = {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => auth),
    getConnectionConfig: jest.fn(async (_d: string) => {
      const hold = holds.shift();
      if (hold) await hold;
      return conn;
    }),
  };
  return {
    store,
    /** Hold the next means read until released. */
    holdNextRead() {
      const g = gate();
      holds.push(g.promise);
      return { release: g.open };
    },
  };
}

interface HeldSave {
  /** Resolves once the held `saveSession` was called. */
  arrived: Promise<void>;
  release(): void;
}

/**
 * A session store over a map. `holdNextSave()` withholds the next
 * `saveSession` until released; `failNextSave()` rejects the next one. The
 * map is written when a save lands.
 */
function sessionStore() {
  const sessions = new Map<string, IConfig>();
  const holds: { arrive: () => void; released: Promise<void> }[] = [];
  let failing = 0;
  const landed: IConfig[] = [];
  const store: jest.Mocked<ISessionStore> = {
    loadSession: jest.fn(async (d: string) => {
      const s = sessions.get(d);
      return s ? { ...s } : null;
    }),
    saveSession: jest.fn(async (d: string, c: unknown) => {
      const hold = holds.shift();
      if (hold) {
        hold.arrive();
        await hold.released;
      }
      if (failing > 0) {
        failing -= 1;
        throw Object.assign(new Error('disk full'), { code: 'EACCES' });
      }
      const written = c as IConfig;
      landed.push({ ...written });
      sessions.set(d, { ...(sessions.get(d) ?? {}), ...written });
    }),
    getAuthorizationConfig: jest.fn(async (_d: string) => null),
    getConnectionConfig: jest.fn(async (_d: string) => null),
    setAuthorizationConfig: jest.fn(
      async (_d: string, _c: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_d: string, _c: IConnectionConfig) => {},
    ),
  };
  return {
    store,
    landed,
    stored: () => sessions.get(D),
    holdNextSave(): HeldSave {
      const arrived = gate();
      const released = gate();
      holds.push({ arrive: arrived.open, released: released.promise });
      return { arrived: arrived.promise, release: released.open };
    },
    failNextSave() {
      failing += 1;
    },
  };
}

interface Login {
  port: number;
  signal: AbortSignal | undefined;
  /** Resolves once the login has released its socket. */
  released: Promise<void>;
}

/**
 * The interactive strategy of the UAA code grant. `answering`: logins answer
 * a code at once. Otherwise each login binds a socket on an ephemeral port
 * and waits until its request's signal aborts, then closes the socket and
 * throws — as a callback server would.
 */
function loginStrategy() {
  const logins: Login[] = [];
  const waiting: ((login: Login) => void)[] = [];
  const control = {
    answering: false,
    logins,
    /** Resolves with the next login that holds a socket. */
    nextHeld(): Promise<Login> {
      return new Promise((resolve) => waiting.push(resolve));
    },
    strategy: (): IAuthorizationStrategy<string> => ({
      authorize: async (request: AuthorizationRequest) => {
        await request.buildAuthorizationUrl(REDIRECT);
        if (control.answering) {
          return { payload: 'the-code', redirectUri: REDIRECT };
        }
        const server = net.createServer();
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        const { port } = server.address() as net.AddressInfo;
        const closed = gate();
        const login: Login = {
          port,
          signal: request.signal,
          released: closed.promise,
        };
        logins.push(login);
        waiting.shift()?.(login);
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          request.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        await new Promise<void>((resolve) => server.close(() => resolve()));
        closed.open();
        throw new Error('the login was aborted');
      },
    }),
  };
  return control;
}

function codeBroker(
  sessions: ReturnType<typeof sessionStore>,
  logins: ReturnType<typeof loginStrategy>,
  extra: Partial<AuthBrokerConfig> = {},
) {
  const keys = keyStore(means('authorization_code'));
  const broker = new AuthBroker({
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
    sessionStore: sessions.store,
    serviceKeyStore: keys.store,
    authorization: () => logins.strategy(),
    ...extra,
  });
  return { broker, keys };
}

function credentialsBroker(
  sessions: ReturnType<typeof sessionStore>,
  extra: Partial<AuthBrokerConfig> = {},
) {
  const keys = keyStore(means('client_credentials'));
  const renewal = jest.fn(() => refreshThenLogin());
  const broker = new AuthBroker({
    renewal,
    onWriteFailure: 'fail',
    sessionStore: sessions.store,
    serviceKeyStore: keys.store,
    ...extra,
  });
  return { broker, keys, renewal };
}

/** A consumer provider instance answering a fresh token on every call. */
function consumerProvider(): IRefreshableTokenProvider & { count: number } {
  const provider = {
    count: 0,
    getTokens: async (): Promise<ITokenResult> => {
      provider.count += 1;
      return {
        authType: 'client_credentials',
        authorizationToken: jwtExpiringIn(3600, {
          jti: `consumer-${provider.count}`,
        }),
        expiresIn: 3600,
      };
    },
    refreshTokens: async (): Promise<ITokenResult> => provider.getTokens(),
  };
  return provider;
}

// ---- the shared resolution --------------------------------------------------

describe('one resolution per (destination, path), through sharedAttempt', () => {
  it('two getProvider callers, one aborts: it is aborted, the other gets the provider', async () => {
    const sessions = sessionStore();
    const { broker, keys } = credentialsBroker(sessions);
    const read = keys.holdNextRead();
    const leaving = new AbortController();

    const first = broker.getProvider(D, { signal: leaving.signal });
    const aborted = rejection(first);
    const second = broker.getProvider(D);
    await turns();
    leaving.abort();
    expectAborted(await aborted);
    read.release();

    const provider = await second;
    expect(await bearer(provider)).toBe(endpoint.issued[0]);
    // The resolution ran on, once: the next call answers the same provider.
    expect(await broker.getProvider(D)).toBe(provider);
  });

  it('both abort: nothing is cached, the next call builds', async () => {
    const sessions = sessionStore();
    const { broker, keys, renewal } = credentialsBroker(sessions);
    const read = keys.holdNextRead();
    const a = new AbortController();
    const b = new AbortController();

    const first = rejection(broker.getProvider(D, { signal: a.signal }));
    const second = rejection(broker.getProvider(D, { signal: b.signal }));
    await turns();
    a.abort();
    b.abort();
    expectAborted(await first);
    expectAborted(await second);
    // The doomed build completes after its attempt was aborted.
    read.release();
    await turns();
    expect(renewal).toHaveBeenCalledTimes(1);

    const provider = await broker.getProvider(D);
    // A build of its own: the doomed one was never cached.
    expect(renewal).toHaveBeenCalledTimes(2);
    expect(await broker.getProvider(D)).toBe(provider);
    expect(sessions.landed).toEqual([]);
  });

  it('the doomed build: every caller aborted during a held store read; a new caller builds afresh; the late completion is not cached and writes nothing', async () => {
    const sessions = sessionStore();
    const { broker, keys, renewal } = credentialsBroker(sessions);
    const read = keys.holdNextRead();
    const a = new AbortController();

    const doomed = rejection(broker.getProvider(D, { signal: a.signal }));
    await turns();
    a.abort();
    expectAborted(await doomed);

    // The first build's read is still held: a new caller does not join it.
    const fresh = broker.getProvider(D);
    expect(await settledSoon(fresh)).toBe(true);
    const provider = await fresh;
    expect(renewal).toHaveBeenCalledTimes(1);

    read.release();
    await turns();
    // The doomed build completed (its renewal option asked), and is not the
    // destination's provider: the cache still answers the fresh one.
    expect(renewal).toHaveBeenCalledTimes(2);
    expect(await broker.getProvider(D)).toBe(provider);
    expect(endpoint.requests).toEqual([]);
    expect(sessions.store.saveSession).not.toHaveBeenCalled();
  });

  it('the consumer path: every caller aborts during the factory build — not cached, the next call builds', async () => {
    const sessions = sessionStore();
    const keys = keyStore(means('client_credentials'));
    const factory = jest.fn(() => consumerProvider());
    const broker = new AuthBroker({
      onWriteFailure: 'fail',
      sessionStore: sessions.store,
      serviceKeyStore: keys.store,
      provider: factory,
    });
    // The consumer path reads the session's connection config in its start.
    const held = gate();
    sessions.store.getConnectionConfig.mockImplementationOnce(async () => {
      await held.promise;
      return null;
    });
    const a = new AbortController();

    const first = rejection(broker.getToken(D, { signal: a.signal }));
    await turns();
    a.abort();
    expectAborted(await first);
    held.open();
    await turns();
    expect(factory).toHaveBeenCalledTimes(1);

    await broker.getToken(D);
    expect(factory).toHaveBeenCalledTimes(2);
    // The doomed provider was never asked, nor its answer written.
    expect(factory.mock.results[0]?.value.count).toBe(0);
    expect(sessions.landed).toHaveLength(1);
  });
});

// ---- a doomed attempt changes nothing -----------------------------------------

describe('a doomed attempt never removes what a fresh attempt committed', () => {
  it('the row path: the doomed identity re-read answers "changed" after a fresh build was committed — the fresh provider stays cached', async () => {
    const conn: IConnectionConfig = means('client_credentials');
    let hold: Promise<void> | undefined;
    const keys: jest.Mocked<IServiceKeyStore> = {
      getServiceKey: jest.fn(async (_d: string) => null),
      getAuthorizationConfig: jest.fn(async (_d: string) => client()),
      getConnectionConfig: jest.fn(async (_d: string) => {
        const held = hold;
        hold = undefined;
        // What the store holds when asked, answered when released.
        const answer = { ...conn };
        if (held) await held;
        return answer;
      }),
    };
    const renewal = jest.fn(() => refreshThenLogin());
    const broker = new AuthBroker({
      renewal,
      onWriteFailure: 'fail',
      sessionStore: sessionStore().store,
      serviceKeyStore: keys,
    });

    const first = await broker.getProvider(D);
    conn.serviceUrl = 'https://other.example.com'; // the means change
    const read = gate();
    hold = read.promise;
    const leaving = new AbortController();
    const doomed = rejection(broker.getProvider(D, { signal: leaving.signal }));
    await turns();
    leaving.abort();
    expectAborted(await doomed);

    // A fresh attempt: the means changed, so it builds and commits.
    const fresh = await broker.getProvider(D);
    expect(fresh).not.toBe(first);
    expect(renewal).toHaveBeenCalledTimes(2);

    // The doomed attempt's re-read now answers "changed".
    read.open();
    await turns();
    expect(await broker.getProvider(D)).toBe(fresh);
    expect(renewal).toHaveBeenCalledTimes(2);
    // The builds stay at three: the first, the fresh one, and none after.
    await broker.getProvider(D);
    expect(renewal).toHaveBeenCalledTimes(2);
  });

  it('the consumer path: the same for the factory’s provider', async () => {
    const sessions = sessionStore();
    const factory = jest.fn(() => consumerProvider());
    const broker = new AuthBroker({
      onWriteFailure: 'fail',
      sessionStore: sessions.store,
      serviceKeyStore: keyStore(means('client_credentials')).store,
      provider: factory,
    });
    let serviceUrl = SERVICE_URL;
    let hold: Promise<void> | undefined;
    // The consumer path's identity holds the session's serviceUrl.
    sessions.store.getConnectionConfig.mockImplementation(async () => {
      const held = hold;
      hold = undefined;
      const answer = { serviceUrl };
      if (held) await held;
      return answer;
    });

    await broker.getToken(D);
    expect(factory).toHaveBeenCalledTimes(1);
    serviceUrl = 'https://other.example.com';
    const read = gate();
    hold = read.promise;
    const leaving = new AbortController();
    const doomed = rejection(broker.getToken(D, { signal: leaving.signal }));
    await turns();
    leaving.abort();
    expectAborted(await doomed);

    await broker.getToken(D);
    expect(factory).toHaveBeenCalledTimes(2);
    const fresh = factory.mock.results[1]?.value;

    read.open();
    await turns();
    await broker.getToken(D);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(fresh.count).toBe(2);
  });
});

// ---- a signal that aborts after the last wait --------------------------------

/**
 * A consumer's signal that turns aborted, without dispatching, when a
 * listener is removed once it is armed — that is, once the wait it took part
 * in settled: armed during the call's last wait, the abort falls between that
 * wait and the call's answer. Armed from the start: at the first wait's end.
 */
function abortsAfterItsLastWait(armed = true): {
  signal: AbortSignal;
  arm: () => void;
} {
  let live = armed;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener: () => {},
    removeEventListener: () => {
      if (live) signal.aborted = true;
    },
    dispatchEvent: () => false,
    onabort: null,
    throwIfAborted: () => {},
  };
  return {
    signal: signal as unknown as AbortSignal,
    arm: () => {
      live = true;
    },
  };
}

describe('a signal that aborts after the last wait: never success', () => {
  it('getProvider under continue rejects aborted and attaches nothing', async () => {
    const attach = jest.spyOn(BaseTokenProvider.prototype, 'attach');
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions, {
      onWriteFailure: 'continue',
    });
    const { signal } = abortsAfterItsLastWait();

    expectAborted(await rejection(broker.getProvider(D, { signal })));
    expect(attach).not.toHaveBeenCalled();
  });

  it.each(['fail', 'continue'] as const)(
    'getToken under %s rejects aborted at its first wait’s end',
    async (onWriteFailure) => {
      const sessions = sessionStore();
      const { broker } = credentialsBroker(sessions, { onWriteFailure });
      const { signal } = abortsAfterItsLastWait();
      expectAborted(await rejection(broker.getToken(D, { signal })));
    },
  );

  it('getToken under continue, the row path: armed while the provider’s write runs — the last wait — rejects aborted', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions, {
      onWriteFailure: 'continue',
    });
    const { signal, arm } = abortsAfterItsLastWait(false);
    const save = sessions.store.saveSession.getMockImplementation();
    sessions.store.saveSession.mockImplementationOnce(async (d, c) => {
      arm();
      await save?.(d, c);
    });
    expectAborted(await rejection(broker.getToken(D, { signal })));
    expect(sessions.stored()?.authorizationToken).toBe(endpoint.issued[0]);
  });

  it('getToken under continue, the consumer path: armed while its own write runs — the last wait — rejects aborted', async () => {
    const sessions = sessionStore();
    const broker = new AuthBroker({
      onWriteFailure: 'continue',
      sessionStore: sessions.store,
      serviceKeyStore: keyStore(means('client_credentials')).store,
      provider: consumerProvider(),
    });
    const { signal, arm } = abortsAfterItsLastWait(false);
    const save = sessions.store.saveSession.getMockImplementation();
    sessions.store.saveSession.mockImplementationOnce(async (d, c) => {
      arm();
      await save?.(d, c);
    });
    expectAborted(await rejection(broker.getToken(D, { signal })));
    expect(sessions.landed).toHaveLength(1);
  });

  it('the consumer path: a write whose wait never started leaves no unhandled rejection, even when the logger throws', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const sessions = sessionStore();
      sessions.failNextSave();
      const request = new AbortController();
      const provider = consumerProvider();
      const answering = provider.getTokens;
      // The caller leaves while the provider answers: the write is queued,
      // and its wait is refused at once.
      provider.getTokens = async () => {
        const result = await answering();
        request.abort();
        return result;
      };
      const throwing = {
        info: () => {},
        debug: () => {},
        error: () => {},
        warn: () => {
          throw new Error('the logger failed');
        },
      };
      const broker = new AuthBroker(
        {
          onWriteFailure: 'continue',
          sessionStore: sessions.store,
          serviceKeyStore: keyStore(means('client_credentials')).store,
          provider,
        },
        throwing,
      );
      expectAborted(
        await rejection(broker.getToken(D, { signal: request.signal })),
      );
      await turns(50);
      expect(sessions.store.saveSession).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

// ---- what getProvider's signal attaches -------------------------------------

describe('getProvider’s signal is attached to the provider it answers', () => {
  it('a login rejected() starts is aborted by that signal: the strategy’s signal aborts and its port is free', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const session = new AbortController();

    const provider = await broker.getProvider(D, { signal: session.signal });
    const held = logins.nextHeld();
    const answer = provider.rejected(UNAUTHORIZED);
    const login = await held;
    expect(await canBind(login.port)).toBe(false);

    session.abort();
    expect((await answer).ok).toBe(false);
    await login.released;
    expect(login.signal?.aborted).toBe(true);
    expect(await canBind(login.port)).toBe(true);
  });

  it('not while another getProvider caller’s signal is live — a cache hit attaches too', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const first = new AbortController();
    const second = new AbortController();

    const provider = await broker.getProvider(D, { signal: first.signal });
    // A cache hit: the same provider, its signal attached as well.
    expect(await broker.getProvider(D, { signal: second.signal })).toBe(
      provider,
    );
    const held = logins.nextHeld();
    const answer = provider.rejected(UNAUTHORIZED);
    const login = await held;

    first.abort();
    await turns();
    expect(login.signal?.aborted).toBe(false);
    expect(await canBind(login.port)).toBe(false);

    second.abort();
    expect((await answer).ok).toBe(false);
    await login.released;
    expect(login.signal?.aborted).toBe(true);
    expect(await canBind(login.port)).toBe(true);
  });

  it('two concurrent getProvider callers of one resolution each attach their own signal', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const first = new AbortController();
    const second = new AbortController();

    const [one, two] = await Promise.all([
      broker.getProvider(D, { signal: first.signal }),
      broker.getProvider(D, { signal: second.signal }),
    ]);
    expect(two).toBe(one);
    const held = logins.nextHeld();
    const answer = one.rejected(UNAUTHORIZED);
    const login = await held;

    first.abort();
    await turns();
    expect(login.signal?.aborted).toBe(false);
    second.abort();
    expect((await answer).ok).toBe(false);
    await login.released;
    expect(await canBind(login.port)).toBe(true);
  });

  it('getProvider without a signal attaches nothing', async () => {
    const attach = jest.spyOn(BaseTokenProvider.prototype, 'attach');
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const session = new AbortController();

    const provider = await broker.getProvider(D, { signal: session.signal });
    expect(attach).toHaveBeenCalledTimes(1);
    // An unsignalled caller of the same provider adds no party: once the
    // signalled session has gone, nothing keeps the login alive.
    expect(await broker.getProvider(D)).toBe(provider);
    expect(attach).toHaveBeenCalledTimes(1);

    const held = logins.nextHeld();
    const answer = provider.rejected(UNAUTHORIZED);
    const login = await held;
    session.abort();
    expect((await answer).ok).toBe(false);
    await login.released;
    expect(await canBind(login.port)).toBe(true);
  });

  it('an SNC provider gets the signal too; a basic one has nothing to attach', async () => {
    const attach = jest.spyOn(SncLogonProvider.prototype, 'attach');
    const session = new AbortController();
    const snc = new AuthBroker({
      sessionStore: sessionStore().store,
      serviceKeyStore: keyStore({
        authType: 'snc',
        sncPartnerName: 'p:CN=SID',
        sncLib: '/nowhere/libsapcrypto.so',
      }).store,
    });
    await snc.getProvider(D, { signal: session.signal });
    expect(attach).toHaveBeenCalledWith(session.signal);
    await snc.getProvider(D);
    expect(attach).toHaveBeenCalledTimes(1);

    const basic = new AuthBroker({
      sessionStore: sessionStore().store,
      serviceKeyStore: keyStore({
        authType: 'basic',
        serviceUrl: SERVICE_URL,
        username: 'U',
        password: 'P',
      }).store,
    });
    await basic.getProvider(D, { signal: session.signal });
    expect(getEventListeners(session.signal, 'abort')).toHaveLength(1);
  });
});

// ---- the token API never attaches -------------------------------------------

describe('the token API never attaches', () => {
  it('the immortal-party regression: token calls, then two signalled sessions; both close → the login aborts and its port is free', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    logins.answering = true;
    // A token call with no signal, and one whose signal is never aborted (a
    // request that simply finished): neither may keep a later login alive.
    const finished = new AbortController();
    await broker.getToken(D);
    await broker.getToken(D, { signal: finished.signal });
    await broker.refreshToken(D, { signal: finished.signal });

    const first = new AbortController();
    const second = new AbortController();
    const provider = await broker.getProvider(D, { signal: first.signal });
    expect(await broker.getProvider(D, { signal: second.signal })).toBe(
      provider,
    );

    logins.answering = false;
    endpoint.answerNext(REFUSED); // the refresh is refused: a login follows
    const held = logins.nextHeld();
    const answer = provider.rejected(UNAUTHORIZED);
    const login = await held;
    first.abort();
    second.abort();

    expect((await answer).ok).toBe(false);
    await login.released;
    expect(login.signal?.aborted).toBe(true);
    expect(await canBind(login.port)).toBe(true);
  });

  it('after every session closed, an unsignalled getProvider (a cache hit) handed to a connection logs in and gets a token', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const session = new AbortController();

    const provider = await broker.getProvider(D, { signal: session.signal });
    session.abort();
    expect(await broker.getProvider(D)).toBe(provider);

    logins.answering = true;
    expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
    expect(await bearer(provider)).toBe(endpoint.issued[0]);
  });

  it('mixed connections: the signalled one closes, the unsignalled one’s next renewal gets a token', async () => {
    const sessions = sessionStore();
    const logins = loginStrategy();
    const { broker } = codeBroker(sessions, logins);
    const session = new AbortController();

    const signalled = await broker.getProvider(D, { signal: session.signal });
    const unsignalled = await broker.getProvider(D);
    expect(unsignalled).toBe(signalled);
    session.abort();

    logins.answering = true;
    expect(await unsignalled.rejected(UNAUTHORIZED)).toEqual({ ok: true });
    expect(await bearer(unsignalled)).toBe(endpoint.issued[0]);
  });

  it('getToken(…, { signal }) aborted → aborted; a concurrent unsignalled getToken gets the token', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    const request = new AbortController();
    const held = endpoint.holdNext();

    const cancelled = rejection(broker.getToken(D, { signal: request.signal }));
    const waiting = broker.getToken(D);
    await held.arrived;
    request.abort();
    expectAborted(await cancelled);

    held.release();
    expect(await waiting).toBe(endpoint.issued[0]);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('refreshToken(…, { signal }) aborted → aborted; the refresh runs on for an unsignalled caller', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    await broker.getToken(D);
    const request = new AbortController();
    const held = endpoint.holdNext();

    const cancelled = rejection(
      broker.refreshToken(D, { signal: request.signal }),
    );
    await held.arrived;
    const waiting = broker.refreshToken(D);
    // The unsignalled caller has joined the refresh in flight.
    await turns();
    request.abort();
    expectAborted(await cancelled);

    held.release();
    const token = await waiting;
    expect(token).toBe(endpoint.issued[1]);
  });

  it('createTokenRefresher(…, { signal }): every call of the refresher is a waiter with that signal', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    const session = new AbortController();
    const refresher = broker.createTokenRefresher(D, {
      signal: session.signal,
    });
    const held = endpoint.holdNext();

    const cancelled = rejection(refresher.getToken());
    await held.arrived;
    session.abort();
    expectAborted(await cancelled);
    expectAborted(await rejection(refresher.refreshToken()));
    held.release();
    // An unsignalled caller is served as before.
    expect(await broker.getToken(D)).toBe(endpoint.issued.at(-1));
  });
});

// ---- the clientAuthentication context's signal --------------------------------

describe('ClientAuthenticationContext.signal', () => {
  it('aborts when every build waiter has left, not before', async () => {
    const contexts: ClientAuthenticationContext[] = [];
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions, {
      clientAuthentication: async (context) => {
        contexts.push(context);
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        throw new Error('the certificate loader was aborted');
      },
    });
    const a = new AbortController();
    const b = new AbortController();

    const first = rejection(broker.getProvider(D, { signal: a.signal }));
    const second = rejection(broker.getToken(D, { signal: b.signal }));
    await turns();
    expect(contexts).toHaveLength(1);
    const signal = contexts[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    a.abort();
    expectAborted(await first);
    expect(signal?.aborted).toBe(false);

    b.abort();
    expectAborted(await second);
    expect(signal?.aborted).toBe(true);
    await turns();
    // The build that failed after its abort is not cached: a new call asks
    // the strategy again.
    const third = new AbortController();
    const again = rejection(broker.getProvider(D, { signal: third.signal }));
    await turns();
    expect(contexts).toHaveLength(2);
    third.abort();
    expectAborted(await again);
  });

  it('a strategy that answers is built with as before', async () => {
    const sessions = sessionStore();
    const seen: AbortSignal[] = [];
    const { broker } = credentialsBroker(sessions, {
      clientAuthentication: async (context): Promise<IClientAuthentication> => {
        seen.push(context.signal);
        return {
          authenticate: async () => ({
            headers: {
              Authorization: `Basic ${Buffer.from('broker-client:S3CRET-client').toString('base64')}`,
            },
          }),
        };
      },
    });
    expect(await broker.getToken(D)).toBe(endpoint.issued[0]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
  });
});

// ---- every wait on the write queue ------------------------------------------

describe.each(['fail', 'continue'] as const)(
  'a call’s write held or queued, under %s: an abort releases the caller, the write lands afterwards',
  (onWriteFailure) => {
    it('getToken on the row path: its persistence write held', async () => {
      const sessions = sessionStore();
      const { broker } = credentialsBroker(sessions, { onWriteFailure });
      const save = sessions.holdNextSave();
      const request = new AbortController();

      const call = rejection(broker.getToken(D, { signal: request.signal }));
      await save.arrived;
      request.abort();
      expectAborted(await call);

      save.release();
      await turns();
      expect((await sessions.store.loadSession(D))?.authorizationToken).toBe(
        endpoint.issued[0],
      );
    });

    it('refreshToken on the row path: its persistence write held', async () => {
      const sessions = sessionStore();
      const { broker } = credentialsBroker(sessions, { onWriteFailure });
      await broker.getToken(D);
      const save = sessions.holdNextSave();
      const request = new AbortController();

      const call = rejection(
        broker.refreshToken(D, { signal: request.signal }),
      );
      await save.arrived;
      request.abort();
      expectAborted(await call);

      save.release();
      await turns();
      expect((await sessions.store.loadSession(D))?.authorizationToken).toBe(
        endpoint.issued[1],
      );
    });

    it('the consumer path: its write held after the provider returned', async () => {
      const sessions = sessionStore();
      const provider = consumerProvider();
      const broker = new AuthBroker({
        onWriteFailure,
        sessionStore: sessions.store,
        serviceKeyStore: keyStore(means('client_credentials')).store,
        provider,
      });
      const save = sessions.holdNextSave();
      const request = new AbortController();

      const call = rejection(broker.getToken(D, { signal: request.signal }));
      await save.arrived;
      expect(provider.count).toBe(1);
      request.abort();
      expectAborted(await call);

      save.release();
      await turns();
      expect(sessions.landed).toHaveLength(1);
      expect((await sessions.store.loadSession(D))?.authorizationToken).toBe(
        sessions.landed[0]?.authorizationToken,
      );
    });

    it('the consumer path: its write queued behind another held write', async () => {
      const sessions = sessionStore();
      const provider = consumerProvider();
      const broker = new AuthBroker({
        onWriteFailure,
        sessionStore: sessions.store,
        serviceKeyStore: keyStore(means('client_credentials')).store,
        provider,
      });
      const save = sessions.holdNextSave();
      const request = new AbortController();
      // Both pass their entry checks before either writes: the first one's
      // write is held, the second one's queued behind it.
      const before = broker.getToken(D);
      const call = rejection(broker.getToken(D, { signal: request.signal }));
      await save.arrived;
      await turns();
      expect(provider.count).toBe(2);
      expect(sessions.store.saveSession).toHaveBeenCalledTimes(1);
      request.abort();
      expectAborted(await call);

      save.release();
      await before;
      await turns();
      // Both writes ran, in order: the aborted call's write is the last.
      expect(sessions.landed).toHaveLength(2);
      const second = sessions.landed[1]?.authorizationToken;
      expect((await sessions.store.loadSession(D))?.authorizationToken).toBe(
        second,
      );
    });

    it('refreshToken on the consumer path: its write held', async () => {
      const sessions = sessionStore();
      const provider = consumerProvider();
      const broker = new AuthBroker({
        onWriteFailure,
        sessionStore: sessions.store,
        serviceKeyStore: keyStore(means('client_credentials')).store,
        provider,
      });
      const save = sessions.holdNextSave();
      const request = new AbortController();

      const call = rejection(
        broker.refreshToken(D, { signal: request.signal }),
      );
      await save.arrived;
      request.abort();
      expectAborted(await call);
      save.release();
      await turns();
      expect(sessions.landed).toHaveLength(1);
    });
  },
);

describe('a wait for a pending write releases its caller on abort', () => {
  it('under fail, getProvider awaiting a write still in flight is aborted; the write lands', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    const save = sessions.holdNextSave();
    const writing = broker.getToken(D);
    await save.arrived;
    const session = new AbortController();

    const call = rejection(broker.getProvider(D, { signal: session.signal }));
    expect(await settledSoon(call)).toBe(false);
    session.abort();
    expectAborted(await call);

    save.release();
    expect(await writing).toBe(endpoint.issued[0]);
    expect(sessions.stored()?.authorizationToken).toBe(endpoint.issued[0]);
  });

  it('under continue, getProvider does not wait for a write at all', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions, {
      onWriteFailure: 'continue',
    });
    const save = sessions.holdNextSave();
    const writing = broker.getToken(D);
    await save.arrived;

    const provider = broker.getProvider(D);
    expect(await settledSoon(provider)).toBe(true);
    save.release();
    await writing;
  });

  it.each(['getProvider', 'getToken', 'refreshToken'] as const)(
    'under fail, %s retrying a pending write is aborted while the retry is held; the retry lands',
    async (method) => {
      const sessions = sessionStore();
      const { broker } = credentialsBroker(sessions);
      sessions.failNextSave();
      // The token stands, the write did not land: the call fails, and the
      // write is pending.
      expect(
        readFailure(await rejection(broker.getToken(D)), 'unfamiliar-error')
          .kind,
      ).toBe('unknown');
      const save = sessions.holdNextSave();
      const request = new AbortController();

      const call = rejection(broker[method](D, { signal: request.signal }));
      await save.arrived;
      request.abort();
      expectAborted(await call);

      save.release();
      await turns();
      expect(sessions.stored()?.authorizationToken).toBe(endpoint.issued[0]);
      // Landed: the next call goes on.
      await broker.getProvider(D);
    },
  );

  it('flush({ signal }) releases its caller; the retry runs on and lands', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions, {
      onWriteFailure: 'continue',
    });
    sessions.failNextSave();
    await broker.getToken(D);
    const save = sessions.holdNextSave();
    const shutdown = new AbortController();

    const flushing = rejection(broker.flush({ signal: shutdown.signal }));
    await save.arrived;
    shutdown.abort();
    expectAborted(await flushing);

    save.release();
    await turns();
    expect(sessions.stored()?.authorizationToken).toBe(endpoint.issued[0]);
    await broker.flush();
  });
});

// ---- no listener left behind --------------------------------------------------

describe('every waiter’s listener is removed', () => {
  const count = (signal: AbortSignal) =>
    getEventListeners(signal, 'abort').length;

  it('the token API, flush and a refresher leave each signal at its baseline', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    const signal = new AbortController().signal;
    expect(count(signal)).toBe(0);

    await broker.getToken(D, { signal });
    await broker.refreshToken(D, { signal });
    await broker.flush({ signal });
    await broker.createTokenRefresher(D, { signal }).getToken();
    expect(count(signal)).toBe(0);
  });

  it('the consumer path leaves its signal at its baseline', async () => {
    const sessions = sessionStore();
    const broker = new AuthBroker({
      onWriteFailure: 'fail',
      sessionStore: sessions.store,
      serviceKeyStore: keyStore(means('client_credentials')).store,
      provider: consumerProvider(),
    });
    const signal = new AbortController().signal;
    await broker.getToken(D, { signal });
    await broker.refreshToken(D, { signal });
    expect(count(signal)).toBe(0);
  });

  it('a failed resolution leaves its waiters’ signals at their baseline', async () => {
    const sessions = sessionStore();
    const keys = keyStore(means('client_credentials'));
    keys.store.getConnectionConfig.mockRejectedValueOnce(new Error('broken'));
    const broker = new AuthBroker({
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      sessionStore: sessions.store,
      serviceKeyStore: keys.store,
    });
    const signal = new AbortController().signal;
    await rejection(broker.getProvider(D, { signal }));
    expect(count(signal)).toBe(0);
  });

  it('getProvider leaves exactly the provider’s party, which its abort releases', async () => {
    const sessions = sessionStore();
    const { broker } = credentialsBroker(sessions);
    const session = new AbortController();
    await broker.getProvider(D, { signal: session.signal });
    await broker.getProvider(D, { signal: session.signal });
    // One party per signal, nothing of the broker's own.
    expect(count(session.signal)).toBe(1);
    session.abort();
    expect(count(session.signal)).toBe(0);
  });
});
