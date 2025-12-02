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
    const { FileServiceKeyStore, FileSessionStore } = require('../stores');
    broker = new AuthBroker({
      serviceKeyStore: new FileServiceKeyStore([tempDir]),
      sessionStore: new FileSessionStore([tempDir]),
    });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    broker.clearAllCache();
  });

  describe('constructor', () => {
    it('should create broker with default stores', () => {
      const defaultBroker = new AuthBroker();
      expect(defaultBroker).toBeInstanceOf(AuthBroker);
    });

    it('should create broker with custom stores', () => {
      const { FileServiceKeyStore, FileSessionStore } = require('../stores');
      const customBroker = new AuthBroker({
        serviceKeyStore: new FileServiceKeyStore(['/custom/path1', '/custom/path2']),
        sessionStore: new FileSessionStore(['/custom/path1', '/custom/path2']),
      });
      expect(customBroker).toBeInstanceOf(AuthBroker);
    });

    it('should create broker with SafeSessionStore', () => {
      const { FileServiceKeyStore, SafeSessionStore } = require('../stores');
      const safeBroker = new AuthBroker({
        serviceKeyStore: new FileServiceKeyStore(),
        sessionStore: new SafeSessionStore(),
      });
      expect(safeBroker).toBeInstanceOf(AuthBroker);
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

