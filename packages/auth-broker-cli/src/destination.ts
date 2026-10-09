/**
 * The destination a command writes: its means and its secret, each through its
 * own store, in one `<destination>.env` file.
 *
 * - **The means** — `authType`, `grantType`, the grant's data, the client, the
 *   URL — go through `EnvDestinationStore.setDestination`, the key store's own
 *   write method (the store contract is read-only).
 * - **The secret** — the token or cookies, their expiry, the refresh token, and
 *   what they are bound to — reaches the session store only through the
 *   broker's persistence (the provider's `refreshStatePersistence`, the token
 *   API, `flush()`). The one
 *   exception is `mcp-auth saml2-pure --cookie`, whose cookies no
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
import * as dotenv from 'dotenv';
import type { WithUndefined } from './contractShape';
import {
  type LineWriter,
  systemCodeOf,
  toStderr,
  writeFailureLines,
} from './output';
import { UsageError } from './subcommandArgs';

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
 * The two stores over `<directory>/<destination>.env`. A session file named by
 * `--env` (or found by `--destination`) is copied there first, so the broker
 * judges its session against its means; the original is never written. With
 * no seed the file starts absent — whatever an earlier run left there — so no
 * session is read (a service key always logs in).
 */
export function openDestination(
  directory: string,
  destination: string,
  type: DestinationType,
  seedFile?: string,
): DestinationFiles {
  const file = path.join(directory, `${destination}.env`);
  fs.rmSync(file, { force: true });
  if (seedFile !== undefined && fs.existsSync(seedFile)) {
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
  signal?: AbortSignal | undefined,
  write: LineWriter = toStderr,
): Promise<boolean> {
  try {
    await broker.flush({ signal });
    return true;
  } catch (error) {
    // The run was ended by its signal: no write failed, the caller rethrows.
    if (signal?.aborted) throw error;
    // Each destination still pending, in its SessionWriteFailure's words —
    // the store's error as auth-errors classified it — never the store's
    // message.
    for (const line of writeFailureLines(error)) write(line);
    return false;
  }
}

/**
 * Runs the CLI's own write of `output`; a failure is refused naming `what`
 * (`--output`, the session path), the path the user gave and an allowlisted
 * system code — never the writer's message.
 */
function writing(output: string, what: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    throw new UsageError(
      `${what}: ${output} cannot be written${systemCodeOf(error)}`,
    );
  }
}

/** Copies the destination file to `output`, creating its directory. */
export function writeOutputFile(
  files: DestinationFiles,
  output: string,
  what = '--output',
): void {
  writing(output, what, () => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(files.file, output);
  });
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
  writing(output, '--output', () => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  });
}

/**
 * The variable that records `--basic-encoding` beside the client it applies
 * to (`SAP_UAA_BASIC_ENCODING`, `XSUAA_UAA_BASIC_ENCODING` with `--type
 * xsuaa`): neither store has a field for it, so the CLI writes and reads the
 * one line itself, leaving every other line as it is.
 */
export function basicEncodingVariable(type: DestinationType): string {
  return `${type === 'xsuaa' ? 'XSUAA' : 'SAP'}_UAA_BASIC_ENCODING`;
}

/** Sets `name=value` in `file` (replacing the line, or adding one); `undefined` removes it. */
export function setFileVariable(
  file: string,
  name: string,
  value: string | undefined,
): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const kept = lines.filter((line) => !line.startsWith(`${name}=`));
  if (value !== undefined) kept.push(`${name}=${value}`);
  fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
}

/**
 * The value of `name` in `file` as auth-stores reads it — `dotenv.parse`, the
 * library its stores read `.env` files with: `export`, quoting, comments,
 * whitespace, the last of duplicate assignments. `undefined` when absent.
 */
export function readFileVariable(
  file: string,
  name: string,
): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const variables = dotenv.parse(fs.readFileSync(file));
  return Object.hasOwn(variables, name) ? variables[name] : undefined;
}

/** How a destination's client authenticates, for the JSON export. */
export interface ExportedClientAuth {
  clientAuth?: 'certificate' | 'secret' | undefined;
  basicEncoding?: 'raw' | 'form' | undefined;
  certPath?: string | undefined;
  keyPath?: string | undefined;
}

/**
 * The `--format json` output, aware of how the client authenticates — one
 * export for every runner: what the stores hold (`jsonOutput`), and for a
 * certificate client its identity (UAA URL, client id), both certificate
 * paths and `certurl` (never PEM); for Basic, the encoding.
 */
export async function authenticatedJsonOutput(
  files: DestinationFiles,
  destination: string,
  options: { tokenType?: boolean },
  auth: ExportedClientAuth,
): Promise<Record<string, unknown>> {
  const output = await jsonOutput(files, destination, options);
  if (auth.clientAuth === 'certificate') {
    const certificate = await files.keyStore.getClientCertificate(destination);
    const fields: [string, unknown][] = [
      ['uaaUrl', certificate?.uaaUrl],
      ['uaaClientId', certificate?.clientId],
      ['uaaClientCertPath', auth.certPath],
      ['uaaClientKeyPath', auth.keyPath],
      ['uaaCertUrl', certificate?.certUrl],
    ];
    for (const [name, value] of fields) {
      if (typeof value === 'string' && value !== '') output[name] = value;
    }
  } else if (auth.clientAuth === 'secret' && auth.basicEncoding) {
    output.uaaBasicEncoding = auth.basicEncoding;
  }
  return output;
}
