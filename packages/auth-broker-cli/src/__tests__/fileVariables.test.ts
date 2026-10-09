/**
 * The CLI's reads of a session file's own lines (`readFileVariable`) see what
 * auth-stores sees: the oracle is auth-stores' `EnvFileSessionStore`, reading
 * the same file — exported keys, quoting, comments, whitespace, and the last
 * of duplicate assignments.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvFileSessionStore } from '@mcp-abap-adt/auth-stores';
import { readFileVariable } from '../destination';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-vars-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const CASES: [label: string, line: (key: string) => string, value: string][] = [
  ['bare', (k) => `${k}=form`, 'form'],
  ['exported', (k) => `export ${k}=form`, 'form'],
  ['single-quoted', (k) => `${k}='form'`, 'form'],
  ['double-quoted', (k) => `${k}="form"`, 'form'],
  ['a trailing comment', (k) => `${k}=form # the encoding`, 'form'],
  ['whitespace around', (k) => `  ${k} =  form  `, 'form'],
  ['duplicates: the last wins', (k) => `${k}=raw\nexport ${k}="form"`, 'form'],
  ['a commented-out line', (k) => `${k}=form\n# ${k}=raw`, 'form'],
];

describe('readFileVariable reads a line as auth-stores does', () => {
  it.each(CASES)('%s', async (_label, line, value) => {
    const file = path.join(root, 'session.env');
    fs.writeFileSync(
      file,
      [
        'SAP_URL=https://abap.example.com',
        line('SAP_REFRESH_TOKEN'),
        line('SAP_UAA_BASIC_ENCODING'),
        '',
      ].join('\n'),
    );
    const stores = await new EnvFileSessionStore(file).getRefreshToken('x');
    expect(stores).toBe(value);
    expect(readFileVariable(file, 'SAP_REFRESH_TOKEN')).toBe(stores);
    expect(readFileVariable(file, 'SAP_UAA_BASIC_ENCODING')).toBe(value);
  });

  it('a key that is absent, and a missing file: undefined', () => {
    const file = path.join(root, 'session.env');
    fs.writeFileSync(file, 'SAP_URL=x\n');
    expect(readFileVariable(file, 'SAP_UAA_BASIC_ENCODING')).toBeUndefined();
    expect(
      readFileVariable(path.join(root, 'none.env'), 'SAP_URL'),
    ).toBeUndefined();
  });
});
