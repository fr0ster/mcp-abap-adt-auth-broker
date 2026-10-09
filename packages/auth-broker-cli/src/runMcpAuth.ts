/**
 * What `mcp-auth` does once its arguments are parsed, importable by tests.
 *
 * A run writes a complete destination: first its means — `jwt`, the
 * grant (`authorization_code`, or `client_credentials` with `--credential`), the
 * client and `serviceUrl` from the service key — through the key store's own
 * write method; then the login through the broker's token API with no
 * provider of its own: the broker's UAA row obtains the token and writes the
 * secret — the secret alone — to the session store, bound to the means, so a
 * later `--env` run and a server's `getProvider` over the output reuse it.
 * `flush()` before the output is written.
 *
 * The run's source (D25, `source.ts`): `--service-key` writes the means and
 * always logs in, reading no session; `--env` (or `--destination` finding a
 * session) takes the means and session from that file and lets the broker
 * reuse, refresh or log in, written back to the file unless `--output` is
 * given.
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
  browserCallbackStrategy,
  refreshThenLogin,
  type staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import { JsonFileHandler } from '@mcp-abap-adt/auth-stores';
import type { IBrowser } from '@mcp-abap-adt/interfaces-auth';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
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
  readCertificateClient,
  serviceKeyStoreFor,
} from './clientAuthentication';
import { asContract } from './contractShape';
import {
  authenticatedJsonOutput,
  basicEncodingVariable,
  completeMeans,
  flushed,
  openDestination,
  setFileVariable,
  writeJsonFile,
  writeOutputFile,
} from './destination';
import { progress } from './output';
import { sessionClientAuth } from './sessionClientAuth';
import {
  noGrantRefusal,
  processEnvironment,
  type RunSource,
  resolveSource,
  type SourceEnvironment,
} from './source';
import { UsageError } from './subcommandArgs';

/** An interactive strategy, as auth-providers' strategy factories return one. */
export type AuthorizationStrategy = ReturnType<typeof staticCodeStrategy>;

export interface McpAuthOptions {
  /** `--service-key`: always a new pair by login (D25). */
  serviceKeyPath?: string | undefined;
  /** `--env`: the session file — its means and session, written back (D25). */
  envFilePath?: string | undefined;
  /** `--destination`: a destination of the standard folder (D25). */
  destination?: string | undefined;
  /** `--destination-dir`: the folder `--destination` reads. */
  destinationDir?: string | undefined;
  /** `--output`: required with `--service-key`; else the session file itself. */
  outputFile?: string | undefined;
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
  /** `--verbose`: the CLI's logger from `debug`. */
  verbose?: true | undefined;
  /** `--auth-debug`: the broker's `authDebug: true`; implies `--verbose`. */
  authDebug?: true | undefined;
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
  /**
   * The CLI's logger (stderr): the broker's, and so the providers' it
   * builds. Absent: the broker logs nothing.
   */
  logger?: ILogger | undefined;
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
  /**
   * The interactive strategy of the authorization code login, stated by the
   * caller — the bin builds the browser callback from `--browser` and
   * `--redirect-port` — given the run's signal, which ends its login. Not
   * called for `--credential`.
   */
  authorization: (
    options: McpAuthOptions,
    signal: AbortSignal | undefined,
  ) => AuthorizationStrategy;
  /**
   * The run's signal (`underInterrupt`): every wait of the run takes it —
   * the broker's calls and the strategy. Absent: nothing ends the login but
   * its result.
   */
  signal?: AbortSignal | undefined;
  /** The platform the browser is mapped for; `process.platform` when absent. */
  platform?: string | undefined;
  /**
   * Where `--destination` looks (`AUTH_BROKER_PATH`, the home folder, the
   * platform); the process's own when absent, read only when needed.
   */
  environment?: SourceEnvironment | undefined;
}

