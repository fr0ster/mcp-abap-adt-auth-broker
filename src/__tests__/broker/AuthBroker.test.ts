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
      refreshTokenFromSession: jest.fn(),
      refreshTokenFromServiceKey: jest.fn(),
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

    it('should throw error if tokenProvider is missing', () => {
      expect(() => {
        new AuthBroker({
          sessionStore: mockSessionStore,
        } as any);
      }).toThrow('tokenProvider is required');
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

    describe('allowBrowserAuth option', () => {
      it('should throw BROWSER_AUTH_REQUIRED in Step 0 when allowBrowserAuth=false and no token/UAA in session', async () => {
        const connConfig: IConnectionConfig = {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: '', // Empty token
        };
        const serviceKeyAuthConfig: IAuthorizationConfig = {
          uaaUrl: 'https://uaa.test.com',
          uaaClientId: 'client123',
          uaaClientSecret: 'secret123',
        };

        mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
        mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
        mockServiceKeyStore.getAuthorizationConfig!.mockResolvedValue(serviceKeyAuthConfig);
        mockServiceKeyStore.getConnectionConfig!.mockResolvedValue({ serviceUrl: 'https://test.sap.com' });

        const brokerNoBrowser = new AuthBroker({
          serviceKeyStore: mockServiceKeyStore,
          sessionStore: mockSessionStore,
          tokenProvider: mockTokenProvider,
          allowBrowserAuth: false,
        }, undefined, noOpLogger);

        let caughtError: any;
        try {
          await brokerNoBrowser.getToken('TEST');
        } catch (error: any) {
          caughtError = error;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.message).toContain('Browser authentication required');
        expect(caughtError.code).toBe('BROWSER_AUTH_REQUIRED');
        expect(caughtError.destination).toBe('TEST');

        // Should not call tokenProvider since browser auth is disabled
        expect(mockTokenProvider.getConnectionConfig).not.toHaveBeenCalled();
      });

      it('should throw BROWSER_AUTH_REQUIRED in Step 2b when allowBrowserAuth=false and refresh token fails', async () => {
        const connConfig: IConnectionConfig = {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: '', // Empty token - triggers Step 2
        };
        const authConfig: IAuthorizationConfig = {
          uaaUrl: 'https://uaa.test.com',
          uaaClientId: 'client123',
          uaaClientSecret: 'secret123',
          refreshToken: 'expired-refresh-token',
        };

        mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
        mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);

        // Step 2a (refreshTokenFromSession) fails
        mockTokenProvider.refreshTokenFromSession.mockRejectedValue(new Error('Refresh token expired'));

        const brokerNoBrowser = new AuthBroker({
          sessionStore: mockSessionStore,
          tokenProvider: mockTokenProvider,
          allowBrowserAuth: false,
        }, undefined, noOpLogger);

        let caughtError: any;
        try {
          await brokerNoBrowser.getToken('TEST');
        } catch (error: any) {
          caughtError = error;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError.message).toContain('Browser authentication required');
        expect(caughtError.code).toBe('BROWSER_AUTH_REQUIRED');

        // Should have tried Step 2a but not Step 2b (browser auth)
        expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
        expect(mockTokenProvider.refreshTokenFromServiceKey).not.toHaveBeenCalled();
      });

      it('should work normally when allowBrowserAuth=true (default)', async () => {
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
        mockServiceKeyStore.getConnectionConfig!.mockResolvedValue({ serviceUrl: 'https://test.sap.com' });
        mockTokenProvider.getConnectionConfig.mockResolvedValue(tokenResult);
        mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
        mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

        // Default broker (allowBrowserAuth=true)
        const token = await broker.getToken('TEST');

        expect(token).toBe(newToken);
        expect(mockTokenProvider.getConnectionConfig).toHaveBeenCalled();
      });

      it('should succeed with allowBrowserAuth=false if valid token exists in session', async () => {
        const sessionToken = 'valid-session-token';
        const connConfig: IConnectionConfig = {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: sessionToken,
        };

        mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
        mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
        mockTokenProvider.validateToken = jest.fn().mockResolvedValue(true);

        const brokerNoBrowser = new AuthBroker({
          sessionStore: mockSessionStore,
          tokenProvider: mockTokenProvider,
          allowBrowserAuth: false,
        }, undefined, logger);

        const token = await brokerNoBrowser.getToken('TEST');

        expect(token).toBe(sessionToken);
        // No browser auth calls needed
        expect(mockTokenProvider.getConnectionConfig).not.toHaveBeenCalled();
        expect(mockTokenProvider.refreshTokenFromServiceKey).not.toHaveBeenCalled();
      });

      it('should succeed with allowBrowserAuth=false if refresh token works', async () => {
        const newToken = 'refreshed-token';
        const connConfig: IConnectionConfig = {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: 'invalid-token',
        };
        const authConfig: IAuthorizationConfig = {
          uaaUrl: 'https://uaa.test.com',
          uaaClientId: 'client123',
          uaaClientSecret: 'secret123',
          refreshToken: 'valid-refresh-token',
        };

        mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
        mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
        mockTokenProvider.validateToken = jest.fn().mockResolvedValue(false);
        mockTokenProvider.refreshTokenFromSession.mockResolvedValue({
          connectionConfig: { serviceUrl: 'https://test.sap.com', authorizationToken: newToken },
          refreshToken: 'new-refresh-token',
        });
        mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
        mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

        const brokerNoBrowser = new AuthBroker({
          sessionStore: mockSessionStore,
          tokenProvider: mockTokenProvider,
          allowBrowserAuth: false,
        }, undefined, logger);

        const token = await brokerNoBrowser.getToken('TEST');

        expect(token).toBe(newToken);
        // Refresh token worked, no browser auth needed
        expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
        expect(mockTokenProvider.refreshTokenFromServiceKey).not.toHaveBeenCalled();
      });
    });

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
      mockTokenProvider.refreshTokenFromSession.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(false);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.validateToken).toHaveBeenCalledWith(invalidToken, connConfig.serviceUrl);
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalledWith(
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

    it('should get token via Step 2b (refreshTokenFromServiceKey) if no refresh token', async () => {
      const newToken = 'new-token-123';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // Empty token
      };
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        // No refreshToken - will skip Step 2a and go to Step 2b
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const broker = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, logger);

      mockTokenProvider.refreshTokenFromServiceKey.mockResolvedValue({
        connectionConfig: { serviceUrl: 'https://test.sap.com', authorizationToken: newToken },
        refreshToken: 'new-refresh-token',
      });

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.refreshTokenFromServiceKey).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: authConfig.uaaUrl,
          uaaClientId: authConfig.uaaClientId,
          uaaClientSecret: authConfig.uaaClientSecret,
        }),
        expect.any(Object)
      );
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should use Step 2b (refreshTokenFromServiceKey) when no refresh token in session', async () => {
      const newToken = 'provider-token';
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: '', // trigger Step2
      };
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        // No refreshToken - will use Step 2b (refreshTokenFromServiceKey)
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockTokenProvider.refreshTokenFromServiceKey.mockResolvedValue(tokenResult);

      const brokerNoClientCreds = new AuthBroker({
        sessionStore: mockSessionStore,
        serviceKeyStore: mockServiceKeyStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      const token = await brokerNoClientCreds.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.refreshTokenFromServiceKey).toHaveBeenCalled();
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
      mockTokenProvider.refreshTokenFromServiceKey.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.getToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.refreshTokenFromServiceKey).toHaveBeenCalledWith(
        expect.objectContaining({
          uaaUrl: authConfig.uaaUrl,
          uaaClientId: authConfig.uaaClientId,
          uaaClientSecret: authConfig.uaaClientSecret,
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
      mockServiceKeyStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockSessionStore.getConnectionConfig.mockResolvedValue(null); // Trigger Step 0
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
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalledWith('TEST', expect.objectContaining({ authorizationToken: 'new-token-123' }));
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
      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockTokenProvider.refreshTokenFromSession.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.refreshToken('TEST');

      expect(token).toBe('new-token-123');
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'existing-refresh-token',
        }),
        expect.any(Object)
      );
    });

    it('should use Step 2a (refreshTokenFromSession) when refresh token available', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        refreshToken: 'refresh-token-123',
      };
      const newToken = 'new-token-123';

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const broker = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, logger);

      mockTokenProvider.refreshTokenFromSession.mockResolvedValue({
        connectionConfig: { serviceUrl: 'https://test.sap.com', authorizationToken: newToken },
        refreshToken: 'new-refresh-token',
      });

      const token = await broker.refreshToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'refresh-token-123',
        }),
        expect.any(Object)
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
      mockTokenProvider.refreshTokenFromSession.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, logger);

      const token = await brokerWithoutServiceKey.refreshToken('TEST');

      expect(token).toBe('new-token-123');
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'refresh-token-123',
        }),
        expect.any(Object)
      );
    });

    it('should throw error if no authorization config found', async () => {
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(null);
      mockSessionStore.getConnectionConfig.mockResolvedValue(null);

      const brokerWithoutServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(brokerWithoutServiceKey.refreshToken('TEST')).rejects.toThrow('serviceUrl');
    });

    it('should fallback to Step 2b (refreshTokenFromServiceKey) when Step 2a (refreshTokenFromSession) fails', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        refreshToken: 'refresh-token-123',
      };
      const newToken = 'fallback-token';
      const tokenResult: TokenProviderResult = {
        connectionConfig: {
          serviceUrl: 'https://test.sap.com',
          authorizationToken: newToken,
        },
        refreshToken: 'new-refresh-token',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      
      // Step 2a fails with RefreshError
      const refreshError = new Error('Refresh token expired');
      (refreshError as any).code = 'REFRESH_ERROR';
      mockTokenProvider.refreshTokenFromSession.mockRejectedValue(refreshError);
      
      // Step 2b succeeds
      mockTokenProvider.refreshTokenFromServiceKey.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue(undefined);
      mockSessionStore.setAuthorizationConfig.mockResolvedValue(undefined);

      const token = await broker.refreshToken('TEST');

      expect(token).toBe(newToken);
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
      expect(mockTokenProvider.refreshTokenFromServiceKey).toHaveBeenCalled();
      expect(mockSessionStore.setConnectionConfig).toHaveBeenCalled();
    });

    it('should throw error when both Step 2a and Step 2b fail', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client123',
        uaaClientSecret: 'secret123',
        refreshToken: 'refresh-token-123',
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      
      // Both steps fail
      const refreshError = new Error('Refresh token expired');
      (refreshError as any).code = 'REFRESH_ERROR';
      mockTokenProvider.refreshTokenFromSession.mockRejectedValue(refreshError);
      
      const browserError = new Error('Browser auth failed');
      (browserError as any).code = 'BROWSER_AUTH_ERROR';
      mockTokenProvider.refreshTokenFromServiceKey.mockRejectedValue(browserError);

      await expect(broker.refreshToken('TEST')).rejects.toThrow('Token refresh failed');
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
      expect(mockTokenProvider.refreshTokenFromServiceKey).toHaveBeenCalled();
    });

    it('should handle ValidationError from provider with missing fields', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'valid-client-id', // Valid value so broker proceeds to provider
        uaaClientSecret: 'valid-secret', // Valid value so broker proceeds to provider
        refreshToken: 'refresh-token-123', // Has refresh token to trigger Step 2a
      };

      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com', authorizationToken: '' });
      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      
      const validationError = new Error('Missing required fields: uaaClientId, uaaClientSecret');
      (validationError as any).code = 'VALIDATION_ERROR';
      (validationError as any).missingFields = ['uaaClientId', 'uaaClientSecret'];
      mockTokenProvider.refreshTokenFromSession.mockRejectedValue(validationError);
      mockTokenProvider.refreshTokenFromServiceKey.mockRejectedValue(validationError);

      // Use broker without serviceKeyStore to avoid Step 0
      const brokerNoServiceKey = new AuthBroker({
        sessionStore: mockSessionStore,
        tokenProvider: mockTokenProvider,
      }, undefined, noOpLogger);

      await expect(brokerNoServiceKey.refreshToken('TEST')).rejects.toThrow('Missing required fields');
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
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

  describe('createTokenRefresher', () => {
    it('should return ITokenRefresher with getToken and refreshToken methods', () => {
      const tokenRefresher = broker.createTokenRefresher('TEST');

      expect(tokenRefresher).toBeDefined();
      expect(typeof tokenRefresher.getToken).toBe('function');
      expect(typeof tokenRefresher.refreshToken).toBe('function');
    });

    it('should call broker.getToken when tokenRefresher.getToken is called', async () => {
      const connConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: 'valid-token-123',
      };
      mockSessionStore.getConnectionConfig.mockResolvedValue(connConfig);
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(true);

      const tokenRefresher = broker.createTokenRefresher('TEST');
      const token = await tokenRefresher.getToken();

      expect(token).toBe('valid-token-123');
      expect(mockSessionStore.getConnectionConfig).toHaveBeenCalledWith('TEST');
    });

    it('should call broker.refreshToken when tokenRefresher.refreshToken is called', async () => {
      const authConfig: IAuthorizationConfig = {
        uaaUrl: 'https://uaa.test.com',
        uaaClientId: 'client-id',
        uaaClientSecret: 'client-secret',
        refreshToken: 'refresh-token-123',
      };
      const newConnConfig: IConnectionConfig = {
        serviceUrl: 'https://test.sap.com',
        authorizationToken: 'new-refreshed-token-456',
      };
      const tokenResult: TokenProviderResult = {
        connectionConfig: newConnConfig,
        refreshToken: 'new-refresh-token',
      };

      mockSessionStore.getAuthorizationConfig.mockResolvedValue(authConfig);
      mockSessionStore.getConnectionConfig.mockResolvedValue({ serviceUrl: 'https://test.sap.com' });
      mockServiceKeyStore.getAuthorizationConfig!.mockResolvedValue(authConfig);
      mockServiceKeyStore.getConnectionConfig!.mockResolvedValue({ serviceUrl: 'https://test.sap.com' });
      mockTokenProvider.refreshTokenFromSession!.mockResolvedValue(tokenResult);
      mockSessionStore.setConnectionConfig.mockResolvedValue();
      mockSessionStore.setAuthorizationConfig.mockResolvedValue();

      const tokenRefresher = broker.createTokenRefresher('TEST');
      const token = await tokenRefresher.refreshToken();

      expect(token).toBe('new-refreshed-token-456');
      expect(mockTokenProvider.refreshTokenFromSession).toHaveBeenCalled();
    });

    it('should create independent refreshers for different destinations', async () => {
      const connConfig1: IConnectionConfig = {
        serviceUrl: 'https://dest1.sap.com',
        authorizationToken: 'token-dest1',
      };
      const connConfig2: IConnectionConfig = {
        serviceUrl: 'https://dest2.sap.com',
        authorizationToken: 'token-dest2',
      };

      mockSessionStore.getConnectionConfig
        .mockImplementation(async (dest: string) => {
          if (dest === 'DEST1') return connConfig1;
          if (dest === 'DEST2') return connConfig2;
          return null;
        });
      mockTokenProvider.validateToken = jest.fn().mockResolvedValue(true);

      const refresher1 = broker.createTokenRefresher('DEST1');
      const refresher2 = broker.createTokenRefresher('DEST2');

      const token1 = await refresher1.getToken();
      const token2 = await refresher2.getToken();

      expect(token1).toBe('token-dest1');
      expect(token2).toBe('token-dest2');
    });
  });

});
