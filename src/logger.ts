/**
 * Logger interface and implementations for auth-broker package
 */

/**
 * Logger interface - defines logging methods
 */
export interface Logger {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
  browserAuth(message: string): void;
  refresh(message: string): void;
  success(message: string): void;
  browserUrl(url: string): void;
  browserOpening(): void;
  testSkip(message: string): void;
}

/**
 * Default logger implementation
 * Controls output based on DEBUG_AUTH_LOG environment variable:
 * - If DEBUG_AUTH_LOG=true: shows debug messages
 * - Otherwise: only shows info messages (concise, one line)
 */
class DefaultLogger implements Logger {
  private readonly debugEnabled: boolean;

  constructor(debugEnabled: boolean = process.env.DEBUG_AUTH_LOG === 'true') {
    this.debugEnabled = debugEnabled;
  }

  info(message: string): void {
    console.info(message);
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      console.debug(`[DEBUG] ${message}`);
    }
  }

  error(message: string): void {
    console.error(message);
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
 * Always shows info messages, debug only if DEBUG_AUTH_LOG=true
 */
class TestLogger implements Logger {
  private readonly debugEnabled: boolean;

  constructor(debugEnabled: boolean = process.env.DEBUG_AUTH_LOG === 'true') {
    this.debugEnabled = debugEnabled;
  }

  info(message: string): void {
    console.info(message);
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      console.info(`[DEBUG] ${message}`);
    }
  }

  error(message: string): void {
    console.error(message);
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
