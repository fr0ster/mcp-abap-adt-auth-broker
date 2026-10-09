/**
 * The stand suites' recording proxy (`startUaaProxy`) owns what it opens
 * upstream: a stalled upstream cannot keep the Jest process — and so
 * `run.sh`, whose cleanup stops the stand — alive. Needs no stand: the
 * upstream here is a loopback socket that accepts and never answers.
 */

import * as net from 'node:net';
import { startUaaProxy } from './cliStand';

/** A loopback server that accepts, reads, and never answers. */
async function silentUpstream(): Promise<{
  url: string;
  connected: Promise<void>;
  closed: Promise<void>;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  let onConnected: () => void = () => {};
  let onClosed: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    onConnected = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.once('data', () => onConnected());
    socket.once('close', () => {
      sockets.delete(socket);
      onClosed();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/uaa`,
    connected,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** `promise`, or a rejection naming `what` after `ms` — the test's own bound. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

describe('the stand suites’ UAA proxy', () => {
  it('closing it destroys a request stalled upstream, and its close settles only then', async () => {
    const upstream = await silentUpstream();
    const proxy = await startUaaProxy(upstream.url);
    const client = new AbortController();
    const pending = fetch(`${proxy.url}/oauth/token`, {
      method: 'POST',
      body: 'grant_type=client_credentials',
      signal: client.signal,
    }).catch(() => undefined);
    try {
      await within(upstream.connected, 5_000, 'the request reached upstream');

      await within(proxy.close(), 5_000, 'the proxy closed');
      await within(upstream.closed, 5_000, 'upstream saw its socket closed');
      expect(proxy.tokenRequests).toEqual([
        { grantType: 'client_credentials', codeVerifier: false },
      ]);
    } finally {
      client.abort();
      await pending;
      await upstream.close();
    }
  }, 30_000);

  it('a client that goes away destroys its request upstream', async () => {
    const upstream = await silentUpstream();
    const proxy = await startUaaProxy(upstream.url);
    const client = new AbortController();
    const pending = fetch(`${proxy.url}/login`, {
      signal: client.signal,
    }).catch(() => undefined);
    try {
      await within(upstream.connected, 5_000, 'the request reached upstream');
      client.abort();
      await pending;
      await within(upstream.closed, 5_000, 'upstream saw its socket closed');
    } finally {
      await within(proxy.close(), 5_000, 'the proxy closed');
      await upstream.close();
    }
  }, 30_000);
});
