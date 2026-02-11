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

function parseLoginForm(html) {
  const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
  if (!actionMatch) throw new Error('Login form action not found');
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
  const match = html.match(/name="SAMLResponse"\s+value="([^"]+)"/i);
  if (!match) return null;
  return match[1];
}

async function main() {
  const samlUrl = `${baseUrl}/realms/${realm}/protocol/saml/clients/${clientId}`;
  const loginPage = await fetchWithRedirect(samlUrl);
  const loginHtml = await loginPage.text();
  const { action, hiddenInputs } = parseLoginForm(loginHtml);

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
    throw new Error('SAMLResponse not found after login');
  }

  process.stdout.write(samlResponse);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
