/**
 * Pure config-building logic for `mcp-sso`, split out from bin/mcp-sso.ts so
 * it can be imported by tests directly.
 *
 * bin/mcp-sso.ts itself cannot be `import`ed safely: it `require()`s the
 * compiled `dist/index.js` at module load time (assuming it is always run
 * from `dist/bin/`) and calls `main()` at the bottom of the file. Neither is
 * true when a test loads the TypeScript source directly, so anything that
 * needs unit coverage — building an `SsoProviderConfig` from CLI options and
 * an optional `--config` file, and merging the two — lives here instead.
 */

import { createInterface } from 'node:readline';
import {
  asOidcResult,
  manualSamlResponseStrategy,
  type OidcBrowserProviderConfig,
  type OidcDeviceFlowProviderConfig,
  type OidcPasswordProviderConfig,
  type OidcTokenExchangeProviderConfig,
  oidcCallbackStrategy,
  type Saml2BearerProviderConfig,
  type Saml2PureProviderConfig,
  type SsoProviderConfig,
  samlCallbackStrategy,
  staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';

/**
 * A person completes these logins at a browser; the library's own default
 * (30s) is sized for an unattended caller instead.
 */
export const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface McpSsoOptions {
  outputFile?: string;
  envFilePath?: string;
  destination?: string;
  serviceKeyPath?: string;
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
  // Overrides the strategy's own callback port (auth-providers'
  // DEFAULT_CALLBACK_PORT) when set; otherwise the strategy decides.
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
  samlMetadataPath?: string;
}

export function readManualInput(prompt: string): Promise<string> {
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

export function normalizeProviderConfig(raw: any): SsoProviderConfig | null {
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

/**
 * Pre-2.0.0 provider config fields that named a JavaScript function
 * (`() => Promise<string>` or similar) rather than a value. JSON cannot
 * carry a function, so a `--config` file can never legitimately supply one —
 * if a key like this shows up, the file is stale in a way no conversion can
 * fix. Refuse rather than silently drop it, and say what to write instead.
 */
const UNSUPPORTED_LEGACY_CONFIG_FIELDS: Record<string, string> = {
  authorizationCodeProvider:
    "'authorizationCodeProvider' (a function) cannot be expressed in a --config file. Use --code for a value you already hold, or drive the OIDC browser flow interactively without it.",
  assertionProvider:
    "'assertionProvider' (a function) cannot be expressed in a --config file. Use --assertion for a value you already hold, or --assertion-flow to choose how it is obtained.",
  manualInput:
    "'manualInput' (a function) cannot be expressed in a --config file. Use --assertion-flow manual to prompt on this CLI's own stdin instead.",
};

/**
 * `--config` file fields that map 1:1 onto a `McpSsoOptions` field of the
 * same name — every pre-2.0.0 config field the strategies still need, other
 * than `authorizationCode` (see `applyFileConfig`), lands here.
 */
const CONFIG_BACKFILL_FIELDS: (keyof McpSsoOptions)[] = [
  'browser',
  'redirectPort',
  'redirectUri',
  'issuerUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
  'deviceAuthorizationEndpoint',
  'clientId',
  'clientSecret',
  'scopes',
  'scope',
  'username',
  'password',
  'passcode',
  'subjectToken',
  'subjectTokenType',
  'audience',
  'actorToken',
  'actorTokenType',
  'idpSsoUrl',
  'spEntityId',
  'acsUrl',
  'relayState',
  'assertionFlow',
  'assertion',
  'cookie',
  'uaaUrl',
];

/**
 * Backfills `options` in place from a `--config` file's raw `config` object.
 * CLI flags always win — a field already set on `options` is left alone; the
 * file only fills gaps.
 *
 * This is what makes a config-file-only run (no --protocol/--flow on the
 * CLI) reach the same strategy-building code as a CLI-flag run: without it,
 * the file's fields — including a `browser`/`redirectPort` a 2.0.0 provider
 * no longer accepts directly — would reach `SsoProviderFactory.create()`
 * untouched and be silently ignored.
 *
 * Every field a pre-2.0.0 config could carry either lands on its
 * `McpSsoOptions` equivalent here (which the strategy built from `options`
 * then consumes) or the run is refused via `process.exit(1)` naming what to
 * write instead. Nothing may reach the provider without one of those two
 * happening.
 *
 * Also backfills `options.protocol`/`options.flow` from the file when the
 * CLI didn't set them — a `--config`-only run (no `--protocol`/`--flow`
 * flags at all) must still resolve to a real flow, or nothing downstream
 * ever calls a builder at all.
 *
 * A no-op when `fileConfig` is `null` (no `--config` was given), so callers
 * can invoke this unconditionally.
 */
export function applyFileConfig(
  options: McpSsoOptions,
  fileConfig: SsoProviderConfig | null,
): void {
  if (!fileConfig) {
    return;
  }

  options.protocol = options.protocol ?? fileConfig.protocol;
  options.flow = options.flow ?? (fileConfig.flow as McpSsoOptions['flow']);

  const fields = ((fileConfig as { config?: unknown }).config ?? {}) as Record<
    string,
    unknown
  >;

  for (const [field, guidance] of Object.entries(
    UNSUPPORTED_LEGACY_CONFIG_FIELDS,
  )) {
    if (fields[field] !== undefined) {
      console.error(`❌ --config: ${guidance}`);
      process.exit(1);
    }
  }

  // Pre-2.0.0 field name for the OIDC manual/OOB code paste path; maps onto
  // the same slot --code fills.
  if (
    options.code === undefined &&
    typeof fields.authorizationCode === 'string'
  ) {
    options.code = fields.authorizationCode;
  }

  for (const field of CONFIG_BACKFILL_FIELDS) {
    if (options[field] === undefined && fields[field] !== undefined) {
      (options as unknown as Record<string, unknown>)[field] = fields[field];
    }
  }
}

function requireOption(value: string | undefined, flagName: string): string {
  if (!value) {
    console.error(`❌ ${flagName} is required for this flow.`);
    process.exit(1);
  }
  return value;
}

function resolveOidcTokenEndpoint(options: McpSsoOptions): string | undefined {
  return (
    options.tokenEndpoint ||
    (options.uaaUrl
      ? `${options.uaaUrl.replace(/\/+$/, '')}/oauth/token`
      : undefined)
  );
}

/**
 * Only the OIDC 'browser' flow opens a browser; routes `--browser`,
 * `--redirect-port` and manual/OOB code paste into the strategy that
 * replaces them.
 */
function buildOidcBrowserAuthorization(options: McpSsoOptions) {
  if (options.code) {
    // The consumer already holds the code (manual paste / OOB redirect
    // URI); no callback server is opened at all.
    return asOidcResult(
      staticCodeStrategy({
        redirectUri: options.redirectUri,
        payload: options.code,
      }),
    );
  }
  // No fallback: an omitted --redirect-port lets the strategy bind its own
  // default port rather than this CLI pinning a number it doesn't own.
  return oidcCallbackStrategy({
    port: options.redirectPort,
    browser: options.browser,
    timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
  });
}

function buildOidcCommon(options: McpSsoOptions) {
  return {
    issuerUrl: options.issuerUrl,
    clientId: requireOption(options.clientId, '--client-id'),
    clientSecret: options.clientSecret,
  };
}

export function buildOidcBrowserConfig(
  options: McpSsoOptions,
): OidcBrowserProviderConfig {
  return {
    ...buildOidcCommon(options),
    authorizationEndpoint: options.authorizationEndpoint,
    tokenEndpoint: resolveOidcTokenEndpoint(options),
    scopes: options.scopes,
    authorization: buildOidcBrowserAuthorization(options),
  };
}

export function buildOidcDeviceConfig(
  options: McpSsoOptions,
): OidcDeviceFlowProviderConfig {
  // Device flow never opens a browser from this process; --browser and
  // --redirect-port have nothing to attach to here.
  return {
    ...buildOidcCommon(options),
    deviceAuthorizationEndpoint: options.deviceAuthorizationEndpoint,
    tokenEndpoint: resolveOidcTokenEndpoint(options),
    scopes: options.scopes,
  };
}

export function buildOidcPasswordConfig(
  options: McpSsoOptions,
): OidcPasswordProviderConfig {
  // Password flow never opens a browser; --browser and --redirect-port are
  // not meaningful here either.
  const passcode = options.passcode;
  const username = options.username || (passcode ? 'passcode' : undefined);
  const password = options.password || passcode;
  return {
    ...buildOidcCommon(options),
    username: requireOption(username, '--username (or --passcode)'),
    password: requireOption(password, '--password (or --passcode)'),
    tokenEndpoint: resolveOidcTokenEndpoint(options),
    scopes: options.scopes,
  };
}

export function buildOidcTokenExchangeConfig(
  options: McpSsoOptions,
): OidcTokenExchangeProviderConfig {
  // Token exchange never opens a browser; --browser and --redirect-port are
  // not meaningful here either.
  return {
    ...buildOidcCommon(options),
    subjectToken: requireOption(options.subjectToken, '--subject-token'),
    subjectTokenType:
      options.subjectTokenType ||
      'urn:ietf:params:oauth:token-type:access_token',
    scope: options.scope,
    audience: options.audience,
    actorToken: options.actorToken,
    actorTokenType: options.actorTokenType,
    tokenEndpoint: resolveOidcTokenEndpoint(options),
  };
}

/**
 * Both SAML flows (bearer, pure) can open a browser; routes `--browser`,
 * `--redirect-port` and the manual/static assertion options into the
 * strategy that replaces them.
 */
function buildSamlAuthorization(options: McpSsoOptions) {
  if (options.assertion) {
    // The consumer already holds the assertion; nothing is opened or asked.
    return staticCodeStrategy({
      redirectUri: options.acsUrl,
      payload: options.assertion,
    });
  }
  const assertionFlow = options.assertionFlow || 'browser';
  if (assertionFlow !== 'browser') {
    // 'manual', and an 'assertion' flow given no value, both need a human to
    // lift the SAMLResponse out of the POST body by hand.
    return manualSamlResponseStrategy({
      redirectUri: options.acsUrl,
      read: readManualInput,
    });
  }
  // No fallback: an omitted --redirect-port lets the strategy bind its own
  // default port rather than this CLI pinning a number it doesn't own.
  return samlCallbackStrategy({
    port: options.redirectPort,
    browser: options.browser,
    timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
  });
}

function buildSamlCookieProvider(
  options: McpSsoOptions,
): (samlResponse: string) => Promise<string> {
  const assertionFlow =
    options.assertionFlow || (options.assertion ? 'assertion' : 'browser');
  return async (samlResponse: string) => {
    if (options.cookie) {
      return options.cookie;
    }
    if (assertionFlow === 'assertion') {
      return `SAMLResponse=${samlResponse}`;
    }
    return readManualInput('Paste session cookies: ');
  };
}

export function buildSamlBearerConfig(
  options: McpSsoOptions,
): Saml2BearerProviderConfig {
  return {
    idpSsoUrl: requireOption(options.idpSsoUrl, '--idp-sso-url'),
    spEntityId: requireOption(options.spEntityId, '--sp-entity-id'),
    acsUrl: options.acsUrl,
    relayState: options.relayState,
    tokenUrl: options.tokenEndpoint,
    uaaUrl: options.uaaUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorization: buildSamlAuthorization(options),
  };
}

export function buildSamlPureConfig(
  options: McpSsoOptions,
): Saml2PureProviderConfig {
  return {
    idpSsoUrl: requireOption(options.idpSsoUrl, '--idp-sso-url'),
    spEntityId: requireOption(options.spEntityId, '--sp-entity-id'),
    acsUrl: options.acsUrl,
    relayState: options.relayState,
    authorization: buildSamlAuthorization(options),
    cookieProvider: buildSamlCookieProvider(options),
  };
}

/**
 * Builds the effective `SsoProviderConfig` from `options` alone.
 *
 * `options` must already be the *merged* view — `--config` file fields
 * backfilled beneath whatever the CLI flags set, via `applyFileConfig` — so
 * this never needs a separate file/CLI merge step, and required-field
 * validation (`requireOption`, inside each builder above) sees the same
 * merged data regardless of whether a value came from the file or a flag.
 */
export function buildProviderConfig(
  options: McpSsoOptions,
  existingAuth: { refreshToken?: string } | null,
  existingConn: { authorizationToken?: string } | null,
): SsoProviderConfig {
  if (!options.protocol || !options.flow) {
    throw new Error(
      'Provider config is missing. Use --config or --protocol/--flow options.',
    );
  }

  let result: SsoProviderConfig;
  if (options.protocol === 'oidc') {
    switch (options.flow) {
      case 'browser':
        result = {
          protocol: 'oidc',
          flow: 'browser',
          config: buildOidcBrowserConfig(options),
        };
        break;
      case 'device':
        result = {
          protocol: 'oidc',
          flow: 'device',
          config: buildOidcDeviceConfig(options),
        };
        break;
      case 'password':
        result = {
          protocol: 'oidc',
          flow: 'password',
          config: buildOidcPasswordConfig(options),
        };
        break;
      case 'token_exchange':
        result = {
          protocol: 'oidc',
          flow: 'token_exchange',
          config: buildOidcTokenExchangeConfig(options),
        };
        break;
      default:
        throw new Error(`Unsupported OIDC flow: ${options.flow}`);
    }
  } else if (options.protocol === 'saml2') {
    switch (options.flow) {
      case 'bearer':
        result = {
          protocol: 'saml2',
          flow: 'bearer',
          config: buildSamlBearerConfig(options),
        };
        break;
      case 'pure':
        result = {
          protocol: 'saml2',
          flow: 'pure',
          config: buildSamlPureConfig(options),
        };
        break;
      default:
        throw new Error(`Unsupported SAML flow: ${options.flow}`);
    }
  } else {
    throw new Error(`Unsupported protocol: ${options.protocol}`);
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
      config: {
        ...(result as unknown as { config: Record<string, unknown> }).config,
        accessToken,
        refreshToken,
      },
    } as unknown as SsoProviderConfig;
  }

  return result;
}
