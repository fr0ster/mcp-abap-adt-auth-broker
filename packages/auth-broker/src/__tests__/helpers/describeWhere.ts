/**
 * The live and stand suites' one way to say where a block runs: run it, or
 * skip it with the reason in its title and in the log. `runLog` is the logger
 * those suites print their results with — `@mcp-abap-adt/logger`'s
 * `DefaultLogger`, as `createTestLogger` builds on, always on: a live or stand
 * run's result is the point (level from `AUTH_LOG_LEVEL`).
 */
import { DefaultLogger, getLogLevel } from '@mcp-abap-adt/logger';

export const runLog = new DefaultLogger(getLogLevel());

export function describeWhere(
  title: string,
  unavailable: string | null,
  body: () => void,
): void {
  if (unavailable) {
    runLog.info(`skipped: ${title} — ${unavailable}`);
    describe.skip(`${title} — skipped: ${unavailable}`, body);
  } else {
    describe(title, body);
  }
}
