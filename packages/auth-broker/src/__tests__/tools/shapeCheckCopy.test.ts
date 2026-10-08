/**
 * The repository's `tools/check-provider-shape.mjs` is a copy of the one
 * `@mcp-abap-adt/auth-errors` publishes (its Decision D4): byte for byte, so a
 * new auth-errors that changes the check fails here until the copy follows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPOSITORY_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('tools/check-provider-shape.mjs', () => {
  it('is byte-identical to the installed auth-errors original', () => {
    const original = readFileSync(
      require.resolve(
        '@mcp-abap-adt/auth-errors/tools/check-provider-shape.mjs',
      ),
    );
    const copy = readFileSync(
      join(REPOSITORY_ROOT, 'tools', 'check-provider-shape.mjs'),
    );
    expect(copy.equals(original)).toBe(true);
  });
});
