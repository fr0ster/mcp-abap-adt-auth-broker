#!/usr/bin/env node
// Cross-platform launcher for the public-client bootstrap integration test.
//
// Usage:
//   node scripts/run-public-client-integration.mjs
// or via npm:
//   npm run test:integration:public-client
//
// Override the defaults by exporting TEST_ABAP_URL / TEST_UAA_URL /
// TEST_CLIENT_ID in your environment before invoking.
//
// The script sets NODE_OPTIONS=--experimental-vm-modules via the child
// process environment (not via inline shell syntax) so it works on both
// POSIX shells and Windows cmd / PowerShell.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');

const env = {
  ...process.env,
  NODE_OPTIONS:
    `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
  TEST_ABAP_URL:
    process.env.TEST_ABAP_URL ??
    'https://b0c732e4-462a-4cad-b1f3-f27c37cc2dbf.abap.eu10.hana.ondemand.com',
  TEST_UAA_URL:
    process.env.TEST_UAA_URL ??
    'https://esup-idp-sandbox-6iwr9oqc.authentication.eu10.hana.ondemand.com',
  TEST_CLIENT_ID:
    process.env.TEST_CLIENT_ID ??
    'sb-xs-b0c732e4-462a-4cad-b1f3-f27c37cc2dbf!b614777|xsuaa-abapcp-prod-eu10!b4584',
};

const child = spawn(
  process.execPath,
  [jestBin, 'publicClientBootstrap.integration.test.ts'],
  { stdio: 'inherit', env },
);

child.on('exit', (code) => process.exit(code ?? 1));
