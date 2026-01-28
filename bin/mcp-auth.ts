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

import * as path from 'path';
import * as fs from 'fs';
// Use require for CommonJS dist files with absolute path
const distPath = path.resolve(__dirname, '..', 'index.js');
const { AuthBroker } = require(distPath);
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
  JsonFileHandler,
} from '@mcp-abap-adt/auth-stores';
import {
  AuthorizationCodeProvider,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import {
  ABAP_CONNECTION_VARS,
  ABAP_AUTHORIZATION_VARS,
  XSUAA_CONNECTION_VARS,
  XSUAA_AUTHORIZATION_VARS,
} from '@mcp-abap-adt/auth-stores';

interface McpAuthOptions {
  serviceKeyPath?: string; // Optional if env file is provided
  envFilePath?: string;
  outputFile: string;
  authType: 'abap' | 'xsuaa';
  browser: string; // Browser for authorization_code flow (default: 'auto')
  credential: boolean; // Use client_credentials instead of authorization_code
  format: 'json' | 'env';
  serviceUrl?: string;
  redirectPort?: number; // Port for OAuth redirect URI (default: 3001)
}

function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function showHelp(): void {
  console.log('MCP Auth - Get tokens and generate .env files from service keys');
  console.log('');
  console.log('Usage:');
  console.log('  mcp-auth --service-key <path> --output <path> [options]');
  console.log('');
  console.log('Required Options:');
  console.log('  --output <path>         Output file path');
  console.log('');
  console.log('Service Key or Env (one required):');
  console.log('  --service-key <path>    Path to service key JSON file');
  console.log('  --env <path>            Path to existing .env file (used for refresh token)');
  console.log('');
  console.log('Optional Options:');
  console.log('  --type <type>           Auth type: abap or xsuaa (default: abap)');
  console.log('  --credential            Use client_credentials flow (clientId/clientSecret, no browser)');
  console.log('                          By default uses authorization_code flow');
  console.log('  --browser <browser>     Browser for authorization_code flow (default: auto):');
  console.log('                            - auto: Try to open browser, fallback to showing URL (like cf login)');
  console.log('                            - none/headless: Show URL in console and wait for callback');
  console.log('                            - system/chrome/edge/firefox: Open specific browser');
  console.log('  --format <format>       Output format: json or env (default: env)');
  console.log('  --service-url <url>     Service URL (SAP URL for ABAP, MCP URL for XSUAA). For XSUAA, optional.');
  console.log('  --redirect-port <port>  Port for OAuth redirect URI (default: 3001). Must match XSUAA redirect-uris config.');
  console.log('');
  console.log('  --version, -v          Show version number');
  console.log('  --help, -h             Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  # XSUAA with authorization_code (default, opens browser)');
  console.log('  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa');
  console.log('');
  console.log('  # XSUAA with authorization_code (show URL in console, no browser)');
  console.log('  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --browser none');
  console.log('');
  console.log('  # XSUAA using existing .env refresh token, fallback to service key');
  console.log('  mcp-auth --env ./mcp.env --service-key ./service-key.json --output ./mcp.env --type xsuaa');
  console.log('');
  console.log('  # XSUAA with client_credentials (special cases)');
  console.log('  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --credential');
  console.log('');
  console.log('  # XSUAA with custom redirect port');
  console.log('  mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa --redirect-port 8080');
  console.log('');
  console.log('  # ABAP with authorization_code (default)');
  console.log('  mcp-auth --service-key ./abap-key.json --output ./abap.env --type abap');
  console.log('');
  console.log('  # ABAP with client_credentials (special cases)');
  console.log('  mcp-auth --service-key ./abap-key.json --output ./abap.env --type abap --credential');
  console.log('');
  console.log('Notes:');
  console.log('  - --type determines the provider (xsuaa or abap)');
  console.log('  - If --env is provided and file exists, refresh token is attempted first');
  console.log('  - If refresh fails or env file is missing, service key auth is used');
  console.log('  - Authentication flow:');
  console.log('    * Default: authorization_code (browser-based OAuth2)');
  console.log('    * --credential: client_credentials (clientId/clientSecret, no browser)');
  console.log('  - Browser options for authorization_code:');
  console.log('    * auto (default): Try to open browser, fallback to showing URL');
  console.log('    * none/headless: Show URL in console and wait for callback');
  console.log('    * system/chrome/edge/firefox: Open specific browser');
  console.log('  - Both providers (xsuaa and abap) support both flows');
  console.log('  - --redirect-port: Port for OAuth redirect URI (default: 3001)');
  console.log('    * Must match redirect_uri configured in XSUAA/ABAP OAuth2 settings');
  console.log('    * Common values: 3001 (default), 8080 (SAP examples)');
  console.log('  - For XSUAA, serviceUrl (MCP URL) is optional - can be provided via --service-url or service key');
  console.log('  - For ABAP, serviceUrl (SAP URL) is required - can be provided via --service-url or service key');
  console.log('  - SAP_URL/XSUAA_MCP_URL is written to .env (from --service-url, service key, or placeholder)');
}

function parseArgs(): McpAuthOptions | null {
  const args = process.argv.slice(2);
  
  // Handle --version and --help first
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  
  if (args.includes('--version') || args.includes('-v')) {
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
      if (!['none', 'chrome', 'edge', 'firefox', 'system', 'headless', 'auto'].includes(browser)) {
        console.error(`Invalid browser: ${browser}. Must be one of: none, chrome, edge, firefox, system, headless, auto`);
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
        console.error(`Invalid redirect port: ${args[i + 1]}. Must be a number between 1 and 65535`);
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
    console.error('Usage: mcp-auth --output <path> [--service-key <path> | --env <path>] [options]');
    console.error('Run "mcp-auth --help" for more information');
    process.exit(1);
  }
  
  // Either service-key or env must be provided
  if (!serviceKeyPath && !envFilePath) {
    console.error('Error: Either --service-key or --env must be provided');
    console.error('');
    console.error('Usage: mcp-auth --output <path> [--service-key <path> | --env <path>] [options]');
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
      lines.push(`${ABAP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=${uaaClientSecret}`);
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
      lines.push(`${XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=${uaaClientSecret}`);
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

async function main() {
  const options = parseArgs();
  
  if (!options) {
    // Help or version was shown, exit already handled
    return;
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
      const json = await JsonFileHandler.load(path.basename(resolvedServiceKeyPath), serviceKeyDir);

      let effectiveJson = json;
      if (json && json.credentials) {
        console.log('🔍 Detected "credentials" wrapper -> unwrapping to temp file');
        effectiveJson = json.credentials;

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
      const originalGetConnectionConfig = serviceKeyStore.getConnectionConfig.bind(serviceKeyStore);
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
    console.log(`📁 Env file: ${resolvedEnvPath} (${envExists ? 'found' : 'not found'})`);
  }
  if (options.serviceKeyPath) {
    console.log(`📁 Service key: ${path.resolve(options.serviceKeyPath)}`);
  }
  console.log(`🔐 Auth type: ${options.authType}`);
  console.log(`🔑 Flow: ${options.credential ? 'client_credentials' : 'authorization_code'}`);
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
        const serviceKeyConn = await serviceKeyStore.getConnectionConfig(
          destination,
        );
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
        serviceKeyAuthConfig = await serviceKeyStore.getAuthorizationConfig(destination);
      } catch (e: any) {
        // Service key parsing might fail - try fallback parsing from raw JSON
        console.log(`ℹ️  Store could not parse service key, using fallback parsing`);
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

    const authConfig = sessionAuthConfig || serviceKeyAuthConfig || fallbackAuthConfig;
    if (!authConfig) {
      throw new Error(`Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields.`);
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
    const finalServiceUrl = outputServiceUrl === '<SERVICE_URL>' ? undefined : outputServiceUrl;

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
          console.log(`   - ${ABAP_CONNECTION_VARS.SERVICE_URL}=${finalServiceUrl}`);
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
