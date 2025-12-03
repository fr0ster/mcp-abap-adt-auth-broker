/**
 * Abstract Service Key Store - base class for service key stores
 * 
 * Provides common functionality for file-based service key stores.
 * Subclasses implement format-specific parsing logic.
 */

import { IServiceKeyStore } from './interfaces';
import { ServiceKey } from '../types';
import { findFileInPaths } from '../pathResolver';
import { resolveSearchPaths } from '../pathResolver';
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
   * Parse raw JSON data into ServiceKey format
   * Must be implemented by subclasses
   * @param rawData Raw JSON data from service key file
   * @returns Parsed ServiceKey object
   * @throws Error if data cannot be parsed or is invalid
   */
  protected abstract parse(rawData: any): ServiceKey;

  /**
   * Get service key for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns ServiceKey object or null if not found
   */
  async getServiceKey(destination: string): Promise<ServiceKey | null> {
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
   * Get search paths (for error messages)
   * @returns Array of search paths
   */
  getSearchPaths(): string[] {
    return [...this.searchPaths];
  }
}

