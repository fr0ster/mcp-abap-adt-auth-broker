/**
 * getProvider's SAML grants with Keycloak as the identity provider and UAA as
 * the service provider, both started by tests/stand/up.sh.
 *
 * - `saml2_pure` end to end: Keycloak issues a signed SAMLResponse for UAA's
 *   web SSO ACS; the broker's provider validates it; the consumer's
 *   `samlCookies` posts it to that ACS, and UAA answers with a session cookie
 *   that is a real UAA login — the cookie the provider then presents. What this
 *   does not prove is SAP ICF's own SAML handling (`SAP_SESSIONID`,
 *   `MYSAPSSO2`): no system at hand accepts SAML from a test IdP.
 * - `saml2_bearer` end to end: Keycloak's assertion exchanged at UAA's
 *   saml2-bearer grant for a token, then renewed by its refresh token.
 *
 * Both logins are IdP-initiated (`samlIdpInitiated: true`): UAA 79 refuses an
 * assertion whose SubjectConfirmationData carries an InResponseTo it did not
 * send — at the bearer grant and, measured for this stand, at web SSO too,
 * `login.saml.disableInResponseToCheck` notwithstanding — and an IdP answering
 * the provider's own AuthnRequest always sets one. Keycloak's `uaa-sp` client is
 * pointed at the ACS each test needs, and its assertion lifespan set to an hour:
 * by default Keycloak's `Conditions` expire a minute after issue, inside the
 * one-minute margin a token provider keeps, so stored cookies would count as
 * expired the moment they arrived. The tests in this file run one after
 * another; no other suite touches that client.
 *
 * Runs only with both UAA_URL and KEYCLOAK_URL set (`npm run test:stand`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryReplayStore } from '@mcp-abap-adt/auth-providers';
import {
  ABAP_SESSION_VARS,
  AbapSessionStore,
  type DestinationMeans,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';
import type {
  IAuthorizationStrategy,
  IAuthProvider,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import { AuthBroker, type StrategyGrant } from '../../index';
import { describeWhere } from '../helpers/describeWhere';
import { FormBrowser } from './formLogin';

const UAA_URL = process.env.UAA_URL?.replace(/\/+$/, '');
const KEYCLOAK_URL = process.env.KEYCLOAK_URL?.replace(/\/+$/, '');

const USER = { username: 'tester', password: 'tester' };
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));

const basic = (client: string) =>
  `Basic ${Buffer.from(`${client}:secret`).toString('base64')}`;

/** Register — or refresh — Keycloak as UAA's `keycloak` SAML provider. */
async function trustKeycloakInUaa(): Promise<void> {
  const metadata = await (
    await fetch(`${KEYCLOAK_URL}/protocol/saml/descriptor`)
  ).text();
  const token = (
    (await (
      await fetch(`${UAA_URL}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basic('stand_admin'),
        },
        body: 'grant_type=client_credentials',
      })
    ).json()) as { access_token: string }
  ).access_token;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const provider = {
    type: 'saml',
    originKey: 'keycloak',
    name: 'keycloak',
    active: true,
    config: {
      metaDataLocation: metadata,
      idpEntityAlias: 'keycloak',
      nameID: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
      assertionConsumerIndex: 0,
      metadataTrustCheck: false,
      showSamlLink: false,
      addShadowUserOnLogin: true,
    },
  };
  const existing = (
    (await (
      await fetch(`${UAA_URL}/identity-providers?rawConfig=true`, { headers })
    ).json()) as { id: string; originKey: string }[]
  ).find((p) => p.originKey === 'keycloak');
  const response = await fetch(
    existing
      ? `${UAA_URL}/identity-providers/${existing.id}?rawConfig=true`
      : `${UAA_URL}/identity-providers?rawConfig=true`,
    {
      method: existing ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(
        existing ? { ...provider, id: existing.id } : provider,
      ),
    },
  );
  if (!response.ok) {
    throw new Error(`UAA refused the Keycloak provider: ${response.status}`);
  }
}

/**
 * The certificates under every `KeyDescriptor use="signing"` in Keycloak's
 * metadata — generated when it starts, so never a committed fixture.
 */
async function keycloakCertificates(): Promise<string[]> {
  const metadata = await (
    await fetch(`${KEYCLOAK_URL}/protocol/saml/descriptor`)
  ).text();
  const found = new Set<string>();
  for (const descriptor of metadata.matchAll(
    /<(?:\w+:)?KeyDescriptor\b[^>]*\buse="signing"[^>]*>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/g,
  )) {
    for (const certificate of descriptor[1]!.matchAll(
      /<(?:\w+:)?X509Certificate>([^<]+)</g,
    )) {
      found.add(certificate[1]!.replace(/\s+/g, ''));
    }
  }
  if (found.size === 0) {
    throw new Error('no signing certificate in Keycloak metadata');
  }
  return [...found];
}

/** UAA's ACS for a binding, from its own SAML metadata. */
async function uaaAcs(binding: 'HTTP-POST' | 'URI'): Promise<string> {
  const metadata = await (await fetch(`${UAA_URL}/saml/metadata`)).text();
  const acs = new RegExp(
    `AssertionConsumerService[^>]*bindings:${binding}"[^>]*Location="([^"]+)"`,
  ).exec(metadata)?.[1];
  if (!acs) throw new Error(`no ${binding}-binding ACS in UAA metadata`);
  return acs;
}

/**
 * Point Keycloak's `uaa-sp` client's IdP-initiated SSO at `acsUrl`, with
 * assertions valid for an hour, and return the URL that starts it.
 */
async function idpInitiatedSsoTo(acsUrl: string): Promise<string> {
  const base = (KEYCLOAK_URL as string).replace(/\/realms\/.*$/, '');
  const admin = (
    (await (
      await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'admin',
        }),
      })
    ).json()) as { access_token: string }
  ).access_token;
  const headers = {
    Authorization: `Bearer ${admin}`,
    'Content-Type': 'application/json',
  };
  const [client] = (await (
    await fetch(`${base}/admin/realms/test/clients?clientId=uaa-sp`, {
      headers,
    })
  ).json()) as { id: string; attributes: Record<string, string> }[];
  if (!client) throw new Error('Keycloak has no uaa-sp client');
  client.attributes = {
    ...client.attributes,
    saml_idp_initiated_sso_url_name: 'uaa-sp',
    saml_assertion_consumer_url_post: acsUrl,
    'saml.assertion.lifespan': '3600',
  };
  const updated = await fetch(
    `${base}/admin/realms/test/clients/${client.id}`,
    { method: 'PUT', headers, body: JSON.stringify(client) },
  );
  if (!updated.ok) {
    throw new Error(`Keycloak refused the client update: ${updated.status}`);
  }
  return `${KEYCLOAK_URL}/protocol/saml/clients/uaa-sp`;
}

/**
 * The consumer's strategy for an IdP-initiated login: the user logs in at
 * Keycloak's IdP-initiated SSO URL, and the SAMLResponse Keycloak would post is
 * handed over. It never asks the provider for an AuthnRequest URL.
 */
function idpInitiatedLogin(
  url: string,
  acsUrl: string,
  logins: string[],
): IAuthorizationStrategy<string> {
  return {
    authorize: async () => {
      const browser = new FormBrowser();
      const page = await browser.submitLogin(await browser.open(url), USER);
      const payload = /name="SAMLResponse" value="([^"]+)"/.exec(
        page.html ?? '',
      )?.[1];
      if (!payload) throw new Error(`no SAMLResponse from ${url}`);
      logins.push(payload);
      return { payload, redirectUri: acsUrl };
    },
  };
}

/** What the consumer's `samlCookies` does here: post to UAA's ACS, keep its session cookie. */
async function cookiesFromUaa(
  acsUrl: string,
  samlResponse: string,
): Promise<string> {
  const response = await fetch(acsUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
  });
  const location = response.headers.get('location') ?? '';
  if (response.status !== 302 || location.includes('saml_error')) {
    throw new Error(`UAA refused the SAMLResponse: ${response.status}`);
  }
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

/** Whether UAA takes these cookies as tester's logged-in session. */
async function loggedInToUaa(cookies: string | undefined): Promise<boolean> {
  const response = await fetch(`${UAA_URL}/`, {
    redirect: 'manual',
    headers: cookies ? { Cookie: cookies } : {},
  });
  return response.status === 200 && (await response.text()).includes('tester');
}

async function presented(
  provider: IAuthProvider,
): Promise<{ bearer?: string; cookies?: string }> {
  let bearer: string | undefined;
  let cookies: string | undefined;
  const request: IRequestTarget = {
    header: (name, value) => {
      if (name === 'Authorization') bearer = value.replace(/^Bearer /, '');
    },
    cookies: (value) => {
      cookies = value;
    },
  };
  expect(await provider.authorize(request)).toEqual({ ok: true });
  return { bearer, cookies };
}

/** The keys of a `.env` file. */
function keysOf(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
}

/** A key's value in a `.env` file, without the quotes auth-stores may write. */
function envValue(file: string, key: string): string | undefined {
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).replace(/^(['"`])(.*)\1$/, '$2');
}

describeWhere(
  'getProvider — the SAML grants, Keycloak to UAA (the stand)',
  UAA_URL && KEYCLOAK_URL
    ? null
    : 'UAA_URL and KEYCLOAK_URL are not set: run `npm run test:stand`, which starts the stand in Docker',
  () => {
    let certificates: string[] = [];
    let webSsoAcs = '';
    let bearerAcs = '';
    let dir: string;
    let keysDir: string;
    let sessionsDir: string;

    beforeAll(async () => {
      await trustKeycloakInUaa();
      certificates = await keycloakCertificates();
      webSsoAcs = await uaaAcs('HTTP-POST');
      bearerAcs = await uaaAcs('URI');
    });

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-stand-'));
      keysDir = path.join(dir, 'destinations');
      sessionsDir = path.join(dir, 'sessions');
      fs.mkdirSync(keysDir);
      fs.mkdirSync(sessionsDir);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Keycloak's trust and the IdP-initiated login, as a destination states them. */
    const samlMeans = (acsUrl: string): DestinationMeans => ({
      authType: 'saml',
      samlIdpSsoUrl: `${KEYCLOAK_URL}/protocol/saml`,
      samlIdpEntityId: KEYCLOAK_URL as string,
      samlIdpCertificates: certificates,
      samlSpEntityId: 'uaa-sp',
      samlAcsUrl: acsUrl,
      samlIdpInitiated: true,
    });

    async function destination(
      name: string,
      means: DestinationMeans,
      collaborators: {
        authorization: (
          d: string,
          g: StrategyGrant,
        ) => IAuthorizationStrategy<string>;
        samlCookies?: (d: string) => (samlResponse: string) => Promise<string>;
      },
    ) {
      const keys = new EnvDestinationStore(keysDir);
      await keys.setDestination(name, means);
      const sessions = new AbapSessionStore(sessionsDir);
      const replayStore = createInMemoryReplayStore();
      const broker = () =>
        new AuthBroker({
          serviceKeyStore: keys,
          sessionStore: sessions,
          assertionReplayStore: () => replayStore,
          ...collaborators,
        });
      return {
        broker,
        sessions,
        sessionFile: path.join(sessionsDir, `${name}.env`),
      };
    }

    it('saml / saml2_pure: Keycloak’s assertion becomes a UAA session cookie, persisted, reused by a new broker, and renewed after a 401', async () => {
      const ssoUrl = await idpInitiatedSsoTo(webSsoAcs);
      const logins: string[] = [];
      const grants: StrategyGrant[] = [];
      const posted: string[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'PURE',
        {
          ...samlMeans(webSsoAcs),
          grantType: 'saml2_pure',
          serviceUrl: UAA_URL,
        },
        {
          authorization: (_d, grant) => {
            grants.push(grant);
            return idpInitiatedLogin(ssoUrl, webSsoAcs, logins);
          },
          samlCookies: () => async (samlResponse) => {
            posted.push(samlResponse);
            return cookiesFromUaa(webSsoAcs, samlResponse);
          },
        },
      );

      const first = broker();
      const provider = await first.getProvider('PURE');
      expect(await provider.prepare()).toEqual({ ok: true });
      await first.flush();
      const cookies = (await presented(provider)).cookies;
      expect(grants).toEqual(['saml2_pure']);
      expect(posted).toEqual(logins);
      expect(await loggedInToUaa(cookies)).toBe(true);
      expect(await loggedInToUaa(undefined)).toBe(false);

      const stored = await sessions.loadSession('PURE');
      expect(stored?.sessionCookies).toBe(cookies);
      expect(stored?.authorizationToken).toBeUndefined();
      expect(stored?.expiresAt).toBeGreaterThan(Date.now() + 30 * 60_000);
      expect(keysOf(sessionFile).sort()).toEqual(
        [
          ABAP_SESSION_VARS.SESSION_COOKIES_B64,
          ABAP_SESSION_VARS.EXPIRES_AT,
          ABAP_SESSION_VARS.ISSUED_FOR,
          ABAP_SESSION_VARS.ISSUED_BY,
        ].sort(),
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_FOR)).toBe(UAA_URL);
      // UAA_URL is http://localhost:<port>/uaa: the ACS is already canonical.
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        webSsoAcs,
      );

      // A new broker over the same stores reuses the cookies: no login.
      const second = broker();
      const seeded = await second.getProvider('PURE');
      expect(await seeded.prepare()).toEqual({ ok: true });
      expect((await presented(seeded)).cookies).toBe(cookies);
      expect(logins).toHaveLength(1);

      // UAA refuses the session: SAML has no refresh, so a new login.
      expect(await seeded.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = (await presented(seeded)).cookies;
      expect(logins).toHaveLength(2);
      expect(renewed).not.toBe(cookies);
      expect(await loggedInToUaa(renewed)).toBe(true);
      await second.flush();
      expect((await sessions.loadSession('PURE'))?.sessionCookies).toBe(
        renewed,
      );
    }, 90_000);

    it('saml / saml2_bearer: Keycloak’s assertion exchanged at UAA for a token, written as a token, renewed by refresh after a 401', async () => {
      const ssoUrl = await idpInitiatedSsoTo(bearerAcs);
      const logins: string[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'BEARER',
        {
          ...samlMeans(bearerAcs),
          grantType: 'saml2_bearer',
          serviceUrl: 'https://abap.stand.invalid',
          uaaUrl: UAA_URL as string,
          uaaClientId: 'saml_kc',
          uaaClientSecret: 'secret',
        },
        {
          authorization: () => idpInitiatedLogin(ssoUrl, bearerAcs, logins),
        },
      );

      const b = broker();
      const provider = await b.getProvider('BEARER');
      expect(await provider.prepare()).toEqual({ ok: true });
      const token = (await presented(provider)).bearer as string;
      expect(claims(token).grant_type).toBe(
        'urn:ietf:params:oauth:grant-type:saml2-bearer',
      );
      expect(claims(token).origin).toBe('keycloak');
      expect(claims(token).user_name).toBe('tester');
      await b.flush();
      const stored = await sessions.loadSession('BEARER');
      expect(stored?.authorizationToken).toBe(token);
      expect(stored?.sessionCookies).toBeUndefined();
      expect(stored?.refreshToken).toEqual(expect.any(String));
      expect(keysOf(sessionFile).sort()).toEqual(
        [
          ABAP_SESSION_VARS.AUTHORIZATION_TOKEN,
          ABAP_SESSION_VARS.EXPIRES_AT,
          ABAP_SESSION_VARS.REFRESH_TOKEN,
          ABAP_SESSION_VARS.ISSUED_FOR,
          ABAP_SESSION_VARS.ISSUED_BY,
        ].sort(),
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        `${UAA_URL}?client_id=saml_kc`,
      );

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = (await presented(provider)).bearer as string;
      expect(claims(renewed).jti).not.toBe(claims(token).jti);
      // A refresh, not a second SAML login (UAA keeps the token's grant_type).
      expect(logins).toHaveLength(1);
      await b.flush();
      expect((await sessions.loadSession('BEARER'))?.authorizationToken).toBe(
        renewed,
      );
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain('secret');
    }, 90_000);
  },
);
