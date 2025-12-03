/**
 * Tests for XsuaaSessionStore class
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { XsuaaSessionStore } from '../stores/XsuaaSessionStore';
import { BtpSessionConfig } from '../types';

describe('XsuaaSessionStore', () => {
  let tempDir: string;
  let store: XsuaaSessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsuaa-session-test-'));
    store = new XsuaaSessionStore([tempDir]);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('loadSession', () => {
    it('should return null for non-existent destination', async () => {
      const result = await store.loadSession('NON_EXISTENT');
      expect(result).toBeNull();
    });

    it('should load valid XSUAA session file', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://example.cfapps.eu10-004.hana.ondemand.com',
        jwtToken: 'token123',
        refreshToken: 'refresh123',
      };

      await store.saveSession('mcp', config);
      const result = await store.loadSession('mcp');

      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.mcpUrl).toBe('https://example.cfapps.eu10-004.hana.ondemand.com');
        expect(result.jwtToken).toBe('token123');
        expect(result.refreshToken).toBe('refresh123');
      }
    });

    it('should load session without mcpUrl (mcpUrl is optional)', async () => {
      // Create .env file with BTP_JWT_TOKEN but no BTP_URL (mcpUrl is optional)
      const envFile = path.join(tempDir, 'mcp.env');
      fs.writeFileSync(envFile, 'BTP_JWT_TOKEN=token123\n');

      // Should load successfully with just token (mcpUrl is optional)
      const result = await store.loadSession('mcp');
      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.jwtToken).toBe('token123');
        expect(result.mcpUrl).toBeUndefined(); // mcpUrl is optional
      }
    });

    it('should return null if jwtToken is missing', async () => {
      // Create invalid .env file without BTP_JWT_TOKEN
      const envFile = path.join(tempDir, 'mcp.env');
      fs.writeFileSync(envFile, 'BTP_URL=https://mcp.test.com\n');

      // loadBtpEnvFile returns null if jwtToken is missing
      const result = await store.loadSession('mcp');
      expect(result).toBeNull();
    });

    it('should return null for invalid .env format', async () => {
      const envFile = path.join(tempDir, 'mcp.env');
      fs.writeFileSync(envFile, 'invalid env format {');

      // loadBtpEnvFile catches errors and returns null
      const result = await store.loadSession('mcp');
      expect(result).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save XSUAA session configuration', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      await store.saveSession('mcp', config);

      const envFile = path.join(tempDir, 'mcp.env');
      expect(fs.existsSync(envFile)).toBe(true);

      const fileContent = fs.readFileSync(envFile, 'utf8');
      expect(fileContent).toContain('BTP_URL=https://mcp.test.com');
      expect(fileContent).toContain('BTP_MCP_URL=https://mcp.test.com');
      expect(fileContent).toContain('BTP_JWT_TOKEN=token123');
    });

    it('should throw error if trying to save ABAP session', async () => {
      const config = {
        sapUrl: 'https://sap.test.com',
        jwtToken: 'token123',
      };

      // XsuaaSessionStore checks for 'jwtToken' in config, and 'sapUrl' means it's EnvConfig, not BtpSessionConfig
      // But the type guard checks for 'jwtToken' in config, so it will pass the first check
      // Then it will fail because it doesn't have 'mcpUrl' in config
      // Actually, the check is: !('jwtToken' in config) - so if jwtToken exists, it passes
      // But then it checks if it's BtpSessionConfig by checking for 'mcpUrl' in config
      // Since EnvConfig has 'sapUrl' not 'mcpUrl', it should fail
      // But wait, the type guard only checks for 'jwtToken' in config
      // So we need to check if it has 'sapUrl' (which means it's EnvConfig)
      await expect(store.saveSession('mcp', config as any)).rejects.toThrow('XsuaaSessionStore can only store BtpSessionConfig');
    });

    it('should work without mcpUrl (mcpUrl is optional)', async () => {
      const config: BtpSessionConfig = {
        jwtToken: 'token123',
        // mcpUrl is optional
      };

      // Should save successfully without mcpUrl
      await store.saveSession('mcp', config);

      const envFile = path.join(tempDir, 'mcp.env');
      expect(fs.existsSync(envFile)).toBe(true);

      const fileContent = fs.readFileSync(envFile, 'utf8');
      expect(fileContent).toContain('BTP_JWT_TOKEN=token123');
      // BTP_URL should not be present since mcpUrl is undefined
      expect(fileContent).not.toContain('BTP_URL=');
    });

    it('should throw error if jwtToken is missing', async () => {
      const config = {
        // jwtToken is missing
        mcpUrl: 'https://mcp.test.com',
      };

      // Type guard checks for 'jwtToken' in config first
      await expect(store.saveSession('mcp', config as any)).rejects.toThrow('XsuaaSessionStore can only store BtpSessionConfig');
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      await store.saveSession('mcp', config);
      await store.deleteSession('mcp');

      const result = await store.loadSession('mcp');
      expect(result).toBeNull();
    });

    it('should not throw error when deleting non-existent session', async () => {
      await expect(store.deleteSession('NON_EXISTENT')).resolves.not.toThrow();
    });
  });

  describe('getSearchPaths', () => {
    it('should return search paths', () => {
      const paths = store.getSearchPaths();
      expect(paths).toContain(tempDir);
    });
  });
});

