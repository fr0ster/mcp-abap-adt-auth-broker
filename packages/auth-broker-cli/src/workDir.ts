/**
 * A private working directory for one CLI run, removed however the run ends.
 *
 * The CLIs keep a temporary session store (and, for a `credentials`-wrapped
 * service key, an unwrapped copy of the key) while they log in. Both hold the
 * client secret. They used to live in `.tmp` beside the output file — in the
 * user's sessions folder, shared by every run — and were removed only on
 * success: a failed or interrupted login left the secret there, and two runs
 * at once shared one directory that each removed on exit.
 *
 * Now each run gets its own directory under the OS temp dir, readable by the
 * user alone. Its owner — the run's interrupt (`interrupt.ts`) — removes it
 * on every exit: success, error, `process.exit()` or a signal.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface WorkDir {
  /** The directory: mode 0700, the user's alone. */
  readonly path: string;
  /** Removes it and everything in it; never throws. */
  remove(): void;
}

export function createWorkDir(prefix: string): WorkDir {
  // mkdtemp creates the directory with mode 0700: the secret is the user's alone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    path: dir,
    remove: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Nothing left to do on the way out.
      }
    },
  };
}
