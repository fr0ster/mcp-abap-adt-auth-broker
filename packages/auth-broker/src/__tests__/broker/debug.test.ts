/**
 * §8 — what the broker logs, and `authDebug`.
 *
 * - `authDebug: true` — `true` itself — reaches every token provider the
 *   broker builds; absent, `false`, `'true'` and `1` are off. It is never read
 *   from the environment. A consumer's instance or factory result keeps its
 *   own setting.
 * - A token endpoint's `error_description` reaches no line, error or
 *   diagnostic, with `authDebug` off and on; with it on, the provider's debug
 *   line names the request's secrets in their prepared form only.
 * - A consumer logger that throws, or answers a rejecting promise, changes no
 *   outcome: every broker log call goes through one quiet wrapper.
 * - Every failed session write is logged once, by the broker, in fixed words.
 * - The discard line says what happened, and a row that is never seeded by
 *   design logs no warn for it.
 *
 * Every provider constructor of auth-providers is wrapped to record the
 * config it was given; the providers themselves are the real ones.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  classify,
  isAuthProviderFailure,
  logFields,
  readFailure,
} from '@mcp-abap-adt/auth-errors';
import {
  ClientCredentialsProvider,
  createInMemoryReplayStore,
  type OidcCallbackResult,
} from '@mcp-abap-adt/auth-providers';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
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
  type TokenGrant,
} from '../../index';
import { uaaRecord } from '../helpers/bindingRecord';
import { fakeKeyStore, fakeSessionStore } from '../helpers/fakeStores';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

/** The config each provider constructor was given, in construction order. */
const constructed: { name: string; config: Record<string, unknown> }[] = [];

const PROVIDER_CLASSES = [
  'ClientCredentialsProvider',
  'AuthorizationCodeProvider',
  'UaaPasscodeProvider',
  'OidcBrowserProvider',
  'OidcDeviceFlowProvider',
  'OidcPasswordProvider',
  'OidcTokenExchangeProvider',
  'Saml2PureProvider',
  'Saml2BearerProvider',
] as const;

jest.mock('@mcp-abap-adt/auth-providers', () => {
  const actual = jest.requireActual('@mcp-abap-adt/auth-providers');
  const wrapped: Record<string, unknown> = {};
  for (const name of [
    'ClientCredentialsProvider',
    'AuthorizationCodeProvider',
    'UaaPasscodeProvider',
    'OidcBrowserProvider',
    'OidcDeviceFlowProvider',
    'OidcPasswordProvider',
    'OidcTokenExchangeProvider',
    'Saml2PureProvider',
    'Saml2BearerProvider',
  ]) {
    const Actual = actual[name];
    wrapped[name] = class extends Actual {
      constructor(config: Record<string, unknown>, ...rest: unknown[]) {
        constructed.push({ name, config: { ...config } });
        super(config, ...rest);
      }
    };
  }
  return { ...actual, ...wrapped };
});

jest.setTimeout(30_000);

const D = 'TRIAL';
const SERVICE_URL = 'https://abap.example.com/sap/bc/adt';
const FOR = 'https://abap.example.com:443/sap/bc/adt?sap-client=100';
const CLIENT_ID = 'sb-broker!t42';
/** Long enough for the prepared form: its first and last 4 characters. */
const CLIENT_SECRET = 'S3CRET-client-must-never-be-logged-whole';
const PREPARED = `S3CR…hole <redacted, ${[...CLIENT_SECRET].length} chars>`;
const DESCRIPTION = 'SERVER-TEXT-MARKER-in-error-description';
const ERROR_URI = 'https://idp.example.com/SERVER-URI-MARKER';
const LOGGER_MARKER = 'LOGGER-OWN-ERROR-MARKER';
const STORE_MARKER = 'STORE-OWN-ERROR-MARKER';
const CERT = readFileSync(
  join(__dirname, '..', 'fixtures', 'certificates', 'client.crt'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Line {
  level: string;
  message: string;
  meta: unknown;
}

/** A logger that records every line. */
function recordingLogger(): { logger: ILogger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      lines.push({ level, message, meta });
    };
  return {
    lines,
    logger: {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    },
  };
}

/** Everything a value renders as: inspect to any depth and JSON. */
function rendered(value: unknown): string {
  let json = '';
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    json = '';
  }
  return `${inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true })}\n${json}`;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (thrown: unknown) => thrown,
  );
}

