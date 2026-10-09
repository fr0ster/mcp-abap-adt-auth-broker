/**
 * The pasted SAML logins of `mcp-auth saml2-pure` and `saml2-bearer`
 * — the built bin, a child process — with the stand's Keycloak as the
 * identity provider, each with its ACS declared and the SAMLResponse given on
 * the CLI's stdin, as a user pastes it.
 *
 * - `saml2-pure --assertion-flow manual`: the CLI sends its own AuthnRequest
 *   (the URL on stderr) to Keycloak's `sap-sp` client, an SP no other suite
 *   uses (tests/stand/keycloak/realm-test.json); the test logs in on
 *   Keycloak's page (formLogin) and pastes the SAMLResponse Keycloak posts to
 *   the declared ACS. The CLI validates it — signature, Issuer, Audience,
 *   Recipient, `InResponseTo` of its own request — and asks for the session
 *   cookies the system set. No SAP system is on the stand to set them, and
 *   UAA's web SSO refuses an assertion answering a request it did not send,
 *   so the test pastes a cookie of its own: what is measured is the CLI's
 *   paste, validation and write, not ICF's SAML handling.
 * - `saml2-bearer --idp-initiated`: UAA trusts Keycloak (`trustKeycloakInUaa`),
 *   `uaa-sp`'s IdP-initiated SSO is pointed at UAA's bearer ACS, and the CLI
 *   reads UAA's SP metadata itself (`--uaa-url`): the ACS it declares, the
 *   Audience, the token alias. The test starts the login at Keycloak, pastes
 *   the SAMLResponse; UAA exchanges the assertion for a token.
 *
 * Both Keycloak clients are given assertions valid for an hour through the
 * admin API (`standAdmin.ts`, shared with the library's SAML suite): by
 * default they expire inside the one-minute margin a provider keeps.
 *
 * Runs only with UAA_URL and KEYCLOAK_URL set, on Linux; elsewhere skipped
 * with the reason.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FormBrowser,
  samlResponseByForm,
} from '../../../../auth-broker/tests/stand/formLogin';
import {
  HOUR_LONG_ASSERTIONS,
  idpInitiatedSsoTo,
  trustKeycloakInUaa,
  uaaAcs,
  updateKeycloakSamlClient,
} from '../../../../auth-broker/tests/stand/standAdmin';
import {
  type CliRun,
  describeWhere,
  envKeys,
  expectQuietStreams,
  KEYCLOAK_URL,
  requireBuiltBin,
  runCli,
  standUnavailable,
  UAA_URL,
  USER,
} from './cliStand';

/** Where the `sap-sp` login says the SAMLResponse is posted: declared, never listened on. */
const SAP_ACS = 'http://localhost:61003/sap/saml2/sp/acs/100';

const claims = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());

