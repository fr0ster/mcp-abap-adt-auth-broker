/**
 * What the CLI writes, and where (§10.7–§10.9, D16, D17).
 *
 * - **stdout** carries only what was asked for: `help` and `--version`. Nothing
 *   here writes to it.
 * - **stderr** carries everything else: progress lines, prompts, log lines
 *   (`createCliLogger`) and failures (`printFailure`).
 *
 * A failure is printed in words auth-errors or the broker rendered, or in the
 * CLI's own fixed words — never the `message` or the stack of a foreign value.
 * This is the one module that reads a caught value's `message`, and only of a
 * value it has recognised: a `DestinationConfigError` (by structure, through
 * the broker's `isDestinationConfigError`) or the CLI's own usage error (by its
 * module-private brand, `isUsageError`).
 */

import * as fs from 'node:fs';
import { isDestinationConfigError } from '@mcp-abap-adt/auth-broker';
import {
  isAuthProviderFailure,
  readFailure,
  renderDiagnostics,
} from '@mcp-abap-adt/auth-errors';
import type {
  IAuthProviderError,
  Operation,
} from '@mcp-abap-adt/interfaces-auth';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { isUsageError, UsageError } from './subcommandArgs';

/** Where a line goes: stderr, unless a test states otherwise. */
export type LineWriter = (line: string) => void;

/** One line to stderr (`console.error`: stderr, never stdout). */
export const toStderr: LineWriter = (line) => {
  console.error(line);
};

/** A progress line: stderr, never stdout (D16). */
export function progress(line: string): void {
  toStderr(line);
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

export interface CliLoggerOptions {
  /** `--verbose` (or `--auth-debug`, which implies it): `debug`; else `info`. */
  verbose: boolean;
}

/** `meta` as one line of JSON; nothing when it cannot be rendered. */
function renderMeta(meta: unknown): string {
  if (meta === undefined) return '';
  try {
    const json = JSON.stringify(meta);
    return json === undefined ? '' : ` ${json}`;
  } catch {
    return '';
  }
}

/**
 * The CLI's logger: every level to stderr, from `debug` with `--verbose`,
 * from `info` without it — the providers' prompt lines that go through a
 * logger (where the callback waits, the SSH-tunnel hint, a URL that cannot
 * be shown) are seen by default. No environment variable is read: what it writes
 * is what the command line says (D17). It never throws.
 */
export function createCliLogger(
  { verbose }: CliLoggerOptions,
  write: LineWriter = toStderr,
): ILogger {
  const from = LEVELS.indexOf(verbose ? 'debug' : 'info');
  const line =
    (level: Level) =>
    (message: string, meta?: unknown): void => {
      if (LEVELS.indexOf(level) < from) return;
      try {
        write(`[${level}] ${String(message)}${renderMeta(meta)}`);
      } catch {
        // A line that cannot be written is dropped; the run goes on.
      }
    };
  return {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  };
}

/** An own data property's value; `undefined` for an accessor or a throwing Proxy. */
function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The system codes the CLI names when its own file or network I/O fails —
 * facts, never a message. Anything else is not named.
 */
const SYSTEM_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EROFS',
  'ENOSPC',
  'EEXIST',
  'EMFILE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * ` (CODE)` for a thrown value whose own `code` — or its `cause`'s, as
 * `fetch` reports a network failure — is on `SYSTEM_CODES`; else `''`.
 * Own data properties only, read once each; total.
 */
export function systemCodeOf(thrown: unknown): string {
  for (const holder of [thrown, ownData(thrown, 'cause')]) {
    const code = ownData(holder, 'code');
    if (typeof code === 'string' && SYSTEM_CODES.has(code)) {
      return ` (${code})`;
    }
  }
  return '';
}

/**
 * Whether the CLI can read a file a flag named: `undefined` when it can, else
 * the system code it gave — ` (ENOENT)`, or `''` for one not allowlisted — so a
 * refusal reads `<flag>: <path as given> cannot be read (CODE)`.
 */
export function unreadableFile(file: string): string | undefined {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return undefined;
  } catch (error) {
    return systemCodeOf(error);
  }
}