/** Lets every queued job and timer of this turn run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A key store stating a client_credentials row against the endpoint. */
function clientCredentialsKeys(endpoint: TokenEndpoint): IServiceKeyStore {
  return fakeKeyStore(
    {
      authType: 'jwt',
      grantType: 'client_credentials',
      serviceUrl: SERVICE_URL,
      sapClient: '100',
    },
    {
      uaaUrl: endpoint.url,
      uaaClientId: CLIENT_ID,
      uaaClientSecret: CLIENT_SECRET,
    },
  );
}

// ---------------------------------------------------------------------------
// authDebug reaches every built provider, for `true` only
// ---------------------------------------------------------------------------

const CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'client',
  uaaClientSecret: 'secret',
};
const OIDC = {
  oidcTokenEndpoint: 'https://idp.example.com/token',
  oidcAuthorizationEndpoint: 'https://idp.example.com/authorize',
  oidcDeviceAuthorizationEndpoint: 'https://idp.example.com/device',
};
const SAML = {
  samlIdpSsoUrl: 'https://idp.example.com/sso',
  samlSpEntityId: 'sp',
  samlIdpEntityId: 'idp',
  samlAcsUrl: 'https://abap.example.com/acs',
  samlIdpCertificates: [CERT],
};

/** Each token row, with the means it needs and the class it builds. */
const ROWS: Array<[TokenGrant, IConnectionConfig, string]> = [
  ['authorization_code', { authType: 'jwt' }, 'AuthorizationCodeProvider'],
  ['client_credentials', { authType: 'jwt' }, 'ClientCredentialsProvider'],
  ['passcode', { authType: 'jwt' }, 'UaaPasscodeProvider'],
  [
    'oidc_authorization_code',
    { authType: 'jwt', ...OIDC },
    'OidcBrowserProvider',
  ],
  ['device_code', { authType: 'jwt', ...OIDC }, 'OidcDeviceFlowProvider'],
  [
    'password',
    { authType: 'jwt', ...OIDC, username: 'u', password: 'p' },
    'OidcPasswordProvider',
  ],
  [
    'token_exchange',
    {
      authType: 'jwt',
      ...OIDC,
      oidcSubjectToken: 'subject',
      oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    },
    'OidcTokenExchangeProvider',
  ],
  ['saml2_pure', { authType: 'saml', ...SAML }, 'Saml2PureProvider'],
  ['saml2_bearer', { authType: 'saml', ...SAML }, 'Saml2BearerProvider'],
];

/** An authorization strategy that must never be asked. */
function unusedStrategy<T>(): IAuthorizationStrategy<T> {
  return {
    authorize: async (_request: AuthorizationRequest) => {
      throw new Error('the authorization strategy was asked');
    },
  };
}

/** Every collaborator a row may need. */
function collaborators(): Partial<AuthBrokerConfig> {
  return {
    authorization: () => unusedStrategy<string>(),
    oidcAuthorization: () => unusedStrategy<OidcCallbackResult>(),
    deviceCodePresenter: () => ({ present: async () => {} }),
    samlCookies: () => async () => 'cookie',
    assertionReplayStore: () => createInMemoryReplayStore(),
  };
}

/** Builds the row's provider and answers the config its constructor got. */
async function builtConfig(
  grant: TokenGrant,
  means: IConnectionConfig,
  className: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  constructed.length = 0;
  const broker = new AuthBroker({
    ...STATED,
    sessionStore: fakeSessionStore(),
    serviceKeyStore: fakeKeyStore(
      { serviceUrl: SERVICE_URL, ...means, grantType: grant },
      CLIENT,
    ),
    ...collaborators(),
    ...(options as Partial<AuthBrokerConfig>),
  });
  await broker.getProvider(D);
  expect(constructed.map((c) => c.name)).toEqual([className]);
  return (constructed[0] as (typeof constructed)[number]).config;
}

