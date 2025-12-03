/**
 * Environment file loader - loads .env files by destination name
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { findFileInPaths } from '../../utils/pathResolver';
import { ABAP_AUTHORIZATION_VARS, ABAP_CONNECTION_VARS } from '../../utils/constants';

// Internal type for ABAP environment configuration
interface EnvConfig {
  sapUrl: string;
  sapClient?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
  language?: string;
}

/**
 * Load environment configuration from {destination}.env file
 * @param destination Destination name
 * @param searchPaths Array of paths to search for the file
 * @returns EnvConfig object or null if file not found
 */
export async function loadEnvFile(destination: string, searchPaths: string[]): Promise<EnvConfig | null> {
  const fileName = `${destination}.env`;
  const envFilePath = findFileInPaths(fileName, searchPaths);

  if (!envFilePath) {
    return null;
  }

  try {
    // Read and parse .env file
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    const parsed = dotenv.parse(envContent);

    // Extract required fields
    const sapUrl = parsed[ABAP_CONNECTION_VARS.SERVICE_URL];
    const jwtToken = parsed[ABAP_CONNECTION_VARS.AUTHORIZATION_TOKEN];

    if (!sapUrl || !jwtToken) {
      return null;
    }

    const config: EnvConfig = {
      sapUrl: sapUrl.trim(),
      jwtToken: jwtToken.trim(),
    };

    // Optional fields
    if (parsed[ABAP_CONNECTION_VARS.SAP_CLIENT]) {
      config.sapClient = parsed[ABAP_CONNECTION_VARS.SAP_CLIENT].trim();
    }

    if (parsed[ABAP_AUTHORIZATION_VARS.REFRESH_TOKEN]) {
      config.refreshToken = parsed[ABAP_AUTHORIZATION_VARS.REFRESH_TOKEN].trim();
    }

    if (parsed[ABAP_AUTHORIZATION_VARS.UAA_URL]) {
      config.uaaUrl = parsed[ABAP_AUTHORIZATION_VARS.UAA_URL].trim();
    }

    if (parsed[ABAP_AUTHORIZATION_VARS.UAA_CLIENT_ID]) {
      config.uaaClientId = parsed[ABAP_AUTHORIZATION_VARS.UAA_CLIENT_ID].trim();
    }

    if (parsed[ABAP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET]) {
      config.uaaClientSecret = parsed[ABAP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET].trim();
    }

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load environment file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

