/**
 * What `mcp-auth` does once its arguments are parsed, importable by tests.
 *
 * A run writes a complete destination (spec §10): first its means — `jwt`, the
 * grant (`authorization_code`, or `client_credentials` with `--credential`), the
 * client and `serviceUrl` from the service key — through the key store's own
 * write method; then the login through the broker's token API with this
 * command's own provider (spec §9), which writes the secret it obtains — the
 * secret alone — to the session store. `flush()` before the output is written.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthBroker, type IServiceKeyStore } from '@mcp-abap-adt/auth-broker';
import {
  AuthorizationCodeProvider,
  ClientCredentialsProvider,
  DEFAULT_CALLBACK_PORT,
  type staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import {
  AbapServiceKeyStore,
  JsonFileHandler,
  XsuaaServiceKeyStore,
} from '@mcp-abap-adt/auth-stores';
import {
  completeMeans,
  flushed,
  jsonOutput,
  openDestination,
  writeJsonFile,
  writeOutputFile,
} from './destination';

/** An interactive strategy, as auth-providers' strategy factories return one. */
export type AuthorizationStrategy = ReturnType<typeof staticCodeStrategy>;

export interface McpAuthOptions {
  serviceKeyPath?: string; // Optional if env file is provided
  envFilePath?: string;
  outputFile: string;
  authType: 'abap' | 'xsuaa';
  browser: string; // Browser for authorization_code flow (default: 'auto')
  credential: boolean; // Use client_credentials instead of authorization_code
  format: 'json' | 'env';
  serviceUrl?: string;
  // The callback port is the provider's own choice (`auth-providers`'
  // DEFAULT_CALLBACK_PORT); this only overrides it when the user asks.
  redirectPort?: number;
}

export interface McpAuthContext {
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
  /**
   * The interactive strategy of the authorization code login, stated by the
   * caller — the bin builds the browser callback from `--browser` and
   * `--redirect-port`. Not called for `--credential`.
   */
  authorization: (options: McpAuthOptions) => AuthorizationStrategy;
}

/** A value present as a non-empty string. */
function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * An XSUAA destination may state no URL: its token is for the services that
 * trust the XSUAA instance, not for one system. The token API with a
 * consumer's provider still requires a `serviceUrl` (spec §9, the 3.x order),
 * so the broker's view of the key store answers a placeholder — never written
 * to the destination, and no binding is computed from it (it does not parse).
 */
const PLACEHOLDER_SERVICE_URL = '<SERVICE_URL>';
function withPlaceholderUrl(store: IServiceKeyStore): IServiceKeyStore {
  return {
    getServiceKey: (destination) => store.getServiceKey(destination),
    getAuthorizationConfig: (destination) =>
      store.getAuthorizationConfig(destination),
    getConnectionConfig: async (destination) => {
      const config = await store.getConnectionConfig(destination);
      return config && !present(config.serviceUrl)
        ? { ...config, serviceUrl: PLACEHOLDER_SERVICE_URL }
        : config;
    },
  };
}

