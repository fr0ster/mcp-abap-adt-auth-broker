/**
 * Refresh token implementation - uses service key to obtain new token
 */

import { loadServiceKey } from './serviceKeyLoader';
import { refreshJwtToken } from './tokenRefresher';
import { loadEnvFile } from './envLoader';
import { saveTokenToEnv } from './tokenStorage';
import { startBrowserAuth } from './browserAuth';
import { setCachedToken } from './cache';

/**
 * Refresh token for destination using service key
 * If no refresh token exists, starts browser authentication flow
 * @param destination Destination name
 * @param searchPaths Array of paths to search for files
 * @returns New JWT token string
 */
export async function refreshToken(destination: string, searchPaths: string[]): Promise<string> {
  // Load service key
  const serviceKey = await loadServiceKey(destination, searchPaths);
  if (!serviceKey) {
    const searchedPaths = searchPaths.join(', ');
    throw new Error(
      `Service key file not found for destination "${destination}". ` +
      `Searched in: ${searchedPaths}`
    );
  }

  // Extract UAA configuration
  const { url: uaaUrl, clientid: clientId, clientsecret: clientSecret } = serviceKey.uaa;
  if (!uaaUrl || !clientId || !clientSecret) {
    throw new Error(
      `Invalid service key for destination "${destination}". ` +
      `Missing required UAA fields: url, clientid, clientsecret`
    );
  }

  // Try to load existing refresh token from .env file
  const envConfig = await loadEnvFile(destination, searchPaths);
  let refreshTokenValue: string | undefined = envConfig?.refreshToken;

  let result: { accessToken: string; refreshToken?: string };

  // If no refresh token, start browser authentication flow
  if (!refreshTokenValue) {
    console.log(`No refresh token found for destination "${destination}". Starting browser authentication...`);
    result = await startBrowserAuth(serviceKey, 'system');
  } else {
    // Refresh token using refresh token
    result = await refreshJwtToken(refreshTokenValue, uaaUrl, clientId, clientSecret);
  }

  // Save new token to .env file
  const sapUrl = serviceKey.url || serviceKey.abap?.url || serviceKey.sap_url;
  if (!sapUrl) {
    throw new Error(
      `Service key for destination "${destination}" does not contain SAP URL. ` +
      `Expected field: url, abap.url, or sap_url`
    );
  }

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

