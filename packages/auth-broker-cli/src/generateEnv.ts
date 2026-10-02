/**
 * What the `generate-env` development script does, importable by tests.
 *
 * It writes a destination from a SAP service key to the session path: the
 * means — `jwt`, the grant `--grant` states, the key's client and URL —
 * through the destination store's own write method, then a login through the
 * provider the broker builds for that destination, whose secret reaches the
 * session store through the broker's persistence. The grant is never read from
 * the key (H1): a key holds a client, and a client may serve several grants.
 *
 * Like the commands, it works on a copy in a private directory and replaces
 * the session file only once `flush()` reports the secret stored: a refused or
 * cancelled login, or a secret the store did not take, leaves the file byte
 * for byte as it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  XsuaaServiceKeyStore,
} from '@mcp-abap-adt/auth-stores';
import {
  completeMeans,
  flushed,
  openDestination,
  writeOutputFile,
} from './destination';
import type { AuthorizationStrategy } from './runMcpAuth';

/** The grants a SAP service key's client alone serves. */
const GRANTS = ['authorization_code', 'client_credentials'] as const;
export type GenerateEnvGrant = (typeof GRANTS)[number];

export const GENERATE_ENV_USAGE =
  'Usage: generate-env-from-service-key <destination> [service-key-path] [session-path] --grant <authorization_code|client_credentials>';

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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--grant') {
      grant = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
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

  const destination = positional[0];
  const resolvedServiceKeyPath = path.resolve(
    positional[1] || path.join(process.cwd(), `${destination}.json`),
  );
  const resolvedSessionPath = path.resolve(
    positional[2] || path.join(process.cwd(), `${destination}.env`),
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
  const rawServiceKey = JSON.parse(
    fs.readFileSync(resolvedServiceKeyPath, 'utf8'),
  ) as Record<string, unknown>;
  const isXsuaa = !rawServiceKey.uaa;
  const serviceKeyStore = isXsuaa
    ? new XsuaaServiceKeyStore(serviceKeyDir)
    : new AbapServiceKeyStore(serviceKeyDir);

  const client = await serviceKeyStore.getAuthorizationConfig(destination);
  if (!client) {
    console.error(`❌ Missing authorization config for ${destination}`);
    return 1;
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
  await files.keyStore.setDestination(
    destination,
    completeMeans({
      authType: 'jwt',
      grantType: grant as GenerateEnvGrant,
      serviceUrl,
      uaaUrl: client.uaaUrl,
      uaaClientId: client.uaaClientId,
      uaaClientSecret: client.uaaClientSecret,
    }),
  );

  const broker = new AuthBroker({
    sessionStore: files.sessionStore,
    serviceKeyStore: files.keyStore,
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
