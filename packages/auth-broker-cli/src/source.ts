/**
 * Where a run's destination comes from — three sources, one per run (§10.1,
 * D25), the same for every subcommand:
 *
 * - `--service-key <path>`: always a new pair. The means come from the key;
 *   no session is read — not even an existing `--output` file — so every run
 *   logs in and writes a new token and refresh token to `--output`.
 * - `--env <path>`: the session file at that path, anywhere. It holds the
 *   means and the session; the broker's `getToken` with `refreshThenLogin()`
 *   decides — a valid token bound to the means used with no request, an
 *   expired one refreshed, else a login. The result is written back to that
 *   path, or to `--output` when given.
 * - `--destination <name>`: `<dir>/sessions/<name>.env` when it exists
 *   (handled as `--env`), else `<dir>/service-keys/<name>.json` (handled as
 *   `--service-key`, its session written to `<dir>/sessions/<name>.env`).
 *   `<dir>` is `--destination-dir`; else the environment variable
 *   `AUTH_BROKER_PATH` — one or several base folders separated by `;`, and on
 *   Unix also `:`, the destination read from the first folder that holds it
 *   and a new session written to the first folder; else the standard folder,
 *   `~/.config/mcp-abap-adt` on Unix and `<home>/Documents/mcp-abap-adt` on
 *   Windows.
 *
 * `AUTH_BROKER_PATH` is the one environment variable the CLI reads, and only
 * for `--destination` without `--destination-dir`. Every text here is read by
 * plain string code: no regular expression runs over a path or the variable.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageError } from './subcommandArgs';

/** The three source flags, and `--destination-dir`, as given. */
export interface SourceFlags {
  serviceKeyPath?: string | undefined;
  envFilePath?: string | undefined;
  destination?: string | undefined;
  destinationDir?: string | undefined;
}

/** What `--destination` reads of the process: stated, so tests state their own. */
export interface SourceEnvironment {
  /** `AUTH_BROKER_PATH`, as the process holds it; `undefined` when unset. */
  authBrokerPath: string | undefined;
  /** The user's home folder. */
  home: string;
  /** `process.platform`: which standard folder, which separators. */
  platform: string;
}

/** The process's own: read only when `--destination` needs a folder. */
export function processEnvironment(): SourceEnvironment {
  return {
    authBrokerPath: process.env.AUTH_BROKER_PATH,
    home: os.homedir(),
    platform: process.platform,
  };
}

const SOURCE_FLAGS = [
  ['--service-key', 'serviceKeyPath'],
  ['--env', 'envFilePath'],
  ['--destination', 'destination'],
] as const;

const ONE_OF = 'give one of --service-key, --env and --destination';

/**
 * The parse-time rules: at most one source — exactly one when `required` —
 * `--destination-dir` only beside `--destination`, and a destination that is
 * a name, never a path. A refusal names the flags.
 */
export function checkSourceFlags(
  flags: SourceFlags,
  { required }: { required: boolean },
): void {
  const given = SOURCE_FLAGS.filter(
    ([, field]) => flags[field] !== undefined,
  ).map(([flag]) => flag);
  if (given.length === 2) {
    throw new UsageError(
      `${given[0]} and ${given[1]} are two sources: ${ONE_OF}`,
    );
  }
  if (given.length === 3) {
    throw new UsageError(
      `--service-key, --env and --destination are three sources: ${ONE_OF}`,
    );
  }
  if (given.length === 0 && required) {
    throw new UsageError(
      'a source is required: --service-key <path>, --env <path> or --destination <name>',
    );
  }
  if (flags.destinationDir !== undefined && flags.destination === undefined) {
    throw new UsageError('--destination-dir applies only to --destination');
  }
  if (
    flags.destination !== undefined &&
    !isDestinationName(flags.destination)
  ) {
    throw new UsageError('--destination needs a destination name, not a path');
  }
}

/** A name a file is made of: not empty, no separator, not `.` or `..`. */
function isDestinationName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/**
 * The standard folder, stated per platform: `<home>/Documents/mcp-abap-adt`
 * on Windows, `<home>/.config/mcp-abap-adt` everywhere else.
 */
export function standardFolder(platform: string, home: string): string {
  return platform === 'win32'
    ? path.win32.join(home, 'Documents', 'mcp-abap-adt')
    : path.posix.join(home, '.config', 'mcp-abap-adt');
}

