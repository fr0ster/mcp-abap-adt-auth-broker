/**
 * Formatting utilities for logging
 */

/**
 * What a log line may say about a token: that it is there, and its length.
 *
 * It used to return a token of 50 characters or fewer whole, and the first and
 * last 25 characters of a longer one. UAA and XSUAA refresh tokens are opaque
 * and about 34 characters, so every one of them was logged in full, at `info`,
 * and an access token leaked 50 characters. auth-providers 4.1.2 closed the
 * same leak in its own `formatToken`; this is the broker's copy of it.
 *
 * @param token Token string to describe
 * @returns `<redacted, N chars>`, or undefined if there is no token
 */
export function formatToken(token?: string): string | undefined {
  if (!token) return undefined;
  return `<redacted, ${token.length} chars>`;
}

/**
 * Format timestamp to readable date/time string
 * @param timestamp Timestamp in milliseconds
 * @returns Formatted date string (e.g., "2025-12-25 19:21:27 UTC")
 */
export function formatExpirationDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}
