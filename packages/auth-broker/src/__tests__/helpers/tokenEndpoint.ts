/**
 * A local UAA token endpoint: `POST <url>/oauth/token`, on 127.0.0.1 and an
 * ephemeral port. It records every request — the grant, the form parameters,
 * the client authentication — and answers each with a fresh token, or with what
 * a test queued for the next request.
 *
 * Enough for the UAA grants auth-providers speaks (authorization_code,
 * client_credentials, password with a passcode, refresh_token). Not a UAA.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TokenRequest {
  grantType: string;
  params: Record<string, string>;
  /** The `Authorization` header, when the client authenticated with one. */
  authorization?: string;
}

export interface TokenAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface TokenEndpoint {
  /** The base URL, as a key store states `uaaUrl`. */
  url: string;
  requests: TokenRequest[];
  /** The tokens issued, in order. */
  issued: string[];
  /** Answer the next request with this instead of a fresh token. */
  answerNext(answer: TokenAnswer): void;
  close(): Promise<void>;
}

const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT: only its claims are read on this side. */
export function jwt(claims: Record<string, unknown>): string {
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.sig`;
}

/** A JWT whose `exp` is `secondsFromNow` away. */
export function jwtExpiringIn(
  secondsFromNow: number,
  claims: Record<string, unknown> = {},
): string {
  return jwt({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + secondsFromNow,
  });
}

export async function startTokenEndpoint(): Promise<TokenEndpoint> {
  const requests: TokenRequest[] = [];
  const issued: string[] = [];
  const queued: TokenAnswer[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/oauth/token') {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(new URLSearchParams(raw));
      requests.push({
        grantType: params.grant_type ?? '',
        params,
        authorization: req.headers.authorization,
      });
      const answer = queued.shift() ?? fresh(params.grant_type);
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });

  function fresh(grantType: string | undefined): TokenAnswer {
    const n = issued.length + 1;
    const token = jwtExpiringIn(3600, {
      jti: `token-${n}`,
      grant_type: grantType,
    });
    issued.push(token);
    return {
      status: 200,
      body: {
        access_token: token,
        token_type: 'bearer',
        expires_in: 3600,
        ...(grantType === 'client_credentials'
          ? {}
          : { refresh_token: `refresh-${n}` }),
      },
    };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    issued,
    answerNext: (answer) => {
      queued.push(answer);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
