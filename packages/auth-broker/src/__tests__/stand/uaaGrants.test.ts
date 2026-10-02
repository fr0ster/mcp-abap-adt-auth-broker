/**
 * getProvider's UAA grants against a real Cloud Foundry UAA, started by
 * tests/stand/up.sh with the clients and user in tests/stand/uaa.
 *
 * Runs only when UAA_URL is set (`npm run test:stand` sets it); elsewhere it is
 * skipped with that reason in its title. The user's part of an interactive
 * grant — UAA's login form, the /passcode page — is played by formLogin.ts:
 * no browser is opened.
 *
 * The broker is composed as a consumer composes it: auth-stores 3's
 * `EnvDestinationStore` holds the means in one directory, its
 * `AbapSessionStore` the session secret in another. What the session file holds
 * afterwards is read from disk — the secret's keys and its binding
 * (`SAP_ISSUED_FOR`, `SAP_ISSUED_BY`), nothing else.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { externalCodeStrategy } from '@mcp-abap-adt/auth-providers';
import type {
  IAuthorizationStrategy,
  IAuthProvider,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import {
  ABAP_SESSION_VARS,
  AbapSessionStore,
  type DestinationMeans,
  EnvDestinationStore,
} from 'auth-stores-3';
import { AuthBroker, type StrategyGrant } from '../../index';
import { describeWhere } from '../helpers/describeWhere';
import { authorizeByForm, FormBrowser } from './formLogin';

const UAA_URL = process.env.UAA_URL?.replace(/\/+$/, '');

const USER = { username: 'tester', password: 'tester' };
const CALLBACK = 'http://localhost/callback';
const SERVICE_URL = 'https://abap.stand.invalid';
/** SERVICE_URL's canonical URI — what the session's `issuedFor` must hold (spec §4.5). */
const ISSUED_FOR = 'https://abap.stand.invalid:443';
/** UAA_URL (`http://localhost:<port>/uaa`, already canonical) with the client. */
const issuedBy = (clientId: string) => `${UAA_URL}?client_id=${clientId}`;
const UNAUTHORIZED = { at: 'request', status: 401, error: null } as const;

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

/** What the user does at UAA's login form: log in, and bring the code back. */
const loginThroughUaa = () =>
  externalCodeStrategy({
    redirectUri: CALLBACK,
    provide: async (url) => {
      const back = await authorizeByForm(url, CALLBACK, USER);
      return back.searchParams.get('code') ?? '';
    },
  });

/** What the user does at /passcode: log in, and read the code off the page. */
const passcodeFromUaa = (seen: string[]) =>
  externalCodeStrategy({
    provide: async (url) => {
      seen.push(url);
      const browser = new FormBrowser();
      const page = await browser.submitLogin(await browser.open(url), USER);
      const code = /<samp id="passcode">([^<]+)<\/samp>/.exec(
        page.html ?? '',
      )?.[1];
      if (!code) throw new Error(`no passcode on ${page.url}`);
      return code;
    },
  });

/** A strategy that must not be reached: a renewal here is a refresh, never a login. */
const noLogin: IAuthorizationStrategy<string> = {
  authorize: async () => {
    throw new Error('a refresh must not reach the authorization strategy');
  },
};

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

/** The keys of a `.env` file, in order. */
function keysOf(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
}

const SECRET_KEYS = [
  ABAP_SESSION_VARS.AUTHORIZATION_TOKEN,
  ABAP_SESSION_VARS.EXPIRES_AT,
  ABAP_SESSION_VARS.REFRESH_TOKEN,
  ABAP_SESSION_VARS.ISSUED_FOR,
  ABAP_SESSION_VARS.ISSUED_BY,
];

