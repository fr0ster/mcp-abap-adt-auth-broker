/**
 * Refresh token implementation - uses service key to obtain new token
 */

import { loadServiceKey } from '../loaders/abap/serviceKeyLoader';
import { refreshJwtToken } from '../auth/tokenRefresher';
import { loadEnvFile } from '../storage/abap/envLoader';
import { saveTokenToEnv } from '../storage/abap/tokenStorage';
import { startBrowserAuth } from '../auth/browserAuth';
import { setCachedToken } from '../utils/cache';
import { Logger, defaultLogger } from '../utils/logger';

/**
 * Refresh token for destination using service key
 * If no refresh token exists, starts browser authentication flow
 * @param destination Destination name
 * @param searchPaths Array of paths to search for files
 * @param logger Optional logger instance. If not provided, uses default logger.
 * @returns New JWT token string
 */
export async function refreshToken(destination: string, searchPaths: string[], logger?: Logger): Promise<string> {
  const log = logger || defaultLogger;
  // Load service key
  const serviceKey = await loadServiceKey(destination, searchPaths);
  if (!serviceKey) {
    const searchedPaths = searchPaths.map(p => `  - ${p}`).join('\n');
    throw new Error(
      `Service key file not found for destination "${destination}".\n` +
      `Please create file: ${destination}.json\n` +
      `Searched in:\n${searchedPaths}`
    );
  }

  // Type assertion for service key structure
  const sk = serviceKey as { uaa?: { url?: string; clientid?: string; clientsecret?: string }; url?: string; abap?: { url?: string }; sap_url?: string };
  
  // Extract UAA configuration
  if (!sk.uaa) {
    throw new Error(
      `Invalid service key for destination "${destination}". ` +
      `Missing required UAA object`
    );
  }
  const { url: uaaUrl, clientid: clientId, clientsecret: clientSecret } = sk.uaa;
  if (!uaaUrl || !clientId || !clientSecret) {
    throw new Error(
      `Invalid service key for destination "${destination}". ` +
      `Missing required UAA fields: url, clientid, clientsecret`
    );
  }

  // Validate SAP URL early (before starting browser auth or refresh)
  const sapUrl = sk.url || sk.abap?.url || sk.sap_url;
  if (!sapUrl) {
    throw new Error(
      `Service key for destination "${destination}" does not contain SAP URL. ` +
      `Expected field: url, abap.url, or sap_url`
    );
  }

  // Try to load existing refresh token from .env file
  const envConfig = await loadEnvFile(destination, searchPaths);
  let refreshTokenValue: string | undefined = envConfig?.refreshToken;

  let result: { accessToken: string; refreshToken?: string };

  // If no refresh token, start browser authentication flow
  if (!refreshTokenValue) {
    log.debug(`No refresh token found for destination "${destination}". Starting browser authentication...`);
    result = await startBrowserAuth(
      {
        uaaUrl,
        uaaClientId: clientId,
        uaaClientSecret: clientSecret,
      },
      'system',
      log
    );
  } else {
    // Refresh token using refresh token
    result = await refreshJwtToken(refreshTokenValue, uaaUrl, clientId, clientSecret);
  }

  // Save new token to .env file

  // Save to first search path (highest priority)
  const savePath = searchPaths[0];
  await saveTokenToEnv(destination, savePath, {
    sapUrl,
    jwtToken: result.accessToken,
    refreshToken: result.refreshToken || refreshTokenValue,
    uaaUrl,
    uaaClientId: clientId,
    uaaClientSecret: clientSecret,
  });

  // Update cache with new token
  setCachedToken(destination, result.accessToken);

  return result.accessToken;
}

