/**
 * Token validator - validates JWT tokens by testing connection
 */

import axios, { AxiosError } from 'axios';

/**
 * Validate JWT token by making a test request to SAP system
 * @param token JWT token to validate
 * @param sapUrl SAP system URL
 * @returns true if token is valid, false if expired/invalid
 */
export async function validateToken(token: string, sapUrl: string): Promise<boolean> {
  try {
    // Make a lightweight request to test token validity
    // Using /sap/bc/adt/core/discovery as it's a simple endpoint
    const testUrl = `${sapUrl}/sap/bc/adt/core/discovery`;

    const response = await axios.get(testUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/xml',
      },
      timeout: 10000, // 10 second timeout
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
    });

    // 200-299: Token is valid
    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    // 401/403: Token expired or invalid (but distinguish from permission errors)
    if (response.status === 401 || response.status === 403) {
      const responseText = typeof response.data === 'string' 
        ? response.data 
        : JSON.stringify(response.data || '');

      // Check if it's a permission error (not auth error)
      if (
        responseText.includes('ExceptionResourceNoAccess') ||
        responseText.includes('No authorization') ||
        responseText.includes('Missing authorization')
      ) {
        // Permission error - token is valid but user doesn't have access
        // We consider this as valid token
        return true;
      }

      // Auth error - token expired or invalid
      return false;
    }

    // Other errors - assume token is valid (might be network issues, etc.)
    return true;
  } catch (error) {
    if (error instanceof AxiosError) {
      // Network errors or timeouts - assume token might be valid
      // (we don't want to invalidate tokens due to network issues)
      if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        // Network issue - assume token is valid
        return true;
      }

      // 401/403 errors
      if (error.response?.status === 401 || error.response?.status === 403) {
        const responseText = typeof error.response.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response.data || '');

        // Check if it's a permission error
        if (
          responseText.includes('ExceptionResourceNoAccess') ||
          responseText.includes('No authorization') ||
          responseText.includes('Missing authorization')
        ) {
          return true;
        }

        return false;
      }
    }

    // Unknown error - assume token is valid to avoid false negatives
    return true;
  }
}

