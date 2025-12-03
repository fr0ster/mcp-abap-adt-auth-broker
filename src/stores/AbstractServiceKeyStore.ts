/**
 * Abstract Service Key Store - base class for service key stores
 * 
 * Provides common functionality for file-based service key stores.
 * Subclasses implement format-specific parsing logic.
 */

import { IServiceKeyStore, IAuthorizationConfig, IConnectionConfig } from './interfaces';
import { IConfig } from '../types';
import { findFileInPaths, resolveSearchPaths } from '../utils/pathResolver';
import * as fs from 'fs';

/**
 * Abstract base class for service key stores
 * 
 * Handles file I/O operations. Subclasses provide parsing logic.
 */
export abstract class AbstractServiceKeyStore implements IServiceKeyStore {
  protected searchPaths: string[];

  /**
   * Create a new AbstractServiceKeyStore instance
   * @param searchPaths Optional search paths for .json files.
   *                    Can be a single path (string) or array of paths.
   *                    If not provided, uses AUTH_BROKER_PATH env var or current working directory.
   */
  constructor(searchPaths?: string | string[]) {
    this.searchPaths = resolveSearchPaths(searchPaths);
  }

  /**
   * Load raw JSON data from file
   * @param destination Destination name
   * @returns Raw JSON data or null if file not found
   */
  protected async loadRawData(destination: string): Promise<any | null> {
    const fileName = `${destination}.json`;
    const serviceKeyPath = findFileInPaths(fileName, this.searchPaths);

    if (!serviceKeyPath) {
      return null;
    }

    try {
      const fileContent = fs.readFileSync(serviceKeyPath, 'utf8');
      return JSON.parse(fileContent);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid JSON in service key file for destination "${destination}": ${error.message}`
        );
      }
      throw new Error(
        `Failed to load service key file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse raw JSON data into service key format
   * Must be implemented by subclasses
   * @param rawData Raw JSON data from service key file
   * @returns Parsed service key object (implementation-specific)
   * @throws Error if data cannot be parsed or is invalid
   */
  protected abstract parse(rawData: unknown): unknown;

  /**
   * Get raw parsed service key (internal representation)
   * Used internally by getAuthorizationConfig and getConnectionConfig
   */
  private async getRawServiceKey(destination: string): Promise<unknown | null> {
    const rawData = await this.loadRawData(destination);
    if (!rawData) {
      return null;
    }

    try {
      return this.parse(rawData);
    } catch (error) {
      throw new Error(
        `Failed to parse service key for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get service key for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IConfig with actual values or null if not found
   */
  async getServiceKey(destination: string): Promise<IConfig | null> {
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
   * Get authorization configuration from service key
   * @param destination Destination name (e.g., "TRIAL")
   * @returns IAuthorizationConfig with actual values or null if not found
   */
  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    const serviceKey = await this.getRawServiceKey(destination);
    if (!serviceKey || typeof serviceKey !== 'object') {
      return null;
    }
    const key = serviceKey as { uaa?: { url?: string; clientid?: string; clientsecret?: string } };
    if (!key.uaa || !key.uaa.url || !key.uaa.clientid || !key.uaa.clientsecret) {
      return null;
    }
    return {
      uaaUrl: key.uaa.url,
      uaaClientId: key.uaa.clientid,
      uaaClientSecret: key.uaa.clientsecret,
    };
  }

  /**
   * Get connection configuration from service key
   * @param destination Destination name (e.g., "TRIAL")
   * @returns IConnectionConfig with actual values or null if not found
   */
  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    const serviceKey = await this.getRawServiceKey(destination);
    if (!serviceKey || typeof serviceKey !== 'object') {
      return null;
    }
    const key = serviceKey as {
      abap?: { url?: string; client?: string; language?: string };
      sap_url?: string;
      url?: string;
      sap_client?: string;
      client?: string;
      language?: string;
    };
    // Service key doesn't have tokens - only URLs and client info
    const serviceUrl = key.abap?.url || key.sap_url || (key.url && !key.url.includes('authentication') ? key.url : undefined);
    return {
      serviceUrl,
      authorizationToken: '', // Service key doesn't contain tokens
      sapClient: key.abap?.client || key.sap_client || key.client,
      language: key.abap?.language || key.language,
    };
  }

  /**
   * Get search paths (for error messages)
   * @returns Array of search paths
   */
  getSearchPaths(): string[] {
    return [...this.searchPaths];
  }
}

