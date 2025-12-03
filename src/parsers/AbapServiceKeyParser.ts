/**
 * ABAP Service Key Parser
 * 
 * Parses standard ABAP service key format with nested uaa object:
 * {
 *   "uaa": {
 *     "url": "...",
 *     "clientid": "...",
 *     "clientsecret": "..."
 *   },
 *   "abap": {
 *     "url": "...",
 *     "client": "..."
 *   },
 *   ...
 * }
 */

import { IServiceKeyParser } from './IServiceKeyParser';

/**
 * Parser for standard ABAP service key format
 */
export class AbapServiceKeyParser implements IServiceKeyParser {
  /**
   * Check if this parser can handle the given raw service key data
   * @param rawData Raw JSON data from service key file
   * @returns true if data has nested uaa object, false otherwise
   */
  canParse(rawData: any): boolean {
    return rawData && typeof rawData === 'object' && rawData.uaa && typeof rawData.uaa === 'object';
  }

  /**
   * Parse raw service key data
   * @param rawData Raw JSON data from service key file
   * @returns Parsed service key object
   * @throws Error if data cannot be parsed or is invalid
   */
  parse(rawData: any): unknown {
    if (!this.canParse(rawData)) {
      throw new Error('Service key does not match ABAP format (missing uaa object)');
    }

    // Validate UAA configuration
    if (!rawData.uaa.url || !rawData.uaa.clientid || !rawData.uaa.clientsecret) {
      throw new Error('Service key "uaa" object missing required fields: url, clientid, clientsecret');
    }

    return rawData;
  }
}

