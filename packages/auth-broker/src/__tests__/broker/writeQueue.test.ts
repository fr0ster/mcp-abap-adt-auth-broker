/**
 * The write queue and `onWriteFailure` (§5.3, §5.4, §3.4's `flush()`; D3,
 * D9, D23).
 *
 * - One plain queue per destination: its writes run one at a time, in the
 *   order they were queued, each writing what it was given; two destinations
 *   never wait on each other.
 * - A retired build's late write is dropped by its path's generation.
 * - A failed write stays pending — the latest state its destination reported
 *   — until the destination's next write or `flush()`; there is no timer.
 * - `'fail'`: the call whose write did not land fails, and every
 *   `getProvider` / `getToken` / `refreshToken` of the destination asks "is
 *   the last write pending" on entry and right before success, retrying it;
 *   `'continue'`: nothing fails, each failed write is one `warn` line.
 *
 * The queue cases run on in-memory stand-ins of the stores (the contract's
 * merge); the restart cases on auth-stores 4.0.0's `EnvDestinationStore` and
 * `AbapSessionStore` files, with real providers against a local token
 * endpoint. A "restart" is a fresh broker over fresh stores on the same files.
 * Nothing opens a browser.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { isAuthProviderFailure, readFailure } from '@mcp-abap-adt/auth-errors';
import { refreshOnly } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  type DestinationMeans,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IAuthProvider,
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  AuthBroker,
  type AuthBrokerConfig,
  SessionWriteFailure,
} from '../../index';
import { uaaRecord } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenAnswer,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

const D = 'TRIAL';
const E = 'OTHER';
const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
const CLIENT = 'sb-broker!t42';
const SECRET = 'S3CRET-client';
const REDIRECT = 'http://localhost/callback';
const R = 'R-seeded-never-in-a-line';
/** What a store's own error message says: never in a line or an error. */
const STORE_MARKER = 'STORE-MESSAGE-MARKER';
const HOUR = 3_600_000;

class StoreDiskError extends Error {
  readonly code = 'EACCES';
}

const diskError = () => new StoreDiskError(`cannot write ${STORE_MARKER} ${R}`);

const REFUSED: TokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

/** A login strategy: the code, as a browser would have brought it back. */
function login(): IAuthorizationStrategy<string> {
  return {
    authorize: async (request: AuthorizationRequest) => {
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    },
    dispose: async () => {},
  };
}

/** A token answer without a refresh token: a token-only result. */
function tokenOnly(jti: string): TokenAnswer & { token: string } {
  const token = jwtExpiringIn(3600, { jti });
  return {
    token,
    status: 200,
    body: { access_token: token, token_type: 'bearer', expires_in: 3600 },
  };
}

/** A manual promise. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Attempt {
  destination: string;
  config: IConfig;
  ok: boolean;
}

/**
 * A session store around `inner` that records every `saveSession` attempt
 * (what it was given, and whether it landed), fails while `failing` says so,
 * holds the next attempt on request, and counts how many run at once per
 * destination.
 */
