/**
 * What `mcp-auth` does once its arguments are parsed, importable by tests.
 *
 * A run writes a complete destination: first its means — `jwt`, the
 * grant (`authorization_code`, or `client_credentials` with `--credential`), the
 * client and `serviceUrl` from the service key — through the key store's own
 * write method; then the login through the broker's token API with this
 * command's own provider, which writes the secret it obtains — the
 * secret alone — to the session store. `flush()` before the output is written.
 *
 * How the client authenticates is the user's statement, never inferred from
 * the key: no `--client-auth` is the client secret, as 2.0.0;
 * `--client-auth secret --basic-encoding raw|form` the secret in a Basic
 * header; `--client-auth certificate --cert-path --key-path` the key's x509
 * client, its certificate and key read from the user's own files, which the
 * destination names by path beside `certurl`. A service key carrying a
 * certificate or a private key is never copied, whatever the flags.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AuthBroker,
  type ClientAuthenticationStrategy,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
  type IServiceKeyStore,
} from '@mcp-abap-adt/auth-broker';
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
  /**
   * How the client authenticates (`--client-auth`). Absent: the client
   * secret in the token request, as 2.0.0.
   */
  clientAuth?: 'certificate' | 'secret';
  /** `--basic-encoding`: required with `clientAuth: 'secret'`, nowhere else. */
  basicEncoding?: 'raw' | 'form';
  /** `--cert-path` / `--key-path`: required with `clientAuth: 'certificate'`. */
  certPath?: string;
  keyPath?: string;
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
 * The client authentication flags, checked before anything is written: each
 * flag only with the choice it belongs to, every flag that choice needs, and
 * the certificate files present — resolved to absolute paths, so the
 * destination works from wherever it is copied. A refusal names the flag.
 */
