#!/usr/bin/env tsx

/**
 * Generate a destination .env file from a service key
 *
 * Usage:
 *   npm run generate-env -- <destination> [service-key-path] [session-path] --grant <grant>
 *   or
 *   npx tsx src/generate-env-from-service-key.ts <destination> [service-key-path] [session-path] --grant <grant>
 *
 * <grant>: authorization_code (opens the system browser) or client_credentials.
 *
 * Examples:
 *   npm run generate-env -- mcp --grant client_credentials
 *   npm run generate-env -- mcp ./mcp.json ./mcp.env --grant client_credentials
 *   npm run generate-env -- TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json --grant authorization_code
 */

import { browserCallbackStrategy } from '@mcp-abap-adt/auth-providers';
import { runGenerateEnv } from './generateEnv';
import { createWorkDir } from './workDir';

/**
 * A person completes this login at a browser; the provider's own default
 * (30s) is sized for an unattended caller instead.
 */
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

runGenerateEnv(process.argv.slice(2), {
  // Removed on any exit, error and signal included: it holds the secret.
  workDir: createWorkDir('generate-env'),
  // No port override: this script has no `--redirect-port` flag, so the
  // callback port is the strategy's own choice.
  authorization: () =>
    browserCallbackStrategy({
      browser: 'system',
      timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
    }),
})
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
