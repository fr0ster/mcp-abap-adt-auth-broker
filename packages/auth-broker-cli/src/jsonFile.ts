/**
 * Reading a JSON file the user names — a service key, a provider config —
 * which may hold a client secret or a private key. A failure is refused in
 * fixed words: Node's `JSON.parse` message quotes bytes of the file, so no
 * message, cause or stack of the original error is passed on.
 */

import * as fs from 'node:fs';
import { UsageError } from './subcommandArgs';

/** The file's JSON; refused as "<what> <file> cannot be read as JSON". */
export function readJsonFile(file: string, what: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new UsageError(`${what} ${file} cannot be read as JSON`);
  }
}
