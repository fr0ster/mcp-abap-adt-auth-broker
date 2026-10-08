/**
 * §10.3 — `--browser` and `--browser-program`, mapped by the CLI's own table
 * per platform. Every factory is a recording double: nothing is launched,
 * and each answer is checked by identity, with the argument the factory got.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IBrowser } from '@mcp-abap-adt/interfaces-auth';
import {
  BROWSER_NAMES,
  type BrowserFactories,
  type BrowserName,
  BrowserUsageError,
  browserFor,
  browserProgramFor,
} from '../browser';
import { runGenerateEnv } from '../generateEnv';
import {
  applyFileConfig,
  type McpSsoOptions,
  normalizeProviderConfig,
  ssoBrowser,
} from '../mcpSsoConfig';
import { mcpAuthBrowser } from '../runMcpAuth';

/** A browser double: it records nothing and opens nothing. */
interface Made extends IBrowser {
  readonly factory: keyof BrowserFactories;
  readonly argument: string | undefined;
}

/** Recording factories: each answer a fresh object naming its factory and argument. */
function recording(): BrowserFactories & { made: Made[] } {
  const made: Made[] = [];
  const make =
    (factory: keyof BrowserFactories) =>
    (argument?: string): IBrowser => {
      const browser: Made = {
        factory,
        argument,
        open: async () => {
          throw new Error('a test browser is never opened');
        },
      };
      made.push(browser);
      return browser;
    };
  return {
    made,
    linuxDefaultBrowser: make('linuxDefaultBrowser'),
    linuxBrowser: make('linuxBrowser'),
    macDefaultBrowser: make('macDefaultBrowser'),
    macBrowser: make('macBrowser'),
    windowsDefaultBrowser: make('windowsDefaultBrowser'),
    windowsBrowser: make('windowsBrowser'),
  };
}

/** §10.3's table: each name on each launching platform → factory and argument. */
const TABLE: Array<
  [string, BrowserName, keyof BrowserFactories, string | undefined]
> = [
  ['linux', 'auto', 'linuxDefaultBrowser', undefined],
  ['linux', 'system', 'linuxDefaultBrowser', undefined],
  ['linux', 'chrome', 'linuxBrowser', 'google-chrome'],
  ['linux', 'edge', 'linuxBrowser', 'microsoft-edge'],
  ['linux', 'firefox', 'linuxBrowser', 'firefox'],
  ['darwin', 'auto', 'macDefaultBrowser', undefined],
  ['darwin', 'system', 'macDefaultBrowser', undefined],
  ['darwin', 'chrome', 'macBrowser', 'Google Chrome'],
  ['darwin', 'edge', 'macBrowser', 'Microsoft Edge'],
  ['darwin', 'firefox', 'macBrowser', 'Firefox'],
  ['win32', 'auto', 'windowsDefaultBrowser', undefined],
  ['win32', 'system', 'windowsDefaultBrowser', undefined],
  ['win32', 'chrome', 'windowsBrowser', 'chrome'],
  ['win32', 'edge', 'windowsBrowser', 'msedge'],
  ['win32', 'firefox', 'windowsBrowser', 'firefox'],
];

const OTHER_PLATFORMS = ['freebsd', 'aix', 'openbsd', 'sunos', 'android'];
const NAMED = BROWSER_NAMES.filter(
  (name) => name !== 'none' && name !== 'headless',
);

describe('browserFor: every cell of the table', () => {
  it.each(TABLE)(
    '%s, --browser %s → %s(%s)',
    (platform, name, factory, argument) => {
      const factories = recording();
      const browser = browserFor(name, platform, factories);
      expect(factories.made).toHaveLength(1);
      expect(browser).toBe(factories.made[0]);
      expect(factories.made[0]).toMatchObject({ factory, argument });
    },
  );

  it.each([
    ['linux', 'linuxBrowser'],
    ['darwin', 'macBrowser'],
    ['win32', 'windowsBrowser'],
  ] as const)(
    '%s, --browser-program → %s with the program as given',
    (platform, factory) => {
      const factories = recording();
      const program =
        platform === 'darwin' ? 'Brave Browser' : '/opt/my browser/bin';
      const browser = browserProgramFor(program, platform, factories);
      expect(browser).toBe(factories.made[0]);
      expect(factories.made[0]).toMatchObject({ factory, argument: program });
    },
  );

  it.each([
    ...['linux', 'darwin', 'win32', ...OTHER_PLATFORMS].flatMap((platform) =>
      (['none', 'headless'] as const).map(
        (name) => [platform, name] as [string, BrowserName],
      ),
    ),
  ])('%s, --browser %s → no browser', (platform, name) => {
    const factories = recording();
    expect(browserFor(name, platform, factories)).toBeUndefined();
    expect(factories.made).toEqual([]);
  });
});

