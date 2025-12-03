/**
 * ABAP Service key store - reads ABAP service keys from {destination}.json files
 * 
 * Uses AbstractServiceKeyStore for file I/O and AbapServiceKeyParser for parsing.
 * This is separate from XsuaaServiceKeyStore to maintain compatibility.
 */

import { IServiceKeyStore } from '../interfaces';
import { AbstractServiceKeyStore } from '../AbstractServiceKeyStore';
import { AbapServiceKeyParser } from '../../parsers/AbapServiceKeyParser';

/**
 * ABAP Service key store implementation
 * 
 * Uses AbstractServiceKeyStore for file operations and AbapServiceKeyParser for parsing.
 * Search paths priority:
 * 1. Constructor parameter (highest)
 * 2. AUTH_BROKER_PATH environment variable
 * 3. Current working directory (lowest)
 */
export class AbapServiceKeyStore extends AbstractServiceKeyStore implements IServiceKeyStore {
  private parser: AbapServiceKeyParser;

  /**
   * Create a new AbapServiceKeyStore instance
   * @param searchPaths Optional search paths for .json files.
   *                    Can be a single path (string) or array of paths.
   *                    If not provided, uses AUTH_BROKER_PATH env var or current working directory.
   */
  constructor(searchPaths?: string | string[]) {
    super(searchPaths);
    this.parser = new AbapServiceKeyParser();
  }

  /**
   * Parse raw JSON data using AbapServiceKeyParser
   * @param rawData Raw JSON data from service key file
   * @returns Parsed service key object
   * @throws Error if data cannot be parsed or is invalid
   */
  protected parse(rawData: any): unknown {
    return this.parser.parse(rawData);
  }
}

