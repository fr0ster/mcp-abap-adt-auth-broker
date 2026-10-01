#!/usr/bin/env node

const { URL, URLSearchParams } = require('url');

const baseUrl = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const realm = process.env.KEYCLOAK_REALM || 'mcp-sso';
const clientId = process.env.SAML_CLIENT_ID || 'mcp-sso-saml';
const username = process.env.KEYCLOAK_USER || 'demo';
const password = process.env.KEYCLOAK_PASSWORD || 'demo';

const maxRedirects = 10;
const cookieJar = new Map();

function storeCookies(headers) {
  const setCookie = headers.getSetCookie ? headers.getSetCookie() : headers.raw?.()['set-cookie'];
  if (!setCookie) return;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [name, value] = pair.split('=');
    if (name && value !== undefined) {
      cookieJar.set(name.trim(), value.trim());
    }
  }
}

function cookieHeader() {
  if (cookieJar.size === 0) return undefined;
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function fetchWithRedirect(url, options = {}) {
  let current = url;
  let redirects = 0;
  while (redirects <= maxRedirects) {
    const res = await fetch(current, {
      ...options,
      redirect: 'manual',
      headers: {
        ...(options.headers || {}),
        ...(cookieJar.size ? { Cookie: cookieHeader() } : {}),
      },
    });
    storeCookies(res.headers);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current).toString();
      current = next;
      redirects += 1;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

function parseLoginActionFromHtml(html) {
  const actionMatch = html.match(/action\s*:\s*['"]([^'"]+)['"]/i);
  return actionMatch ? actionMatch[1] : null;
}

function parseLoginForm(html) {
  const formTag =
    html.match(/<form[^>]*id=['"]kc-form-login['"][^>]*>/i)?.[0] ||
    html.match(/<form[^>]*name=['"]kc-form-login['"][^>]*>/i)?.[0] ||
    html.match(/<form[^>]*>/i)?.[0];

  if (!formTag) {
    const snippet = html.slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`Login form tag not found. HTML: ${snippet}`);
  }

  const actionMatch =
    formTag.match(/action=['"]([^'"]+)['"]/i) ||
    formTag.match(/action=([^ >]+)/i);

  if (!actionMatch) {
    const snippet = formTag.replace(/\s+/g, ' ');
    throw new Error(`Login form action not found. FORM: ${snippet}`);
  }

  const action = actionMatch[1];

  const hiddenInputs = {};
  const inputRegex = /<input[^>]+type="hidden"[^>]*>/gi;
  const nameRegex = /name="([^"]+)"/i;
  const valueRegex = /value="([^"]*)"/i;
  const inputs = html.match(inputRegex) || [];
  for (const input of inputs) {
    const name = input.match(nameRegex)?.[1];
    const value = input.match(valueRegex)?.[1] ?? '';
    if (name) hiddenInputs[name] = value;
  }

  return { action, hiddenInputs };
}

function extractSamlResponse(html) {
  const match =
    html.match(/name="SAMLResponse"\s+value="([^"]+)"/i) ||
    html.match(/name='SAMLResponse'\s+value='([^']+)'/i);
  if (!match) return null;
  return match[1];
}

async function main() {
  const samlUrl = `${baseUrl}/realms/${realm}/protocol/saml/clients/${clientId}`;
  const loginPage = await fetchWithRedirect(samlUrl);
  const loginHtml = await loginPage.text();
  const preLoginSaml = extractSamlResponse(loginHtml);
  if (preLoginSaml) {
    process.stdout.write(preLoginSaml);
    return;
  }
  let action;
  let hiddenInputs = {};
  try {
    ({ action, hiddenInputs } = parseLoginForm(loginHtml));
  } catch (error) {
    const actionFromScript = parseLoginActionFromHtml(loginHtml);
    if (!actionFromScript) {
      throw error;
    }
    action = actionFromScript;
  }

  const form = new URLSearchParams({
    username,
    password,
    ...hiddenInputs,
  });

  const loginRes = await fetchWithRedirect(action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const samlHtml = await loginRes.text();
  const samlResponse = extractSamlResponse(samlHtml);
  if (!samlResponse) {
    const snippet = samlHtml.slice(0, 400).replace(/\s+/g, ' ');
    throw new Error(`SAMLResponse not found after login. HTML: ${snippet}`);
  }

  process.stdout.write(samlResponse);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
