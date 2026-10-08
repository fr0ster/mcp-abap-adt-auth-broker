/**
 * `--browser` and `--browser-program`: which program opens the authorization
 * URL, decided by this CLI in one table of its own, by `process.platform`.
 *
 * auth-providers 6.0.0 names no browser by a string and checks no platform:
 * each of its six factories runs exactly its program. So the names this CLI
 * has always taken are mapped here, explicitly — never guessed:
 *
 * | `--browser`          | linux                           | darwin                          | win32                         |
 * |----------------------|---------------------------------|---------------------------------|-------------------------------|
 * | `auto`, `system`     | `linuxDefaultBrowser()`         | `macDefaultBrowser()`           | `windowsDefaultBrowser()`     |
 * | `chrome`             | `linuxBrowser('google-chrome')` | `macBrowser('Google Chrome')`   | `windowsBrowser('chrome')`    |
 * | `edge`               | `linuxBrowser('microsoft-edge')`| `macBrowser('Microsoft Edge')`  | `windowsBrowser('msedge')`    |
 * | `firefox`            | `linuxBrowser('firefox')`       | `macBrowser('Firefox')`         | `windowsBrowser('firefox')`   |
 * | `none`, `headless`   | no browser: the URL is shown on stderr                                                            |
 *
 * `--browser-program <program>` is the platform's named-browser factory with
 * the program as given: an executable on `PATH` or an absolute path (Linux),
 * an application name (macOS), a program name or path (Windows).
 *
 * On any other platform a named browser and `--browser-program` are refused
 * naming the flag; `none` / `headless` work everywhere.
 */

import {
  linuxBrowser,
  linuxDefaultBrowser,
  macBrowser,
  macDefaultBrowser,
  windowsBrowser,
  windowsDefaultBrowser,
} from '@mcp-abap-adt/auth-providers';
import type { IBrowser } from '@mcp-abap-adt/interfaces-auth';

/** The names `--browser` (and a `--config` file's `browser`) take. */
export const BROWSER_NAMES = [
  'auto',
  'system',
  'chrome',
  'edge',
  'firefox',
  'none',
  'headless',
] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

export function isBrowserName(value: unknown): value is BrowserName {
  return (
    typeof value === 'string' &&
    (BROWSER_NAMES as readonly string[]).includes(value)
  );
}

/** The six browser factories of auth-providers, injectable for tests. */
export interface BrowserFactories {
  linuxDefaultBrowser(): IBrowser;
  linuxBrowser(program: string): IBrowser;
  macDefaultBrowser(): IBrowser;
  macBrowser(application: string): IBrowser;
  windowsDefaultBrowser(): IBrowser;
  windowsBrowser(program: string): IBrowser;
}

/** auth-providers' own factories: what the commands use. */
export const SHIPPED_BROWSERS: BrowserFactories = {
  linuxDefaultBrowser,
  linuxBrowser,
  macDefaultBrowser,
  macBrowser,
  windowsDefaultBrowser,
  windowsBrowser,
};

/** A browser choice this platform cannot honour: a usage error naming the flag. */
export class BrowserUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUsageError';
  }
}

type LaunchingPlatform = 'linux' | 'darwin' | 'win32';

function launching(platform: string): platform is LaunchingPlatform {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}

/** The named browsers' programs, per platform. */
const PROGRAMS: Readonly<
  Record<
    'chrome' | 'edge' | 'firefox',
    Readonly<Record<LaunchingPlatform, string>>
  >
> = {
  chrome: {
    linux: 'google-chrome',
    darwin: 'Google Chrome',
    win32: 'chrome',
  },
  edge: {
    linux: 'microsoft-edge',
    darwin: 'Microsoft Edge',
    win32: 'msedge',
  },
  firefox: { linux: 'firefox', darwin: 'Firefox', win32: 'firefox' },
};

function named(
  platform: LaunchingPlatform,
  program: string,
  factories: BrowserFactories,
): IBrowser {
  switch (platform) {
    case 'linux':
      return factories.linuxBrowser(program);
    case 'darwin':
      return factories.macBrowser(program);
    case 'win32':
      return factories.windowsBrowser(program);
  }
}

function platformDefault(
  platform: LaunchingPlatform,
  factories: BrowserFactories,
): IBrowser {
  switch (platform) {
    case 'linux':
      return factories.linuxDefaultBrowser();
    case 'darwin':
      return factories.macDefaultBrowser();
    case 'win32':
      return factories.windowsDefaultBrowser();
  }
}

/**
 * The browser `--browser <name>` states on `platform`: an `IBrowser`, or
 * `undefined` for `none` / `headless` (the URL is shown on stderr). Throws
 * `BrowserUsageError` for a named browser on a platform with no launcher.
 * Reads and launches nothing: a factory only describes its program.
 */
export function browserFor(
  name: BrowserName,
  platform: string,
  factories: BrowserFactories = SHIPPED_BROWSERS,
): IBrowser | undefined {
  if (name === 'none' || name === 'headless') return undefined;
  if (!launching(platform)) {
    throw new BrowserUsageError(
      `--browser ${name} has no launcher on this platform; use --browser none`,
    );
  }
  if (name === 'auto' || name === 'system') {
    return platformDefault(platform, factories);
  }
  return named(platform, PROGRAMS[name][platform], factories);
}

/**
 * The browser `--browser-program <program>` states on `platform`: the
 * platform's named-browser factory with the program as given. Throws
 * `BrowserUsageError` on a platform with no launcher.
 */
export function browserProgramFor(
  program: string,
  platform: string,
  factories: BrowserFactories = SHIPPED_BROWSERS,
): IBrowser {
  if (!launching(platform)) {
    throw new BrowserUsageError(
      '--browser-program has no launcher on this platform; use --browser none',
    );
  }
  return named(platform, program, factories);
}

/** What a run states about its browser: a name, or a program of the user's. */
export type BrowserChoice =
  | { readonly name: BrowserName }
  | { readonly program: string };

/** `browserFor` or `browserProgramFor`, by what the run states. */
export function browserOf(
  choice: BrowserChoice,
  platform: string,
  factories: BrowserFactories = SHIPPED_BROWSERS,
): IBrowser | undefined {
  return 'program' in choice
    ? browserProgramFor(choice.program, platform, factories)
    : browserFor(choice.name, platform, factories);
}
