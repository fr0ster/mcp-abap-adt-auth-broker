/**
 * Integration tests for AuthBroker
 *
 * Real tests using service keys, session stores, and actual token providers
 * Tests use test-config.yaml for configuration (same as auth-providers)
 *
 * Test scenarios:
 * 1. Only service key (no session) - should login via browser
 * 2. Service key + fresh session - should use token from session
 * 3. Service key + expired session + expired refresh token - should login via browser
 * 4. Token validation - validate token expiration
 * 5. allowBrowserAuth option - test behavior with browser auth disabled
 */

import { AuthorizationCodeProvider } from '@mcp-abap-adt/auth-providers';
import {
  AbapServiceKeyStore,
  SafeAbapSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { AuthBroker } from '../../AuthBroker';
import {
  getAbapDestination,
  getExpiredToken,
  getRefreshToken,
  getServiceKeysDir,
  hasRealConfig,
  loadTestConfig,
} from '../helpers/configHelpers';
import { createTestLogger } from '../helpers/testLogger';

// Helper to create expired JWT token
const createExpiredJWT = (): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 }), // Expired 1 hour ago
  ).toString('base64url');
  return `${header}.${payload}.signature`;
};

// Helper to create valid JWT token
const createValidJWT = (): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), // Valid for 1 hour
  ).toString('base64url');
  return `${header}.${payload}.signature`;
};

