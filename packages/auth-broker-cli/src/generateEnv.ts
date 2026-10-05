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
import { XsuaaServiceKeyStore } from '@mcp-abap-adt/auth-stores';
import {
  type ClientAuthFlags,
  carriesCertificate,
  certificateNeedsFlag,
  clientAuthenticationStrategy,
  clientAuthFlags,
  noCertificateClient,
  serviceKeyStoreFor,
} from './clientAuthentication';
import {
  completeMeans,
  flushed,
  openDestination,
  writeOutputFile,
} from './destination';
import { readJsonFile } from './jsonFile';
import type { AuthorizationStrategy } from './runMcpAuth';

/** The grants a SAP service key's client alone serves. */
const GRANTS = ['authorization_code', 'client_credentials'] as const;
export type GenerateEnvGrant = (typeof GRANTS)[number];

export const GENERATE_ENV_USAGE =
  'Usage: generate-env-from-service-key <destination> [service-key-path] [session-path] --grant <authorization_code|client_credentials> [--client-auth certificate --cert-path <path> --key-path <path> | --client-auth secret --basic-encoding raw|form]';

/** The client authentication flags and the field each one fills. */
const CLIENT_AUTH_FLAGS: Record<string, keyof ClientAuthFlags> = {
  '--client-auth': 'clientAuth',
  '--basic-encoding': 'basicEncoding',
  '--cert-path': 'certPath',
  '--key-path': 'keyPath',
};

export interface GenerateEnvContext {
  /** The interactive strategy of the authorization code grant, stated by the caller. */
  authorization: () => AuthorizationStrategy;
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
}

/** Runs the script; resolves the exit code. */
export async function runGenerateEnv(
  args: string[],
  { authorization, workDir }: GenerateEnvContext,
): Promise<number> {
  const positional: string[] = [];
  let grant: string | undefined;
  const flags: ClientAuthFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue; // i < args.length: never
    const flag = Object.hasOwn(CLIENT_AUTH_FLAGS, arg)
      ? CLIENT_AUTH_FLAGS[arg]
      : undefined;
    if (arg === '--grant') {
      grant = args[i + 1];
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

  // Checked before anything is read or written; the certificate files are
  // resolved to absolute paths, so the destination works from its final place.
  let certificateFiles: ReturnType<typeof clientAuthFlags>;
  try {
    certificateFiles = clientAuthFlags(flags);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    console.error(GENERATE_ENV_USAGE);
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

  console.log(`📁 Service key: ${resolvedServiceKeyPath}`);
  console.log(`📁 Session file: ${resolvedSessionPath}`);

  // The key's format decides its parser and the file's key names: an ABAP
  // key nests the client under `uaa`, an XSUAA key holds it flat.
  // Read in fixed words: the parser's message would quote the key.
  let rawServiceKey: Record<string, unknown>;
  try {
    rawServiceKey = (readJsonFile(resolvedServiceKeyPath, 'The service key') ??
      {}) as Record<string, unknown>;
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
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
      // A key the ABAP store reads carries no certificate client.
      if (serviceKeyStore instanceof XsuaaServiceKeyStore) {
        certificateClient =
          await serviceKeyStore.getClientCertificate(destination);
      }
    } catch (error) {
      // The store's refusal names the key's fields, never a value.
      console.error(`❌ ${(error as Error).message}`);
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
      await serviceKeyStore.getAuthorizationConfig(destination);
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
    serviceUrl = (await serviceKeyStore.getConnectionConfig(destination))
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
  const broker = new AuthBroker({
    sessionStore: files.sessionStore,
    serviceKeyStore: files.keyStore,
    clientAuthentication: clientAuthenticationStrategy(flags),
    authorization: () => authorization(),
  });

  console.log(`🔐 Getting token for destination "${destination}" (${grant})`);
  try {
    const provider = (await broker.getProvider(destination)) as unknown as {
      getTokens: () => Promise<unknown>;
    };
    await provider.getTokens();
  } catch (error) {
    console.error(
      `❌ Login failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`   ${resolvedSessionPath} is unchanged.`);
    return 1;
  }
  console.log(`✅ Token obtained successfully`);

  if (!(await flushed(broker, (line) => console.error(line)))) {
    console.error(`   ${resolvedSessionPath} is unchanged.`);
    return 1;
  }
  writeOutputFile(files, resolvedSessionPath);
  console.log(`✅ Session file written: ${resolvedSessionPath}`);
  return 0;
}
