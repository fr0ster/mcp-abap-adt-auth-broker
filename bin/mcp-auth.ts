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

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Use require for CommonJS dist files with absolute path
const distPath = path.resolve(__dirname, '..', 'index.js');
const { AuthBroker } = require(distPath);

import {
  AuthorizationCodeProvider,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import {
  ABAP_AUTHORIZATION_VARS,
  ABAP_CONNECTION_VARS,
  AbapServiceKeyStore,
  AbapSessionStore,
  JsonFileHandler,
  XSUAA_AUTHORIZATION_VARS,
  XSUAA_CONNECTION_VARS,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { parseArgs, type McpAuthOptions } from '../src/cli/parseArgs';
import { bootstrapPublicClient } from '../src/cli/publicClientBootstrap';
import { renderPublicClientEnv } from '../src/cli/publicClientEnv';

function getVersion(): string {
  try {
    const candidates = [
      path.join(__dirname, 'package.json'),
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const packageJson = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        return packageJson.version || 'unknown';
      }
    }

    const localRequire = require('module').createRequire(__filename);
    const resolved = localRequire.resolve(
      '@mcp-abap-adt/auth-broker/package.json',
    );
    const packageJson = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return packageJson.version || 'unknown';
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
    '  --redirect-port <port>  Port for OAuth redirect URI (default: 3001). Must match XSUAA redirect-uris config.',
  );
  console.log('');
  console.log('  --version, -v          Show version number');
  console.log('  --help, -h             Show this help message');
  console.log('');
  console.log('Public-client mode (no service key — URL + client_id only):');
  console.log(
    '  --abap-url <url>        ABAP system URL (required for public-client)',
  );
  console.log(
    '  --uaa-url <url>         XSUAA tenant URL (required for public-client)',
  );
  console.log(
    '  --client-id <id>        Public OAuth client_id (required for public-client)',
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
  console.log('  # SAML2 pure (cookies)');
  console.log(
    '  mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --output ./saml.env --type abap',
  );
  console.log('');
  console.log('  # SAML2 bearer (in progress, requires --dev)');
  console.log(
    '  mcp-auth saml2-bearer --dev --service-key ./service-key.json --assertion <base64> --output ./sso.env --type xsuaa',
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
  console.log('  # Public-client (no service key)');
  console.log(
    '  mcp-auth --abap-url https://...abap.eu10.hana.ondemand.com \\',
  );
  console.log(
    '           --uaa-url  https://...authentication.eu10.hana.ondemand.com \\',
  );
  console.log(
    "           --client-id 'sb-xs-...!b1|xsuaa-abapcp-prod-eu10!b4584' \\",
  );
  console.log('           --output ./mcp.env');
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
    '  - --redirect-port: Port for OAuth redirect URI (default: 3001)',
  );
  console.log(
    '    * Must match redirect_uri configured in XSUAA/ABAP OAuth2 settings',
  );
  console.log('    * Common values: 3001 (default), 8080 (SAP examples)');
  console.log(
    '  - For XSUAA, serviceUrl (MCP URL) is optional - can be provided via --service-url or service key',
  );
  console.log(
    '  - For ABAP, serviceUrl (SAP URL) is required - can be provided via --service-url or service key',
  );
  console.log(
    '  - SAP_URL/XSUAA_MCP_URL is written to .env (from --service-url, service key, or placeholder)',
  );
}

function writeEnvFile(
  outputPath: string,
  authType: 'abap' | 'xsuaa',
  token: string,
  refreshToken?: string,
  serviceUrl?: string,
  uaaUrl?: string,
  uaaClientId?: string,
  uaaClientSecret?: string,
): void {
  const lines: string[] = [];

  if (authType === 'abap') {
    // ABAP format
    if (serviceUrl) {
      lines.push(`${ABAP_CONNECTION_VARS.SERVICE_URL}=${serviceUrl}`);
    }
    lines.push(`${ABAP_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${token}`);

    if (refreshToken) {
      lines.push(`${ABAP_AUTHORIZATION_VARS.REFRESH_TOKEN}=${refreshToken}`);
    }

    if (uaaUrl) {
      lines.push(`${ABAP_AUTHORIZATION_VARS.UAA_URL}=${uaaUrl}`);
    }

    if (uaaClientId) {
      lines.push(`${ABAP_AUTHORIZATION_VARS.UAA_CLIENT_ID}=${uaaClientId}`);
    }

    if (uaaClientSecret) {
      lines.push(
        `${ABAP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=${uaaClientSecret}`,
      );
    }
  } else {
    // XSUAA format
    if (serviceUrl) {
      lines.push(`XSUAA_MCP_URL=${serviceUrl}`);
    }
    lines.push(`${XSUAA_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${token}`);

    if (refreshToken) {
      lines.push(`${XSUAA_AUTHORIZATION_VARS.REFRESH_TOKEN}=${refreshToken}`);
    }

    if (uaaUrl) {
      lines.push(`${XSUAA_AUTHORIZATION_VARS.UAA_URL}=${uaaUrl}`);
    }

    if (uaaClientId) {
      lines.push(`${XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_ID}=${uaaClientId}`);
    }

    if (uaaClientSecret) {
      lines.push(
        `${XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=${uaaClientSecret}`,
      );
    }
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write to file
  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
}

function writeJsonFile(
  outputPath: string,
  token: string,
  refreshToken?: string,
  serviceUrl?: string,
  uaaUrl?: string,
  uaaClientId?: string,
  uaaClientSecret?: string,
): void {
  const outputData: Record<string, string> = {
    accessToken: token,
  };

  if (refreshToken) {
    outputData.refreshToken = refreshToken;
  }

  if (serviceUrl) {
    outputData.serviceUrl = serviceUrl;
  }

  if (uaaUrl) {
    outputData.uaaUrl = uaaUrl;
  }

  if (uaaClientId) {
    outputData.uaaClientId = uaaClientId;
  }

  if (uaaClientSecret) {
    outputData.uaaClientSecret = uaaClientSecret;
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write to file
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
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

  // Handle --version and --help first
  if (
    rawArgs.length === 0 ||
    rawArgs.includes('--help') ||
    rawArgs.includes('-h')
  ) {
    showHelp();
    process.exit(0);
  }

  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
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

  let options: McpAuthOptions;
  try {
    options = parseArgs(hasSubcommand ? rawArgs.slice(1) : rawArgs);
  } catch (e: any) {
    console.error('Error:', e.message);
    console.error('Run "mcp-auth --help" for usage information');
    process.exit(1);
  }

  if (options.mode === 'public-client') {
    console.log(`📁 Output file: ${path.resolve(options.outputFile)}`);
    console.log(`🌐 ABAP URL: ${options.abapUrl}`);
    console.log(`🛡  UAA URL: ${options.uaaUrl}`);
    console.log(`🆔 Client ID: ${options.clientId}`);
    console.log(`🔑 Flow: authorization_code + PKCE (public client)`);

    const tokens = await bootstrapPublicClient({
      uaaUrl: options.uaaUrl!,
      clientId: options.clientId!,
      redirectPort: options.redirectPort,
      browser: options.browser,
    });

    const envContent = renderPublicClientEnv({
      abapUrl: options.abapUrl!,
      uaaUrl: options.uaaUrl!,
      clientId: options.clientId!,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });

    const outputPath = path.resolve(options.outputFile);
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, envContent, 'utf8');

    console.log(`✅ .env file created: ${outputPath}`);
    console.log(`   - BTP_ABAP_URL=${options.abapUrl}`);
    console.log(`   - BTP_UAA_URL=${options.uaaUrl}`);
    console.log(`   - BTP_UAA_CLIENT_ID=${options.clientId}`);
    console.log(`   - BTP_UAA_CLIENT_SECRET= (empty — public client)`);
    console.log(`   - BTP_JWT_TOKEN=${tokens.accessToken.substring(0, 50)}...`);
    if (tokens.refreshToken) {
      console.log(
        `   - BTP_REFRESH_TOKEN=${tokens.refreshToken.substring(0, 50)}...`,
      );
    } else {
      console.log(`   - (no BTP_REFRESH_TOKEN — XSUAA did not issue one)`);
    }
    process.exit(0);
  }

  // Resolve paths
  const resolvedOutputPath = path.resolve(options.outputFile);
  const resolvedEnvPath = options.envFilePath
    ? path.resolve(options.envFilePath)
    : undefined;

  // If service key is provided, use it; optionally read session from env
  let serviceKeyStore: any = null;
  let destination: string | undefined;
  const envExists = resolvedEnvPath ? fs.existsSync(resolvedEnvPath) : false;

  if (resolvedEnvPath) {
    destination = path.basename(resolvedEnvPath, path.extname(resolvedEnvPath));
  }

  // Store raw service key JSON for fallback parsing
  let rawServiceKeyJson: any = null;

  if (options.serviceKeyPath) {
    const resolvedServiceKeyPath = path.resolve(options.serviceKeyPath);
    let serviceKeyDir = path.dirname(resolvedServiceKeyPath);

    // Check if service key file exists
    if (!fs.existsSync(resolvedServiceKeyPath)) {
      console.error(`❌ Service key file not found: ${resolvedServiceKeyPath}`);
      process.exit(1);
    }

    const serviceKeyFileName = path.basename(resolvedServiceKeyPath, '.json');
    if (destination && destination !== serviceKeyFileName) {
      console.error(
        `❌ Destination mismatch: env file (${destination}) vs service key (${serviceKeyFileName})`,
      );
      process.exit(1);
    }
    destination = serviceKeyFileName;

    // Determine which store to use based on service key content
    // ABAP format has nested "uaa" object, XSUAA format has flat structure
    let isAbapFormat = options.authType === 'abap'; // default fallback
    try {
      // Use JsonFileHandler to ensure consistent parsing behavior
      const json = await JsonFileHandler.load(
        path.basename(resolvedServiceKeyPath),
        serviceKeyDir,
      );

      let effectiveJson: Record<string, unknown> | null = json as Record<
        string,
        unknown
      >;
      if (json && (json as Record<string, unknown>).credentials) {
        console.log(
          '🔍 Detected "credentials" wrapper -> unwrapping to temp file',
        );
        effectiveJson = (json as Record<string, unknown>).credentials as Record<
          string,
          unknown
        >;

        // Create temp file with unwrapped content to make it compatible with standard stores
        const tempDir = path.join(path.dirname(resolvedOutputPath), '.tmp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tempKeyPath = path.join(tempDir, `${destination}.json`);
        fs.writeFileSync(tempKeyPath, JSON.stringify(effectiveJson, null, 2));

        // Point store to temp directory so it reads the unwrapped file
        serviceKeyDir = tempDir;
      }

      // Store raw JSON for fallback parsing
      rawServiceKeyJson = effectiveJson;

      if (effectiveJson) {
        // If it has uaa property (even if null/string/object), XSUAA parser rejects it.
        // So we must use ABAP store which expects uaa object.
        if (effectiveJson.uaa) {
          isAbapFormat = true;
        } else {
          isAbapFormat = false;
        }
      }
    } catch (e: any) {
      // If parsing fails here, let the store handle the error
    }

    // Create appropriate stores based on detected format
    serviceKeyStore = isAbapFormat
      ? new AbapServiceKeyStore(serviceKeyDir)
      : new XsuaaServiceKeyStore(serviceKeyDir);

    // Patch serviceKeyStore for XSUAA to ensure serviceUrl is present (AuthBroker requirement)
    // even if not in the file. XSUAA doesn't strictly need it, but AuthBroker enforces it.
    if (options.authType === 'xsuaa') {
      const originalGetConnectionConfig =
        serviceKeyStore.getConnectionConfig.bind(serviceKeyStore);
      serviceKeyStore.getConnectionConfig = async (dest: string) => {
        const config = await originalGetConnectionConfig(dest);
        if (config && !config.serviceUrl) {
          config.serviceUrl = '<SERVICE_URL>';
        }
        return config;
      };
    }
  }

  if (!destination) {
    console.error('❌ Destination could not be determined from inputs');
    process.exit(1);
  }

  console.log(`📁 Output file: ${resolvedOutputPath}`);
  if (resolvedEnvPath) {
    console.log(
      `📁 Env file: ${resolvedEnvPath} (${envExists ? 'found' : 'not found'})`,
    );
  }
  if (options.serviceKeyPath) {
    console.log(`📁 Service key: ${path.resolve(options.serviceKeyPath)}`);
  }
  console.log(`🔐 Auth type: ${options.authType}`);
  console.log(
    `🔑 Flow: ${options.credential ? 'client_credentials' : 'authorization_code'}`,
  );
  if (!options.credential) {
    console.log(`🌐 Browser: ${options.browser}`);
  }
  console.log(`📄 Format: ${options.format}`);
  if (options.serviceUrl) {
    console.log(`🔗 Service URL: ${options.serviceUrl}`);
  }

  try {
    if (!envExists && !serviceKeyStore) {
      throw new Error('Env file not found and no service key provided.');
    }

    // Create temporary session store (work off a temp copy of env file)
    const tempSessionDir = path.join(path.dirname(resolvedOutputPath), '.tmp');
    if (!fs.existsSync(tempSessionDir)) {
      fs.mkdirSync(tempSessionDir, { recursive: true });
    }
    if (envExists && resolvedEnvPath) {
      const tempEnvPath = path.join(tempSessionDir, `${destination}.env`);
      fs.copyFileSync(resolvedEnvPath, tempEnvPath);
    }

    // Resolve serviceUrl from service key if not provided explicitly
    let actualServiceUrl = options.serviceUrl;
    if (!actualServiceUrl && serviceKeyStore) {
      try {
        const serviceKeyConn =
          await serviceKeyStore.getConnectionConfig(destination);
        actualServiceUrl = serviceKeyConn?.serviceUrl;
      } catch {
        // For XSUAA, serviceUrl is optional and may not exist in service key
        // This is expected - continue without serviceUrl
      }
    }

    // For XSUAA, serviceUrl is optional - use placeholder only for AuthBroker internal work
    const brokerServiceUrl = actualServiceUrl || '<SERVICE_URL>';

    const sessionStore =
      options.authType === 'xsuaa'
        ? new XsuaaSessionStore(tempSessionDir, brokerServiceUrl)
        : new AbapSessionStore(tempSessionDir);

    const sessionAuthConfig =
      await sessionStore.getAuthorizationConfig(destination);
    let serviceKeyAuthConfig = null;
    if (serviceKeyStore?.getAuthorizationConfig) {
      try {
        serviceKeyAuthConfig =
          await serviceKeyStore.getAuthorizationConfig(destination);
      } catch (e: any) {
        // Service key parsing might fail - try fallback parsing from raw JSON
        console.log(
          `ℹ️  Store could not parse service key, using fallback parsing`,
        );
      }
    }

    // Fallback: if stores failed, try to construct authConfig from raw service key JSON
    let fallbackAuthConfig = null;
    if (!sessionAuthConfig && !serviceKeyAuthConfig && rawServiceKeyJson) {
      // XSUAA format: clientid, clientsecret, url at top level
      // ABAP format: uaa.clientid, uaa.clientsecret, uaa.url
      const uaa = rawServiceKeyJson.uaa || rawServiceKeyJson;
      if (uaa.clientid && uaa.clientsecret && uaa.url) {
        fallbackAuthConfig = {
          uaaUrl: uaa.url,
          uaaClientId: uaa.clientid,
          uaaClientSecret: uaa.clientsecret,
        };
        console.log(`✅ Constructed auth config from raw service key`);
      }
    }

    const authConfig =
      sessionAuthConfig || serviceKeyAuthConfig || fallbackAuthConfig;
    if (!authConfig) {
      throw new Error(
        `Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields.`,
      );
    }

    // Default: authorization_code flow with browser
    // --credential: client_credentials flow (no browser needed)
    const redirectPort = options.redirectPort || 3001;

    // Log authorization URL for debugging
    if (!options.credential) {
      const redirectUri = `http://localhost:${redirectPort}/callback`;
      const authorizationUrl = `${authConfig.uaaUrl}/oauth/authorize?client_id=${encodeURIComponent(authConfig.uaaClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
      console.log(`🔗 Authorization URL: ${authorizationUrl}`);
      console.log(`📍 Redirect URI: ${redirectUri}`);
    }

    const tokenProvider = options.credential
      ? new ClientCredentialsProvider({
          uaaUrl: authConfig.uaaUrl,
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
        })
      : new AuthorizationCodeProvider({
          uaaUrl: authConfig.uaaUrl,
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
          refreshToken: authConfig.refreshToken,
          browser: options.browser,
          redirectPort: redirectPort,
        });

    const broker = new AuthBroker(
      {
        sessionStore,
        serviceKeyStore: serviceKeyStore || undefined,
        tokenProvider,
      },
      options.browser,
    );

    console.log(`🔐 Getting token for destination "${destination}"...`);
    const token = await broker.getToken(destination);
    console.log(`✅ Token obtained successfully`);

    const connConfig = await sessionStore.getConnectionConfig(destination);

    if (!token) {
      throw new Error(
        `Token provider did not return authorization token for destination "${destination}"`,
      );
    }

    const outputServiceUrl =
      options.serviceUrl || connConfig?.serviceUrl || actualServiceUrl;

    // Filter out placeholder service URL
    const finalServiceUrl =
      outputServiceUrl === '<SERVICE_URL>' ? undefined : outputServiceUrl;

    // Write output file based on format
    if (options.format === 'env') {
      writeEnvFile(
        resolvedOutputPath,
        options.authType,
        token,
        authConfig?.refreshToken,
        finalServiceUrl,
        authConfig?.uaaUrl,
        authConfig?.uaaClientId,
        authConfig?.uaaClientSecret,
      );

      console.log(`✅ .env file created: ${resolvedOutputPath}`);

      // Show what was written
      console.log(`📋 .env file contains:`);
      if (options.authType === 'abap') {
        if (finalServiceUrl) {
          console.log(
            `   - ${ABAP_CONNECTION_VARS.SERVICE_URL}=${finalServiceUrl}`,
          );
        }
        console.log(
          `   - ${ABAP_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${token.substring(0, 50)}...`,
        );
        if (authConfig?.refreshToken) {
          console.log(
            `   - ${ABAP_AUTHORIZATION_VARS.REFRESH_TOKEN}=${authConfig.refreshToken.substring(0, 50)}...`,
          );
        }
      } else {
        if (finalServiceUrl) {
          console.log(`   - XSUAA_MCP_URL=${finalServiceUrl}`);
        }
        console.log(
          `   - ${XSUAA_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${token.substring(0, 50)}...`,
        );
        if (authConfig?.refreshToken) {
          console.log(
            `   - ${XSUAA_AUTHORIZATION_VARS.REFRESH_TOKEN}=${authConfig.refreshToken.substring(0, 50)}...`,
          );
        }
      }
    } else {
      writeJsonFile(
        resolvedOutputPath,
        token,
        authConfig?.refreshToken,
        finalServiceUrl,
        authConfig?.uaaUrl,
        authConfig?.uaaClientId,
        authConfig?.uaaClientSecret,
      );

      console.log(`✅ JSON file created: ${resolvedOutputPath}`);
      console.log(`📋 Output contains:`);
      console.log(`   - accessToken: ${token.substring(0, 50)}...`);
      if (authConfig?.refreshToken) {
        console.log(
          `   - refreshToken: ${authConfig.refreshToken.substring(0, 50)}...`,
        );
      }
      if (finalServiceUrl) {
        console.log(`   - serviceUrl: ${finalServiceUrl}`);
      }
    }

    // Cleanup temp directory
    try {
      fs.rmSync(tempSessionDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Exit explicitly to close any open handles (e.g., OAuth callback server)
    process.exit(0);
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
