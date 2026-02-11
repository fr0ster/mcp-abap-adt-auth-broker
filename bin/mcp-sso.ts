#!/usr/bin/env node

/**
 * MCP SSO - Get tokens via SSO providers and generate .env files
 *
 * Usage:
 *   mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [options]
 *
 * Examples:
 *   # OIDC browser flow (authorization code with local callback)
 *   mcp-sso --protocol oidc --flow browser --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
 *
 *   # OIDC device flow
 *   mcp-sso --protocol oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
 *
 *   # OIDC password flow
 *   mcp-sso --protocol oidc --flow password --token-endpoint https://issuer/oauth/token --client-id my-client --username user --password pass --output ./sso.env --type xsuaa
 *
 *   # OIDC token exchange
 *   mcp-sso --protocol oidc --flow token_exchange --issuer https://issuer --client-id my-client --subject-token <token> --output ./sso.env --type xsuaa
 *
 *   # SAML bearer flow
 *   mcp-sso --protocol saml2 --flow bearer --idp-sso-url https://idp/sso --sp-entity-id my-sp --token-endpoint https://uaa.example/oauth/token --assertion <base64> --output ./sso.env --type xsuaa
 *
 *   # SAML pure flow (cookie)
 *   mcp-sso --protocol saml2 --flow pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --assertion <base64> --cookie "SAP_SESSION=..." --output ./sso.env --type abap
 */

import { createInterface } from 'node:readline';
import * as fs from 'fs';
import * as path from 'path';

// Use require for CommonJS dist files with absolute path
const distPath = path.resolve(__dirname, '..', 'index.js');
const { AuthBroker } = require(distPath);

import {
  SsoProviderFactory,
  type OidcBrowserProviderConfig,
  type OidcDeviceFlowProviderConfig,
  type OidcPasswordProviderConfig,
  type OidcTokenExchangeProviderConfig,
  type Saml2BearerProviderConfig,
  type Saml2PureProviderConfig,
  type SsoProviderConfig,
} from '@mcp-abap-adt/auth-providers';
import { AbapSessionStore, XsuaaSessionStore } from '@mcp-abap-adt/auth-stores';

interface McpSsoOptions {
  outputFile?: string;
  envFilePath?: string;
  destination?: string;
  authType: 'abap' | 'xsuaa';
  format: 'json' | 'env';
  protocol?: 'oidc' | 'saml2';
  flow?:
    | 'browser'
    | 'device'
    | 'password'
    | 'token_exchange'
    | 'bearer'
    | 'pure';
  configPath?: string;
  serviceUrl?: string;
  browser?: string;
  redirectPort?: number;
  redirectUri?: string;
  issuerUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  scope?: string;
  code?: string;
  username?: string;
  password?: string;
  passcode?: string;
  subjectToken?: string;
  subjectTokenType?: string;
  audience?: string;
  actorToken?: string;
  actorTokenType?: string;
  idpSsoUrl?: string;
  spEntityId?: string;
  acsUrl?: string;
  relayState?: string;
  assertionFlow?: 'browser' | 'manual' | 'assertion';
  assertion?: string;
  cookie?: string;
  uaaUrl?: string;
}

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
  console.log('MCP SSO - Get tokens via SSO providers and generate .env files');
  console.log('');
  console.log('Usage:');
  console.log(
    '  mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [options]',
  );
  console.log('');
  console.log('Required Options:');
  console.log('  --output <path>           Output file path');
  console.log('  --protocol <oidc|saml2>   Protocol');
  console.log('  --flow <flow>             Flow for protocol');
  console.log('');
  console.log('Common Options:');
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
    '  --redirect-port <port>    Redirect port for browser flows (default: 3001)',
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
    '  --passcode <value>        Passcode (alias for password, username=passcode)',
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
  console.log('  --sp-entity-id <id>        SP Entity ID');
  console.log(
    '  --acs-url <url>            ACS URL (default: http://localhost:<port>/callback)',
  );
  console.log('  --relay-state <value>      RelayState (optional)');
  console.log(
    '  --assertion-flow <flow>    browser|manual|assertion (default: browser)',
  );
  console.log('  --assertion <base64>       SAMLResponse (base64)');
  console.log('  --cookie <value>           Session cookies (for pure SAML)');
  console.log(
    '  --token-endpoint <url>     Token endpoint for SAML bearer exchange',
  );
  console.log('');
  console.log('  --version, -v              Show version number');
  console.log('  --help, -h                 Show this help message');
}

