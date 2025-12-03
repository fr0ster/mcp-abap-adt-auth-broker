/**
 * Tests for BtpSessionStore
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BtpSessionStore } from '../../../stores/btp/BtpSessionStore';

describe('BtpSessionStore', () => {
  let tempDir: string;
  let store: BtpSessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-session-store-test-'));
    store = new BtpSessionStore([tempDir]);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('loadSession', () => {
    it('should return null for non-existent destination', async () => {
      const result = await store.loadSession('nonexistent');
      expect(result).toBeNull();
    });

    it('should load valid BTP session file', async () => {
      const config = {
        abapUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        refreshToken: 'test-refresh-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);

      const loaded = await store.loadSession('btp');
      expect(loaded).not.toBeNull();
      if (loaded && 'abapUrl' in loaded) {
        expect(loaded.abapUrl).toBe('https://abap.example.com');
        expect(loaded.authorizationToken).toBe('test-token-123');
        expect(loaded.refreshToken).toBe('test-refresh-123');
        expect(loaded.uaaUrl).toBe('https://uaa.example.com');
        expect(loaded.uaaClientId).toBe('test-client-id');
        expect(loaded.uaaClientSecret).toBe('test-client-secret');
      }
    });

    it('should return null if required fields are missing', async () => {
      // Create invalid .env file
      const envPath = path.join(tempDir, 'btp.env');
      fs.writeFileSync(envPath, 'BTP_JWT_TOKEN=test-token\n');

      const result = await store.loadSession('btp');
      expect(result).toBeNull();
    });

    it('should return null for invalid .env format', async () => {
      // Create invalid .env file
      const envPath = path.join(tempDir, 'btp.env');
      fs.writeFileSync(envPath, 'invalid content\n');

      const result = await store.loadSession('btp');
      expect(result).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save BTP session configuration', async () => {
      const config = {
        abapUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        refreshToken: 'test-refresh-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);

      const envPath = path.join(tempDir, 'btp.env');
      expect(fs.existsSync(envPath)).toBe(true);

      const content = fs.readFileSync(envPath, 'utf8');
      expect(content).toContain('BTP_ABAP_URL=https://abap.example.com');
      expect(content).toContain('BTP_JWT_TOKEN=test-token-123');
      expect(content).toContain('BTP_REFRESH_TOKEN=test-refresh-123');
      expect(content).toContain('BTP_UAA_URL=https://uaa.example.com');
      expect(content).toContain('BTP_UAA_CLIENT_ID=test-client-id');
      expect(content).toContain('BTP_UAA_CLIENT_SECRET=test-client-secret');
    });

    it('should throw error if trying to save ABAP session', async () => {
      const config = {
        sapUrl: 'https://sap.example.com',
        jwtToken: 'test-token-123',
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('BtpSessionStore can only store BtpSessionConfig');
    });

    it('should throw error if trying to save XSUAA session', async () => {
      const config = {
        mcpUrl: 'https://mcp.example.com',
        jwtToken: 'test-token-123',
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('BtpSessionStore can only store BtpSessionConfig');
    });

    it('should throw error if required fields are missing', async () => {
      const config = {
        abapUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        // Missing uaaUrl, uaaClientId, uaaClientSecret
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('BTP session config missing required fields');
    });

    it('should work without refreshToken (refreshToken is optional)', async () => {
      const config = {
        abapUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);

      const loaded = await store.loadSession('btp');
      expect(loaded).not.toBeNull();
      if (loaded && 'abapUrl' in loaded) {
        expect(loaded.abapUrl).toBe('https://abap.example.com');
        expect(loaded.authorizationToken).toBe('test-token-123');
        expect(loaded.refreshToken).toBeUndefined();
      }
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      const config = {
        abapUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);
      expect(await store.loadSession('btp')).not.toBeNull();

      await store.deleteSession('btp');
      expect(await store.loadSession('btp')).toBeNull();
    });

    it('should not throw error when deleting non-existent session', async () => {
      await expect(store.deleteSession('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('getSearchPaths', () => {
    it('should return search paths', () => {
      const paths = store.getSearchPaths();
      expect(paths).toContain(tempDir);
    });
  });
});

