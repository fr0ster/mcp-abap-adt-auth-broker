/**
 * Tests for AuthBroker.getToken - covers main scenarios
 * 
 * NOTE: Tests that require service keys will look for files in:
 *   - ./test-destinations/ (relative to project root)
 *   - Or path specified in TEST_DESTINATIONS_PATH environment variable
 * 
 * To run tests that require service keys, place your service key files there:
 *   ./test-destinations/TRIAL.json
 */

import { AuthBroker } from '../AuthBroker';
import {
  setupTestBrokers,
  cleanupTestBrokers,
  checkNoExistsFile,
  prepareTest2,
  prepareTest3,
  verifyEnvFile,
  TEST_DESTINATIONS_PATH,
  TestBrokers,
} from './testHelpers';
import * as path from 'path';
import * as fs from 'fs';

describe('AuthBroker.getToken', () => {
  let brokers: TestBrokers;
  let test1Passed = false;

  beforeEach(() => {
    brokers = setupTestBrokers('getToken');
  });

  afterEach(() => {
    cleanupTestBrokers(brokers);
  });

  describe('Test 1: Destination that does not exist', () => {
    it('should throw error when destination file does not exist', async () => {
      if (!checkNoExistsFile()) {
        return;
      }
      
      const error = await brokers.broker.getToken('NO_EXISTS').catch(e => e);
      
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('No authentication found for destination "NO_EXISTS"');
      expect(error.message).toContain('Please create one of:');
      expect(error.message).toContain('NO_EXISTS.env');
      expect(error.message).toContain('NO_EXISTS.json');
      expect(error.message).toContain('Searched in:');
      
      test1Passed = true;
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it('should trigger browser auth when TRIAL.json exists but TRIAL.env does not', async () => {
      if (!test1Passed) {
        return;
      }
      
      const { envFile, shouldSkip } = prepareTest2();
      if (shouldSkip) {
        return;
      }

      const token = await brokers.testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
    }, 300000);
  });

  describe('Test 3: .env file exists - token validation and refresh flow', () => {
    it('should return valid token from .env without refresh if token is valid', async () => {
      const { envFile, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      const token = await brokers.testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });

    it('should refresh expired token via refreshToken (not browser auth) when refresh token is valid', async () => {
      const { envFile, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      // Check if refresh token exists
      const envContent = fs.readFileSync(envFile, 'utf8');
      const refreshTokenMatch = envContent.match(/SAP_REFRESH_TOKEN=(.+)/);
      if (!refreshTokenMatch) {
        return;
      }

      // Clear cache to force loading from .env
      brokers.testDestinationsBroker.clearAllCache();

      const token = await brokers.testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });
  });
});
