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
 */

import { AuthBroker } from '../AuthBroker';
import {
  setupTestBrokers,
  cleanupTestBrokers,
  checkNoExistsFile,
  prepareTest2,
  prepareTest3,
  verifyEnvFile,
  TestBrokers,
} from './testHelpers';
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
        expect(error.message).toContain('Please create one of:');
        expect(error.message).toContain('NO_EXISTS.env');
      } else {
        expect(error.message).toContain('Service key file not found for destination "NO_EXISTS"');
        expect(error.message).toContain('Please create file:');
      }
      expect(error.message).toContain('NO_EXISTS.json');
      expect(error.message).toContain('Searched in:');
      
      if (method === 'getToken') {
        test1Passed = true;
      }
      
      console.log(`📋 Test 1 passed (${methodName}) - Error: ${error.message.split('\n')[0]}`);
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it.each([
      ['getToken', 'getToken'],
      ['refreshToken', 'refreshToken'],
    ])('%s should trigger browser auth when TRIAL.json exists but TRIAL.env does not', async (methodName, method) => {
      if (!test1Passed && method === 'refreshToken') {
        console.log(`\n⏭️  Skipping Test 2 (${methodName}): Test 1 must pass first`);
        return;
      }
      
      const { envFile, shouldSkip } = prepareTest2();
      if (shouldSkip) {
        return;
      }

      console.log(`🌐 Test 2 (${methodName}): Starting browser authentication. Browser will open. Please complete authentication.`);

      const broker = brokers.testDestinationsBroker as any;
      const token = await broker[method]('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
      
      console.log(`\n✅ Test 2 passed (${methodName}) - Browser auth completed. .env file created at: ${envFile}`);
    }, 300000);
  });

  describe('Test 3: .env file exists', () => {
    it('getToken should validate token and only refresh if expired', async () => {
      const { envFile, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      console.log(`🔄 Test 3 (getToken): Getting token from existing .env file (URL: ${sapUrl})`);
      console.log(`   Note: getToken validates token first - if valid, returns without refresh`);

      const token = await brokers.testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
      
      console.log(`\n✅ Test 3 passed (getToken) - Token obtained (validated, may or may not be refreshed)`);
    });

    it('refreshToken should ALWAYS force refresh even if token is valid', async () => {
      const { envFile, sapUrl, shouldSkip } = prepareTest3();
      if (shouldSkip) {
        return;
      }

      // Check if refresh token exists
      const envContent = fs.readFileSync(envFile, 'utf8');
      const refreshTokenMatch = envContent.match(/SAP_REFRESH_TOKEN=(.+)/);
      if (!refreshTokenMatch) {
        console.log(`\n⚠️  Test 3 (refreshToken) requires SAP_REFRESH_TOKEN in .env file`);
        console.log(`   Run Test 2 first to create it.`);
        return;
      }

      console.log(`🔄 Test 3 (refreshToken): FORCING token refresh (always refreshes, unlike getToken)`);
      console.log(`   URL: ${sapUrl}`);

      const token = await brokers.testDestinationsBroker.refreshToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile);
      
      console.log(`\n✅ Test 3 passed (refreshToken) - Token force refreshed`);
      console.log(`   Key difference: refreshToken always refreshes, getToken only if expired`);
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

      const skFile = path.join(brokers.tempDir, 'TRIAL.json');
      fs.writeFileSync(skFile, JSON.stringify(invalidServiceKey));

      await expect(brokers.broker.refreshToken('TRIAL')).rejects.toThrow(
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

      const skFile = path.join(brokers.tempDir, 'TRIAL.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      await expect(brokers.broker.refreshToken('TRIAL')).rejects.toThrow(
        'Service key for destination "TRIAL" does not contain SAP URL'
      );
    });
  });
});

