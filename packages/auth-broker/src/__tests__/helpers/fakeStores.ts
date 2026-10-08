/**
 * In-memory fakes of the store contracts: a key store holding means (and,
 * optionally, a client and a certificate client), a session store holding
 * one secret per destination and recording every write.
 */

import type {
  IClientCertificate,
  IConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';

export function fakeKeyStore(
  means: IConnectionConfig | null,
  client: IAuthorizationConfig | null = null,
  certificate?: IClientCertificate | null,
): jest.Mocked<IServiceKeyStore> {
  return {
    getServiceKey: jest.fn(async (_d: string) => null),
    getAuthorizationConfig: jest.fn(async (_d: string) => client),
    getConnectionConfig: jest.fn(async (_d: string) => means),
    ...(certificate === undefined
      ? {}
      : { getClientCertificate: jest.fn(async (_d: string) => certificate) }),
  };
}

export interface FakeSessionStore extends jest.Mocked<ISessionStore> {
  /** What each saveSession was given, in order. */
  readonly writes: IConfig[];
}

export function fakeSessionStore(
  session: IConfig | null = null,
): FakeSessionStore {
  const writes: IConfig[] = [];
  let stored: IConfig | null = session;
  return {
    writes,
    loadSession: jest.fn(async (_d: string) => stored),
    saveSession: jest.fn(async (_d: string, secret: unknown) => {
      const written = secret as IConfig;
      writes.push({ ...written });
      stored = { ...(stored ?? {}), ...written };
    }),
    getAuthorizationConfig: jest.fn(async (_d: string) => null),
    getConnectionConfig: jest.fn(async (_d: string) => stored),
    setAuthorizationConfig: jest.fn(
      async (_d: string, _c: IAuthorizationConfig) => {},
    ),
    setConnectionConfig: jest.fn(
      async (_d: string, _c: IConnectionConfig) => {},
    ),
    deleteSession: jest.fn(async (_d: string) => {}),
  };
}
