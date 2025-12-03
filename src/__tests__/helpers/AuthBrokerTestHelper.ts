/**
 * Test helper class for AuthBroker
 * 
 * Creates AuthBroker instances based on YAML configuration
 */

import { AuthBroker } from '../../AuthBroker';
import { IServiceKeyStore, ISessionStore } from '../../stores/interfaces';
import { ITokenProvider } from '../../providers';
import { Logger } from '../../utils/logger';
import { loadTestConfig, getServiceKeysDir, getSessionsDir } from './configHelpers';
import * as path from 'path';
import * as os from 'os';

/**
 * Resolve path, expanding ~ to home directory
 */
function resolvePath(dirPath: string): string {
  if (dirPath.startsWith('~')) {
    return path.join(os.homedir(), dirPath.slice(1));
  }
  return path.resolve(dirPath);
}

/**
 * Test helper class for creating AuthBroker instances from YAML configuration
 */
export class AuthBrokerTestHelper {
  /**
   * Create AuthBroker with stores and provider from YAML configuration
   * Uses auth_broker.paths.service_keys_dir and auth_broker.paths.sessions_dir
   */
  static createBrokerFromYaml(
    serviceKeyStore: IServiceKeyStore,
    sessionStore: ISessionStore,
    tokenProvider: ITokenProvider,
    options?: { browser?: string; logger?: Logger }
  ): AuthBroker {
    return new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      options?.browser, // Use provided browser or default from AuthBroker (system)
      options?.logger
    );
  }

  /**
   * Create AuthBroker with ABAP stores from YAML paths
   */
  static createAbapBrokerFromYaml(
    options?: { browser?: string; logger?: Logger }
  ): AuthBroker {
    const config = loadTestConfig();
    const serviceKeysDir = getServiceKeysDir(config);
    const sessionsDir = getSessionsDir(config);
    
    if (!serviceKeysDir || !sessionsDir) {
      throw new Error(
        'Service keys and sessions directories must be configured in tests/test-config.yaml\n' +
        'Please set auth_broker.paths.service_keys_dir and auth_broker.paths.sessions_dir'
      );
    }

    const { AbapServiceKeyStore, AbapSessionStore } = require('../../stores');
    const { BtpTokenProvider } = require('../../providers');

    return this.createBrokerFromYaml(
      new AbapServiceKeyStore([resolvePath(serviceKeysDir)]),
      new AbapSessionStore([resolvePath(sessionsDir)]),
      new BtpTokenProvider(),
      options
    );
  }

  /**
   * Create AuthBroker with XSUAA stores from YAML paths
   */
  static createXsuaaBrokerFromYaml(
    options?: { browser?: string; logger?: Logger }
  ): AuthBroker {
    const config = loadTestConfig();
    const serviceKeysDir = getServiceKeysDir(config);
    const sessionsDir = getSessionsDir(config);
    
    if (!serviceKeysDir || !sessionsDir) {
      throw new Error(
        'Service keys and sessions directories must be configured in tests/test-config.yaml\n' +
        'Please set auth_broker.paths.service_keys_dir and auth_broker.paths.sessions_dir'
      );
    }

    const { XsuaaServiceKeyStore, XsuaaSessionStore } = require('../../stores');
    const { XsuaaTokenProvider } = require('../../providers');

    return this.createBrokerFromYaml(
      new XsuaaServiceKeyStore([resolvePath(serviceKeysDir)]),
      new XsuaaSessionStore([resolvePath(sessionsDir)]),
      new XsuaaTokenProvider(),
      options
    );
  }

  /**
   * Create AuthBroker with BTP stores from YAML paths
   */
  static createBtpBrokerFromYaml(
    options?: { browser?: string; logger?: Logger }
  ): AuthBroker {
    const config = loadTestConfig();
    const serviceKeysDir = getServiceKeysDir(config);
    const sessionsDir = getSessionsDir(config);
    
    if (!serviceKeysDir || !sessionsDir) {
      throw new Error(
        'Service keys and sessions directories must be configured in tests/test-config.yaml\n' +
        'Please set auth_broker.paths.service_keys_dir and auth_broker.paths.sessions_dir'
      );
    }

    const { AbapServiceKeyStore, BtpSessionStore } = require('../../stores');
    const { BtpTokenProvider } = require('../../providers');

    return this.createBrokerFromYaml(
      new AbapServiceKeyStore([resolvePath(serviceKeysDir)]),
      new BtpSessionStore([resolvePath(sessionsDir)]),
      new BtpTokenProvider(),
      options
    );
  }
}