// Helper to validate token expiration
// Returns true if token is valid (not expired), false otherwise
const validateTokenExpiration = (token: string): boolean => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    // Decode payload
    const payload = parts[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '=='.substring(0, (4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(decoded);

    if (!claims.exp) {
      return false;
    }

    // Add 60 second buffer to account for clock skew and network latency
    const bufferMs = 60 * 1000;
    const expiresAt = claims.exp * 1000; // Convert to milliseconds
    return Date.now() < expiresAt - bufferMs;
  } catch {
    return false;
  }
};

describe('AuthBroker Integration', () => {
  const config = loadTestConfig();
  const destination = getAbapDestination(config);
  const serviceKeysDir = getServiceKeysDir(config);
  const hasRealConfigValue = hasRealConfig(config, 'abap');

  describe('Scenario 1 & 2: Token lifecycle', () => {
    it('should get token via browser and reuse token from session', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      // Ensure no session exists
      try {
        await sessionStore.deleteSession(destination);
      } catch {
        // Session doesn't exist, that's fine
      }

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      // Create token provider
      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        browser: 'system', // Use system browser for authentication
        redirectPort: 3101, // Unique port for Scenario 1
        logger,
      } as any);

      // Create AuthBroker with real stores and provider
      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        'system', // Use system default browser
        logger,
      );

      // Scenario 1: Get token - should login via browser (no session exists)
      logger.info(
        `Scenario 1: Getting token for destination: ${destination} (no session)`,
      );
      const token1 = await broker.getToken(destination);

      expect(token1).toBeDefined();
      expect(token1.length).toBeGreaterThan(0);

      // Validate that new token is valid and not expired
      const isValid1 = validateTokenExpiration(token1);
      expect(isValid1).toBe(true);

      // Verify token is saved to session
      const savedConfig1 = await sessionStore.getConnectionConfig(destination);
      expect(savedConfig1).toBeDefined();
      expect(savedConfig1?.authorizationToken).toBe(token1);

      logger.info(
        `Scenario 1: Token retrieved and saved: token(${token1.length} chars)`,
      );

      // Wait a bit for server to fully close and port to be freed
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Scenario 2: Get token again - should use cached token from session
      logger.info(
        `Scenario 2: Getting token again for destination: ${destination} (should use session)`,
      );

      // Get auth config from session (should have refresh token now)
      const sessionAuthConfig =
        await sessionStore.getAuthorizationConfig(destination);
      expect(sessionAuthConfig).toBeDefined();
      expect(sessionAuthConfig?.refreshToken).toBeDefined();

      // Create new provider with tokens from session
      const tokenProvider2 = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        refreshToken: sessionAuthConfig?.refreshToken,
        accessToken: token1, // Use token from Scenario 1
        browser: 'system', // Use system browser if token refresh/login needed
        redirectPort: 3102, // Unique port for Scenario 2
        logger,
      } as any);

      // Create new broker with updated provider
      const broker2 = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider: tokenProvider2,
        },
        'system',
        logger,
      );

      const token2 = await broker2.getToken(destination);
      expect(token2).toBeDefined();
      expect(token2.length).toBeGreaterThan(0);

      // Should use cached token from Scenario 1 (if still valid)
      // Or refresh if expired
      const isValid2 = validateTokenExpiration(token2);
      expect(isValid2).toBe(true);

      logger.info(
        `Scenario 2: Token retrieved: token(${token2.length} chars), valid: ${isValid2}`,
      );
    }, 300000); // 5 minutes timeout for manual browser authentication
  });

  describe('Scenario 3: Service key + expired session + expired refresh token', () => {
    it('should return expired token from session, provider handles re-auth when needed', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      // Get service URL from service key
      const serviceKeyConnConfig =
        await serviceKeyStore.getConnectionConfig(destination);
      if (!serviceKeyConnConfig?.serviceUrl) {
        throw new Error('Failed to load service URL from service key');
      }

      // Get expired token from YAML config (real expired token) or create fake one
      const expiredTokenFromConfig = getExpiredToken(config);
      const expiredToken = expiredTokenFromConfig || createExpiredJWT();

      logger.info(
        `Scenario 3: Using expired token: ${expiredTokenFromConfig ? 'real (from YAML config)' : 'fake (generated)'}`,
      );

      // Debug: Print token to see what we're working with
      logger.info(
        `Scenario 3: Expired token: ${expiredToken.substring(0, 50)}...`,
      );
      try {
        const parts = expiredToken.split('.');
        if (parts.length === 3) {
          const payload = parts[1];
          const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
          const padded =
            base64 + '=='.substring(0, (4 - (base64.length % 4)) % 4);
          const decoded = Buffer.from(padded, 'base64').toString('utf8');
          const claims = JSON.parse(decoded);
          logger.info(
            `Scenario 3: Expired token claims: ${JSON.stringify(claims, null, 2)}`,
          );
          logger.info(
            `Scenario 3: Token exp=${claims.exp}, now=${Math.floor(Date.now() / 1000)}, expired=${claims.exp < Math.floor(Date.now() / 1000)}`,
          );
        }
      } catch (e) {
        logger.warn(`Scenario 3: Failed to decode expired token: ${e}`);
      }

      // Save expired token to session to simulate expired session
      await sessionStore.setConnectionConfig(destination, {
        serviceUrl: serviceKeyConnConfig.serviceUrl,
        authorizationToken: expiredToken, // Expired token in session
        authType: 'jwt',
      });

      // Get refresh token from YAML config (real refresh token) or from previous scenarios
      // Priority: 1. YAML config, 2. Previous scenario session, 3. Invalid (for testing)
      const refreshTokenFromConfig = getRefreshToken(config);
      const sessionAuthConfigBefore =
        await sessionStore.getAuthorizationConfig(destination);
      const refreshTokenFromSession = sessionAuthConfigBefore?.refreshToken;
      const validRefreshToken =
        refreshTokenFromConfig || refreshTokenFromSession;

      logger.info(
        `Scenario 3: Refresh token: ${refreshTokenFromConfig ? 'from YAML config' : refreshTokenFromSession ? 'from previous scenario' : 'not available (will use invalid)'}`,
      );

      await sessionStore.setAuthorizationConfig(destination, {
        uaaUrl: authConfig.uaaUrl!,
        uaaClientId: authConfig.uaaClientId!,
        uaaClientSecret: authConfig.uaaClientSecret!,
        refreshToken: validRefreshToken || 'invalid-expired-refresh-token', // Use valid if available
      });

      // Create provider with expired/invalid token
      // Problem: If access token is invalid (can't be parsed), provider might skip refresh
      // even with valid refresh token and go straight to login
      // Provider.getTokens() flow:
      // 1. Check if token is valid -> if can't parse, might skip refresh -> login
      // 2. If token can be parsed but expired -> try refresh (if refresh token available)
      // 3. If refresh fails -> clear refresh token -> perform login (authorization via browser)
      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        refreshToken: validRefreshToken || 'invalid-expired-refresh-token', // Use valid if available
        accessToken: expiredToken, // Expired/invalid token - this might cause issues
        browser: 'system', // Use system browser for authentication (login, not refresh)
        redirectPort: 3103, // Unique port for Scenario 3
        logger,
      } as any);

      logger.info(
        `Scenario 3: Provider initialized with accessToken: ${expiredToken.substring(0, 50)}..., refreshToken: ${validRefreshToken ? 'valid' : 'invalid'}`,
      );

      // Create AuthBroker
      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        'system',
        logger,
      );

      // Broker flow:
      // 1. Gets expired token from session
      // 2. Validates token -> invalid (expired)
      // 3. Calls provider.getTokens() -> provider tries refresh -> fails -> performs login (authorization)
      // 4. Returns new token from login
      logger.info(
        `Scenario 3: Getting token via broker (expired token in session, invalid refresh token)`,
      );
      logger.info(
        `Scenario 3: Expired token in session: ${expiredToken.substring(0, 50)}...`,
      );
      logger.info(
        `Scenario 3: Provider will try refresh -> fail -> perform login (authorization via browser)`,
      );

      // Broker validates token, sees it's expired, calls provider.getTokens()
      // Provider tries refresh (fails), then performs login (authorization via browser)
      // Consumer doesn't know about token issues - provider handles refresh/login internally

      // Debug: Check if provider has validateToken
      const hasValidateToken =
        'validateToken' in tokenProvider &&
        typeof (tokenProvider as any).validateToken === 'function';
      logger.info(
        `Scenario 3: Provider has validateToken: ${hasValidateToken}`,
      );

      // Debug: Test validateToken directly
      if (hasValidateToken) {
        try {
          const validationResult = await (tokenProvider as any).validateToken(
            expiredToken,
            serviceKeyConnConfig.serviceUrl,
          );
          logger.info(
            `Scenario 3: validateToken result for expired token: ${validationResult}`,
          );
        } catch (e) {
          logger.warn(`Scenario 3: validateToken failed: ${e}`);
        }
      }

      const token = await broker.getToken(destination);

      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);

      // Token should be different from expired token (provider handled re-auth)
      // If token is the same as expired token, broker returned it from session without validation/refresh
      if (token === expiredToken) {
        logger.error(
          `Scenario 3: ERROR - Broker returned expired token from session without calling provider.getTokens()!`,
        );
        logger.error(
          `Scenario 3: This means broker didn't validate token or validateToken returned true for expired token`,
        );
      }
      expect(token).not.toBe(expiredToken);
      logger.info(
        `Scenario 3: Token received: ${token.substring(0, 50)}... (different from expired: ${token !== expiredToken})`,
      );

      // Validate that new token is valid and not expired
      const isValid = validateTokenExpiration(token);
      expect(isValid).toBe(true);

      // Verify that new token is saved to session (not expired token)
      const savedConfig = await sessionStore.getConnectionConfig(destination);
      expect(savedConfig).toBeDefined();
      expect(savedConfig?.authorizationToken).toBe(token);
      expect(savedConfig?.authorizationToken).not.toBe(expiredToken);

      logger.info(
        `Scenario 3: Token retrieved after provider handled re-authentication: token(${token.length} chars), valid: ${isValid}`,
      );
    }, 300000); // 5 minutes timeout for manual browser authentication
  });

  describe('Token validation', () => {
    it('should validate token expiration correctly', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        logger,
      } as any);

      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        undefined,
        logger,
      );

      // Test validation of expired token
      const expiredToken = createExpiredJWT();
      if (
        'validateToken' in tokenProvider &&
        typeof tokenProvider.validateToken === 'function'
      ) {
        const isValidExpired = await tokenProvider.validateToken(expiredToken);
        expect(isValidExpired).toBe(false);

        // Test validation of valid token
        const validToken = createValidJWT();
        const isValidValid = await tokenProvider.validateToken(validToken);
        expect(isValidValid).toBe(true);

        logger.info(
          `Token validation test: expired(${isValidExpired}), valid(${isValidValid})`,
        );
      } else {
        // If validateToken is not available, skip validation test
        logger.info(
          'Token validation test skipped - validateToken not available',
        );
      }
    }, 30000);
  });

  describe('allowBrowserAuth option', () => {
    it('should throw BROWSER_AUTH_REQUIRED when allowBrowserAuth=false and no valid session', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      // Ensure no session exists
      try {
        await sessionStore.deleteSession(destination);
      } catch {
        // Session doesn't exist, that's fine
      }

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        browser: 'none', // No browser for this test
        logger,
      } as any);

      // Create broker with allowBrowserAuth=false
      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
          allowBrowserAuth: false,
        },
        'none',
        logger,
      );

      // Should throw BROWSER_AUTH_REQUIRED error
      await expect(broker.getToken(destination)).rejects.toThrow(
        'Browser authentication required',
      );
    }, 30000);

    it('should work with allowBrowserAuth=false if valid token exists in session', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      // First, get a valid token and save it to session
      const tokenProvider1 = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        browser: 'system',
        redirectPort: 3104,
        logger,
      } as any);

      const broker1 = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider: tokenProvider1,
        },
        'system',
        logger,
      );

      // Get token and save to session
      const validToken = await broker1.getToken(destination);
      expect(validToken).toBeDefined();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Now create broker with allowBrowserAuth=false and use token from session
      const sessionAuthConfig =
        await sessionStore.getAuthorizationConfig(destination);
      const sessionConnConfig =
        await sessionStore.getConnectionConfig(destination);

      const tokenProvider2 = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        refreshToken: sessionAuthConfig?.refreshToken,
        accessToken: sessionConnConfig?.authorizationToken,
        browser: 'none',
        logger,
      } as any);

      const broker2 = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider: tokenProvider2,
          allowBrowserAuth: false,
        },
        'none',
        logger,
      );

      // Should work with valid token from session
      const token = await broker2.getToken(destination);
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);
    }, 300000);
  });

  describe('Fallback to service key', () => {
    it('should use service key when session is empty', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      // Ensure no session exists
      try {
        await sessionStore.deleteSession(destination);
      } catch {
        // Session doesn't exist, that's fine
      }

      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!authConfig) {
        throw new Error('Failed to load authorization config from service key');
      }

      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: authConfig.uaaUrl!,
        clientId: authConfig.uaaClientId!,
        clientSecret: authConfig.uaaClientSecret!,
        browser: 'system',
        redirectPort: 3105,
        logger,
      } as any);

      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        'system',
        logger,
      );

      // Should fallback to service key and login via browser
      const token = await broker.getToken(destination);

      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);

      // Verify token is saved to session
      const savedConfig = await sessionStore.getConnectionConfig(destination);
      expect(savedConfig).toBeDefined();
      expect(savedConfig?.authorizationToken).toBe(token);
    }, 300000);
  });

  describe('getAuthorizationConfig and getConnectionConfig', () => {
    it('should get authorization config from stores', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      const serviceKeyAuthConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!serviceKeyAuthConfig) {
        throw new Error('Missing auth config for integration test');
      }

      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: serviceKeyAuthConfig.uaaUrl,
        clientId: serviceKeyAuthConfig.uaaClientId,
        clientSecret: serviceKeyAuthConfig.uaaClientSecret,
        refreshToken: serviceKeyAuthConfig.refreshToken,
        browser: 'system',
        logger,
      } as any);

      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        undefined,
        logger,
      );

      const authConfig = await broker.getAuthorizationConfig(destination);

      expect(authConfig).toBeDefined();
      expect(authConfig?.uaaUrl).toBeDefined();
      expect(authConfig?.uaaClientId).toBeDefined();
      expect(authConfig?.uaaClientSecret).toBeDefined();
    });

    it('should get connection config from stores', async () => {
      if (!hasRealConfigValue) {
        console.warn('⚠️  Skipping integration test - no real config');
        return;
      }

      if (!destination || !serviceKeysDir) {
        console.warn('⚠️  Skipping integration test - missing required config');
        return;
      }

      const logger = createTestLogger('AUTH-BROKER-INTEGRATION');
      const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
      const sessionStore = new SafeAbapSessionStore(logger);

      const serviceKeyAuthConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      if (!serviceKeyAuthConfig) {
        throw new Error('Missing auth config for integration test');
      }

      const tokenProvider = new AuthorizationCodeProvider({
        uaaUrl: serviceKeyAuthConfig.uaaUrl,
        clientId: serviceKeyAuthConfig.uaaClientId,
        clientSecret: serviceKeyAuthConfig.uaaClientSecret,
        refreshToken: serviceKeyAuthConfig.refreshToken,
        browser: 'system',
        logger,
      } as any);

      const broker = new AuthBroker(
        {
          serviceKeyStore,
          sessionStore,
          tokenProvider,
        },
        undefined,
        logger,
      );

      const connConfig = await broker.getConnectionConfig(destination);

      expect(connConfig).toBeDefined();
      expect(connConfig?.serviceUrl).toBeDefined();
    });
  });
});
