/**
 * Tests for envLoader module
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { loadEnvFile } from '../../../storage/abap/envLoader';

describe('envLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-env-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should load valid .env file', async () => {
    const envContent = `
SAP_URL=https://test.sap.com
SAP_CLIENT=100
SAP_JWT_TOKEN=test_token_123
SAP_REFRESH_TOKEN=refresh_token_456
SAP_UAA_URL=https://uaa.test.com
SAP_UAA_CLIENT_ID=client_id
SAP_UAA_CLIENT_SECRET=client_secret
    `.trim();

    const envFile = path.join(tempDir, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [tempDir]);

    expect(config).not.toBeNull();
    expect(config?.sapUrl).toBe('https://test.sap.com');
    expect(config?.sapClient).toBe('100');
    expect(config?.jwtToken).toBe('test_token_123');
    expect(config?.refreshToken).toBe('refresh_token_456');
    expect(config?.uaaUrl).toBe('https://uaa.test.com');
    expect(config?.uaaClientId).toBe('client_id');
    expect(config?.uaaClientSecret).toBe('client_secret');
  });

  it('should return null if file not found', async () => {
    const config = await loadEnvFile('NONEXISTENT', [tempDir]);
    expect(config).toBeNull();
  });

  it('should return null if SAP_URL missing', async () => {
    const envContent = `
SAP_JWT_TOKEN=test_token
    `.trim();

    const envFile = path.join(tempDir, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [tempDir]);
    expect(config).toBeNull();
  });

  it('should return null if SAP_JWT_TOKEN missing', async () => {
    const envContent = `
SAP_URL=https://test.sap.com
    `.trim();

    const envFile = path.join(tempDir, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [tempDir]);
    expect(config).toBeNull();
  });

  it('should handle optional fields', async () => {
    const envContent = `
SAP_URL=https://test.sap.com
SAP_JWT_TOKEN=test_token
    `.trim();

    const envFile = path.join(tempDir, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [tempDir]);

    expect(config).not.toBeNull();
    expect(config?.sapUrl).toBe('https://test.sap.com');
    expect(config?.jwtToken).toBe('test_token');
    expect(config?.sapClient).toBeUndefined();
    expect(config?.refreshToken).toBeUndefined();
  });

  it('should trim whitespace from values', async () => {
    const envContent = `
SAP_URL=  https://test.sap.com  
SAP_JWT_TOKEN=  test_token  
    `.trim();

    const envFile = path.join(tempDir, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [tempDir]);

    expect(config).not.toBeNull();
    expect(config?.sapUrl).toBe('https://test.sap.com');
    expect(config?.jwtToken).toBe('test_token');
  });

  it('should search in multiple paths', async () => {
    const dir1 = path.join(tempDir, 'dir1');
    const dir2 = path.join(tempDir, 'dir2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const envContent = `
SAP_URL=https://test.sap.com
SAP_JWT_TOKEN=test_token
    `.trim();

    const envFile = path.join(dir2, 'TRIAL.env');
    fs.writeFileSync(envFile, envContent);

    const config = await loadEnvFile('TRIAL', [dir1, dir2]);
    expect(config).not.toBeNull();
    expect(config?.sapUrl).toBe('https://test.sap.com');
  });
});