function controlled(inner: ISessionStore) {
  const attempts: Attempt[] = [];
  let settledCount = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const running = new Map<string, number>();
  const most = new Map<string, number>();
  const holds: { arrive: () => void; released: Promise<void> }[] = [];
  const control = {
    /** Fail every attempt for which this answers an error. */
    failing: (_destination: string, _config: IConfig): Error | undefined =>
      undefined,
    attempts,
    /** The most attempts of one destination that ran at once. */
    most: (destination: string) => most.get(destination) ?? 0,
    /**
     * Resolves once `count` attempts have settled, and the broker has taken
     * in what they came to (a turn of the event loop later).
     */
    settled: (count: number) =>
      (settledCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          })
      ).then(() => new Promise<void>((resolve) => setImmediate(resolve))),
    /** Hold the next attempt until `release()`. */
    holdNext: () => {
      const arrived = gate();
      const released = gate();
      holds.push({ arrive: arrived.open, released: released.promise });
      return { arrived: arrived.promise, release: released.open };
    },
  };
  const store: ISessionStore = {
    loadSession: (d) => inner.loadSession(d),
    saveSession: async (d, config) => {
      const now = (running.get(d) ?? 0) + 1;
      running.set(d, now);
      most.set(d, Math.max(most.get(d) ?? 0, now));
      const attempt: Attempt = {
        destination: d,
        config: { ...(config as IConfig) },
        ok: false,
      };
      attempts.push(attempt);
      try {
        const hold = holds.shift();
        if (hold) {
          hold.arrive();
          await hold.released;
        }
        const error = control.failing(d, attempt.config);
        if (error) throw error;
        await inner.saveSession(d, config);
        attempt.ok = true;
      } finally {
        running.set(d, (running.get(d) ?? 1) - 1);
        settledCount += 1;
        for (const waiter of waiters.filter((w) => w.count <= settledCount)) {
          waiter.resolve();
        }
      }
    },
    getAuthorizationConfig: (d) => inner.getAuthorizationConfig(d),
    getConnectionConfig: (d) => inner.getConnectionConfig(d),
    setAuthorizationConfig: (d, c) => inner.setAuthorizationConfig(d, c),
    setConnectionConfig: (d, c) => inner.setConnectionConfig(d, c),
  };
  return { store, control };
}

/** The contract's merge in memory, per destination. */
function mergingStore(): {
  store: ISessionStore;
  held: (d: string) => Record<string, unknown>;
} {
  // Each destination starts with its connection, as a consumer's session
  // store states it for the consumer path.
  const sessions = new Map<string, Record<string, unknown>>(
    [D, E].map((d) => [d, { serviceUrl: SERVICE_URL, sapClient: '100' }]),
  );
  return {
    held: (d) => ({ ...(sessions.get(d) ?? {}) }),
    store: {
      loadSession: async (d) => ({ ...(sessions.get(d) ?? {}) }) as IConfig,
      saveSession: async (d, config) => {
        const next = { ...(sessions.get(d) ?? {}) };
        for (const [field, value] of Object.entries(config as object)) {
          if (value === undefined) continue;
          if (value === '') delete next[field];
          else next[field] = value;
        }
        sessions.set(d, next);
      },
      getAuthorizationConfig: async () => null,
      getConnectionConfig: async (d) => {
        const { refreshToken: _refresh, ...connection } = sessions.get(d) ?? {};
        return Object.keys(connection).length > 0
          ? (connection as IConnectionConfig)
          : null;
      },
      setAuthorizationConfig: async () => {},
      setConnectionConfig: async () => {},
    },
  };
}

/** A logger that records every line. */
function recordingLogger() {
  const lines: { level: string; message: string; meta: unknown }[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      lines.push({ level, message, meta });
    };
  const logger: ILogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { logger, lines };
}

/** A consumer's provider handing out `<label>-<n>`, in call order. */
function consumerProvider(label: string): IRefreshableTokenProvider {
  let n = 0;
  const answer = async (): Promise<ITokenResult> => {
    n += 1;
    return {
      authorizationToken: `${label}-${n}`,
      authType: 'authorization_code',
      expiresIn: 3600,
    };
  };
  return { getTokens: answer, refreshTokens: answer };
}

/** The call's failure for a write that did not land. */
function expectPersistingFailed(thrown: unknown, code = 'EACCES'): void {
  expect(isAuthProviderFailure(thrown)).toBe(true);
  const error = readFailure(thrown, 'unfamiliar-error');
  expect(error.kind).toBe('unknown');
  expect(error.facts).toEqual(
    expect.objectContaining({ operation: 'persisting-tokens', code }),
  );
}

const asTokens = (provider: IAuthProvider) =>
  provider as unknown as IRefreshableTokenProvider;

// ---------------------------------------------------------------------------
// The queue, on in-memory stores
// ---------------------------------------------------------------------------