/**
 * `AUTH_BROKER_PATH` as its base folders: split on `;`, and on Unix also on
 * `:` (never on Windows, where a drive letter holds one), each part trimmed,
 * empty parts dropped. One pass over the text, no regular expression.
 */
export function splitBasePaths(value: string, platform: string): string[] {
  const colonSeparates = platform !== 'win32';
  const parts: string[] = [];
  let current = '';
  for (const character of value) {
    if (character === ';' || (colonSeparates && character === ':')) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The base folders `--destination` looks in, in order: `--destination-dir`;
 * else `AUTH_BROKER_PATH`'s folders; else the standard folder.
 */
export function destinationBases(
  flags: Pick<SourceFlags, 'destinationDir'>,
  environment: SourceEnvironment,
): string[] {
  if (flags.destinationDir !== undefined) {
    return [path.resolve(flags.destinationDir)];
  }
  const listed =
    environment.authBrokerPath === undefined
      ? []
      : splitBasePaths(environment.authBrokerPath, environment.platform);
  if (listed.length > 0) {
    return listed.map((folder) => path.resolve(folder));
  }
  return [standardFolder(environment.platform, environment.home)];
}

/** What a run reads and where it writes, once its source is resolved. */
export type RunSource =
  | {
      kind: 'service-key';
      /** The service key, an absolute path. */
      serviceKeyPath: string;
      /** The destination's name: the key's file name. */
      destination: string;
      /** Where the session is written: `--output`, else the destination's default. */
      output: string | undefined;
    }
  | {
      kind: 'session';
      /** The session file, an absolute path: read, and written back by default. */
      sessionPath: string;
      /** The destination's name: the session file's name. */
      destination: string;
      /** `--output` when given, else the session file itself. */
      output: string;
      /** The flag that named it, for a refusal: `--env` or `--destination`. */
      flag: '--env' | '--destination';
    };

function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

/** A file's name without its extension. */
function nameOf(file: string): string {
  return path.basename(file, path.extname(file));
}

/**
 * The run's source, resolved against the file system: `undefined` when none
 * was given (a subcommand that states its means by flags). `environment` is
 * asked for only by `--destination` without `--destination-dir`.
 */
export function resolveSource(
  flags: SourceFlags,
  outputFile: string | undefined,
  environment: () => SourceEnvironment,
): RunSource | undefined {
  checkSourceFlags(flags, { required: false });
  const output =
    outputFile === undefined ? undefined : path.resolve(outputFile);
  if (flags.serviceKeyPath !== undefined) {
    const serviceKeyPath = path.resolve(flags.serviceKeyPath);
    return {
      kind: 'service-key',
      serviceKeyPath,
      destination: nameOf(serviceKeyPath),
      output,
    };
  }
  if (flags.envFilePath !== undefined) {
    const sessionPath = path.resolve(flags.envFilePath);
    if (!isFile(sessionPath)) {
      throw new UsageError(`--env: no session file at ${sessionPath}`);
    }
    return {
      kind: 'session',
      sessionPath,
      destination: nameOf(sessionPath),
      output: output ?? sessionPath,
      flag: '--env',
    };
  }
  const name = flags.destination;
  if (name === undefined) return undefined;
  // The process is read only when no folder was given.
  const bases =
    flags.destinationDir === undefined
      ? destinationBases({}, environment())
      : [path.resolve(flags.destinationDir)];
  for (const base of bases) {
    const sessionPath = path.join(base, 'sessions', `${name}.env`);
    if (isFile(sessionPath)) {
      return {
        kind: 'session',
        sessionPath,
        destination: name,
        output: output ?? sessionPath,
        flag: '--destination',
      };
    }
    const serviceKeyPath = path.join(base, 'service-keys', `${name}.json`);
    if (isFile(serviceKeyPath)) {
      return {
        kind: 'service-key',
        serviceKeyPath,
        destination: name,
        // A new session goes to the first folder.
        output:
          output ?? path.join(bases[0] as string, 'sessions', `${name}.env`),
      };
    }
  }
  throw new UsageError(
    `--destination: ${name} is in none of ${bases.join(', ')} (sessions/${name}.env, service-keys/${name}.json)`,
  );
}
