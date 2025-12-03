/**
 * Constants for environment variable names and HTTP headers
 * Used by consumers to know which variables to read from .env files
 * and which headers to add for authentication
 */

/**
 * Environment variable names for ABAP connections
 * These are read from {destination}.env files for ABAP systems
 */
export const ABAP_ENV_VARS = {
  /** SAP system URL */
  SAP_URL: 'SAP_URL',
  /** JWT token for Authorization */
  SAP_JWT_TOKEN: 'SAP_JWT_TOKEN',
  /** Refresh token for token renewal */
  SAP_REFRESH_TOKEN: 'SAP_REFRESH_TOKEN',
  /** UAA URL for token refresh */
  SAP_UAA_URL: 'SAP_UAA_URL',
  /** UAA client ID */
  SAP_UAA_CLIENT_ID: 'SAP_UAA_CLIENT_ID',
  /** UAA client secret */
  SAP_UAA_CLIENT_SECRET: 'SAP_UAA_CLIENT_SECRET',
  /** SAP client number */
  SAP_CLIENT: 'SAP_CLIENT',
  /** Language */
  SAP_LANGUAGE: 'SAP_LANGUAGE',
} as const;

/**
 * Environment variable names for BTP/XSUAA connections
 * These are read from {destination}.env files for BTP services
 */
export const BTP_ENV_VARS = {
  /** MCP server URL (optional - not part of authentication) */
  BTP_URL: 'BTP_URL',
  /** Alternative name for MCP URL */
  BTP_MCP_URL: 'BTP_MCP_URL',
  /** JWT token for Authorization: Bearer header */
  BTP_JWT_TOKEN: 'BTP_JWT_TOKEN',
  /** Refresh token for token renewal */
  BTP_REFRESH_TOKEN: 'BTP_REFRESH_TOKEN',
  /** UAA URL for token refresh */
  BTP_UAA_URL: 'BTP_UAA_URL',
  /** UAA client ID */
  BTP_UAA_CLIENT_ID: 'BTP_UAA_CLIENT_ID',
  /** UAA client secret */
  BTP_UAA_CLIENT_SECRET: 'BTP_UAA_CLIENT_SECRET',
} as const;

/**
 * HTTP headers for ABAP connections
 * These headers are added to requests to ABAP systems
 */
export const ABAP_HEADERS = {
  /** SAP system URL */
  SAP_URL: 'x-sap-url',
  /** Authentication type (jwt, xsuaa, basic) */
  SAP_AUTH_TYPE: 'x-sap-auth-type',
  /** JWT token */
  SAP_JWT_TOKEN: 'x-sap-jwt-token',
  /** Refresh token */
  SAP_REFRESH_TOKEN: 'x-sap-refresh-token',
  /** UAA URL */
  SAP_UAA_URL: 'x-sap-uaa-url',
  /** UAA client ID */
  SAP_UAA_CLIENT_ID: 'x-sap-uaa-client-id',
  /** UAA client secret */
  SAP_UAA_CLIENT_SECRET: 'x-sap-uaa-client-secret',
  /** SAP client number */
  SAP_CLIENT: 'x-sap-client',
  /** Destination name for service key-based authentication */
  SAP_DESTINATION: 'x-sap-destination',
  /** Destination name for MCP destination-based authentication */
  MCP_DESTINATION: 'x-mcp-destination',
  /** Login for basic authentication */
  SAP_LOGIN: 'x-sap-login',
  /** Password for basic authentication */
  SAP_PASSWORD: 'x-sap-password',
} as const;

/**
 * HTTP headers for BTP/XSUAA connections
 * These headers are added to requests to BTP services
 */
export const BTP_HEADERS = {
  /** Authorization header with Bearer token (for BTP Cloud authentication) */
  AUTHORIZATION: 'Authorization',
  /** MCP server URL (optional - can be provided separately) */
  MCP_URL: 'x-mcp-url',
  /** BTP destination name for service key-based authentication */
  BTP_DESTINATION: 'x-btp-destination',
} as const;

/**
 * Helper to get Authorization header value for BTP
 * @param token JWT token
 * @returns Authorization header value (e.g., "Bearer <token>")
 */
export function getBtpAuthorizationHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Helper to check if environment variable is for ABAP
 * @param varName Environment variable name
 * @returns true if variable is for ABAP
 */
export function isAbapEnvVar(varName: string): boolean {
  return Object.values(ABAP_ENV_VARS).includes(varName as any);
}

/**
 * Helper to check if environment variable is for BTP
 * @param varName Environment variable name
 * @returns true if variable is for BTP
 */
export function isBtpEnvVar(varName: string): boolean {
  return Object.values(BTP_ENV_VARS).includes(varName as any);
}

