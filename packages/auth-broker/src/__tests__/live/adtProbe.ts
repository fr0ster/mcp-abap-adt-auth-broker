/**
 * What the live suites share to open ADT through `getProvider`: the probe a
 * connection 14 connector reads, and the check the `jwt` case runs — a
 * session seeded with a token the system refuses, the 401 renewed by the
 * stored refresh token in `rejected()`, the request answered 200, the new
 * token and its binding in the session file. `getProvider.live.test.ts`'s
 * `jwt` case and `browserLogin.live.test.ts` both run it, on a copy of a
 * session file; neither ever writes the original.
 *
 * Nothing here prints a value from the store: only status codes and sizes.
 */

import * as path from 'node:path';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
} from '@mcp-abap-adt/auth-stores';
import {
  AdtCloudConnector,
  type AdtOnPremConnector,
  CloudHttpTransport,
} from '@mcp-abap-adt/connection';
import type {
  IAuthorizationStrategy,
  IAuthProvider,
  IAuthRejection,
} from '@mcp-abap-adt/interfaces-auth';
import type { IConnectionConfig } from '@mcp-abap-adt/interfaces-auth-broker';
import { asContract } from '../../contractShape';
import { AuthBroker } from '../../index';
import { runLog as log } from '../helpers/describeWhere';
import { STATED } from '../helpers/stated';

/** A silent logger for the connector: the case prints only what it asserts. */
export const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** The lightest ADT read connection 14's own live suite measures. */
export const PROBE = '/sap/bc/adt/compatibility/graph';

export type ConnectorConfig = ConstructorParameters<
  typeof AdtOnPremConnector
>[0];

export function byteSize(data: unknown): number {
  return typeof data === 'string'
    ? Buffer.byteLength(data)
    : Buffer.byteLength(JSON.stringify(data ?? ''));
}

/** A JWT the system did not issue: well-formed, unsigned, `exp` an hour ahead. */
function refusedJwt(): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    sub: 'auth-broker-live',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.refused`;
}

/** The provider, with every rejection it is handed recorded. */
function recordingRejections(provider: IAuthProvider): {
  provider: IAuthProvider;
  rejections: IAuthRejection[];
} {
  const rejections: IAuthRejection[] = [];
  return {
    rejections,
    provider: {
      kind: provider.kind,
      prepare: () => provider.prepare(),
      establish: (logon) => provider.establish(logon),
      authorize: (request) => provider.authorize(request),
      rejected: (rejection) => {
        rejections.push(rejection);
        return provider.rejected(rejection);
      },
    },
  };
}

/** This check renews by refresh: a login would mean a browser, so it is refused. */
const refuseLogin: IAuthorizationStrategy<string> = {
  authorize: async () => {
    throw new Error(
      'this case renews by the stored refresh token; it never logs in',
    );
  },
};

export interface RefusedTokenCheck {
  /** A directory holding `<destination>.env` — a copy; it is written. */
  sessionsDir: string;
  /** The directory of `<destination>.json`, the destination's SAP service key. */
  serviceKeysDir: string;
  destination: string;
  /** How the log lines name the case, e.g. `jwt over HTTP`. */
  label: string;
}

/**
 * The `jwt` case's check, on the session file `<sessionsDir>/<destination>.env`:
 * seeds a refused token under the binding the file answers, opens ADT through
 * `getProvider` and connection 14's `AdtCloudConnector`, and asserts one 401,
 * renewed by refresh, a 200, and a new token with its binding written back.
 */
export async function expectRefusedTokenRenewed(
  check: RefusedTokenCheck,
): Promise<void> {
  const { sessionsDir, serviceKeysDir, destination, label } = check;
  const sessions = new AbapSessionStore(sessionsDir);
  const stored = await sessions.loadSession(destination);
  if (!stored?.refreshToken) {
    throw new Error(
      `the session of "${destination}" holds no refresh token: log in again with the CLI`,
    );
  }
  if (!stored.issuedFor || !stored.issuedBy) {
    throw new Error(
      `the session of "${destination}" answers no binding (SAP_ISSUED_FOR / SAP_ISSUED_BY): log in again with mcp-auth 3`,
    );
  }
  const refused = refusedJwt();
  // auth-stores merges: the refused token is written under the binding
  // the file answered, its refresh token kept.
  await sessions.saveSession(destination, {
    authorizationToken: refused,
    refreshToken: stored.refreshToken,
    issuedFor: stored.issuedFor,
    issuedBy: stored.issuedBy,
  });

  const keys = new AbapServiceKeyStore(serviceKeysDir, {
    grantType: 'authorization_code',
  });
  const broker = new AuthBroker({
    ...STATED,
    serviceKeyStore: keys,
    sessionStore: sessions,
    authorization: () => refuseLogin,
  });
  const means: IConnectionConfig | null =
    await keys.getConnectionConfig(destination);
  if (!means?.serviceUrl) {
    throw new Error(
      `the service key of "${destination}" (${path.join(serviceKeysDir, `${destination}.json`)}) states no ABAP URL`,
    );
  }
  const recorded = recordingRejections(await broker.getProvider(destination));
  const connector = new AdtCloudConnector(
    asContract<ConnectorConfig>({
      url: means.serviceUrl,
      client: means.sapClient,
      authType: 'jwt',
    }),
    recorded.provider,
    new CloudHttpTransport(
      () => ({}),
      quiet,
      asContract<ConstructorParameters<typeof CloudHttpTransport>[2]>({
        client: means.sapClient,
        baseUrl: means.serviceUrl,
      }),
    ),
    quiet,
  );
  try {
    await connector.connect();
    const response = await connector.makeAdtRequest({
      method: 'GET',
      url: PROBE,
      headers: { Accept: 'application/xml' },
      timeout: 15_000,
    });
    log.info(
      `${label}: ${recorded.rejections.length} rejection(s) (${recorded.rejections
        .map((r) => r.status ?? r.at)
        .join(
          ', ',
        )}); GET ${PROBE} → ${response.status}, ${byteSize(response.data)} bytes`,
    );
    expect(response.status).toBe(200);
  } finally {
    await connector.disconnect();
  }

  expect(recorded.rejections.map((r) => r.status)).toEqual([401]);
  await broker.flush();
  const after = await sessions.loadSession(destination);
  expect(after?.authorizationToken).toEqual(expect.any(String));
  expect(after?.authorizationToken).not.toBe(refused);
  // The renewal wrote the binding beside it, computed from the key.
  expect(after?.issuedFor).toEqual(expect.any(String));
  expect(after?.issuedBy).toEqual(expect.any(String));
  log.info(
    `${label}: the session file holds a new token (${after?.authorizationToken?.length} chars)`,
  );
}
