/**
 * Tests for SafeBtpSessionStore
 */

import { SafeBtpSessionStore } from '../../../stores/btp/SafeBtpSessionStore';

describe('SafeBtpSessionStore', () => {
  let store: SafeBtpSessionStore;

  beforeEach(() => {
    store = new SafeBtpSessionStore();
  });

  describe('loadSession', () => {
    it('should return null for non-existent destination', async () => {
      const result = await store.loadSession('nonexistent');
      expect(result).toBeNull();
    });

    it('should return saved session', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        refreshToken: 'test-refresh-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);
      const loaded = await store.loadSession('btp');

      expect(loaded).not.toBeNull();
      if (loaded && 'serviceUrl' in loaded) {
        expect(loaded.serviceUrl).toBe('https://abap.example.com');
        expect(loaded.authorizationToken).toBe('test-token-123');
        expect(loaded.refreshToken).toBe('test-refresh-123');
        expect(loaded.uaaUrl).toBe('https://uaa.example.com');
        expect(loaded.uaaClientId).toBe('test-client-id');
        expect(loaded.uaaClientSecret).toBe('test-client-secret');
      }
    });

    it('should return null after session is deleted', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);
      await store.deleteSession('btp');
      expect(await store.loadSession('btp')).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save session configuration', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);
      const loaded = await store.loadSession('btp');

      expect(loaded).not.toBeNull();
      if (loaded && 'serviceUrl' in loaded) {
        expect(loaded.serviceUrl).toBe('https://abap.example.com');
        expect(loaded.authorizationToken).toBe('test-token-123');
      }
    });

    it('should overwrite existing session', async () => {
      const config1 = {
        serviceUrl: 'https://abap1.example.com',
        jwtToken: 'token-1',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      const config2 = {
        serviceUrl: 'https://abap2.example.com',
        jwtToken: 'token-2',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config1);
      await store.saveSession('btp', config2);

      const loaded = await store.loadSession('btp');
      expect(loaded).not.toBeNull();
      if (loaded && 'serviceUrl' in loaded) {
        expect(loaded.serviceUrl).toBe('https://abap2.example.com');
        expect(loaded.authorizationToken).toBe('token-2');
      }
    });

    it('should save multiple destinations independently', async () => {
      const config1 = {
        serviceUrl: 'https://abap1.example.com',
        jwtToken: 'token-1',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      const config2 = {
        serviceUrl: 'https://abap2.example.com',
        jwtToken: 'token-2',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp1', config1);
      await store.saveSession('btp2', config2);

      const loaded1 = await store.loadSession('btp1');
      const loaded2 = await store.loadSession('btp2');

      expect(loaded1).not.toBeNull();
      expect(loaded2).not.toBeNull();
      if (loaded1 && 'serviceUrl' in loaded1) {
        expect(loaded1.serviceUrl).toBe('https://abap1.example.com');
      }
      if (loaded2 && 'serviceUrl' in loaded2) {
        expect(loaded2.serviceUrl).toBe('https://abap2.example.com');
      }
    });

    it('should throw error if trying to save ABAP session', async () => {
      const config = {
        sapUrl: 'https://sap.example.com',
        jwtToken: 'test-token-123',
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('SafeBtpSessionStore can only store BTP sessions');
    });

    it('should throw error if trying to save XSUAA session', async () => {
      const config = {
        mcpUrl: 'https://mcp.example.com',
        jwtToken: 'test-token-123',
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('SafeBtpSessionStore can only store BTP sessions');
    });

    it('should throw error if required fields are missing', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        // Missing uaaUrl, uaaClientId, uaaClientSecret
      };

      await expect(store.saveSession('btp', config as any)).rejects.toThrow('BTP session config missing required fields');
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
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

    it('should only delete specified destination', async () => {
      const config1 = {
        serviceUrl: 'https://abap1.example.com',
        jwtToken: 'token-1',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      const config2 = {
        serviceUrl: 'https://abap2.example.com',
        jwtToken: 'token-2',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp1', config1);
      await store.saveSession('btp2', config2);

      await store.deleteSession('btp1');

      expect(await store.loadSession('btp1')).toBeNull();
      expect(await store.loadSession('btp2')).not.toBeNull();
    });
  });

  describe('in-memory behavior', () => {
    it('should not persist data between instances', () => {
      const store1 = new SafeBtpSessionStore();
      const store2 = new SafeBtpSessionStore();

      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      store1.saveSession('btp', config);
      expect(store2.loadSession('btp')).resolves.toBeNull();
    });

    it('should maintain data within same instance', async () => {
      const config = {
        serviceUrl: 'https://abap.example.com',
        jwtToken: 'test-token-123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp', config);
      const loaded = await store.loadSession('btp');
      expect(loaded).not.toBeNull();
    });
  });

  describe('clearAll', () => {
    it('should clear all sessions', async () => {
      const config1 = {
        serviceUrl: 'https://abap1.example.com',
        jwtToken: 'token-1',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      const config2 = {
        serviceUrl: 'https://abap2.example.com',
        jwtToken: 'token-2',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'test-client-id',
        uaaClientSecret: 'test-client-secret',
      };

      await store.saveSession('btp1', config1);
      await store.saveSession('btp2', config2);

      store.clearAll();

      expect(await store.loadSession('btp1')).toBeNull();
      expect(await store.loadSession('btp2')).toBeNull();
    });
  });
});

