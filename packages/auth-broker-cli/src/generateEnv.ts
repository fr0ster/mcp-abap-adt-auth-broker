/**
 * What the `generate-env` development script does, importable by tests.
 *
 * It writes a destination from a SAP service key to the session path: the
 * means — `jwt`, the grant `--grant` states, the key's client and URL —
 * through the destination store's own write method, then a login through the
 * provider the broker builds for that destination, whose secret reaches the
 * session store through the broker's persistence. The grant is never read from
 * the key: a key holds a client, and a client may serve several grants.
 *
 * Like the commands, it works on a copy in a private directory and replaces
 * the session file only once `flush()` reports the secret stored: a refused or
 * cancelled login, or a secret the store did not take, leaves the file byte
 * for byte as it was.
 *
 * How the client authenticates is the user's statement, never inferred from
 * the key, under the same flags and rules as `mcp-auth`: no `--client-auth`
 * is the client secret, as 2.0.0; `--client-auth secret --basic-encoding
 * raw|form` the secret in a Basic header; `--client-auth certificate
 * --cert-path --key-path` the key's x509 client, whose certificate and key
 * stay in the user's own files — the destination names them by absolute path
 * beside `certurl`, never holds their PEM.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import type { XsuaaServiceKeyStore } from '@mcp-abap-adt/auth-stores';
import type { IBrowser } from '@mcp-abap-adt/interfaces-auth';
import {
  BROWSER_NAMES,
  type BrowserFactories,
  browserFor,
  browserProgramFor,
  isBrowserName,
  SHIPPED_BROWSERS,
} from './browser';
import {
  type ClientAuthFlags,
  carriesCertificate,
  certificateNeedsFlag,
  clientAuthenticationStrategy,
  clientAuthFlags,
  noCertificateClient,
  readCertificateClient,
  serviceKeyStoreFor,
} from './clientAuthentication';
import {
  completeMeans,
  flushed,
  openDestination,
  writeOutputFile,
} from './destination';
import { readJsonFile } from './jsonFile';
import { createCliLogger, printFailure, progress, toStderr } from './output';
import type { AuthorizationStrategy } from './runMcpAuth';
import { UsageError } from './subcommandArgs';

/** The grants a SAP service key's client alone serves. */
const GRANTS = ['authorization_code', 'client_credentials'] as const;
export type GenerateEnvGrant = (typeof GRANTS)[number];

export const GENERATE_ENV_USAGE =
  'Usage: generate-env-from-service-key <destination> [service-key-path] [session-path] --grant <authorization_code|client_credentials> [--verbose] [--auth-debug] [--browser auto|system|chrome|edge|firefox|none|headless | --browser-program <program>] [--client-auth certificate --cert-path <path> --key-path <path> | --client-auth secret --basic-encoding raw|form]';

/** The client authentication flags and the field each one fills. */
const CLIENT_AUTH_FLAGS: Record<string, keyof ClientAuthFlags> = {
  '--client-auth': 'clientAuth',
  '--basic-encoding': 'basicEncoding',
  '--cert-path': 'certPath',
  '--key-path': 'keyPath',
};

export interface GenerateEnvContext {
  /**
   * The interactive strategy of the authorization code grant, stated by the
   * caller, given the browser the run states for this platform (`undefined`:
   * none — the URL is shown on stderr).
   */
  authorization: (browser: IBrowser | undefined) => AuthorizationStrategy;
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
  /** The platform the browser is mapped for; `process.platform` when absent. */
  platform?: string | undefined;
  /** The browser factories; auth-providers' own when absent. */
  browsers?: BrowserFactories | undefined;
}

