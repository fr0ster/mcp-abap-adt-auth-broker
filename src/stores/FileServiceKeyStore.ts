/**
 * File-based implementation of ServiceKeyStore
 * 
 * Reads service keys from {destination}.json files in search paths.
 */

import { ServiceKeyStore } from './interfaces';
import { ServiceKey } from '../types';
import { loadServiceKey } from '../serviceKeyLoader';
import { resolveSearchPaths } from '../pathResolver';

/**
 * File-based service key store implementation
 * 
 * Searches for {destination}.json files in configured search paths.
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class FileServiceKeyStore implements ServiceKeyStore {
  private searchPaths: string[];

  /**
   * Create a new FileServiceKeyStore instance
   * @param searchPaths Optional search paths for .json files.
   *                    Can be a single path (string) or array of paths.
   *                    If not provided, uses AUTH_BROKER_PATH env var or current working directory.
   */
  constructor(searchPaths?: string | string[]) {
    this.searchPaths = resolveSearchPaths(searchPaths);
  }

  /**
   * Get service key for destination
   * @param destination Destination name (e.g., "TRIAL")
   * @returns ServiceKey object or null if not found
   */
  async getServiceKey(destination: string): Promise<ServiceKey | null> {
    return loadServiceKey(destination, this.searchPaths);
  }

  /**
   * Get search paths (for error messages)
   * @returns Array of search paths
   */
  getSearchPaths(): string[] {
    return [...this.searchPaths];
  }
}