describe('one queue per destination', () => {
  function consumerBroker(policy: 'fail' | 'continue' = 'fail') {
    const memory = mergingStore();
    const { store, control } = controlled(memory.store);
    const broker = new AuthBroker({
      ...STATED,
      onWriteFailure: policy,
      sessionStore: store,
      provider: consumerProvider('instance'),
    });
    return { broker, control, held: memory.held };
  }

  it('three writes queued behind a held one run one at a time, in order; another destination does not wait', async () => {
    const { broker, control, held } = consumerBroker();
    const first = control.holdNext();
    const calls = [broker.getToken(D)];
    await first.arrived;
    calls.push(broker.getToken(D), broker.getToken(D), broker.getToken(D));

    // Another destination's write lands while D's first is held.
    const other = await broker.getToken(E);
    expect(held(E).authorizationToken).toBe(other);
    expect(control.attempts.filter((a) => a.destination === D)).toHaveLength(1);

    first.release();
    const tokens = await Promise.all(calls);

    // Each call's own write, in the order the calls queued them.
    expect(new Set(tokens).size).toBe(4);
    expect(
      control.attempts
        .filter((a) => a.destination === D)
        .map((a) => a.config.authorizationToken),
    ).toEqual(tokens);
    expect(control.most(D)).toBe(1);
    expect(held(D).authorizationToken).toBe(tokens[3]);
  });

  it('each caller is told what its own write came to: a failed write among queued ones fails its caller only, and every write ran', async () => {
    const { broker, control, held } = consumerBroker();
    // The third write the store is given fails.
    control.failing = () =>
      control.attempts.length === 3 ? diskError() : undefined;
    const first = control.holdNext();
    const calls = [broker.getToken(D)];
    await first.arrived;
    calls.push(broker.getToken(D), broker.getToken(D), broker.getToken(D));
    first.release();

    const results = await Promise.allSettled(calls);

    // Every caller's own write ran, once each — none was folded into another.
    expect(control.attempts.map((a) => a.ok)).toEqual([
      true,
      true,
      false,
      true,
    ]);
    const written = control.attempts.map((a) => a.config.authorizationToken);
    expect(new Set(written).size).toBe(4);
    // The caller of each write is told what that write came to.
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(
      results.map((r) => (r.status === 'fulfilled' ? r.value : undefined)),
    ).toEqual([written[0], written[1], undefined, written[3]]);
    expectPersistingFailed((results[2] as PromiseRejectedResult).reason);
    // The later write landed: nothing is pending.
    expect(held(D).authorizationToken).toBe(written[3]);
    await expect(broker.flush()).resolves.toBeUndefined();
  });

  it('writes of the two paths queued while one is in flight both land, in queue order', async () => {
    const endpoint = await startTokenEndpoint();
    try {
      const memory = mergingStore();
      const { store, control } = controlled(memory.store);
      const keys: IServiceKeyStore = {
        getServiceKey: async () => null,
        getConnectionConfig: async () =>
          ({
            authType: 'jwt',
            grantType: 'client_credentials',
            serviceUrl: SERVICE_URL,
            sapClient: '100',
          }) as IConnectionConfig,
        getAuthorizationConfig: async () =>
          ({
            uaaUrl: endpoint.url,
            uaaClientId: CLIENT,
            uaaClientSecret: SECRET,
          }) as IAuthorizationConfig,
      };
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keys,
        provider: consumerProvider('consumer'),
      });
      const row = asTokens(await broker.getProvider(D));

      const first = control.holdNext();
      const consumerFirst = broker.getToken(D);
      await first.arrived;
      const rowWrite = row.getTokens();
      const consumerSecond = broker.getToken(D);
      first.release();

      await expect(consumerFirst).resolves.toBe('consumer-1');
      expect((await rowWrite).authorizationToken).toBe(endpoint.issued[0]);
      await expect(consumerSecond).resolves.toBe('consumer-2');
      // Each write ran once: the held one first, then the two queued behind it
      // (the row's after its token request, so its place among them is the
      // order they were queued in).
      const written = control.attempts.map((a) => a.config.authorizationToken);
      expect(written[0]).toBe('consumer-1');
      expect([...written].sort()).toEqual(
        ['consumer-1', 'consumer-2', endpoint.issued[0]].sort(),
      );
      expect(written.indexOf('consumer-1')).toBeLessThan(
        written.indexOf('consumer-2'),
      );
      expect(control.attempts.every((a) => a.ok)).toBe(true);
      expect(control.most(D)).toBe(1);
    } finally {
      await endpoint.close();
    }
  });
});