describeWhere(
  'mcp-auth saml2-pure / saml2-bearer — the pasted SAML logins, Keycloak as the IdP (the stand)',
  standUnavailable({ uaa: true, keycloak: true }),
  () => {
    let root: string;
    let emptyPath: string;
    let runs: CliRun[];

    beforeAll(async () => {
      requireBuiltBin();
      await trustKeycloakInUaa(UAA_URL as string, KEYCLOAK_URL as string);
      await updateKeycloakSamlClient(
        KEYCLOAK_URL as string,
        'sap-sp',
        HOUR_LONG_ASSERTIONS,
      );
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

    function mcpAuth(args: string[]): CliRun {
      const run = runCli(args, { cwd: root, emptyPath, stdin: true });
      runs.push(run);
      return run;
    }

    it('saml2-pure --assertion-flow manual: the AuthnRequest URL on stderr, the SAMLResponse pasted on stdin, validated, the cookies pasted and written', async () => {
      const output = path.join(root, 'pure.env');
      const run = mcpAuth([
        'saml2-pure',
        '--assertion-flow',
        'manual',
        '--idp-metadata',
        `${KEYCLOAK_URL}/protocol/saml/descriptor`,
        '--sp-entity-id',
        'sap-sp',
        '--acs-url',
        SAP_ACS,
        '--type',
        'abap',
        '--service-url',
        'https://abap.stand.invalid',
        '--output',
        output,
      ]);
      const url = await run.stderrLine((line) =>
        line.startsWith(`${KEYCLOAK_URL}/protocol/saml?`),
      );
      expect(new URL(url).searchParams.get('SAMLRequest')).toEqual(
        expect.any(String),
      );

      const { samlResponse, acsUrl } = await samlResponseByForm(url, USER);
      expect(acsUrl).toBe(SAP_ACS);
      run.answer(samlResponse);

      // A prompt ends no line: the next one follows it on the same line.
      await run.stderrLine((line) => line.includes('Paste session cookies'));
      const cookies = `SAP_SESSIONID_STD_100=${randomBytes(16).toString('hex')}`;
      run.answer(cookies);

      expect(await run.ended).toEqual({ code: 0, signal: null });
      const keys = envKeys(output);
      expect(
        Buffer.from(keys.SAP_SESSION_COOKIES_B64 ?? '', 'base64').toString(),
      ).toBe(cookies);
      expect(keys.SAP_JWT_TOKEN).toBeUndefined();
      // The means as declared: the pure grant, its ACS.
      expect(keys.SAP_GRANT_TYPE).toBe('saml2_pure');
      expect(keys.SAP_SAML_ACS_URL).toBe(SAP_ACS);
      expectQuietStreams(run, [cookies]);
    }, 120_000);

    it('saml2-bearer --idp-initiated: the ACS from UAA’s metadata, the SAMLResponse pasted on stdin, exchanged at UAA for a token and written', async () => {
      const bearerAcs = await uaaAcs(UAA_URL as string, 'URI');
      const ssoUrl = await idpInitiatedSsoTo(KEYCLOAK_URL as string, bearerAcs);
      const output = path.join(root, 'bearer.env');
      const run = mcpAuth([
        'saml2-bearer',
        '--idp-initiated',
        '--uaa-url',
        UAA_URL as string,
        '--client-id',
        'saml_kc',
        '--client-secret',
        'secret',
        '--idp-metadata',
        `${KEYCLOAK_URL}/protocol/saml/descriptor`,
        '--type',
        'xsuaa',
        '--output',
        output,
      ]);
      await run.stderrLine((line) =>
        line.includes('Start the login at your identity provider'),
      );

      // The user starts the login at Keycloak and lifts the SAMLResponse it
      // posts to UAA's bearer ACS.
      const browser = new FormBrowser();
      const page = await browser.submitLogin(await browser.open(ssoUrl), USER);
      const html = page.html ?? '';
      const start = html.indexOf('name="SAMLResponse" value="');
      expect(start).toBeGreaterThan(-1);
      const valueStart = start + 'name="SAMLResponse" value="'.length;
      const samlResponse = html.slice(
        valueStart,
        html.indexOf('"', valueStart),
      );
      run.answer(samlResponse);

      expect(await run.ended).toEqual({ code: 0, signal: null });
      const keys = envKeys(output);
      const token = keys.XSUAA_JWT_TOKEN ?? '';
      expect(claims(token).grant_type).toBe(
        'urn:ietf:params:oauth:grant-type:saml2-bearer',
      );
      expect(claims(token).origin).toBe('keycloak');
      expect(claims(token).user_name).toBe('tester');
      // The ACS the CLI declared, read from UAA's metadata; IdP-initiated.
      expect(keys.XSUAA_GRANT_TYPE).toBe('saml2_bearer');
      expect(keys.XSUAA_SAML_ACS_URL).toBe(bearerAcs);
      expect(keys.XSUAA_SAML_IDP_INITIATED).toBe('true');
      const refresh = keys.XSUAA_REFRESH_TOKEN ?? '';
      expect(refresh.length).toBeGreaterThan(0);
      expectQuietStreams(run, [token, refresh]);
    }, 120_000);
  },
);
