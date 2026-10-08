/**
 * What `mcp-auth` does once its arguments are parsed, importable by tests.
 *
 * A run writes a complete destination: first its means — `jwt`, the
 * grant (`authorization_code`, or `client_credentials` with `--credential`), the
 * client and `serviceUrl` from the service key — through the key store's own
 * write method; then the login through the broker's token API with no
 * provider of its own: the broker's UAA row obtains the token and writes the
 * secret — the secret alone — to the session store, bound to the means, so an
 * `--env` rerun is seeded from it and a server's `getProvider` over the
 * output reuses it. `flush()` before the output is written.
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
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  DEFAULT_CALLBACK_PORT,
  refreshThenLogin,
  type staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import {
  JsonFileHandler,
  XsuaaServiceKeyStore,
} from '@mcp-abap-adt/auth-stores';
import type { IBrowser } from '@mcp-abap-adt/interfaces-auth';
import {
  BROWSER_NAMES,
  type BrowserFactories,
  BrowserUsageError,
  browserFor,
  browserProgramFor,
  isBrowserName,
  SHIPPED_BROWSERS,
} from './browser';
import {
  carriesCertificate,
  certificateNeedsFlag,
  clientAuthenticationStrategy,
  clientAuthFlags,
  noCertificateClient,
  present,
  serviceKeyStoreFor,
} from './clientAuthentication';
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
  serviceKeyPath?: string | undefined; // Optional if env file is provided
  envFilePath?: string | undefined;
  outputFile: string;
  authType: 'abap' | 'xsuaa';
  /** `--browser`: a name of the CLI's table (default `'auto'`), never a program. */
  browser: string;
  /** `--browser-program`: the program to run as given; excludes `--browser`. */
  browserProgram?: string | undefined;
  credential: boolean; // Use client_credentials instead of authorization_code
  format: 'json' | 'env';
  serviceUrl?: string | undefined;
  // The callback port is the provider's own choice (`auth-providers`'
  // DEFAULT_CALLBACK_PORT); this only overrides it when the user asks.
  redirectPort?: number | undefined;
  /**
   * How the client authenticates (`--client-auth`). Absent: the client
   * secret in the token request, as 2.0.0.
   */
  clientAuth?: 'certificate' | 'secret' | undefined;
  /** `--basic-encoding`: required with `clientAuth: 'secret'`, nowhere else. */
  basicEncoding?: 'raw' | 'form' | undefined;
  /** `--cert-path` / `--key-path`: required with `clientAuth: 'certificate'`. */
  certPath?: string | undefined;
  keyPath?: string | undefined;
}

/**
 * The browser a run states, for `platform`: `--browser-program` (its own
 * option) as given, else `--browser` through the CLI's table; `undefined` for
 * `none` / `headless`. Throws `BrowserUsageError` for a name the table does
 * not hold, or a launcher `platform` has none of. Reads and launches nothing.
 */
export function mcpAuthBrowser(
  options: Pick<McpAuthOptions, 'browser' | 'browserProgram'>,
  platform: string = process.platform,
  factories: BrowserFactories = SHIPPED_BROWSERS,
): IBrowser | undefined {
  if (options.browserProgram !== undefined) {
    return browserProgramFor(options.browserProgram, platform, factories);
  }
  if (!isBrowserName(options.browser)) {
    throw new BrowserUsageError(
      `--browser must be one of: ${BROWSER_NAMES.join(', ')}`,
    );
  }
  return browserFor(options.browser, platform, factories);
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
  /** The platform the browser is mapped for; `process.platform` when absent. */
  platform?: string | undefined;
}

/** Runs `mcp-auth`; resolves the exit code. Usage errors exit the process. */
export async function runMcpAuth(
  options: McpAuthOptions,
  { workDir, authorization, platform }: McpAuthContext,
): Promise<number> {
  // The browser is mapped only for the login that opens one — the
  // authorization code login — and then before anything is read or written:
  // a name this platform has no launcher for is a usage error, never a
  // guess. `--credential` opens none, so nothing is mapped or refused.
  if (!options.credential) {
    mcpAuthBrowser(options, platform ?? process.platform);
  }
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
    let json: Record<string, unknown> | null;
    try {
      json = (await JsonFileHandler.load(
        path.basename(resolvedServiceKeyPath),
        serviceKeyDir,
      )) as Record<string, unknown> | null;
    } catch {
      // Fixed words, before anything is written: the reader's message quotes
      // the file, which holds a client secret or a private key.
      throw new Error(
        `The service key ${resolvedServiceKeyPath} cannot be read as JSON`,
      );
    }
    try {
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
      // Unwrapping failed: the store reports what it cannot read below.
    }

    // A key carrying a certificate is read by XsuaaServiceKeyStore, whatever
    // its format: the one store that answers its certificate client.
    const serviceKeyStore = serviceKeyStoreFor(
      serviceKeyDir,
      isAbapFormat,
      rawServiceKeyJson,
    );
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
      throw new Error(certificateNeedsFlag(destination));
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
      throw new Error(noCertificateClient(destination));
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
    console.log(
      `🌐 Browser: ${options.browserProgram === undefined ? options.browser : `program ${options.browserProgram}`}`,
    );
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
  const clientAuthentication = clientAuthenticationStrategy(options);

  // The provider is the broker's UAA row (§10.2), the same composition a
  // server's getProvider builds over the output: the client the destination
  // states — with `--client-auth`, the strategy's answer and no client secret
  // — seeded from an `--env` session only when it is bound to these means. It
  // renews as this CLI states (a refresh, then a login: a user at a terminal
  // can log in), and a secret the store did not take fails the run.
  const broker = new AuthBroker({
    renewal: () => refreshThenLogin(),
    onWriteFailure: 'fail',
    sessionStore: files.sessionStore,
    serviceKeyStore: files.keyStore,
    clientAuthentication,
    // Asked only for the authorization_code row; `--credential` logs in
    // with the client alone.
    authorization: () => authorization(options),
  });

  console.log(`🔐 Getting token for destination "${destination}"...`);
  // Whether the login threw, beside what it threw: a falsy value thrown
  // (undefined, 0, '') is a failure too.
  let failed = false;
  let obtainError: unknown;
  try {
    await broker.getToken(destination);
    console.log(`✅ Token obtained successfully`);
  } catch (error) {
    // A failed login, or a token obtained whose write failed: either way the
    // run fails, after one more attempt at any write still pending.
    failed = true;
    obtainError = error;
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
