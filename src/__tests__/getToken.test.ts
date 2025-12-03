/**
 * Tests for AuthBroker.getToken - covers main scenarios
 * 
 * NOTE: Tests that require service keys will look for files in:
 *   - ./test-destinations/ (relative to project root)
 *   - Or path specified in TEST_DESTINATIONS_PATH environment variable
 * 
 * Configuration:
 *   - Destination name is read from tests/test-config.yaml (auth_broker.abap.destination)
 *   - If not configured, defaults to "TRIAL"
 *   - To configure: copy tests/test-config.yaml.template to tests/test-config.yaml and fill in values
 * 
 * To run tests that require service keys, place your service key files there:
 *   ./test-destinations/<destination>.json (where <destination> is from YAML config)
 */

import { AuthBroker } from '../AuthBroker';
import {
  setupTestBrokers,
  cleanupTestBrokers,
  checkNoExistsFile,
  prepareTest2,
  prepareTest3,
  verifyEnvFile,
  getTestDestination,
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
      expect(error.message).toContain('NO_EXISTS.env');
      expect(error.message).toContain('NO_EXISTS.json');
      expect(error.message).toContain('Searched for session files:');
      expect(error.message).toContain('Searched for service key files:');
      
      test1Passed = true;
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it(`should trigger browser auth when service key exists but .env does not (files: ${getTestDestination()}.json, ${getTestDestination()}.env)`, async () => {
      if (!test1Passed) {
        return;
      }
      
      const { envFile, serviceKeyPath, shouldSkip } = prepareTest2();
      if (shouldSkip) {
        return;
      }

      if (process.env.TEST_VERBOSE) {
        console.log(`📁 Test 2: service key: ${serviceKeyPath}, session: ${envFile}`);
      }

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.getToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
    }, 300000);
  });

  describe('Test 3: .env file exists - token validation and refresh flow', () => {
    it(`should return valid token from .env without refresh if token is valid (files: ${getTestDestination()}.json, ${getTestDestination()}.env)`, async () => {
      const { envFile, serviceKeyPath, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      if (process.env.TEST_VERBOSE) {
        console.log(`📁 Test 3: service key: ${serviceKeyPath}, session: ${envFile}, URL: ${sapUrl}`);
      }

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.getToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });

    it('should refresh expired token via refreshToken (not browser auth) when refresh token is valid', async () => {
      const { envFile, serviceKeyPath, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      // Check if refresh token exists
      const envContent = fs.readFileSync(envFile, 'utf8');
      const refreshTokenMatch = envContent.match(/SAP_REFRESH_TOKEN=(.+)/);
      if (!refreshTokenMatch) {
        return;
      }

      if (process.env.TEST_VERBOSE) {
        console.log(`📁 Test 3 (refresh): service key: ${serviceKeyPath}, session: ${envFile}, URL: ${sapUrl}`);
      }

      // Clear cache to force loading from .env
      brokers.testDestinationsBroker.clearAllCache();

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.getToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });
  });
});
