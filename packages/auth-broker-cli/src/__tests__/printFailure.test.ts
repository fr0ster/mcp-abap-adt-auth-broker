/**
 * §10.9: every failure the CLI prints goes through `printFailure` — words
 * auth-errors, the broker or the CLI rendered, never the message or the stack
 * of a foreign value — and the CLI's sources hold no other way to print one.
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DestinationConfigError } from '@mcp-abap-adt/auth-broker';
import {
  AuthProviderFailure,
  authError,
  readFailure,
} from '@mcp-abap-adt/auth-errors';
import { failureLines, writeFailureLines } from '../output';
import { UsageError } from '../subcommandArgs';

const SECRET = 'FOREIGN-MESSAGE-MARKER-8e21';

/** No stack frame, no foreign message, in any line. */
function expectClean(lines: string[]): void {
  const text = lines.join('\n');
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/\n\s+at /);
  expect(text).not.toContain('.ts:');
}

describe('printFailure', () => {
  it('a failure without diagnostics: ❌ reason — hint, one line', () => {
    const error = authError['request-failed']({
      operation: 'token-request',
      problem: 'refused',
      status: 401 as never,
    });
    const lines = failureLines(new AuthProviderFailure(error));
    expect(lines).toEqual([
      error.hint ? `❌ ${error.reason} — ${error.hint}` : `❌ ${error.reason}`,
    ]);
    expectClean(lines);
  });

  it('a failure with diagnostics: the words, then the diagnostics on their own line', () => {
    const error = authError.snc(
      { problem: 'no-credential', secureLoginClient: false },
      { library: '/opt/sap/libsapcrypto.so' },
    );
    const lines = failureLines(new AuthProviderFailure(error));
    expect(lines[0]).toBe(
      error.hint ? `❌ ${error.reason} — ${error.hint}` : `❌ ${error.reason}`,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('/opt/sap/libsapcrypto.so');
    expectClean(lines);
  });

  it('a context goes before the words', () => {
    const lines = failureLines(
      new AuthProviderFailure(authError.unknown({ operation: 'refresh' })),
      { context: 'Login failed' },
    );
    expect(lines[0]?.startsWith('❌ Login failed: ')).toBe(true);
  });

  describe('a failure of a second copy of auth-errors, loaded from another path', () => {
    let dir: string;
    let second: any;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'auth-errors-copy-'));
      for (const name of ['auth-errors', 'interfaces-auth']) {
        const original = dirname(
          require.resolve(`@mcp-abap-adt/${name}/package.json`),
        );
        cpSync(original, join(dir, 'node_modules', '@mcp-abap-adt', name), {
          recursive: true,
        });
      }
      second = require(
        join(dir, 'node_modules', '@mcp-abap-adt', 'auth-errors'),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('prints the same reason — hint as this copy; its diagnostics dropped', () => {
      const facts = { problem: 'no-credential', secureLoginClient: false };
      const ours = authError.snc(facts as never, {
        library: '/opt/sap/libsapcrypto.so',
      });
      const foreign = new second.AuthProviderFailure(
        second.authError.snc(facts, { library: '/opt/sap/libsapcrypto.so' }),
      );
      const lines = failureLines(foreign);
      expect(lines).toEqual([
        ours.hint ? `❌ ${ours.reason} — ${ours.hint}` : `❌ ${ours.reason}`,
      ]);
      expectClean(lines);
    });
  });

  it('a DestinationConfigError: its message (names only), no error carried', () => {
    const error = new DestinationConfigError('TRIAL', ['uaaUrl'], 'missing');
    expect(failureLines(error)).toEqual([
      '❌ Destination "TRIAL": missing (uaaUrl)',
    ]);
  });

  it("a DestinationConfigError carrying an error: its message, that error's hint, then its diagnostics", () => {
    const snc = authError.snc(
      { problem: 'no-credential', secureLoginClient: false },
      { library: '/opt/sap/libsapcrypto.so' },
    );
    const carried = readFailure(
      new AuthProviderFailure(snc),
      'unfamiliar-error',
    );
    const error = new DestinationConfigError(
      'TRIAL',
      ['sncLib'],
      'the provider refused',
      carried,
    );
    const lines = failureLines(error);
    expect(lines[0]).toBe(
      carried.hint
        ? `❌ Destination "TRIAL": the provider refused: ${carried.reason} (sncLib) — ${carried.hint}`
        : `❌ Destination "TRIAL": the provider refused: ${carried.reason} (sncLib)`,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('/opt/sap/libsapcrypto.so');
    expectClean(lines);
  });

  it("the CLI's own usage error: its fixed words", () => {
    expect(failureLines(new UsageError('--output is required'))).toEqual([
      '❌ --output is required',
    ]);
  });

  it.each([
    ['an Error', () => new Error(SECRET)],
    ['a TypeError with a stack', () => new TypeError(SECRET)],
    [
      'a lookalike usage error',
      () => Object.assign(new Error(SECRET), { name: 'UsageError' }),
    ],
    [
      'a lookalike failure',
      () => ({ name: 'AuthProviderFailure', message: SECRET }),
    ],
    ['a string', () => SECRET],
    ['undefined', () => undefined],
    [
      'a throwing Proxy',
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error(SECRET);
            },
            getOwnPropertyDescriptor: () => {
              throw new Error(SECRET);
            },
          },
        ),
    ],
  ])(
    "anything else (%s): auth-errors' unfamiliar words, never its message",
    (_label, make) => {
      const lines = failureLines(make());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        `❌ ${readFailure(undefined, 'unfamiliar-error').reason}`,
      );
      expectClean(lines);
    },
  );

  it("a failed flush: one line per destination, the SessionWriteFailure's words, never the store's", () => {
    const failure = {
      name: 'SessionWriteFailure',
      destination: 'TRIAL',
      error: readFailure(new Error(SECRET), 'persisting-tokens'),
      message: SECRET,
    };
    const lines = writeFailureLines(
      new AggregateError([failure], `wrapping ${SECRET}`),
    );
    expect(lines).toEqual([
      `❌ The session was not stored: "TRIAL": ${failure.error.reason}`,
    ]);
    expectClean(lines);
    // Not an aggregate: printed as any other failure, with the context.
    const other = writeFailureLines(new Error(SECRET));
    expect(other[0]?.startsWith('❌ The session was not stored: ')).toBe(true);
    expectClean(other);
  });
});