function parseScopes(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function readManualInput(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(): McpSsoOptions | null {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(getVersion());
    process.exit(0);
  }

  let outputFile: string | undefined;
  let envFilePath: string | undefined;
  let destination: string | undefined;
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
      default:
        break;
    }
  }

  return {
    outputFile,
    envFilePath,
    destination,
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
  };
}

function normalizeProviderConfig(raw: any): SsoProviderConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.provider) {
    return raw.provider as SsoProviderConfig;
  }
  if (raw.protocol && raw.flow) {
    const { protocol, flow, config, ...rest } = raw;
    return {
      protocol,
      flow,
      config: config ?? rest,
    } as SsoProviderConfig;
  }
  return null;
}

function mergeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function buildOidcConfig(options: McpSsoOptions): Record<string, unknown> {
  const scopeList = options.scopes;
  const tokenEndpoint =
    options.tokenEndpoint ||
    (options.uaaUrl
      ? `${options.uaaUrl.replace(/\/+$/, '')}/oauth/token`
      : undefined);
  const passcode = options.passcode;
  const username = options.username || (passcode ? 'passcode' : undefined);
  const password = options.password || passcode;
  return {
    issuerUrl: options.issuerUrl,
    authorizationEndpoint: options.authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint: options.deviceAuthorizationEndpoint,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scopes: scopeList,
    scope: options.scope,
    authorizationCode: options.code,
    username,
    password,
    subjectToken: options.subjectToken,
    subjectTokenType:
      options.subjectTokenType ||
      'urn:ietf:params:oauth:token-type:access_token',
    audience: options.audience,
    actorToken: options.actorToken,
    actorTokenType: options.actorTokenType,
    browser: options.browser,
    redirectPort: options.redirectPort,
    redirectUri: options.redirectUri,
  };
}

function buildSamlConfig(options: McpSsoOptions): Record<string, unknown> {
  const assertionFlow =
    options.assertionFlow || (options.assertion ? 'assertion' : 'browser');
  const tokenUrl =
    options.tokenEndpoint ||
    (options.uaaUrl
      ? `${options.uaaUrl.replace(/\/+$/, '')}/oauth/token`
      : undefined);
  const assertionProvider = options.assertion
    ? async () => options.assertion as string
    : assertionFlow === 'assertion'
      ? async () => readManualInput('Paste SAMLResponse: ')
      : undefined;
  const cookieProvider = async () => {
    if (options.cookie) {
      return options.cookie;
    }
    return readManualInput('Paste session cookies: ');
  };

  return {
    idpSsoUrl: options.idpSsoUrl,
    spEntityId: options.spEntityId,
    acsUrl: options.acsUrl,
    relayState: options.relayState,
    assertionFlow,
    assertionProvider,
    tokenUrl,
    uaaUrl: options.uaaUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    browser: options.browser,
    redirectPort: options.redirectPort,
    cookieProvider,
  };
}

function buildProviderConfig(
  options: McpSsoOptions,
  existingAuth: { refreshToken?: string } | null,
  existingConn: { authorizationToken?: string } | null,
  fileConfig: SsoProviderConfig | null,
): SsoProviderConfig {
  let configFromCli: SsoProviderConfig | null = null;
  if (options.protocol && options.flow) {
    if (options.protocol === 'oidc') {
      switch (options.flow) {
        case 'browser':
          configFromCli = {
            protocol: 'oidc',
            flow: 'browser',
            config: buildOidcConfig(options) as unknown as OidcBrowserProviderConfig,
          };
          break;
        case 'device':
          configFromCli = {
            protocol: 'oidc',
            flow: 'device',
            config: buildOidcConfig(options) as unknown as OidcDeviceFlowProviderConfig,
          };
          break;
        case 'password':
          configFromCli = {
            protocol: 'oidc',
            flow: 'password',
            config: buildOidcConfig(options) as unknown as OidcPasswordProviderConfig,
          };
          break;
        case 'token_exchange':
          configFromCli = {
            protocol: 'oidc',
            flow: 'token_exchange',
            config: buildOidcConfig(options) as unknown as OidcTokenExchangeProviderConfig,
          };
          break;
        default:
          throw new Error(`Unsupported OIDC flow: ${options.flow}`);
      }
    } else if (options.protocol === 'saml2') {
      switch (options.flow) {
        case 'bearer':
          configFromCli = {
            protocol: 'saml2',
            flow: 'bearer',
            config: buildSamlConfig(options) as unknown as Saml2BearerProviderConfig,
          };
          break;
        case 'pure':
          configFromCli = {
            protocol: 'saml2',
            flow: 'pure',
            config: buildSamlConfig(options) as unknown as Saml2PureProviderConfig,
          };
          break;
        default:
          throw new Error(`Unsupported SAML flow: ${options.flow}`);
      }
    }
  }

  const base = fileConfig ?? configFromCli;
  if (!base) {
    throw new Error(
      'Provider config is missing. Use --config or --protocol/--flow options.',
    );
  }

  let result: SsoProviderConfig = base;
  if (options.protocol) {
    result = { ...result, protocol: options.protocol } as SsoProviderConfig;
  }
  if (options.flow) {
    result = { ...result, flow: options.flow } as SsoProviderConfig;
  }

  if (configFromCli) {
    result = {
      ...result,
      config: mergeConfig(
        (result as any).config || {},
        (configFromCli as any).config || {},
      ),
    } as unknown as SsoProviderConfig;
  }

  const accessToken = existingConn?.authorizationToken;
  const refreshToken = existingAuth?.refreshToken;
  if (
    (result.protocol === 'oidc' ||
      (result.protocol === 'saml2' && result.flow === 'bearer')) &&
    (accessToken || refreshToken)
  ) {
    result = {
      ...result,
      config: mergeConfig((result as any).config || {}, {
        accessToken,
        refreshToken,
      }),
    } as unknown as SsoProviderConfig;
  }

  return result;
}

