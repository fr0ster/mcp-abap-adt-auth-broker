/**
 * Tests for AuthBroker.refreshToken - covers refresh and browser auth scenarios
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
  TestBrokers,
} from './testHelpers';
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
      expect(error.message).toContain('Service key file not found for destination "NO_EXISTS"');
      expect(error.message).toContain('Please create file:');
      expect(error.message).toContain('NO_EXISTS.json');
      expect(error.message).toContain('Searched in:');
      
      test1Passed = true;
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it('should start browser auth when TRIAL.json exists but TRIAL.env does not', async () => {
      if (!test1Passed) {
        return;
      }
      
      const { envFile, shouldSkip } = prepareTest2();
      if (shouldSkip) {
        return;
      }

      const token = await brokers.testDestinationsBroker.refreshToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      verifyEnvFile(envFile, true);
    }, 300000);
  });

  describe('Test 3: .env file exists - force refresh', () => {
    it('should ALWAYS refresh token even if .env token is valid', async () => {
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

      const token = await brokers.testDestinationsBroker.refreshToken('TRIAL');

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
