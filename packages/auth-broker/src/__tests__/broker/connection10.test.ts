/**
 * End to end through `@mcp-abap-adt/connection` 10, no SAP system — a
 * process's connector renews and the renewal is stored: a connector built from what `getProvider`
 * returns, over its real HTTP wire, against a local server that refuses the
 * stored token with a 401 and takes the renewed one; a local token endpoint.
 *
 * The provider renews once in `rejected()`, the connector resends once, the
 * new token is in the session file afterwards — and the token API, on the same
 * broker, answers that very token without asking for another (one provider per
 * destination, shared by `getProvider` and the token API).
 *
 * The stores are auth-stores 3's file stores, as a consumer composes them: the
 * means in an `EnvDestinationStore`, the secret in an `AbapSessionStore`.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ABAP_DESTINATION_VARS,
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import {
  AdtCloudConnector,
  CloudHttpTransport,
} from '@mcp-abap-adt/connection';
import type {
  IAuthorizationStrategy,
  IAuthProvider,
  IAuthRejection,
} from '@mcp-abap-adt/interfaces-auth';
import { AuthBroker } from '../../index';
import {
  jwtExpiringIn,
  startTokenEndpoint,
  type TokenEndpoint,
} from '../helpers/tokenEndpoint';

const D = 'TRIAL';
const PROBE = '/sap/bc/adt/compatibility/graph';
/** Where ABAP Cloud hands out a session, and the link it names it by. */
const SESSIONS = '/sap/bc/adt/core/http/sessions';
const SECURITY_SESSION_REL =
  'http://www.sap.com/adt/categories/core/http/sessions/securitysession';

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** One request the local ABAP server received. */
interface Seen {
  method: string;
  path: string;
  bearer?: string | undefined;
  status: number;
}

/**
 * A local stand-in for an ABAP system's HTTP side: it takes a bearer token the
 * token endpoint issued and answers 401 to any other — the stored token is
 * well-formed and unexpired, so only the server can refuse it. Every answer to
 * an accepted request carries a CSRF token, as ADT's do.
 */
