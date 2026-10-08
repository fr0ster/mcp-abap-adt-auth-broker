/**
 * What one session write is, and the refresh state a build owns (§5.2, §5.6,
 * §6.4).
 *
 * auth-stores 4.0.0's `saveSession` merges: a field a write leaves out keeps
 * what is stored, whoever stored it. So every write the broker makes states
 * the refresh token — the one the build owns, or `''` — and, beside a
 * credential, both binding fields; a credential-free write states only
 * `refreshToken: ''`. A refresh token reaches the store only from the build
 * that was seeded with it or obtained it — never from the store at write
 * time.
 *
 * End to end over auth-stores 4.0.0's `EnvDestinationStore` (the means) and
 * `AbapSessionStore` (the secret) files, with real providers against a local
 * token endpoint; a "restart" is a fresh broker over fresh stores on the same
 * files. Where a case needs a store the auth-stores files cannot hold (a
 * refresh token with a binding and no credential, or a store that merges
 * binding fields as plainly as any other), an in-memory store with the
 * contract's merge — a field given sets, `''` clears, absent keeps — stands in,
 * and says so. Expected records are assembled from the spec's grammar
 * (`helpers/bindingRecord`), never by the broker's own function. Every
 * interactive part is a test double; nothing opens a browser.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type MockSamlIdp, startMockSamlIdp } from '@mcp-abap-adt/auth-mocks';
import {
  ClientCredentialsProvider,
  createInMemoryReplayStore,
  refreshThenLogin,
} from '@mcp-abap-adt/auth-providers';
import {
  ABAP_SESSION_VARS,
  AbapSessionStore,
  type DestinationMeans,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IRefreshableTokenProvider,
  IRenewalStrategy,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  IConnectionConfig,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AuthBroker, type AuthBrokerConfig } from '../../index';
import { record, samlPureRecord, uaaRecord } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenAnswer,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.setTimeout(30_000);

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
/** The canonical `issuedFor` of SERVICE_URL with client 100. */
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
const CLIENT = 'sb-broker!t42';
const OTHER_CLIENT = 'sb-other!t7';
const SECRET = 'S3CRET-client';
const REDIRECT = 'http://localhost/callback';
/** A refresh token of other means, or of nobody this build owns. */
const R_OLD = 'R-old-must-never-come-back';
const R = 'R-seeded';
const HOUR = 3_600_000;

let endpoint: TokenEndpoint;
let dir: string;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-writes-'));
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

/** The key file states these means. */
async function state(means: DestinationMeans): Promise<void> {
  await new EnvDestinationStore(keysDir()).setDestination(D, means);
}

/** The means as the key store answers them — what the record is made of. */
async function statedMeans(): Promise<IConnectionConfig> {
  return (await new EnvDestinationStore(keysDir()).getConnectionConfig(
    D,
  )) as IConnectionConfig;
}

function uaaMeans(
  grant: 'authorization_code' | 'client_credentials',
  clientId = CLIENT,
): DestinationMeans {
  return {
    authType: 'jwt',
    grantType: grant,
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    uaaUrl: endpoint.url,
    uaaClientId: clientId,
    uaaClientSecret: SECRET,
  };
}

/** The record of a UAA row with the endpoint and `clientId`. */
const by = (
  grant: 'authorization_code' | 'client_credentials' = 'authorization_code',
  clientId = CLIENT,
) => uaaRecord(grant, endpoint.url, clientId);

/** The session file as a fresh store reads it: what a restart finds. */
function stored(): Promise<IConfig | null> {
  return new AbapSessionStore(sessionsDir()).loadSession(D);
}

/** A session put into the file by another writer. */
async function seed(session: IConfig): Promise<void> {
  await new AbapSessionStore(sessionsDir()).saveSession(D, session);
}

