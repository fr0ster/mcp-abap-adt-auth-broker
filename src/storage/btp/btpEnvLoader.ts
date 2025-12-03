/**
 * BTP Environment file loader - loads .env files with BTP_* variables for BTP authentication to ABAP
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { findFileInPaths } from '../../utils/pathResolver';
import { BTP_AUTHORIZATION_VARS, BTP_CONNECTION_VARS } from '../../utils/constants';

// Internal type for BTP session storage
interface BtpSessionConfig {
  abapUrl: string;
  sapClient?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl: string;
  uaaClientId: string;
  uaaClientSecret: string;
  language?: string;
}

/**
 * Load BTP environment configuration from {destination}.env file
 * Reads BTP_* variables for BTP authentication to ABAP systems
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
    const jwtToken = parsed[BTP_CONNECTION_VARS.AUTHORIZATION_TOKEN];
    const abapUrl = parsed[BTP_CONNECTION_VARS.SERVICE_URL];
    const uaaUrl = parsed[BTP_AUTHORIZATION_VARS.UAA_URL];
    const uaaClientId = parsed[BTP_AUTHORIZATION_VARS.UAA_CLIENT_ID];
    const uaaClientSecret = parsed[BTP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET];

    if (!jwtToken || !abapUrl || !uaaUrl || !uaaClientId || !uaaClientSecret) {
      return null;
    }

    const config: BtpSessionConfig = {
      abapUrl: abapUrl.trim(),
      jwtToken: jwtToken.trim(),
      uaaUrl: uaaUrl.trim(),
      uaaClientId: uaaClientId.trim(),
      uaaClientSecret: uaaClientSecret.trim(),
    };

    // Optional fields
    if (parsed[BTP_AUTHORIZATION_VARS.REFRESH_TOKEN]) {
      config.refreshToken = parsed[BTP_AUTHORIZATION_VARS.REFRESH_TOKEN].trim();
    }

    if (parsed[BTP_CONNECTION_VARS.SAP_CLIENT]) {
      config.sapClient = parsed[BTP_CONNECTION_VARS.SAP_CLIENT].trim();
    }

    if (parsed[BTP_CONNECTION_VARS.SAP_LANGUAGE]) {
      config.language = parsed[BTP_CONNECTION_VARS.SAP_LANGUAGE].trim();
    }

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load BTP environment file for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

