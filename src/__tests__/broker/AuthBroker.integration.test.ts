/**
 * Integration tests for AuthBroker
 * 
 * Real tests using service keys, session stores, and actual token providers
 */

import { AuthBroker } from '../../AuthBroker';
import { createTestLogger } from '../helpers/testLogger';
import { loadTestConfig, getAbapDestination, getServiceKeysDir, getSessionsDir, hasRealConfig } from '../helpers/configHelpers';
import { AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-stores';
import { BtpTokenProvider } from '@mcp-abap-adt/auth-providers';

describe('AuthBroker Integration', () => {
  const config = loadTestConfig();
  const destination = getAbapDestination(config);
  const serviceKeysDir = getServiceKeysDir(config);
  const sessionsDir = getSessionsDir(config);

  it('should get token using real stores and providers', async () => {
    if (!hasRealConfig(config, 'abap') || !destination || !serviceKeysDir || !sessionsDir) {
      console.warn('⚠️  Skipping integration test - missing config');
      return;
    }

    // Create logger with debug enabled
    const logger = createTestLogger('AUTH-BROKER-INTEGRATION');

    logger.info(`Using service keys dir: ${serviceKeysDir}`);
    logger.info(`Using sessions dir: ${sessionsDir}`);
    logger.info(`Looking for service key file: ${serviceKeysDir}/${destination}.json`);

    // Create real stores with logger - VERIFY THEY WORK DIRECTLY FIRST
    const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
    const sessionStore = new AbapSessionStore(sessionsDir, logger);
    
    // Test stores directly before injecting into broker
    logger.info(`Testing serviceKeyStore directly...`);
    const directServiceKey = await serviceKeyStore.getServiceKey(destination);
    logger.info(`Direct serviceKeyStore.getServiceKey result: ${directServiceKey ? 'found' : 'not found'}`);
    
    const directAuthConfig = await serviceKeyStore.getAuthorizationConfig(destination);
    logger.info(`Direct serviceKeyStore.getAuthorizationConfig result: ${directAuthConfig ? 'found' : 'not found'}`);
    if (directAuthConfig) {
      logger.info(`Direct authConfig: uaaUrl(${directAuthConfig.uaaUrl.substring(0, 40)}...), clientId(${directAuthConfig.uaaClientId.substring(0, 20)}...)`);
    }
    
    const directConnConfig = await sessionStore.getConnectionConfig(destination);
    logger.info(`Direct sessionStore.getConnectionConfig result: ${directConnConfig ? 'found' : 'not found'}`);
    
    // Create real token provider
    const tokenProvider = new BtpTokenProvider();

    // Create AuthBroker with real stores and provider
    const broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      'system', // Use system default browser
      logger
    );

    logger.info(`Starting token retrieval for destination: ${destination}`);

    // Get token - this will use the full fallback chain
    const token = await broker.getToken(destination);

    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(0);

    logger.info(`Token retrieved successfully: token(${token.length} chars)`);

    // Verify token is saved to session
    const savedConfig = await sessionStore.getConnectionConfig(destination);
    expect(savedConfig).toBeDefined();
    expect(savedConfig?.authorizationToken).toBe(token);

    logger.info(`Token saved to session: file(${sessionsDir}/${destination}.env)`);
  }, 300000); // 5 minute timeout for browser auth

  it('should refresh token using real stores and providers', async () => {
    if (!hasRealConfig(config, 'abap') || !destination || !serviceKeysDir || !sessionsDir) {
      console.warn('⚠️  Skipping integration test - missing config');
      return;
    }

    // Create logger with debug enabled
    const logger = createTestLogger('AUTH-BROKER-INTEGRATION');

    logger.info(`Using service keys dir: ${serviceKeysDir}`);
    logger.info(`Using sessions dir: ${sessionsDir}`);
    logger.info(`Looking for service key file: ${serviceKeysDir}/${destination}.json`);

    // Create real stores with logger
    const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
    const sessionStore = new AbapSessionStore(sessionsDir, logger);
    
    // Create real token provider
    const tokenProvider = new BtpTokenProvider();

    // Create AuthBroker with real stores and provider
    const broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      'system', // Use system default browser
      logger
    );

    logger.info(`Starting token refresh for destination: ${destination}`);

    // Force refresh token
    const token = await broker.refreshToken(destination);

    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(0);

    logger.info(`Token refreshed successfully: token(${token.length} chars)`);

    // Verify token is saved to session
    const savedConfig = await sessionStore.getConnectionConfig(destination);
    expect(savedConfig).toBeDefined();
    expect(savedConfig?.authorizationToken).toBe(token);
  }, 300000); // 5 minute timeout for browser auth

  it('should get authorization config from stores', async () => {
    if (!hasRealConfig(config, 'abap') || !destination || !serviceKeysDir || !sessionsDir) {
      console.warn('⚠️  Skipping integration test - missing config');
      return;
    }

    // Create logger with debug enabled
    const logger = createTestLogger('AUTH-BROKER-INTEGRATION');

    logger.info(`Using service keys dir: ${serviceKeysDir}`);
    logger.info(`Looking for service key file: ${serviceKeysDir}/${destination}.json`);

    // Create real stores with logger
    const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
    const sessionStore = new AbapSessionStore(sessionsDir, logger);
    
    // Create real token provider
    const tokenProvider = new BtpTokenProvider();

    // Create AuthBroker with real stores and provider
    const broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      undefined,
      logger
    );

    logger.info(`Getting authorization config for destination: ${destination}`);

    // Get authorization config
    const authConfig = await broker.getAuthorizationConfig(destination);

    expect(authConfig).toBeDefined();
    expect(authConfig?.uaaUrl).toBeDefined();
    expect(authConfig?.uaaClientId).toBeDefined();
    expect(authConfig?.uaaClientSecret).toBeDefined();

    logger.info(`Authorization config retrieved: uaaUrl(${authConfig?.uaaUrl.substring(0, 40)}...), clientId(${authConfig?.uaaClientId.substring(0, 20)}...)`);
  });

  it('should get connection config from stores', async () => {
    if (!hasRealConfig(config, 'abap') || !destination || !serviceKeysDir || !sessionsDir) {
      console.warn('⚠️  Skipping integration test - missing config');
      return;
    }

    // Create logger with debug enabled
    const logger = createTestLogger('AUTH-BROKER-INTEGRATION');

    logger.info(`Using service keys dir: ${serviceKeysDir}`);
    logger.info(`Looking for service key file: ${serviceKeysDir}/${destination}.json`);

    // Create real stores with logger
    const serviceKeyStore = new AbapServiceKeyStore(serviceKeysDir, logger);
    const sessionStore = new AbapSessionStore(sessionsDir, logger);
    
    // Create real token provider
    const tokenProvider = new BtpTokenProvider();

    // Create AuthBroker with real stores and provider
    const broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      undefined,
      logger
    );

    logger.info(`Getting connection config for destination: ${destination}`);

    // Get connection config
    const connConfig = await broker.getConnectionConfig(destination);

    expect(connConfig).toBeDefined();
    expect(connConfig?.serviceUrl).toBeDefined();

    logger.info(`Connection config retrieved: serviceUrl(${connConfig?.serviceUrl}), token(${connConfig?.authorizationToken?.length || 0} chars)`);
  });
});