/** A session file as 4.x wrote it: the bare issuer URI, or no issuedBy. */
function seed4x(fields: {
  token: string;
  refreshToken: string;
  issuedBy?: string;
}): void {
  const V = ABAP_SESSION_VARS;
  fs.writeFileSync(
    path.join(sessionsDir(), `${D}.env`),
    [
      `${V.AUTHORIZATION_TOKEN}=${fields.token}`,
      `${V.EXPIRES_AT}=${Date.now() + HOUR}`,
      `${V.REFRESH_TOKEN}=${fields.refreshToken}`,
      `${V.ISSUED_FOR}=${FOR}`,
      ...(fields.issuedBy === undefined
        ? []
        : [`${V.ISSUED_BY}=${fields.issuedBy}`]),
      '',
    ].join('\n'),
  );
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

const REFUSED: TokenAnswer = {
  status: 400,
  body: { error: 'invalid_grant' },
};

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

/** A login the user never completes. */
function refusedLogin(): IAuthorizationStrategy<string> {
  return {
    authorize: async () => {
      throw new Error('the user closed the window');
    },
    dispose: async () => {},
  };
}

/** A renewal that logs in first, whatever is held: a token-only result while held. */
const loginFirst = (): IRenewalStrategy => ({
  next: (situation) =>
    situation.steps.length === 0 ? { next: 'login' } : { next: 'stop' },
});

/**
 * A session store that records every write it is given and lets a test wait
 * until a number of them landed.
 */
function observed(inner: ISessionStore): {
  store: ISessionStore;
  writes: IConfig[];
  landed: (count: number) => Promise<void>;
} {
  const writes: IConfig[] = [];
  let done = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  const store: ISessionStore = {
    loadSession: (d) => inner.loadSession(d),
    saveSession: async (d, config) => {
      writes.push({ ...(config as IConfig) });
      await inner.saveSession(d, config);
      done += 1;
      for (const waiter of waiting.filter((w) => w.count <= done)) {
        waiter.resolve();
      }
    },
    getAuthorizationConfig: (d) => inner.getAuthorizationConfig(d),
    getConnectionConfig: (d) => inner.getConnectionConfig(d),
    setAuthorizationConfig: (d, c) => inner.setAuthorizationConfig(d, c),
    setConnectionConfig: (d, c) => inner.setConnectionConfig(d, c),
  };
  return {
    store,
    writes,
    landed: (count) =>
      done >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push({ count, resolve });
          }),
  };
}

/**
 * The contract's merge and nothing more, in memory: a field given sets it,
 * `''` clears it, absent keeps it — binding fields included, and a binding is
 * kept without a credential. For the cases the auth-stores files cannot hold.
 */
function mergingStore(initial: IConfig): {
  store: ISessionStore;
  held: () => Record<string, unknown>;
} {
  let session: Record<string, unknown> = { ...initial };
  return {
    held: () => ({ ...session }),
    store: {
      loadSession: async () => ({ ...session }) as IConfig,
      saveSession: async (_d, config) => {
        const next = { ...session };
        for (const [field, value] of Object.entries(config as object)) {
          if (value === undefined) continue;
          if (value === '') delete next[field];
          else next[field] = value;
        }
        session = next;
      },
      getAuthorizationConfig: async () => null,
      getConnectionConfig: async () => null,
      setAuthorizationConfig: async () => {},
      setConnectionConfig: async () => {},
    },
  };
}

function broker(
  options: Partial<AuthBrokerConfig> & {
    sessions?: ISessionStore;
  } = {},
) {
  const watched = observed(
    options.sessions ?? new AbapSessionStore(sessionsDir()),
  );
  const { sessions: _sessions, ...rest } = options;
  const b = new AuthBroker({
    ...STATED,
    serviceKeyStore: new EnvDestinationStore(keysDir()),
    authorization: () => login(),
    ...rest,
    sessionStore: watched.store,
  });
  return { broker: b, ...watched };
}

/** The token provider getProvider built for D. */
async function tokenProvider(
  b: AuthBroker,
): Promise<IRefreshableTokenProvider> {
  return (await b.getProvider(D)) as unknown as IRefreshableTokenProvider;
}

