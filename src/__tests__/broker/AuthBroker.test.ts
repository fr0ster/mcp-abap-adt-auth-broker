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
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

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
    // Reset axios mock
    mockedAxios.mockReset();
  });

  describe('constructor', () => {
    it('should create broker with mocked stores and provider', () => {
      expect(broker).toBeInstanceOf(AuthBroker);
    });

    it('should create broker without serviceKeyStore', () => {
      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      });
      expect(brokerWithoutServiceKey).toBeInstanceOf(AuthBroker);
    });

    it('should throw error if serviceKeyStore is provided but missing getServiceKey method', () => {
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

    it('should throw error if sessionStore is missing', () => {
      expect(() => {
        new AuthBroker({
          tokenProvider: mockTokenProvider,
          // Missing sessionStore
        } as any);
      }).toThrow('sessionStore is required');
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

    it('should create broker without tokenProvider', () => {
      const brokerWithoutProvider = new AuthBroker({
        sessionStore: mockSessionStore,
      });
      expect(brokerWithoutProvider).toBeInstanceOf(AuthBroker);
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
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(true);

      const token = await broker.getToken('TEST');

      expect(token).toBe(sessionToken);
      expect(mockSessionStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
      expect(mockSessionStore.getAuthorizationConfig).toHaveBeenCalledWith('TEST');
      expect(mockTokenProvider.validateToken).toHaveBeenCalledWith(sessionToken, connConfig.serviceUrl);
    });

    it('should throw error if session missing serviceUrl', async () => {
      const connConfig: IConnectionConfig = {
        authorizationToken: 'token-123',
        // No serviceUrl
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);

      const errorBroker = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(errorBroker.getToken('TEST')).rejects.toThrow('missing required field \'serviceUrl\'');
    });

    it('should get new token via Step 1 (refresh) if session token is invalid', async () => {
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
        refreshToken: 'refresh-token-123',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
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
          refreshToken: 'refresh-token-123',
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should initialize token via Step 0 if no token and no UAA in session but serviceKeyStore available', async () => {
      const newToken = 'new-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // Empty token
      };
      const serviceKeyAuthConfig: IAuthorizationConfig = {
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

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockServiceKeyStore.getAuthorizationConfig!.mockResolvedValue(serviceKeyAuthConfig);
      mockServiceKeyStore.getConnectionConfig!.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockServiceKeyStore.getAuthorizationConfig).toHaveBeenCalledWith('TEST');
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: serviceKeyAuthConfig.uaaUrl,
          uaaClientId: serviceKeyAuthConfig.uaaClientId,
          uaaClientSecret: serviceKeyAuthConfig.uaaClientSecret,
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
      expect(mockSessionStore.setAuthorizationConfig).toHaveBeenCalledWith('TEST', expect.objectContaining({ refreshToken: 'refresh-token-123' }));
    });

    it('should throw error if no token, no UAA, and no serviceKeyStore', async () => {
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // Empty token
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(brokerWithoutServiceKey.getToken('TEST')).rejects.toThrow('serviceKeyStore is not available');
    });

    it('should get token via Step 2 (direct UAA) if no refresh token but UAA credentials in session and no provider', async () => {
      const newToken = 'new-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // Empty token
      };
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        // No refreshToken
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      
      // Mock axios for direct UAA request
      mockedAxios.mockResolvedValue({
        data: {
          access_token: newToken,
          refresh_token: 'refresh-token-123',
          expires_in: 3600,
        },
      } as any);

      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const brokerWithoutProvider = new AuthBroker({
        sessionStore: mockSessionStore,
      }, undefined, logger);

      const token = await brokerWithoutProvider.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          url: 'https://uaa.test.com/oauth/token',
        })
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should get token via Step 2 (UAA) if no refresh token but UAA credentials in session', async () => {
      const newToken = 'new-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // Empty token
      };
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        // No refreshToken
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
        refreshToken: 'refresh-token-123',
      };

      // Mock axios to fail so it falls back to provider
      mockedAxios.mockRejectedValue(new Error('Direct UAA failed'));

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: authConfig.uaaUrl,
          uaaClientId: authConfig.uaaClientId,
          uaaClientSecret: authConfig.uaaClientSecret,
          refreshToken: undefined,
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
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

      // Mock axios to fail so it falls back to provider
      mockedAxios.mockRejectedValue(new Error('Direct UAA failed'));

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

    it('should use direct UAA refresh if UAA credentials in session and no provider', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        refreshToken: 'refresh-token-123',
      };
      const newToken = 'new-token-123';

      // Mock axios for direct UAA refresh
      mockedAxios.mockResolvedValue({
        data: {
          access_token: newToken,
          refresh_token: 'new-refresh-token-123',
          expires_in: 3600,
        },
      } as any);

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const brokerWithoutProvider = new AuthBroker({
        sessionStore: mockSessionStore,
      }, undefined, logger);

      const token = await brokerWithoutProvider.refreshToken('TEST');

      expect(token).toBe(newToken);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          url: 'https://uaa.test.com/oauth/token',
        })
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should use UAA credentials from session if serviceKeyStore not available', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        refreshToken: 'refresh-token-123',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: 'new-token-123',
        },
        refreshToken: 'new-refresh-token-123',
      };

      // Mock axios to fail so it falls back to provider
      mockedAxios.mockRejectedValue(new Error('Direct UAA failed'));

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, logger);

      const token = await brokerWithoutServiceKey.refreshToken('TEST');

      expect(token).toBe('new-token-123');
      expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'refresh-token-123',
        }),
        expect.any(Object)
      );
    });

    it('should throw error if no authorization config found', async () => {
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(brokerWithoutServiceKey.refreshToken('TEST')).rejects.toThrow('Authorization config not found');
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

    it('should fall back to service key store if session store returns null and serviceKeyStore available', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
      };

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockServiceKeyStore.getAuthorizationConfig!.mockResolvedValue(authConfig);

      const result = await broker.getAuthorizationConfig('TEST');

      expect(result).toEqual(authConfig);
      expect(mockServiceKeyStore.getAuthorizationConfig).toHaveBeenCalledWith('TEST');
    });

    it('should return null if session store returns null and serviceKeyStore not available', async () => {
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      });

      const result = await brokerWithoutServiceKey.getAuthorizationConfig('TEST');

      expect(result).toBeNull();
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

    it('should fall back to service key store if session store returns null and serviceKeyStore available', async () => {
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '',
        sapClient: '1234567890',
        language: 'en',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(null);
      mockServiceKeyStore.getConnectionConfig!.mockResolvedValue(connConfig);

      const result = await broker.getConnectionConfig('TEST');

      expect(result).toEqual(connConfig);
      expect(mockServiceKeyStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
    });

    it('should return null if session store returns null and serviceKeyStore not available', async () => {
      mockSessionStore.getConnectionConfig.mockResolvedValue(null);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      });

      const result = await brokerWithoutServiceKey.getConnectionConfig('TEST');

      expect(result).toBeNull();
    });
  });

});
