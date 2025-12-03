/**
 * BTP Token storage - saves tokens to .env files with BTP_* variables for BTP authentication to ABAP
 */

import * as fs from 'fs';
import * as path from 'path';
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
 * Save BTP token to {destination}.env file using BTP_* variables
 * @param destination Destination name
 * @param savePath Path where to save the file
 * @param config BTP session configuration to save
 */
export async function saveBtpTokenToEnv(
  destination: string,
  savePath: string,
  config: BtpSessionConfig
): Promise<void> {
  // Ensure directory exists
  if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
  }

  const envFilePath = path.join(savePath, `${destination}.env`);
  const tempFilePath = `${envFilePath}.tmp`;

  // Read existing .env file if it exists
  let existingContent = '';
  if (fs.existsSync(envFilePath)) {
    existingContent = fs.readFileSync(envFilePath, 'utf8');
  }

  // Parse existing content to preserve other values
  const lines = existingContent.split('\n');
  const existingVars = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      // Skip old SAP_* and XSUAA_* variables for BTP (we use BTP_* now)
      if (key.startsWith('SAP_') || key.startsWith('XSUAA_')) {
        continue; // Don't preserve old variables
      }
      const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
      existingVars.set(key, value);
    }
  }

  // Update with new values (BTP_* variables)
  existingVars.set(BTP_CONNECTION_VARS.SERVICE_URL, config.abapUrl);
  existingVars.set(BTP_CONNECTION_VARS.AUTHORIZATION_TOKEN, config.jwtToken);

  if (config.refreshToken) {
    existingVars.set(BTP_AUTHORIZATION_VARS.REFRESH_TOKEN, config.refreshToken);
  }

  existingVars.set(BTP_AUTHORIZATION_VARS.UAA_URL, config.uaaUrl);
  existingVars.set(BTP_AUTHORIZATION_VARS.UAA_CLIENT_ID, config.uaaClientId);
  existingVars.set(BTP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET, config.uaaClientSecret);

  if (config.sapClient) {
    existingVars.set(BTP_CONNECTION_VARS.SAP_CLIENT, config.sapClient);
  }

  if (config.language) {
    existingVars.set(BTP_CONNECTION_VARS.SAP_LANGUAGE, config.language);
  }

  // Write to temporary file first (atomic write)
  const envLines: string[] = [];
  for (const [key, value] of existingVars.entries()) {
    // Escape value if it contains spaces or special characters
    const escapedValue = value.includes(' ') || value.includes('=') || value.includes('#')
      ? `"${value.replace(/"/g, '\\"')}"`
      : value;
    envLines.push(`${key}=${escapedValue}`);
  }

  const envContent = envLines.join('\n') + '\n';

  // Write to temp file
  fs.writeFileSync(tempFilePath, envContent, 'utf8');

  // Atomic rename
  fs.renameSync(tempFilePath, envFilePath);
}