/** Every credential write states the refresh token and both binding fields. */
function expectStated(writes: IConfig[]): void {
  for (const write of writes) {
    const fields = write as Record<string, unknown>;
    if (fields.authorizationToken || fields.sessionCookies) {
      expect(typeof fields.refreshToken).toBe('string');
      expect(typeof fields.issuedFor).toBe('string');
      expect(typeof fields.issuedBy).toBe('string');
    }
  }
}

/** Nothing any token request carried holds `secret`. */
function neverSent(secret: string): void {
  expect(JSON.stringify(endpoint.requests)).not.toContain(secret);
}

const EXPIRED = () => jwtExpiringIn(-60, { jti: 'expired' });

describe('a refused refresh: the refresh token is cleared, and stays cleared after a restart', () => {
  async function seededExpired(): Promise<string> {
    const token = EXPIRED();
    await state(uaaMeans('authorization_code'));
    await seed({
      authorizationToken: token,
      expiresAt: Date.now() - 60_000,
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });
    return token;
  }

  it('refused refresh → token-only login → the store holds no refresh token, and a restart logs in', async () => {
    await seededExpired();
    endpoint.answerNext(REFUSED);
    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);
    const first = broker();

    await expect(first.broker.getToken(D)).resolves.toBe(fresh.token);

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
      'authorization_code',
    ]);
    expect(endpoint.requests[0]?.params.refresh_token).toBe(R);
    expect(await stored()).toEqual({
      authorizationToken: fresh.token,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: by(),
    });
    expectStated(first.writes);

    const restarted = broker();
    await restarted.broker.refreshToken(D);
    expect(endpoint.requests.slice(2).map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    expect(JSON.stringify(endpoint.requests.slice(1))).not.toContain(R);
  });

  it('the fallback login failing: the refresh token is still cleared', async () => {
    const token = await seededExpired();
    endpoint.answerNext(REFUSED);
    const first = broker({ authorization: () => refusedLogin() });

    const failed = expect(first.broker.getToken(D)).rejects.toBeDefined();
    await failed;

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
    ]);
    expect(await stored()).toEqual({
      authorizationToken: token,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: by(),
    });

    const restarted = broker();
    await restarted.broker.getToken(D);
    expect(endpoint.requests.slice(1).map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    expect(JSON.stringify(endpoint.requests.slice(1))).not.toContain(R);
  });

  it('a refresh cut after dispatch (ifCut: discard): the clearing write lands, a restart finds no refresh token, and the late answer with nothing newer is written', async () => {
    const token = await seededExpired();
    const held = endpoint.holdNext();
    const first = broker();
    const provider = await tokenProvider(first.broker);
    const controller = new AbortController();

    const cut = expect(
      provider.getTokens({ signal: controller.signal }),
    ).rejects.toBeDefined();
    await held.arrived;
    controller.abort();
    await cut;
    await first.landed(1);

    expect(first.writes).toEqual([
      expect.objectContaining({ authorizationToken: token, refreshToken: '' }),
    ]);
    expect((await stored())?.refreshToken).toBeUndefined();

    // A restart while the cut refresh is still out: nothing to refresh with.
    const restarted = broker({ authorization: () => refusedLogin() });
    const refused = expect(restarted.broker.getToken(D)).rejects.toBeDefined();
    await refused;
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
    ]);

    // The late answer: R2, and nothing newer committed — written.
    held.release();
    await first.landed(2);
    const n = endpoint.issued.length;
    expect(await stored()).toEqual({
      authorizationToken: endpoint.issued[n - 1],
      expiresAt: expect.any(Number),
      refreshToken: `refresh-${n}`,
      issuedFor: FOR,
      issuedBy: by(),
    });
    expectStated(first.writes);
  });

  it('a new refresh token after a cleared one wins, and a restart refreshes with it', async () => {
    await seededExpired();
    endpoint.answerNext(REFUSED);
    endpoint.answerNext(tokenOnly('login-only'));
    const first = broker();
    await first.broker.getToken(D);
    expect((await stored())?.refreshToken).toBeUndefined();

    // The next login answers a refresh token: R2.
    await first.broker.refreshToken(D);
    const n = endpoint.issued.length;
    expect((await stored())?.refreshToken).toBe(`refresh-${n}`);

    const restarted = broker();
    await restarted.broker.refreshToken(D);
    const last = endpoint.requests.at(-1);
    expect(last?.grantType).toBe('refresh_token');
    expect(last?.params.refresh_token).toBe(`refresh-${n}`);
  });
});