/** Runs the script; resolves the exit code. */
export async function runGenerateEnv(
  args: string[],
  {
    authorization,
    workDir,
    platform = process.platform,
    browsers = SHIPPED_BROWSERS,
  }: GenerateEnvContext,
): Promise<number> {
  const positional: string[] = [];
  let grant: string | undefined;
  let browserName: string | undefined;
  let browserProgram: string | undefined;
  let verbose = false;
  let authDebug = false;
  const flags: ClientAuthFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // i < args.length: never
    const flag = Object.hasOwn(CLIENT_AUTH_FLAGS, arg)
      ? CLIENT_AUTH_FLAGS[arg]
      : undefined;
    if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--auth-debug') {
      authDebug = true;
    } else if (arg === '--grant') {
      grant = args[i + 1];
      i++;
    } else if (arg === '--browser') {
      browserName = args[i + 1];
      i++;
    } else if (arg === '--browser-program') {
      browserProgram = args[i + 1];
      i++;
    } else if (flag !== undefined) {
      const value = args[i + 1];
      if (value === undefined) {
        console.error(`❌ ${arg} needs a value`);
        console.error(GENERATE_ENV_USAGE);
        return 1;
      }
      flags[flag] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }

  const [destination, serviceKeyPath, sessionPath] = positional;
  if (destination === undefined) {
    console.error(GENERATE_ENV_USAGE);
    return 1;
  }
  if (!grant || !(GRANTS as readonly string[]).includes(grant)) {
    // Stated, never inferred: 3.x read client_credentials from an XSUAA key's
    // URL and authorization_code from anything else.
    console.error(
      `❌ --grant is required: ${GRANTS.join(' or ')}. A service key does not say which grant its destination uses.`,
    );
    console.error(GENERATE_ENV_USAGE);
    return 1;
  }

  // The browser for this platform (2.x: always the system browser; now
  // --browser, default auto), checked before anything is read or written.
  let browser: IBrowser | undefined;
  try {
    if (browserProgram !== undefined) {
      if (browserName !== undefined) {
        throw new UsageError('--browser-program excludes --browser');
      }
      browser = browserProgramFor(browserProgram, platform, browsers);
    } else {
      const name = browserName ?? 'auto';
      if (!isBrowserName(name)) {
        throw new UsageError(
          `--browser must be one of: ${BROWSER_NAMES.join(', ')}`,
        );
      }
      browser = browserFor(name, platform, browsers);
    }
  } catch (error) {
    printFailure(error);
    toStderr(GENERATE_ENV_USAGE);
    return 1;
  }

  // Checked before anything is read or written; the certificate files are
  // resolved to absolute paths, so the destination works from its final place.
  let certificateFiles: ReturnType<typeof clientAuthFlags>;
  try {
    certificateFiles = clientAuthFlags(flags);
  } catch (error) {
    printFailure(error);
    toStderr(GENERATE_ENV_USAGE);
    return 1;
  }

  const resolvedServiceKeyPath = path.resolve(
    serviceKeyPath || path.join(process.cwd(), `${destination}.json`),
  );
  const resolvedSessionPath = path.resolve(
    sessionPath || path.join(process.cwd(), `${destination}.env`),
  );
  const serviceKeyDir = path.dirname(resolvedServiceKeyPath);

  if (!fs.existsSync(resolvedServiceKeyPath)) {
    console.error(`❌ Service key file not found: ${resolvedServiceKeyPath}`);
    return 1;
  }

  progress(`📁 Service key: ${resolvedServiceKeyPath}`);
  progress(`📁 Session file: ${resolvedSessionPath}`);

  // The key's format decides its parser and the file's key names: an ABAP
  // key nests the client under `uaa`, an XSUAA key holds it flat.
  // Read in fixed words: the parser's message would quote the key.
  let rawServiceKey: Record<string, unknown>;
  try {
    rawServiceKey = (readJsonFile(resolvedServiceKeyPath, 'The service key') ??
      {}) as Record<string, unknown>;
  } catch (error) {
    printFailure(error);
    return 1;
  }
  const isXsuaa = !rawServiceKey.uaa;
  // Only the fields' presence: which client authenticates is the user's flag.
  const unwrappedKey = rawServiceKey.credentials ?? rawServiceKey;
  const serviceKeyStore = serviceKeyStoreFor(
    serviceKeyDir,
    !isXsuaa,
    unwrappedKey,
  );

  // The client the destination states: the key's certificate client — who it
  // is and where it authenticates, its PEM dropped — or its secret client.
  let client: {
    uaaUrl: string;
    uaaClientId: string;
    uaaClientSecret?: string;
    uaaCertUrl?: string;
  };
  if (certificateFiles) {
    let certificateClient: Awaited<
      ReturnType<XsuaaServiceKeyStore['getClientCertificate']>
    > = null;
    try {
      // A key the ABAP store reads carries no certificate client: which
      // store was built is recorded, never asked of the object.
      if (serviceKeyStore.kind === 'xsuaa') {
        certificateClient = await readCertificateClient(
          serviceKeyStore.store,
          destination,
        );
      }
    } catch (error) {
      // The fields the store's refusal names, in this CLI's words.
      printFailure(error);
      return 1;
    }
    if (!certificateClient) {
      console.error(`❌ ${noCertificateClient(destination)}`);
      return 1;
    }
    client = {
      uaaUrl: certificateClient.uaaUrl,
      uaaClientId: certificateClient.clientId,
      uaaCertUrl: certificateClient.certUrl,
    };
  } else {
    const secretClient =
      await serviceKeyStore.store.getAuthorizationConfig(destination);
    if (!secretClient) {
      const certificateKey = carriesCertificate(unwrappedKey);
      console.error(
        certificateKey && flags.clientAuth === undefined
          ? `❌ ${certificateNeedsFlag(destination)}`
          : `❌ Missing authorization config for ${destination}${certificateKey ? ': the service key carries no client secret; a client certificate needs --client-auth certificate' : ''}`,
      );
      return 1;
    }
    client = secretClient;
  }
  let serviceUrl: string | undefined;
  try {
    serviceUrl = (await serviceKeyStore.store.getConnectionConfig(destination))
      ?.serviceUrl;
  } catch {
    // An XSUAA key may carry no URL.
  }

  // A copy of the session file, if there is one: it is replaced only below.
  const files = openDestination(
    workDir,
    destination,
    isXsuaa ? 'xsuaa' : 'abap',
    resolvedSessionPath,
  );
  // A certificate client is written as its paths and `certurl` — never PEM —
  // and the store removes the client secret it replaces (and the reverse).
  await files.keyStore.setDestination(
    destination,
    completeMeans({
      authType: 'jwt',
      grantType: grant as GenerateEnvGrant,
      serviceUrl,
      uaaUrl: client.uaaUrl,
      uaaClientId: client.uaaClientId,
      ...(certificateFiles
        ? {
            uaaCertUrl: client.uaaCertUrl,
            uaaClientCertPath: certificateFiles.certPath,
            uaaClientKeyPath: certificateFiles.keyPath,
          }
        : { uaaClientSecret: client.uaaClientSecret }),
    }),
  );

  // The user's choice as the broker's strategy; none without `--client-auth`.
  // This script's own choices, stated: a renewal refreshes, then logs in; a
  // secret the store did not take fails the run.
  const broker = new AuthBroker(
    {
      sessionStore: files.sessionStore,
      serviceKeyStore: files.keyStore,
      clientAuthentication: clientAuthenticationStrategy(flags),
      authorization: () => authorization(browser),
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      // On only with --auth-debug (§10.7): never from the environment.
      authDebug,
    },
    // The script's logger: stderr, from debug with --verbose (or
    // --auth-debug, which implies it), else from info.
    createCliLogger({ verbose: verbose || authDebug }),
  );

  progress(`🔐 Getting token for destination "${destination}" (${grant})`);
  try {
    // Kept: getProvider is typed IAuthProvider, and both grants this script
    // states (authorization_code, client_credentials) build a token provider,
    // which also has getTokens. A runtime check would add a refusal for a
    // provider that cannot be built here.
    const provider = (await broker.getProvider(destination)) as unknown as {
      getTokens: () => Promise<unknown>;
    };
    await provider.getTokens();
  } catch (error) {
    // A provider's failure — of any installed copy of auth-errors — in the
    // words auth-errors renders from its kind and facts; anything else in
    // auth-errors' unfamiliar words, never its message (§10.9).
    printFailure(error, {
      context: 'Login failed',
      operation: 'token-request',
    });
    toStderr(`   ${resolvedSessionPath} is unchanged.`);
    return 1;
  }
  progress(`✅ Token obtained successfully`);

  if (!(await flushed(broker))) {
    toStderr(`   ${resolvedSessionPath} is unchanged.`);
    return 1;
  }
  writeOutputFile(files, resolvedSessionPath, 'the session path');
  progress(`✅ Session file written: ${resolvedSessionPath}`);
  return 0;
}
