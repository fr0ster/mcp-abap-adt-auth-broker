/**
 * Interface for service key parsers
 * 
 * Different parsers handle different service key formats:
 * - AbapServiceKeyParser: Standard ABAP service key format with nested uaa object
 * - XsuaaServiceKeyParser: Direct XSUAA service key format from BTP
 */

import { ServiceKey } from '../types';

/**
 * Interface for parsing service keys from raw JSON data
 */
export interface IServiceKeyParser {
  /**
   * Check if this parser can handle the given raw service key data
   * @param rawData Raw JSON data from service key file
   * @returns true if this parser can handle the data, false otherwise
   */
  canParse(rawData: any): boolean;

  /**
   * Parse raw service key data into standard ServiceKey format
   * @param rawData Raw JSON data from service key file
   * @returns Parsed ServiceKey object
   * @throws Error if data cannot be parsed or is invalid
   */
  parse(rawData: any): ServiceKey;
}

