/**
 * Safe XSUAA Session Store - in-memory session storage for XSUAA service connections
 * 
 * Stores simplified XSUAA configuration (XsuaaSessionConfig) in memory only.
 * Does not persist to disk - suitable for secure environments.
 * This is separate from SafeAbapSessionStore for type safety.
 */

import { IConnectionConfig, ISessionStore, IAuthorizationConfig } from '../interfaces';
import { AbstractSafeSessionStore } from '../AbstractSafeSessionStore';

// Internal type for XSUAA session storage
interface XsuaaSessionData {
  mcpUrl?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
}

/**
 * Safe XSUAA Session store implementation
 * 
 * Stores session data in memory only (no file I/O).
 * Suitable for secure environments where tokens should not be persisted to disk.
 */
export class SafeXsuaaSessionStore extends AbstractSafeSessionStore implements ISessionStore {
  protected validateSessionConfig(config: unknown): void {
    if (!config || typeof config !== 'object') {
      throw new Error('SafeXsuaaSessionStore can only store XSUAA sessions');
    }
    const obj = config as Record<string, unknown>;
    
    // Reject ABAP sessions (has sapUrl)
    if ('sapUrl' in obj) {
      throw new Error('SafeXsuaaSessionStore can only store XSUAA sessions');
    }
    
    // Reject BTP sessions (has abapUrl)
    if ('abapUrl' in obj) {
      throw new Error('SafeXsuaaSessionStore can only store XSUAA sessions');
    }
    
    // Accept IConfig format (has authorizationToken) or internal format (has jwtToken)
    if (!obj.authorizationToken && !obj.jwtToken) {
      throw new Error('XSUAA session config missing required field: authorizationToken or jwtToken');
    }
  }

  protected convertToInternalFormat(config: unknown): unknown {
    if (!config || typeof config !== 'object') {
      return config;
    }
    const obj = config as Record<string, unknown>;
    // Convert IConfig format (serviceUrl, authorizationToken) to internal format (mcpUrl, jwtToken)
    const internal: XsuaaSessionData = {
      mcpUrl: obj.serviceUrl as string | undefined,
      jwtToken: (obj.authorizationToken || obj.jwtToken) as string,
      refreshToken: obj.refreshToken as string | undefined,
      uaaUrl: obj.uaaUrl as string | undefined,
      uaaClientId: obj.uaaClientId as string | undefined,
      uaaClientSecret: obj.uaaClientSecret as string | undefined,
    };
    return internal;
  }

  protected isValidSessionConfig(config: unknown): config is XsuaaSessionData {
    if (!config || typeof config !== 'object') return false;
    const obj = config as Record<string, unknown>;
    // Accept both IConfig format (authorizationToken) and internal format (jwtToken)
    // Reject ABAP (sapUrl) and BTP (abapUrl)
    return (('authorizationToken' in obj || 'jwtToken' in obj) && !('sapUrl' in obj) && !('abapUrl' in obj));
  }

  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    const sessionConfig = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(sessionConfig)) {
      return null;
    }

    if (!sessionConfig.jwtToken) {
      return null;
    }

    return {
      serviceUrl: sessionConfig.mcpUrl, // May be undefined for XSUAA
      authorizationToken: sessionConfig.jwtToken,
    };
  }

  async setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void> {
    const current = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(current)) {
      throw new Error(`No XSUAA session found for destination "${destination}"`);
    }
    const updated: XsuaaSessionData = {
      ...current,
      mcpUrl: config.serviceUrl !== undefined ? config.serviceUrl : current.mcpUrl,
      jwtToken: config.authorizationToken,
    };
    await this.saveSession(destination, updated);
  }

  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    const sessionConfig = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(sessionConfig)) {
      return null;
    }

    if (!sessionConfig.uaaUrl || !sessionConfig.uaaClientId || !sessionConfig.uaaClientSecret) {
      return null;
    }

    return {
      uaaUrl: sessionConfig.uaaUrl,
      uaaClientId: sessionConfig.uaaClientId,
      uaaClientSecret: sessionConfig.uaaClientSecret,
      refreshToken: sessionConfig.refreshToken,
    };
  }

  async setAuthorizationConfig(destination: string, config: IAuthorizationConfig): Promise<void> {
    const current = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(current)) {
      throw new Error(`No XSUAA session found for destination "${destination}"`);
    }

    const updated: XsuaaSessionData = {
      ...current,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
      refreshToken: config.refreshToken || current.refreshToken,
    };
    await this.saveSession(destination, updated);
  }
}

