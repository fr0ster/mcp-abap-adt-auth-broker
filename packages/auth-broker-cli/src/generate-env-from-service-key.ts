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
 * <grant>: authorization_code (opens a browser, as --browser states — default
 *   auto, the platform's default browser) or client_credentials.
 *
 * --verbose: log lines from debug on (default: from info), on stderr.
 * --auth-debug: the broker's authDebug — the providers' debug line names the
 *   request's secrets; implies --verbose. No environment variable does either.
 *
 * --browser auto|system|chrome|edge|firefox|none|headless, or
 * --browser-program <program>: as mcp-auth takes them.
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
import { asContract } from './contractShape';
import { runGenerateEnv } from './generateEnv';
import { underInterrupt } from './interrupt';
import { printFailure } from './output';

// Under the run's interrupt (§10.4): SIGINT / SIGTERM end the login; the
// work directory — it holds the secret — is removed on any exit.
underInterrupt('generate-env', ({ signal, workDir }) =>
  runGenerateEnv(process.argv.slice(2), {
    workDir,
    signal,
    // No port override: this script has no `--redirect-port` flag, so the
    // callback port is the strategy's own choice. The login waits until the
    // user ends it: the run's signal, no bound of this script's own.
    authorization: (browser, loginSignal) =>
      browserCallbackStrategy(
        asContract<Parameters<typeof browserCallbackStrategy>[0]>({
          browser,
          signal: loginSignal,
        }),
      ),
  }),
)
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // auth-errors', the broker's or this CLI's words: never a foreign
    // value's message, never a stack (§10.9).
    printFailure(error);
    process.exit(1);
  });
