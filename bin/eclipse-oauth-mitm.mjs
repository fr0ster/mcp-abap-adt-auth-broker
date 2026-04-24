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
// If the request went to <uuid>.abap-web.<region>.hana.ondemand.com, the
// corresponding ABAP *runtime* host is <uuid>.abap.<region>.hana.ondemand.com.
// ADT's reentrance-ticket endpoint lives on the runtime (ICF), while
// the approuter (abap-web) just proxies browser-level OAuth. Probe both.
const abapRuntimeBase = abapBase.replace('.abap-web.', '.abap.');

/**
 * Probe four candidate mechanisms for exchanging a reentrance-ticket for a
 * server session (Set-Cookie). Runs each in sequence until one produces
 * Set-Cookie, or all fail. Note: reentrance-ticket is typically one-shot,
 * so only one variant will succeed per captured ticket. Failing variants
 * usually return 401 without consuming the ticket, but that is not guaranteed.
 */
async function probeReentranceExchange(ticket) {
  const UA_ECLIPSE =
    'Java/17.0.12 (Eclipse ADT)'; // Eclipse-like UA; approuter may key off this.
  const variants = [
    {
      name: 'A) GET /discovery  Authorization: Bearer <ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `Bearer ${ticket}` },
    },
    {
      name: 'B) GET /discovery  Authorization: <ticket>  (raw, no scheme)',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: ticket },
    },
    {
      name: 'C) GET /discovery  Authorization: SAP-Logon-Ticket <ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `SAP-Logon-Ticket ${ticket}` },
    },
    {
      name: 'D) GET /discovery  Authorization: Basic base64(":"+ticket)',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${ticket}`).toString('base64')}`,
      },
    },
    {
      name: 'E) GET /discovery  Cookie: MYSAPSSO2=<ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Cookie: `MYSAPSSO2=${ticket}` },
    },
    {
      name: 'F) GET /discovery  Cookie: sap-reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Cookie: `sap-reentrance-ticket=${ticket}` },
    },
    {
      name: 'G) GET /discovery?reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'H) GET /sap/bc/adt/core/http/reentranceticket?reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/core/http/reentranceticket?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'I) GET /discovery  Authorization: Bearer <ticket>  +Eclipse UA',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `Bearer ${ticket}`, 'User-Agent': UA_ECLIPSE },
    },
    {
      name: 'J) POST /sap/bc/adt/core/http/reentranceticket  body=ticket',
      method: 'POST',
      url: `${abapBase}/sap/bc/adt/core/http/reentranceticket`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `reentrance-ticket=${encodeURIComponent(ticket)}`,
    },
    // --- Probes against the ABAP runtime host (not the approuter) ---
    {
      name: `K) GET ${abapRuntimeBase}/sap/bc/adt/discovery  Authorization: Bearer <ticket>`,
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `Bearer ${ticket}` },
    },
    {
      name: `L) GET ${abapRuntimeBase}/sap/bc/adt/discovery?reentrance-ticket=<ticket>`,
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/discovery?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: `M) GET ${abapRuntimeBase}/sap/bc/adt/core/http/reentranceticket?reentrance-ticket=<ticket>`,
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/reentranceticket?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    // --- sap- prefix variant on approuter ---
    {
      name: 'N) GET /discovery?sap-reentrance-ticket=<ticket> (approuter)',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery?sap-reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'O) GET /discovery  Authorization: ReEntranceTicket <ticket>',
      method: 'GET',
      url: `${abapBase}/sap/bc/adt/discovery`,
      headers: { Authorization: `ReEntranceTicket ${ticket}` },
    },
    // --- Probes against runtime's /sap/bc/adt/core/http/sessions ---
    // (this is the endpoint Eclipse's log shows being hit right after
    // the public virtualhost call; so this is the real exchange point)
    {
      name: 'P) GET <runtime>/sap/bc/adt/core/http/sessions?reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/sessions?reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'Q) GET <runtime>/sap/bc/adt/core/http/sessions?sap-reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/sessions?sap-reentrance-ticket=${encodeURIComponent(ticket)}`,
      headers: {},
    },
    {
      name: 'R) GET <runtime>/sap/bc/adt/core/http/sessions  Cookie: sap-reentrance-ticket=<ticket>',
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/sessions`,
      headers: { Cookie: `sap-reentrance-ticket=${ticket}` },
    },
    {
      name: 'S) GET <runtime>/sap/bc/adt/core/http/sessions  X-SAP-Reentrance-Ticket: <ticket>',
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/sessions`,
      headers: { 'X-SAP-Reentrance-Ticket': ticket },
    },
    {
      name: 'T) GET <runtime>/sap/bc/adt/core/http/sessions  Authorization: Bearer <ticket>  +x-sap-security-session:create',
      method: 'GET',
      url: `${abapRuntimeBase}/sap/bc/adt/core/http/sessions`,
      headers: {
        Authorization: `Bearer ${ticket}`,
        'x-sap-security-session': 'create',
      },
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
        body: v.body,
        redirect: 'manual',
      });
      const setCookie =
        r.headers.getSetCookie?.() ?? r.headers.get('set-cookie');
      const allHeaders = Object.fromEntries(r.headers.entries());
      const bodyText = await r.text();

      log(`   status    : ${r.status}`);
      log(`   location  : ${r.headers.get('location') || '(none)'}`);
      log(`   set-cookie: ${JSON.stringify(setCookie) || '(none)'}`);
      log(`   all-hdrs  : ${JSON.stringify(allHeaders)}`);
      log(`   body (${bodyText.length} bytes):`);
      log(bodyText.length > 3000 ? `${bodyText.slice(0, 3000)}…` : bodyText);

      // Only a real SSO session cookie counts as success. Trace/context
      // cookies (sap-usercontext, sap-login-XSRF_*) are set on any response
      // from the ICF and do NOT mean we authenticated.
      const cookieList = Array.isArray(setCookie)
        ? setCookie
        : setCookie
          ? [setCookie]
          : [];
      const sessionCookie = cookieList.find((c) =>
        /^(MYSAPSSO2|JSESSIONID|SAP_SESSIONID|sap-contextid)=/i.test(c),
      );
      if (sessionCookie) {
        log(`   ✅ variant worked — real session cookie: ${sessionCookie.split(';')[0]}`);
      }
      // Do NOT break — continue probing all variants so we see the full
      // picture; trial systems don't penalize failed attempts.
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
