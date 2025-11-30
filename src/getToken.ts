/**
 * Get token implementation - loads from .env, validates, refreshes if needed
 */

import { loadEnvFile } from './envLoader';
import { loadServiceKey } from './serviceKeyLoader';
import { validateToken } from './tokenValidator';
import { refreshToken } from './refreshToken';
import { getCachedToken, setCachedToken } from './cache';

/**
 * Get authentication token for destination
 * @param destination Destination name
 * @param searchPaths Array of paths to search for files
 * @returns JWT token string
 * @throws Error if neither .env file nor service key found
 */
export async function getToken(destination: string, searchPaths: string[]): Promise<string> {
  // Check cache first
  const cachedToken = getCachedToken(destination);
  if (cachedToken) {
    // Validate cached token
    const envConfig = await loadEnvFile(destination, searchPaths);
    if (envConfig) {
      const isValid = await validateToken(cachedToken, envConfig.sapUrl);
      if (isValid) {
        return cachedToken;
      }
      // Token expired, remove from cache
    }
  }

  // Load from .env file
  const envConfig = await loadEnvFile(destination, searchPaths);
  if (envConfig && envConfig.jwtToken) {
    // Validate token
    const isValid = await validateToken(envConfig.jwtToken, envConfig.sapUrl);
    if (isValid) {
      setCachedToken(destination, envConfig.jwtToken);
      return envConfig.jwtToken;
    }
  }

  // Token not found or expired, check if we have service key for browser auth
  const serviceKey = await loadServiceKey(destination, searchPaths);
  if (!serviceKey) {
    // No service key and no valid token - throw error
    throw new Error(
      `No authentication found for destination "${destination}". ` +
      `Neither ${destination}.env file nor ${destination}.json service key found in search paths: ${searchPaths.join(', ')}`
    );
  }

  // Try to refresh (will use browser auth if no refresh token)
  const newToken = await refreshToken(destination, searchPaths);
  setCachedToken(destination, newToken);
  return newToken;
}

