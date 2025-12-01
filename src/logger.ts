/**
 * Logger interface and implementations for auth-broker package
 */

/**
 * Log levels
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

/**
 * Logger interface - defines logging methods
 */
export interface Logger {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  browserAuth(message: string): void;
  refresh(message: string): void;
  success(message: string): void;
  browserUrl(url: string): void;
  browserOpening(): void;
  testSkip(message: string): void;
}

/**
 * Get log level from environment variable
 * AUTH_LOG_LEVEL can be: error, warn, info, debug
 * DEBUG_AUTH_LOG=true is also supported for backward compatibility (sets level to debug)
 */
function getLogLevel(): LogLevel {
  const level = process.env.AUTH_LOG_LEVEL?.toLowerCase();
  if (level === 'error') return LogLevel.ERROR;
  if (level === 'warn') return LogLevel.WARN;
  if (level === 'info') return LogLevel.INFO;
  if (level === 'debug') return LogLevel.DEBUG;
  // Backward compatibility
  if (process.env.DEBUG_AUTH_LOG === 'true') return LogLevel.DEBUG;
  // Default: info level
  return LogLevel.INFO;
}

/**
 * Default logger implementation
 * Controls output based on AUTH_LOG_LEVEL environment variable:
 * - error: only errors
 * - warn: errors and warnings
 * - info: errors, warnings, and info (default)
 * - debug: all messages
 */
class DefaultLogger implements Logger {
  private readonly logLevel: LogLevel;

  constructor(logLevel?: LogLevel) {
    this.logLevel = logLevel ?? getLogLevel();
  }

  info(message: string): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.info(message);
    }
  }

  debug(message: string): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.debug(`[DEBUG] ${message}`);
    }
  }

  error(message: string): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(message);
    }
  }

  warn(message: string): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`);
    }
  }

  browserAuth(message: string): void {
    this.info(`🌐 ${message}`);
  }

  refresh(message: string): void {
    this.info(`🔄 ${message}`);
  }

  success(message: string): void {
    this.info(`✅ ${message}`);
  }

  browserUrl(url: string): void {
    // Always show URL when browser is not opened automatically (user needs to open manually)
    this.info(`🔗 Open in browser: ${url}`);
  }

  browserOpening(): void {
    // Only show when debug is enabled (browser opens automatically)
    this.debug(`🌐 Opening browser for authentication...`);
  }

  testSkip(message: string): void {
    this.info(`⏭️  ${message}`);
  }
}

/**
 * Test logger implementation
 * Uses same log levels as DefaultLogger
 */
class TestLogger implements Logger {
  private readonly logLevel: LogLevel;

  constructor(logLevel?: LogLevel) {
    this.logLevel = logLevel ?? getLogLevel();
  }

  info(message: string): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.info(message);
    }
  }

  debug(message: string): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.info(`[DEBUG] ${message}`);
    }
  }

  error(message: string): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(message);
    }
  }

  warn(message: string): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`);
    }
  }

  browserAuth(message: string): void {
    this.info(`🌐 ${message}`);
  }

  refresh(message: string): void {
    this.info(`🔄 ${message}`);
  }

  success(message: string): void {
    this.info(`✅ ${message}`);
  }

  browserUrl(url: string): void {
    // Always show URL when browser is not opened automatically (user needs to open manually)
    this.info(`🔗 Open in browser: ${url}`);
  }

  browserOpening(): void {
    // Only show when debug is enabled (browser opens automatically)
    this.debug(`🌐 Opening browser for authentication...`);
  }

  testSkip(message: string): void {
    this.info(`⏭️  ${message}`);
  }
}

// Default logger instance (singleton)
export const defaultLogger: Logger = new DefaultLogger();

// Test logger instance
export const testLogger: Logger = new TestLogger();

// Export convenience functions that use default logger (for backward compatibility)
export function info(message: string): void {
  defaultLogger.info(message);
}

export function debug(message: string): void {
  defaultLogger.debug(message);
}

export function error(message: string): void {
  defaultLogger.error(message);
}

export function browserAuth(message: string): void {
  defaultLogger.browserAuth(message);
}

export function refresh(message: string): void {
  defaultLogger.refresh(message);
}

export function success(message: string): void {
  defaultLogger.success(message);
}

export function browserUrl(url: string): void {
  defaultLogger.browserUrl(url);
}

export function browserOpening(): void {
  defaultLogger.browserOpening();
}

export function testSkip(message: string): void {
  defaultLogger.testSkip(message);
}

export function warn(message: string): void {
  defaultLogger.warn(message);
}
