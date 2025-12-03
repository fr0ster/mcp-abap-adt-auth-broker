/**
 * In-memory implementation of SessionStore
 * 
 * @deprecated Use SafeAbapSessionStore, SafeXsuaaSessionStore, or SafeBtpSessionStore instead.
 * This class is kept for backward compatibility but does not implement all ISessionStore methods.
 * 
 * Stores session data in memory (Map). Data is lost after application restart.
 * This is a secure implementation that doesn't persist sensitive data to disk.
 */

import { ISessionStore, IAuthorizationConfig, IConnectionConfig } from '../interfaces';
import { IConfig } from '../../types';

// Internal type for ABAP session storage
interface AbapSessionData {
  sapUrl: string;
  sapClient?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
  language?: string;
}

/**
 * In-memory session store implementation
 * 
 * @deprecated Use SafeAbapSessionStore instead for type safety.
 * 
 * Stores session data in a Map. All data is lost when the application restarts.
 * This is the default secure implementation that doesn't write sensitive data to files.
 */
export class SafeSessionStore implements ISessionStore {
  private sessions: Map<string, unknown> = new Map();

  /**
   * Load session configuration for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * @param destination Destination name (e.g., "TRIAL")
   * @returns IConfig with actual values or null if not found
   */
  async loadSession(destination: string): Promise<IConfig | null> {
    const authConfig = await this.getAuthorizationConfig(destination);
    const connConfig = await this.getConnectionConfig(destination);
    
    // Return null if both are null, otherwise return composition (even if one is null)
    if (!authConfig && !connConfig) {
      return null;
    }
    
    return {
      ...(authConfig || {}),
      ...(connConfig || {}),
    };
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @param config Session configuration to save
   */
  async saveSession(destination: string, config: unknown): Promise<void> {
    this.sessions.set(destination, config);
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL")
   */
  async deleteSession(destination: string): Promise<void> {
    this.sessions.delete(destination);
  }

  /**
   * Get authorization configuration with actual values (not file paths)
   * Returns values needed for obtaining and refreshing tokens
   * @param destination Destination name
   * @returns IAuthorizationConfig with actual values or null if not found
   */
  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    const sessionConfig = await this.loadSession(destination);
    if (!sessionConfig || typeof sessionConfig !== 'object') {
      return null;
    }
    const config = sessionConfig as Record<string, unknown>;
    if (!config.uaaUrl || !config.uaaClientId || !config.uaaClientSecret) {
      return null;
    }
    return {
      uaaUrl: config.uaaUrl as string,
      uaaClientId: config.uaaClientId as string,
      uaaClientSecret: config.uaaClientSecret as string,
      refreshToken: config.refreshToken as string | undefined,
    };
  }

  /**
   * Get connection configuration with actual values (not file paths)
   * Returns values needed for connecting to services
   * @param destination Destination name
   * @returns IConnectionConfig with actual values or null if not found
   */
  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    const sessionConfig = await this.loadSession(destination);
    if (!sessionConfig || typeof sessionConfig !== 'object') {
      return null;
    }
    const config = sessionConfig as Record<string, unknown>;
    if (!config.jwtToken) {
      return null;
    }
    let serviceUrl: string | undefined;
    if ('sapUrl' in config) {
      serviceUrl = config.sapUrl as string;
    } else if ('abapUrl' in config) {
      serviceUrl = config.abapUrl as string;
    } else if ('mcpUrl' in config) {
      serviceUrl = config.mcpUrl as string;
    }
    return {
      serviceUrl,
      authorizationToken: config.jwtToken as string,
      sapClient: config.sapClient as string | undefined,
      language: config.language as string | undefined,
    };
  }

  /**
   * Set authorization configuration
   * Updates values needed for obtaining and refreshing tokens
   * @param destination Destination name
   * @param config IAuthorizationConfig with values to set
   */
  async setAuthorizationConfig(destination: string, config: IAuthorizationConfig): Promise<void> {
    const current = await this.loadSession(destination);
    if (!current || typeof current !== 'object') {
      throw new Error(`No session found for destination "${destination}"`);
    }
    const currentObj = current as Record<string, unknown>;
    const updated = {
      ...currentObj,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
      refreshToken: config.refreshToken || currentObj.refreshToken,
    };
    await this.saveSession(destination, updated);
  }

  /**
   * Set connection configuration
   * Updates values needed for connecting to services
   * @param destination Destination name
   * @param config IConnectionConfig with values to set
   */
  async setConnectionConfig(destination: string, config: IConnectionConfig): Promise<void> {
    const current = await this.loadSession(destination);
    if (!current || typeof current !== 'object') {
      throw new Error(`No session found for destination "${destination}"`);
    }
    const currentObj = current as Record<string, unknown>;
    const updated: Record<string, unknown> = { ...current };
    if ('sapUrl' in currentObj) {
      updated.sapUrl = config.serviceUrl || currentObj.sapUrl;
      updated.jwtToken = config.authorizationToken;
      if (config.sapClient !== undefined) updated.sapClient = config.sapClient;
      if (config.language !== undefined) updated.language = config.language;
    } else if ('abapUrl' in currentObj) {
      updated.abapUrl = config.serviceUrl || currentObj.abapUrl;
      updated.jwtToken = config.authorizationToken;
      if (config.sapClient !== undefined) updated.sapClient = config.sapClient;
      if (config.language !== undefined) updated.language = config.language;
    } else {
      if (config.serviceUrl !== undefined) updated.mcpUrl = config.serviceUrl;
      updated.jwtToken = config.authorizationToken;
    }
    await this.saveSession(destination, updated);
  }
}

