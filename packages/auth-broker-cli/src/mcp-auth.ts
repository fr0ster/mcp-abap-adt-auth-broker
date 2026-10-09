#!/usr/bin/env node

/**
 * mcp-auth - log in to a SAP BTP or ABAP destination and write it: its means
 * and the secret the login obtained.
 *
 * One command (D24): `mcp-auth [auth-code]` (UAA authorization code, or
 * `--credential` client credentials), `mcp-auth oidc`, `mcp-auth saml2-pure`
 * and `mcp-auth saml2-bearer` — 2.x's `mcp-sso`, with the same flags — all run
 * in this process. The command line is read by `subcommandArgs.ts`.
 *
 * Examples:
 *   mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa
 *   mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --credential
 *   mcp-auth --service-key ./x509-key.json --output ./mcp.env --type xsuaa --credential \
 *     --client-auth certificate --cert-path ./client.crt --key-path ./client.key
 *   mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
 *   mcp-auth saml2-bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { browserCallbackStrategy } from '@mcp-abap-adt/auth-providers';
import { asContract } from './contractShape';
import { underInterrupt } from './interrupt';
import type { McpSsoOptions } from './mcpSsoConfig';
import { createCliLogger, printFailure, toStderr } from './output';
import { type McpAuthOptions, mcpAuthBrowser, runMcpAuth } from './runMcpAuth';
import { runMcpSso } from './runMcpSso';
import {
  isUsageError,
  isVerbose,
  parseCommandLine,
  type SsoSubcommand,
  type Subcommand,
} from './subcommandArgs';

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

function showMainHelp(): void {
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
    '  --env <path>            Path to an existing .env file: its session is reused while valid',
  );
  console.log('');
  console.log('Optional Options:');
  console.log(
    '  --type <type>           Auth type: abap or xsuaa (default: abap)',
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
    "                            - auto/system: the platform's default browser; the URL is also shown if it fails",
  );
  console.log(
    '                            - none/headless: Show URL in console and wait for callback',
  );
  console.log(
    '                            - chrome/edge/firefox, per platform:',
  );
  console.log(
    '                                linux: google-chrome, microsoft-edge, firefox',
  );
  console.log(
    "                                darwin: 'Google Chrome', 'Microsoft Edge', Firefox",
  );
  console.log('                                win32: chrome, msedge, firefox');
  console.log(
    '                            - other platforms: none/headless only',
  );
  console.log(
    '  --browser-program <p>   The browser program to run, as given (linux: on PATH or a path;',
  );
  console.log(
    '                          darwin: an application name; win32: a program name or path); excludes --browser',
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
  console.log(
    '  --client-auth <how>     How the client authenticates to the authorization server:',
  );
  console.log(
    "                            - certificate: the key's x509 client, with --cert-path and --key-path",
  );
  console.log(
    '                            - secret: the client secret in a Basic header, with --basic-encoding',
  );
  console.log(
    '                          Not given: the client secret in the token request, as before.',
  );
  console.log(
    '  --basic-encoding <enc>  With --client-auth secret (required): raw (XSUAA) or form (UAA, Keycloak)',
  );
  console.log(
    '  --cert-path <path>      With --client-auth certificate (required): the client certificate PEM file',
  );
  console.log(
    '  --key-path <path>       With --client-auth certificate (required): its private key PEM file',
  );
  console.log(
    '  --verbose               Log lines from debug on (default: from info), on stderr',
  );
  console.log(
    "  --auth-debug            The providers' debug line names the request's secrets (implies --verbose)",
  );
  console.log('');
  console.log(
    'SAML (saml2-pure, saml2-bearer; see mcp-auth saml2-pure --help for all):',
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
    '  --acs-url <url>            The Recipient; a pasted login needs it (saml2-bearer: read from XSUAA metadata)',
  );
  console.log(
    '  --saml-metadata <path>     XSUAA SP metadata file; with --service-key <uaa.url>/saml/metadata is read',
  );
  console.log('  --assertion <base64>       A SAMLResponse obtained elsewhere');
  console.log('  --assertion-flow <flow>    browser|manual|assertion');
  console.log('');
  console.log('  version, --version, -v Show version number');
  console.log(
    '  help, --help, -h       Show this help message; mcp-auth <subcommand> --help for each',
  );
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
    '  # SAML2 pure (cookies); every assertion is validated: see mcp-auth saml2-pure --help',
  );
  console.log(
    '  mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp.pem --idp-entity-id https://idp/metadata --output ./saml.env --type abap',
  );
  console.log('');
  console.log('  # SAML2 bearer');
  console.log(
    '  mcp-auth saml2-bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa',
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
    '  # XSUAA reusing the session of an existing .env, refreshed or logged in again only when needed',
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
  console.log(
    '  # XSUAA x509 key: client_credentials with the client certificate',
  );
  console.log(
    '  mcp-auth --service-key ./x509-key.json --output ./mcp.env --type xsuaa --credential --client-auth certificate --cert-path ./client.crt --key-path ./client.key',
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
    '  - With --env, a valid stored token bound to these means is reused: no request is sent.',
  );
  console.log(
    '    An expired one is refreshed with the stored refresh token; if that fails, or there is',
  );
  console.log('    none, the login runs. To log in anew, run without --env.');
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
  console.log(
    '  - --client-auth is never inferred from the key: an x509 key without it is refused.',
  );
  console.log(
    '    With certificate, the .env names the PEM files by absolute path (SAP_UAA_CLIENT_CERT_PATH,',
  );
  console.log(
    '    SAP_UAA_CLIENT_KEY_PATH) beside SAP_UAA_CERT_URL — XSUAA_UAA_* with --type xsuaa — and',
  );
  console.log(
    '    holds no client secret; the certificate and key are never copied, by the .env or anywhere else.',
  );
}

const SSO_TITLES: Record<SsoSubcommand, string> = {
  oidc: 'an OIDC grant (or the UAA passcode grant)',
  'saml2-pure': 'SAML into session cookies',
  'saml2-bearer': 'a SAML assertion exchanged for an OAuth token',
};

function showSsoHelp(subcommand: SsoSubcommand): void {
  console.log(
    `mcp-auth ${subcommand} - log in through ${SSO_TITLES[subcommand]} and write the destination`,
  );
  console.log('');
  console.log('Usage:');
  console.log(
    `  mcp-auth ${subcommand}${subcommand === 'oidc' ? ' --flow <browser|device|password|token_exchange>' : ''} --output <path> [options]`,
  );
  console.log('');
  console.log('Required Options:');
  console.log('  --output <path>           Output file path');
  if (subcommand === 'oidc') {
    console.log(
      "  --flow <flow>             browser|device|password|token_exchange (or the --config file's flow)",
    );
  }
  console.log('');
  console.log('Common Options:');
  console.log('  --service-key <path>      Service key JSON (XSUAA/ABAP)');
  console.log('  --type <abap|xsuaa>       Output type (default: abap)');
  console.log('  --format <env|json>       Output format (default: env)');
  console.log(
    '  --env <path>              Optional existing env file: its session is reused while valid, refreshed when expired',
  );
  console.log(
    '  --destination <name>      Destination name (default: output file base)',
  );
  console.log(
    '  --service-url <url>       Service URL (ABAP: SAP URL, XSUAA: MCP URL)',
  );
  console.log(
    `  --config <path>           JSON config file; its protocol and flow must be mcp-auth ${subcommand}'s`,
  );
  console.log(
    '  --browser <browser>       Browser: auto|system|chrome|edge|firefox|none|headless (default: auto)',
  );
  console.log(
    '                            linux: auto/system the default; chrome google-chrome; edge microsoft-edge; firefox firefox',
  );
  console.log(
    "                            darwin: auto/system the default; chrome 'Google Chrome'; edge 'Microsoft Edge'; firefox Firefox",
  );
  console.log(
    '                            win32: auto/system the default; chrome chrome; edge msedge; firefox firefox',
  );
  console.log(
    '                            other platforms: none/headless only (the URL is shown on stderr)',
  );
  console.log(
    '  --browser-program <p>     The browser program to run, as given (linux: on PATH or a path;',
  );
  console.log(
    '                            darwin: an application name; win32: a program name or path); excludes --browser',
  );
  console.log(
    '  --redirect-port <port>    Redirect port for browser flows (default: from auth-providers, currently 61001)',
  );
  console.log(
    '  --redirect-uri <uri>      Custom redirect URI (OOB/manual code flows)',
  );
  console.log(
    '  --verbose                 Log lines from debug on (default: from info), on stderr',
  );
  console.log(
    "  --auth-debug              The providers' debug line names the request's secrets (implies --verbose)",
  );
  console.log('');
  console.log('OIDC Options:');
  console.log('  --issuer <url>            OIDC issuer/discovery URL');
  console.log('  --authorization-endpoint <url>  Authorization endpoint');
  console.log('  --token-endpoint <url>    Token endpoint');
  console.log('  --device-authorization-endpoint <url>  Device auth endpoint');
  console.log('  --client-id <id>          OAuth client id');
  console.log('  --client-secret <secret>  OAuth client secret');
  console.log(
    '  --scopes <csv>            Scopes list (comma or space-separated)',
  );
  console.log('  --scope <value>           Scope for token exchange');
  console.log(
    '  --code <value>            An authorization code obtained elsewhere: no URL is built, so the',
  );
  console.log(
    '                            login carries no state or PKCE (the browser flow carries both)',
  );
  console.log('  --username <value>        Username for password flow');
  console.log('  --password <value>        Password for password flow');
  console.log(
    '  --passcode <value>        UAA one-time passcode: the passcode grant (needs --uaa-url or --service-key).',
  );
  console.log(
    '                            --flow password with neither --password nor --username asks for one',
  );
  console.log('  --subject-token <token>   Subject token for token exchange');
  console.log(
    '  --subject-token-type <type> Subject token type (default: access_token)',
  );
  console.log('  --audience <value>        Audience for token exchange');
  console.log('  --actor-token <token>     Actor token for token exchange');
  console.log(
    '  --actor-token-type <type> Actor token type for token exchange',
  );
  console.log(
    '  --uaa-url <url>           UAA base URL (used to build token endpoint)',
  );
  console.log('');
  console.log('SAML Options:');
  console.log('  --idp-sso-url <url>        IdP SSO URL');
  console.log(
    '  --sp-entity-id <id>        SP Entity ID; also the Audience the assertion must name',
  );
  console.log(
    '  --acs-url <url>            The ACS the IdP posts to; the Recipient the assertion must name.',
  );
  console.log(
    '                             A pasted login (--assertion-flow manual, --idp-initiated) needs it:',
  );
  console.log(
    '                             --acs-url, the XSUAA metadata (saml2-bearer), or acsUrl in --config',
  );
  console.log(
    '  --idp-cert <path>          IdP signing certificate file (PEM or DER); repeat for key rotation',
  );
  console.log(
    '  --idp-entity-id <id>       IdP entityID; the Issuer the assertion must name',
  );
  console.log(
    '  --idp-metadata <url|path>  IdP SAML metadata (https or file): fills --idp-cert, --idp-entity-id',
  );
  console.log(
    '                             and --idp-sso-url where not given, e.g. https://<ias>/saml2/metadata',
  );
  console.log(
    '  --idp-initiated            The IdP starts the login; no AuthnRequest is sent (required for bearer',
  );
  console.log(
    '                             against UAA/XSUAA). Use with --assertion or --assertion-flow manual',
  );
  console.log(
    '  --authn-request-id <id>    Refused since 2.0.0: a destination cannot state a request ID',
  );
  console.log(
    '  --saml-metadata <path>     XSUAA SP metadata; bearer reads it for the token alias, --acs-url and',
  );
  console.log(
    '                             --sp-entity-id. With --service-key, <uaa.url>/saml/metadata is read instead',
  );
  console.log('  --relay-state <value>      RelayState (optional)');
  console.log(
    '  --assertion-flow <flow>    browser|manual|assertion (default: browser; manual with --idp-initiated)',
  );
  console.log('  --assertion <base64>       SAMLResponse (base64)');
  console.log(
    '  --cookie <value>           Session cookies handed over (pure SAML): stored as they are, no login',
  );
  console.log(
    '  --token-endpoint <url>     Token endpoint for SAML bearer exchange',
  );
  console.log('');
  console.log(
    '  Every SAML assertion is validated before use. Both SAML flows require --idp-cert',
  );
  console.log(
    '  and --idp-entity-id, or --idp-metadata (or idpCertificates/idpEntityId in --config). An --assertion',
  );
  console.log(
    '  also needs --idp-initiated; the browser and manual flows send their own request',
  );
  console.log('  unless --idp-initiated is given.');
  console.log('');
  console.log('What is written (one .env file, two roles):');
  console.log(
    '  the means — SAP_AUTH_TYPE, SAP_GRANT_TYPE, the client (SAP_UAA_*), SAP_OIDC_* / SAP_SAML_*,',
  );
  console.log(
    '  SAP_URL — through the destination store; the secret — the token or cookies, SAP_EXPIRES_AT,',
  );
  console.log(
    '  the refresh token, SAP_ISSUED_FOR / SAP_ISSUED_BY — through the session store, as the broker',
  );
  console.log(
    '  stores what the login obtains (XSUAA_* keys with --type xsuaa). The output is written only once',
  );
  console.log('  the secret is stored; otherwise the command exits 1.');
  console.log('');
  console.log('  version, --version, -v     Show version number');
  console.log('  help, --help, -h           Show this help message');
}

function showHelp(subcommand: Subcommand | undefined): void {
  if (subcommand === undefined || subcommand === 'auth-code') {
    showMainHelp();
  } else {
    showSsoHelp(subcommand);
  }
}

/**
 * `mcp-auth [auth-code]`: the authorization code or client credentials login,
 * under the run's interrupt (§10.4): `SIGINT` / `SIGTERM` end it.
 */