/** The CLI's refusal of a file a flag named that it cannot read. */
export function cannotReadFile(
  flag: string,
  given: string,
  code: string,
): UsageError {
  return new UsageError(`${flag}: ${given} cannot be read${code}`);
}

/** `❌ reason`, or `❌ reason — hint`; then the diagnostics, when there are any. */
function errorLines(error: IAuthProviderError, lead?: string): string[] {
  const words = error.hint ? `${error.reason} — ${error.hint}` : error.reason;
  const lines = [`❌ ${lead ?? ''}${words}`];
  const diagnostics = renderDiagnostics(error);
  if (diagnostics) lines.push(diagnostics);
  return lines;
}

export interface PrintFailureOptions {
  /** Words before the failure's own (`SAML metadata: `), the CLI's own. */
  context?: string | undefined;
  /** Where the catch was, for a value auth-errors must classify. */
  operation?: Operation | undefined;
}

/**
 * The lines a caught value is printed as (§10.9):
 *
 * - the CLI's own usage error (its brand): its message, fixed words;
 * - a `DestinationConfigError` (its structure): its message — names only —
 *   then, when it carries a provider's error, that error's hint and
 *   diagnostics;
 * - an `AuthProviderFailure` of any copy: `readFailure`'s reason and hint,
 *   then its diagnostics (a foreign copy's are dropped by auth-errors);
 * - anything else: `readFailure(thrown, 'unfamiliar-error')`'s words.
 *
 * Never a stack, never the message of anything else. Total.
 */
export function failureLines(
  thrown: unknown,
  { context, operation }: PrintFailureOptions = {},
): string[] {
  const lead = context === undefined ? '' : `${context}: `;
  try {
    if (isUsageError(thrown)) {
      const message = ownData(thrown, 'message');
      return [`❌ ${lead}${typeof message === 'string' ? message : ''}`];
    }
    if (isDestinationConfigError(thrown)) {
      const message = ownData(thrown, 'message');
      const words =
        typeof message === 'string'
          ? message
          : `Destination "${thrown.destination}": (${thrown.missingFields.join(', ')})`;
      const carried = ownData(thrown, 'error');
      if (carried === undefined) return [`❌ ${lead}${words}`];
      const error = readFailure(carried, operation ?? 'unfamiliar-error');
      const lines = [
        `❌ ${lead}${error.hint ? `${words} — ${error.hint}` : words}`,
      ];
      const diagnostics = renderDiagnostics(error);
      if (diagnostics) lines.push(diagnostics);
      return lines;
    }
    if (isAuthProviderFailure(thrown)) {
      return errorLines(
        readFailure(thrown, operation ?? 'unfamiliar-error'),
        lead,
      );
    }
  } catch {
    // Fall through to the unfamiliar words.
  }
  return errorLines(readFailure(thrown, 'unfamiliar-error'), lead);
}

/** Prints a caught value on stderr, as `failureLines` words it. */
export function printFailure(
  thrown: unknown,
  options: PrintFailureOptions = {},
  write: LineWriter = toStderr,
): void {
  for (const line of failureLines(thrown, options)) write(line);
}

/**
 * The lines of a failed `flush()`: one per destination still pending — its
 * name and the store's failure as auth-errors classified it, the
 * `SessionWriteFailure`'s own words — never the store's message. Anything
 * else `flush()` rejects with is printed as `failureLines` words it.
 */
export function writeFailureLines(thrown: unknown): string[] {
  const failures = ownData(thrown, 'errors');
  if (!Array.isArray(failures) || failures.length === 0) {
    return failureLines(thrown, {
      context: 'The session was not stored',
      operation: 'persisting-tokens',
    });
  }
  return failures.map((failure: unknown) => {
    const destination = ownData(failure, 'destination');
    const error = readFailure(failure, 'persisting-tokens');
    const words = error.hint ? `${error.reason} — ${error.hint}` : error.reason;
    return typeof destination === 'string'
      ? `❌ The session was not stored: "${destination}": ${words}`
      : `❌ The session was not stored: ${words}`;
  });
}
