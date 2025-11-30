/**
 * Environment file loader - loads .env files by destination name
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { EnvConfig } from './types';
import { findFileInPaths } from './pathResolver';

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
    const sapUrl = parsed.SAP_URL;
    const jwtToken = parsed.SAP_JWT_TOKEN;

    if (!sapUrl || !jwtToken) {
      return null;
    }

    const config: EnvConfig = {
      sapUrl: sapUrl.trim(),
      jwtToken: jwtToken.trim(),
    };

    // Optional fields
    if (parsed.SAP_CLIENT) {
      config.sapClient = parsed.SAP_CLIENT.trim();
    }

    if (parsed.SAP_REFRESH_TOKEN) {
      config.refreshToken = parsed.SAP_REFRESH_TOKEN.trim();
    }

    if (parsed.SAP_UAA_URL) {
      config.uaaUrl = parsed.SAP_UAA_URL.trim();
    }

    if (parsed.SAP_UAA_CLIENT_ID) {
      config.uaaClientId = parsed.SAP_UAA_CLIENT_ID.trim();
    }

    if (parsed.SAP_UAA_CLIENT_SECRET) {
      config.uaaClientSecret = parsed.SAP_UAA_CLIENT_SECRET.trim();
    }

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load environment file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

