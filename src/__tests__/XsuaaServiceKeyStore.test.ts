/**
 * Tests for XsuaaServiceKeyStore class
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { XsuaaServiceKeyStore } from '../stores/XsuaaServiceKeyStore';

describe('XsuaaServiceKeyStore', () => {
  let tempDir: string;
  let store: XsuaaServiceKeyStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsuaa-sk-test-'));
    store = new XsuaaServiceKeyStore([tempDir]);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('getServiceKey', () => {
    it('should load valid XSUAA service key file', async () => {
      const serviceKey = {
        url: 'https://example.authentication.eu10.hana.ondemand.com',
        clientid: 'sb-example-12345!t123',
        clientsecret: 'example-secret-key-12345$example-hash=',
      };

      const skFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      const loaded = await store.getServiceKey('mcp');

      expect(loaded).not.toBeNull();
      expect(loaded?.uaa.url).toBe('https://example.authentication.eu10.hana.ondemand.com');
      expect(loaded?.uaa.clientid).toBe('sb-example-12345!t123');
      expect(loaded?.uaa.clientsecret).toBe('example-secret-key-12345$example-hash=');
    });

    it('should return null if file not found', async () => {
      const loaded = await store.getServiceKey('NONEXISTENT');
      expect(loaded).toBeNull();
    });

    it('should throw error if service key is ABAP format', async () => {
      const serviceKey = {
        uaa: {
          url: 'https://uaa.test.com',
          clientid: 'client123',
          clientsecret: 'secret123',
        },
      };

      const skFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      await expect(store.getServiceKey('mcp')).rejects.toThrow('Service key does not match XSUAA format');
    });

    it('should throw error for invalid JSON', async () => {
      const skFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(skFile, 'invalid json {');

      await expect(store.getServiceKey('mcp')).rejects.toThrow('Invalid JSON');
    });

    it('should search in multiple paths', async () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      const serviceKey = {
        url: 'https://uaa.test.com',
        clientid: 'client123',
        clientsecret: 'secret123',
      };

      const skFile = path.join(dir2, 'mcp.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      const store2 = new XsuaaServiceKeyStore([dir1, dir2]);
      const loaded = await store2.getServiceKey('mcp');

      expect(loaded).not.toBeNull();
      expect(loaded?.uaa.url).toBe('https://uaa.test.com');
    });

    it('should preserve abap.url if present', async () => {
      const serviceKey = {
        url: 'https://uaa.test.com',
        clientid: 'client123',
        clientsecret: 'secret123',
        abap: {
          url: 'https://abap.test.com',
        },
      };

      const skFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      const loaded = await store.getServiceKey('mcp');

      expect(loaded).not.toBeNull();
      expect(loaded?.abap?.url).toBe('https://abap.test.com');
    });
  });

  describe('getSearchPaths', () => {
    it('should return search paths', () => {
      const paths = store.getSearchPaths();
      expect(paths).toContain(tempDir);
    });
  });
});

