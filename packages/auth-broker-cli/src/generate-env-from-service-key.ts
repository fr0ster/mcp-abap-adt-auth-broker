#!/usr/bin/env tsx

/**
 * Generate a destination .env file from a service key
 *
 * Usage:
 *   npm run generate-env -- <destination> [service-key-path] [session-path] --grant <grant>
 *   or
 *   npx tsx src/generate-env-from-service-key.ts <destination> [service-key-path] [session-path] --grant <grant>
 *   each followed by
 *     [--client-auth certificate --cert-path <path> --key-path <path>
 *      | --client-auth secret --basic-encoding raw|form]
 *
 * <grant>: authorization_code (opens the system browser) or client_credentials.
 *
 * --client-auth: how the client authenticates, never inferred from the key.
 *   Absent: the client secret in the token request (2.0.0); a key with a
 *   client certificate and no secret is refused.
 *   certificate: the key's x509 client at its `certurl`, presenting the
 *     certificate and key in --cert-path and --key-path (both required):
 *     existing PEM files of yours, which the command never copies. The
 *     destination holds their absolute paths and `certurl` —
 *     SAP_UAA_CLIENT_CERT_PATH, SAP_UAA_CLIENT_KEY_PATH, SAP_UAA_CERT_URL
 *     (XSUAA_UAA_* for an XSUAA key) — never PEM, and no client secret.
 *   secret: the client secret in a Basic header, encoded as --basic-encoding
 *     states (required): raw (XSUAA) or form (UAA, Keycloak).
 *
 * Examples:
 *   npm run generate-env -- mcp --grant client_credentials
 *   npm run generate-env -- mcp ./mcp.json ./mcp.env --grant client_credentials
 *   npm run generate-env -- TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json --grant authorization_code
 *   npm run generate-env -- mcp ./mcp.json ./mcp.env --grant client_credentials --client-auth certificate --cert-path ./client.crt --key-path ./client.key
 *   npm run generate-env -- mcp ./mcp.json ./mcp.env --grant client_credentials --client-auth secret --basic-encoding raw
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
