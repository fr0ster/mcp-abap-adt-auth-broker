/**
 * A local token endpoint: `POST <url>/oauth/token` (and `<url>/oauth/token/…`,
 * as a SAML bearer alias), on 127.0.0.1 and an ephemeral port. It records every
 * request — the grant, the form parameters, the client
 * authentication, and apart the path — and answers each with a fresh token, or with what a test
 * queued for the next request.
 *
 * Enough for the grants auth-providers speaks: the UAA ones (authorization_code,
 * client_credentials, password with a passcode, refresh_token) and the OIDC and
 * SAML ones (password, token exchange, device code, saml2-bearer). For OIDC it
 * also serves a discovery document at `<url>/.well-known/openid-configuration`
 * naming its own endpoints, and a device authorization endpoint at
 * `<url>/device`. Not a UAA, not an OpenID provider.
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
  /** The path each token request was posted to: `/oauth/token`, or an alias below it. */
  paths: string[];
  /** The form parameters of each device authorization request, in order. */
  deviceRequests: Record<string, string>[];
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
  const paths: string[] = [];
  const deviceRequests: Record<string, string>[] = [];
  const issued: string[] = [];
  let base = '';
  const queued: TokenAnswer[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      if (
        req.method === 'GET' &&
        path === '/.well-known/openid-configuration'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/oauth/token`,
            device_authorization_endpoint: `${base}/device`,
          }),
        );
        return;
      }
      if (req.method === 'POST' && path === '/device') {
        const n = deviceRequests.push(
          Object.fromEntries(new URLSearchParams(raw)),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            device_code: `device-${n}`,
            user_code: `USER-${n}`,
            verification_uri: `${base}/verify`,
            verification_uri_complete: `${base}/verify?user_code=USER-${n}`,
            expires_in: 600,
            interval: 1,
          }),
        );
        return;
      }
      if (
        req.method !== 'POST' ||
        !(path === '/oauth/token' || path.startsWith('/oauth/token/'))
      ) {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(new URLSearchParams(raw));
      paths.push(path);
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
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    requests,
    paths,
    deviceRequests,
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
