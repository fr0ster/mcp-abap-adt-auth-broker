/**
 * End-to-end integration test for mcp-auth CLI with public-client bootstrap
 *
 * This test is gated on environment variables and skipped by default.
 * Run manually with:
 *
 *   npm run build
 *   TEST_ABAP_URL=https://...abap.eu10.hana.ondemand.com \
 *   TEST_UAA_URL=https://...authentication.eu10.hana.ondemand.com \
 *   TEST_CLIENT_ID='sb-xs-...|xsuaa-abapcp-prod-eu10!b4584' \
 *   npm test -- publicClientBootstrap.integration.test.ts
 *
 * You will need to log in via the browser when it opens.
 * Record whether refresh_token was issued (visible in the .env file).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ABAP_URL = process.env.TEST_ABAP_URL;
const UAA_URL = process.env.TEST_UAA_URL;
const CLIENT_ID = process.env.TEST_CLIENT_ID;

(ABAP_URL && UAA_URL && CLIENT_ID ? describe : describe.skip)(
  'mcp-auth public-client end-to-end (manual)',
  () => {
    it(
      'writes a .env with non-empty BTP_JWT_TOKEN and ABAP GET succeeds',
      async () => {
        const outDir = fs.mkdtempSync(
          path.join(require('node:os').tmpdir(), 'mcp-auth-'),
        );
        const outFile = path.join(outDir, 'mcp.env');
        const cli = path.resolve(__dirname, '../../../dist/bin/mcp-auth.js');

        const r = spawnSync(
          process.execPath,
          [
            cli,
            '--abap-url',
            ABAP_URL!,
            '--uaa-url',
            UAA_URL!,
            '--client-id',
            CLIENT_ID!,
            '--output',
            outFile,
          ],
          { stdio: 'inherit', timeout: 5 * 60 * 1000 },
        );

        expect(r.status).toBe(0);
        const content = fs.readFileSync(outFile, 'utf8');
        expect(content).toMatch(/^BTP_JWT_TOKEN=.+$/m);
        expect(content).toMatch(/^BTP_UAA_CLIENT_SECRET=$/m);
        expect(content).toMatch(`BTP_ABAP_URL=${ABAP_URL}`);

        const jwtLine = content
          .split('\n')
          .find((l) => l.startsWith('BTP_JWT_TOKEN='))!;
        const jwt = jwtLine.split('=', 2)[1];

        const adt = await fetch(
          `${ABAP_URL!.replace(/\/$/, '')}/sap/bc/adt/discovery`,
          {
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: 'application/atomsvc+xml',
            },
          },
        );
        expect(adt.status).toBe(200);
        console.log(`ADT discovery status: ${adt.status}`);
      },
      5 * 60 * 1000,
    ); // 5 minute timeout for browser auth
  },
);
