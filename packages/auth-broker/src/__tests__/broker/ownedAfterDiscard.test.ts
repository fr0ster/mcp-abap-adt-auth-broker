/**
 * A discard makes the refresh token a build owns none (§5.2), whatever the
 * persistence reports afterwards.
 *
 * auth-providers' `refreshStatePersistence` stays `cleared` after a discard
 * and reports `null` until a new refresh token arrives, so through it the rule
 * cannot be seen. Here it is wrapped: the first `null` is forwarded, and every
 * later `null` is rewritten as `undefined` — a persistence that, after a
 * discard, reports "none new" for a token-only result. The broker must still
 * write `''` then, never the refresh token the provider discarded. In its own
 * file, so the mock touches no other suite.
 *
 * Over auth-stores 4.0.0's `EnvDestinationStore` and `AbapSessionStore` files,
 * a real `AuthorizationCodeProvider` and the local token endpoint; nothing
 * opens a browser.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PersistedTokens } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IRefreshableTokenProvider,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConfig,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import { AuthBroker } from '../../index';
import { uaaRecord } from '../helpers/bindingRecord';
import { STATED } from '../helpers/stated';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

jest.mock('@mcp-abap-adt/auth-providers', () => {
  const actual = jest.requireActual('@mcp-abap-adt/auth-providers');
  return {
    ...actual,
    refreshStatePersistence: (
      write: (tokens: PersistedTokens) => Promise<void>,
      options: unknown,
    ) => {
      let discarded = false;
      return actual.refreshStatePersistence((tokens: PersistedTokens) => {
        if (tokens.refreshToken !== null) return write(tokens);
        if (!discarded) {
          discarded = true;
          return write(tokens);
        }
        return write({ ...tokens, refreshToken: undefined });
      }, options);
    },
  };
});

jest.setTimeout(30_000);

const D = 'TRIAL';
const CLIENT = 'sb-broker!t42';
const R = 'R-discarded-must-not-come-back';
const REDIRECT = 'http://localhost/callback';

let endpoint: TokenEndpoint;
let dir: string;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-owned-'));
});

afterEach(async () => {
  await endpoint.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a discard makes the owned refresh token none: a later token-only result reported as "none new" writes ""', async () => {
  const keys = path.join(dir, 'keys');
  const sessions = path.join(dir, 'sessions');
  await new EnvDestinationStore(keys).setDestination(D, {
    authType: 'jwt',
    grantType: 'authorization_code',
    serviceUrl: 'https://abap.example.com/sap/bc/adt',
    sapClient: '100',
    uaaUrl: endpoint.url,
    uaaClientId: CLIENT,
    uaaClientSecret: 'S3CRET-client',
  });
  await new AbapSessionStore(sessions).saveSession(D, {
    authorizationToken: jwtExpiringIn(-60, { jti: 'expired' }),
    expiresAt: Date.now() - 60_000,
    refreshToken: R,
    issuedFor: 'https://abap.example.com:443/sap/bc/adt?sap-client=100',
    issuedBy: uaaRecord('authorization_code', endpoint.url, CLIENT),
  });
  // One strategy for the build: the first login is refused, the next completes.
  let attempts = 0;
  const strategy: IAuthorizationStrategy<string> = {
    authorize: async (request: AuthorizationRequest) => {
      attempts += 1;
      if (attempts === 1) throw new Error('the user closed the window');
      await request.buildAuthorizationUrl(REDIRECT);
      return { payload: 'the-code', redirectUri: REDIRECT };
    },
    dispose: async () => {},
  };
  const inner = new AbapSessionStore(sessions);
  const writes: IConfig[] = [];
  const store: ISessionStore = {
    loadSession: (d) => inner.loadSession(d),
    saveSession: async (d, config) => {
      writes.push({ ...(config as IConfig) });
      await inner.saveSession(d, config);
    },
    getAuthorizationConfig: (d) => inner.getAuthorizationConfig(d),
    getConnectionConfig: (d) => inner.getConnectionConfig(d),
    setAuthorizationConfig: (d, c) => inner.setAuthorizationConfig(d, c),
    setConnectionConfig: (d, c) => inner.setConnectionConfig(d, c),
  };
  const broker = new AuthBroker({
    ...STATED,
    sessionStore: store,
    serviceKeyStore: new EnvDestinationStore(keys),
    authorization: () => strategy,
  });
  const provider = (await broker.getProvider(
    D,
  )) as unknown as IRefreshableTokenProvider;

  // The refresh is refused (R discarded), and the fallback login too.
  endpoint.answerNext({ status: 400, body: { error: 'invalid_grant' } });
  const failed = expect(provider.getTokens()).rejects.toBeDefined();
  await failed;
  expect(writes.map((w) => w.refreshToken)).toEqual(['']);

  // A token-only login: the wrapped persistence reports it as "none new".
  const token = jwtExpiringIn(3600, { jti: 'login-only' });
  endpoint.answerNext({
    status: 200,
    body: { access_token: token, token_type: 'bearer', expires_in: 3600 },
  });
  await expect(provider.getTokens()).resolves.toMatchObject({
    authorizationToken: token,
  });

  expect(writes.map((w) => w.refreshToken)).toEqual(['', '']);
  const stored = await new AbapSessionStore(sessions).loadSession(D);
  expect(stored?.authorizationToken).toBe(token);
  expect(stored?.refreshToken).toBeUndefined();
});
