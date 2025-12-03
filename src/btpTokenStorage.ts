/**
 * BTP Token storage - saves tokens to .env files with BTP_* variables
 */

import * as fs from 'fs';
import * as path from 'path';
import { BtpSessionConfig } from './types';

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
  // Remove old SAP_* variables for XSUAA (use BTP_* instead)
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
      // Skip old SAP_* variables for XSUAA (we use BTP_* now)
      if (key.startsWith('SAP_') && (key === 'SAP_URL' || key === 'SAP_JWT_TOKEN' || key === 'SAP_REFRESH_TOKEN' || 
          key === 'SAP_UAA_URL' || key === 'SAP_UAA_CLIENT_ID' || key === 'SAP_UAA_CLIENT_SECRET')) {
        continue; // Don't preserve old SAP_* variables
      }
      const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
      existingVars.set(key, value);
    }
  }

  // Update with new values (BTP_* variables)
  // mcpUrl is optional (for XSUAA, it's not part of authentication)
  if (config.mcpUrl) {
    existingVars.set('BTP_URL', config.mcpUrl);
    // Also support BTP_MCP_URL for clarity
    existingVars.set('BTP_MCP_URL', config.mcpUrl);
  }

  existingVars.set('BTP_JWT_TOKEN', config.jwtToken);

  if (config.refreshToken) {
    existingVars.set('BTP_REFRESH_TOKEN', config.refreshToken);
  }

  if (config.uaaUrl) {
    existingVars.set('BTP_UAA_URL', config.uaaUrl);
  }

  if (config.uaaClientId) {
    existingVars.set('BTP_UAA_CLIENT_ID', config.uaaClientId);
  }

  if (config.uaaClientSecret) {
    existingVars.set('BTP_UAA_CLIENT_SECRET', config.uaaClientSecret);
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

