/**
 * The own keys of every object the token API hands a consumer — the factory's
 * `authConfig`, its `connConfig` seed, its fourth argument, the strategy's
 * context — and of the secret it writes, pinned exactly: a key present with
 * the value `undefined` is a key (`'refreshToken' in authConfig`,
 * `Object.keys`, a spread over a stored value), so `toEqual`, which treats an
 * `undefined` field as absent, cannot pin it. Each list below is the shape
 * 4.1.0 handed out; under `exactOptionalPropertyTypes` it is kept by
 * `asContract` (`src/contractShape.ts`), never by dropping an `undefined`.
 */

import type {
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
import {
  AuthBroker,
  type ClientAuthenticationContext,
  type TokenProviderFactory,
} from '../../index';
import { STATED } from '../helpers/stated';

const D = 'KEYS';

const MEANS: IConnectionConfig = {
  authType: 'jwt',
  grantType: 'authorization_code',
  serviceUrl: 'https://abap.example.com',
  sapClient: '100',
};

const CLIENT: IAuthorizationConfig = {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'the-client',
  uaaClientSecret: 'the-secret',
};

/** A session store over one slot, recording every write as given. */
function sessions() {
  const writes: IConfig[] = [];
  const store: ISessionStore = {
    loadSession: async () => null,
    saveSession: async (_d, config) => {
      writes.push(config as IConfig);
    },
    getAuthorizationConfig: async () => null,
    getConnectionConfig: async () => null,
    setAuthorizationConfig: async () => {},
    setConnectionConfig: async () => {},
    deleteSession: async () => {},
  };
  return { store, writes };
}

function keyStore(): IServiceKeyStore {
  return {
    getServiceKey: async () => null,
    getAuthorizationConfig: async () => ({ ...CLIENT }),
    getConnectionConfig: async () => ({ ...MEANS }),
  };
}

/** A consumer provider answering one token, without a refresh token. */
function provider(): IRefreshableTokenProvider {
  const result: ITokenResult = {
    authorizationToken: 'the-token',
    authType: 'authorization_code',
    expiresIn: 3600,
  };
  return {
    getTokens: async () => result,
    refreshTokens: async () => result,
  };
}

/** Own keys, sorted, with whether each holds `undefined`. */
function shape(value: object | null | undefined): string[] {
  if (!value) return [];
  return Object.keys(value)
    .sort()
    .map((key) =>
      (value as Record<string, unknown>)[key] === undefined
        ? `${key}=undefined`
        : key,
    );
}

async function run(withStrategy: boolean) {
  const { store, writes } = sessions();
  const contexts: ClientAuthenticationContext[] = [];
  const factory = jest.fn<
    ReturnType<TokenProviderFactory>,
    Parameters<TokenProviderFactory>
  >(() => provider());
  const broker = new AuthBroker({
    ...STATED,
    sessionStore: store,
    serviceKeyStore: keyStore(),
    provider: factory,
    ...(withStrategy
      ? {
          clientAuthentication: async (
            context: ClientAuthenticationContext,
          ) => {
            contexts.push(context);
            return { authenticate: async () => ({}) };
          },
        }
      : {}),
  });
  await broker.getToken(D);
  await broker.flush();
  expect(factory).toHaveBeenCalledTimes(1);
  const [, authConfig, connConfig, client] = factory.mock.calls[0]!;
  return { authConfig, connConfig, client, contexts, writes, factory };
}

describe('own keys of what the token API hands out and writes', () => {
  it('without a strategy: authConfig carries refreshToken as a key, undefined', async () => {
    const { authConfig, connConfig, factory, writes } = await run(false);
    expect(factory.mock.calls[0]).toHaveLength(3);
    expect(shape(authConfig)).toEqual([
      'refreshToken=undefined',
      'uaaClientId',
      'uaaClientSecret',
      'uaaUrl',
    ]);
    expect(shape(connConfig)).toEqual(['serviceUrl']);
    expect(writes).toHaveLength(1);
    expect(shape(writes[0])).toEqual([
      'authorizationToken',
      'expiresAt',
      'issuedBy',
      'issuedFor',
      // Always stated: the result's refresh token, or '' (§5.5).
      'refreshToken',
    ]);
  });

  it('with a strategy: authConfig, the seed, the fourth argument and the context', async () => {
    const { authConfig, connConfig, client, contexts, writes } =
      await run(true);
    expect(shape(authConfig)).toEqual([
      'refreshToken=undefined',
      'uaaClientId',
      'uaaClientSecret',
      'uaaUrl',
    ]);
    expect(shape(connConfig)).toEqual(['serviceUrl']);
    expect(shape(client)).toEqual([
      'clientAuthentication',
      'clientId',
      'uaaUrl',
    ]);
    expect(contexts).toHaveLength(1);
    expect(shape(contexts[0])).toEqual([
      'client',
      'destination',
      'grant',
      'readCertificate',
      // The build's attempt signal (D11).
      'signal',
    ]);
    expect(shape(contexts[0]!.client)).toEqual([
      'uaaClientId',
      'uaaClientSecret',
      'uaaUrl',
    ]);
    expect(writes).toHaveLength(1);
    expect(shape(writes[0])).toEqual([
      'authorizationToken',
      'expiresAt',
      'issuedBy',
      'issuedFor',
      // Always stated: the result's refresh token, or '' (§5.5).
      'refreshToken',
    ]);
  });
});
