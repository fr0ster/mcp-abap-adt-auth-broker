/**
 * Token storage - saves tokens to .env files
 */

import * as fs from 'fs';
import * as path from 'path';
// Internal type for ABAP environment configuration (same as in envLoader.ts)
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
import { ABAP_AUTHORIZATION_VARS, ABAP_CONNECTION_VARS } from '../../utils/constants';

/**
 * Save token to {destination}.env file
 * @param destination Destination name
 * @param savePath Path where to save the file
 * @param config Configuration to save
 */
export async function saveTokenToEnv(
  destination: string,
  savePath: string,
  config: Partial<EnvConfig> & { sapUrl?: string; jwtToken: string }
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
      const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
      existingVars.set(key, value);
    }
  }

  // Update with new values
  // sapUrl is optional (for XSUAA, it's not part of authentication)
  if (config.sapUrl) {
    existingVars.set(ABAP_CONNECTION_VARS.SERVICE_URL, config.sapUrl);
  }
  existingVars.set(ABAP_CONNECTION_VARS.AUTHORIZATION_TOKEN, config.jwtToken);

  if (config.sapClient) {
    existingVars.set(ABAP_CONNECTION_VARS.SAP_CLIENT, config.sapClient);
  }

  if (config.refreshToken) {
    existingVars.set(ABAP_AUTHORIZATION_VARS.REFRESH_TOKEN, config.refreshToken);
  }

  if (config.uaaUrl) {
    existingVars.set(ABAP_AUTHORIZATION_VARS.UAA_URL, config.uaaUrl);
  }

  if (config.uaaClientId) {
    existingVars.set(ABAP_AUTHORIZATION_VARS.UAA_CLIENT_ID, config.uaaClientId);
  }

  if (config.uaaClientSecret) {
    existingVars.set(ABAP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET, config.uaaClientSecret);
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

