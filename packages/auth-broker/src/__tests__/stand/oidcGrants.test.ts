/**
 * getProvider's OIDC grants against a real Keycloak, started by
 * tests/stand/up.sh with the `test` realm in tests/stand/keycloak.
 *
 * Runs only when KEYCLOAK_URL is set (`npm run test:stand` sets it);
 * elsewhere it is skipped with that reason in its title. The user's part of an
 * interactive grant — Keycloak's login page, its device verification page — is
 * played by formLogin.ts: no browser is opened.
 *
 * The broker is composed as a consumer composes it: auth-stores 3's
 * `EnvDestinationStore` holds the means in one directory, its
 * `AbapSessionStore` the session secret in another. What the session file holds
 * afterwards is read from disk — the secret's keys and its binding, nothing
 * else.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  asOidcResult,
  externalCodeStrategy,
  type IDeviceCodePresenter,
  type OidcCallbackResult,
} from '@mcp-abap-adt/auth-providers';
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
import { AuthBroker } from '../../index';
import { describeWhere } from '../helpers/describeWhere';
import { approveDevice, authorizeByForm } from './formLogin';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL?.replace(/\/+$/, '');

const USER = { username: 'tester', password: 'tester' };
const CALLBACK = 'http://localhost/callback';
const SERVICE_URL = 'https://abap.stand.invalid';
/** SERVICE_URL's canonical URI — what the session's `issuedFor` must hold. */
const ISSUED_FOR = 'https://abap.stand.invalid:443';
/** KEYCLOAK_URL (`http://localhost:<port>/realms/test`, already canonical) with the client. */
const issuedBy = (clientId: string) => `${KEYCLOAK_URL}?client_id=${clientId}`;
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));

