#!/usr/bin/env node
/**
 * Wrapper script for mcp-auth.ts
 * Uses npx tsx to run TypeScript file
 */

const { spawn } = require('child_process');
const path = require('path');

// Get absolute path to TypeScript file
const scriptPath = path.resolve(__dirname, 'mcp-auth.ts');

let tsxCliPath;
try {
  // Resolve tsx CLI from local dependency (cross-platform, no npx/cmd)
  tsxCliPath = require.resolve('tsx/dist/cli.js');
} catch (error) {
  console.error('Error: tsx is not installed. Run `npm install` first to install local dependencies.');
  process.exit(1);
}

const nodePath = process.execPath;
const args = [tsxCliPath, scriptPath, ...process.argv.slice(2)];

// Run the TypeScript file via node + tsx CLI
const child = spawn(nodePath, args, {
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
