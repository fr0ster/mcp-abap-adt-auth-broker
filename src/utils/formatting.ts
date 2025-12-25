/**
 * Formatting utilities for logging
 */

/**
 * Format token for logging (start...end)
 * @param token Token string to format
 * @returns Formatted token string or undefined if token is empty
 */
export function formatToken(token?: string): string | undefined {
  if (!token) return undefined;
  if (token.length <= 50) return token;
  return `${token.substring(0, 25)}...${token.substring(token.length - 25)}`;
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