/**
 * The authorization code login's strategy, as the bin composes it: the browser
 * callback on `--redirect-port` (the strategy's own default when not given),
 * the browser `--browser` / `--browser-program` state, ended by `signal` —
 * the run's — and by nothing else: no bound.
 */
export function authCodeStrategy(
  options: McpAuthOptions,
  signal: AbortSignal | undefined,
  platform: string = process.platform,
): AuthorizationStrategy {
  return browserCallbackStrategy(
    asContract<Parameters<typeof browserCallbackStrategy>[0]>({
      browser: mcpAuthBrowser(options, platform),
      port: options.redirectPort,
      signal,
    }),
  );
}

/** The grants `mcp-auth [auth-code]` runs, and the subcommand of every other. */
const SUBCOMMAND_OF_GRANT: Record<string, string> = {
  authorization_code: 'auth-code',
  client_credentials: 'auth-code',
  oidc_authorization_code: 'oidc',
  device_code: 'oidc',
  password: 'oidc',
  passcode: 'oidc',
  token_exchange: 'oidc',
  saml2_pure: 'saml2-pure',
  none: 'saml2-pure',
  saml2_bearer: 'saml2-bearer',
};

/**
 * The flags that state means: a session source holds its own (D25), so each
 * is refused beside it, named.
 */
function refuseMeansFlags(
  options: McpAuthOptions,
  flag: '--env' | '--destination',
): void {
  // How the client authenticates is the file's too (D25): its certificate
  // paths, or the Basic encoding it records.
  const stated = [
    ['--credential', options.credential],
    ['--service-url', options.serviceUrl !== undefined],
    ['--client-auth', options.clientAuth !== undefined],
    ['--basic-encoding', options.basicEncoding !== undefined],
    ['--cert-path', options.certPath !== undefined],
    ['--key-path', options.keyPath !== undefined],
  ] as const;
  for (const [name, given] of stated) {
    if (given) {
      throw new UsageError(
        `${name} and ${flag}: the session file holds the means and is used as it is; state the means with --service-key instead`,
      );
    }
  }
}

