/**
 * Common test helpers for AuthBroker tests
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../AuthBroker';
import { testLogger } from '../logger';

// Fixed test destinations path - user can place service keys here
export const TEST_DESTINATIONS_PATH = process.env.TEST_DESTINATIONS_PATH || path.join(process.cwd(), 'test-destinations');

export interface TestBrokers {
  tempDir: string;
  broker: AuthBroker;
  testDestinationsBroker: AuthBroker;
}

/**
 * Setup test brokers for a test suite
 */
export function setupTestBrokers(testName: string): TestBrokers {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `auth-broker-${testName}-test-`));
  const broker = new AuthBroker([tempDir], undefined, testLogger);
  const testDestinationsBroker = new AuthBroker([TEST_DESTINATIONS_PATH], undefined, testLogger);
  
  return { tempDir, broker, testDestinationsBroker };
}

/**
 * Cleanup test brokers
 */
export function cleanupTestBrokers(brokers: TestBrokers): void {
  if (brokers.tempDir && fs.existsSync(brokers.tempDir)) {
    fs.rmSync(brokers.tempDir, { recursive: true, force: true });
  }
  brokers.broker.clearAllCache();
  brokers.testDestinationsBroker.clearAllCache();
}

/**
 * Check if NO_EXISTS.json exists and skip test if it does
 */
export function checkNoExistsFile(): boolean {
  const noExistsJson = path.join(TEST_DESTINATIONS_PATH, 'NO_EXISTS.json');
  if (fs.existsSync(noExistsJson)) {
    return false;
  }
  return true;
}

/**
 * Prepare Test 2: Remove TRIAL.env if exists, check for TRIAL.json
 */
export function prepareTest2(): { envFile: string; serviceKeyPath: string; shouldSkip: boolean } {
  const envFile = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.env');
  const serviceKeyPath = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.json');
  
  // Remove TRIAL.env if it exists before Test 2
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
  }
  
  // Check if service key exists
  if (!fs.existsSync(serviceKeyPath)) {
    return { envFile, serviceKeyPath, shouldSkip: true };
  }
  
  return { envFile, serviceKeyPath, shouldSkip: false };
}

/**
 * Prepare Test 3: Check for TRIAL.json and TRIAL.env
 */
export function prepareTest3(): { envFile: string; serviceKeyPath: string; sapUrl: string; shouldSkip: boolean } {
  const serviceKeyPath = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.json');
  const envFile = path.join(TEST_DESTINATIONS_PATH, 'TRIAL.env');
  
  // Check if service key exists
  if (!fs.existsSync(serviceKeyPath)) {
    return { envFile, serviceKeyPath, sapUrl: '', shouldSkip: true };
  }

  // Test 3 requires TRIAL.env file to exist
  if (!fs.existsSync(envFile)) {
    return { envFile, serviceKeyPath, sapUrl: '', shouldSkip: true };
  }

  const serviceKey = JSON.parse(fs.readFileSync(serviceKeyPath, 'utf8'));
  const envContent = fs.readFileSync(envFile, 'utf8');
  
  // Extract SAP_URL from .env or service key
  const urlMatch = envContent.match(/SAP_URL=(.+)/);
  const sapUrl = urlMatch ? urlMatch[1].trim() : (serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url);
  
  return { envFile, serviceKeyPath, sapUrl, shouldSkip: false };
}

/**
 * Verify .env file contains required tokens
 */
export function verifyEnvFile(envFile: string, requireRefreshToken: boolean = false): void {
  expect(fs.existsSync(envFile)).toBe(true);
  const envContent = fs.readFileSync(envFile, 'utf8');
  expect(envContent).toContain('SAP_JWT_TOKEN=');
  if (requireRefreshToken) {
    expect(envContent).toContain('SAP_REFRESH_TOKEN=');
  }
}

