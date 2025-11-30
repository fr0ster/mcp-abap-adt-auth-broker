/**
 * Token cache management
 */

interface CachedToken {
  token: string;
  expiresAt?: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Get cached token for destination
 */
export function getCachedToken(destination: string): string | null {
  const cached = tokenCache.get(destination);
  if (!cached) {
    return null;
  }

  // Check if token is expired (if expiration time is set)
  if (cached.expiresAt && Date.now() >= cached.expiresAt) {
    tokenCache.delete(destination);
    return null;
  }

  return cached.token;
}

/**
 * Set cached token for destination
 */
export function setCachedToken(destination: string, token: string, expiresAt?: number): void {
  tokenCache.set(destination, {
    token,
    expiresAt,
  });
}

/**
 * Clear cached token for destination
 */
export function clearCache(destination: string): void {
  tokenCache.delete(destination);
}

/**
 * Clear all cached tokens
 */
export function clearAllCache(): void {
  tokenCache.clear();
}

