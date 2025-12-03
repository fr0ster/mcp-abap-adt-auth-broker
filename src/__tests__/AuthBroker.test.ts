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
    const { AbapServiceKeyStore, AbapSessionStore } = require('../stores');
    broker = new AuthBroker({
      serviceKeyStore: new AbapServiceKeyStore([tempDir]),
      sessionStore: new AbapSessionStore([tempDir]),
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
      const customTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-custom-test-'));
      const { AbapServiceKeyStore, AbapSessionStore } = require('../stores');
      const customBroker = new AuthBroker({
        serviceKeyStore: new AbapServiceKeyStore([customTempDir]),
        sessionStore: new AbapSessionStore([customTempDir]),
      });
      expect(customBroker).toBeInstanceOf(AuthBroker);
      // Cleanup
      if (fs.existsSync(customTempDir)) {
        fs.rmSync(customTempDir, { recursive: true, force: true });
      }
    });

    it('should create broker with SafeSessionStore', () => {
      const { AbapServiceKeyStore, SafeAbapSessionStore } = require('../stores');
      const safeBroker = new AuthBroker({
        serviceKeyStore: new AbapServiceKeyStore(),
        sessionStore: new SafeAbapSessionStore(),
      });
      expect(safeBroker).toBeInstanceOf(AuthBroker);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific destination', () => {
      const { getTestDestination } = require('./testHelpers');
      const destination = getTestDestination();
      expect(() => broker.clearCache(destination)).not.toThrow();
    });

    it('should clear all cache', () => {
      expect(() => broker.clearAllCache()).not.toThrow();
    });
  });

  // Note: getToken and refreshToken tests would require more complex mocking
  // of axios, file system, and token validation. These are integration-level tests.
});

