/**
 * What `mcp-auth oidc | saml2-pure | saml2-bearer` do once their arguments
 * are parsed (`subcommandArgs.ts`) — 2.x's `mcp-sso` — importable by tests.
 *
 * A run writes a complete destination: first its means, through the
 * key store's own write method — `authType`, `grantType`, the grant's data, the
 * client — then the login, through the provider the broker builds for that
 * destination with the collaborators this CLI states, whose secret reaches the
 * session store through the broker's persistence. `flush()` before the output
 * is written: a secret the store did not take is a failed run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthBroker, bindingOf } from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import { XsuaaServiceKeyStore } from '@mcp-abap-adt/auth-stores';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  completeMeans,
  flushed,
  jsonOutput,
  openDestination,
  writeJsonFile,
  writeOutputFile,
} from './destination';
import { readJsonFile } from './jsonFile';
import {
  applyFileConfig,
  buildCollaborators,
  buildDestinationMeans,
  type McpSsoOptions,
  normalizeProviderConfig,
  opensBrowser,
  ssoBrowser,
  ssoRow,
} from './mcpSsoConfig';
import { applySamlMetadata } from './samlMetadata';

export interface McpSsoContext {
  /** Where the device-code presenter and the broker write. */
  logger: ILogger;
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
  /** The platform the browser is mapped for; `process.platform` when absent. */
  platform?: string | undefined;
}

