/**
 * Tests for AuthBroker with XSUAA service keys and sessions
 * 
 * These tests require test-config.yaml with XSUAA configuration.
 * If config is missing or contains placeholders, tests will be skipped.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AuthBroker } from '../AuthBroker';
import { XsuaaServiceKeyStore, XsuaaSessionStore, SafeXsuaaSessionStore, ISessionStore } from '../stores';
import { BtpSessionConfig } from '../types';
import { loadTestConfig, hasRealConfig, getXsuaaDestinations, getServiceKeysDir, getSessionsDir } from './configHelpers';

/**
 * Resolve path, expanding ~ to home directory
 */
function resolvePath(dirPath: string): string {
  if (dirPath.startsWith('~')) {
    return path.join(os.homedir(), dirPath.slice(1));
  }
  return path.resolve(dirPath);
}

describe('AuthBroker with XSUAA', () => {
  const config = loadTestConfig();
  const shouldSkip = !hasRealConfig(config, 'xsuaa');

  if (shouldSkip) {
    console.log('Skipping XSUAA tests: test-config.yaml not found or contains placeholders');
    console.log('To run these tests:');
    console.log('  1. Copy tests/test-config.yaml.template to tests/test-config.yaml');
    console.log('  2. Fill in real values for XSUAA configuration');
    console.log('  3. Place service key file in service-keys directory');
    return;
  }

  const { btp_destination } = getXsuaaDestinations(config);
  // btp_url is not needed for XSUAA tests - mcpUrl is optional and comes from YAML/config, not service key
  const serviceKeysDir = getServiceKeysDir(config);
  const sessionsDir = getSessionsDir(config);
  let tempDir: string;
  let broker: AuthBroker;
  let sessionStore: ISessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsuaa-auth-broker-test-'));
    // Use YAML config paths if available, otherwise use temp directory
    // Resolve ~ to home directory
    const testServiceKeysDir = serviceKeysDir ? resolvePath(serviceKeysDir) : tempDir;
    const testSessionsDir = sessionsDir ? resolvePath(sessionsDir) : tempDir;
    sessionStore = new XsuaaSessionStore([testSessionsDir]);
    broker = new AuthBroker({
      serviceKeyStore: new XsuaaServiceKeyStore([testServiceKeysDir]),
      sessionStore: sessionStore,
    });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    broker.clearAllCache();
  });

  describe('getToken with XSUAA service key', () => {
    it('should load token from XSUAA session if exists', async () => {
      if (!btp_destination) {
        return;
      }

      // mcpUrl is optional - can be undefined
      const sessionConfig: BtpSessionConfig = {
        jwtToken: 'valid-token-123',
      };

      await sessionStore.saveSession(btp_destination, sessionConfig);

      // For XSUAA, token is returned directly from session (no validation)
      const token = await broker.getToken(btp_destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
    });

    it('should throw error if no service key and no session', async () => {
      await expect(broker.getToken('NONEXISTENT')).rejects.toThrow('No authentication found');
    });
  });

  describe('refreshToken with XSUAA service key', () => {
    it('should work with XSUAA service key that has UAA credentials', async () => {
      if (!btp_destination) {
        return;
      }

      // Load service key from YAML config path or default location
      const testServiceKeysDir = serviceKeysDir ? resolvePath(serviceKeysDir) : undefined;
      const serviceKeyStore = testServiceKeysDir 
        ? new XsuaaServiceKeyStore([testServiceKeysDir])
        : new XsuaaServiceKeyStore();
      const serviceKeyPath = testServiceKeysDir 
        ? path.join(testServiceKeysDir, `${btp_destination}.json`)
        : `~/.config/mcp-abap-adt/service-keys/${btp_destination}.json`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 XSUAA refreshToken: service key: ${serviceKeyPath}`);
      }
      
      const serviceKey = await serviceKeyStore.getServiceKey(btp_destination);
      
      if (!serviceKey) {
        throw new Error(`Service key not found for destination "${btp_destination}". Place service key file in ${serviceKeyPath}`);
      }

      // Copy service key to temp directory for test
      const skFile = path.join(tempDir, `${btp_destination}.json`);
      fs.writeFileSync(skFile, JSON.stringify({
        url: serviceKey.uaa.url,
        clientid: serviceKey.uaa.clientid,
        clientsecret: serviceKey.uaa.clientsecret,
        abap: serviceKey.abap,
      }));

      // Mock client credentials auth for XSUAA (no browser needed)
      const getClientCredentialsTokenSpy = jest.spyOn(require('../clientCredentialsAuth'), 'getTokenWithClientCredentials');
      getClientCredentialsTokenSpy.mockResolvedValue({
        accessToken: 'new-token-123',
      });

      const token = await broker.refreshToken(btp_destination);

      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
      expect(getClientCredentialsTokenSpy).toHaveBeenCalled();

      // Verify session was saved
      const savedSession = await sessionStore.loadSession(btp_destination);
      expect(savedSession).not.toBeNull();
      if (savedSession && 'mcpUrl' in savedSession) {
        expect(savedSession.jwtToken).toBeTruthy();
        expect(savedSession.jwtToken.length).toBeGreaterThan(0);
        // mcpUrl is optional - not checked
      }


      getClientCredentialsTokenSpy.mockRestore();
    });

    it('should work with XSUAA service key without SAP URL (XSUAA key only has UAA credentials)', async () => {
      // XSUAA service key format: url contains 'authentication' or is UAA URL
      const serviceKey = {
        url: 'https://authentication.test.com', // Must contain 'authentication' to be detected as XSUAA
        clientid: 'client123',
        clientsecret: 'secret123',
        // Missing abap.url, url is UAA URL, not SAP URL - this is OK for XSUAA
      };

      // Create a separate broker that uses tempDir for this test
      const testBroker = new AuthBroker({
        serviceKeyStore: new XsuaaServiceKeyStore([tempDir]),
        sessionStore: new XsuaaSessionStore([tempDir]),
      }, 'none'); // Use 'none' browser to avoid opening browser

      const skFile = path.join(tempDir, 'mcp.json');
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      // Mock client credentials auth for XSUAA (no browser needed)
      const getClientCredentialsTokenSpy = jest.spyOn(require('../clientCredentialsAuth'), 'getTokenWithClientCredentials');
      getClientCredentialsTokenSpy.mockResolvedValue({
        accessToken: 'new-token-123',
      });

      // Mock browser auth to ensure it's NOT called for XSUAA
      const startBrowserAuthSpy = jest.spyOn(require('../browserAuth'), 'startBrowserAuth');
      startBrowserAuthSpy.mockResolvedValue({
        accessToken: 'browser-token',
        refreshToken: 'browser-refresh',
      });

      // For XSUAA, refreshToken should work even without SAP URL
      // (MCP URL is optional and can be provided separately)
      const token = await testBroker.refreshToken('mcp');

      expect(token).toBe('new-token-123');
      expect(getClientCredentialsTokenSpy).toHaveBeenCalled();
      expect(startBrowserAuthSpy).not.toHaveBeenCalled(); // Browser auth should NOT be called for XSUAA
      
      getClientCredentialsTokenSpy.mockRestore();
      startBrowserAuthSpy.mockRestore();
    });
  });

  describe('getSapUrl with XSUAA', () => {
    it('should return mcpUrl from XSUAA session if present', async () => {
      if (!btp_destination) {
        return;
      }

      // mcpUrl is optional - test with it present
      const testUrl = 'https://test-mcp.cfapps.eu10.hana.ondemand.com';
      const sessionConfig: BtpSessionConfig = {
        mcpUrl: testUrl,
        jwtToken: 'token123',
      };

      await sessionStore.saveSession(btp_destination, sessionConfig);

      const url = await broker.getSapUrl(btp_destination);
      expect(url).toBe(testUrl);
    });

    it('should return undefined for XSUAA service key if no session (XSUAA key has no URL)', async () => {
      if (!btp_destination) {
        return;
      }

      // Load service key from YAML config path or default location
      const testServiceKeysDir = serviceKeysDir ? resolvePath(serviceKeysDir) : undefined;
      const serviceKeyStore = testServiceKeysDir 
        ? new XsuaaServiceKeyStore([testServiceKeysDir])
        : new XsuaaServiceKeyStore();
      const serviceKeyPath = testServiceKeysDir 
        ? path.join(testServiceKeysDir, `${btp_destination}.json`)
        : `~/.config/mcp-abap-adt/service-keys/${btp_destination}.json`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 XSUAA getSapUrl: service key: ${serviceKeyPath}`);
      }
      
      const serviceKey = await serviceKeyStore.getServiceKey(btp_destination);
      
      if (!serviceKey) {
        throw new Error(`Service key not found for destination "${btp_destination}". Place service key file in ${serviceKeyPath}`);
      }

      // Copy XSUAA service key to temp directory for test
      // XSUAA key only contains UAA credentials, no MCP URL
      const skFile = path.join(tempDir, `${btp_destination}.json`);
      fs.writeFileSync(skFile, JSON.stringify({
        url: serviceKey.uaa.url, // UAA URL, not MCP URL
        clientid: serviceKey.uaa.clientid,
        clientsecret: serviceKey.uaa.clientsecret,
        // No abap.url - XSUAA key only has UAA credentials for authentication
      }));

      // Make sure no session exists
      if (sessionStore.deleteSession) {
        await sessionStore.deleteSession(btp_destination);
      }

      // For XSUAA, getSapUrl should return undefined if no session
      // Because XSUAA service key doesn't contain MCP URL (only UAA credentials)
      const url = await broker.getSapUrl(btp_destination);
      expect(url).toBeUndefined();
    });
  });

  describe('with SafeXsuaaSessionStore', () => {
    it('should work with in-memory XSUAA session store', async () => {
      if (!btp_destination) {
        return;
      }

      const safeSessionStore = new SafeXsuaaSessionStore();
      
      // Create service key for test (XSUAA format)
      const serviceKey = {
        url: 'https://authentication.test.com',
        clientid: 'client123',
        clientsecret: 'secret123',
      };
      const skFile = path.join(tempDir, `${btp_destination}.json`);
      fs.writeFileSync(skFile, JSON.stringify(serviceKey));

      const safeBroker = new AuthBroker({
        serviceKeyStore: new XsuaaServiceKeyStore([tempDir]),
        sessionStore: safeSessionStore,
      }, 'none'); // Use 'none' browser to avoid opening browser

      // mcpUrl is optional - test without it
      const sessionConfig: BtpSessionConfig = {
        jwtToken: 'token123',
      };

      await safeSessionStore.saveSession(btp_destination, sessionConfig);

      // For XSUAA, token validation is not performed (no SAP URL to validate against)
      // Just return the token from session
      const token = await safeBroker.getToken(btp_destination);
      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThan(0);
    });
  });
});