async function bearer(provider: IAuthProvider): Promise<string> {
  let token = '';
  const request: IRequestTarget = {
    header: (name, value) => {
      if (name === 'Authorization') token = value.replace(/^Bearer /, '');
    },
    cookies: () => {},
  };
  expect(await provider.authorize(request)).toEqual({ ok: true });
  return token;
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

const SECRET_KEYS = [
  ABAP_SESSION_VARS.AUTHORIZATION_TOKEN,
  ABAP_SESSION_VARS.EXPIRES_AT,
  ABAP_SESSION_VARS.REFRESH_TOKEN,
  ABAP_SESSION_VARS.ISSUED_FOR,
  ABAP_SESSION_VARS.ISSUED_BY,
].sort();

/** What the user does at Keycloak's login page: log in, and bring the code back. */
const loginThroughKeycloak = (): IAuthorizationStrategy<OidcCallbackResult> =>
  asOidcResult(
    externalCodeStrategy({
      redirectUri: CALLBACK,
      provide: async (url) => {
        const back = await authorizeByForm(url, CALLBACK, USER);
        return back.searchParams.get('code') ?? '';
      },
    }),
  );

/** A strategy that must not be reached: a renewal here is a refresh, never a login. */
const noLogin: IAuthorizationStrategy<OidcCallbackResult> = {
  authorize: async () => {
    throw new Error('a refresh must not reach the authorization strategy');
  },
};

/** What a user does with a device code: open the page it names, log in, approve. */
function approvingPresenter(shown: string[]): IDeviceCodePresenter {
  return {
    present: async (prompt) => {
      shown.push(prompt.userCode);
      await approveDevice(
        prompt.verificationUriComplete ?? prompt.verificationUri,
        USER,
      );
    },
  };
}

/** A user's access token for another client — the subject of a token exchange. */
async function subjectToken(): Promise<string> {
  const response = await fetch(
    `${KEYCLOAK_URL}/protocol/openid-connect/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'te-subject',
        client_secret: 'secret',
        ...USER,
      }),
    },
  );
  return ((await response.json()) as { access_token: string }).access_token;
}

describeWhere(
  'getProvider — the OIDC grants against Keycloak (the stand)',
  KEYCLOAK_URL
    ? null
    : 'KEYCLOAK_URL is not set: run `npm run test:stand`, which starts the stand in Docker',
  () => {
    let dir: string;
    let keysDir: string;
    let sessionsDir: string;

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

    /**
     * The destination's means written as a consumer writes them — the issuer,
     * and the client as `mcp-sso` writes it (`uaaUrl` the issuer); a broker
     * over both stores with the collaborators given.
     */
    async function destination(
      name: string,
      means: DestinationMeans,
      collaborators: {
        oidcAuthorization?: () => IAuthorizationStrategy<OidcCallbackResult>;
        deviceCodePresenter?: () => IDeviceCodePresenter;
      } = {},
    ) {
      const keys = new EnvDestinationStore(keysDir);
      await keys.setDestination(name, {
        authType: 'jwt',
        serviceUrl: SERVICE_URL,
        oidcIssuerUrl: KEYCLOAK_URL as string,
        uaaUrl: KEYCLOAK_URL as string,
        oidcScopes: ['openid'],
        ...means,
      });
      const sessions = new AbapSessionStore(sessionsDir);
      const broker = () =>
        new AuthBroker({
          serviceKeyStore: keys,
          sessionStore: sessions,
          ...collaborators,
        });
      return {
        broker,
        sessions,
        sessionFile: path.join(sessionsDir, `${name}.env`),
      };
    }

    it('jwt / password logs in, persists, renews by refresh after a 401, and a new broker is seeded', async () => {
      const { broker, sessions, sessionFile } = await destination('PWD', {
        grantType: 'password',
        uaaClientId: 'oidc-password',
        uaaClientSecret: 'secret',
        username: USER.username,
        password: USER.password,
      });

      const first = broker();
      const provider = await first.getProvider('PWD');
      expect(await provider.prepare()).toEqual({ ok: true });
      const loggedIn = await bearer(provider);
      expect(claims(loggedIn).iss).toBe(KEYCLOAK_URL);
      expect(claims(loggedIn).azp).toBe('oidc-password');
      expect(claims(loggedIn).preferred_username).toBe('tester');
      await first.flush();
      expect(keysOf(sessionFile).sort()).toEqual(SECRET_KEYS);
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_FOR)).toBe(
        ISSUED_FOR,
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('oidc-password'),
      );

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = await bearer(provider);
      expect(claims(renewed).jti).not.toBe(claims(loggedIn).jti);
      await first.flush();
      expect((await sessions.loadSession('PWD'))?.authorizationToken).toBe(
        renewed,
      );

      const seeded = await broker().getProvider('PWD');
      expect(await seeded.prepare()).toEqual({ ok: true });
      expect(await bearer(seeded)).toBe(renewed);
      // The means' secrets stay in the key store.
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toMatch(/secret|tester/);
    }, 60_000);

    it('jwt / oidc_authorization_code logs in through Keycloak’s page with PKCE, as a public client, and renews by refresh after a 401', async () => {
      const strategies: IAuthorizationStrategy<OidcCallbackResult>[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'BROWSER',
        {
          grantType: 'oidc_authorization_code',
          uaaClientId: 'oidc-browser',
          uaaClientSecret: '',
        },
        {
          oidcAuthorization: () => {
            const strategy =
              strategies.length === 0 ? loginThroughKeycloak() : noLogin;
            strategies.push(strategy);
            return strategy;
          },
        },
      );

      const b = broker();
      const provider = await b.getProvider('BROWSER');
      expect(await provider.prepare()).toEqual({ ok: true });
      const loggedIn = await bearer(provider);
      expect(claims(loggedIn).iss).toBe(KEYCLOAK_URL);
      expect(claims(loggedIn).azp).toBe('oidc-browser');
      expect(claims(loggedIn).preferred_username).toBe('tester');

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = await bearer(provider);
      expect(renewed).not.toBe(loggedIn);
      await b.flush();
      expect(strategies).toHaveLength(1);
      expect((await sessions.loadSession('BROWSER'))?.authorizationToken).toBe(
        renewed,
      );
      expect(keysOf(sessionFile).sort()).toEqual(SECRET_KEYS);
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('oidc-browser'),
      );
    }, 60_000);

    it('jwt / device_code shows the code through the consumer’s presenter, gets the token once the user approves, and persists it', async () => {
      const shown: string[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'DEVICE',
        {
          grantType: 'device_code',
          uaaClientId: 'oidc-device',
          uaaClientSecret: '',
        },
        { deviceCodePresenter: () => approvingPresenter(shown) },
      );

      const b = broker();
      const provider = await b.getProvider('DEVICE');
      expect(await provider.prepare()).toEqual({ ok: true });
      const token = await bearer(provider);
      await b.flush();

      expect(shown).toHaveLength(1);
      expect(claims(token).azp).toBe('oidc-device');
      expect(claims(token).preferred_username).toBe('tester');
      expect((await sessions.loadSession('DEVICE'))?.authorizationToken).toBe(
        token,
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('oidc-device'),
      );
    }, 60_000);

    it('jwt / token_exchange exchanges the stored subject token for the requester’s, and exchanges again after a 401', async () => {
      const subject = await subjectToken();
      const { broker, sessions, sessionFile } = await destination('TE', {
        grantType: 'token_exchange',
        uaaClientId: 'te-requester',
        uaaClientSecret: 'secret',
        oidcScopes: null,
        oidcSubjectToken: subject,
        oidcSubjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      });

      const b = broker();
      const provider = await b.getProvider('TE');
      expect(await provider.prepare()).toEqual({ ok: true });
      const exchanged = await bearer(provider);
      expect(claims(exchanged).azp).toBe('te-requester');
      expect(claims(exchanged).preferred_username).toBe('tester');

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const again = await bearer(provider);
      expect(claims(again).jti).not.toBe(claims(exchanged).jti);
      await b.flush();
      expect((await sessions.loadSession('TE'))?.authorizationToken).toBe(
        again,
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('te-requester'),
      );
      // The subject token is means: sent to Keycloak, never written to the session.
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain(subject);
    }, 60_000);
  },
);