function clientAuthFlags(
  options: McpAuthOptions,
): { certPath: string; keyPath: string } | null {
  const { clientAuth } = options;
  if (
    clientAuth !== undefined &&
    clientAuth !== 'certificate' &&
    clientAuth !== 'secret'
  ) {
    throw new Error(`--client-auth must be 'certificate' or 'secret'`);
  }
  if (clientAuth === 'secret') {
    if (options.basicEncoding !== 'raw' && options.basicEncoding !== 'form') {
      throw new Error(
        '--client-auth secret needs --basic-encoding raw|form: how the client id and secret are encoded depends on the server (XSUAA: raw)',
      );
    }
  } else if (options.basicEncoding !== undefined) {
    throw new Error('--basic-encoding applies only to --client-auth secret');
  }
  const certificateFlags = [
    ['--cert-path', options.certPath],
    ['--key-path', options.keyPath],
  ] as const;
  if (clientAuth !== 'certificate') {
    const stray = certificateFlags.filter(([, value]) => value !== undefined);
    if (stray.length > 0) {
      throw new Error(
        `${stray.map(([flag]) => flag).join(' and ')} apply only to --client-auth certificate`,
      );
    }
    return null;
  }
  const missing = certificateFlags.filter(([, value]) => !present(value));
  if (missing.length > 0) {
    throw new Error(
      `--client-auth certificate needs ${missing.map(([flag]) => flag).join(' and ')}`,
    );
  }
  const [certPath, keyPath] = certificateFlags.map(([flag, value]) => {
    const resolved = path.resolve(value as string);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${flag}: no file at ${resolved}`);
    }
    return resolved;
  });
  return { certPath, keyPath };
}

/**
 * Whether a service key carries a client certificate or a private key, in
 * part or whole, flat or under `uaa` — PEM the CLI must never copy. Only the
 * fields' presence is read; which client authenticates is the user's flag.
 */
function carriesCertificate(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const uaa = (json as Record<string, unknown>).uaa;
  return [json, uaa].some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      ((part as Record<string, unknown>).certificate !== undefined ||
        (part as Record<string, unknown>).key !== undefined),
  );
}

/**
 * An XSUAA destination may state no URL: its token is for the services that
 * trust the XSUAA instance, not for one system. The token API with a
 * consumer's provider still requires a `serviceUrl` (the 3.x order),
 * so the broker's view of the key store answers a placeholder — never written
 * to the destination, and no binding is computed from it (it does not parse).
 */
const PLACEHOLDER_SERVICE_URL = '<SERVICE_URL>';
function withPlaceholderUrl(store: IServiceKeyStore): IServiceKeyStore {
  const readCertificate = store.getClientCertificate?.bind(store);
  return {
    ...(readCertificate ? { getClientCertificate: readCertificate } : {}),
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
  const certificateFiles = clientAuthFlags(options);
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
  // The key's certificate client, without its PEM: who the client is and
  // where it authenticates. Read only with `--client-auth certificate`.
  let keyCertificate: {
    uaaUrl: string;
    clientId: string;
    certUrl: string;
  } | null = null;

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
    let certificateKey = false;
    try {
      const json = (await JsonFileHandler.load(
        path.basename(resolvedServiceKeyPath),
        serviceKeyDir,
      )) as Record<string, unknown> | null;
      let effectiveJson = json;
      if (json?.credentials) {
        effectiveJson = json.credentials as Record<string, unknown>;
        // Looked at before anything is written: a key carrying a certificate
        // or a private key is read in place — XsuaaServiceKeyStore unwraps
        // `credentials` itself — so no copy of it exists, even on a failed run.
        certificateKey = carriesCertificate(effectiveJson);
        if (certificateKey) {
          console.log(
            '🔍 Detected "credentials" wrapper with a client certificate -> read in place, never copied',
          );
        } else {
          console.log(
            '🔍 Detected "credentials" wrapper -> unwrapping to temp file',
          );
          const keysDir = path.join(workDir, 'service-keys');
          fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(
            path.join(keysDir, `${destination}.json`),
            JSON.stringify(effectiveJson, null, 2),
            { mode: 0o600 },
          );
          serviceKeyDir = keysDir;
        }
      } else {
        certificateKey = carriesCertificate(effectiveJson);
      }
      rawServiceKeyJson = effectiveJson;
      if (effectiveJson) {
        isAbapFormat = !!effectiveJson.uaa;
      }
    } catch {
      // If parsing fails here, let the store report it below.
    }

    // Only XsuaaServiceKeyStore answers a key's certificate client (it reads
    // `uaa`-nested keys and `abap.url` too).
    const serviceKeyStore =
      isAbapFormat && !certificateKey
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
    if (!options.clientAuth && !keyClient && certificateKey) {
      throw new Error(
        `The service key of ${destination} carries a client certificate and no client secret: state how the client authenticates with --client-auth certificate --cert-path <path> --key-path <path>`,
      );
    }
    if (certificateFiles && serviceKeyStore instanceof XsuaaServiceKeyStore) {
      // The store's refusal of an incomplete certificate client names the
      // key's fields, never a value.
      const client = await serviceKeyStore.getClientCertificate(destination);
      if (client) {
        keyCertificate = {
          uaaUrl: client.uaaUrl,
          clientId: client.clientId,
          certUrl: client.certUrl,
        };
      }
    }
    if (certificateFiles && !keyCertificate) {
      throw new Error(
        `The service key of ${destination} carries no client certificate (url, clientid, certificate, key, certurl): --client-auth certificate needs one`,
      );
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
  if (options.clientAuth === 'secret') {
    console.log(
      `🔏 Client authentication: secret (Basic, ${options.basicEncoding})`,
    );
  } else if (certificateFiles) {
    console.log(
      `🔏 Client authentication: certificate (${certificateFiles.certPath}, ${certificateFiles.keyPath})`,
    );
  }
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
  // A certificate client is written as its paths and `certurl` — never PEM —
  // and the store removes the client secret it replaces (and the reverse).
  const serviceUrl = options.serviceUrl || keyServiceUrl;
  await files.keyStore.setDestination(
    destination,
    completeMeans({
      authType: 'jwt',
      grantType,
      serviceUrl,
      ...(certificateFiles
        ? {
            ...(keyCertificate
              ? {
                  uaaUrl: keyCertificate.uaaUrl,
                  uaaClientId: keyCertificate.clientId,
                  uaaCertUrl: keyCertificate.certUrl,
                }
              : {}),
            uaaClientCertPath: certificateFiles.certPath,
            uaaClientKeyPath: certificateFiles.keyPath,
          }
        : (keyClient ?? {})),
    }),
  );

  // Who the client is, as the destination now states it.
  let client: { uaaUrl: string; uaaClientId: string; certUrl?: string };
  if (certificateFiles) {
    const stated = await files.keyStore.getClientCertificate(destination);
    if (!stated) {
      throw new Error(`Client certificate not found for ${destination}.`);
    }
    client = {
      uaaUrl: stated.uaaUrl,
      uaaClientId: stated.clientId,
      certUrl: stated.certUrl,
    };
  } else {
    const authConfig = await files.keyStore.getAuthorizationConfig(destination);
    if (
      !authConfig ||
      !present(authConfig.uaaUrl) ||
      !present(authConfig.uaaClientSecret)
    ) {
      throw new Error(
        `Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields; a client certificate needs --client-auth certificate.`,
      );
    }
    client = authConfig;
  }

  if (!options.credential) {
    // A preview only: the strategy binds the port and assembles the URL.
    const redirectUri = `http://localhost:${options.redirectPort ?? DEFAULT_CALLBACK_PORT}/callback`;
    console.log(
      `🔗 Authorization URL: ${client.uaaUrl}/oauth/authorize?client_id=${encodeURIComponent(client.uaaClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`,
    );
    console.log(`📍 Redirect URI: ${redirectUri}`);
  }

  // The user's choice as the broker's strategy; none without `--client-auth`.
  let clientAuthentication: ClientAuthenticationStrategy | undefined;
  if (certificateFiles) {
    clientAuthentication = fromServiceKeyCertificate();
  } else if (options.clientAuth === 'secret') {
    clientAuthentication = fromServiceKeySecret({
      encoding: options.basicEncoding as 'raw' | 'form',
    });
  }

  // This command's own provider, built by the broker's factory form from the
  // client the destination states and the refresh token its session holds —
  // with `--client-auth`, from the strategy's answer and the client identity
  // the factory's fourth argument carries, and no client secret.
  const broker = new AuthBroker({
    sessionStore: files.sessionStore,
    serviceKeyStore:
      options.authType === 'xsuaa'
        ? withPlaceholderUrl(files.keyStore)
        : files.keyStore,
    clientAuthentication,
    provider: (_destination, auth, _connection, stated) => {
      if (clientAuthentication) {
        // A stated choice never falls back to the secret.
        if (
          !stated?.clientAuthentication ||
          !present(stated.uaaUrl) ||
          !present(stated.clientId)
        ) {
          throw new Error(`Missing client authentication for ${destination}`);
        }
        const authenticated = {
          uaaUrl: stated.uaaUrl,
          clientId: stated.clientId,
          clientAuthentication: stated.clientAuthentication,
        };
        return options.credential
          ? new ClientCredentialsProvider(authenticated)
          : new AuthorizationCodeProvider({
              ...authenticated,
              refreshToken: stated.refreshToken,
              authorization: authorization(options),
            });
      }
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
    // A certificate client is no secret client, so the stores' JSON view
    // leaves it out: its identity, paths and `certurl` are added — never PEM.
    writeJsonFile(resolvedOutputPath, {
      ...(await jsonOutput(files, destination, {})),
      ...(certificateFiles
        ? {
            uaaUrl: client.uaaUrl,
            uaaClientId: client.uaaClientId,
            uaaClientCertPath: certificateFiles.certPath,
            uaaClientKeyPath: certificateFiles.keyPath,
            uaaCertUrl: client.certUrl,
          }
        : {}),
    });
    console.log(`✅ JSON file created: ${resolvedOutputPath}`);
  }
  return 0;
}
