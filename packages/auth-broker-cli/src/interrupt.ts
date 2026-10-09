/**
 * One interrupt per run (§10.4, D18): a login ends only when the user ends it.
 *
 * `underInterrupt` gives a run its private work directory and one
 * `AbortController`, whose signal the run passes to every wait it has — the
 * broker's calls, the strategies, the terminal reads, `flush()`. While the
 * run lives:
 *
 * - the first `SIGINT` or `SIGTERM` aborts that signal; nothing else. The run
 *   settles `aborted` (the strategy releases its callback socket on the way),
 *   and only then does the interrupt print "the authorization was aborted",
 *   remove the work directory and answer 130 (`SIGINT`) or 143 (`SIGTERM`) —
 *   whatever the run threw, it is not printed: the user ended it;
 * - a second one exits at once with its own code, the work directory removed
 *   first — the user's own bound, should a strategy not settle;
 * - `SIGHUP` exits 129 at once, the work directory removed, as 2.x did.
 *
 * There is no timer: nothing ends a login but its result, an explicit error
 * or the user. After the run every listener it added is removed, the work
 * directory with it. A `process.exit()` inside the run still removes the
 * directory (`exit` listener).
 */

import { AuthProviderFailure, authError } from '@mcp-abap-adt/auth-errors';
import { printFailure } from './output';
import { createWorkDir } from './workDir';

/** The signals a run handles. */
export type HandledSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** The conventional exit code of each: 128 + its number. */
export const SIGNAL_EXIT_CODES: Readonly<Record<HandledSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/** Where signals come from and how the process ends: `process`, unless a test states otherwise. */
export interface InterruptHost {
  on(signal: HandledSignal, listener: () => void): unknown;
  removeListener(signal: HandledSignal, listener: () => void): unknown;
  exit(code: number): void;
}

const processHost: InterruptHost = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) =>
    process.removeListener(signal, listener),
  exit: (code) => process.exit(code),
};

/** What a run gets: the signal of every wait it has, and its work directory. */
export interface InterruptedRun {
  readonly signal: AbortSignal;
  readonly workDir: string;
}

/**
 * Runs `run` under the run's interrupt; resolves its exit code — 130 / 143
 * when the user ended it — and rethrows what it threw otherwise.
 */
export async function underInterrupt(
  prefix: string,
  run: (context: InterruptedRun) => Promise<number>,
  host: InterruptHost = processHost,
): Promise<number> {
  const workDir = createWorkDir(prefix);
  const controller = new AbortController();
  let received: 'SIGINT' | 'SIGTERM' | undefined;

  const listeners: Array<[HandledSignal, () => void]> = [
    ...(['SIGINT', 'SIGTERM'] as const).map(
      (signal): [HandledSignal, () => void] => [
        signal,
        () => {
          if (received === undefined) {
            received = signal;
            controller.abort();
            return;
          }
          workDir.remove();
          host.exit(SIGNAL_EXIT_CODES[signal]);
        },
      ],
    ),
    [
      'SIGHUP',
      () => {
        workDir.remove();
        host.exit(SIGNAL_EXIT_CODES.SIGHUP);
      },
    ],
  ];
  // `exit` covers a process.exit() inside the run; signals are the host's.
  process.once('exit', workDir.remove);
  for (const [signal, listener] of listeners) host.on(signal, listener);

  let failed = false;
  let thrown: unknown;
  let code = 1;
  try {
    code = await run({ signal: controller.signal, workDir: workDir.path });
  } catch (error) {
    failed = true;
    thrown = error;
  } finally {
    for (const [signal, listener] of listeners) {
      host.removeListener(signal, listener);
    }
    process.removeListener('exit', workDir.remove);
    workDir.remove();
  }

  if (received !== undefined) {
    // The user ended the login: auth-errors' words for it, never what the
    // aborted run threw.
    printFailure(
      new AuthProviderFailure(
        authError['interactive-login']({ outcome: 'aborted' }),
      ),
    );
    return SIGNAL_EXIT_CODES[received];
  }
  if (failed) throw thrown;
  return code;
}
