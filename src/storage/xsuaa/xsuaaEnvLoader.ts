/**
 * XSUAA Environment file loader - loads .env files with XSUAA_* variables for XSUAA
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { findFileInPaths } from '../../utils/pathResolver';
import { XSUAA_AUTHORIZATION_VARS, XSUAA_CONNECTION_VARS } from '../../utils/constants';

// Internal type for XSUAA session storage
interface XsuaaSessionConfig {
  mcpUrl?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
}

/**
 * Load XSUAA environment configuration from {destination}.env file
 * Reads XSUAA_* variables instead of SAP_* variables
 * @param destination Destination name
 * @param searchPaths Array of paths to search for the file
 * @returns XsuaaSessionConfig object or null if file not found
 */
export async function loadXsuaaEnvFile(destination: string, searchPaths: string[]): Promise<XsuaaSessionConfig | null> {
  const fileName = `${destination}.env`;
  const envFilePath = findFileInPaths(fileName, searchPaths);

  if (!envFilePath) {
    return null;
  }

  try {
    // Read and parse .env file
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    const parsed = dotenv.parse(envContent);

    // Extract required fields (XSUAA_* variables)
    const jwtToken = parsed[XSUAA_CONNECTION_VARS.AUTHORIZATION_TOKEN];

    if (!jwtToken) {
      return null;
    }

    const config: XsuaaSessionConfig = {
      jwtToken: jwtToken.trim(),
    };

    // mcpUrl can be loaded from .env file as additional variable (not part of CONNECTION_VARS, but can be stored)
    // URL comes from elsewhere (YAML config, parameter, or request header), but can be stored in .env
    if (parsed['XSUAA_MCP_URL']) {
      config.mcpUrl = parsed['XSUAA_MCP_URL'].trim();
    }

    if (parsed[XSUAA_AUTHORIZATION_VARS.REFRESH_TOKEN]) {
      config.refreshToken = parsed[XSUAA_AUTHORIZATION_VARS.REFRESH_TOKEN].trim();
    }

    if (parsed[XSUAA_AUTHORIZATION_VARS.UAA_URL]) {
      config.uaaUrl = parsed[XSUAA_AUTHORIZATION_VARS.UAA_URL].trim();
    }

    if (parsed[XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_ID]) {
      config.uaaClientId = parsed[XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_ID].trim();
    }

    if (parsed[XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_SECRET]) {
      config.uaaClientSecret = parsed[XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_SECRET].trim();
    }

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load XSUAA environment file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