/** Runs one of those subcommands; resolves the exit code. Usage errors exit the process. */
export async function runMcpSso(
  options: McpSsoOptions,
  { logger, workDir, platform }: McpSsoContext,
): Promise<number> {
  if (!options.outputFile) {
    console.error('❌ Missing required --output');
    process.exit(1);
  }

  const resolvedOutputPath = path.resolve(options.outputFile);
  const resolvedEnvPath = options.envFilePath
    ? path.resolve(options.envFilePath)
    : undefined;

  let destination = options.destination;
  if (options.serviceKeyPath) {
    const resolvedServiceKeyPath = path.resolve(options.serviceKeyPath);
    if (!fs.existsSync(resolvedServiceKeyPath)) {
      console.error(`❌ Service key file not found: ${resolvedServiceKeyPath}`);
      process.exit(1);
    }
    const serviceKeyFileName = path.basename(
      resolvedServiceKeyPath,
      path.extname(resolvedServiceKeyPath),
    );
    if (destination && destination !== serviceKeyFileName) {
      console.error(
        `❌ Destination mismatch: service key (${serviceKeyFileName}) vs output (${destination})`,
      );
      process.exit(1);
    }
    destination = serviceKeyFileName;
  }
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

  const allowTokenEndpointWithServiceKey =
    options.protocol === 'saml2' && options.flow === 'bearer';
  const serviceKeyConflicts =
    options.serviceKeyPath &&
    (options.configPath ||
      options.issuerUrl ||
      options.authorizationEndpoint ||
      (!allowTokenEndpointWithServiceKey && options.tokenEndpoint) ||
      options.deviceAuthorizationEndpoint ||
      options.clientId ||
      options.clientSecret ||
      options.uaaUrl);
  if (serviceKeyConflicts) {
    console.error(
      '❌ Use either --service-key or explicit OIDC/SAML parameters (issuer/token/client/uaa).',
    );
    process.exit(1);
  }

  if (options.serviceKeyPath && options.authType !== 'xsuaa') {
    console.error('❌ --service-key is supported only for XSUAA flows.');
    process.exit(1);
  }

  let providerConfigFromFile: ReturnType<typeof normalizeProviderConfig> = null;
  if (options.configPath) {
    const resolvedConfigPath = path.resolve(options.configPath);
    if (!fs.existsSync(resolvedConfigPath)) {
      console.error(`❌ Config file not found: ${resolvedConfigPath}`);
      process.exit(1);
    }
    // Read in fixed words: the parser's message would quote the file.
    let raw: unknown;
    try {
      raw = readJsonFile(resolvedConfigPath, 'The config file');
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
    providerConfigFromFile = normalizeProviderConfig(raw);
    if (!providerConfigFromFile) {
      console.error('❌ --config: the file holds no JSON object');
      process.exit(1);
    }
  }

  // Merge the file into `options` *before* anything downstream reads
  // options.protocol/flow or builds a strategy from them — a run driven by
  // --config must reach exactly the same validation and destination-building
  // code a run given every flag does; a file naming another subcommand is
  // refused there. CLI flags already
  // parsed are left alone; the file only fills what they didn't set. A no-op
  // when --config wasn't given.
  applyFileConfig(options, providerConfigFromFile);

  // The browser is mapped only for a login that opens one — what the run
  // states, from a flag or the --config file, else `auto` — and then before
  // anything else is read or written: a name this platform has no launcher
  // for is a usage error, never a guess. A login that opens none maps no
  // browser and refuses none.
  try {
    if (opensBrowser(options)) {
      ssoBrowser(options, platform ?? process.platform);
    }
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }

  // The user's own --token-endpoint, before a service key sets the plain
  // /oauth/token, which a saml2-bearer grant must not use.
  const explicitTokenEndpoint = options.tokenEndpoint;

  if (options.serviceKeyPath) {
    const resolvedServiceKeyPath = path.resolve(options.serviceKeyPath);
    const serviceKeyStore = new XsuaaServiceKeyStore(
      path.dirname(resolvedServiceKeyPath),
    );
    const authConfig =
      await serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      console.error(
        `❌ Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields.`,
      );
      process.exit(1);
    }
    const uaaUrl = authConfig.uaaUrl;
    if (!uaaUrl) {
      console.error(`❌ Service key missing UAA URL for ${destination}.`);
      process.exit(1);
    }
    options.uaaUrl = uaaUrl;
    options.clientId = authConfig.uaaClientId;
    options.clientSecret = authConfig.uaaClientSecret;
    if (!options.issuerUrl) {
      options.issuerUrl = uaaUrl;
    }
    if (!options.tokenEndpoint) {
      options.tokenEndpoint = `${uaaUrl.replace(/\/+$/, '')}/oauth/token`;
    }
    if (!options.authorizationEndpoint) {
      options.authorizationEndpoint = `${uaaUrl.replace(/\/+$/, '')}/oauth/authorize`;
    }
  }

  // What the SAML metadata states and the caller did not: the identity
  // provider's trust from --idp-metadata, and for saml2-bearer the Audience,
  // Recipient and token endpoint from XSUAA's own metadata (--saml-metadata,
  // else <uaa.url>/saml/metadata from the service key).
  try {
    await applySamlMetadata(options, explicitTokenEndpoint);
  } catch (error) {
    console.error(
      `❌ SAML metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
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

  const files = openDestination(
    workDir,
    destination,
    options.authType,
    resolvedEnvPath,
  );

  // An ABAP session is presented to a system: its URL is required, from
  // --service-url or the destination given with --env.
  if (options.authType === 'abap' && !options.serviceUrl) {
    const stated = await files.keyStore.getConnectionConfig(destination);
    if (!stated?.serviceUrl) {
      console.error(
        '❌ ABAP requires --service-url or existing env with SAP URL',
      );
      process.exit(1);
    }
  }

  const row = ssoRow(options);
  const means = buildDestinationMeans(options);
  await files.keyStore.setDestination(destination, completeMeans(means));
  console.log(
    `📝 Destination "${destination}": ${row.authType} / ${row.grantType}`,
  );

  // This CLI's choices, stated: a user at a terminal can log in, so a
  // renewal refreshes and then logs in; a secret the store did not take
  // fails the run, which then writes no output.
  const broker = new AuthBroker(
    {
      sessionStore: files.sessionStore,
      serviceKeyStore: files.keyStore,
      ...buildCollaborators(options, logger),
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
    },
    logger,
  );

  if (row.grantType === 'none') {
    // The cookies were handed over, not obtained: the CLI writes them, with
    // the binding the broker computes for this destination's means — the
    // resource with its SAP client — so the broker presents them there and
    // nowhere else. The CLI composes no binding of its own.
    const stated = await files.keyStore.getConnectionConfig(destination);
    await files.sessionStore.saveSession(destination, {
      sessionCookies: options.cookie,
      ...bindingOf(stated ?? {}),
    });
    // The destination as the broker will read it: refused here, not later.
    await broker.getProvider(destination);
    console.log(`✅ Session cookies stored`);
  }
  // Whether the login threw, beside what it threw: a falsy value thrown
  // (undefined, 0, '') is a failure too.
  let failed = false;
  let obtainError: unknown;
  if (row.grantType !== 'none') {
    const provider = await broker.getProvider(destination);
    const tokens = provider as Partial<{
      getTokens: () => Promise<unknown>;
    }>;
    if (typeof tokens.getTokens !== 'function') {
      throw new Error(
        `The provider for "${destination}" obtains no token (${row.authType} / ${row.grantType})`,
      );
    }
    console.log(`🔐 Getting token for destination "${destination}"...`);
    // What the provider obtains reaches the session store through the
    // broker's persistence; a write that did not land fails this call
    // (onWriteFailure: 'fail'). Either way the run fails, after one more
    // attempt at any write still pending.
    try {
      await tokens.getTokens();
      console.log(`✅ Token obtained successfully`);
    } catch (error) {
      failed = true;
      obtainError = error;
    }
  }

  const stored = await flushed(broker, (line) => console.error(line));
  if (failed) {
    throw obtainError;
  }
  if (!stored) {
    return 1;
  }

  if (options.format === 'env') {
    writeOutputFile(files, resolvedOutputPath);
    console.log(`✅ .env file created: ${resolvedOutputPath}`);
  } else {
    writeJsonFile(
      resolvedOutputPath,
      await jsonOutput(files, destination, { tokenType: true }),
    );
    console.log(`✅ JSON file created: ${resolvedOutputPath}`);
  }
  return 0;
}
