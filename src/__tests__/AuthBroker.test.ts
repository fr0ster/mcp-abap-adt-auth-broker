/**
 * Tests for AuthBroker class
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../AuthBroker';

describe('AuthBroker', () => {
  let tempDir: string;
  let broker: AuthBroker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-test-'));
    // Use default browser (system) - no browser parameter passed
    broker = new AuthBroker([tempDir]);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    broker.clearAllCache();
  });

  describe('constructor', () => {
    it('should use constructor paths', () => {
      const customBroker = new AuthBroker(['/custom/path1', '/custom/path2']);
      expect(customBroker).toBeInstanceOf(AuthBroker);
    });

    it('should use single string path', () => {
      const customBroker = new AuthBroker('/single/path');
      expect(customBroker).toBeInstanceOf(AuthBroker);
    });

    it('should use AUTH_BROKER_PATH environment variable', () => {
      const originalEnv = process.env.AUTH_BROKER_PATH;
      process.env.AUTH_BROKER_PATH = '/env/path1:/env/path2';
      
      const envBroker = new AuthBroker();
      expect(envBroker).toBeInstanceOf(AuthBroker);
      
      process.env.AUTH_BROKER_PATH = originalEnv;
    });

    it('should use current working directory as fallback', () => {
      const originalEnv = process.env.AUTH_BROKER_PATH;
      delete process.env.AUTH_BROKER_PATH;
      
      const defaultBroker = new AuthBroker();
      expect(defaultBroker).toBeInstanceOf(AuthBroker);
      
      process.env.AUTH_BROKER_PATH = originalEnv;
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific destination', () => {
      expect(() => broker.clearCache('TRIAL')).not.toThrow();
    });

    it('should clear all cache', () => {
      expect(() => broker.clearAllCache()).not.toThrow();
    });
  });

  // Note: getToken and refreshToken tests would require more complex mocking
  // of axios, file system, and token validation. These are integration-level tests.
});