describe('a token-only result while a refresh token is held: the owned one, written as its value', () => {
  it('a build seeded with R writes R, the binding unchanged; a restart refreshes with R', async () => {
    await state(uaaMeans('authorization_code'));
    await seed({
      authorizationToken: jwtExpiringIn(3600, { jti: 'stored' }),
      expiresAt: Date.now() + HOUR,
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });
    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);
    const first = broker({ renewal: () => loginFirst() });

    await expect(first.broker.refreshToken(D)).resolves.toBe(fresh.token);

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    expect(first.writes).toEqual([
      {
        authorizationToken: fresh.token,
        expiresAt: expect.any(Number),
        refreshToken: R,
        issuedFor: FOR,
        issuedBy: by(),
      },
    ]);
    expect(await stored()).toEqual({
      authorizationToken: fresh.token,
      expiresAt: expect.any(Number),
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });

    const restarted = broker();
    await restarted.broker.refreshToken(D);
    expect(endpoint.requests.at(-1)?.params.refresh_token).toBe(R);
  });

  it('a build that obtained R writes R for its next token-only result', async () => {
    await state(uaaMeans('authorization_code'));
    const first = broker({ renewal: () => loginFirst() });
    await first.broker.getToken(D);
    expect((await stored())?.refreshToken).toBe('refresh-1');

    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);
    await expect(first.broker.refreshToken(D)).resolves.toBe(fresh.token);

    expect(await stored()).toEqual({
      authorizationToken: fresh.token,
      expiresAt: expect.any(Number),
      refreshToken: 'refresh-1',
      issuedFor: FOR,
      issuedBy: by(),
    });
    expect(first.writes.at(-1)?.refreshToken).toBe('refresh-1');
  });
});

describe('the refresh token a build owns, isolated (no rebuild)', () => {
  it('a build started with nothing writes "" for a token-only result, though another writer put a refresh token under the same record after the build', async () => {
    await state(uaaMeans('authorization_code'));
    const first = broker();
    await first.broker.getProvider(D);
    // After the build read the empty store: another writer, the same record.
    await seed({
      authorizationToken: jwtExpiringIn(-60, { jti: 'other-writer' }),
      expiresAt: Date.now() - 60_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: by(),
    });
    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);

    await expect(first.broker.getToken(D)).resolves.toBe(fresh.token);

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'authorization_code',
    ]);
    neverSent(R_OLD);
    expect(first.writes.map((w) => w.refreshToken)).toEqual(['']);
    expect(await stored()).toEqual({
      authorizationToken: fresh.token,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: by(),
    });
  });

  it('a client_credentials result writes "" over a refresh token stored under its own record', async () => {
    await state(uaaMeans('client_credentials'));
    await seed({
      authorizationToken: jwtExpiringIn(-60, { jti: 'stored' }),
      expiresAt: Date.now() - 60_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: by('client_credentials'),
    });
    const first = broker();

    await first.broker.getToken(D);

    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'client_credentials',
    ]);
    expect(first.writes.map((w) => w.refreshToken)).toEqual(['']);
    expect(await stored()).toEqual({
      authorizationToken: endpoint.issued[0],
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: by('client_credentials'),
    });
  });

  it('a discard makes the owned refresh token none: the next token-only write is ""', async () => {
    await state(uaaMeans('authorization_code'));
    await seed({
      authorizationToken: EXPIRED(),
      expiresAt: Date.now() - 60_000,
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });
    endpoint.answerNext(REFUSED);
    // One strategy for the build: the first login is refused, the next one
    // completes.
    let attempts = 0;
    const once: IAuthorizationStrategy<string> = {
      authorize: async (request) => {
        attempts += 1;
        if (attempts === 1) throw new Error('the user closed the window');
        return login().authorize(request);
      },
      dispose: async () => {},
    };
    const first = broker({ authorization: () => once });
    const provider = await tokenProvider(first.broker);
    const failed = expect(provider.getTokens()).rejects.toBeDefined();
    await failed;
    expect(first.writes.map((w) => w.refreshToken)).toEqual(['']);

    // The same build, a token-only result afterwards: still "".
    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);
    await expect(provider.getTokens()).resolves.toMatchObject({
      authorizationToken: fresh.token,
    });
    expect(first.writes.map((w) => w.refreshToken)).toEqual(['', '']);
    expect((await stored())?.refreshToken).toBeUndefined();
  });
});

