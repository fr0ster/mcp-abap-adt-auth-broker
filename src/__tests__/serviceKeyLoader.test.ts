/**
 * Tests for serviceKeyLoader module
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { loadServiceKey } from '../serviceKeyLoader';

describe('serviceKeyLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-sk-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should load valid service key file', async () => {
    const serviceKey = {
      url: 'https://test.sap.com',
      uaa: {
        url: 'https://uaa.test.com',
        clientid: 'test_client_id',
        clientsecret: 'test_client_secret',
      },
    };

    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    const loaded = await loadServiceKey('TRIAL', [tempDir]);

    expect(loaded).not.toBeNull();
    expect(loaded?.url).toBe('https://test.sap.com');
    expect(loaded?.uaa.url).toBe('https://uaa.test.com');
    expect(loaded?.uaa.clientid).toBe('test_client_id');
    expect(loaded?.uaa.clientsecret).toBe('test_client_secret');
  });

  it('should return null if file not found', async () => {
    const loaded = await loadServiceKey('NONEXISTENT', [tempDir]);
    expect(loaded).toBeNull();
  });

  it('should throw error if uaa object missing and not XSUAA format', async () => {
    const serviceKey = {
      url: 'https://test.sap.com',
      // Missing both uaa object and XSUAA fields (clientid, clientsecret)
    };

    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    await expect(loadServiceKey('TRIAL', [tempDir])).rejects.toThrow('Service key does not match any supported format');
  });

  it('should parse XSUAA format service key', async () => {
    const serviceKey = {
      url: 'https://example.authentication.eu10.hana.ondemand.com',
      clientid: 'sb-example-12345!t123',
      clientsecret: 'example-secret-key-12345$example-hash=',
      tenantmode: 'shared',
    };

    const skFile = path.join(tempDir, 'mcp.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    const loaded = await loadServiceKey('mcp', [tempDir]);

    expect(loaded).not.toBeNull();
    expect(loaded?.uaa.url).toBe('https://example.authentication.eu10.hana.ondemand.com');
    expect(loaded?.uaa.clientid).toBe('sb-example-12345!t123');
    expect(loaded?.uaa.clientsecret).toBe('example-secret-key-12345$example-hash=');
  });

  it('should throw error if uaa fields missing', async () => {
    const serviceKey = {
      url: 'https://test.sap.com',
      uaa: {
        url: 'https://uaa.test.com',
        // missing clientid and clientsecret
      },
    };

    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    await expect(loadServiceKey('TRIAL', [tempDir])).rejects.toThrow('Service key "uaa" object missing required fields');
  });

  it('should handle abap.url field', async () => {
    const serviceKey = {
      abap: {
        url: 'https://abap.test.com',
      },
      uaa: {
        url: 'https://uaa.test.com',
        clientid: 'test_client_id',
        clientsecret: 'test_client_secret',
      },
    };

    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    const loaded = await loadServiceKey('TRIAL', [tempDir]);
    expect(loaded).not.toBeNull();
    expect(loaded?.abap?.url).toBe('https://abap.test.com');
  });

  it('should handle sap_url field', async () => {
    const serviceKey = {
      sap_url: 'https://sap.test.com',
      uaa: {
        url: 'https://uaa.test.com',
        clientid: 'test_client_id',
        clientsecret: 'test_client_secret',
      },
    };

    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    const loaded = await loadServiceKey('TRIAL', [tempDir]);
    expect(loaded).not.toBeNull();
    expect(loaded?.sap_url).toBe('https://sap.test.com');
  });

  it('should throw error for invalid JSON', async () => {
    const skFile = path.join(tempDir, 'TRIAL.json');
    fs.writeFileSync(skFile, 'invalid json {');

    await expect(loadServiceKey('TRIAL', [tempDir])).rejects.toThrow('Invalid JSON');
  });

  it('should search in multiple paths', async () => {
    const dir1 = path.join(tempDir, 'dir1');
    const dir2 = path.join(tempDir, 'dir2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const serviceKey = {
      url: 'https://test.sap.com',
      uaa: {
        url: 'https://uaa.test.com',
        clientid: 'test_client_id',
        clientsecret: 'test_client_secret',
      },
    };

    const skFile = path.join(dir2, 'TRIAL.json');
    fs.writeFileSync(skFile, JSON.stringify(serviceKey));

    const loaded = await loadServiceKey('TRIAL', [dir1, dir2]);
    expect(loaded).not.toBeNull();
    expect(loaded?.url).toBe('https://test.sap.com');
  });
});

