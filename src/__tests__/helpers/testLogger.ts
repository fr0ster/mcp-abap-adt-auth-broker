/**
 * Test logger with environment variable control
 */

import type { ILogger } from '@mcp-abap-adt/interfaces';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase() || 'info';
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return levels.includes(level as LogLevel) ? (level as LogLevel) : 'info';
}

function shouldLog(level: LogLevel): boolean {
  const currentLevel = getLogLevel();
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return levels.indexOf(level) >= levels.indexOf(currentLevel);
}

export function createTestLogger(prefix: string = 'TEST'): ILogger {
  // Check if logging is enabled - requires explicit enable
  const isEnabled = (): boolean => {
    // Explicitly disabled
    if (process.env.DEBUG_AUTH_BROKER === 'false') {
      return false;
    }
    // Explicitly enabled
    if (
      process.env.DEBUG_AUTH_BROKER === 'true' ||
      process.env.DEBUG === 'true' ||
      process.env.DEBUG?.includes('auth-broker') === true
    ) {
      return true;
    }
    // Do not enable by default - require explicit enable
    return false;
  };

  // Format message and meta into single line
  const formatMessage = (message: string, meta?: any): string => {
    if (!meta || meta === '') {
      return message;
    }
    // If meta is an object, format it concisely
    if (typeof meta === 'object' && !Array.isArray(meta)) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(meta)) {
        if (value !== undefined && value !== null) {
          if (typeof value === 'string' && value.length > 50) {
            parts.push(`${key}(${value.substring(0, 50)}...)`);
          } else if (typeof value === 'boolean') {
            parts.push(`${key}(${value})`);
          } else {
            parts.push(`${key}(${value})`);
          }
        }
      }
      return parts.length > 0 ? `${message} ${parts.join(', ')}` : message;
    }
    // If meta is a string or other type, append it
    return `${message} ${String(meta)}`;
  };

  return {
    debug: (message: string, meta?: any) => {
      if (isEnabled() && shouldLog('debug')) {
        console.debug(`[${prefix}] [DEBUG] ${formatMessage(message, meta)}`);
      }
    },
    info: (message: string, meta?: any) => {
      if (isEnabled() && shouldLog('info')) {
        console.info(`[${prefix}] ${formatMessage(message, meta)}`);
      }
    },
    warn: (message: string, meta?: any) => {
      if (isEnabled() && shouldLog('warn')) {
        console.warn(`[${prefix}] [WARN] ${formatMessage(message, meta)}`);
      }
    },
    error: (message: string, meta?: any) => {
      if (isEnabled() && shouldLog('error')) {
        console.error(`[${prefix}] [ERROR] ${formatMessage(message, meta)}`);
      }
    },
  };
}