/** The CLI's runtime sources: everything under src outside __tests__. */
const SRC = resolve(__dirname, '..');
const SOURCES = readdirSync(SRC)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

/** The text without comments, so a word in a comment is not code. */
function code(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | undefined;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i += 1;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i = text.indexOf('*/', i + 2);
      i = i === -1 ? text.length : i + 2;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Whether `read` occurs in `body` not as the tail of a longer name (`choice.name`). */
function readsAsWritten(body: string, read: string): boolean {
  const first = read[0] ?? '';
  if (first.toLowerCase() === first.toUpperCase() && first !== '_') {
    return body.includes(read); // `${error}`, `(error as Error)`: no name to extend
  }
  let at = body.indexOf(read);
  while (at !== -1) {
    const before = at === 0 ? '' : (body[at - 1] as string);
    const partOfName =
      before !== '' &&
      (before === '_' ||
        before === '$' ||
        before === '.' ||
        (before >= '0' && before <= '9') ||
        before.toLowerCase() !== before.toUpperCase());
    if (!partOfName) return true;
    at = body.indexOf(read, at + 1);
  }
  return false;
}

/** Whether `name` occurs in `text` as a whole identifier. */
function hasToken(text: string, name: string): boolean {
  const identifier = (c: string | undefined) =>
    c !== undefined &&
    (c === '_' ||
      c === '$' ||
      (c >= '0' && c <= '9') ||
      c.toLowerCase() !== c.toUpperCase());
  let at = text.indexOf(name);
  while (at !== -1) {
    if (!identifier(text[at - 1]) && !identifier(text[at + name.length])) {
      return true;
    }
    at = text.indexOf(name, at + 1);
  }
  return false;
}

/**
 * Every name that holds a caught value: a `catch` binding, a rejection
 * handler's `unknown` parameter, the usual names, and — to a fixpoint — any
 * name assigned from one of them (`obtainError = error`).
 */
function caughtNames(body: string): Set<string> {
  const bound = new Set<string>(['error', 'err', 'e', 'thrown', 'reason']);
  for (const m of body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    bound.add(m[1] as string);
  }
  for (const m of body.matchAll(
    /\(\s*([A-Za-z_$][\w$]*)\s*:\s*unknown\s*\)\s*=>/g,
  )) {
    bound.add(m[1] as string);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of body.matchAll(
      /([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[;,)]/g,
    )) {
      if (bound.has(m[2] as string) && !bound.has(m[1] as string)) {
        bound.add(m[1] as string);
        grew = true;
      }
    }
  }
  return bound;
}

/**
 * Every call that prints: a `console` or logger method (`.log`, `.info`,
 * `.warn`, `.error`, `.debug`), a stream `.write`, `toStderr`, `progress`,
 * `write` — with its whole argument text, parentheses balanced.
 */
function printingCalls(body: string): { callee: string; argument: string }[] {
  const calls: { callee: string; argument: string }[] = [];
  for (const m of body.matchAll(
    /(\.(?:log|info|warn|error|debug|write)|\btoStderr|\bprogress|\bwrite)\s*\(/g,
  )) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    let quote: string | undefined;
    while (i < body.length && depth > 0) {
      const c = body[i] as string;
      if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = undefined;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    calls.push({ callee: m[1] as string, argument: body.slice(start, i - 1) });
  }
  return calls;
}

/** The code of an argument: string text dropped, a template's `${…}` kept. */
function withoutStringText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'" || c === '"') {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      out += '""';
    } else if (c === '`') {
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '$' && text[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            if (depth > 0) out += text[i];
            i += 1;
          }
          out += ' ';
        } else i += 1;
      }
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

