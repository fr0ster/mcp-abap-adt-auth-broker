/**
 * The destination a command writes: its means and its secret, each through its
 * own store, in one `<destination>.env` file.
 *
 * - **The means** — `authType`, `grantType`, the grant's data, the client, the
 *   URL — go through `EnvDestinationStore.setDestination`, the key store's own
 *   write method (the store contract is read-only).
 * - **The secret** — the token or cookies, their expiry, the refresh token, and
 *   what they are bound to — reaches the session store only through the
 *   broker's persistence (`onTokens`, the token API, `flush()`). The one
 *   exception is `mcp-sso saml2 --flow pure --cookie`, whose cookies no
 *   provider obtains: the user handed them over, and the CLI writes them.
 *
 * Both stores touch only their own keys of the file, so one file holds both
 * roles, as the 2.x session file did; a session store refuses means, so a client
 * secret never reaches it.
 *
 * A command works in a private directory of its own (`workDir.ts`) and copies
 * the file to `--output` only once the secret is stored: a failed login, or a
 * secret the store did not take, leaves the output as it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  AbapSessionStore,
  type DestinationMeans,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import type { WithUndefined } from './contractShape';

/** Which key names the destination file uses: `SAP_*` or `XSUAA_*`. */
export type DestinationType = 'abap' | 'xsuaa';

export interface DestinationFiles {
  /** The key store: the destination's means. */
  keyStore: EnvDestinationStore;
  /** The session store: the destination's secret. */
  sessionStore: AbapSessionStore | XsuaaSessionStore;
  /** `<directory>/<destination>.env`, which both stores share. */
  file: string;
}

/**
 * The two stores over `<directory>/<destination>.env`. An existing file named
 * by `--env` is copied there first, so its secret seeds the login and its means
 * are kept where this run does not restate them; the original is never
 * written.
 */
export function openDestination(
  directory: string,
  destination: string,
  type: DestinationType,
  seedFile?: string,
): DestinationFiles {
  const file = path.join(directory, `${destination}.env`);
  if (seedFile && fs.existsSync(seedFile)) {
    fs.copyFileSync(seedFile, file);
  }
  return type === 'xsuaa'
    ? {
        keyStore: new EnvDestinationStore(directory, {
          variables: XSUAA_DESTINATION_VARS,
        }),
        sessionStore: new XsuaaSessionStore(directory),
        file,
      }
    : {
        keyStore: new EnvDestinationStore(directory),
        sessionStore: new AbapSessionStore(directory),
        file,
      };
}

/**
 * The means fields that belong to one way in or another. A command states the
 * ones its own row uses and removes the rest, so a file passed with `--env`
 * that was written for another grant keeps no stale password, subject token or
 * trust. `serviceUrl`, `sapClient` and `language` belong to the system, not to
 * a grant: they stay unless the command states them.
 */
const GRANT_FIELDS = [
  'username',
  'password',
  'sncPartnerName',
  'sncQop',
  'sncLib',
  'sncMyName',
  'oidcIssuerUrl',
  'oidcAuthorizationEndpoint',
  'oidcTokenEndpoint',
  'oidcDeviceAuthorizationEndpoint',
  'oidcScopes',
  'oidcSubjectToken',
  'oidcSubjectTokenType',
  'oidcAudience',
  'oidcActorToken',
  'oidcActorTokenType',
  'samlIdpSsoUrl',
  'samlIdpEntityId',
  'samlIdpCertificates',
  'samlSpEntityId',
  'samlAcsUrl',
  'samlRelayState',
  'samlIdpInitiated',
  'samlClockSkewMs',
  'samlTokenUrl',
] as const satisfies readonly (keyof DestinationMeans)[];

/** The means a command states: a field given as `undefined` is not stated. */
export type StatedMeans = WithUndefined<DestinationMeans>;

/**
 * The write a command makes: what it states, every grant field it does not
 * state removed, and nothing given as `undefined` (a field left out stays).
 */
export function completeMeans(stated: StatedMeans): DestinationMeans {
  const means: Record<string, unknown> = {};
  for (const field of GRANT_FIELDS) {
    means[field] = null;
  }
  for (const [field, value] of Object.entries(stated)) {
    if (value !== undefined) {
      means[field] = value;
    }
  }
  return means as DestinationMeans;
}

/**
 * Waits until every secret the broker obtained is stored. `false` when a write
 * still fails: the command then exits non-zero and writes no output, since the
 * file would lack the secret the login obtained.
 */
export async function flushed(
  broker: AuthBroker,
  report: (line: string) => void,
): Promise<boolean> {
  try {
    await broker.flush();
    return true;
  } catch (error) {
    // The broker's own message names the destination and the store error's
    // class, never what was being written.
    report(
      `❌ The session was not stored: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Copies the destination file to `--output`, creating its directory. */
export function writeOutputFile(files: DestinationFiles, output: string): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(files.file, output);
}

/**
 * The `--format json` output: what the stores hold for the destination, under
 * the 1.x names. A public client's `''` secret is left out; so is a field the
 * stores do not hold.
 */
export async function jsonOutput(
  files: DestinationFiles,
  destination: string,
  options: { tokenType?: boolean },
): Promise<Record<string, unknown>> {
  const means = await files.keyStore.getConnectionConfig(destination);
  const client = await files.keyStore.getAuthorizationConfig(destination);
  const secret = await files.sessionStore.loadSession(destination);
  const cookies = secret?.sessionCookies;
  const output: Record<string, unknown> = {};
  if (options.tokenType) {
    output.tokenType = cookies ? 'saml' : 'jwt';
  }
  if (cookies) {
    output.sessionCookies = cookies;
  } else if (secret?.authorizationToken) {
    output.accessToken = secret.authorizationToken;
  }
  const fields: [string, unknown][] = [
    ['refreshToken', secret?.refreshToken],
    ['serviceUrl', means?.serviceUrl],
    ['uaaUrl', client?.uaaUrl],
    ['uaaClientId', client?.uaaClientId],
    ['uaaClientSecret', client?.uaaClientSecret],
  ];
  for (const [name, value] of fields) {
    if (typeof value === 'string' && value !== '') {
      output[name] = value;
    }
  }
  return output;
}

export function writeJsonFile(
  output: string,
  data: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}
