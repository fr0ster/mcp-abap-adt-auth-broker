/**
 * §13.3: `mcp-auth oidc --flow device` — the built bin, a child process —
 * against the stand's Keycloak (the `test` realm's public client
 * `oidc-device`, tests/stand/keycloak/realm-test.json).
 *
 * The device code is shown on stderr — the presenter is given no logger, so
 * no log level hides it — and the test plays the user: it reads the complete
 * verification URI from the CLI's stderr and approves it on Keycloak's pages
 * with the library's `formLogin`. The CLI polls until the approval lands.
 *
 * Runs only with KEYCLOAK_URL set, on Linux; elsewhere skipped with the reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { approveDevice } from '../../../../auth-broker/tests/stand/formLogin';
import {
  type CliRun,
  describeWhere,
  envKeys,
  expectQuietStreams,
  KEYCLOAK_URL,
  requireBuiltBin,
  runCli,
  standUnavailable,
  USER,
} from './cliStand';

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());

describeWhere(
  'mcp-auth oidc --flow device against Keycloak (the stand)',
  standUnavailable({ keycloak: true }),
  () => {
    let root: string;
    let emptyPath: string;
    let runs: CliRun[];

    beforeAll(() => {
      requireBuiltBin();
    });

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-stand-'));
      emptyPath = path.join(root, 'empty-path');
      fs.mkdirSync(emptyPath);
      runs = [];
    });

    afterEach(async () => {
      for (const run of runs) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill('SIGKILL');
          await run.ended;
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('shows the user code on stderr, gets the token once the user approves it on Keycloak, and writes the session', async () => {
      const output = path.join(root, 'device.env');
      const run = runCli(
        [
          'oidc',
          '--flow',
          'device',
          '--issuer',
          KEYCLOAK_URL as string,
          '--client-id',
          'oidc-device',
          '--type',
          'xsuaa',
          '--output',
          output,
        ],
        { cwd: root, emptyPath },
      );
      runs.push(run);

      const code = (
        await run.stderrLine((line) => line.startsWith('Enter code: '))
      ).slice('Enter code: '.length);
      const complete = (
        await run.stderrLine((line) => line.startsWith('Or use: '))
      ).slice('Or use: '.length);
      expect(code.length).toBeGreaterThan(0);
      expect(new URL(complete).searchParams.get('user_code')).toBe(code);
      await approveDevice(complete, USER);

      expect(await run.ended).toEqual({ code: 0, signal: null });
      const keys = envKeys(output);
      const token = keys.XSUAA_JWT_TOKEN ?? '';
      expect(claims(token).azp).toBe('oidc-device');
      expect(claims(token).preferred_username).toBe('tester');
      expect(keys.XSUAA_GRANT_TYPE).toBe('device_code');
      const refresh = keys.XSUAA_REFRESH_TOKEN ?? '';
      expect(refresh.length).toBeGreaterThan(0);
      expectQuietStreams(run, [token, refresh]);
    }, 120_000);
  },
);
