#!/usr/bin/env node
// Cross-platform launcher for the public-client bootstrap integration test.
//
// Usage:
//   node scripts/run-public-client-integration.mjs
// or via npm:
//   npm run test:integration:public-client
//
// Required configuration (one of):
//   - environment variables: TEST_ABAP_URL, TEST_UAA_URL, TEST_CLIENT_ID
//   - .env.test file in repo root with the same KEY=VALUE entries (one per line)
//
// Environment variables override .env.test entries when both are present.
// .env.test is gitignored — see .env.test.example for the file shape.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function loadDotEnvTest() {
  const file = path.join(REPO_ROOT, '.env.test');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fromFile = loadDotEnvTest();
const required = ['TEST_ABAP_URL', 'TEST_UAA_URL', 'TEST_CLIENT_ID'];
const resolved = {};
const missing = [];
for (const k of required) {
  const v = process.env[k] ?? fromFile[k];
  if (!v) missing.push(k);
  else resolved[k] = v;
}

if (missing.length) {
  console.error('Missing required configuration:');
  for (const k of missing) console.error(`  - ${k}`);
  console.error('');
  console.error(
    'Set them as environment variables, or create .env.test in repo root.',
  );
  console.error('See .env.test.example for the expected file shape.');
  process.exit(2);
}

const env = {
  ...process.env,
  ...resolved,
  NODE_OPTIONS:
    `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim(),
};

const child = spawn(
  process.execPath,
  [jestBin, 'publicClientBootstrap.integration.test.ts'],
  { stdio: 'inherit', env, cwd: REPO_ROOT },
);

child.on('exit', (code) => process.exit(code ?? 1));
