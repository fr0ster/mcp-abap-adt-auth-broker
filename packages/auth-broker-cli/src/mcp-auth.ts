#!/usr/bin/env node

/**
 * MCP Auth - Get tokens and generate .env files from service keys
 *
 * Usage:
 *   mcp-auth --service-key <path> --output <path> [--env <path>] [--type abap|xsuaa] [--credential] [--browser auto|none|chrome|edge|firefox|system] [--format json|env]
 *
 * Examples:
 *   # Generate .env file with authorization_code (default)
 *   mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa
 *
 *   # With authorization_code, show URL in console (no browser)
 *   mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --browser none
 *
 *   # With client_credentials (special cases)
 *   mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --credential
 *
 *   # Generate .env file for ABAP
 *   mcp-auth --service-key ./abap-key.json --output ./abap.env --type abap
 */

import { browserCallbackStrategy } from '@mcp-abap-adt/auth-providers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { type McpAuthOptions, runMcpAuth } from './runMcpAuth';
import { createWorkDir } from './workDir';

/**
 * A person completes this login at a browser; the provider's own default
 * (30s) is sized for an unattended caller instead.
 */
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function getVersion(): string {
  // This package's own manifest: dist/<bin>.js and src/<bin>.ts both sit one
  // level below it. Never the library's — the CLI has its own version.
  try {
    const manifest = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function showHelp(): void {
  console.log(
    'MCP Auth - Get tokens and generate .env files from service keys',
  );
  console.log('');
  console.log('Usage:');
  console.log('  mcp-auth <auth-code|oidc|saml2-pure|saml2-bearer> [options]');
  console.log('  mcp-auth --service-key <path> --output <path> [options]');
  console.log('');
  console.log('Required Options:');
  console.log('  --output <path>         Output file path');
  console.log('');
  console.log('Service Key or Env (one required):');
  console.log('  --service-key <path>    Path to service key JSON file');
  console.log(
    '  --env <path>            Path to existing .env file (used for refresh token)',
  );
  console.log('');
  console.log('Optional Options:');
  console.log(
    '  --type <type>           Auth type: abap or xsuaa (default: abap)',
  );
  console.log(
    '  --dev                   Enable in-progress commands (saml2-bearer)',
  );
  console.log(
    '  --credential            Use client_credentials flow (clientId/clientSecret, no browser)',
  );
  console.log(
    '                          By default uses authorization_code flow',
  );
  console.log(
    '  --browser <browser>     Browser for authorization_code flow (default: auto):',
  );
  console.log(
    '                            - auto: Try to open browser, fallback to showing URL (like cf login)',
  );
  console.log(
    '                            - none/headless: Show URL in console and wait for callback',
  );
  console.log(
    '                            - system/chrome/edge/firefox: Open specific browser',
  );
  console.log(
    '  --format <format>       Output format: json or env (default: env)',
  );
  console.log(
    '  --service-url <url>     Service URL (SAP URL for ABAP, MCP URL for XSUAA). For XSUAA, optional.',
  );
  console.log(
    '  --redirect-port <port>  Port for OAuth redirect URI (default: from auth-providers, currently 61001).',
  );
  console.log(
    '                          Must match XSUAA redirect-uris config.',
  );
  console.log('');
  console.log(
    'SAML (saml2-pure, saml2-bearer; passed to mcp-sso, see mcp-sso --help for all):',
  );
  console.log(
    '  --idp-metadata <url|path>  IdP SAML metadata (https or file): certificate, entityID, SSO URL',
  );
  console.log(
    '                             e.g. https://<ias-tenant>.accounts.ondemand.com/saml2/metadata',
  );
  console.log(
    '  --idp-cert <path>          IdP signing certificate (PEM or DER); repeat for key rotation',
  );
  console.log(
    '  --idp-entity-id <id>       IdP entityID; the Issuer the assertion must name',
  );
  console.log(
    '  --idp-sso-url <url>        IdP SSO endpoint (read from --idp-metadata when not given)',
  );
  console.log(
    '  --idp-initiated            The IdP starts the login; required for saml2-bearer against XSUAA',
  );
  console.log(
    '  --authn-request-id <id>    AuthnRequest ID an --assertion answers, when sent elsewhere',
  );
  console.log(
    '  --sp-entity-id <id>        SP entityID, the Audience (saml2-bearer: read from XSUAA metadata)',
  );
  console.log(
    '  --acs-url <url>            The Recipient (saml2-bearer: read from XSUAA metadata)',
  );
  console.log(
    '  --saml-metadata <path>     XSUAA SP metadata file; with --service-key <uaa.url>/saml/metadata is read',
  );
  console.log('  --assertion <base64>       A SAMLResponse obtained elsewhere');
  console.log('  --assertion-flow <flow>    browser|manual|assertion');
  console.log('');
  console.log('  version, --version, -v Show version number');
  console.log('  help, --help, -h       Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  # Auth code (default flow via service key)');
  console.log(
    '  mcp-auth auth-code --service-key ./service-key.json --output ./mcp.env --type xsuaa',
  );
  console.log('');
  console.log('  # OIDC SSO (device/password/browser/token-exchange)');
  console.log(
    '  mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa',
  );
  console.log('');
  console.log(
    '  # SAML2 pure (cookies); every assertion is validated: see mcp-sso --help',
  );
  console.log(
    '  mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp.pem --idp-entity-id https://idp/metadata --output ./saml.env --type abap',
  );
  console.log('');
  console.log('  # SAML2 bearer (in progress, requires --dev)');
  console.log(
    '  mcp-auth saml2-bearer --dev --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa',
  );
  console.log('');
  console.log('  # XSUAA with authorization_code (default, opens browser)');
  console.log(
    '  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa',
  );
  console.log('');
  console.log(
    '  # XSUAA with authorization_code (show URL in console, no browser)',
  );
  console.log(
    '  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --browser none',
  );
  console.log('');
  console.log(
    '  # XSUAA using existing .env refresh token, fallback to service key',
  );
  console.log(
    '  mcp-auth --env ./mcp.env --service-key ./service-key.json --output ./mcp.env --type xsuaa',
  );
  console.log('');
  console.log('  # XSUAA with client_credentials (special cases)');
  console.log(
    '  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --credential',
  );
  console.log('');
  console.log('  # XSUAA with custom redirect port');
  console.log(
    '  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --redirect-port 8080',
  );
  console.log('');
  console.log('  # ABAP with authorization_code (default)');
  console.log(
    '  mcp-auth --service-key ./abap-key.json --output ./abap.env --type abap',
  );
  console.log('');
  console.log('  # ABAP with client_credentials (special cases)');
  console.log(
    '  mcp-auth --service-key ./abap-key.json --output ./abap.env --type abap --credential',
  );
  console.log('');
  console.log('Notes:');
  console.log('  - --type determines the provider (xsuaa or abap)');
  console.log(
    '  - If --env is provided and file exists, refresh token is attempted first',
  );
  console.log(
    '  - If refresh fails or env file is missing, service key auth is used',
  );
  console.log('  - Authentication flow:');
  console.log('    * Default: authorization_code (browser-based OAuth2)');
  console.log(
    '    * --credential: client_credentials (clientId/clientSecret, no browser)',
  );
  console.log('  - Browser options for authorization_code:');
  console.log(
    '    * auto (default): Try to open browser, fallback to showing URL',
  );
  console.log('    * none/headless: Show URL in console and wait for callback');
  console.log('    * system/chrome/edge/firefox: Open specific browser');
  console.log('  - Both providers (xsuaa and abap) support both flows');
  console.log(
    '  - --redirect-port: Port for OAuth redirect URI (default: from auth-providers, currently 61001)',
  );
  console.log(
    '    * Must match redirect_uri configured in XSUAA/ABAP OAuth2 settings',
  );
  console.log(
    '    * If your registered redirect URI uses a different port (e.g. 3001, 8080), pass it explicitly',
  );
  console.log(
    '  - For XSUAA, serviceUrl (MCP URL) is optional - can be provided via --service-url or service key',
  );
  console.log(
    '  - For ABAP, serviceUrl (SAP URL) is required - can be provided via --service-url or service key',
  );
  console.log(
    '  - SAP_URL/XSUAA_MCP_URL is written to .env when known (--service-url or the service key)',
  );
  console.log(
    '  - The .env file holds two roles: the means (SAP_AUTH_TYPE=jwt, SAP_GRANT_TYPE, SAP_UAA_*,',
  );
  console.log(
    '    SAP_URL) through the destination store, and the secret (SAP_JWT_TOKEN, SAP_EXPIRES_AT,',
  );
  console.log(
    '    SAP_REFRESH_TOKEN, SAP_ISSUED_FOR, SAP_ISSUED_BY) through the session store; XSUAA_* with',
  );
  console.log(
    '    --type xsuaa. It is written only once the secret is stored; otherwise the command exits 1.',
  );
}

function parseArgs(
  args: string[] = process.argv.slice(2),
): McpAuthOptions | null {
  // Handle --version and --help first
  if (
    args.length === 0 ||
    args[0] === 'help' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    showHelp();
    process.exit(0);
  }

  if (
    args[0] === 'version' ||
    args.includes('--version') ||
    args.includes('-v')
  ) {
    console.log(getVersion());
    process.exit(0);
  }

  let serviceKeyPath: string | undefined;
  let envFilePath: string | undefined;
  let outputFile: string | undefined;
  let authType: 'abap' | 'xsuaa' = 'abap';
  let browser: string = 'auto'; // Default to auto for authorization_code flow
  let credential: boolean = false; // Use client_credentials instead of authorization_code
  let format: 'json' | 'env' = 'env';
  let serviceUrl: string | undefined;
  let redirectPort: number | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service-key' && i + 1 < args.length) {
      serviceKeyPath = args[i + 1];
      i++;
    } else if (args[i] === '--env' && i + 1 < args.length) {
      envFilePath = args[i + 1];
      i++;
    } else if (args[i] === '--output' && i + 1 < args.length) {
      outputFile = args[i + 1];
      i++;
    } else if (args[i] === '--type' && i + 1 < args.length) {
      const type = args[i + 1];
      if (type === 'abap' || type === 'xsuaa') {
        authType = type;
      } else {
        console.error(`Invalid auth type: ${type}. Must be 'abap' or 'xsuaa'`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--browser' && i + 1 < args.length) {
      browser = args[i + 1];
      if (
        ![
          'none',
          'chrome',
          'edge',
          'firefox',
          'system',
          'headless',
          'auto',
        ].includes(browser)
      ) {
        console.error(
          `Invalid browser: ${browser}. Must be one of: none, chrome, edge, firefox, system, headless, auto`,
        );
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--format' && i + 1 < args.length) {
      const fmt = args[i + 1];
      if (fmt === 'json' || fmt === 'env') {
        format = fmt;
      } else {
        console.error(`Invalid format: ${fmt}. Must be 'json' or 'env'`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--service-url' && i + 1 < args.length) {
      serviceUrl = args[i + 1];
      i++;
    } else if (args[i] === '--redirect-port' && i + 1 < args.length) {
      const port = parseInt(args[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(
          `Invalid redirect port: ${args[i + 1]}. Must be a number between 1 and 65535`,
        );
        process.exit(1);
      }
      redirectPort = port;
      i++;
    } else if (args[i] === '--credential') {
      credential = true;
    } else {
      console.error(`Unknown option: ${args[i]}`);
      console.error('Run "mcp-auth --help" for usage information');
      process.exit(1);
    }
  }

  // Validate required arguments
  if (!outputFile) {
    console.error('Error: --output is required');
    console.error('');
    console.error(
      'Usage: mcp-auth --output <path> [--service-key <path> | --env <path>] [options]',
    );
    console.error('Run "mcp-auth --help" for more information');
    process.exit(1);
  }

  // Either service-key or env must be provided
  if (!serviceKeyPath && !envFilePath) {
    console.error('Error: Either --service-key or --env must be provided');
    console.error('');
    console.error(
      'Usage: mcp-auth --output <path> [--service-key <path> | --env <path>] [options]',
    );
    console.error('Run "mcp-auth --help" for more information');
    process.exit(1);
  }

  return {
    serviceKeyPath,
    envFilePath,
    outputFile,
    authType,
    browser,
    credential,
    format,
    serviceUrl,
    redirectPort,
  };
}

function runMcpSso(args: string[]): void {
  const mcpSsoPath = path.resolve(__dirname, 'mcp-sso.js');
  const result = spawnSync(process.execPath, [mcpSsoPath, ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // `help` and `version` as commands, like every CLI in the family; they answer
  // before any subcommand is dispatched.
  if (rawArgs[0] === 'help') {
    showHelp();
    process.exit(0);
  }
  if (rawArgs[0] === 'version') {
    console.log(getVersion());
    process.exit(0);
  }
  const subcommand = rawArgs[0];
  const hasSubcommand =
    subcommand && !subcommand.startsWith('-') && subcommand.length > 0;
  if (hasSubcommand) {
    const remaining = rawArgs.slice(1);
    const ensureNoProtocol = () => {
      if (remaining.includes('--protocol')) {
        console.error('❌ --protocol is not supported with subcommands.');
        process.exit(1);
      }
    };
    switch (subcommand) {
      case 'auth-code': {
        break;
      }
      case 'oidc': {
        ensureNoProtocol();
        runMcpSso(['oidc', ...remaining]);
        return;
      }
      case 'saml2-pure': {
        ensureNoProtocol();
        if (remaining.includes('--flow')) {
          const idx = remaining.indexOf('--flow');
          const flow = remaining[idx + 1];
          if (flow && flow !== 'pure') {
            console.error('❌ saml2-pure requires --flow pure.');
            process.exit(1);
          }
        } else {
          remaining.unshift('pure');
          remaining.unshift('--flow');
        }
        runMcpSso(['saml2', ...remaining]);
        return;
      }
      case 'saml2-bearer': {
        ensureNoProtocol();
        if (!remaining.includes('--dev')) {
          console.error(
            '⚠️  saml2-bearer is in progress. Re-run with --dev to enable.',
          );
          process.exit(1);
        }
        const filtered = remaining.filter((arg) => arg !== '--dev');
        if (filtered.includes('--flow')) {
          console.error('❌ saml2-bearer does not accept --flow.');
          process.exit(1);
        }
        runMcpSso(['bearer', ...filtered]);
        return;
      }
      default: {
        console.error(`Unknown command: ${subcommand}`);
        showHelp();
        process.exit(1);
      }
    }
  }

  const options = parseArgs(hasSubcommand ? rawArgs.slice(1) : rawArgs);

  if (!options) {
    // Help or version was shown, exit already handled
    return;
  }

  // Removed on any exit, error and signal included: it holds the secret.
  const workDir = createWorkDir('mcp-auth');
  try {
    const code = await runMcpAuth(options, {
      workDir,
      // Passing `options.redirectPort` as given, so an omitted
      // --redirect-port lets the strategy bind its own default rather than
      // this CLI pinning a number it doesn't own.
      authorization: (run) =>
        browserCallbackStrategy({
          browser: run.browser,
          port: run.redirectPort,
          timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
        }),
    });
    // Exit explicitly to close any open handles (e.g., OAuth callback server)
    process.exit(code);
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
