/**
 * Test logger with environment variable control
 * Uses DefaultLogger from @mcp-abap-adt/logger for proper formatting
 */

import type { ILogger } from '@mcp-abap-adt/interfaces';
import { DefaultLogger, getLogLevel } from '@mcp-abap-adt/logger';

export function createTestLogger(prefix: string = 'TEST'): ILogger {
  // Check if logging is enabled - requires explicit enable
  const isEnabled = (): boolean => {
    // Explicitly disabled (support both short and long names)
    if (
      process.env.DEBUG_BROKER === 'false' ||
      process.env.DEBUG_AUTH_BROKER === 'false'
    ) {
      return false;
    }
    // Explicitly enabled (support both short and long names)
    if (
      process.env.DEBUG_BROKER === 'true' ||
      process.env.DEBUG_AUTH_BROKER === 'true' ||
      process.env.DEBUG === 'true' ||
      process.env.DEBUG?.includes('broker') === true ||
      process.env.DEBUG?.includes('auth-broker') === true
    ) {
      return true;
    }
    // Do not enable by default - require explicit enable
    return false;
  };

  // Create DefaultLogger with appropriate log level
  // getLogLevel respects AUTH_LOG_LEVEL env var and defaults to INFO
  const baseLogger = new DefaultLogger(getLogLevel());

  // Return wrapper that checks if logging is enabled
  return {
    debug: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.debug(`[${prefix}] ${message}`, meta);
      }
    },
    info: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.info(`[${prefix}] ${message}`, meta);
      }
    },
    warn: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.warn(`[${prefix}] ${message}`, meta);
      }
    },
    error: (message: string, meta?: unknown) => {
      if (isEnabled()) {
        baseLogger.error(`[${prefix}] ${message}`, meta);
      }
    },
  };
}