/** Runs `mcp-auth`; resolves the exit code. Usage errors exit the process. */
export async function runMcpAuth(
  options: McpAuthOptions,
  { workDir, authorization }: McpAuthContext,
): Promise<number> {
  const resolvedOutputPath = path.resolve(options.outputFile);
  const resolvedEnvPath = options.envFilePath
    ? path.resolve(options.envFilePath)
    : undefined;

  let destination: string | undefined;
  const envExists = resolvedEnvPath ? fs.existsSync(resolvedEnvPath) : false;
  if (resolvedEnvPath) {
    destination = path.basename(resolvedEnvPath, path.extname(resolvedEnvPath));
  }

  // The client and URL the service key states, copied into the destination:
  // the output is read later on its own, with no service key beside it.
  let keyClient: {
    uaaUrl: string;
    uaaClientId: string;
    uaaClientSecret: string;
  } | null = null;
  let keyServiceUrl: string | undefined;

  if (options.serviceKeyPath) {
    const resolvedServiceKeyPath = path.resolve(options.serviceKeyPath);
    let serviceKeyDir = path.dirname(resolvedServiceKeyPath);

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

    // Which parser reads the key: the ABAP format nests the client under
    // `uaa`, the XSUAA format holds it flat. The format, not the grant: the
    // grant is the command's (`--credential`), never read from the key.
    let isAbapFormat = options.authType === 'abap';
    let rawServiceKeyJson: Record<string, unknown> | null = null;
    try {
      const json = (await JsonFileHandler.load(
        path.basename(resolvedServiceKeyPath),
        serviceKeyDir,
      )) as Record<string, unknown> | null;
      let effectiveJson = json;
      if (json?.credentials) {
        console.log(
          '🔍 Detected "credentials" wrapper -> unwrapping to temp file',
        );
        effectiveJson = json.credentials as Record<string, unknown>;
        const keysDir = path.join(workDir, 'service-keys');
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(keysDir, `${destination}.json`),
          JSON.stringify(effectiveJson, null, 2),
          { mode: 0o600 },
        );
        serviceKeyDir = keysDir;
      }
      rawServiceKeyJson = effectiveJson;
      if (effectiveJson) {
        isAbapFormat = !!effectiveJson.uaa;
      }
    } catch {
      // If parsing fails here, let the store report it below.
    }

    const serviceKeyStore = isAbapFormat
      ? new AbapServiceKeyStore(serviceKeyDir)
      : new XsuaaServiceKeyStore(serviceKeyDir);
    try {
      const auth = await serviceKeyStore.getAuthorizationConfig(destination);
      if (auth) {
        keyClient = {
          uaaUrl: auth.uaaUrl,
          uaaClientId: auth.uaaClientId,
          uaaClientSecret: auth.uaaClientSecret,
        };
      }
    } catch {
      console.log(
        `ℹ️  Store could not parse service key, using fallback parsing`,
      );
    }
    if (!keyClient && rawServiceKeyJson) {
      const uaa = (rawServiceKeyJson.uaa ?? rawServiceKeyJson) as Record<
        string,
        unknown
      >;
      if (
        present(uaa.clientid) &&
        present(uaa.clientsecret) &&
        present(uaa.url)
      ) {
        keyClient = {
          uaaUrl: uaa.url,
          uaaClientId: uaa.clientid,
          uaaClientSecret: uaa.clientsecret,
        };
        console.log(`✅ Constructed auth config from raw service key`);
      }
    }
    try {
      keyServiceUrl = (await serviceKeyStore.getConnectionConfig(destination))
        ?.serviceUrl;
    } catch {
      // For XSUAA, serviceUrl is optional and may not exist in the key.
    }
  }

  if (!destination) {
    console.error('❌ Destination could not be determined from inputs');
    process.exit(1);
  }

  const grantType = options.credential
    ? 'client_credentials'
    : 'authorization_code';

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
  console.log(`🔑 Flow: ${grantType}`);
  if (!options.credential) {
    console.log(`🌐 Browser: ${options.browser}`);
  }
  console.log(`📄 Format: ${options.format}`);
  if (options.serviceUrl) {
    console.log(`🔗 Service URL: ${options.serviceUrl}`);
  }

  if (!envExists && !options.serviceKeyPath) {
    throw new Error('Env file not found and no service key provided.');
  }

  const files = openDestination(
    workDir,
    destination,
    options.authType,
    resolvedEnvPath,
  );

  // The means, before the login: what the session's secret is obtained with.
  const serviceUrl = options.serviceUrl || keyServiceUrl;
  await files.keyStore.setDestination(
    destination,
    completeMeans({
      authType: 'jwt',
      grantType,
      serviceUrl,
      ...(keyClient ?? {}),
    }),
  );

  const authConfig = await files.keyStore.getAuthorizationConfig(destination);
  if (
    !authConfig ||
    !present(authConfig.uaaUrl) ||
    !present(authConfig.uaaClientSecret)
  ) {
    throw new Error(
      `Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields.`,
    );
  }

  if (!options.credential) {
    // A preview only: the strategy binds the port and assembles the URL.
    const redirectUri = `http://localhost:${options.redirectPort ?? DEFAULT_CALLBACK_PORT}/callback`;
    console.log(
      `🔗 Authorization URL: ${authConfig.uaaUrl}/oauth/authorize?client_id=${encodeURIComponent(authConfig.uaaClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`,
    );
    console.log(`📍 Redirect URI: ${redirectUri}`);
  }

  // This command's own provider, built by the broker's factory form from the
  // client the destination states and the refresh token its session holds.
  const broker = new AuthBroker({
    sessionStore: files.sessionStore,
    serviceKeyStore:
      options.authType === 'xsuaa'
        ? withPlaceholderUrl(files.keyStore)
        : files.keyStore,
    provider: (_destination, auth) => {
      if (!auth) {
        throw new Error(`Missing authorization config for ${destination}`);
      }
      return options.credential
        ? new ClientCredentialsProvider({
            uaaUrl: auth.uaaUrl,
            clientId: auth.uaaClientId,
            clientSecret: auth.uaaClientSecret,
          })
        : new AuthorizationCodeProvider({
            uaaUrl: auth.uaaUrl,
            clientId: auth.uaaClientId,
            clientSecret: auth.uaaClientSecret,
            refreshToken: auth.refreshToken,
            authorization: authorization(options),
          });
    },
  });

  console.log(`🔐 Getting token for destination "${destination}"...`);
  let obtainError: unknown;
  try {
    await broker.getToken(destination);
    console.log(`✅ Token obtained successfully`);
  } catch (error) {
    // A failed login, or a token obtained whose write failed: either way the
    // run fails, after one more attempt at any write still pending.
    obtainError = error;
  }
  const stored = await flushed(broker, (line) => console.error(line));
  if (obtainError) {
    throw obtainError;
  }
  if (!stored) {
    return 1;
  }

  if (options.format === 'env') {
    writeOutputFile(files, resolvedOutputPath);
    console.log(`✅ .env file created: ${resolvedOutputPath}`);
  } else {
    writeJsonFile(resolvedOutputPath, await jsonOutput(files, destination, {}));
    console.log(`✅ JSON file created: ${resolvedOutputPath}`);
  }
  return 0;
}
