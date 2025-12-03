/**
 * BTP Environment file loader - loads .env files with BTP_* variables for XSUAA
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { BtpSessionConfig } from './types';
import { findFileInPaths } from './pathResolver';

/**
 * Load BTP environment configuration from {destination}.env file
 * Reads BTP_* variables instead of SAP_* variables
 * @param destination Destination name
 * @param searchPaths Array of paths to search for the file
 * @returns BtpSessionConfig object or null if file not found
 */
export async function loadBtpEnvFile(destination: string, searchPaths: string[]): Promise<BtpSessionConfig | null> {
  const fileName = `${destination}.env`;
  const envFilePath = findFileInPaths(fileName, searchPaths);

  if (!envFilePath) {
    return null;
  }

  try {
    // Read and parse .env file
    const envContent = fs.readFileSync(envFilePath, 'utf8');
    const parsed = dotenv.parse(envContent);

    // Extract required fields (BTP_* variables)
    const jwtToken = parsed.BTP_JWT_TOKEN;

    if (!jwtToken) {
      return null;
    }

    const config: BtpSessionConfig = {
      jwtToken: jwtToken.trim(),
    };

    // Optional fields
    if (parsed.BTP_URL || parsed.BTP_MCP_URL) {
      config.mcpUrl = (parsed.BTP_URL || parsed.BTP_MCP_URL)?.trim();
    }

    if (parsed.BTP_REFRESH_TOKEN) {
      config.refreshToken = parsed.BTP_REFRESH_TOKEN.trim();
    }

    if (parsed.BTP_UAA_URL) {
      config.uaaUrl = parsed.BTP_UAA_URL.trim();
    }

    if (parsed.BTP_UAA_CLIENT_ID) {
      config.uaaClientId = parsed.BTP_UAA_CLIENT_ID.trim();
    }

    if (parsed.BTP_UAA_CLIENT_SECRET) {
      config.uaaClientSecret = parsed.BTP_UAA_CLIENT_SECRET.trim();
    }

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load BTP environment file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

