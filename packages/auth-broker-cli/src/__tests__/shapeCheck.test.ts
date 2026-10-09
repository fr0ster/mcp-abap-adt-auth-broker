/**
 * The shape check of the error contract (rules 4, 5 and 6), run in-process
 * through auth-errors' module with this repository's own `typescript`. The
 * package's own sources must be clean; each fixture under `tools/__fixtures__`
 * breaks one rule and must be refused by that rule alone, so a rule dropped
 * from `SHAPE_CHECK` turns its fixture's case red. Every path that publishes
 * runs this test: the root `check` (which `release:publish` and this
 * package's `prepublishOnly` run) and the release workflow run
 * `npm run test:shape`, and this package's `test:shape` runs this file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkProviderShape,
  reportLines,
  type ShapeCheckReport,
  type ShapeFinding,
  type ShapeRule,
} from '@mcp-abap-adt/auth-errors/shape-check';
import ts from 'typescript';

const REPOSITORY_ROOT = join(__dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = join(__dirname, '..', '..');

/** This package's whole configuration of the check. */
const SHAPE_CHECK = {
  typescript: ts,
  rules: [4, 5, 6],
  root: PACKAGE_ROOT,
  project: join(PACKAGE_ROOT, 'tsconfig.json'),
  sites: null,
} as const;

/** Each fixture and the one rule it breaks. */
const FIXTURES: readonly (readonly [string, ShapeRule])[] = [
  ['rule4.ts', 4],
  ['rule5.ts', 5],
  ['rule6.ts', 6],
];

jest.setTimeout(120_000);

/** The scripts of the `package.json` in `dir`. */
function scripts(dir: string): Readonly<Record<string, string>> {
  const manifest = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  return manifest.scripts ?? {};
}

function findings(report: ShapeCheckReport): readonly ShapeFinding[] {
  if (report.status !== 'checked') {
    throw new Error(`not checked: ${reportLines(report).join('\n')}`);
  }
  return report.findings;
}

describe('the shape check (auth-errors) over @mcp-abap-adt/auth-broker-cli', () => {
  it('finds nothing in this package', () => {
    expect(reportLines(checkProviderShape(SHAPE_CHECK))).toEqual([]);
  });

  it('runs every rule a fixture breaks', () => {
    for (const [, rule] of FIXTURES) {
      expect(SHAPE_CHECK.rules).toContain(rule);
    }
  });

  it.each(FIXTURES)('refuses %s by rule %s alone', (fixture, rule) => {
    const file = join(PACKAGE_ROOT, 'tools', '__fixtures__', fixture);
    const found = findings(
      checkProviderShape({ ...SHAPE_CHECK, files: [file] }),
    );
    expect(found.map((finding) => [finding.file, finding.rule])).toEqual([
      [`tools/__fixtures__/${fixture}`, rule],
    ]);
  });

  it('runs on every path that publishes', () => {
    const root = scripts(REPOSITORY_ROOT);
    expect(root.check?.split(' && ')).toContain('npm run test:shape');
    expect(root['test:shape']).toBe('npm run test:shape --workspaces');
    const own = scripts(PACKAGE_ROOT);
    expect(own.prepublishOnly).toBe('npm run --prefix ../.. check');
    expect(own['test:shape']).toBe(
      'cross-env NODE_OPTIONS=--experimental-vm-modules jest src/__tests__/shapeCheck.test.ts',
    );
    const release = readFileSync(
      join(REPOSITORY_ROOT, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(release).toContain('run: npm run test:shape\n');
  });
});
