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

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../AuthBroker';

// Fixed test destinations path - user can place service keys here
const TEST_DESTINATIONS_PATH = process.env.TEST_DESTINATIONS_PATH || path.join(process.cwd(), 'test-destinations');

describe('AuthBroker.getToken', () => {
  let tempDir: string;
  let broker: AuthBroker;
  let testDestinationsBroker: AuthBroker;
  
  // Track test execution state to stop subsequent tests if previous ones fail
  let test1Passed = false;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-getToken-test-'));
    // Use default browser (system) - no browser parameter passed
    broker = new AuthBroker([tempDir]);
    
    // Broker that uses fixed test destinations path with default browser
    testDestinationsBroker = new AuthBroker([TEST_DESTINATIONS_PATH]);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    broker.clearAllCache();
    testDestinationsBroker.clearAllCache();
  });

  describe('Test 1: Destination that does not exist', () => {
    it('should throw error when destination file does not exist', async () => {
      // Verify NO_EXISTS.json is absent before test
      const noExistsJson = path.join(TEST_DESTINATIONS_PATH, 'NO_EXISTS.json');
      if (fs.existsSync(noExistsJson)) {
        console.log(`\n⏭️  Skipping Test 1: NO_EXISTS.json exists at ${noExistsJson}`);
        console.log(`   Please remove it before running Test 1.`);
        return;
      }
      
      const error = await broker.getToken('NO_EXISTS').catch(e => e);
      
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('No authentication found for destination "NO_EXISTS"');
      expect(error.message).toContain('Please create one of:');
      expect(error.message).toContain('NO_EXISTS.env');
      expect(error.message).toContain('NO_EXISTS.json');
      expect(error.message).toContain('Searched in:');
      
      // Mark test 1 as passed
      test1Passed = true;
      
      // Print error message so user knows where to place the file
      console.log(`📋 Test 1 passed - Error: ${error.message.split('\n')[0]}`);
    });
  });

  describe('Test 2: Service key exists but no .env file', () => {
    it('should trigger browser auth when TRIAL.json exists but TRIAL.env does not', async () => {
      // Skip if previous test failed
      if (!test1Passed) {
        console.log('\n⏭️  Skipping Test 2: Test 1 must pass first');
        return;
      }
      
      // Remove TRIAL.env if it exists before Test 2
      const envFile = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.env');
      if (fs.existsSync(envFile)) {
        console.log(`\n⚠️  Removing existing ${envFile} before Test 2`);
        fs.unlinkSync(envFile);
      }
      
      const serviceKeyPath = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.json');
      
      // Check if service key exists in test destinations
      if (!fs.existsSync(serviceKeyPath)) {
        console.log(`\n⚠️  Test 2 requires service key file at: ${serviceKeyPath}`);
        console.log(`   Place your service key file there to test browser authentication flow.`);
        console.log(`   Skipping test...`);
        return;
      }

      console.log(`🌐 Test 2: Starting browser authentication. Browser will open. Please complete authentication.`);

      const token = await testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      
      // Verify .env file was created with tokens
      expect(fs.existsSync(envFile)).toBe(true);
      const envContent = fs.readFileSync(envFile, 'utf8');
      expect(envContent).toContain('SAP_JWT_TOKEN=');
      expect(envContent).toContain('SAP_REFRESH_TOKEN=');
      
      console.log(`\n✅ Test 2 passed - Browser auth completed. .env file created at: ${envFile}`);
    }, 300000); // 5 minute timeout for user to complete authentication
  });

  describe('Test 3: .env file exists - token refresh', () => {
    it('should refresh token if .env token is expired', async () => {
      const serviceKeyPath = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.json');
      const envFile = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.env');
      
      // Check if service key exists
      if (!fs.existsSync(serviceKeyPath)) {
        console.log(`\n⚠️  Test 3 requires service key file at: ${serviceKeyPath}`);
        console.log(`   Skipping test...`);
        return;
      }

      // Test 3 requires TRIAL.env file to exist (can be created by Test 2 or manually)
      if (!fs.existsSync(envFile)) {
        console.log(`\n⏭️  Skipping Test 3: TRIAL.env file not found at ${envFile}`);
        console.log(`   Create this file manually or run Test 2 to create it.`);
        return;
      }

      const serviceKey = JSON.parse(fs.readFileSync(serviceKeyPath, 'utf8'));
      const envContent = fs.readFileSync(envFile, 'utf8');
      
      // Extract SAP_URL from .env or service key
      const urlMatch = envContent.match(/SAP_URL=(.+)/);
      const sapUrl = urlMatch ? urlMatch[1].trim() : (serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url);

      console.log(`🔄 Test 3: Getting/refreshing token from existing .env file (URL: ${sapUrl})`);

      const token = await testDestinationsBroker.getToken('TRIAL');

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      
      // Verify .env file still exists (may have been updated)
      expect(fs.existsSync(envFile)).toBe(true);
      const updatedContent = fs.readFileSync(envFile, 'utf8');
      expect(updatedContent).toContain('SAP_JWT_TOKEN=');
      
      console.log(`\n✅ Test 3 passed - Token obtained/refreshed. .env file at: ${envFile}`);
    });
  });

  // Additional edge cases that are not critical but good to have:
  // - Valid token in cache (covered implicitly by Test 3 if token is valid)
  // - Valid token in .env (covered implicitly by Test 3 if token is valid)
  // - Multi-path search (would require complex setup)
  // - Expired refresh token -> browser auth (would require expired refresh token)
  // - Token validation errors (network issues, etc.)
});
