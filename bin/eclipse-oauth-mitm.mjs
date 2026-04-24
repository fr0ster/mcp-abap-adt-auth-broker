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

// Autodetect which query param carries the callback URL.
// OAuth2 uses `redirect_uri`; SAP ADT reentrance-ticket uses `redirect-url`;
// some flows use `redirect_url` or `callback_url`.
const REDIRECT_PARAM_CANDIDATES = [
  'redirect_uri',
  'redirect-url',
  'redirect_url',
  'callback_url',
];
const redirectParamName = REDIRECT_PARAM_CANDIDATES.find((p) =>
  original.searchParams.has(p),
);
if (!redirectParamName) {
  console.error(
    `URL has no redirect param — looked for any of: ${REDIRECT_PARAM_CANDIDATES.join(', ')}`,
  );
  process.exit(2);
}
const origRedirect = original.searchParams.get(redirectParamName);

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
  const body = await readBody(req);
  log('callback received on', url.pathname);
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
  // Preserve the original URL path so the rewritten URL is as close to the
  // original as possible; our listener accepts any path anyway.
  let origPath = '/callback';
  try {
    origPath = new URL(origRedirect).pathname || '/callback';
  } catch {
    // origRedirect not a full URL — fall back to /callback
  }
  const myRedirect = `http://localhost:${port}${origPath}`;

  const rewritten = new URL(original.toString());
  rewritten.searchParams.set(redirectParamName, myRedirect);

  log('listening on              :', myRedirect);
  log(`original ${redirectParamName.padEnd(16)}:`, origRedirect);
  log('');
  console.log(rewritten.toString());
  console.log('');
  log('waiting for callback… (ctrl-c to abort)');
});
