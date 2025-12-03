/**
 * XSUAA Service key loader - loads XSUAA service key JSON files by destination name
 * 
 * @deprecated Use loadServiceKey() with XsuaaServiceKeyParser instead.
 * This function is kept for backward compatibility.
 * 
 * Supports direct XSUAA service key format from BTP (without nested uaa object):
 * {
 *   "url": "https://...authentication...hana.ondemand.com",
 *   "clientid": "...",
 *   "clientsecret": "...",
 *   ...
 * }
 */

import { findFileInPaths } from '../../utils/pathResolver';
import { XsuaaServiceKeyParser } from '../../parsers';
import * as fs from 'fs';

/**
 * Load XSUAA service key from {destination}.json file
 * Normalizes direct XSUAA format to standard ServiceKey format
 * @param destination Destination name
 * @param searchPaths Array of paths to search for the file
 * @returns Service key object or null if file not found
 * @deprecated Use loadServiceKey() instead, which automatically detects format
 */
export async function loadXSUAAServiceKey(destination: string, searchPaths: string[]): Promise<unknown | null> {
  const fileName = `${destination}.json`;
  const serviceKeyPath = findFileInPaths(fileName, searchPaths);

  if (!serviceKeyPath) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(serviceKeyPath, 'utf8');
    const rawData = JSON.parse(fileContent);

    // Use XSUAA parser
    const parser = new XsuaaServiceKeyParser();
    if (!parser.canParse(rawData)) {
      return null; // Not an XSUAA format
    }

    return parser.parse(rawData);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON in XSUAA service key file for destination "${destination}": ${error.message}`
      );
    }
    throw new Error(
      `Failed to load XSUAA service key for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

