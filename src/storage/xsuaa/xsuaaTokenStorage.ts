/**
 * XSUAA Token storage - saves tokens to .env files with XSUAA_* variables
 */

import * as fs from 'fs';
import * as path from 'path';
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
 * Save XSUAA token to {destination}.env file using XSUAA_* variables
 * @param destination Destination name
 * @param savePath Path where to save the file
 * @param config XSUAA session configuration to save
 */
export async function saveXsuaaTokenToEnv(
  destination: string,
  savePath: string,
  config: XsuaaSessionConfig
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
  // Remove old SAP_* variables for XSUAA (use XSUAA_* instead)
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
      // Skip old SAP_* variables for XSUAA (we use XSUAA_* now)
      if (key.startsWith('SAP_') && (key === 'SAP_URL' || key === 'SAP_JWT_TOKEN' || key === 'SAP_REFRESH_TOKEN' || 
          key === 'SAP_UAA_URL' || key === 'SAP_UAA_CLIENT_ID' || key === 'SAP_UAA_CLIENT_SECRET')) {
        continue; // Don't preserve old SAP_* variables
      }
      const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
      existingVars.set(key, value);
    }
  }

  // Update with new values (XSUAA_* variables)
  // mcpUrl can be saved as additional variable (not part of CONNECTION_VARS, but can be stored for convenience)
  // URL comes from elsewhere (YAML config, parameter, or request header), but can be stored in .env
  if (config.mcpUrl) {
    existingVars.set('XSUAA_MCP_URL', config.mcpUrl); // Store as additional variable (not in CONNECTION_VARS)
  }

  existingVars.set(XSUAA_CONNECTION_VARS.AUTHORIZATION_TOKEN, config.jwtToken);

  if (config.refreshToken) {
    existingVars.set(XSUAA_AUTHORIZATION_VARS.REFRESH_TOKEN, config.refreshToken);
  }

  if (config.uaaUrl) {
    existingVars.set(XSUAA_AUTHORIZATION_VARS.UAA_URL, config.uaaUrl);
  }

  if (config.uaaClientId) {
    existingVars.set(XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_ID, config.uaaClientId);
  }

  if (config.uaaClientSecret) {
    existingVars.set(XSUAA_AUTHORIZATION_VARS.UAA_CLIENT_SECRET, config.uaaClientSecret);
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