/** A key's value in a `.env` file, without the quotes auth-stores may write. */
function envValue(file: string, key: string): string | undefined {
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).replace(/^(['"`])(.*)\1$/, '$2');
}

describeWhere(
  'getProvider — the UAA grants against Cloud Foundry UAA (the stand)',
  UAA_URL
    ? null
    : 'UAA_URL is not set: run `npm run test:stand`, which starts the stand in Docker',
  () => {
    let uaaIssuer = '';
    let dir: string;
    let keysDir: string;
    let sessionsDir: string;

    beforeAll(async () => {
      // The issuer UAA puts in its tokens, as its discovery states it — not
      // derived from UAA_URL, whose port may differ from the committed config.
      const discovery = await fetch(
        `${UAA_URL}/.well-known/openid-configuration`,
      );
      uaaIssuer = ((await discovery.json()) as { issuer: string }).issuer;
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

    /** The destination's means written as a consumer writes them; a broker over both stores. */
    async function destination(
      name: string,
      means: DestinationMeans,
      authorization?: (
        d: string,
        g: StrategyGrant,
      ) => IAuthorizationStrategy<string>,
    ) {
      const keys = new EnvDestinationStore(keysDir);
      await keys.setDestination(name, {
        authType: 'jwt',
        serviceUrl: SERVICE_URL,
        uaaUrl: UAA_URL as string,
        ...means,
      });
      const sessions = new AbapSessionStore(sessionsDir);
      const broker = () =>
        new AuthBroker({
          serviceKeyStore: keys,
          sessionStore: sessions,
          authorization,
        });
      return {
        broker,
        sessions,
        sessionFile: path.join(sessionsDir, `${name}.env`),
      };
    }

    it('jwt / client_credentials obtains a client token and writes the secret alone', async () => {
      const { broker, sessions, sessionFile } = await destination('CC', {
        grantType: 'client_credentials',
        uaaClientId: 'cc_client',
        uaaClientSecret: 'secret',
      });
      const b = broker();
      const provider = await b.getProvider('CC');

      expect(await provider.prepare()).toEqual({ ok: true });
      await b.flush();

      const token = await bearer(provider);
      expect(claims(token).iss).toBe(uaaIssuer);
      expect(claims(token).grant_type).toBe('client_credentials');
      expect(claims(token).client_id).toBe('cc_client');
      expect((await sessions.loadSession('CC'))?.authorizationToken).toBe(
        token,
      );
      // No refresh token in a client_credentials answer, and none stored.
      expect(keysOf(sessionFile).sort()).toEqual(
        [
          ABAP_SESSION_VARS.AUTHORIZATION_TOKEN,
          ABAP_SESSION_VARS.EXPIRES_AT,
          ABAP_SESSION_VARS.ISSUED_FOR,
          ABAP_SESSION_VARS.ISSUED_BY,
        ].sort(),
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_FOR)).toBe(
        ISSUED_FOR,
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('cc_client'),
      );
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain('secret');
    });

    it('jwt / authorization_code logs in through UAA’s form, persists, and renews by refresh after a 401', async () => {
      const grants: StrategyGrant[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'CODE',
        {
          grantType: 'authorization_code',
          uaaClientId: 'authcode',
          uaaClientSecret: 'secret',
        },
        (_d, grant) => {
          grants.push(grant);
          return grants.length === 1 ? loginThroughUaa() : noLogin;
        },
      );

      const first = broker();
      const provider = await first.getProvider('CODE');
      expect(await provider.prepare()).toEqual({ ok: true });
      const loggedIn = await bearer(provider);
      expect(grants).toEqual(['authorization_code']);
      expect(claims(loggedIn).user_name).toBe('tester');
      expect(claims(loggedIn).grant_type).toBe('authorization_code');
      const afterLogin = await sessions.loadSession('CODE');
      expect(afterLogin?.authorizationToken).toBe(loggedIn);
      expect(afterLogin?.refreshToken).toEqual(expect.any(String));
      // The token's own exp, as the provider counts it (whole seconds).
      expect(
        Math.abs(
          (afterLogin?.expiresAt as number) -
            (claims(loggedIn).exp as number) * 1000,
        ),
      ).toBeLessThanOrEqual(1_000);
      expect(keysOf(sessionFile).sort()).toEqual([...SECRET_KEYS].sort());
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_FOR)).toBe(
        ISSUED_FOR,
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('authcode'),
      );

      // The server refuses the token: the provider renews in rejected().
      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = await bearer(provider);
      expect(renewed).not.toBe(loggedIn);
      expect(claims(renewed).jti).not.toBe(claims(loggedIn).jti);
      expect((await sessions.loadSession('CODE'))?.authorizationToken).toBe(
        renewed,
      );
      await first.flush();

      // A new broker over the same stores is seeded: no login, the stored token.
      const second = broker();
      const seeded = await second.getProvider('CODE');
      expect(await seeded.prepare()).toEqual({ ok: true });
      expect(await bearer(seeded)).toBe(renewed);
      expect(grants).toEqual(['authorization_code', 'authorization_code']);
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain('secret');
    }, 60_000);

    it('jwt / passcode sends the user to <uaaUrl>/passcode, persists, and renews by refresh after a 401', async () => {
      const seen: string[] = [];
      const grants: StrategyGrant[] = [];
      const { broker, sessions, sessionFile } = await destination(
        'PASSCODE',
        {
          grantType: 'passcode',
          uaaClientId: 'passcode_client',
          uaaClientSecret: 'secret',
        },
        (_d, grant) => {
          grants.push(grant);
          return passcodeFromUaa(seen);
        },
      );

      const b = broker();
      const provider = await b.getProvider('PASSCODE');
      expect(await provider.prepare()).toEqual({ ok: true });
      const loggedIn = await bearer(provider);

      expect(grants).toEqual(['passcode']);
      expect(seen).toEqual([`${UAA_URL}/passcode`]);
      expect(claims(loggedIn).user_name).toBe('tester');
      expect((await sessions.loadSession('PASSCODE'))?.authorizationToken).toBe(
        loggedIn,
      );

      expect(await provider.rejected(UNAUTHORIZED)).toEqual({ ok: true });
      const renewed = await bearer(provider);
      expect(renewed).not.toBe(loggedIn);
      // A refresh, not a second passcode.
      expect(seen).toHaveLength(1);
      expect((await sessions.loadSession('PASSCODE'))?.authorizationToken).toBe(
        renewed,
      );
      await b.flush();
      expect(keysOf(sessionFile).sort()).toEqual([...SECRET_KEYS].sort());
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('passcode_client'),
      );
      expect(fs.readFileSync(sessionFile, 'utf8')).not.toContain('secret');
    }, 60_000);

    it('a session file bound to another URL is not reused: a fresh login through UAA, written with the new binding', async () => {
      let logins = 0;
      const { broker, sessions, sessionFile } = await destination(
        'MOVED',
        {
          grantType: 'authorization_code',
          uaaClientId: 'authcode',
          uaaClientSecret: 'secret',
        },
        () => {
          const login = loginThroughUaa();
          return {
            authorize: (request) => {
              logins += 1;
              return login.authorize(request);
            },
          };
        },
      );
      const first = broker();
      expect(await (await first.getProvider('MOVED')).prepare()).toEqual({
        ok: true,
      });
      await first.flush();
      const before = await sessions.loadSession('MOVED');
      expect(logins).toBe(1);
      expect(before?.issuedFor).toBe(ISSUED_FOR);

      // The destination now names another system.
      await new EnvDestinationStore(keysDir).setDestination('MOVED', {
        serviceUrl: 'https://moved.stand.invalid/sap',
        sapClient: '200',
      });
      const second = broker();
      const moved = await second.getProvider('MOVED');
      expect(await moved.prepare()).toEqual({ ok: true });
      await second.flush();

      expect(logins).toBe(2);
      const token = await bearer(moved);
      expect(token).not.toBe(before?.authorizationToken);
      const after = await sessions.loadSession('MOVED');
      expect(after?.authorizationToken).toBe(token);
      expect(after?.refreshToken).not.toBe(before?.refreshToken);
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_FOR)).toBe(
        'https://moved.stand.invalid:443/sap?sap-client=200',
      );
      expect(envValue(sessionFile, ABAP_SESSION_VARS.ISSUED_BY)).toBe(
        issuedBy('authcode'),
      );
    }, 60_000);
  },
);
