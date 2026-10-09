/**
 * §13.3: `mcp-auth`'s authorization-code login — the built bin, a child
 * process — against the stand's Cloud Foundry UAA, started by
 * `npm run test:stand` (packages/auth-broker/tests/stand/run.sh).
 *
 * No real browser starts: the bin is given the suite's fake browser by
 * absolute path (`--browser-program`) and a `PATH` holding nothing; the fake
 * hands the URL over and the test plays the user on UAA's login form with the
 * library's `formLogin`, then brings the redirect to the CLI's callback on
 * `http://localhost:61001/callback` — the UAA clients `cli_authcode` and
 * `cli_short` (tests/stand/uaa/config/uaa.yml) register exactly that.
 *
 * The service key names a recording proxy in front of UAA (`startUaaProxy`),
 * so a case can say what the stand's token endpoint saw — a code exchange
 * with its `code_verifier`, a refresh, or nothing at all.
 *
 * The refused refresh: UAA revokes the stored refresh token through its own
 * endpoint, `DELETE /oauth/token/revoke/{tokenId}` (an opaque refresh token is
 * its own id), called with the user's access token — the token's owner may
 * revoke it. `cli_short`'s access tokens live 30 s, inside the one-minute
 * margin a token provider keeps, so the next `--env` run counts the stored
 * token expired and renews it.
 *
 * Runs only with UAA_URL set, on Linux; elsewhere skipped with the reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bindsPort,
  CALLBACK_PORT,
  type CliRun,
  describeWhere,
  envKeys,
  expectQuietStreams,
  type Inbox,
  playLogin,
  requireBuiltBin,
  runCli,
  standUnavailable,
  startInbox,
  startUaaProxy,
  UAA_URL,
  type UaaProxy,
  whileRunning,
  writeFakeBrowser,
} from './cliStand';

const TOKEN = 'XSUAA_JWT_TOKEN';
const REFRESH = 'XSUAA_REFRESH_TOKEN';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());

describeWhere(
  'mcp-auth — the authorization code login against UAA (the stand)',
  standUnavailable({ uaa: true }),
  () => {
    let root: string;
    let emptyPath: string;
    let fakeBrowser: string;
    let inbox: Inbox;
    let proxy: UaaProxy;
    let runs: CliRun[];

    beforeAll(() => {
      requireBuiltBin();
    });

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-stand-'));
      emptyPath = path.join(root, 'empty-path');
      fs.mkdirSync(emptyPath);
      fakeBrowser = writeFakeBrowser(root);
      inbox = await startInbox();
      proxy = await startUaaProxy(UAA_URL as string);
      runs = [];
    });

    afterEach(async () => {
      for (const run of runs) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill('SIGKILL');
          await run.ended;
        }
      }
      await inbox.close();
      await proxy.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** An XSUAA-format service key naming the proxy and `client`. */
    function serviceKey(client: 'cli_authcode' | 'cli_short'): string {
      const file = path.join(root, `${client}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          url: proxy.url,
          clientid: client,
          clientsecret: 'secret',
        }),
      );
      return file;
    }

    function mcpAuth(args: string[]): CliRun {
      const run = runCli(['--type', 'xsuaa', ...args], {
        cwd: root,
        emptyPath,
        env: { FAKE_BROWSER_INBOX: inbox.url },
      });
      runs.push(run);
      return run;
    }

    /** A fresh login through the fake browser, written to `output`. */
    async function login(
      client: 'cli_authcode' | 'cli_short',
      output: string,
    ): Promise<{ run: CliRun; token: string; refresh: string }> {
      const run = mcpAuth([
        '--service-key',
        serviceKey(client),
        '--output',
        output,
        '--browser-program',
        fakeBrowser,
      ]);
      await playLogin(await whileRunning(run, inbox.next()));
      expect(await run.ended).toEqual({ code: 0, signal: null });
      const keys = envKeys(output);
      return {
        run,
        token: keys[TOKEN] ?? '',
        refresh: keys[REFRESH] ?? '',
      };
    }

    it('logs in through the fake browser: the URL carries state and an S256 challenge, the .env holds the pair, stdout is empty', async () => {
      const output = path.join(root, 'out.env');
      const run = mcpAuth([
        '--service-key',
        serviceKey('cli_authcode'),
        '--output',
        output,
        '--browser-program',
        fakeBrowser,
      ]);
      const url = await whileRunning(run, inbox.next());
      const shown = new URL(url);
      expect(`${shown.origin}${shown.pathname}`).toBe(
        `${proxy.url}/oauth/authorize`,
      );
      expect(shown.searchParams.get('state')).toEqual(expect.any(String));
      expect(shown.searchParams.get('state')?.length).toBeGreaterThan(0);
      expect(shown.searchParams.get('code_challenge_method')).toBe('S256');
      expect(shown.searchParams.get('code_challenge')?.length).toBeGreaterThan(
        0,
      );
      expect(shown.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);

      await playLogin(url);
      expect(await run.ended).toEqual({ code: 0, signal: null });

      const keys = envKeys(output);
      const token = keys[TOKEN] ?? '';
      const refresh = keys[REFRESH] ?? '';
      expect(claims(token).user_name).toBe('tester');
      expect(claims(token).client_id).toBe('cli_authcode');
      expect(refresh.length).toBeGreaterThan(0);
      // One code exchange, carrying the PKCE verifier.
      expect(proxy.tokenRequests).toEqual([
        { grantType: 'authorization_code', codeVerifier: true },
      ]);
      expect(inbox.received).toHaveLength(1);
      expectQuietStreams(run, [token, refresh]);
    }, 120_000);

    it.each([
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const)(
      '%s while the fake browser holds the URL ends the login: exit %i, "the authorization was aborted", the callback port free, no output',
      async (signal, code) => {
        const output = path.join(root, 'out.env');
        const run = mcpAuth([
          '--service-key',
          serviceKey('cli_authcode'),
          '--output',
          output,
          '--browser-program',
          fakeBrowser,
        ]);
        // The URL is built once the callback listens: the login now waits.
        await whileRunning(run, inbox.next());
        run.child.kill(signal);

        expect(await run.ended).toEqual({ code, signal: null });
        expect(run.stderr()).toContain('the authorization was aborted');
        expect(run.stderr()).not.toContain('    at ');
        await bindsPort(CALLBACK_PORT);
        expect(fs.existsSync(output)).toBe(false);
        expect(proxy.tokenRequests).toEqual([]);
        expect(run.stdout()).toBe('');
      },
      120_000,
    );

    it('--browser none: the URL is read from stderr, the test plays the login, the run completes', async () => {
      const output = path.join(root, 'out.env');
      const run = mcpAuth([
        '--service-key',
        serviceKey('cli_authcode'),
        '--output',
        output,
        '--browser',
        'none',
      ]);
      const url = await run.stderrLine((line) =>
        line.startsWith(`${proxy.url}/oauth/authorize?`),
      );
      expect(new URL(url).searchParams.get('state')?.length).toBeGreaterThan(0);
      await playLogin(url);
      expect(await run.ended).toEqual({ code: 0, signal: null });

      const keys = envKeys(output);
      expect(claims(keys[TOKEN] ?? '').user_name).toBe('tester');
      expect(inbox.received).toEqual([]);
      expectQuietStreams(run, [keys[TOKEN] ?? '', keys[REFRESH] ?? '']);
    }, 120_000);

    it('a revoked refresh token: the next --env run is refused its refresh, logs in, and writes back the new pair — never the revoked token', async () => {
      const output = path.join(root, 'short.env');
      const first = await login('cli_short', output);
      expect(first.refresh.length).toBeGreaterThan(0);

      // UAA revokes it: the owner's access token may revoke its refresh token.
      const revoked = await fetch(
        `${UAA_URL}/oauth/token/revoke/${encodeURIComponent(first.refresh)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${first.token}` },
        },
      );
      expect(revoked.status).toBe(200);
      await revoked.text();
      const before = proxy.tokenRequests.length;

      const run = mcpAuth(['--env', output, '--browser-program', fakeBrowser]);
      await playLogin(await whileRunning(run, inbox.next()));
      expect(await run.ended).toEqual({ code: 0, signal: null });

      // The stand saw the refresh, refused, then the code exchange.
      expect(proxy.tokenRequests.slice(before)).toEqual([
        { grantType: 'refresh_token', codeVerifier: false },
        { grantType: 'authorization_code', codeVerifier: true },
      ]);
      const keys = envKeys(output);
      const token = keys[TOKEN] ?? '';
      const refresh = keys[REFRESH] ?? '';
      expect(refresh.length).toBeGreaterThan(0);
      expect(refresh).not.toBe(first.refresh);
      expect(token).not.toBe(first.token);
      expect(fs.readFileSync(output, 'utf8')).not.toContain(first.refresh);
      expectQuietStreams(run, [first.token, first.refresh, token, refresh]);
    }, 120_000);

    it('--env with a valid bound session: no request reaches the token endpoint, no browser, the file unchanged', async () => {
      const output = path.join(root, 'session.env');
      const first = await login('cli_authcode', output);
      const written = fs.readFileSync(output);
      const before = proxy.tokenRequests.length;

      const run = mcpAuth(['--env', output, '--browser-program', fakeBrowser]);
      expect(await run.ended).toEqual({ code: 0, signal: null });

      expect(proxy.tokenRequests.slice(before)).toEqual([]);
      expect(inbox.received).toHaveLength(1);
      expect(fs.readFileSync(output).equals(written)).toBe(true);
      expectQuietStreams(run, [first.token, first.refresh]);
    }, 120_000);
  },
);