describe('any other platform: nothing guessed', () => {
  it.each(
    OTHER_PLATFORMS.flatMap((platform) =>
      NAMED.map((name) => [platform, name] as [string, BrowserName]),
    ),
  )('%s refuses --browser %s, naming the flag', (platform, name) => {
    const factories = recording();
    let caught: unknown;
    try {
      browserFor(name, platform, factories);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserUsageError);
    expect((caught as Error).message).toBe(
      `--browser ${name} has no launcher on this platform; use --browser none`,
    );
    expect(factories.made).toEqual([]);
  });

  it.each(OTHER_PLATFORMS)('%s refuses --browser-program', (platform) => {
    const factories = recording();
    expect(() => browserProgramFor('firefox', platform, factories)).toThrow(
      '--browser-program has no launcher on this platform; use --browser none',
    );
    expect(factories.made).toEqual([]);
  });

  it('generate-env refuses before anything is read or written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-refusal-'));
    const authorization = jest.fn();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runGenerateEnv(
        [
          'TRIAL',
          // No such file: a read would fail on it first.
          path.join(root, 'missing-key.json'),
          path.join(root, 'TRIAL.env'),
          '--grant',
          'authorization_code',
          '--browser',
          'chrome',
        ],
        {
          authorization,
          workDir: path.join(root, 'work'),
          platform: 'freebsd',
          browsers: recording(),
        },
      );
      expect(code).toBe(1);
      expect(error).toHaveBeenCalledWith(
        '❌ --browser chrome has no launcher on this platform; use --browser none',
      );
      expect(
        error.mock.calls.flat().join('\n').includes('missing-key.json'),
      ).toBe(false);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(authorization).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      log.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mcp-sso: the flag and the --config field map the same', () => {
  function fromFile(browser: unknown): McpSsoOptions {
    const options: McpSsoOptions = { authType: 'abap', format: 'env' };
    applyFileConfig(
      options,
      normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'c',
        browser,
      }),
    );
    return options;
  }

  it.each(TABLE)(
    '%s, browser %s → %s(%s), from the file as from the flag',
    (platform, name, factory, argument) => {
      const fileFactories = recording();
      const flagFactories = recording();
      const fromConfig = ssoBrowser(fromFile(name), platform, fileFactories);
      const fromFlag = ssoBrowser({ browser: name }, platform, flagFactories);
      expect(fromConfig).toBe(fileFactories.made[0]);
      expect(fromFlag).toBe(flagFactories.made[0]);
      expect(fileFactories.made[0]).toMatchObject({ factory, argument });
      expect(flagFactories.made[0]).toMatchObject({ factory, argument });
    },
  );

  it.each([
    ['linux', 'linuxDefaultBrowser'],
    ['darwin', 'macDefaultBrowser'],
    ['win32', 'windowsDefaultBrowser'],
  ])(
    'nothing stated: auto, as every flow that opens a browser (%s → %s)',
    (platform, factory) => {
      const factories = recording();
      expect(ssoBrowser({}, platform, factories)).toBe(factories.made[0]);
      expect(factories.made).toEqual([
        expect.objectContaining({ factory, argument: undefined }),
      ]);
    },
  );

  it('nothing stated on another platform: refused like --browser auto', () => {
    expect(() => ssoBrowser({}, 'freebsd', recording())).toThrow(
      '--browser auto has no launcher on this platform; use --browser none',
    );
  });

  it('an unknown value is refused naming browser', () => {
    for (const value of ['opera', 'Chrome', 'msedge']) {
      expect(() => ssoBrowser(fromFile(value), 'linux', recording())).toThrow(
        'browser must be one of:',
      );
    }
  });

  it('a stated browser on another platform is refused; none is not', () => {
    expect(() => ssoBrowser(fromFile('auto'), 'freebsd', recording())).toThrow(
      BrowserUsageError,
    );
    expect(
      ssoBrowser(fromFile('none'), 'freebsd', recording()),
    ).toBeUndefined();
  });

  it('--browser-program beside a --config file stating browser names the file’s field, not a flag never given', () => {
    const options = fromFile('chrome');
    options.browserProgram = 'firefox';
    expect(() => ssoBrowser(options, 'linux', recording())).toThrow(
      "--browser-program excludes the --config file's browser",
    );
  });

  it('--browser-program excludes --browser', () => {
    expect(() =>
      ssoBrowser(
        { browser: 'chrome', browserProgram: 'firefox' },
        'linux',
        recording(),
      ),
    ).toThrow('--browser-program excludes --browser');
  });
});

describe('mcp-auth: --browser and --browser-program are two options', () => {
  it('--browser-program is read from its own option; --browser keeps its name', () => {
    const factories = recording();
    const browser = mcpAuthBrowser(
      { browser: 'auto', browserProgram: '/opt/my browser/bin' },
      'linux',
      factories,
    );
    expect(browser).toBe(factories.made[0]);
    expect(factories.made[0]).toMatchObject({
      factory: 'linuxBrowser',
      argument: '/opt/my browser/bin',
    });
  });

  it('--browser alone maps by the table; none gives no browser', () => {
    const factories = recording();
    expect(mcpAuthBrowser({ browser: 'edge' }, 'win32', factories)).toBe(
      factories.made[0],
    );
    expect(factories.made[0]).toMatchObject({
      factory: 'windowsBrowser',
      argument: 'msedge',
    });
    expect(mcpAuthBrowser({ browser: 'none' }, 'win32', factories)).toBe(
      undefined,
    );
  });

  it('a program in the browser option is not a browser name: refused, never run', () => {
    const factories = recording();
    expect(() =>
      mcpAuthBrowser({ browser: '/opt/my browser/bin' }, 'linux', factories),
    ).toThrow(BrowserUsageError);
    expect(factories.made).toEqual([]);
  });
});
