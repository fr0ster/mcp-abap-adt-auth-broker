/**
 * Transitional: the repository's 2.1.1 copy of the shape check, auth-errors'
 * module and the command auth-errors now installs decide the same, on both
 * packages' roots and on every fixture — the installed command byte for byte
 * with the copy. Removed together with the copy.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkProviderShape,
  reportLines,
  type ShapeRule,
} from '@mcp-abap-adt/auth-errors/shape-check';
import ts from 'typescript';

const REPOSITORY_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const COPY = join(REPOSITORY_ROOT, 'tools', 'check-provider-shape.mjs');
const INSTALLED = require.resolve(
  '@mcp-abap-adt/auth-errors/tools/check-provider-shape.mjs',
);

jest.setTimeout(300_000);

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const PACKAGES = ['auth-broker', 'auth-broker-cli'] as const;
const CONFIGURED: readonly ShapeRule[] = [4, 5, 6];
const WIDER: readonly ShapeRule[] = [4, 5, 6, 7, 8];
const FIXTURES = ['rule4.ts', 'rule5.ts', 'rule6.ts'] as const;

interface Entry {
  readonly label: string;
  readonly root: string;
  readonly rules: readonly ShapeRule[];
  readonly files: readonly string[];
}

const MATRIX: readonly Entry[] = PACKAGES.flatMap((name) => {
  const root = join(REPOSITORY_ROOT, 'packages', name);
  return [
    { label: `${name}, rules 4,5,6`, root, rules: CONFIGURED, files: [] },
    { label: `${name}, rules 4–8`, root, rules: WIDER, files: [] },
    ...FIXTURES.map((fixture) => ({
      label: `${name}, ${fixture} with rules 4,5,6`,
      root,
      rules: CONFIGURED,
      files: [join(root, 'tools', '__fixtures__', fixture)],
    })),
  ];
});

describe('the 2.1.1 copy', () => {
  it('is the 2.1.1 file, byte for byte', () => {
    expect(createHash('sha256').update(readFileSync(COPY)).digest('hex')).toBe(
      '681d8cbdc6177d2436955e172d9aded58ea67e8b9a604d1fbaf1f81c70715603',
    );
  });

  it('is not the installed command', () => {
    expect(readFileSync(INSTALLED).equals(readFileSync(COPY))).toBe(false);
  });
});

describe('the copy, the module and the installed command decide the same', () => {
  it.each(MATRIX.map((entry) => [entry.label, entry] as const))(
    '%s',
    (_label, entry) => {
      const args = [
        '--rules',
        entry.rules.join(','),
        '--root',
        entry.root,
        ...entry.files,
      ];
      const copy = run(COPY, args);
      expect(run(INSTALLED, args)).toEqual(copy);

      const report = checkProviderShape({
        typescript: ts,
        rules: entry.rules,
        root: entry.root,
        project: join(entry.root, 'tsconfig.json'),
        sites: null,
        files: entry.files,
      });
      expect(report.status).toBe('checked');
      if (report.status !== 'checked') return;
      expect(copy.stderr).toBe('');
      expect(copy.status).toBe(report.findings.length > 0 ? 1 : 0);
      expect(copy.stdout).toBe(
        reportLines(report)
          .map((line) => `${line}\n`)
          .join(''),
      );
      // A fixture's case compares a report that holds a finding.
      expect(report.findings.length > 0).toBe(entry.files.length > 0);
    },
  );
});
