/**
 * XSUAA Service Key Parser
 * 
 * Parses direct XSUAA service key format from BTP (without nested uaa object):
 * {
 *   "url": "https://...authentication...hana.ondemand.com",
 *   "clientid": "...",
 *   "clientsecret": "...",
 *   "tenantmode": "shared",
 *   ...
 * }
 */

import { ServiceKey } from '../types';
import { IServiceKeyParser } from './IServiceKeyParser';

/**
 * Parser for direct XSUAA service key format from BTP
 */
export class XsuaaServiceKeyParser implements IServiceKeyParser {
  /**
   * Check if this parser can handle the given raw service key data
   * @param rawData Raw JSON data from service key file
   * @returns true if data has direct XSUAA fields (url, clientid, clientsecret) without nested uaa object
   */
  canParse(rawData: any): boolean {
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      return false;
    }
    
    // Check for nested uaa object (ABAP format) - should not have it
    if (rawData.uaa) {
      return false;
    }
    
    // Check for required XSUAA fields at root level
    return (
      typeof rawData.url === 'string' &&
      typeof rawData.clientid === 'string' &&
      typeof rawData.clientsecret === 'string' &&
      rawData.url.length > 0 &&
      rawData.clientid.length > 0 &&
      rawData.clientsecret.length > 0
    );
  }

  /**
   * Parse raw service key data into standard ServiceKey format
   * @param rawData Raw JSON data from service key file
   * @returns Parsed ServiceKey object (normalized to standard format)
   * @throws Error if data cannot be parsed or is invalid
   */
  parse(rawData: any): ServiceKey {
    if (!this.canParse(rawData)) {
      throw new Error('Service key does not match XSUAA format (missing url, clientid, or clientsecret at root level)');
    }

    // Normalize to standard ServiceKey format
    const serviceKey: ServiceKey = {
      uaa: {
        url: rawData.url, // UAA URL for token endpoint
        clientid: rawData.clientid,
        clientsecret: rawData.clientsecret,
      },
      // Preserve abap.url if present
      abap: rawData.abap,
      // Preserve other optional fields
      url: rawData.url, // UAA URL
      sap_url: rawData.sap_url,
      client: rawData.client,
      sap_client: rawData.sap_client,
      language: rawData.language,
    };

    return serviceKey;
  }
}