export async function runMcpAuth(
  options: McpAuthOptions,
  {
    logger,
    workDir,
    authorization,
    platform,
    signal,
    environment,
  }: McpAuthContext,
): Promise<number> {
  // The run's one source (D25), resolved before anything is read or written.
  const source: RunSource | undefined = resolveSource(
    options,
    options.outputFile,
    () => environment ?? processEnvironment(),
  );
  if (source === undefined) {
    throw new UsageError(
      'a source is required: --service-key <path>, --env <path> or --destination <name>',
    );
  }
  if (source.kind === 'session') {
    refuseMeansFlags(options, source.flag);
    if (options.format === 'json' && options.outputFile === undefined) {
      throw new UsageError(
        '--format json needs --output: the session file is written back as .env',
      );
    }
  }
  if (source.output === undefined) {
    throw new UsageError('--output is required with --service-key');
  }
  // The browser is mapped only for the login that opens one — the
  // authorization code login — and then before anything is read or written:
  // a name this platform has no launcher for is a usage error, never a
  // guess. `--credential` opens none, so nothing is mapped or refused. A
  // session file's grant is known once it is read, below.
  if (source.kind === 'service-key' && !options.credential) {
    mcpAuthBrowser(options, platform ?? process.platform);
  }
  const certificateFiles = clientAuthFlags(options);
  const resolvedOutputPath = source.output;
  const destination = source.destination;

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

  if (source.kind === 'service-key') {
    const resolvedServiceKeyPath = source.serviceKeyPath;
    let serviceKeyDir = path.dirname(resolvedServiceKeyPath);

    if (!fs.existsSync(resolvedServiceKeyPath)) {
      console.error(`❌ Service key file not found: ${resolvedServiceKeyPath}`);
      process.exit(1);
    }
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
      throw new UsageError(
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
          progress(
            '🔍 Detected "credentials" wrapper with a client certificate -> read in place, never copied',
          );
        } else {
          progress(
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
      const auth =
        await serviceKeyStore.store.getAuthorizationConfig(destination);
      if (auth) {
        keyClient = {
          uaaUrl: auth.uaaUrl,
          uaaClientId: auth.uaaClientId,
          uaaClientSecret: auth.uaaClientSecret,
        };
      }
    } catch {
      progress(`ℹ️  Store could not parse service key, using fallback parsing`);
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
        progress(`✅ Constructed auth config from raw service key`);
      }
    }
    try {
      keyServiceUrl = (
        await serviceKeyStore.store.getConnectionConfig(destination)
      )?.serviceUrl;
    } catch {
      // For XSUAA, serviceUrl is optional and may not exist in the key.
    }
    if (!options.clientAuth && !keyClient && certificateKey) {
      throw new UsageError(certificateNeedsFlag(destination));
    }
    if (certificateFiles && serviceKeyStore.kind === 'xsuaa') {
      // The store's refusal of an incomplete certificate client names the
      // key's fields, never a value.
      const client = await readCertificateClient(
        serviceKeyStore.store,
        destination,
      );
      if (client) {
        keyCertificate = {
          uaaUrl: client.uaaUrl,
          clientId: client.clientId,
          certUrl: client.certUrl,
        };
      }
    }
    if (certificateFiles && !keyCertificate) {
      throw new UsageError(noCertificateClient(destination));
    }
  }

  progress(`📁 Output file: ${resolvedOutputPath}`);
  if (source.kind === 'session') {
    progress(`📁 Session file: ${source.sessionPath}`);
  } else {
    progress(`📁 Service key: ${source.serviceKeyPath}`);
  }
  progress(`🔐 Auth type: ${options.authType}`);

  // The destination in the run's private directory: a session file is copied
  // there — its means and session the broker's to judge — and a service key's
  // run starts from no file at all, so no session is read.
  const files = openDestination(
    workDir,
    destination,
    options.authType,
    source.kind === 'session' ? source.sessionPath : undefined,
  );

  let grantType: 'authorization_code' | 'client_credentials';
  if (source.kind === 'service-key') {
    grantType = options.credential
      ? 'client_credentials'
      : 'authorization_code';
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
    // The Basic encoding, beside the client it applies to: a later --env
    // run reads it back (D25).
    setFileVariable(
      files.file,
      basicEncodingVariable(options.authType),
      options.clientAuth === 'secret' ? options.basicEncoding : undefined,
    );
  } else {
    // The means are the file's: this command runs only its own grants.
    const stated = (await files.keyStore.getConnectionConfig(destination))
      ?.grantType;
    if (stated !== 'authorization_code' && stated !== 'client_credentials') {
      const subcommand =
        stated === undefined ? undefined : SUBCOMMAND_OF_GRANT[stated];
      if (stated === undefined) {
        throw noGrantRefusal(source.sessionPath, options.authType, source.flag);
      }
      throw new UsageError(
        `${source.flag}: the session file states the grant ${stated}${subcommand ? `: run mcp-auth ${subcommand}` : ''}`,
      );
    }
    grantType = stated;
    if (grantType === 'authorization_code') {
      mcpAuthBrowser(options, platform ?? process.platform);
    }
  }
  progress(`🔑 Flow: ${grantType}`);
  // How the client authenticates: the flags with a service key; the file's
  // record with a session file.
  const clientAuth =
    source.kind === 'service-key'
      ? { clientAuth: options.clientAuth, basicEncoding: options.basicEncoding }
      : sessionClientAuth(files.file, options.authType, source.flag);
  if (clientAuth.clientAuth === 'secret') {
    progress(
      `🔏 Client authentication: secret (Basic, ${clientAuth.basicEncoding})`,
    );
  } else if (certificateFiles) {
    progress(
      `🔏 Client authentication: certificate (${certificateFiles.certPath}, ${certificateFiles.keyPath})`,
    );
  } else if (clientAuth.clientAuth === 'certificate') {
    progress(
      '🔏 Client authentication: certificate (the session file names it)',
    );
  }
  if (grantType === 'authorization_code') {
    progress(
      `🌐 Browser: ${options.browserProgram === undefined ? options.browser : `program ${options.browserProgram}`}`,
    );
  }
  progress(`📄 Format: ${options.format}`);
  if (options.serviceUrl) {
    progress(`🔗 Service URL: ${options.serviceUrl}`);
  }

  // The client the destination states, checked before the login: a
  // certificate client, or a secret one.
  if (clientAuth.clientAuth === 'certificate') {
    if (!(await files.keyStore.getClientCertificate(destination))) {
      throw new UsageError(`Client certificate not found for ${destination}.`);
    }
  } else {
    const authConfig = await files.keyStore.getAuthorizationConfig(destination);
    if (
      !authConfig ||
      !present(authConfig.uaaUrl) ||
      !present(authConfig.uaaClientSecret)
    ) {
      throw new UsageError(
        `Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields; a client certificate needs --client-auth certificate.`,
      );
    }
  }

  // The user's choice as the broker's strategy; none without `--client-auth`.
  const clientAuthentication = clientAuthenticationStrategy(clientAuth);

  // The provider is the broker's UAA row (§10.2), the same composition a
  // server's getProvider builds over the output: the client the destination
  // states — with `--client-auth`, the strategy's answer and no client secret
  // — seeded from an `--env` session only when it is bound to these means. It
  // renews as this CLI states (a refresh, then a login: a user at a terminal
  // can log in), and a secret the store did not take fails the run.
  const broker = new AuthBroker(
    {
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      // On only with --auth-debug (§10.7): never from the environment.
      authDebug: options.authDebug === true,
      sessionStore: files.sessionStore,
      serviceKeyStore: files.keyStore,
      clientAuthentication,
      // Asked only for the authorization_code row; `--credential` logs in
      // with the client alone.
      authorization: () => authorization(options, signal),
    },
    logger,
  );

  progress(`🔐 Getting token for destination "${destination}"...`);
  // Whether the login threw, beside what it threw: a falsy value thrown
  // (undefined, 0, '') is a failure too.
  let failed = false;
  let obtainError: unknown;
  try {
    await broker.getToken(destination, { signal });
    progress(`✅ Token obtained successfully`);
  } catch (error) {
    // A failed login, or a token obtained whose write failed: either way the
    // run fails, after one more attempt at any write still pending.
    failed = true;
    obtainError = error;
  }
  const stored = await flushed(broker, signal);
  if (failed) {
    throw obtainError;
  }
  if (!stored) {
    return 1;
  }
  if (options.format === 'env') {
    // An interrupted run writes no output: checked with nothing awaited
    // between the check and the write.
    signal?.throwIfAborted();
    writeOutputFile(files, resolvedOutputPath);
    progress(`✅ .env file created: ${resolvedOutputPath}`);
  } else {
    // A certificate client is no secret client, so the stores' JSON view
    // leaves it out: its identity, paths and `certurl` are added — never PEM.
    // The one authentication-aware export: the paths are the flags' with a
    // service key, the session file's with --env; the Basic encoding likewise.
    const json = await authenticatedJsonOutput(
      files,
      destination,
      {},
      {
        ...clientAuth,
        certPath:
          certificateFiles?.certPath ??
          ('certPath' in clientAuth ? clientAuth.certPath : undefined),
        keyPath:
          certificateFiles?.keyPath ??
          ('keyPath' in clientAuth ? clientAuth.keyPath : undefined),
      },
    );
    // An interrupted run writes no output: checked after the last await.
    signal?.throwIfAborted();
    writeJsonFile(resolvedOutputPath, json);
    progress(`✅ JSON file created: ${resolvedOutputPath}`);
  }
  return 0;
}
