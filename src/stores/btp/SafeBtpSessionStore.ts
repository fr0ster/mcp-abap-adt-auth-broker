/**
 * Safe BTP Session Store - in-memory session storage for BTP authentication to ABAP systems
 * 
 * Stores full BTP configuration (BtpSessionConfig) in memory only.
 * Does not persist to disk - suitable for secure environments.
 * This is separate from SafeAbapSessionStore and SafeXsuaaSessionStore for type safety.
 */

import { IConnectionConfig, ISessionStore, IAuthorizationConfig } from '../interfaces';
import { AbstractSafeSessionStore } from '../AbstractSafeSessionStore';

// Internal type for BTP session storage
interface BtpSessionData {
  abapUrl: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl: string;
  uaaClientId: string;
  uaaClientSecret: string;
  sapClient?: string;
  language?: string;
}

/**
 * Safe BTP Session store implementation
 * 
 * Stores session data in memory only (no file I/O).
 * Suitable for secure environments where tokens should not be persisted to disk.
 */
export class SafeBtpSessionStore extends AbstractSafeSessionStore implements ISessionStore {
  protected validateSessionConfig(config: unknown): void {
    if (!config || typeof config !== 'object') {
      throw new Error('SafeBtpSessionStore can only store BTP sessions');
    }
    
    const obj = config as Record<string, unknown>;
    
    // Accept IConfig format (has serviceUrl) or internal format (has abapUrl)
    const serviceUrl = obj.serviceUrl || obj.abapUrl;
    
    // Reject ABAP sessions (has sapUrl but no abapUrl/serviceUrl for BTP)
    if ('sapUrl' in obj && !serviceUrl) {
      throw new Error('SafeBtpSessionStore can only store BTP sessions');
    }
    
    // Reject XSUAA sessions (has mcpUrl but no abapUrl/serviceUrl)
    if ('mcpUrl' in obj && !serviceUrl) {
      throw new Error('SafeBtpSessionStore can only store BTP sessions');
    }
    
    // Ensure it has serviceUrl or abapUrl (required for BTP)
    if (!serviceUrl) {
      throw new Error('BTP session config missing required field: serviceUrl or abapUrl');
    }
    
    // Validate required fields (accept IConfig format)
    if (!obj.authorizationToken && !obj.jwtToken) {
      throw new Error('BTP session config missing required field: authorizationToken or jwtToken');
    }
    if (!obj.uaaUrl || !obj.uaaClientId || !obj.uaaClientSecret) {
      throw new Error('BTP session config missing required fields: uaaUrl, uaaClientId, uaaClientSecret');
    }
  }

  protected convertToInternalFormat(config: unknown): unknown {
    if (!config || typeof config !== 'object') {
      return config;
    }
    const obj = config as Record<string, unknown>;
    // Convert IConfig format (serviceUrl, authorizationToken) to internal format (abapUrl, jwtToken)
    const internal: BtpSessionData = {
      abapUrl: (obj.serviceUrl || obj.abapUrl) as string,
      jwtToken: (obj.authorizationToken || obj.jwtToken) as string,
      refreshToken: obj.refreshToken as string | undefined,
      uaaUrl: obj.uaaUrl as string,
      uaaClientId: obj.uaaClientId as string,
      uaaClientSecret: obj.uaaClientSecret as string,
      sapClient: obj.sapClient as string | undefined,
      language: obj.language as string | undefined,
    };
    return internal;
  }

  protected isValidSessionConfig(config: unknown): config is BtpSessionData {
    if (!config || typeof config !== 'object') return false;
    const obj = config as Record<string, unknown>;
    // Accept both IConfig format (serviceUrl, authorizationToken) and internal format (abapUrl, jwtToken)
    return (('serviceUrl' in obj || 'abapUrl' in obj) && ('authorizationToken' in obj || 'jwtToken' in obj));
  }

  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    const sessionConfig = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(sessionConfig)) {
      return null;
    }

    if (!sessionConfig.jwtToken || !sessionConfig.abapUrl) {
      return null;
    }

    return {
      serviceUrl: sessionConfig.abapUrl,
      authorizationToken: sessionConfig.jwtToken,
      sapClient: sessionConfig.sapClient,
      language: sessionConfig.language,
    };
  }

  async setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void> {
    const current = this.loadRawSession(destination);
    if (!this.isValidSessionConfig(current)) {
      throw new Error(`No BTP session found for destination "${destination}"`);
    }
    const updated: BtpSessionData = {
      ...current,
      abapUrl: config.serviceUrl || current.abapUrl,
      jwtToken: config.authorizationToken,
      sapClient: config.sapClient !== undefined ? config.sapClient : current.sapClient,
      language: config.language !== undefined ? config.language : current.language,
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
      throw new Error(`No BTP session found for destination "${destination}"`);
    }

    const updated: BtpSessionData = {
      ...current,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
      refreshToken: config.refreshToken || current.refreshToken,
    };
    await this.saveSession(destination, updated);
  }
}

