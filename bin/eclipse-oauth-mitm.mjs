#!/usr/bin/env node
// Eclipse ADT OAuth MITM observer.
//
// Takes an authorization URL (the one Eclipse would open in its embedded
// browser) as argv[1], rewrites the `redirect_uri` query parameter to point
// at a local listener spawned by this script, prints the rewritten URL, and
// waits for the callback. When the callback arrives, it logs everything
// (method, headers, query params, body) and then 302-redirects the browser
// to the original `redirect_uri` with the same query string — so Eclipse's
// own callback listener still sees the `code`/`state` and can attempt its
// own token exchange (which will fail because XSUAA bound the code to our
// rewritten redirect, but that's fine — the goal is observation).
//
// Usage:
//   node bin/eclipse-oauth-mitm.mjs '<auth-url>'
//
// Example:
//   node bin/eclipse-oauth-mitm.mjs \
//     'https://login.example/oauth/authorize?response_type=code&client_id=X&redirect_uri=http%3A%2F%2Flocalhost%3A7777%2Fcb&state=abc'
//
// Use ctrl-c to abort before the callback arrives.

import http from 'node:http';

const input = process.argv[2];
if (!input) {
  console.error('usage: node bin/eclipse-oauth-mitm.mjs <auth-url>');
  process.exit(2);
}

let original;
try {
  original = new URL(input);
} catch (e) {
  console.error(`invalid URL: ${e.message}`);
  process.exit(2);
}

const origRedirect = original.searchParams.get('redirect_uri');
if (!origRedirect) {
  console.error('URL has no redirect_uri query parameter — nothing to rewrite');
  process.exit(2);
}

function log(...a) {
  console.log(`[mitm] ${new Date().toISOString()}`, ...a);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/callback') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found: ${url.pathname}\n`);
    return;
  }

  const body = await readBody(req);
  log('callback received');
  log('  method :', req.method);
  log('  headers:', JSON.stringify(req.headers, null, 2));
  log('  query  :', JSON.stringify(Object.fromEntries(url.searchParams), null, 2));
  if (body) log('  body   :', body);

  const forwardTarget = new URL(origRedirect);
  for (const [k, v] of url.searchParams) forwardTarget.searchParams.append(k, v);

  log('forwarding 302 →', forwardTarget.toString());

  res.writeHead(302, { location: forwardTarget.toString() });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Captured</title>` +
      `<p>Callback captured and logged. Redirecting to original Eclipse callback…</p>` +
      `<p>Target: <code>${forwardTarget.toString()}</code></p>`,
  );

  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 250);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const myRedirect = `http://localhost:${port}/callback`;

  const rewritten = new URL(original.toString());
  rewritten.searchParams.set('redirect_uri', myRedirect);

  log('listening on        :', myRedirect);
  log('original redirect_uri:', origRedirect);
  log('');
  console.log(rewritten.toString());
  console.log('');
  log('waiting for callback… (ctrl-c to abort)');
});
