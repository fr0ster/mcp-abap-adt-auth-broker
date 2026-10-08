/**
 * The consumer path's identity is the means it reads — never the session
 * store's answers, which the broker's own writes change (§6.3, §5.5).
 *
 * On auth-stores 4.0.0's own session stores — `SafeAbapSessionStore` in
 * memory and `AbapSessionStore` files — whose `getConnectionConfig` answers
 * `null` before the first write and the written secret after it: two token
 * API calls keep one consumer provider (one factory call, no refusal of an
 * instance); a real change of the means then rebuilds the factory's provider
 * and refuses the instance. The instance's identity holds the destination's
 * issuer and client too (`uaaUrl`, client id, `oidcIssuerUrl`), though it is
 * handed none of them.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AbapSessionStore,
  SafeAbapSessionStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  IRefreshableTokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AuthBroker, type TokenProviderFactory } from '../../index';
import { STATED } from '../helpers/stated';

const D = 'TRIAL';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-consumer-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface KeyState {
  means: Record<string, unknown>;
  client: IAuthorizationConfig;
}

function keyStore(state: KeyState): IServiceKeyStore {
  return {
    getServiceKey: async () => null,
    getConnectionConfig: async () => ({ ...state.means }) as IConnectionConfig,
    getAuthorizationConfig: async () => ({ ...state.client }),
  };
}

function keyState(): KeyState {
  return {
    means: {
      authType: 'jwt',
      grantType: 'authorization_code',
      serviceUrl: 'https://abap.example.com/sap/bc/adt',
      sapClient: '100',
    },
    client: {
      uaaUrl: 'https://uaa.example.com',
      uaaClientId: 'sb-broker!t42',
      uaaClientSecret: 'S3CRET',
    },
  };
}

/** A consumer's provider: hands out `<label>-<n>`, with a refresh token. */
function consumerProvider(label: string): IRefreshableTokenProvider {
  let n = 0;
  const answer = async (): Promise<ITokenResult> => {
    n += 1;
    return {
      authorizationToken: `${label}-${n}`,
      refreshToken: `${label}-refresh-${n}`,
      authType: 'authorization_code',
      expiresIn: 3600,
    };
  };
  return { getTokens: answer, refreshTokens: answer };
}

const stores: [string, () => ISessionStore][] = [
  ['SafeAbapSessionStore', () => new SafeAbapSessionStore()],
  ['AbapSessionStore files', () => new AbapSessionStore(dir)],
];

describe.each(stores)('on auth-stores’ %s', (_label, makeStore) => {
  it('a factory: two token API calls → one provider, one factory call; a means change → called again', async () => {
    const state = keyState();
    const sessionStore = makeStore();
    let builds = 0;
    const factory = jest.fn<
      ReturnType<TokenProviderFactory>,
      Parameters<TokenProviderFactory>
    >(() => {
      builds += 1;
      return consumerProvider(`factory${builds}`);
    });
    const broker = new AuthBroker({
      ...STATED,
      sessionStore,
      serviceKeyStore: keyStore(state),
      provider: factory,
    });

    await expect(broker.getToken(D)).resolves.toBe('factory1-1');
    // The broker's own write changed what the session store answers.
    expect(await sessionStore.getConnectionConfig(D)).not.toBeNull();
    await expect(broker.getToken(D)).resolves.toBe('factory1-2');
    await expect(broker.refreshToken(D)).resolves.toBe('factory1-3');
    expect(factory).toHaveBeenCalledTimes(1);

    state.means.sapClient = '200';
    await expect(broker.getToken(D)).resolves.toBe('factory2-1');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('an instance: two token API calls → served, never refused; a means change → refused naming provider', async () => {
    const state = keyState();
    const instance = consumerProvider('instance');
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: makeStore(),
      serviceKeyStore: keyStore(state),
      provider: instance,
    });

    await expect(broker.getToken(D)).resolves.toBe('instance-1');
    await expect(broker.getToken(D)).resolves.toBe('instance-2');
    await expect(broker.refreshToken(D)).resolves.toBe('instance-3');

    state.means.serviceUrl = 'https://other.example.com/sap/bc/adt';
    await expect(broker.getToken(D)).rejects.toMatchObject({
      name: 'DestinationConfigError',
      missingFields: ['provider'],
    });
  });
});

describe('the instance’s identity holds the issuer and the client, though it is handed neither', () => {
  const changes: [string, (state: KeyState) => void][] = [
    [
      'uaaUrl',
      (state) => {
        state.client = { ...state.client, uaaUrl: 'https://uaa.other.com' };
      },
    ],
    [
      'client id',
      (state) => {
        state.client = { ...state.client, uaaClientId: 'sb-other!t7' };
      },
    ],
    [
      'oidcIssuerUrl',
      (state) => {
        state.means.oidcIssuerUrl = 'https://idp.other.com/realms/r';
      },
    ],
  ];

  it.each(changes)(
    '%s changed → the token API refuses the destination naming provider',
    async (_field, change) => {
      const state = keyState();
      state.means.oidcIssuerUrl = 'https://idp.example.com/realms/r';
      const instance = consumerProvider('instance');
      const broker = new AuthBroker({
        ...STATED,
        sessionStore: new SafeAbapSessionStore(),
        serviceKeyStore: keyStore(state),
        provider: instance,
      });
      await expect(broker.getToken(D)).resolves.toBe('instance-1');
      await expect(broker.getToken(D)).resolves.toBe('instance-2');

      change(state);
      await expect(broker.getToken(D)).rejects.toMatchObject({
        name: 'DestinationConfigError',
        missingFields: ['provider'],
      });
    },
  );

  it('the client secret is not part of it: a changed secret keeps the instance', async () => {
    const state = keyState();
    const broker = new AuthBroker({
      ...STATED,
      sessionStore: new SafeAbapSessionStore(),
      serviceKeyStore: keyStore(state),
      provider: consumerProvider('instance'),
    });
    await expect(broker.getToken(D)).resolves.toBe('instance-1');
    state.client = { ...state.client, uaaClientSecret: 'S3CRET-new' };
    await expect(broker.getToken(D)).resolves.toBe('instance-2');
  });
});