function runAuthCode(options: McpAuthOptions): Promise<number> {
  // The work directory is removed on any exit, error and signal included:
  // it holds the secret.
  return underInterrupt('mcp-auth', ({ signal, workDir }) =>
    runMcpAuth(options, {
      logger: createCliLogger({ verbose: isVerbose(options) }),
      workDir,
      signal,
      // Passing `options.redirectPort` as given, so an omitted
      // --redirect-port lets the strategy bind its own default rather than
      // this CLI pinning a number it doesn't own. The login waits until the
      // user ends it: the run's signal, no bound.
      authorization: (run, loginSignal) =>
        browserCallbackStrategy(
          asContract<Parameters<typeof browserCallbackStrategy>[0]>({
            browser: mcpAuthBrowser(run),
            port: run.redirectPort,
            signal: loginSignal,
          }),
        ),
    }),
  );
}

/** `mcp-auth oidc | saml2-pure | saml2-bearer`, in this process, under the run's interrupt. */
function runSso(options: McpSsoOptions): Promise<number> {
  return underInterrupt('mcp-auth', ({ signal, workDir }) =>
    runMcpSso(options, {
      logger: createCliLogger({ verbose: isVerbose(options) }),
      workDir,
      signal,
    }),
  );
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(process.argv.slice(2));
  } catch (error) {
    if (!isUsageError(error)) throw error;
    printFailure(error);
    toStderr('Run "mcp-auth --help" for usage information');
    return 1;
  }
  switch (parsed.kind) {
    case 'help':
      showHelp(parsed.subcommand);
      return 0;
    case 'version':
      console.log(getVersion());
      return 0;
    case 'auth-code':
      return runAuthCode(parsed.options);
    case 'sso':
      return runSso(parsed.options);
  }
}

main().then(
  // Exit explicitly to close any open handles (e.g., OAuth callback server)
  (code) => process.exit(code),
  (error: unknown) => {
    // In words auth-errors, the broker or this CLI rendered: never a
    // foreign value's message, never a stack (§10.9).
    printFailure(error);
    process.exit(1);
  },
);
