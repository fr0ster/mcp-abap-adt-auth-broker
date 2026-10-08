/**
 * Source rules (§3.1, §13.1; H4):
 *
 * - the library's `src` reads a failure only through auth-errors: no
 *   `instanceof` at all, no read of `message` / `stack` (`.message`,
 *   `['message']`), and `name` only written by its own error classes
 *   (`this.name = …`) — `isDestinationConfigError` reads it as an own data
 *   property, by descriptor;
 * - none of the three certificate phrases the broker once copied from
 *   auth-providers: the provider's error carries its own words;
 * - in both packages' `src`: no `timeoutMs`, no `AbortSignal.timeout`, no
 *   `INTERACTIVE_LOGIN_TIMEOUT_MS` — no wait has a bound of the package's own.
 *
 * Comments are left out of the code checks (a comment may say what is not
 * done); the phrase check reads the whole file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const PACKAGES = join(__dirname, '..', '..', '..', '..');
const LIBRARY_SRC = join(PACKAGES, 'auth-broker', 'src');
const CLI_SRC = join(PACKAGES, 'auth-broker-cli', 'src');

/** Every `.ts` file under `dir`, tests (`__tests__`) left out. */
function runtimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : runtimeFiles(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * The code of a file without its comments: a scanner that keeps string and
 * template literals whole, so a `//` inside a URL is not taken for one, and
 * every line break, so line numbers stay the file's.
 */
function codeOf(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Its line breaks stay, so a line number still points at the file.
      out += text
        .slice(i, stop)
        .split('\n')
        .map(() => '')
        .join('\n');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** `file:line` of every line of `code` holding `needle`. */
function sites(file: string, code: string, needle: string): string[] {
  return code
    .split('\n')
    .flatMap((line, index) =>
      line.includes(needle)
        ? [`${relative(PACKAGES, file)}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

const library = runtimeFiles(LIBRARY_SRC).map((file) => ({
  file,
  text: readFileSync(file, 'utf8'),
}));
const both = [...runtimeFiles(LIBRARY_SRC), ...runtimeFiles(CLI_SRC)].map(
  (file) => ({ file, code: codeOf(readFileSync(file, 'utf8')) }),
);

describe('the library reads a failure only through auth-errors', () => {
  it('has library sources to check', () => {
    expect(library.length).toBeGreaterThan(5);
  });

  it('no instanceof', () => {
    const found = library.flatMap(({ file, text }) =>
      sites(file, codeOf(text), 'instanceof'),
    );
    expect(found).toEqual([]);
  });

  it('no read of message or stack, and name only written by its own classes', () => {
    const found = library.flatMap(({ file, text }) => {
      const code = codeOf(text);
      const names = sites(file, code, '.name').filter(
        (site) => !site.includes('this.name = '),
      );
      return [
        ...sites(file, code, '.message'),
        ...sites(file, code, '.stack'),
        ...sites(file, code, "'message'"),
        ...sites(file, code, "'stack'"),
        ...names,
      ];
    });
    expect(found).toEqual([]);
  });

  it('none of the three certificate phrases copied from auth-providers', () => {
    const phrases = [
      'the client certificate is incomplete',
      'the client certificate has expired',
      'the client certificate could not be used',
    ];
    const found = library.flatMap(({ file, text }) =>
      phrases.flatMap((phrase) => sites(file, text, phrase)),
    );
    expect(found).toEqual([]);
  });
});

describe('no wait has a bound of the package’s own (both packages)', () => {
  it.each(['timeoutMs', 'AbortSignal.timeout', 'INTERACTIVE_LOGIN_TIMEOUT_MS'])(
    'no %s',
    (needle) => {
      const found = both.flatMap(({ file, code }) => sites(file, code, needle));
      expect(found).toEqual([]);
    },
  );
});