describe('sources (CLI src)', () => {
  it('reads every runtime source', () => {
    expect(SOURCES.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'mcp-auth.ts',
        'output.ts',
        'runMcpAuth.ts',
        'runMcpSso.ts',
        'generateEnv.ts',
        'generate-env-from-service-key.ts',
        'destination.ts',
        'subcommandArgs.ts',
      ]),
    );
  });

  it('no instanceof anywhere: no error is told by its class, nor a store the CLI built', () => {
    for (const { file, text } of SOURCES) {
      expect([file, code(text).includes('instanceof')]).toEqual([file, false]);
    }
  });

  it("no .message, .stack or .name of a caught value is read — output.ts reads a recognised value's message, through its own data", () => {
    for (const { file, text } of SOURCES) {
      const body = code(text);
      const bound = caughtNames(body);
      const reads: string[] = [];
      for (const name of bound) {
        for (const read of [
          `${name}.message`,
          `${name}.stack`,
          `${name}.name`,
          `${name}?.message`,
          `${name}?.stack`,
          `String(${name})`,
          `\${${name}}`,
          `(${name} as Error)`,
        ]) {
          if (readsAsWritten(body, read)) reads.push(read);
        }
      }
      expect([file, reads]).toEqual([file, []]);
      // Nor any `.message` / `.stack` at all outside output.ts.
      if (file !== 'output.ts') {
        expect([
          file,
          body.includes('.message'),
          body.includes('.stack'),
        ]).toEqual([file, false, false]);
      }
    }
  });

  it('no caught value reaches a console, logger, stream or progress call — only printFailure prints one', () => {
    for (const { file, text } of SOURCES) {
      const body = code(text);
      const bound = caughtNames(body);
      const printed: string[] = [];
      for (const call of printingCalls(body)) {
        const expressions = withoutStringText(call.argument);
        for (const name of bound) {
          if (hasToken(expressions, name))
            printed.push(`${call.callee}(${name})`);
        }
      }
      expect([file, printed]).toEqual([file, []]);
    }
  });

  it('no environment variable is read but AUTH_BROKER_PATH, once, in source.ts (D17, D25)', () => {
    const reads: string[] = [];
    for (const { file, text } of SOURCES) {
      const parts = code(text).split('process.env');
      for (const after of parts.slice(1)) {
        reads.push(`${file}: process.env${after.slice(0, 17)}`);
      }
    }
    expect(reads).toEqual(['source.ts: process.env.AUTH_BROKER_PATH']);
  });

  it('stdout only for help and --version: console.log only in mcp-auth.ts help and version', () => {
    for (const { file, text } of SOURCES) {
      const body = code(text);
      expect([file, body.includes('process.stdout')]).toEqual([file, false]);
      expect([file, body.includes('console.info')]).toEqual([file, false]);
      if (file !== 'mcp-auth.ts') {
        expect([file, body.includes('console.log')]).toEqual([file, false]);
      }
    }
    const main = code(
      SOURCES.find((s) => s.file === 'mcp-auth.ts')?.text ?? '',
    );
    const afterHelp = main.slice(main.indexOf('function showHelp('));
    expect(afterHelp.split('console.log(').length - 1).toBe(1);
    expect(afterHelp).toContain('console.log(getVersion())');
  });

  it('@mcp-abap-adt/logger is gone: imported nowhere, no dependency', () => {
    for (const { file, text } of SOURCES) {
      expect([file, text.includes('@mcp-abap-adt/logger')]).toEqual([
        file,
        false,
      ]);
    }
    const manifest = JSON.parse(
      readFileSync(resolve(SRC, '..', 'package.json'), 'utf8'),
    );
    expect(manifest.dependencies).not.toHaveProperty('@mcp-abap-adt/logger');
    expect(manifest.devDependencies ?? {}).not.toHaveProperty(
      '@mcp-abap-adt/logger',
    );
  });

  it('the CLI previews no authorization URL of its own (D19)', () => {
    for (const { file, text } of SOURCES) {
      const body = code(text);
      expect([file, body.includes('/oauth/authorize?')]).toEqual([file, false]);
      expect([file, body.includes('Authorization URL')]).toEqual([file, false]);
    }
  });
});
