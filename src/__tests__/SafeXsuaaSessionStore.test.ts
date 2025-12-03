/**
 * Tests for SafeXsuaaSessionStore class
 */

import { SafeXsuaaSessionStore } from '../stores/SafeXsuaaSessionStore';
import { BtpSessionConfig } from '../types';

describe('SafeXsuaaSessionStore', () => {
  let store: SafeXsuaaSessionStore;

  beforeEach(() => {
    store = new SafeXsuaaSessionStore();
  });

  describe('loadSession', () => {
    it('should return null for non-existent destination', async () => {
      const result = await store.loadSession('NON_EXISTENT');
      expect(result).toBeNull();
    });

    it('should return saved session', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
        refreshToken: 'refresh123',
      };

      await store.saveSession('mcp', config);
      const result = await store.loadSession('mcp');

      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.mcpUrl).toBe('https://mcp.test.com');
        expect(result.jwtToken).toBe('token123');
        expect(result.refreshToken).toBe('refresh123');
      }
    });

    it('should return null after session is deleted', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      await store.saveSession('mcp', config);
      await store.deleteSession('mcp');
      const result = await store.loadSession('mcp');

      expect(result).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save session configuration', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      await store.saveSession('mcp', config);
      const result = await store.loadSession('mcp');

      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.mcpUrl).toBe('https://mcp.test.com');
        expect(result.jwtToken).toBe('token123');
      }
    });

    it('should overwrite existing session', async () => {
      const config1: BtpSessionConfig = {
        mcpUrl: 'https://mcp1.test.com',
        jwtToken: 'token1',
      };

      const config2: BtpSessionConfig = {
        mcpUrl: 'https://mcp2.test.com',
        jwtToken: 'token2',
      };

      await store.saveSession('mcp', config1);
      await store.saveSession('mcp', config2);

      const result = await store.loadSession('mcp');
      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.mcpUrl).toBe('https://mcp2.test.com');
        expect(result.jwtToken).toBe('token2');
      }
    });

    it('should save multiple destinations independently', async () => {
      const config1: BtpSessionConfig = {
        mcpUrl: 'https://mcp1.test.com',
        jwtToken: 'token1',
      };

      const config2: BtpSessionConfig = {
        mcpUrl: 'https://mcp2.test.com',
        jwtToken: 'token2',
      };

      await store.saveSession('mcp1', config1);
      await store.saveSession('mcp2', config2);

      const result1 = await store.loadSession('mcp1');
      const result2 = await store.loadSession('mcp2');

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      if (result1 && 'mcpUrl' in result1) {
        expect(result1.mcpUrl).toBe('https://mcp1.test.com');
      }
      if (result2 && 'mcpUrl' in result2) {
        expect(result2.mcpUrl).toBe('https://mcp2.test.com');
      }
    });

    it('should throw error if trying to save ABAP session', async () => {
      const config = {
        sapUrl: 'https://sap.test.com',
        jwtToken: 'token123',
      };

      await expect(store.saveSession('mcp', config as any)).rejects.toThrow('SafeXsuaaSessionStore can only store BtpSessionConfig');
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

    it('should only delete specified destination', async () => {
      const config1: BtpSessionConfig = {
        mcpUrl: 'https://mcp1.test.com',
        jwtToken: 'token1',
      };

      const config2: BtpSessionConfig = {
        mcpUrl: 'https://mcp2.test.com',
        jwtToken: 'token2',
      };

      await store.saveSession('mcp1', config1);
      await store.saveSession('mcp2', config2);
      await store.deleteSession('mcp1');

      const result1 = await store.loadSession('mcp1');
      const result2 = await store.loadSession('mcp2');

      expect(result1).toBeNull();
      expect(result2).not.toBeNull();
    });
  });

  describe('in-memory behavior', () => {
    it('should not persist data between instances', () => {
      const store1 = new SafeXsuaaSessionStore();
      const store2 = new SafeXsuaaSessionStore();

      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      store1.saveSession('mcp', config);

      // store2 should not see data from store1
      store2.loadSession('mcp').then(result => {
        expect(result).toBeNull();
      });
    });

    it('should maintain data within same instance', async () => {
      const config: BtpSessionConfig = {
        mcpUrl: 'https://mcp.test.com',
        jwtToken: 'token123',
      };

      await store.saveSession('mcp', config);
      const result = await store.loadSession('mcp');

      expect(result).not.toBeNull();
      if (result && 'mcpUrl' in result) {
        expect(result.mcpUrl).toBe('https://mcp.test.com');
      }
    });
  });

  describe('clearAll', () => {
    it('should clear all sessions', async () => {
      const config1: BtpSessionConfig = {
        mcpUrl: 'https://mcp1.test.com',
        jwtToken: 'token1',
      };

      const config2: BtpSessionConfig = {
        mcpUrl: 'https://mcp2.test.com',
        jwtToken: 'token2',
      };

      await store.saveSession('mcp1', config1);
      await store.saveSession('mcp2', config2);

      store.clearAll();

      const result1 = await store.loadSession('mcp1');
      const result2 = await store.loadSession('mcp2');

      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });
});