describe('a session bound to other means: what the write leaves in the store, and a restart', () => {
  const identities: [string, () => Promise<void>][] = [
    [
      'another client (a version-2 record)',
      () =>
        seed({
          authorizationToken: jwtExpiringIn(3600, { jti: 'identity-a' }),
          expiresAt: Date.now() + HOUR,
          refreshToken: R_OLD,
          issuedFor: FOR,
          issuedBy: by('authorization_code', OTHER_CLIENT),
        }),
    ],
    [
      '4.x: a bare issuer URI',
      async () =>
        seed4x({
          token: jwtExpiringIn(3600, { jti: 'identity-4x' }),
          refreshToken: R_OLD,
          issuedBy: `${endpoint.url}?client_id=sb-broker%21t42`,
        }),
    ],
    [
      '4.x: no issuedBy',
      async () =>
        seed4x({
          token: jwtExpiringIn(3600, { jti: 'identity-4x' }),
          refreshToken: R_OLD,
        }),
    ],
  ];

  describe.each(identities)('the store holds %s', (_label, storeA) => {
    it('authorization_code, a token-only login: no R_old, the binding B; a restart sends no refresh token', async () => {
      await state(uaaMeans('authorization_code'));
      await storeA();
      const fresh = tokenOnly('login-only');
      endpoint.answerNext(fresh);
      const first = broker();

      await expect(first.broker.getToken(D)).resolves.toBe(fresh.token);

      expect(await stored()).toEqual({
        authorizationToken: fresh.token,
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: by(),
      });
      expectStated(first.writes);

      const restarted = broker();
      await restarted.broker.refreshToken(D);
      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'authorization_code',
        'authorization_code',
      ]);
      neverSent(R_OLD);
    });

    it('client_credentials: no R_old, the binding B; a restart sends no refresh token', async () => {
      await state(uaaMeans('client_credentials'));
      await storeA();
      const first = broker();

      await first.broker.getToken(D);

      expect(await stored()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: by('client_credentials'),
      });
      expectStated(first.writes);

      const restarted = broker();
      await restarted.broker.refreshToken(D);
      expect(endpoint.requests.map((r) => r.grantType)).toEqual([
        'client_credentials',
        'client_credentials',
      ]);
      neverSent(R_OLD);
    });

    it('saml2_pure cookies: no R_old, the binding B; a restart is seeded with the cookies and no refresh token', async () => {
      await state(samlMeans());
      await storeA();
      const first = samlBroker();

      expect(await (await first.broker.getProvider(D)).prepare()).toEqual({
        ok: true,
      });

      expect(await stored()).toEqual({
        sessionCookies: COOKIES,
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: samlPureRecord(await statedMeans()),
      });
      expectStated(first.writes);

      const restarted = samlBroker();
      expect(await (await restarted.broker.getProvider(D)).prepare()).toEqual({
        ok: true,
      });
      // Seeded with the cookies: no second login, and no refresh token.
      expect(restarted.logins()).toBe(0);
      expect((await stored())?.refreshToken).toBeUndefined();
      neverSent(R_OLD);
    });

    it('a consumer factory, a token-only result: no R_old, its record; a restart hands the factory no R_old', async () => {
      await state(uaaMeans('client_credentials'));
      await storeA();
      const handed: (IAuthorizationConfig | null)[] = [];
      const factory = (
        _d: string,
        auth: IAuthorizationConfig | null,
      ): IRefreshableTokenProvider => {
        handed.push(auth);
        return clientCredentials();
      };
      const first = broker({ provider: factory });

      await first.broker.getToken(D);

      expect(await stored()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: record(
          'provider/jwt/client_credentials',
          { clientId: CLIENT, uaaUrl: endpoint.url },
          '',
        ),
      });
      expectStated(first.writes);

      const restarted = broker({ provider: factory });
      await restarted.broker.getToken(D);
      expect(handed[1]?.refreshToken ?? '').toBe('');
      neverSent(R_OLD);
    });

    it('a consumer instance, a token-only result: no R_old, its record', async () => {
      await state(uaaMeans('client_credentials'));
      await storeA();
      const first = broker({ provider: clientCredentials() });

      await first.broker.getToken(D);

      expect(await stored()).toEqual({
        authorizationToken: endpoint.issued[0],
        expiresAt: expect.any(Number),
        issuedFor: FOR,
        issuedBy: record('provider/jwt/client_credentials', {}, ''),
      });
      expectStated(first.writes);
      neverSent(R_OLD);
    });
  });

  it('means stating no resource over a session with one: issuedFor is written as "", so a merging store keeps none', async () => {
    const means = uaaMeans('authorization_code');
    delete means.serviceUrl;
    await state(means);
    const merging = mergingStore({
      authorizationToken: jwtExpiringIn(3600, { jti: 'identity-a' }),
      expiresAt: Date.now() + HOUR,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: by('authorization_code', OTHER_CLIENT),
    });
    const fresh = tokenOnly('login-only');
    endpoint.answerNext(fresh);
    const first = broker({ sessions: merging.store });

    await first.broker.getToken(D);

    expect(first.writes).toEqual([
      {
        authorizationToken: fresh.token,
        expiresAt: expect.any(Number),
        refreshToken: '',
        issuedFor: '',
        issuedBy: by(),
      },
    ]);
    expect(merging.held()).toEqual({
      authorizationToken: fresh.token,
      expiresAt: expect.any(Number),
      issuedBy: by(),
    });
  });
});

