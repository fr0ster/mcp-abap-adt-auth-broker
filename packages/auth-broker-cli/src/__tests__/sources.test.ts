/**
 * Where `--destination <name>` is looked for: `--destination-dir`, else
 * the environment variable `AUTH_BROKER_PATH` (one or several base folders,
 * split by plain code), else the standard folder of the platform — each level
 * overriding the next. The pure resolver is tested per platform; the built bin
 * is run under node with `HOME` and `AUTH_BROKER_PATH` of its own, so the
 * folder levels are proven where the process reads them. No test reads the
 * user's own folder or variable: every run states both.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticCodeStrategy } from '@mcp-abap-adt/auth-providers';
import { runMcpAuth } from '../runMcpAuth';
import { destinationFolders, splitBasePaths, standardFolder } from '../source';
import {
  type LocalServer,
  startLocalServer,
  tokenAnswer,
} from './helpers/localServer';

const BIN = path.resolve(__dirname, '..', '..', 'dist', 'mcp-auth.js');
const NAME = 'TRIAL';

describe('the standard folder, stated per platform', () => {
  it('Unix: ~/.config/mcp-abap-adt', () => {
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(standardFolder(platform, '/home/u')).toBe(
        '/home/u/.config/mcp-abap-adt',
      );
    }
  });

  it('Windows: Documents/mcp-abap-adt under the home', () => {
    expect(standardFolder('win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\Documents\\mcp-abap-adt',
    );
  });
});

describe('AUTH_BROKER_PATH: one or several base folders', () => {
  it('Unix: split on ";" and ":", empty parts dropped', () => {
    expect(splitBasePaths('/a;/b:/c', 'linux')).toEqual(['/a', '/b', '/c']);
    expect(splitBasePaths('/a::/b;;', 'darwin')).toEqual(['/a', '/b']);
    expect(splitBasePaths('/one', 'linux')).toEqual(['/one']);
  });

  it('Windows: split on ";" only — a drive letter keeps its colon', () => {
    expect(splitBasePaths('C:\\a;D:\\b', 'win32')).toEqual(['C:\\a', 'D:\\b']);
  });

  it('read by plain code, never a regular expression', () => {
    const text = fs.readFileSync(
      path.resolve(__dirname, '..', 'source.ts'),
      'utf8',
    );
    expect(text.includes('RegExp')).toBe(false);
    expect(text.includes('.split(/')).toBe(false);
    expect(text.includes('.match(')).toBe(false);
    expect(text.includes('.replace(/')).toBe(false);
  });
});

describe('the folder levels, each overriding the next — as the server’s getPlatformPaths', () => {
  const unix = { home: '/home/u', platform: 'linux' };
  const both = (
    bases: string[],
    join = (b: string, s: string) => `${b}/${s}`,
  ) => ({
    sessions: bases.map((b) => join(b, 'sessions')),
    serviceKeys: bases.map((b) => join(b, 'service-keys')),
  });

  it('--destination-dir first, whatever the variable', () => {
    expect(
      destinationFolders(
        { destinationDir: '/dests' },
        { ...unix, authBrokerPath: '/a;/b' },
      ),
    ).toEqual(both(['/dests']));
  });

  it('then AUTH_BROKER_PATH, every folder in order', () => {
    expect(
      destinationFolders({}, { ...unix, authBrokerPath: '/a;/b:/c' }),
    ).toEqual(both(['/a', '/b', '/c']));
  });

  it('an entry ending in the subfolder looked for is read as its parent base — that subfolder only, as the server', () => {
    expect(
      destinationFolders(
        {},
        { ...unix, authBrokerPath: '/x/sessions;/y/service-keys;/z' },
      ),
    ).toEqual({
      sessions: ['/x/sessions', '/y/service-keys/sessions', '/z/sessions'],
      serviceKeys: [
        '/x/sessions/service-keys',
        '/y/service-keys',
        '/z/service-keys',
      ],
    });
    expect(
      destinationFolders(
        { destinationDir: '/d/sessions' },
        { ...unix, authBrokerPath: undefined },
      ),
    ).toEqual({
      sessions: ['/d/sessions'],
      serviceKeys: ['/d/sessions/service-keys'],
    });
  });

  it('each list without duplicates, in order', () => {
    expect(
      destinationFolders(
        {},
        { ...unix, authBrokerPath: '/a;/a/sessions;/b;/a/' },
      ),
    ).toEqual({
      sessions: ['/a/sessions', '/b/sessions'],
      serviceKeys: [
        '/a/service-keys',
        '/a/sessions/service-keys',
        '/b/service-keys',
      ],
    });
  });

  it('then the standard folder: the variable absent or empty', () => {
    for (const authBrokerPath of [undefined, '', ';:']) {
      expect(destinationFolders({}, { ...unix, authBrokerPath })).toEqual(
        both(['/home/u/.config/mcp-abap-adt']),
      );
    }
  });

  it('Windows paths by the platform stated, never the native resolver', () => {
    const win = (b: string, s: string) => `${b}\\${s}`;
    expect(
      destinationFolders(
        {},
        { home: 'C:\\Users\\u', platform: 'win32', authBrokerPath: undefined },
      ),
    ).toEqual(both(['C:\\Users\\u\\Documents\\mcp-abap-adt'], win));
    expect(
      destinationFolders(
        {},
        {
          home: 'C:\\Users\\u',
          platform: 'win32',
          authBrokerPath: 'C:\\a;D:\\b\\service-keys',
        },
      ),
    ).toEqual({
      sessions: ['C:\\a\\sessions', 'D:\\b\\service-keys\\sessions'],
      serviceKeys: ['C:\\a\\service-keys', 'D:\\b\\service-keys'],
    });
    expect(
      destinationFolders(
        { destinationDir: 'E:\\dests' },
        { home: 'C:\\Users\\u', platform: 'win32', authBrokerPath: undefined },
      ),
    ).toEqual(both(['E:\\dests'], win));
  });
});

describe('the built bin reads the folder as the process states it', () => {
  let server: LocalServer;
  let root: string;
  let tmp: string;
  const children: ReturnType<typeof spawn>[] = [];

  beforeEach(async () => {
    server = await startLocalServer();
    server.answer('/oauth/token', tokenAnswer('uaa'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-sources-'));
    tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.pid !== undefined) {
        process.kill(child.pid, 'SIGKILL');
      }
    }
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A destination file holding a valid token bound to its means, obtained
   * in process against the local server, at `<base>/sessions/<NAME>.env`.
   */
  async function sessionIn(base: string, label: string): Promise<string> {
    const keys = path.join(root, `keys-${label}`);
    const work = path.join(root, `work-${label}`);
    fs.mkdirSync(keys, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const key = path.join(keys, `${NAME}.json`);
    fs.writeFileSync(
      key,
      JSON.stringify({
        uaa: {
          url: server.url,
          clientid: `client-${label}`,
          clientsecret: 's',
        },
        abap: { url: 'https://abap.example.com' },
      }),
    );
    const file = path.join(base, 'sessions', `${NAME}.env`);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runMcpAuth(
        {
          serviceKeyPath: key,
          outputFile: file,
          authType: 'abap',
          browser: 'none',
          credential: false,
          format: 'env',
        },
        {
          workDir: work,
          authorization: () => staticCodeStrategy({ payload: 'the-code' }),
        },
      );
    } finally {
      spy.mockRestore();
    }
    return file;
  }

  function runBin(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', TMPDIR: tmp, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('no AUTH_BROKER_PATH: the session under $HOME/.config/mcp-abap-adt is used, no request sent', async () => {
    const home = path.join(root, 'home');
    const file = await sessionIn(
      path.join(home, '.config', 'mcp-abap-adt'),
      'home',
    );
    const before = fs.readFileSync(file);
    const sent = server.requests.length;
    const output = path.join(root, 'out.env');
    const result = await runBin(['--destination', NAME, '--output', output], {
      HOME: home,
    });
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(server.requests).toHaveLength(sent);
    expect(fs.readFileSync(output)).toEqual(before);
  });

  it('AUTH_BROKER_PATH overrides the standard folder; the first folder holding the destination is read', async () => {
    const home = path.join(root, 'home');
    await sessionIn(path.join(home, '.config', 'mcp-abap-adt'), 'home');
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const listed = await sessionIn(path.join(root, 'listed'), 'listed');
    const before = fs.readFileSync(listed);
    const output = path.join(root, 'out.env');
    const result = await runBin(['--destination', NAME, '--output', output], {
      HOME: home,
      AUTH_BROKER_PATH: `${empty};${path.join(root, 'listed')}`,
    });
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(fs.readFileSync(output)).toEqual(before);
  });

  it('--destination-dir overrides AUTH_BROKER_PATH', async () => {
    const home = path.join(root, 'home');
    await sessionIn(path.join(root, 'listed'), 'listed');
    const given = await sessionIn(path.join(root, 'given'), 'given');
    const before = fs.readFileSync(given);
    const output = path.join(root, 'out.env');
    const result = await runBin(
      [
        '--destination',
        NAME,
        '--destination-dir',
        path.join(root, 'given'),
        '--output',
        output,
      ],
      { HOME: home, AUTH_BROKER_PATH: path.join(root, 'listed') },
    );
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(fs.readFileSync(output)).toEqual(before);
  });

  it('a destination found nowhere is a usage error naming the folders looked in', async () => {
    const home = path.join(root, 'home');
    const result = await runBin(['--destination', NAME], { HOME: home });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const base = path.join(home, '.config', 'mcp-abap-adt');
    expect(result.stderr).toContain(
      `❌ --destination: ${NAME} is in none of ${path.join(base, 'sessions')} (as ${NAME}.env) and ${path.join(base, 'service-keys')} (as ${NAME}.json)`,
    );
    // A run-time usage error ends as a parse-time one does (M4).
    expect(
      result.stderr
        .trimEnd()
        .endsWith('Run "mcp-auth --help" for usage information'),
    ).toBe(true);
  });
});