describe('a retired build', () => {
  it("a replaced provider's late write is dropped: never written, and the new build's session stays", async () => {
    const endpoint = await startTokenEndpoint();
    try {
      const memory = mergingStore();
      const { store, control } = controlled(memory.store);
      const client: IAuthorizationConfig = {
        uaaUrl: endpoint.url,
        uaaClientId: CLIENT,
        uaaClientSecret: SECRET,
      };
      const keys: IServiceKeyStore = {
        getServiceKey: async () => null,
        getConnectionConfig: async () =>
          ({
            authType: 'jwt',
            grantType: 'client_credentials',
            serviceUrl: SERVICE_URL,
            sapClient: '100',
          }) as IConnectionConfig,
        getAuthorizationConfig: async () => ({ ...client }),
      };
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: store,
        serviceKeyStore: keys,
      });

      const old = asTokens(await broker.getProvider(D));
      await old.getTokens();
      client.uaaClientSecret = 'S3CRET-rotated';
      const replacement = asTokens(await broker.getProvider(D));
      expect(replacement).not.toBe(old);
      await replacement.getTokens();
      expect(control.attempts).toHaveLength(2);

      // The old provider renews: its write is dropped, and its caller is not
      // failed for a write the broker refuses to make.
      expect((await old.refreshTokens()).authorizationToken).toBe(
        endpoint.issued[2],
      );

      expect(control.attempts.map((a) => a.config.authorizationToken)).toEqual([
        endpoint.issued[0],
        endpoint.issued[1],
      ]);
      expect(memory.held(D).authorizationToken).toBe(endpoint.issued[1]);
      await expect(broker.flush()).resolves.toBeUndefined();
    } finally {
      await endpoint.close();
    }
  });
});

describe('no timer', () => {
  it('the writer schedules nothing: a failed write leaves no timer behind', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const memory = mergingStore();
      const { store, control } = controlled(memory.store);
      control.failing = () => diskError();
      const broker = new AuthBroker({
        ...STATED,
        onWriteFailure: 'continue',
        sessionStore: store,
        provider: consumerProvider('instance'),
      });

      await expect(broker.getToken(D)).resolves.toBe('instance-1');

      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(3_600_000);
      // Nothing retried it: only the destination's next write or flush().
      expect(control.attempts).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the writer's source holds no timer", () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'SessionWriter.ts'),
      'utf8',
    );
    for (const timer of [
      'setTimeout',
      'setInterval',
      'setImmediate',
      '.unref(',
      'AbortSignal.timeout',
    ]) {
      expect(source).not.toContain(timer);
    }
  });
});

