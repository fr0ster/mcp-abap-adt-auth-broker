#!/usr/bin/env node

/**
 * MCP SSO - Get tokens via SSO providers and generate .env files
 *
 * Usage:
 *   mcp-sso <oidc|saml2|bearer> [options]
 *   mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [options]
 *
 * Examples:
 *   # OIDC browser flow (authorization code with local callback)
 *   mcp-sso oidc --flow browser --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
 *
 *   # OIDC device flow
 *   mcp-sso oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
 *
 *   # OIDC password flow
 *   mcp-sso oidc --flow password --token-endpoint https://issuer/oauth/token --client-id my-client --username user --password pass --output ./sso.env --type xsuaa
 *
 *   # OIDC token exchange
 *   mcp-sso oidc --flow token_exchange --issuer https://issuer --client-id my-client --subject-token <token> --output ./sso.env --type xsuaa
 *
 *   # SAML bearer flow with a service key: the Audience, Recipient and token alias come from
 *   # <uaa.url>/saml/metadata, the IdP's trust from its metadata
 *   mcp-sso bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa
 *
 *   # SAML bearer flow, everything stated (IdP-initiated assertion, as UAA/XSUAA require)
 *   mcp-sso bearer --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> --idp-cert ./idp-signing.pem --idp-entity-id https://idp/metadata --idp-initiated --token-endpoint https://uaa.example/oauth/token --assertion <base64> --output ./sso.env --type xsuaa
 *
 *   # SAML pure flow (cookie)
 *   mcp-sso saml2 --flow pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp-signing.pem --idp-entity-id https://idp/metadata --cookie "SAP_SESSION=..." --output ./sso.env --type abap
 */

import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { DefaultLogger, getLogLevel } from '@mcp-abap-adt/logger';
import * as fs from 'fs';
import * as path from 'path';
import { type McpSsoOptions, parseSamlTrustArg } from './mcpSsoConfig';
import { runMcpSso } from './runMcpSso';
import { createWorkDir } from './workDir';

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
  console.log('MCP SSO - Get tokens via SSO providers and generate .env files');
  console.log('');
  console.log('Usage:');
  console.log('  mcp-sso <oidc|saml2|bearer> [options]');
  console.log(
    '  mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [options]',
  );
  console.log('');
  console.log('Required Options:');
  console.log('  --output <path>           Output file path');
  console.log('  --protocol <oidc|saml2>   Protocol (if no subcommand)');
  console.log(
    '  --flow <flow>             Flow for protocol (if no subcommand)',
  );
  console.log('');
  console.log('Common Options:');
  console.log('  --service-key <path>      Service key JSON (XSUAA/ABAP)');
  console.log('  --type <abap|xsuaa>       Output type (default: abap)');
  console.log('  --format <env|json>       Output format (default: env)');
  console.log(
    '  --env <path>              Optional existing env file (used for refresh)',
  );
  console.log(
    '  --destination <name>      Destination name (default: output file base)',
  );
  console.log(
    '  --service-url <url>       Service URL (ABAP: SAP URL, XSUAA: MCP URL)',
  );
  console.log(
    '  --config <path>           JSON config file (SSO provider config)',
  );
  console.log(
    '  --browser <browser>       Browser: auto|none|system|chrome|edge|firefox',
  );
  console.log(
    '  --redirect-port <port>    Redirect port for browser flows (default: from auth-providers, currently 61001)',
  );
  console.log(
    '  --redirect-uri <uri>      Custom redirect URI (OOB/manual code flows)',
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
  console.log('  --code <value>            Authorization code (manual)');
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
    '  --acs-url <url>            ACS URL; the Recipient the assertion must name (default: http://localhost:<port>/callback)',
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

function parseScopes(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function createCliLogger(prefix: string = 'SSO'): ILogger {
  const isEnabled = (): boolean => {
    if (
      process.env.DEBUG_SSO === 'false' ||
      process.env.DEBUG_AUTH_SSO === 'false'
    ) {
      return false;
    }
    if (
      process.env.DEBUG_SSO === 'true' ||
      process.env.DEBUG_AUTH_SSO === 'true' ||
      process.env.DEBUG === 'true' ||
      process.env.DEBUG?.includes('sso') === true ||
      process.env.DEBUG?.includes('auth-sso') === true
    ) {
      return true;
    }
    return false;
  };

  const baseLogger = new DefaultLogger(getLogLevel());
  return {
    debug: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.debug(`[${prefix}] ${message}`, meta);
      }
    },
    info: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.info(`[${prefix}] ${message}`, meta);
      }
    },
    warn: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.warn(`[${prefix}] ${message}`, meta);
      }
    },
    error: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.error(`[${prefix}] ${message}`, meta);
      }
    },
  };
}