async function main() {
  const options = parseArgs();
  if (!options) {
    return;
  }

  if (!options.outputFile) {
    console.error('❌ Missing required --output');
    process.exit(1);
  }

  const resolvedOutputPath = path.resolve(options.outputFile);
  const resolvedEnvPath = options.envFilePath
    ? path.resolve(options.envFilePath)
    : undefined;

  let destination = options.destination;
  if (!destination) {
    destination = path.basename(
      resolvedOutputPath,
      path.extname(resolvedOutputPath),
    );
  }

  if (resolvedEnvPath) {
    const envName = path.basename(
      resolvedEnvPath,
      path.extname(resolvedEnvPath),
    );
    if (destination && envName !== destination) {
      console.error(
        `❌ Destination mismatch: env file (${envName}) vs output (${destination})`,
      );
      process.exit(1);
    }
  }

  let providerConfigFromFile: SsoProviderConfig | null = null;
  if (options.configPath) {
    const resolvedConfigPath = path.resolve(options.configPath);
    if (!fs.existsSync(resolvedConfigPath)) {
      console.error(`❌ Config file not found: ${resolvedConfigPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
    providerConfigFromFile = normalizeProviderConfig(raw);
    if (!providerConfigFromFile) {
      console.error(`❌ Config file does not contain provider config`);
      process.exit(1);
    }
  }

  if (options.protocol === 'oidc' && options.flow === 'password') {
    if (options.uaaUrl && !options.tokenEndpoint) {
      options.tokenEndpoint = `${options.uaaUrl.replace(/\/+$/, '')}/oauth/token`;
    }
  }

  if (options.protocol === 'oidc' && options.flow) {
    const valid = ['browser', 'device', 'password', 'token_exchange'];
    if (!valid.includes(options.flow)) {
      console.error(
        `❌ Invalid OIDC flow: ${options.flow}. Use one of: ${valid.join(', ')}`,
      );
      process.exit(1);
    }
  }
  if (options.protocol === 'saml2' && options.flow) {
    const valid = ['bearer', 'pure'];
    if (!valid.includes(options.flow)) {
      console.error(
        `❌ Invalid SAML flow: ${options.flow}. Use one of: ${valid.join(', ')}`,
      );
      process.exit(1);
    }
  }

  if (options.protocol === 'oidc' && options.flow === 'password') {
    if (!options.passcode && !options.password) {
      options.passcode = await readManualInput('Paste passcode: ');
    }
  }

  const tempSessionDir = path.join(path.dirname(resolvedOutputPath), '.tmp');
  if (!fs.existsSync(tempSessionDir)) {
    fs.mkdirSync(tempSessionDir, { recursive: true });
  }

  if (resolvedEnvPath && fs.existsSync(resolvedEnvPath)) {
    const tempEnvPath = path.join(tempSessionDir, `${destination}.env`);
    fs.copyFileSync(resolvedEnvPath, tempEnvPath);
  }

  const placeholderServiceUrl = '<SERVICE_URL>';
  const defaultServiceUrl =
    options.authType === 'xsuaa'
      ? options.serviceUrl || placeholderServiceUrl
      : options.serviceUrl || '';
  const sessionStore =
    options.authType === 'xsuaa'
      ? new XsuaaSessionStore(tempSessionDir, defaultServiceUrl)
      : new AbapSessionStore(tempSessionDir);

  const existingConn = await sessionStore.getConnectionConfig(destination);
  const existingAuth = await sessionStore.getAuthorizationConfig(destination);

  const serviceUrl = options.serviceUrl || existingConn?.serviceUrl;
  if (options.authType === 'abap' && !serviceUrl) {
    console.error(
      '❌ ABAP requires --service-url or existing env with SAP URL',
    );
    process.exit(1);
  }

  if (
    options.protocol === 'saml2' &&
    options.flow === 'pure' &&
    options.authType === 'xsuaa'
  ) {
    console.error(
      '❌ SAML pure flow is only supported for ABAP sessions (cookies)',
    );
    process.exit(1);
  }

  await sessionStore.setConnectionConfig(destination, {
    serviceUrl:
      serviceUrl ||
      (options.authType === 'xsuaa' ? defaultServiceUrl : undefined),
    authorizationToken: existingConn?.authorizationToken,
    sessionCookies: existingConn?.sessionCookies,
  });

  let stripClientSecret = false;
  const authUaaUrl =
    options.uaaUrl || options.tokenEndpoint || options.issuerUrl || undefined;
  if (options.clientId && authUaaUrl) {
    let clientSecret = options.clientSecret;
    if (!clientSecret) {
      clientSecret = '__public__';
      stripClientSecret = true;
    }
    await sessionStore.setAuthorizationConfig(destination, {
      uaaUrl: authUaaUrl,
      uaaClientId: options.clientId,
      uaaClientSecret: clientSecret,
      refreshToken: existingAuth?.refreshToken,
    });
  }

  const providerConfig = buildProviderConfig(
    options,
    existingAuth,
    existingConn,
    providerConfigFromFile,
  );

  const tokenProvider = SsoProviderFactory.create(providerConfig);
  const broker = new AuthBroker(
    {
      sessionStore,
      tokenProvider,
    },
    options.browser,
  );

  console.log(`🔐 Getting token for destination "${destination}"...`);
  await broker.getToken(destination);
  console.log(`✅ Token obtained successfully`);

  const connConfig = await sessionStore.getConnectionConfig(destination);
  const authConfig = await sessionStore.getAuthorizationConfig(destination);

  if (!connConfig) {
    throw new Error('Connection config not found after authentication');
  }

  const isSaml = !!connConfig.sessionCookies && !connConfig.authorizationToken;
  const token = isSaml
    ? connConfig.sessionCookies
    : connConfig.authorizationToken;
  if (!token) {
    throw new Error('Token provider did not return authorization token');
  }

  if (options.format === 'env') {
    const tempEnvPath = path.join(tempSessionDir, `${destination}.env`);
    if (!fs.existsSync(tempEnvPath)) {
      throw new Error(`Temp env file not found: ${tempEnvPath}`);
    }

    const outputDir = path.dirname(resolvedOutputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    let envContent = fs.readFileSync(tempEnvPath, 'utf8');
    if (options.authType === 'xsuaa' && !serviceUrl) {
      const lines = envContent
        .split('\n')
        .filter((line) => !line.startsWith('XSUAA_MCP_URL='));
      envContent = `${lines.join('\n')}\n`;
    }
    if (stripClientSecret) {
      const lines = envContent
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('XSUAA_UAA_CLIENT_SECRET=') &&
            !line.startsWith('SAP_UAA_CLIENT_SECRET='),
        );
      envContent = `${lines.join('\n')}\n`;
    }
    fs.writeFileSync(resolvedOutputPath, envContent, 'utf8');
    console.log(`✅ .env file created: ${resolvedOutputPath}`);
  } else {
    const outputData: Record<string, unknown> = {
      tokenType: isSaml ? 'saml' : 'jwt',
    };
    if (isSaml) {
      outputData.sessionCookies = token;
    } else {
      outputData.accessToken = token;
    }
    if (authConfig?.refreshToken) {
      outputData.refreshToken = authConfig.refreshToken;
    }
    if (serviceUrl) {
      outputData.serviceUrl = serviceUrl;
    }
    if (authConfig?.uaaUrl) {
      outputData.uaaUrl = authConfig.uaaUrl;
    }
    if (authConfig?.uaaClientId) {
      outputData.uaaClientId = authConfig.uaaClientId;
    }
    if (authConfig?.uaaClientSecret) {
      if (!stripClientSecret) {
        outputData.uaaClientSecret = authConfig.uaaClientSecret;
      }
    }

    const outputDir = path.dirname(resolvedOutputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(
      resolvedOutputPath,
      JSON.stringify(outputData, null, 2),
      'utf8',
    );
    console.log(`✅ JSON file created: ${resolvedOutputPath}`);
  }

  try {
    fs.rmSync(tempSessionDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

main().catch((error) => {
  console.error(`❌ Error: ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
