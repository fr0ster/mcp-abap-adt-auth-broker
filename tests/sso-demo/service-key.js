#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const action = args[0];

let serviceName = 'sso-demo-auth';
let keyName = 'sso-demo-key';
let outFile = 'sso-demo.xsuaa.json';

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  const next = i + 1 < args.length ? args[i + 1] : undefined;
  if (arg === '--service' && next) {
    serviceName = next;
    i++;
    continue;
  }
  if (arg === '--key' && next) {
    keyName = next;
    i++;
    continue;
  }
  if (arg === '--out' && next) {
    outFile = next;
    i++;
    continue;
  }
}

if (!action || !['create', 'fetch', 'delete'].includes(action)) {
  console.error(
    'Usage: node service-key.js <create|fetch|delete> [--service <name>] [--key <name>] [--out <file>]',
  );
  process.exit(1);
}

function runCf(cmdArgs) {
  const result = spawnSync('cf', cmdArgs, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.stderr.write(result.stdout || '');
    process.exit(result.status || 1);
  }
  return result.stdout || '';
}

if (action === 'create') {
  runCf(['create-service-key', serviceName, keyName]);
  process.exit(0);
}

if (action === 'delete') {
  runCf(['delete-service-key', serviceName, keyName, '-f']);
  process.exit(0);
}

const output = runCf(['service-key', serviceName, keyName]);
const jsonStart = output.indexOf('{');
if (jsonStart === -1) {
  console.error('Could not find JSON in cf service-key output.');
  process.stderr.write(output);
  process.exit(1);
}

const json = output.slice(jsonStart);
fs.writeFileSync(outFile, json, 'utf8');
