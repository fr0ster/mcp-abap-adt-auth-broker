/**
 * Tests for SafeAbapSessionStore class
 */

import { SafeAbapSessionStore } from '../stores/SafeAbapSessionStore';
import { EnvConfig } from '../types';

describe('SafeAbapSessionStore', () => {
  let store: SafeAbapSessionStore;

  beforeEach(() => {
    store = new SafeAbapSessionStore();
  });

  describe('loadSession', () => {
    it('should return null for non-existent destination', async () => {
      const result = await store.loadSession('NON_EXISTENT');
      expect(result).toBeNull();
    });

    it('should return saved session', async () => {
      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
        refreshToken: 'refresh123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };

      await store.saveSession('TRIAL', config);
      const result = await store.loadSession('TRIAL');

      expect(result).toEqual(config);
    });

    it('should return null after session is deleted', async () => {
      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
      };

      await store.saveSession('TRIAL', config);
      await store.deleteSession('TRIAL');
      const result = await store.loadSession('TRIAL');

      expect(result).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save session configuration', async () => {
      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
        refreshToken: 'refresh123',
        uaaUrl: 'https://uaa.example.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        sapClient: '100',
        language: 'EN',
      };

      await store.saveSession('TRIAL', config);
      const result = await store.loadSession('TRIAL');

      expect(result).toEqual(config);
    });

    it('should overwrite existing session', async () => {
      const config1: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token1',
      };

      const config2: EnvConfig = {
        sapUrl: 'https://example2.com',
        jwtToken: 'token2',
      };

      await store.saveSession('TRIAL', config1);
      await store.saveSession('TRIAL', config2);
      const result = await store.loadSession('TRIAL');

      expect(result).toEqual(config2);
    });

    it('should save multiple destinations independently', async () => {
      const config1: EnvConfig = {
        sapUrl: 'https://example1.com',
        jwtToken: 'token1',
      };

      const config2: EnvConfig = {
        sapUrl: 'https://example2.com',
        jwtToken: 'token2',
      };

      await store.saveSession('DEST1', config1);
      await store.saveSession('DEST2', config2);

      const result1 = await store.loadSession('DEST1');
      const result2 = await store.loadSession('DEST2');

      expect(result1).toEqual(config1);
      expect(result2).toEqual(config2);
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
      };

      await store.saveSession('TRIAL', config);
      await store.deleteSession('TRIAL');
      const result = await store.loadSession('TRIAL');

      expect(result).toBeNull();
    });

    it('should not throw error when deleting non-existent session', async () => {
      await expect(store.deleteSession('NON_EXISTENT')).resolves.not.toThrow();
    });

    it('should only delete specified destination', async () => {
      const config1: EnvConfig = {
        sapUrl: 'https://example1.com',
        jwtToken: 'token1',
      };

      const config2: EnvConfig = {
        sapUrl: 'https://example2.com',
        jwtToken: 'token2',
      };

      await store.saveSession('DEST1', config1);
      await store.saveSession('DEST2', config2);
      await store.deleteSession('DEST1');

      const result1 = await store.loadSession('DEST1');
      const result2 = await store.loadSession('DEST2');

      expect(result1).toBeNull();
      expect(result2).toEqual(config2);
    });
  });

  describe('in-memory behavior', () => {
    it('should not persist data between instances', () => {
      const store1 = new SafeAbapSessionStore();
      const store2 = new SafeAbapSessionStore();

      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
      };

      // Save in store1
      store1.saveSession('TRIAL', config);

      // Store2 should not have the data
      store2.loadSession('TRIAL').then(result => {
        expect(result).toBeNull();
      });

      // Store1 should have the data
      store1.loadSession('TRIAL').then(result => {
        expect(result).toEqual(config);
      });
    });

    it('should maintain data within same instance', async () => {
      const config: EnvConfig = {
        sapUrl: 'https://example.com',
        jwtToken: 'token123',
      };

      await store.saveSession('TRIAL', config);
      
      // Multiple loads should return same data
      const result1 = await store.loadSession('TRIAL');
      const result2 = await store.loadSession('TRIAL');
      const result3 = await store.loadSession('TRIAL');

      expect(result1).toEqual(config);
      expect(result2).toEqual(config);
      expect(result3).toEqual(config);
    });
  });
});

