/**
 * Tests for AuthBroker.refreshToken - covers refresh and browser auth scenarios
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

import { AuthBroker } from '../../AuthBroker';
import {
  setupTestBrokers,
  cleanupTestBrokers,
  checkNoExistsFile,
  prepareTest2,
  prepareTest3,
  verifyEnvFile,
  getTestDestination,
  TestBrokers,
} from '../helpers/testHelpers';
import * as path from 'path';
import * as fs from 'fs';

describe('AuthBroker.refreshToken', () => {
  let brokers: TestBrokers;
  let test1Passed = false;

  beforeEach(() => {
    brokers = setupTestBrokers('refreshToken');
  });

  afterEach(() => {
    cleanupTestBrokers(brokers);
  });

  describe('Test 1: Destination that does not exist', () => {
    it('should throw error when trying to refresh without service key', async () => {
      if (!checkNoExistsFile()) {
        return;
      }
      
      const error = await brokers.broker.refreshToken('NO_EXISTS').catch(e => e);
      
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Service key not found for destination "NO_EXISTS"');
      
      test1Passed = true;
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it(`should start browser auth when service key exists but .env does not (files: ${getTestDestination()}.json, ${getTestDestination()}.env)`, async () => {
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

      // Create broker with 'system' browser for this test (needs browser auth)
      const { AuthBrokerTestHelper } = require('../helpers/AuthBrokerTestHelper');
      const browserBroker = AuthBrokerTestHelper.createAbapBrokerFromYaml({
        browser: 'system',
        logger: brokers.testDestinationsBroker['logger']
      });

      const destination = getTestDestination();
      const token = await browserBroker.refreshToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
    }, 300000);
  });

  describe('Test 3: .env file exists - force refresh', () => {
    it(`should ALWAYS refresh token even if .env token is valid (files: ${getTestDestination()}.json, ${getTestDestination()}.env)`, async () => {
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
        console.log(`📁 Test 3: service key: ${serviceKeyPath}, session: ${envFile}, URL: ${sapUrl}`);
      }

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.refreshToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });
  });

  describe('Error cases', () => {
    it('should throw error if service key missing UAA fields', async () => {
      const invalidServiceKey = {
        url: 'https://test.sap.com',
        uaa: {
          // Missing required fields
        },
      };

      const destination = getTestDestination();
      const skFile = path.join(brokers.tempDir, `${destination}.json`);
      fs.writeFileSync(skFile, JSON.stringify(invalidServiceKey));

      await expect(brokers.broker.refreshToken(destination)).rejects.toThrow(
        'Service key "uaa" object missing required fields'
      );
    });

    it('should throw error if service key missing SAP URL', async () => {
      const serviceKey = {
        // Missing url, abap.url, and sap_url
        uaa: {
          url: 'https://uaa.test.com',
          clientid: 'test_client_id',
          clientsecret: 'test_client_secret',
        },
      };

      const destination = getTestDestination();
      const skFile = path.join(brokers.tempDir, `${destination}.json`);
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      // When service key has no SAP URL, refreshToken will try to get token via browser auth
      // But with browser: 'none', it should throw error immediately instead of hanging
      await expect(brokers.broker.refreshToken(destination)).rejects.toThrow();
    }, 10000); // Add timeout to prevent hanging
  });
});
