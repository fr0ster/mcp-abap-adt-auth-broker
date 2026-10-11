/**
 * What the CLI relies on when it discards a session the store refuses as not
 * of its format (`sessionRecord.ts`):
 *
 * - each session store's `deleteSession` (auth-stores 5) removes its session
 *   keys alone — the token or cookies, the expiry, the refresh token, both
 *   binding keys — and leaves every other line byte for byte, over a record it
 *   refuses to read;
 * - the refusal and any other `StorageError` are recognised by structure and
 *   printed in the CLI's fixed words, never the store's message.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AbapSessionStore,
  EnvFileSessionStore,
  StorageError,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { failureLines } from '../output';
import {
  isRecordFormatRefusal,
  isStorageError,
  SessionStoreFailure,
} from '../sessionRecord';

const DEST = 'OLD';
const SECRET = 'OLD-SECRET-MARKER-5f1c';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-record-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Means a 2.x file holds, with a comment, a blank line and an unknown key, written as a person might. */
const ABAP_MEANS = [
  '# the destination',
  'SAP_URL=https://abap.example.com',
  'SAP_CLIENT=100',
  '',
  "SAP_UAA_URL='https://uaa.example.com'",
  'SAP_UAA_CLIENT_ID=client',
  'SAP_UAA_CLIENT_SECRET=client-secret',
  'SAP_AUTH_TYPE=jwt',
  'SAP_GRANT_TYPE=authorization_code',
  'SAP_UAA_BASIC_ENCODING=form',
  'SOMETHING_ELSE=kept',
];

const XSUAA_MEANS = [
  'XSUAA_MCP_URL=https://mcp.example.com',
  'XSUAA_UAA_URL=https://uaa.example.com',
  'XSUAA_UAA_CLIENT_ID=client',
  'XSUAA_UAA_CLIENT_SECRET=client-secret',
  'XSUAA_AUTH_TYPE=jwt',
  'XSUAA_GRANT_TYPE=authorization_code',
];

/** The means interleaved with a session the store refuses: a token without the binding keys. */
function oldFile(file: string, means: string[], prefix: 'SAP' | 'XSUAA') {
  const lines = [
    ...means.slice(0, 2),
    `${prefix}_JWT_TOKEN=${SECRET}-token`,
    ...means.slice(2, 4),
    `${prefix}_REFRESH_TOKEN=${SECRET}-refresh`,
    `${prefix}_EXPIRES_AT=1700000000000`,
    ...means.slice(4),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

describe('deleteSession over a record the store refuses (auth-stores 5)', () => {
  it.each([
    [
      'AbapSessionStore',
      () => new AbapSessionStore(root),
      ABAP_MEANS,
      'SAP' as const,
    ],
    [
      'XsuaaSessionStore',
      () => new XsuaaSessionStore(root),
      XSUAA_MEANS,
      'XSUAA' as const,
    ],
    [
      'EnvFileSessionStore',
      () => new EnvFileSessionStore(path.join(root, `${DEST}.env`)),
      ABAP_MEANS,
      'SAP' as const,
    ],
  ])(
    '%s: the session keys go, every other line stays byte for byte',
    async (_name, make, means, prefix) => {
      const file = path.join(root, `${DEST}.env`);
      oldFile(file, means, prefix);
      const store = make();
      const refused = await store.loadSession(DEST).catch((e: unknown) => e);
      expect(isRecordFormatRefusal(refused)).toBe(true);

      await store.deleteSession(DEST);

      expect(fs.readFileSync(file, 'utf8')).toBe(`${means.join('\n')}\n`);
      await expect(store.loadSession(DEST)).resolves.toBeNull();
    },
  );

  it('a binding key or cookies are session keys too: removed with the rest', async () => {
    const file = path.join(root, `${DEST}.env`);
    fs.writeFileSync(
      file,
      [
        ...ABAP_MEANS,
        `SAP_SESSION_COOKIES_B64=${SECRET}`,
        `SAP_JWT_TOKEN=${SECRET}`,
        'SAP_ISSUED_FOR=https://abap.example.com',
        '',
      ].join('\n'),
    );
    await new AbapSessionStore(root).deleteSession(DEST);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${ABAP_MEANS.join('\n')}\n`);
  });

  it('a file holding session keys alone is removed: the CLI never discards one (it has no grant to log in with)', async () => {
    const file = path.join(root, `${DEST}.env`);
    fs.writeFileSync(file, `SAP_JWT_TOKEN=${SECRET}\n`);
    await new EnvFileSessionStore(file).deleteSession(DEST);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('a StorageError, recognised by structure', () => {
  const recordFormat = () =>
    new StorageError('read', `${SECRET} message`, undefined, 'record-format');

  it('record-format: own code and reason; anything less is not', () => {
    expect(isRecordFormatRefusal(recordFormat())).toBe(true);
    expect(
      isRecordFormatRefusal({ code: 'STORAGE_ERROR', reason: 'record-format' }),
    ).toBe(true);
    expect(isRecordFormatRefusal(new StorageError('read', 'x'))).toBe(false);
    expect(isRecordFormatRefusal({ reason: 'record-format' })).toBe(false);
    // An accessor is never run.
    const getter = Object.defineProperty({ code: 'STORAGE_ERROR' }, 'reason', {
      get: () => 'record-format',
    });
    expect(isRecordFormatRefusal(getter)).toBe(false);
    expect(isRecordFormatRefusal(null)).toBe(false);
    expect(isStorageError('STORAGE_ERROR')).toBe(false);
  });

  it('carried by a run: the destination and the CLI’s words, never the message', () => {
    expect(failureLines(new SessionStoreFailure(DEST, recordFormat()))).toEqual(
      [`❌ the stored session for "${DEST}" is not in the store's format`],
    );
    const cause = Object.assign(new Error(`${SECRET} cause`), {
      code: 'EACCES',
    });
    expect(
      failureLines(
        new SessionStoreFailure(
          DEST,
          new StorageError('write', `${SECRET} message`, cause),
        ),
      ),
    ).toEqual([`❌ the session store for "${DEST}" failed (write) (EACCES)`]);
  });

  it('bare: the same words without a destination', () => {
    expect(failureLines(new StorageError('read', `${SECRET} /a/path`))).toEqual(
      ['❌ the session store for the destination failed (read)'],
    );
    expect(failureLines(recordFormat())).toEqual([
      "❌ the stored session for the destination is not in the store's format",
    ]);
  });
});