async function startAbap(endpoint: TokenEndpoint) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const accepted = bearer !== undefined && endpoint.issued.includes(bearer);
      const status = accepted ? 200 : 401;
      seen.push({
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0]!,
        bearer,
        status,
      });
      if (!accepted) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      const headers = {
        'Content-Type': 'application/xml',
        'x-csrf-token': 'CSRF-TOKEN',
        // What ABAP Cloud answers: a session the connector can hold a lock in.
        'Set-Cookie': 'SAP_SESSIONID_TST_100=local-session; path=/',
      };
      if (req.url?.startsWith(SESSIONS)) {
        res
          .writeHead(200, headers)
          .end(
            `<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom"><atom:link href="${SESSIONS}/local-session" rel="${SECURITY_SESSION_REL}"/></http:session>`,
          );
        return;
      }
      res.writeHead(200, headers).end('<ok/>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** The provider, with every rejection the connector hands it recorded. */
function recordingRejections(provider: IAuthProvider) {
  const rejections: IAuthRejection[] = [];
  const recorded: IAuthProvider = {
    kind: provider.kind,
    prepare: () => provider.prepare(),
    establish: (logon) => provider.establish(logon),
    authorize: (request) => provider.authorize(request),
    rejected: (rejection) => {
      rejections.push(rejection);
      return provider.rejected(rejection);
    },
  };
  return { provider: recorded, rejections };
}

/** The renewal here is a refresh: a login would mean a person, so it is refused. */
const refuseLogin: IAuthorizationStrategy<string> = {
  authorize: async () => {
    throw new Error('this case renews by refresh; it never logs in');
  },
};

let endpoint: TokenEndpoint;
let abap: Awaited<ReturnType<typeof startAbap>>;
let dir: string;

beforeEach(async () => {
  endpoint = await startTokenEndpoint();
  abap = await startAbap(endpoint);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-connection-'));
  fs.mkdirSync(path.join(dir, 'keys'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  const V = ABAP_DESTINATION_VARS;
  fs.writeFileSync(
    path.join(dir, 'keys', `${D}.env`),
    [
      `${V.serviceUrl}=${abap.url}`,
      `${V.authType}=jwt`,
      `${V.grantType}=authorization_code`,
      `${V.uaaUrl}=${endpoint.url}`,
      `${V.uaaClientId}=broker-client`,
      `${V.uaaClientSecret}=S3CRET-client`,
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  await abap.close();
  await endpoint.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('through connection 10: getProvider → AdtCloudConnector → 401 → rejected() → the session store → the token API', () => {
  it('renews once, resends once, stores the new token, and the token API answers that same token', async () => {
    const sessions = new AbapSessionStore(path.join(dir, 'sessions'));
    // A token the server refuses: well-formed, a future exp, issued by no one.
    const refused = jwtExpiringIn(3600, { jti: 'refused' });
    await sessions.saveSession(D, {
      authorizationToken: refused,
      refreshToken: 'stored-refresh',
      issuedFor: abap.url,
      issuedBy: `${endpoint.url}?client_id=broker-client`,
    });
    const broker = new AuthBroker({
      serviceKeyStore: new EnvDestinationStore(path.join(dir, 'keys')),
      sessionStore: sessions,
      authorization: () => refuseLogin,
    });

    const recorded = recordingRejections(await broker.getProvider(D));
    const connector = new AdtCloudConnector(
      { url: abap.url, authType: 'jwt' },
      recorded.provider,
      new CloudHttpTransport(() => ({}), quiet, { baseUrl: abap.url }),
      quiet,
    );
    let status: number;
    try {
      await connector.connect();
      const response = await connector.makeAdtRequest({
        method: 'GET',
        url: PROBE,
        headers: { Accept: 'application/xml' },
        timeout: 5_000,
      });
      status = response.status;
    } finally {
      await connector.disconnect();
    }

    expect(status).toBe(200);
    // One renewal: one refresh by the stored refresh token, no login.
    expect(recorded.rejections.map((r) => r.status)).toEqual([401]);
    expect(endpoint.requests.map((r) => r.grantType)).toEqual([
      'refresh_token',
    ]);
    expect(endpoint.requests[0]!.params.refresh_token).toBe('stored-refresh');
    const renewed = endpoint.issued[0];
    // What the server saw: connection 10's logon (its session preflight, then
    // the CSRF fetch) with the refused token — the 401 on the CSRF fetch is
    // what it handed to rejected() — then the logon once more with the
    // renewed token, and the request itself. One renewal, one resend.
    const which = (bearer?: string) =>
      bearer === refused ? 'refused' : bearer === renewed ? 'renewed' : bearer;
    expect(abap.seen.map((s) => [s.path, which(s.bearer), s.status])).toEqual([
      [SESSIONS, 'refused', 401],
      ['/sap/bc/adt/core/discovery', 'refused', 401],
      [SESSIONS, 'renewed', 200],
      ['/sap/bc/adt/core/discovery', 'renewed', 200],
      [PROBE, 'renewed', 200],
    ]);

    // Written before the connector resent: in the session file now.
    const stored = await new AbapSessionStore(
      path.join(dir, 'sessions'),
    ).loadSession(D);
    expect(stored?.authorizationToken).toBe(renewed);
    expect(stored?.refreshToken).toBe('refresh-1');

    // The token API on the same broker: the same provider, the same token —
    // held, not read back from the store, and not asked for again.
    const loadSession = jest.spyOn(sessions, 'loadSession');
    await expect(broker.getToken(D)).resolves.toBe(renewed);
    await expect(broker.createTokenRefresher(D).getToken()).resolves.toBe(
      renewed,
    );
    expect(endpoint.requests).toHaveLength(1);
    expect(loadSession).not.toHaveBeenCalled();
    await expect(broker.flush()).resolves.toBeUndefined();
  });
});