function parseArgs(): McpSsoOptions | null {
  let args = process.argv.slice(2);

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

  let outputFile: string | undefined;
  let envFilePath: string | undefined;
  let destination: string | undefined;
  let serviceKeyPath: string | undefined;
  let authType: 'abap' | 'xsuaa' = 'abap';
  let format: 'env' | 'json' = 'env';
  let protocol: 'oidc' | 'saml2' | undefined;
  let flow: McpSsoOptions['flow'];
  let configPath: string | undefined;
  let serviceUrl: string | undefined;
  let browser: string | undefined;
  let redirectPort: number | undefined;
  let redirectUri: string | undefined;
  let issuerUrl: string | undefined;
  let authorizationEndpoint: string | undefined;
  let tokenEndpoint: string | undefined;
  let deviceAuthorizationEndpoint: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scopes: string[] | undefined;
  let scope: string | undefined;
  let code: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let passcode: string | undefined;
  let subjectToken: string | undefined;
  let subjectTokenType: string | undefined;
  let audience: string | undefined;
  let actorToken: string | undefined;
  let actorTokenType: string | undefined;
  let idpSsoUrl: string | undefined;
  let spEntityId: string | undefined;
  let acsUrl: string | undefined;
  let relayState: string | undefined;
  let assertionFlow: 'browser' | 'manual' | 'assertion' | undefined;
  let assertion: string | undefined;
  let cookie: string | undefined;
  let uaaUrl: string | undefined;
  let samlMetadataPath: string | undefined;
  const samlTrust: Partial<McpSsoOptions> = {};

  const firstArg = args[0];
  if (firstArg && !firstArg.startsWith('-')) {
    if (firstArg === 'oidc') {
      protocol = 'oidc';
    } else if (firstArg === 'saml2') {
      protocol = 'saml2';
    } else if (firstArg === 'bearer') {
      protocol = 'saml2';
      flow = 'bearer';
    } else {
      console.error(`Unknown command: ${firstArg}`);
      showHelp();
      process.exit(1);
    }
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = i + 1 < args.length ? args[i + 1] : undefined;

    switch (arg) {
      case '--output':
        outputFile = next;
        i++;
        break;
      case '--env':
        envFilePath = next;
        i++;
        break;
      case '--service-key':
        serviceKeyPath = next;
        i++;
        break;
      case '--destination':
        destination = next;
        i++;
        break;
      case '--type':
        if (next === 'abap' || next === 'xsuaa') {
          authType = next;
        } else {
          console.error(`Invalid type: ${next}. Use abap or xsuaa.`);
          process.exit(1);
        }
        i++;
        break;
      case '--format':
        if (next === 'env' || next === 'json') {
          format = next;
        } else {
          console.error(`Invalid format: ${next}. Use env or json.`);
          process.exit(1);
        }
        i++;
        break;
      case '--protocol':
        if (next === 'oidc' || next === 'saml2') {
          protocol = next;
        } else {
          console.error(`Invalid protocol: ${next}. Use oidc or saml2.`);
          process.exit(1);
        }
        i++;
        break;
      case '--flow':
        flow = next as McpSsoOptions['flow'];
        i++;
        break;
      case '--config':
        configPath = next;
        i++;
        break;
      case '--service-url':
        serviceUrl = next;
        i++;
        break;
      case '--browser':
        browser = next;
        i++;
        break;
      case '--redirect-port':
        if (!next) break;
        redirectPort = parseInt(next, 10);
        if (
          Number.isNaN(redirectPort) ||
          redirectPort < 1 ||
          redirectPort > 65535
        ) {
          console.error(`Invalid redirect port: ${next}`);
          process.exit(1);
        }
        i++;
        break;
      case '--redirect-uri':
        redirectUri = next;
        i++;
        break;
      case '--issuer':
        issuerUrl = next;
        i++;
        break;
      case '--authorization-endpoint':
        authorizationEndpoint = next;
        i++;
        break;
      case '--token-endpoint':
        tokenEndpoint = next;
        i++;
        break;
      case '--device-authorization-endpoint':
        deviceAuthorizationEndpoint = next;
        i++;
        break;
      case '--client-id':
        clientId = next;
        i++;
        break;
      case '--client-secret':
        clientSecret = next;
        i++;
        break;
      case '--scopes':
        scopes = parseScopes(next);
        i++;
        break;
      case '--scope':
        scope = next;
        i++;
        break;
      case '--code':
        code = next;
        i++;
        break;
      case '--username':
        username = next;
        i++;
        break;
      case '--password':
        password = next;
        i++;
        break;
      case '--passcode':
        passcode = next;
        i++;
        break;
      case '--subject-token':
        subjectToken = next;
        i++;
        break;
      case '--subject-token-type':
        subjectTokenType = next;
        i++;
        break;
      case '--audience':
        audience = next;
        i++;
        break;
      case '--actor-token':
        actorToken = next;
        i++;
        break;
      case '--actor-token-type':
        actorTokenType = next;
        i++;
        break;
      case '--idp-sso-url':
        idpSsoUrl = next;
        i++;
        break;
      case '--sp-entity-id':
        spEntityId = next;
        i++;
        break;
      case '--acs-url':
        acsUrl = next;
        i++;
        break;
      case '--relay-state':
        relayState = next;
        i++;
        break;
      case '--assertion-flow':
        if (next === 'browser' || next === 'manual' || next === 'assertion') {
          assertionFlow = next;
        } else {
          console.error(
            `Invalid assertion flow: ${next}. Use browser, manual, or assertion.`,
          );
          process.exit(1);
        }
        i++;
        break;
      case '--assertion':
        assertion = next;
        i++;
        break;
      case '--cookie':
        cookie = next;
        i++;
        break;
      case '--uaa-url':
        uaaUrl = next;
        i++;
        break;
      case '--saml-metadata':
        samlMetadataPath = next;
        i++;
        break;
      default:
        i += parseSamlTrustArg(samlTrust, arg, next);
        break;
    }
  }

  return {
    outputFile,
    envFilePath,
    destination,
    serviceKeyPath,
    authType,
    format,
    protocol,
    flow: flow as McpSsoOptions['flow'],
    configPath,
    serviceUrl,
    browser,
    redirectPort,
    redirectUri,
    issuerUrl,
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint,
    clientId,
    clientSecret,
    scopes,
    scope,
    code,
    username,
    password,
    passcode,
    subjectToken,
    subjectTokenType,
    audience,
    actorToken,
    actorTokenType,
    idpSsoUrl,
    spEntityId,
    acsUrl,
    relayState,
    assertionFlow,
    assertion,
    cookie,
    uaaUrl,
    samlMetadataPath,
    ...samlTrust,
  };
}

async function main() {
  const options = parseArgs();
  if (!options) {
    return;
  }
  // Removed on any exit, error and signal included: it holds the secret.
  const workDir = createWorkDir('mcp-sso');
  const code = await runMcpSso(options, {
    logger: createCliLogger(),
    workDir,
  });
  process.exit(code);
}

main().catch((error) => {
  console.error(`❌ Error: ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
