/**
 * Tests for AuthBroker class
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../../AuthBroker';
import { AbapServiceKeyStore, AbapSessionStore } from '../../stores';
import { BtpTokenProvider } from '../../providers';

describe('AuthBroker', () => {
  let tempDir: string;
  let broker: AuthBroker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-test-'));
    // Use default browser (system) - no browser parameter passed
    broker = new AuthBroker({
      serviceKeyStore: new AbapServiceKeyStore([tempDir]),
      sessionStore: new AbapSessionStore([tempDir]),
      tokenProvider: new BtpTokenProvider(),
    });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    broker.clearAllCache();
  });

  describe('constructor', () => {
    // Note: AuthBroker now requires stores and tokenProvider in constructor
    // No default stores - must provide explicit configuration

    it('should create broker with custom stores', () => {
      const customTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-custom-test-'));
      const customBroker = new AuthBroker({
        serviceKeyStore: new AbapServiceKeyStore([customTempDir]),
        sessionStore: new AbapSessionStore([customTempDir]),
        tokenProvider: new BtpTokenProvider(),
      });
      expect(customBroker).toBeInstanceOf(AuthBroker);
      // Cleanup
      if (fs.existsSync(customTempDir)) {
        fs.rmSync(customTempDir, { recursive: true, force: true });
      }
    });

    it('should create broker with SafeSessionStore', () => {
      const { SafeAbapSessionStore } = require('../../stores');
      const { BtpTokenProvider } = require('../../providers');
      const safeBroker = new AuthBroker({
        serviceKeyStore: new AbapServiceKeyStore(),
        sessionStore: new SafeAbapSessionStore(),
        tokenProvider: new BtpTokenProvider(),
      });
      expect(safeBroker).toBeInstanceOf(AuthBroker);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific destination', () => {
      const { getTestDestination } = require('../helpers/testHelpers');
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

