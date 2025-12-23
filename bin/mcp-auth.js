#!/usr/bin/env node
/**
 * Wrapper script for mcp-auth.ts
 * Uses npx tsx to run TypeScript file
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get absolute path to TypeScript file
const scriptPath = path.resolve(__dirname, 'mcp-auth.ts');

// Check if tsx is available locally, otherwise use npx
const localTsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const useLocalTsx = fs.existsSync(localTsx);

let command;
let args;

if (useLocalTsx) {
  // Use local tsx
  command = process.platform === 'win32' ? `${localTsx}.cmd` : localTsx;
  args = [scriptPath, ...process.argv.slice(2)];
} else {
  // Use npx tsx
  command = 'npx';
  args = ['tsx', scriptPath, ...process.argv.slice(2)];
}

// Run the TypeScript file
const child = spawn(command, args, {
  stdio: 'inherit',
  shell: false, // Don't use shell to avoid security warnings
  env: process.env,
});

child.on('error', (error) => {
  console.error(`Error: ${error.message}`);
  if (error.code === 'ENOENT') {
    console.error('Please install tsx: npm install -g tsx');
  }
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

