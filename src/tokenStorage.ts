/**
 * Token storage - saves tokens to .env files
 */

import * as fs from 'fs';
import * as path from 'path';
import { EnvConfig } from './types';

/**
 * Save token to {destination}.env file
 * @param destination Destination name
 * @param savePath Path where to save the file
 * @param config Configuration to save
 */
export async function saveTokenToEnv(
  destination: string,
  savePath: string,
  config: Partial<EnvConfig> & { sapUrl: string; jwtToken: string }
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
  existingVars.set('SAP_URL', config.sapUrl);
  existingVars.set('SAP_JWT_TOKEN', config.jwtToken);

  if (config.sapClient) {
    existingVars.set('SAP_CLIENT', config.sapClient);
  }

  if (config.refreshToken) {
    existingVars.set('SAP_REFRESH_TOKEN', config.refreshToken);
  }

  if (config.uaaUrl) {
    existingVars.set('SAP_UAA_URL', config.uaaUrl);
  }

  if (config.uaaClientId) {
    existingVars.set('SAP_UAA_CLIENT_ID', config.uaaClientId);
  }

  if (config.uaaClientSecret) {
    existingVars.set('SAP_UAA_CLIENT_SECRET', config.uaaClientSecret);
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

