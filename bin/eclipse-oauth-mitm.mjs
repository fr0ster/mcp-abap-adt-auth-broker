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

// Base of the original ABAP request (used for reentrance-ticket exchange probes).
const abapBase = `${original.protocol}//${original.host}`;

/**
 * Probe four candidate mechanisms for exchanging a reentrance-ticket for a
 * server session (Set-Cookie). Runs each in sequence until one produces
 * Set-Cookie, or all fail. Note: reentrance-ticket is typically one-shot,
 * so only one variant will succeed per captured ticket. Failing variants
 * usually return 401 without consuming the ticket, but that is not guaranteed.
 */
async function probeReentranceExchange(ticket) {
  const variants = [
    {
      name: 'A) GET /sap/bc/adt/core/http/reentranceticket?reentrance-ticket=…',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/core/http/reentranceticket?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'B) GET /sap/bc/adt/discovery?reentrance-ticket=…',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'C) GET /sap/bc/adt/discovery  Authorization: Bearer <ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `Bearer ${ticket}` },
    },
    {
      name: 'D) GET /sap/bc/adt/discovery  X-SAP-Reentrance-Ticket: <ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { 'X-SAP-Reentrance-Ticket': ticket },
    },
  ];

  log('');
  log('=== reentrance-ticket exchange probe ===');
  for (const v of variants) {
    log(`→ ${v.name}`);
    try {
      const r = await fetch(v.url, {
        method: v.method,
        headers: { accept: 'application/*', ...v.headers },
        redirect: 'manual',
      });
      const setCookie =
        r.headers.getSetCookie?.() ?? r.headers.get('set-cookie');
      const allHeaders = Object.fromEntries(r.headers.entries());
      const bodyText = await r.text();
      const bodySnippet = bodyText.slice(0, 400).replace(/\s+/g, ' ');

      log(`   status    : ${r.status}`);
      log(`   location  : ${r.headers.get('location') || '(none)'}`);
      log(`   set-cookie: ${JSON.stringify(setCookie) || '(none)'}`);
      log(`   all-hdrs  : ${JSON.stringify(allHeaders)}`);
      log(`   body[0..400]: ${bodySnippet}${bodyText.length > 400 ? ' …' : ''}`);

      const gotCookie =
        setCookie && (Array.isArray(setCookie) ? setCookie.length > 0 : true);
      if (gotCookie) {
        log(`   ✅ variant worked — this is the exchange mechanism`);
        break;
      }
    } catch (e) {
      log(`   error     : ${e.message}`);
    }
  }
  log('=== end probe ===');
  log('');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = await readBody(req);
  log('callback received on', url.pathname);
  log('  method :', req.method);
  log('  headers:', JSON.stringify(req.headers, null, 2));
  log('  query  :', JSON.stringify(Object.fromEntries(url.searchParams), null, 2));
  if (body) log('  body   :', body);

  const ticket = url.searchParams.get('reentrance-ticket');
  if (ticket) {
    await probeReentranceExchange(ticket);
  }

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
