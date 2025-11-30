/**
 * Service key loader - loads service key JSON files by destination name
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServiceKey } from './types';
import { findFileInPaths } from './pathResolver';

/**
 * Load service key from {destination}.json file
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
    const serviceKey = JSON.parse(fileContent) as ServiceKey;

    // Validate service key structure
    if (!serviceKey.uaa) {
      throw new Error('Service key missing "uaa" object');
    }

    if (!serviceKey.uaa.url || !serviceKey.uaa.clientid || !serviceKey.uaa.clientsecret) {
      throw new Error('Service key "uaa" object missing required fields: url, clientid, clientsecret');
    }

    return serviceKey;
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