describe('a credential-free write: only refreshToken ""', () => {
  // A refresh token with its binding and no credential: the auth-stores files
  // drop a binding without a credential, so a merging store stands in.
  async function discardOver(other: IConfig): Promise<{
    writes: IConfig[];
    held: Record<string, unknown>;
  }> {
    await state(uaaMeans('authorization_code'));
    const merging = mergingStore({
      refreshToken: R,
      issuedFor: FOR,
      issuedBy: by(),
    });
    const first = broker({
      sessions: merging.store,
      authorization: () => refusedLogin(),
    });
    const provider = await tokenProvider(first.broker);
    // After the build: another writer stores its own credential.
    await merging.store.saveSession(D, other);
    endpoint.answerNext(REFUSED);

    const failed = expect(provider.getTokens()).rejects.toBeDefined();
    await failed;

    expect(endpoint.requests[0]?.params.refresh_token).toBe(R);
    return { writes: first.writes, held: merging.held() };
  }

  it('over another identity’s session: its credential keeps its own binding and loses the refresh token', async () => {
    const other = jwtExpiringIn(3600, { jti: 'identity-a' });
    const otherBy = by('authorization_code', OTHER_CLIENT);
    const { writes, held } = await discardOver({
      authorizationToken: other,
      issuedFor: 'https://other.example.com:443',
      issuedBy: otherBy,
    });

    expect(writes).toEqual([{ refreshToken: '' }]);
    expect(held).toEqual({
      authorizationToken: other,
      issuedFor: 'https://other.example.com:443',
      issuedBy: otherBy,
    });
  });

  it('over the same identity’s session: its credential and binding stay, the refresh token goes', async () => {
    const same = jwtExpiringIn(3600, { jti: 'identity-b' });
    const { writes, held } = await discardOver({
      authorizationToken: same,
      issuedFor: FOR,
      issuedBy: by(),
    });

    expect(writes).toEqual([{ refreshToken: '' }]);
    expect(held).toEqual({
      authorizationToken: same,
      issuedFor: FOR,
      issuedBy: by(),
    });
  });
});