describe('flush()', () => {
  it('resolves once every queued write landed, a held one included', async () => {
    const memory = mergingStore();
    const { store, control } = controlled(memory.store);
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: store,
      provider: consumerProvider('instance'),
    });
    const first = control.holdNext();
    const call = broker.getToken(D);
    await first.arrived;

    let flushed = false;
    const flush = broker.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    first.release();
    await flush;
    await expect(call).resolves.toBe('instance-1');
    expect(memory.held(D).authorizationToken).toBe('instance-1');
  });

  it('rejects with the AggregateError of SessionWriteFailures naming each destination still failing; resolves once they land', async () => {
    const memory = mergingStore();
    const { store, control } = controlled(memory.store);
    const { logger, lines } = recordingLogger();
    const broker = new AuthBroker(
      {
        ...STATED,
        onWriteFailure: 'continue',
        sessionStore: store,
        provider: consumerProvider('instance'),
      },
      logger,
    );
    control.failing = () => diskError();
    await broker.getToken(D);
    await broker.getToken(E);

    const thrown = await broker.flush().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toContain(`"${D}"`);
    expect(aggregate.message).toContain(`"${E}"`);
    expect(aggregate.errors).toHaveLength(2);
    for (const failure of aggregate.errors) {
      expect(failure).toBeInstanceOf(SessionWriteFailure);
    }
    expect(
      aggregate.errors.map((f: SessionWriteFailure) => f.destination),
    ).toEqual([D, E]);
    expect(aggregate.errors.map((f: SessionWriteFailure) => f.message)).toEqual(
      [
        `"${D}": persisting the tokens failed (unknown error, EACCES)`,
        `"${E}": persisting the tokens failed (unknown error, EACCES)`,
      ],
    );
    // Each pending write was retried once: two writes, two retries.
    expect(control.attempts).toHaveLength(4);
    const everything = inspect([thrown, lines], { depth: 10 });
    expect(everything).not.toContain(STORE_MARKER);
    expect(everything).not.toContain(R);
    expect(everything).not.toContain('instance-1');
    expect(everything).not.toContain('instance-2');

    control.failing = () => undefined;
    await expect(broker.flush()).resolves.toBeUndefined();
    expect(memory.held(D).authorizationToken).toBe('instance-1');
    expect(memory.held(E).authorizationToken).toBe('instance-2');
    await expect(broker.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real providers on auth-stores files
// ---------------------------------------------------------------------------

describe('on the session files, with real providers', () => {
  let endpoint: TokenEndpoint;
  let dir: string;

  beforeEach(async () => {
    endpoint = await startTokenEndpoint();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-queue-'));
    fs.mkdirSync(keysDir());
    fs.mkdirSync(sessionsDir());
  });

  afterEach(async () => {
    await endpoint.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function keysDir(): string {
    return path.join(dir, 'keys');
  }
  function sessionsDir(): string {
    return path.join(dir, 'sessions');
  }

  async function state(
    means: DestinationMeans,
    destination = D,
  ): Promise<void> {
    await new EnvDestinationStore(keysDir()).setDestination(destination, means);
  }

  function uaaMeans(
    grant: 'authorization_code' | 'client_credentials',
  ): DestinationMeans {
    return {
      authType: 'jwt',
      grantType: grant,
      serviceUrl: SERVICE_URL,
      sapClient: '100',
      uaaUrl: endpoint.url,
      uaaClientId: CLIENT,
      uaaClientSecret: SECRET,
    };
  }

  const by = (
    grant: 'authorization_code' | 'client_credentials' = 'authorization_code',
  ) => uaaRecord(grant, endpoint.url, CLIENT);

  /** What a restart finds. */
  function stored(destination = D): Promise<IConfig | null> {
    return new AbapSessionStore(sessionsDir()).loadSession(destination);
  }

  async function seedSession(session: IConfig): Promise<void> {
    await new AbapSessionStore(sessionsDir()).saveSession(D, session);
  }

  /** The destination's session: a token (expired or valid) and R. */
  async function seeded(
    token: string,
    expiresAt: number,
  ): Promise<{ token: string }> {
    await state(uaaMeans('authorization_code'));
    await seedSession({
      authorizationToken: token,
      expiresAt,
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });
    return { token };
  }

  const seededExpired = () =>
    seeded(jwtExpiringIn(-60, { jti: 'expired' }), Date.now() - 60_000);
  const seededValid = () =>
    seeded(jwtExpiringIn(3600, { jti: 'valid' }), Date.now() + HOUR);

  /** A key store over the files whose next means read can be held. */
  function holdableKeys() {
    const inner = new EnvDestinationStore(keysDir());
    let hold: { arrive: () => void; released: Promise<void> } | undefined;
    const keys: IServiceKeyStore = {
      getServiceKey: (d) => inner.getServiceKey(d),
      getAuthorizationConfig: (d) => inner.getAuthorizationConfig(d),
      getConnectionConfig: async (d) => {
        const held = hold;
        hold = undefined;
        if (held) {
          held.arrive();
          await held.released;
        }
        return inner.getConnectionConfig(d);
      },
    };
    return {
      keys,
      holdNextMeans: () => {
        const arrived = gate();
        const released = gate();
        hold = { arrive: arrived.open, released: released.promise };
        return { arrived: arrived.promise, release: released.open };
      },
    };
  }

  function broker(
    options: Partial<AuthBrokerConfig> & { keys?: IServiceKeyStore } = {},
  ) {
    const { store, control } = controlled(new AbapSessionStore(sessionsDir()));
    const { logger, lines } = recordingLogger();
    const { keys, ...rest } = options;
    const b = new AuthBroker(
      {
        ...STATED,
        serviceKeyStore: keys ?? new EnvDestinationStore(keysDir()),
        authorization: () => login(),
        ...rest,
        sessionStore: store,
      },
      logger,
    );
    return { broker: b, control, lines };
  }

  /** The warn lines about a session write that did not land. */
  const warnings = <L extends { level: string; meta: unknown }>(
    lines: L[],
  ): L[] =>
    lines.filter(
      (line) =>
        line.level === 'warn' &&
        JSON.stringify(line.meta ?? null).includes(
          'persisting the tokens failed',
        ),
    );

  /** No line and no error holds a token, the refresh token or the store's text. */
  function expectNothingLeaked(...values: unknown[]): void {
    const everything = inspect(values, { depth: 10 });
    expect(everything).not.toContain(STORE_MARKER);
    expect(everything).not.toContain(R);
    for (const token of endpoint.issued) {
      expect(everything).not.toContain(token);
    }
  }

  describe('a failed write stays pending until the next write or flush()', () => {
    it("a failing '' write is carried by the next write of the same build: it lands, and a restart finds no refresh token", async () => {
      await seededExpired();
      endpoint.answerNext(REFUSED);
      const fresh = tokenOnly('login-only');
      endpoint.answerNext(fresh);
      const first = broker({ onWriteFailure: 'continue' });
      let failures = 1;
      first.control.failing = () => (failures-- > 0 ? diskError() : undefined);

      await expect(first.broker.getToken(D)).resolves.toBe(fresh.token);

      expect(first.control.attempts.map((a) => a.ok)).toEqual([false, true]);
      // The discard failed; the next write carries its ''.
      expect(first.control.attempts[1]?.config).toEqual(
        expect.objectContaining({
          authorizationToken: fresh.token,
          refreshToken: '',
        }),
      );
      expect((await stored())?.refreshToken).toBeUndefined();

      const restarted = broker();
      await restarted.broker.refreshToken(D);
      expect(endpoint.requests.slice(2).map((r) => r.grantType)).toEqual([
        'authorization_code',
      ]);
      expect(JSON.stringify(endpoint.requests.slice(1))).not.toContain(R);
      expectNothingLeaked(first.lines, restarted.lines);
    });

    it("a failing '' write with no later write: flush() alone retries it, it lands, and a restart finds no refresh token", async () => {
      const { token } = await seededValid();
      endpoint.answerNext(REFUSED);
      const first = broker({
        onWriteFailure: 'continue',
        renewal: () => refreshOnly(),
      });
      let failures = 1;
      first.control.failing = () => (failures-- > 0 ? diskError() : undefined);
      const provider = await first.broker.getProvider(D);

      // The refresh is refused: R is discarded, and its '' write fails.
      await provider.rejected(UNAUTHORIZED);
      expect(first.control.attempts.map((a) => a.ok)).toEqual([false]);
      expect((await stored())?.refreshToken).toBe(R);

      await expect(first.broker.flush()).resolves.toBeUndefined();

      expect(first.control.attempts.map((a) => a.ok)).toEqual([false, true]);
      expect(first.control.attempts[1]?.config).toEqual(
        first.control.attempts[0]?.config,
      );
      expect(await stored()).toEqual({
        authorizationToken: token,
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: by(),
      });
      expectNothingLeaked(first.lines);
    });

    it("a failed '' and then a failed token-only write: the retry is the latest write, which lands — a restart finds the new token and no refresh token", async () => {
      await seededExpired();
      endpoint.answerNext(REFUSED);
      const fresh = tokenOnly('login-only');
      endpoint.answerNext(fresh);
      const first = broker({ onWriteFailure: 'continue' });
      let failures = 2;
      first.control.failing = () => (failures-- > 0 ? diskError() : undefined);

      await expect(first.broker.getToken(D)).resolves.toBe(fresh.token);
      expect(first.control.attempts.map((a) => a.ok)).toEqual([false, false]);

      await expect(first.broker.flush()).resolves.toBeUndefined();

      expect(first.control.attempts[2]).toEqual({
        destination: D,
        config: first.control.attempts[1]?.config,
        ok: true,
      });
      expect(await stored()).toEqual({
        authorizationToken: fresh.token,
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: by(),
      });
    });
  });

  describe("onWriteFailure: 'fail'", () => {
    it('the obtaining call fails unknown persisting-tokens with the code; while pending each call retries first and is refused; another destination is unaffected; once it lands every call proceeds', async () => {
      await state(uaaMeans('client_credentials'));
      await state(uaaMeans('client_credentials'), E);
      const first = broker();
      first.control.failing = (d) => (d === D ? diskError() : undefined);

      expectPersistingFailed(
        await first.broker.getToken(D).catch((e: unknown) => e),
      );
      expect(endpoint.requests).toHaveLength(1);
      expect(first.control.attempts).toHaveLength(1);

      // Pending: each call retries it first, and is refused while it fails —
      // no provider is asked.
      for (const call of [
        () => first.broker.getProvider(D),
        () => first.broker.getToken(D),
        () => first.broker.refreshToken(D),
      ]) {
        const before = first.control.attempts.length;
        expectPersistingFailed(await call().catch((e: unknown) => e));
        expect(first.control.attempts).toHaveLength(before + 1);
        expect(first.control.attempts.at(-1)?.config).toEqual(
          first.control.attempts[0]?.config,
        );
      }
      expect(endpoint.requests).toHaveLength(1);

      // Another destination is not refused.
      expect(await first.broker.getToken(E)).toBe(endpoint.issued[1]);

      // The store takes the retry: the call proceeds.
      first.control.failing = () => undefined;
      expect(await first.broker.getToken(D)).toBe(endpoint.issued[0]);
      expect((await stored())?.authorizationToken).toBe(endpoint.issued[0]);
      await expect(first.broker.getProvider(D)).resolves.toBeDefined();
      expect(await first.broker.refreshToken(D)).toBe(endpoint.issued[2]);
      expect(endpoint.requests).toHaveLength(3);
      await expect(first.broker.flush()).resolves.toBeUndefined();
      expectNothingLeaked(first.lines);
    });

    it('a pending write left by a detached discard (an aborted getTokens on the provider getProvider returned) refuses the next call', async () => {
      await seededExpired();
      const held = endpoint.holdNext();
      const first = broker();
      first.control.failing = () => diskError();
      const provider = asTokens(await first.broker.getProvider(D));
      const controller = new AbortController();

      const cut = expect(
        provider.getTokens({ signal: controller.signal }),
      ).rejects.toBeDefined();
      await held.arrived;
      controller.abort();
      await cut;
      // The detached discard's write fails: nobody awaits it.
      await first.control.settled(1);
      expect(first.control.attempts[0]?.config).toEqual(
        expect.objectContaining({ refreshToken: '' }),
      );

      const before = endpoint.requests.length;
      expectPersistingFailed(
        await first.broker.getToken(D).catch((e: unknown) => e),
      );
      expect(endpoint.requests).toHaveLength(before);
      expect(first.control.attempts).toHaveLength(2);

      // Let the cut refresh's late answer go, and its write settle.
      first.control.failing = () => undefined;
      held.release();
      await first.control.settled(3);
      await expect(first.broker.flush()).resolves.toBeUndefined();
      expectNothingLeaked(first.lines);
    });
  });

  describe("onWriteFailure: 'continue'", () => {
    it('every call succeeds; one warn line per failed write, with logFields only', async () => {
      await state(uaaMeans('client_credentials'));
      const first = broker({ onWriteFailure: 'continue' });
      first.control.failing = () => diskError();

      expect(await first.broker.getToken(D)).toBe(endpoint.issued[0]);
      await expect(first.broker.getProvider(D)).resolves.toBeDefined();
      expect(await first.broker.getToken(D)).toBe(endpoint.issued[0]);
      expect(await first.broker.refreshToken(D)).toBe(endpoint.issued[1]);

      // Two writes, both failed; no call retried one.
      expect(first.control.attempts.map((a) => a.ok)).toEqual([false, false]);
      const warned = warnings(first.lines);
      expect(warned).toHaveLength(2);
      for (const line of warned) {
        expect(line.meta).toEqual({
          error: 'persisting the tokens failed (unknown error, EACCES)',
          kind: 'unknown',
        });
      }
      expectNothingLeaked(first.lines);
    });
  });

  describe('the check right before success', () => {
    /**
     * The already-held provider's discard: a refused forced refresh under
     * `refreshOnly()`, whose `''` write the store rejects — while `call` is
     * suspended in a held means read.
     */
    async function discardWhileSuspended(
      policy: 'fail' | 'continue',
      call: (b: AuthBroker) => Promise<unknown>,
    ) {
      await seededValid();
      const holdable = holdableKeys();
      const first = broker({
        onWriteFailure: policy,
        renewal: () => refreshOnly(),
        keys: holdable.keys,
      });
      first.control.failing = () => diskError();
      const provider = asTokens(await first.broker.getProvider(D));

      const read = holdable.holdNextMeans();
      const suspended = call(first.broker).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await read.arrived;

      endpoint.answerNext(REFUSED);
      await provider.refreshTokens().catch(() => undefined);
      await first.control.settled(1);
      expect(first.control.attempts).toEqual([
        expect.objectContaining({
          ok: false,
          config: expect.objectContaining({ refreshToken: '' }),
        }),
      ]);
      return { ...first, provider, read, suspended };
    }

    const calls = [
      [
        'getProvider awaiting a held store read',
        (b: AuthBroker) => b.getProvider(D),
      ],
      [
        'getToken answered from the cache, suspended before it returns',
        (b: AuthBroker) => b.getToken(D),
      ],
    ] as const;

    it.each(calls)(
      "'fail', the store still rejecting: %s retries the pending write and is refused",
      async (_name, call) => {
        const s = await discardWhileSuspended('fail', call);
        s.read.release();
        const outcome = await s.suspended;

        expect(outcome.ok).toBe(false);
        expectPersistingFailed(!outcome.ok && outcome.error);
        expect(s.control.attempts.map((a) => a.ok)).toEqual([false, false]);
        expect(s.control.attempts[1]?.config).toEqual(
          s.control.attempts[0]?.config,
        );
        expectNothingLeaked(s.lines, outcome);
      },
    );

    it.each(calls)(
      "'fail', the store taking the retry: %s succeeds, and the store holds no refresh token",
      async (_name, call) => {
        const s = await discardWhileSuspended('fail', call);
        s.control.failing = () => undefined;
        s.read.release();
        const outcome = await s.suspended;

        expect(outcome.ok).toBe(true);
        expect(s.control.attempts.map((a) => a.ok)).toEqual([false, true]);
        expect((await stored())?.refreshToken).toBeUndefined();
      },
    );

    it.each(calls)(
      "'continue': %s succeeds, and the failure is one warn line",
      async (_name, call) => {
        const s = await discardWhileSuspended('continue', call);
        s.read.release();
        const outcome = await s.suspended;

        expect(outcome.ok).toBe(true);
        expect(s.control.attempts.map((a) => a.ok)).toEqual([false]);
        expect(warnings(s.lines)).toHaveLength(1);
        expectNothingLeaked(s.lines);
      },
    );
  });
});
