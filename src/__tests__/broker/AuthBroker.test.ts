/**
 * Tests for AuthBroker class
 * 
 * Tests use mocked implementations of interfaces, not real store/provider classes.
 */

import { AuthBroker } from '../../AuthBroker';
import type { IServiceKeyStore, ISessionStore, IAuthorizationConfig, IConnectionConfig } from '../../stores/interfaces';
import type { ITokenProvider, TokenProviderResult } from '../../providers';
import type { IConfig } from '../../types';
import type { ILogger } from '@mcp-abap-adt/interfaces';
import { createTestLogger } from '../helpers/testLogger';

// No-op logger for tests that expect errors (to avoid misleading error output)
const noOpLogger: ILogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

describe('AuthBroker', () => {
  let mockServiceKeyStore: jest.Mocked<IServiceKeyStore>;
  let mockSessionStore: jest.Mocked<ISessionStore>;
  let mockTokenProvider: jest.Mocked<ITokenProvider>;
  let broker: AuthBroker;
  let logger: ReturnType<typeof createTestLogger>;

  beforeEach(() => {
    // Create test logger (only enabled if DEBUG_AUTH_BROKER is set)
    logger = createTestLogger('AUTH-BROKER');

    // Create mocks for interfaces
    mockServiceKeyStore = {
      getServiceKey: jest.fn(),
      getAuthorizationConfig: jest.fn(),
      getConnectionConfig: jest.fn(),
    } as any;

    mockSessionStore = {
      deleteSession: jest.fn(),
      getAuthorizationConfig: jest.fn(),
      getConnectionConfig: jest.fn(),
      setAuthorizationConfig: jest.fn(),
      setConnectionConfig: jest.fn(),
    } as any;

    mockTokenProvider = {
      getConnectionConfig: jest.fn(),
      validateToken: jest.fn(),
    } as any;

    // Use logger (enabled only if DEBUG_AUTH_BROKER is set)
    // Tests that expect errors should use noOpLogger explicitly
    broker = new AuthBroker({
      serviceKeyStore: mockServiceKeyStore,
      sessionStore: mockSessionStore,
      tokenProvider: mockTokenProvider,
    }, undefined, logger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create broker with mocked stores and provider', () => {
      expect(broker).toBeInstanceOf(AuthBroker);
    });

    it('should throw error if serviceKeyStore is missing getServiceKey method', () => {
      const invalidServiceKeyStore = {
        getAuthorizationConfig: jest.fn(),
        getConnectionConfig: jest.fn(),
        // Missing getServiceKey
      } as any;

      expect(() => {
        new AuthBroker({
          serviceKeyStore: invalidServiceKeyStore,
          sessionStore: mockSessionStore,
          tokenProvider: mockTokenProvider,
        });
      }).toThrow('serviceKeyStore.getServiceKey must be a function');
    });

    it('should throw error if sessionStore is missing setConnectionConfig method', () => {
      const invalidSessionStore = {
        getAuthorizationConfig: jest.fn(),
        getConnectionConfig: jest.fn(),
        setAuthorizationConfig: jest.fn(),
        // Missing setConnectionConfig
      } as any;

      expect(() => {
        new AuthBroker({
          serviceKeyStore: mockServiceKeyStore,
          sessionStore: invalidSessionStore,
          tokenProvider: mockTokenProvider,
        });
      }).toThrow('sessionStore.setConnectionConfig must be a function');
    });

    it('should throw error if tokenProvider is missing getConnectionConfig method', () => {
      const invalidTokenProvider = {
        validateToken: jest.fn(),
        // Missing getConnectionConfig
      } as any;

      expect(() => {
        new AuthBroker({
          serviceKeyStore: mockServiceKeyStore,
          sessionStore: mockSessionStore,
          tokenProvider: invalidTokenProvider,
        });
      }).toThrow('tokenProvider.getConnectionConfig must be a function');
    });
  });

  describe('getToken', () => {

    it('should return token from session store if valid', async () => {
      const sessionToken = 'session-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: sessionToken,
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(true);

      const token = await broker.getToken('TEST');

      expect(token).toBe(sessionToken);
      expect(mockSessionStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
      expect(mockTokenProvider.validateToken).toHaveBeenCalledWith(sessionToken, connConfig.serviceUrl);
    });

    it('should return token from session store without validation if no serviceUrl', async () => {
      const sessionToken = 'session-token-123';
      const connConfig: IConnectionConfig = {
        authorizationToken: sessionToken,
        // No serviceUrl
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);

      const token = await broker.getToken('TEST');

      expect(token).toBe(sessionToken);
      expect(mockTokenProvider.validateToken).not.toHaveBeenCalled();
    });

    it('should get new token from provider if session token is invalid', async () => {
      const invalidToken = 'invalid-token';
      const newToken = 'new-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: invalidToken,
      };
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockServiceKeyStore.getServiceKey.mockResolvedValue({} as IConfig);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(false);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.validateToken).toHaveBeenCalledWith(invalidToken, connConfig.serviceUrl);
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: authConfig.uaaUrl,
          uaaClientId: authConfig.uaaClientId,
          uaaClientSecret: authConfig.uaaClientSecret,
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should get new token from provider if no session token', async () => {
      const newToken = 'new-token-123';
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
        refreshToken: 'refresh-token-123',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(null);
      mockServiceKeyStore.getServiceKey.mockResolvedValue({} as IConfig);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalled();
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalledWith('TEST', tokenResult.connectionConfig);
      expect(mockSessionStore.setAuthorizationConfig).toHaveBeenCalledWith('TEST', expect.objectContaining({ refreshToken: 'refresh-token-123' }));
    });

    it('should throw error if no service key and no session', async () => {
      mockSessionStore.getConnectionConfig.mockResolvedValue(null);
      mockServiceKeyStore.getServiceKey.mockResolvedValue(null);

      // Use no-op logger to avoid misleading error output in tests that expect errors
      const errorBroker = new AuthBroker({
        serviceKeyStore: mockServiceKeyStore,
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(errorBroker.getToken('TEST')).rejects.toThrow('No authentication found');
    });
  });

  describe('refreshToken', () => {
    it('should get new token from provider and save to session', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: 'new-token-123',
        },
        refreshToken: 'new-refresh-token-123',
      };

      mockServiceKeyStore.getServiceKey.mockResolvedValue({} as IConfig);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.refreshToken('TEST');

      expect(token).toBe('new-token-123');
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: authConfig.uaaUrl,
          uaaClientId: authConfig.uaaClientId,
          uaaClientSecret: authConfig.uaaClientSecret,
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalledWith('TEST', tokenResult.connectionConfig);
      expect(mockSessionStore.setAuthorizationConfig).toHaveBeenCalledWith('TEST', expect.objectContaining({ refreshToken: 'new-refresh-token-123' }));
    });

    it('should use refresh token from session if available', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };
      const sessionAuthConfig: IAuthorizationConfig = {
        ...authConfig,
        refreshToken: 'existing-refresh-token',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          authorizationToken: 'new-token-123',
        },
        refreshToken: 'new-refresh-token-123',
      };

      mockServiceKeyStore.getServiceKey.mockResolvedValue({} as IConfig);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(sessionAuthConfig);
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.refreshToken('TEST');

      expect(token).toBe('new-token-123');
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'existing-refresh-token',
        }),
        expect.any(Object)
      );
    });

    it('should throw error if service key not found', async () => {
      mockServiceKeyStore.getServiceKey.mockResolvedValue(null);

      // Use no-op logger to avoid misleading error output in tests that expect errors
      const errorBroker = new AuthBroker({
        serviceKeyStore: mockServiceKeyStore,
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(errorBroker.refreshToken('TEST')).rejects.toThrow('Service key not found');
    });

    it('should throw error if service key has no UAA credentials', async () => {
      mockServiceKeyStore.getServiceKey.mockResolvedValue({} as IConfig);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(null);

      // Use no-op logger to avoid misleading error output in tests that expect errors
      const errorBroker = new AuthBroker({
        serviceKeyStore: mockServiceKeyStore,
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(errorBroker.refreshToken('TEST')).rejects.toThrow('does not contain UAA credentials');
    });
  });

  describe('getAuthorizationConfig', () => {
    it('should return config from session store if available', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);

      const result = await broker.getAuthorizationConfig('TEST');

      expect(result).toEqual(authConfig);
      expect(mockSessionStore.getAuthorizationConfig).toHaveBeenCalledWith('TEST');
      expect(mockServiceKeyStore.getAuthorizationConfig).not.toHaveBeenCalled();
    });

    it('should fall back to service key store if session store returns null', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockServiceKeyStore.getAuthorizationConfig.mockResolvedValue(authConfig);

      const result = await broker.getAuthorizationConfig('TEST');

      expect(result).toEqual(authConfig);
      expect(mockServiceKeyStore.getAuthorizationConfig).toHaveBeenCalledWith('TEST');
    });
  });

  describe('getConnectionConfig', () => {
    it('should return config from session store if available', async () => {
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: 'token-123',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);

      const result = await broker.getConnectionConfig('TEST');

      expect(result).toEqual(connConfig);
      expect(mockSessionStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
      expect(mockServiceKeyStore.getConnectionConfig).not.toHaveBeenCalled();
    });

    it('should fall back to service key store if session store returns null', async () => {
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '',
        sapClient: '1234567890',
        language: 'en',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(null);
      mockServiceKeyStore.getConnectionConfig.mockResolvedValue(connConfig);

      const result = await broker.getConnectionConfig('TEST');

      expect(result).toEqual(connConfig);
      expect(mockServiceKeyStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
    });
  });

});