describe('saml2_pure and the consumer path write refreshToken ""', () => {
  it('saml2_pure cookies clear a refresh token stored beside earlier cookies of the same record', async () => {
    await state(samlMeans());
    await seed({
      sessionCookies: 'SAP_SESSIONID_OLD=expired',
      expiresAt: Date.now() - 60_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: samlPureRecord(await statedMeans()),
    });
    const first = samlBroker();

    expect(await (await first.broker.getProvider(D)).prepare()).toEqual({
      ok: true,
    });

    expect(first.logins()).toBe(1);
    expect(first.writes.map((w) => w.refreshToken)).toEqual(['']);
    expect(await stored()).toEqual({
      sessionCookies: COOKIES,
      expiresAt: expect.any(Number),
      issuedFor: FOR,
      issuedBy: samlPureRecord(await statedMeans()),
    });
  });

  it('a consumer instance’s result without a refresh token writes "" over one stored under its own record', async () => {
    await state(uaaMeans('client_credentials'));
    await seed({
      authorizationToken: jwtExpiringIn(-60, { jti: 'stored' }),
      expiresAt: Date.now() - 60_000,
      refreshToken: R_OLD,
      issuedFor: FOR,
      issuedBy: record('provider/jwt/client_credentials', {}, ''),
    });
    const first = broker({ provider: clientCredentials() });

    await first.broker.getToken(D);

    expect(first.writes.map((w) => w.refreshToken)).toEqual(['']);
    expect((await stored())?.refreshToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------- helpers

/** A consumer's provider: real, and it never holds a refresh token. */
function clientCredentials(): ClientCredentialsProvider {
  return new ClientCredentialsProvider({
    uaaUrl: endpoint.url,
    clientId: CLIENT,
    clientSecret: SECRET,
    renewal: refreshThenLogin(),
  });
}

const IDP_ENTITY = 'urn:test:idp';
const SP_ENTITY = 'urn:test:sp';
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';
const COOKIES = 'SAP_SESSIONID_ABC_100=stand-in; MYSAPSSO2=stand-in';
const FORM_FIELD = 'name="SAMLResponse" value="';

let idp: MockSamlIdp;

beforeAll(async () => {
  idp = await startMockSamlIdp({
    issuer: IDP_ENTITY,
    audience: SP_ENTITY,
    acsUrls: [ACS],
    signWhat: 'response',
  });
});

afterAll(async () => {
  await idp.close();
});

function samlMeans(): DestinationMeans {
  return {
    authType: 'saml',
    grantType: 'saml2_pure',
    serviceUrl: SERVICE_URL,
    sapClient: '100',
    samlIdpSsoUrl: `${idp.url}/sso`,
    samlIdpEntityId: IDP_ENTITY,
    samlIdpCertificates: [idp.certificatePem],
    samlSpEntityId: SP_ENTITY,
    samlAcsUrl: ACS,
  };
}

/**
 * A `saml2_pure` broker whose strategy plays the browser: it fetches the
 * AuthnRequest URL from the mock IdP and takes the SAMLResponse out of the
 * form it answers with.
 */
function samlBroker() {
  let logins = 0;
  const strategy: IAuthorizationStrategy<string> = {
    authorize: async (request: AuthorizationRequest) => {
      logins += 1;
      const html = await (
        await fetch(await request.buildAuthorizationUrl(ACS))
      ).text();
      const start = html.indexOf(FORM_FIELD);
      const end = html.indexOf('"', start + FORM_FIELD.length);
      if (start < 0 || end < 0) throw new Error('no SAMLResponse');
      return {
        payload: html.slice(start + FORM_FIELD.length, end),
        redirectUri: ACS,
      };
    },
    dispose: async () => {},
  };
  const replay = createInMemoryReplayStore();
  const built = broker({
    authorization: () => strategy,
    samlCookies: () => async () => COOKIES,
    assertionReplayStore: () => replay,
  });
  return { ...built, logins: () => logins };
}
