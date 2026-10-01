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
 * user alone, and it is removed on any exit: success, error, or a signal.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SIGNAL_EXIT_CODES: Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

export function createWorkDir(prefix: string): string {
  // mkdtemp creates the directory with mode 0700: the secret is the user's alone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

  const remove = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing left to do on the way out.
    }
  };

  // `exit` covers process.exit() and a normal end; it does not fire for a
  // signal, so each is handled too, and exits with the conventional code.
  process.once('exit', remove);
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.once(signal as NodeJS.Signals, () => {
      remove();
      process.exit(code);
    });
  }

  return dir;
}
