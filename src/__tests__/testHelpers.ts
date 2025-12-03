/**
 * Common test helpers for AuthBroker tests
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../AuthBroker';
import { testLogger } from '../logger';
import { AbapServiceKeyStore, AbapSessionStore } from '../stores';
import { loadTestConfig, getAbapDestination, getServiceKeysDir, getSessionsDir } from './configHelpers';

/**
 * Resolve path, expanding ~ to home directory
 */
function resolvePath(dirPath: string): string {
  if (dirPath.startsWith('~')) {
    return path.join(os.homedir(), dirPath.slice(1));
  }
  return path.resolve(dirPath);
}

/**
 * Get test service keys directory from YAML config or fallback to default
 */
function getTestServiceKeysDir(): string {
  const config = loadTestConfig();
  const serviceKeysDir = getServiceKeysDir(config);
  if (serviceKeysDir) {
    return resolvePath(serviceKeysDir);
  }
  // Fallback to environment variable or default
  return process.env.TEST_DESTINATIONS_PATH || path.join(process.cwd(), 'test-destinations');
}

/**
 * Get test sessions directory from YAML config or fallback to default
 */
function getTestSessionsDir(): string {
  const config = loadTestConfig();
  const sessionsDir = getSessionsDir(config);
  if (sessionsDir) {
    return resolvePath(sessionsDir);
  }
  // Fallback to same as service keys directory
  return getTestServiceKeysDir();
}

// Export for backward compatibility
export const TEST_DESTINATIONS_PATH = getTestServiceKeysDir();

// Get ABAP destination from YAML config, fallback to "TRIAL"
export function getTestDestination(): string {
  const config = loadTestConfig();
  const destination = getAbapDestination(config);
  return destination || 'TRIAL';
}

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
  const broker = new AuthBroker({
    serviceKeyStore: new AbapServiceKeyStore([tempDir]),
    sessionStore: new AbapSessionStore([tempDir]),
  }, undefined, testLogger);
  
  // Use separate directories for service keys and sessions from YAML config
  const serviceKeysDir = getTestServiceKeysDir();
  const sessionsDir = getTestSessionsDir();
  const testDestinationsBroker = new AuthBroker({
    serviceKeyStore: new AbapServiceKeyStore([serviceKeysDir]),
    sessionStore: new AbapSessionStore([sessionsDir]),
  }, undefined, testLogger);
  
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
  const serviceKeysDir = getTestServiceKeysDir();
  const noExistsJson = path.join(serviceKeysDir, 'NO_EXISTS.json');
  if (fs.existsSync(noExistsJson)) {
    return false;
  }
  return true;
}

/**
 * Prepare Test 2: Remove <destination>.env if exists, check for <destination>.json
 */
export function prepareTest2(): { envFile: string; serviceKeyPath: string; shouldSkip: boolean } {
  const destination = getTestDestination();
  const serviceKeysDir = getTestServiceKeysDir();
  const sessionsDir = getTestSessionsDir();
  const envFile = path.join(sessionsDir, `${destination}.env`);
  const serviceKeyPath = path.join(serviceKeysDir, `${destination}.json`);
  
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
 * Prepare Test 3: Check for <destination>.json and <destination>.env
 */
export function prepareTest3(): { envFile: string; serviceKeyPath: string; sapUrl: string; shouldSkip: boolean } {
  const destination = getTestDestination();
  const serviceKeysDir = getTestServiceKeysDir();
  const sessionsDir = getTestSessionsDir();
  const serviceKeyPath = path.join(serviceKeysDir, `${destination}.json`);
  const envFile = path.join(sessionsDir, `${destination}.env`);
  
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

