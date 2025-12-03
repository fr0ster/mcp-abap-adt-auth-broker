/**
 * Unified tests for AuthBroker.getToken and refreshToken methods
 * 
 * These methods have similar behavior but key differences:
 * - getToken: Validates token first, only refreshes if expired/invalid
 * - refreshToken: Always forces refresh, never validates existing token
 * 
 * NOTE: Tests that require service keys will look for files in:
 *   - ./test-destinations/ (relative to project root)
 *   - Or path specified in TEST_DESTINATIONS_PATH environment variable
 * 
 * Configuration:
 *   - Destination name is read from tests/test-config.yaml (auth_broker.abap.destination)
 *   - If not configured, defaults to "TRIAL"
 *   - To configure: copy tests/test-config.yaml.template to tests/test-config.yaml and fill in values
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

describe('AuthBroker token methods', () => {
  let brokers: TestBrokers;
  let test1Passed = false;

  beforeEach(() => {
    brokers = setupTestBrokers('tokenMethods');
  });

  afterEach(() => {
    cleanupTestBrokers(brokers);
  });

  describe('Test 1: Destination that does not exist', () => {
    it.each([
      ['getToken', 'getToken'],
      ['refreshToken', 'refreshToken'],
    ])('%s should throw error when destination file does not exist', async (methodName, method) => {
      if (!checkNoExistsFile()) {
        return;
      }
      
      const broker = brokers.broker as any;
      const error = await broker[method]('NO_EXISTS').catch((e: Error) => e);
      
      expect(error).toBeInstanceOf(Error);
      
      if (method === 'getToken') {
        expect(error.message).toContain('No authentication found for destination "NO_EXISTS"');
        expect(error.message).toContain('No session data and no service key found');
      } else {
        expect(error.message).toContain('Service key not found for destination "NO_EXISTS"');
      }
      
      if (method === 'getToken') {
        test1Passed = true;
      }
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📋 Test 1 passed (${methodName}) - Error: ${error.message.split('\n')[0]}`);
      }
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it.each([
      ['getToken', 'getToken'],
      ['refreshToken', 'refreshToken'],
    ])('%s should trigger browser auth when service key exists but .env does not', async (methodName, method) => {
      if (!test1Passed && method === 'refreshToken') {
        if (process.env.TEST_VERBOSE) {
          console.log(`⏭️  Skipping Test 2 (${methodName}): Test 1 must pass first`);
        }
        return;
      }
      
      const { envFile, serviceKeyPath, shouldSkip } = prepareTest2();
      if (shouldSkip) {
        return;
      }

      if (process.env.TEST_VERBOSE) {
        console.log(`📁 Test 2 (${methodName}): service key: ${serviceKeyPath}, session: ${envFile}`);
      }

      const destination = getTestDestination();
      const broker = brokers.testDestinationsBroker as any;
      const token = await broker[method](destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
    }, 300000);
  });

  describe('Test 3: .env file exists', () => {
    it('getToken should validate token and only refresh if expired', async () => {
      const { envFile, serviceKeyPath, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      if (process.env.TEST_VERBOSE) {
        console.log(`📁 Test 3 (getToken): service key: ${serviceKeyPath}, session: ${envFile}, URL: ${sapUrl}`);
      }

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.getToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });

    it('refreshToken should ALWAYS force refresh even if token is valid', async () => {
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
        console.log(`📁 Test 3 (refreshToken): service key: ${serviceKeyPath}, session: ${envFile}, URL: ${sapUrl}`);
      }

      const destination = getTestDestination();
      const token = await brokers.testDestinationsBroker.refreshToken(destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
    });
  });

  describe('Error cases (refreshToken specific)', () => {
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

