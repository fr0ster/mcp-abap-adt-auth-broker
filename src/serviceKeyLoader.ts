/**
 * Service key loader - loads service key JSON files by destination name
 * 
 * Uses parsers to handle different service key formats:
 * - AbapServiceKeyParser: Standard ABAP service key format with nested uaa object
 * - XsuaaServiceKeyParser: Direct XSUAA service key format from BTP
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServiceKey } from './types';
import { findFileInPaths } from './pathResolver';
import { AbapServiceKeyParser, XsuaaServiceKeyParser, IServiceKeyParser } from './parsers';

/**
 * Load service key from {destination}.json file
 * Automatically detects format and uses appropriate parser
 * @param destination Destination name
 * @param searchPaths Array of paths to search for the file
 * @returns ServiceKey object or null if file not found
 */
export async function loadServiceKey(destination: string, searchPaths: string[]): Promise<ServiceKey | null> {
  const fileName = `${destination}.json`;
  const serviceKeyPath = findFileInPaths(fileName, searchPaths);

  if (!serviceKeyPath) {
    return null;
  }

  try {
    const fileContent = fs.readFileSync(serviceKeyPath, 'utf8');
    const rawData = JSON.parse(fileContent);

    // Try parsers in order: ABAP format first, then XSUAA format
    const parsers: IServiceKeyParser[] = [
      new AbapServiceKeyParser(),
      new XsuaaServiceKeyParser(),
    ];

    for (const parser of parsers) {
      if (parser.canParse(rawData)) {
        return parser.parse(rawData);
      }
    }

    // No parser could handle the data
    throw new Error(
      'Service key does not match any supported format. ' +
      'Expected either ABAP format (with nested uaa object) or XSUAA format (with url, clientid, clientsecret at root level)'
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON in service key file for destination "${destination}": ${error.message}`
      );
    }
    throw new Error(
      `Failed to load service key for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

