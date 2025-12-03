/**
 * Integration tests for AuthBroker with XSUAA service keys and sessions
 * 
 * These tests require:
 * 1. test-config.yaml file in tests/ directory (see test-config.yaml.template)
 * 2. XSUAA service key file: <btp_destination>.json in service-keys directory
 * 
 * To run these tests:
 * 1. Copy tests/test-config.yaml.template to tests/test-config.yaml
 * 2. Fill in real values for <TEST_BTP_DESTINATION>, <TEST_MCP_DESTINATION>, <TEST_BTP_URL>
 * 3. Place service key file in ~/.config/mcp-abap-adt/service-keys/<btp_destination>.json
 * 4. Run: npm test -- XsuaaAuthBroker.integration.test.ts
 */

import { AuthBroker } from '../AuthBroker';
import { XsuaaServiceKeyStore, XsuaaSessionStore, ISessionStore } from '../stores';
import { BtpSessionConfig } from '../types';
import { loadTestConfig, hasRealConfig, getXsuaaDestinations, getServiceKeysDir, getSessionsDir } from './configHelpers';
import * as path from 'path';
import * as os from 'os';

describe('AuthBroker with XSUAA (Integration)', () => {
  const config = loadTestConfig();
  const shouldSkip = !hasRealConfig(config, 'xsuaa');

  if (shouldSkip) {
    console.log('Skipping XSUAA integration tests: test-config.yaml not found or contains placeholders');
    console.log('To run these tests:');
    console.log('  1. Copy tests/test-config.yaml.template to tests/test-config.yaml');
    console.log('  2. Fill in real values for <TEST_BTP_DESTINATION>, <TEST_MCP_DESTINATION>, <TEST_BTP_URL>');
    console.log('  3. Place service key file in service-keys directory');
    return;
  }

  const { btp_destination, btp_url } = getXsuaaDestinations(config);
  const serviceKeysDir = getServiceKeysDir(config);
  const sessionsDir = getSessionsDir(config);
  let broker: AuthBroker;
  let sessionStore: ISessionStore;

  beforeAll(() => {
    // Use YAML config paths if available, resolve ~ to home directory
    const resolvePath = (dirPath: string): string => {
      if (dirPath.startsWith('~')) {
        return path.join(os.homedir(), dirPath.slice(1));
      }
      return path.resolve(dirPath);
    };
    
    const testServiceKeysDir = serviceKeysDir ? [resolvePath(serviceKeysDir)] : undefined;
    const testSessionsDir = sessionsDir ? [resolvePath(sessionsDir)] : undefined;
    sessionStore = testSessionsDir ? new XsuaaSessionStore(testSessionsDir) : new XsuaaSessionStore();
    broker = new AuthBroker({
      serviceKeyStore: testServiceKeysDir ? new XsuaaServiceKeyStore(testServiceKeysDir) : new XsuaaServiceKeyStore(),
      sessionStore: sessionStore,
    });
  });

  afterAll(() => {
    broker.clearAllCache();
  });

  describe('getToken with XSUAA', () => {
    it(`should get token from XSUAA service key (files: ${btp_destination}.json, ${btp_destination}.env)`, async () => {
      if (!btp_destination) {
        return;
      }
      
      const serviceKeysDir = getServiceKeysDir(config);
      const sessionsDir = getSessionsDir(config);
      const resolvePath = (dirPath: string): string => {
        if (dirPath && dirPath.startsWith('~')) {
          return path.join(os.homedir(), dirPath.slice(1));
        }
        return dirPath ? path.resolve(dirPath) : '';
      };
      
      const serviceKeyPath = serviceKeysDir 
        ? path.join(resolvePath(serviceKeysDir), `${btp_destination}.json`)
        : `~/.config/mcp-abap-adt/service-keys/${btp_destination}.json`;
      const sessionPath = sessionsDir
        ? path.join(resolvePath(sessionsDir), `${btp_destination}.env`)
        : `~/.config/mcp-abap-adt/sessions/${btp_destination}.env`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 getToken XSUAA: service key: ${serviceKeyPath}, session: ${sessionPath}`);
      }
      
      // This will use client_credentials grant type (no browser)
      const token = await broker.getToken(btp_destination);
      
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    }, 60000);
  });

  describe('refreshToken with XSUAA', () => {
    it(`should refresh token using XSUAA service key (files: ${btp_destination}.json, ${btp_destination}.env)`, async () => {
      if (!btp_destination) {
        return;
      }
      
      const serviceKeysDir = getServiceKeysDir(config);
      const sessionsDir = getSessionsDir(config);
      const resolvePath = (dirPath: string): string => {
        if (dirPath && dirPath.startsWith('~')) {
          return path.join(os.homedir(), dirPath.slice(1));
        }
        return dirPath ? path.resolve(dirPath) : '';
      };
      
      const serviceKeyPath = serviceKeysDir 
        ? path.join(resolvePath(serviceKeysDir), `${btp_destination}.json`)
        : `~/.config/mcp-abap-adt/service-keys/${btp_destination}.json`;
      const sessionPath = sessionsDir
        ? path.join(resolvePath(sessionsDir), `${btp_destination}.env`)
        : `~/.config/mcp-abap-adt/sessions/${btp_destination}.env`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 refreshToken XSUAA: service key: ${serviceKeyPath}, session: ${sessionPath}`);
      }
      
      // This will use client_credentials grant type (no browser)
      const token = await broker.refreshToken(btp_destination);
      
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    }, 60000);
  });

  describe('getSapUrl with XSUAA', () => {
    it(`should return BTP URL from session (XSUAA key has no URL) (files: ${btp_destination}.json, ${btp_destination}.env)`, async () => {
      if (!btp_destination || !btp_url) {
        return;
      }
      
      const serviceKeysDir = getServiceKeysDir(config);
      const sessionsDir = getSessionsDir(config);
      const resolvePath = (dirPath: string): string => {
        if (dirPath && dirPath.startsWith('~')) {
          return path.join(os.homedir(), dirPath.slice(1));
        }
        return dirPath ? path.resolve(dirPath) : '';
      };
      
      const serviceKeyPath = serviceKeysDir 
        ? path.join(resolvePath(serviceKeysDir), `${btp_destination}.json`)
        : `~/.config/mcp-abap-adt/service-keys/${btp_destination}.json`;
      const sessionPath = sessionsDir
        ? path.join(resolvePath(sessionsDir), `${btp_destination}.env`)
        : `~/.config/mcp-abap-adt/sessions/${btp_destination}.env`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 getSapUrl XSUAA: service key: ${serviceKeyPath}, session: ${sessionPath}, URL: ${btp_url}`);
      }
      
      // For XSUAA, service key doesn't contain MCP URL - it must come from session
      // First, create a session with mcpUrl
      const sessionConfig: BtpSessionConfig = {
        mcpUrl: btp_url,
        jwtToken: 'test-token-123',
      };
      await sessionStore.saveSession(btp_destination, sessionConfig);
      
      // Now getSapUrl should return mcpUrl from session
      const url = await broker.getSapUrl(btp_destination);
      
      expect(url).toBeTruthy();
      expect(typeof url).toBe('string');
      expect(url).toBe(btp_url);
      
      // Cleanup
      if (sessionStore.deleteSession) {
        await sessionStore.deleteSession(btp_destination);
      }
    });
  });

  describe('XSUAA session management', () => {
    it(`should save and load XSUAA session (files: ${btp_destination}.env)`, async () => {
      if (!btp_destination || !btp_url) {
        return;
      }
      
      const sessionsDir = getSessionsDir(config);
      const resolvePath = (dirPath: string): string => {
        if (dirPath && dirPath.startsWith('~')) {
          return path.join(os.homedir(), dirPath.slice(1));
        }
        return dirPath ? path.resolve(dirPath) : '';
      };
      
      const sessionPath = sessionsDir
        ? path.join(resolvePath(sessionsDir), `${btp_destination}.env`)
        : `~/.config/mcp-abap-adt/sessions/${btp_destination}.env`;
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 XSUAA session: saving to ${sessionPath}`);
      }
      
      const sessionConfig: BtpSessionConfig = {
        mcpUrl: btp_url,
        jwtToken: 'test-token-123',
        refreshToken: 'test-refresh-123',
      };

      await sessionStore.saveSession(btp_destination, sessionConfig);
      
      if (process.env.TEST_VERBOSE) {
        console.log(`📁 XSUAA session: loading from ${sessionPath}`);
      }
      
      const loaded = await sessionStore.loadSession(btp_destination);
      
      expect(loaded).not.toBeNull();
      if (loaded && 'mcpUrl' in loaded) {
        expect(loaded.mcpUrl).toBe(btp_url);
        expect(loaded.jwtToken).toBe('test-token-123');
        expect(loaded.refreshToken).toBe('test-refresh-123');
      }

      // Cleanup
      if (sessionStore.deleteSession) {
        await sessionStore.deleteSession(btp_destination);
      }
    });
  });
});