const OFF: Array<[string, Record<string, unknown>]> = [
  ['absent', {}],
  ['false', { authDebug: false }],
  ["'true'", { authDebug: 'true' }],
  ['1', { authDebug: 1 }],
];

describe('authDebug reaches every provider the broker builds, on only for true', () => {
  it.each(ROWS)('%s: authDebug true', async (grant, means, className) => {
    const config = await builtConfig(grant, means, className, {
      authDebug: true,
    });
    expect(config.authDebug).toBe(true);
  });

  for (const [label, options] of OFF) {
    it.each(ROWS)(
      `%s: authDebug ${label} is off`,
      async (grant, means, className) => {
        const config = await builtConfig(grant, means, className, options);
        expect('authDebug' in config).toBe(true);
        expect(config.authDebug).toBe(false);
      },
    );
  }
});

describe('the environment changes nothing', () => {
  const NAMES = [
    'DEBUG_AUTH_PROVIDERS',
    'DEBUG_BROWSER_AUTH',
    'DEBUG',
    'DEBUG_BROKER',
    'DEBUG_AUTH_BROKER',
    'DEBUG_AUTH',
    'DEBUG_AUTH_DEBUG',
    'DEBUG_ADT',
    'AUTH_DEBUG',
    'AUTH_LOG_LEVEL',
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of NAMES) {
      saved.set(name, process.env[name]);
      process.env[name] = name === 'AUTH_LOG_LEVEL' ? 'debug' : 'true';
    }
  });

  afterEach(() => {
    for (const name of NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(ROWS)(
    '%s: every DEBUG* variable set, no option — authDebug false',
    async (grant, means, className) => {
      const config = await builtConfig(grant, means, className, {});
      expect(config.authDebug).toBe(false);
    },
  );

  it('a refused token request with every DEBUG* variable set and no option: no sent, no secret, no server text', async () => {
    const endpoint = await startTokenEndpoint();
    try {
      const { logger, lines } = recordingLogger();
      const broker = new AuthBroker(
        {
          ...STATED,
          sessionStore: fakeSessionStore(),
          serviceKeyStore: clientCredentialsKeys(endpoint),
        },
        logger,
      );
      endpoint.answerNext({
        status: 400,
        body: {
          error: 'invalid_client',
          error_description: DESCRIPTION,
          error_uri: ERROR_URI,
        },
      });
      const thrown = await rejection(broker.getToken(D));
      expect(isAuthProviderFailure(thrown)).toBe(true);
      const all = rendered(lines);
      expect(all).not.toContain('sent');
      expect(all).not.toContain('S3CR…');
      expect(all).not.toContain(CLIENT_SECRET);
      expect(all).not.toContain(DESCRIPTION);
    } finally {
      await endpoint.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A consumer's provider keeps its own setting
// ---------------------------------------------------------------------------

describe("a consumer's provider keeps its own authDebug", () => {
  /** A session store on the consumer path: the connection in the session. */
  function consumerSessions(): ISessionStore {
    return fakeSessionStore(
      asConfig({ serviceUrl: SERVICE_URL, sapClient: '100' }),
    );
  }

  it('an instance built without authDebug, a broker with authDebug true: the instance never names sent', async () => {
    const endpoint = await startTokenEndpoint();
    try {
      const own = recordingLogger();
      constructed.length = 0;
      const instance = new ClientCredentialsProvider({
        uaaUrl: endpoint.url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        logger: own.logger,
        renewal: STATED.renewal(),
      });
      const broker = new AuthBroker({
        ...STATED,
        authDebug: true,
        sessionStore: consumerSessions(),
        provider: instance,
      });
      endpoint.answerNext({
        status: 400,
        body: { error: 'invalid_client', error_description: DESCRIPTION },
      });
      await rejection(broker.getToken(D));
      // Only the consumer's own construction: the broker built nothing.
      expect(constructed.map((c) => c.name)).toEqual([
        'ClientCredentialsProvider',
      ]);
      expect(constructed[0]?.config.authDebug).toBeUndefined();
      expect(rendered(own.lines)).not.toContain('sent');
      expect(rendered(own.lines)).not.toContain(DESCRIPTION);
    } finally {
      await endpoint.close();
    }
  });

  it.each([
    [true, undefined],
    [undefined, true],
    [true, false],
  ])(
    'a factory: the broker with authDebug %p, the factory building with %p — the result keeps the factory’s, and the factory is handed no authDebug',
    async (brokerDebug, factoryDebug) => {
      const handed: unknown[] = [];
      constructed.length = 0;
      const broker = new AuthBroker({
        ...STATED,
        ...(brokerDebug === undefined ? {} : { authDebug: brokerDebug }),
        sessionStore: consumerSessions(),
        provider: (...args: unknown[]) => {
          handed.push(args);
          return new ClientCredentialsProvider({
            uaaUrl: 'https://uaa.example.com',
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            renewal: { next: () => ({ next: 'stop' as const }) },
            ...(factoryDebug === undefined ? {} : { authDebug: factoryDebug }),
          }) as IRefreshableTokenProvider;
        },
      });
      await rejection(broker.getToken(D));
      expect(handed).toHaveLength(1);
      expect(rendered(handed)).not.toContain('authDebug');
      expect(constructed).toHaveLength(1);
      expect(constructed[0]?.config.authDebug).toBe(factoryDebug);
    },
  );
});

// ---------------------------------------------------------------------------
// Server text reaches nothing; sent holds prepared secrets only
// ---------------------------------------------------------------------------

describe('a 400 with an error_description', () => {
  it.each([
    ['off', undefined],
    ['on', true],
  ])(
    'authDebug %s: the description is in no line, error or diagnostic; the secret is never whole',
    async (label, authDebug) => {
      const endpoint = await startTokenEndpoint();
      try {
        const { logger, lines } = recordingLogger();
        const broker = new AuthBroker(
          {
            ...STATED,
            ...(authDebug === undefined ? {} : { authDebug }),
            sessionStore: fakeSessionStore(),
            serviceKeyStore: clientCredentialsKeys(endpoint),
          },
          logger,
        );
        endpoint.answerNext({
          status: 400,
          body: {
            error: 'invalid_client',
            error_description: DESCRIPTION,
            error_uri: ERROR_URI,
          },
        });
        const thrown = await rejection(broker.getToken(D));
        expect(isAuthProviderFailure(thrown)).toBe(true);
        const diagnostic = readFailure(thrown, 'token-source');
        for (const text of [
          rendered(lines),
          rendered(thrown),
          rendered(diagnostic),
        ]) {
          expect(text).not.toContain(DESCRIPTION);
          expect(text).not.toContain('SERVER-URI-MARKER');
          expect(text).not.toContain(CLIENT_SECRET);
        }
        const withSent = lines.filter(
          (line) =>
            line.meta !== null &&
            typeof line.meta === 'object' &&
            'sent' in line.meta,
        );
        if (label === 'off') {
          expect(withSent).toEqual([]);
          return;
        }
        expect(withSent).toHaveLength(1);
        const line = withSent[0] as Line;
        expect(line.level).toBe('debug');
        const sent = (line.meta as { sent: Record<string, string> }).sent;
        expect(Object.keys(sent).length).toBeGreaterThan(0);
        // Every secret in its prepared form: the edges and the marker.
        for (const value of Object.values(sent)) {
          expect(value).toMatch(/<redacted, \d+ chars>$/);
        }
        expect(Object.values(sent)).toContain(PREPARED);
      } finally {
        await endpoint.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// A consumer logger that throws, or answers a rejecting promise
// ---------------------------------------------------------------------------

/** Every method throws. */
function throwingLogger(): ILogger {
  const fail = (): void => {
    throw new Error(LOGGER_MARKER);
  };
  return { debug: fail, info: fail, warn: fail, error: fail };
}

/** Every method answers a rejecting promise: an async logger. */
function rejectingLogger(): ILogger {
  const fail = (): Promise<never> => Promise.reject(new Error(LOGGER_MARKER));
  return { debug: fail, info: fail, warn: fail, error: fail } as ILogger;
}

function asConfig(value: Record<string, unknown>): IConfig {
  return value as IConfig;
}

/** What the store throws: its message is foreign text. */
function storeError(): Error {
  return Object.assign(new Error(`cannot write ${STORE_MARKER}`), {
    code: 'EACCES',
  });
}

/**
 * A session store that merges as the contract says, fails while `failing`
 * is set, and states the connection for the consumer path.
 */
function failableStore() {
  let held: Record<string, unknown> = {
    serviceUrl: SERVICE_URL,
    sapClient: '100',
  };
  const control = { failing: false, attempts: 0 };
  let lastToken = '';
  const store: ISessionStore = {
    loadSession: async () => asConfig({ ...held }),
    saveSession: async (_d, config) => {
      control.attempts += 1;
      const offered = (config as { authorizationToken?: unknown })
        .authorizationToken;
      if (typeof offered === 'string') lastToken = offered;
      if (control.failing) throw storeError();
      const next = { ...held };
      for (const [field, value] of Object.entries(config as object)) {
        if (value === undefined) continue;
        if (value === '') delete next[field];
        else next[field] = value;
      }
      held = next;
    },
    getAuthorizationConfig: async () => null,
    getConnectionConfig: async () => {
      const { refreshToken: _r, ...connection } = held;
      return connection as IConnectionConfig;
    },
    setAuthorizationConfig: async () => {},
    setConnectionConfig: async () => {},
  };
  return { store, control, held: () => held, lastToken: () => lastToken };
}

/** A consumer's provider answering a fresh token each call. */
function consumerProvider(): IRefreshableTokenProvider {
  let n = 0;
  const answer = async (): Promise<ITokenResult> => {
    n += 1;
    return {
      authorizationToken: jwtExpiringIn(3600, { jti: `consumer-${n}` }),
      authType: 'authorization_code',
      expiresIn: 3600,
    };
  };
  return { getTokens: answer, refreshTokens: answer };
}

describe('a consumer logger that throws or rejects changes no outcome', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  let endpoint: TokenEndpoint;

  beforeEach(async () => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    endpoint = await startTokenEndpoint();
  });

  afterEach(async () => {
    await settle();
    process.off('unhandledRejection', onUnhandled);
    await endpoint.close();
    expect(unhandled).toEqual([]);
  });

  const LOGGERS: Array<[string, () => ILogger]> = [
    ['throws', throwingLogger],
    ['answers a rejecting promise', rejectingLogger],
  ];
  const POLICIES = ['fail', 'continue'] as const;
  const PATHS = ['row', 'consumer'] as const;

  function brokerOn(
    path: (typeof PATHS)[number],
    policy: (typeof POLICIES)[number],
    logger: ILogger,
  ) {
    const sessions = failableStore();
    const broker = new AuthBroker(
      {
        ...STATED,
        onWriteFailure: policy,
        sessionStore: sessions.store,
        ...(path === 'row'
          ? { serviceKeyStore: clientCredentialsKeys(endpoint) }
          : { provider: consumerProvider() }),
      },
      logger,
    );
    return { broker, ...sessions };
  }

  for (const [kind, makeLogger] of LOGGERS) {
    for (const policy of POLICIES) {
      for (const path of PATHS) {
        it(`a logger that ${kind}, '${policy}', the ${path} path: a landed write stays landed`, async () => {
          const { broker, held, control } = brokerOn(
            path,
            policy,
            makeLogger(),
          );
          const token = await broker.getToken(D);
          expect(held().authorizationToken).toBe(token);
          expect(control.attempts).toBe(1);
          // Nothing pending: flush writes nothing and resolves.
          await expect(broker.flush()).resolves.toBeUndefined();
          expect(control.attempts).toBe(1);
          // The next call is served — under 'fail' too, nothing is pending.
          const next = await broker.getToken(D);
          if (path === 'row') expect(next).toBe(token);
          expect(held().authorizationToken).toBe(next);
        });

        it(`a logger that ${kind}, '${policy}', the ${path} path: a failed write is the store's failure, never the logger's, and stays pending`, async () => {
          const { broker, held, control } = brokerOn(
            path,
            policy,
            makeLogger(),
          );
          control.failing = true;
          const call = broker.getToken(D);
          if (policy === 'fail') {
            const thrown = await rejection(call);
            expect(isAuthProviderFailure(thrown)).toBe(true);
            const error = readFailure(thrown, 'unfamiliar-error');
            expect(error.kind).toBe('unknown');
            expect(error.facts).toEqual(
              expect.objectContaining({
                operation: 'persisting-tokens',
                code: 'EACCES',
              }),
            );
            expect(rendered(thrown)).not.toContain(LOGGER_MARKER);
          } else {
            await expect(call).resolves.toEqual(expect.any(String));
          }
          expect(held().authorizationToken).toBeUndefined();
          // Pending: flush retries it, and it lands.
          control.failing = false;
          const before = control.attempts;
          await expect(broker.flush()).resolves.toBeUndefined();
          expect(control.attempts).toBe(before + 1);
          expect(held().authorizationToken).toEqual(expect.any(String));
        });

        it(`a logger that ${kind}, '${policy}', the ${path} path: flush and retry still reject only with the store's failure`, async () => {
          const { broker, control } = brokerOn(path, policy, makeLogger());
          control.failing = true;
          await broker.getToken(D).catch(() => undefined);
          const flushed = await rejection(broker.flush());
          expect(flushed).toBeInstanceOf(AggregateError);
          expect(rendered(flushed)).not.toContain(LOGGER_MARKER);
          // The destination's next call retries the pending write first.
          const next = broker.getToken(D);
          if (policy === 'fail') {
            const thrown = await rejection(next);
            expect(readFailure(thrown, 'unfamiliar-error').facts).toEqual(
              expect.objectContaining({ operation: 'persisting-tokens' }),
            );
            expect(rendered(thrown)).not.toContain(LOGGER_MARKER);
          } else {
            await expect(next).resolves.toEqual(expect.any(String));
          }
        });
      }
    }
  }

  it.each(LOGGERS)(
    'a logger that %s: the constructor, getProvider and a discard log line change nothing',
    async (_kind, makeLogger) => {
      const broker = new AuthBroker(
        {
          ...STATED,
          sessionStore: fakeSessionStore(
            asConfig({
              authorizationToken: 'stored-elsewhere',
              refreshToken: 'stored-refresh',
              issuedFor: FOR,
              issuedBy: 'another-record',
            }),
          ),
          serviceKeyStore: fakeKeyStore(
            {
              authType: 'jwt',
              grantType: 'authorization_code',
              serviceUrl: SERVICE_URL,
              sapClient: '100',
            },
            {
              uaaUrl: endpoint.url,
              uaaClientId: CLIENT_ID,
              uaaClientSecret: CLIENT_SECRET,
            },
          ),
          authorization: () => unusedStrategy<string>(),
        },
        makeLogger(),
      );
      await expect(broker.getProvider(D)).resolves.toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Every failed write is logged once, by the broker, in fixed words
// ---------------------------------------------------------------------------

describe('a failed session write is logged once', () => {
  const PENDING_LINE = `[AuthBroker] Session write for ${D} failed; it stays pending until the destination's next write or flush()`;

  it.each([
    ['row', 'continue'],
    ['consumer', 'continue'],
    ['row', 'fail'],
    ['consumer', 'fail'],
  ] as const)(
    "the %s path, '%s': one line for the one failed write, the classification's fields only",
    async (path, policy) => {
      const endpoint = await startTokenEndpoint();
      try {
        const { logger, lines } = recordingLogger();
        const sessions = failableStore();
        sessions.control.failing = true;
        const broker = new AuthBroker(
          {
            ...STATED,
            onWriteFailure: policy,
            sessionStore: sessions.store,
            ...(path === 'row'
              ? { serviceKeyStore: clientCredentialsKeys(endpoint) }
              : { provider: consumerProvider() }),
          },
          logger,
        );
        const call = broker.getToken(D);
        if (policy === 'fail') await rejection(call);
        const token = policy === 'continue' ? await call : sessions.lastToken();
        await settle();
        expect(sessions.control.attempts).toBe(1);
        // The one failed write, logged once — by the broker: no other line of
        // any level (the provider's persistence included) repeats it.
        const warns = lines.filter((l) => l.level === 'warn');
        expect(warns.map((l) => l.message)).toEqual([PENDING_LINE]);
        expect(
          lines.filter(
            (l) =>
              l.level === 'warn' ||
              l.level === 'error' ||
              rendered(l).includes('persisting') ||
              rendered(l).includes('EACCES') ||
              rendered(l).toLowerCase().includes('write'),
          ),
        ).toEqual(warns);
        expect(warns[0]?.meta).toEqual(
          logFields(classify(storeError(), 'persisting-tokens')),
        );
        const all = rendered(lines);
        expect(all).not.toContain(STORE_MARKER);
        expect(all).not.toContain(token);
        expect(all).not.toContain(CLIENT_SECRET);
        expect(all).not.toContain(endpoint.url);
      } finally {
        await endpoint.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The discard line
// ---------------------------------------------------------------------------

describe('a stored secret the destination does not take', () => {
  const DISCARDED = `[AuthBroker] ${D}: the stored session secret was not issued under the destination's current means; not used, the provider obtains a new one`;
  const NEVER_SEEDED = `[AuthBroker] ${D}: the destination's means do not state everything a session secret is bound to; a stored one is never used`;

  it('a fully stated row, a secret recorded under another client: one warn line saying what happened', async () => {
    const endpoint = await startTokenEndpoint();
    try {
      const { logger, lines } = recordingLogger();
      const broker = new AuthBroker(
        {
          ...STATED,
          sessionStore: fakeSessionStore(
            asConfig({
              authorizationToken: 'stored-elsewhere',
              refreshToken: 'stored-refresh',
              issuedFor: FOR,
              issuedBy: uaaRecord(
                'authorization_code',
                endpoint.url,
                'another-client',
              ),
            }),
          ),
          serviceKeyStore: fakeKeyStore(
            {
              authType: 'jwt',
              grantType: 'authorization_code',
              serviceUrl: SERVICE_URL,
              sapClient: '100',
            },
            {
              uaaUrl: endpoint.url,
              uaaClientId: CLIENT_ID,
              uaaClientSecret: CLIENT_SECRET,
            },
          ),
          authorization: () => unusedStrategy<string>(),
        },
        logger,
      );
      await broker.getProvider(D);
      expect(
        lines.filter((l) => l.level === 'warn').map((l) => [l.message, l.meta]),
      ).toEqual([[DISCARDED, undefined]]);
      expect(rendered(lines)).not.toContain('bound to another resource');
      expect(rendered(lines)).not.toContain('stored-elsewhere');
      expect(rendered(lines)).not.toContain(NEVER_SEEDED);
    } finally {
      await endpoint.close();
    }
  });

  it('token_exchange, never seeded by design: no warn on every restart — one debug line', async () => {
    for (let restart = 0; restart < 2; restart += 1) {
      const { logger, lines } = recordingLogger();
      const broker = new AuthBroker(
        {
          ...STATED,
          sessionStore: fakeSessionStore(
            asConfig({
              authorizationToken: 'stored-token',
              issuedFor: FOR,
              issuedBy: 'whatever-was-written',
            }),
          ),
          serviceKeyStore: fakeKeyStore(
            {
              ...(ROWS.find(([g]) => g === 'token_exchange')?.[1] ?? {}),
              grantType: 'token_exchange',
              serviceUrl: SERVICE_URL,
              sapClient: '100',
            },
            CLIENT,
          ),
          ...collaborators(),
        },
        logger,
      );
      await broker.getProvider(D);
      expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
      expect(
        lines.filter((l) => l.message === NEVER_SEEDED).map((l) => l.level),
      ).toEqual(['debug']);
      expect(rendered(lines)).not.toContain('stored-token');
    }
  });
});
