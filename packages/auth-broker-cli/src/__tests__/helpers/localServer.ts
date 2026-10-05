/**
 * A local HTTP server standing in for a token endpoint (UAA, an OIDC issuer):
 * it records every request — path, form body, Authorization header — and
 * answers each path with what the test states. Nothing leaves the machine.
 *
 * With `tls`, an HTTPS server instead (an XSUAA `certurl`): it asks for a
 * client certificate, accepts any, and records the subject CN of the one
 * presented.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

export interface RecordedRequest {
  path: string;
  form: Record<string, string>;
  authorization?: string | undefined;
  /** The subject CN of the client certificate presented (`tls` only). */
  clientCertificate?: string;
}

export type Answer = { status?: number; body: unknown };

export interface LocalServer {
  url: string;
  requests: RecordedRequest[];
  /** What a path answers; a path with no answer is a 404. */
  answer(
    path: string,
    answer: Answer | ((form: Record<string, string>) => Answer),
  ): void;
  close(): Promise<void>;
}

export async function startLocalServer(tls?: {
  cert: string;
  key: string;
}): Promise<LocalServer> {
  const answers = new Map<
    string,
    Answer | ((form: Record<string, string>) => Answer)
  >();
  const requests: RecordedRequest[] = [];
  const handler: http.RequestListener = (req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const form = Object.fromEntries(new URLSearchParams(body));
      const peer = tls
        ? (req.socket as TLSSocket).getPeerCertificate()
        : undefined;
      requests.push({
        path,
        form,
        authorization: req.headers.authorization,
        ...(peer?.subject
          ? { clientCertificate: String(peer.subject.CN) }
          : {}),
      });
      const found = answers.get(path);
      const answer =
        typeof found === 'function' ? found(form) : (found ?? undefined);
      if (!answer) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
        return;
      }
      res.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(answer.body));
    });
  };
  const server = tls
    ? https.createServer(
        { ...tls, requestCert: true, rejectUnauthorized: false },
        handler,
      )
    : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    answer: (path, answer) => {
      answers.set(path, answer);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * An unsigned JWT named `name`, valid for an hour: the providers read its
 * `exp`, so a stored one is reused rather than renewed.
 */
export function jwt(name: string): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({
    sub: name,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
}

/** The name an unsigned JWT from `jwt()` carries. */
export function jwtName(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
      .sub;
  } catch {
    return undefined;
  }
}

/**
 * A token response; each call a new access token — a JWT named
 * `<prefix>-access-<n>` — so a renewal is visible.
 */
export function tokenAnswer(prefix: string, refresh = true): () => Answer {
  let n = 0;
  return () => {
    n += 1;
    return {
      body: {
        access_token: jwt(`${prefix}-access-${n}`),
        ...(refresh ? { refresh_token: `${prefix}-refresh-${n}` } : {}),
        token_type: 'bearer',
        expires_in: 3600,
      },
    };
  };
}
