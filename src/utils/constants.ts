/**
 * Constants for environment variable names and HTTP headers
 * Used by consumers to know which variables to read from .env files
 * and which headers to add for authentication
 */

/**
 * Environment variable names for ABAP connections - Authorization
 * These are used for obtaining and refreshing tokens
 */
export const ABAP_AUTHORIZATION_VARS = {
  /** UAA URL for token refresh */
  UAA_URL: 'SAP_UAA_URL',
  /** UAA client ID */
  UAA_CLIENT_ID: 'SAP_UAA_CLIENT_ID',
  /** UAA client secret */
  UAA_CLIENT_SECRET: 'SAP_UAA_CLIENT_SECRET',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'SAP_REFRESH_TOKEN',
} as const;

/**
 * Environment variable names for ABAP connections - Connection
 * These are used for connecting to ABAP systems
 */
export const ABAP_CONNECTION_VARS = {
  /** Service URL (SAP system URL) */
  SERVICE_URL: 'SAP_URL',
  /** Authorization token (JWT token) */
  AUTHORIZATION_TOKEN: 'SAP_JWT_TOKEN',
  /** SAP client number (optional) */
  SAP_CLIENT: 'SAP_CLIENT',
  /** Language (optional) */
  SAP_LANGUAGE: 'SAP_LANGUAGE',
} as const;

/**
 * Environment variable names for XSUAA connections - Authorization
 * These are used for obtaining and refreshing tokens (reduced scope)
 */
export const XSUAA_AUTHORIZATION_VARS = {
  /** UAA URL for token refresh */
  UAA_URL: 'XSUAA_UAA_URL',
  /** UAA client ID */
  UAA_CLIENT_ID: 'XSUAA_UAA_CLIENT_ID',
  /** UAA client secret */
  UAA_CLIENT_SECRET: 'XSUAA_UAA_CLIENT_SECRET',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'XSUAA_REFRESH_TOKEN',
} as const;

/**
 * Environment variable names for XSUAA connections - Connection
 * These are used for connecting to XSUAA services (reduced scope)
 * Note: SERVICE_URL is undefined for XSUAA (not part of authentication, URL comes from elsewhere)
 */
export const XSUAA_CONNECTION_VARS = {
  /** Authorization token (JWT token for Authorization: Bearer header) */
  AUTHORIZATION_TOKEN: 'XSUAA_JWT_TOKEN',
} as const;

/**
 * Environment variable names for BTP connections - Authorization
 * These are used for obtaining and refreshing tokens (full scope for ABAP)
 */
export const BTP_AUTHORIZATION_VARS = {
  /** UAA URL for token refresh (from service key) */
  UAA_URL: 'BTP_UAA_URL',
  /** UAA client ID (from service key) */
  UAA_CLIENT_ID: 'BTP_UAA_CLIENT_ID',
  /** UAA client secret (from service key) */
  UAA_CLIENT_SECRET: 'BTP_UAA_CLIENT_SECRET',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'BTP_REFRESH_TOKEN',
} as const;

/**
 * Environment variable names for BTP connections - Connection
 * These are used for connecting to ABAP systems via BTP authentication (full scope)
 */
export const BTP_CONNECTION_VARS = {
  /** Service URL (ABAP system URL, required - from service key or YAML) */
  SERVICE_URL: 'BTP_ABAP_URL',
  /** Authorization token (JWT token for Authorization: Bearer header) */
  AUTHORIZATION_TOKEN: 'BTP_JWT_TOKEN',
  /** SAP client number (optional) */
  SAP_CLIENT: 'BTP_SAP_CLIENT',
  /** Language (optional) */
  SAP_LANGUAGE: 'BTP_LANGUAGE',
} as const;

/**
 * @deprecated Use ABAP_AUTHORIZATION_VARS and ABAP_CONNECTION_VARS instead
 * Environment variable names for ABAP connections
 * These are read from {destination}.env files for ABAP systems
 * 
 * Usage: process.env[ABAP_ENV_VARS.SERVICE_URL] → 'SAP_URL'
 */
export const ABAP_ENV_VARS = {
  /** Service URL (SAP system URL) */
  SERVICE_URL: 'SAP_URL',
  /** Authorization token (JWT token) */
  AUTHORIZATION_TOKEN: 'SAP_JWT_TOKEN',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'SAP_REFRESH_TOKEN',
  /** UAA URL for token refresh */
  UAA_URL: 'SAP_UAA_URL',
  /** UAA client ID */
  UAA_CLIENT_ID: 'SAP_UAA_CLIENT_ID',
  /** UAA client secret */
  UAA_CLIENT_SECRET: 'SAP_UAA_CLIENT_SECRET',
  /** SAP client number (optional) */
  SAP_CLIENT: 'SAP_CLIENT',
  /** Language (optional) */
  SAP_LANGUAGE: 'SAP_LANGUAGE',
} as const;

/**
 * @deprecated Use XSUAA_AUTHORIZATION_VARS and XSUAA_CONNECTION_VARS instead
 * Environment variable names for XSUAA connections (reduced scope)
 * These are read from {destination}.env files for XSUAA services
 * 
 * Usage: process.env[XSUAA_ENV_VARS.SERVICE_URL] → 'XSUAA_MCP_URL'
 */
export const XSUAA_ENV_VARS = {
  /** Service URL (MCP server URL, optional - not part of authentication) */
  SERVICE_URL: 'XSUAA_MCP_URL',
  /** Authorization token (JWT token for Authorization: Bearer header) */
  AUTHORIZATION_TOKEN: 'XSUAA_JWT_TOKEN',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'XSUAA_REFRESH_TOKEN',
  /** UAA URL for token refresh */
  UAA_URL: 'XSUAA_UAA_URL',
  /** UAA client ID */
  UAA_CLIENT_ID: 'XSUAA_UAA_CLIENT_ID',
  /** UAA client secret */
  UAA_CLIENT_SECRET: 'XSUAA_UAA_CLIENT_SECRET',
} as const;

/**
 * @deprecated Use BTP_AUTHORIZATION_VARS and BTP_CONNECTION_VARS instead
 * Environment variable names for BTP connections (full scope for ABAP)
 * These are read from {destination}.env files for BTP authentication to ABAP systems
 * 
 * Usage: process.env[BTP_ENV_VARS.SERVICE_URL] → 'BTP_ABAP_URL'
 */
export const BTP_ENV_VARS = {
  /** Service URL (ABAP system URL, required - from service key or YAML) */
  SERVICE_URL: 'BTP_ABAP_URL',
  /** Authorization token (JWT token for Authorization: Bearer header) */
  AUTHORIZATION_TOKEN: 'BTP_JWT_TOKEN',
  /** Refresh token for token renewal */
  REFRESH_TOKEN: 'BTP_REFRESH_TOKEN',
  /** UAA URL for token refresh (from service key) */
  UAA_URL: 'BTP_UAA_URL',
  /** UAA client ID (from service key) */
  UAA_CLIENT_ID: 'BTP_UAA_CLIENT_ID',
  /** UAA client secret (from service key) */
  UAA_CLIENT_SECRET: 'BTP_UAA_CLIENT_SECRET',
  /** SAP client number (optional) */
  SAP_CLIENT: 'BTP_SAP_CLIENT',
  /** Language (optional) */
  SAP_LANGUAGE: 'BTP_LANGUAGE',
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
 * HTTP headers for XSUAA connections (reduced scope)
 * These headers are added to requests to XSUAA services
 */
export const XSUAA_HEADERS = {
  /** Authorization header with Bearer token */
  AUTHORIZATION: 'Authorization',
  /** MCP server URL (optional - can be provided separately) */
  MCP_URL: 'x-mcp-url',
  /** XSUAA destination name for service key-based authentication */
  XSUAA_DESTINATION: 'x-xsuaa-destination',
} as const;

/**
 * HTTP headers for BTP connections (full scope for ABAP)
 * These headers are added to requests to ABAP systems via BTP authentication
 */
export const BTP_HEADERS = {
  /** Authorization header with Bearer token (for BTP authentication to ABAP) */
  AUTHORIZATION: 'Authorization',
  /** ABAP system URL (required - from service key or YAML) */
  ABAP_URL: 'x-abap-url',
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
 * Helper to check if environment variable is for XSUAA
 * @param varName Environment variable name
 * @returns true if variable is for XSUAA
 */
export function isXsuaaEnvVar(varName: string): boolean {
  return Object.values(XSUAA_ENV_VARS).includes(varName as any);
}

/**
 * Helper to check if environment variable is for BTP
 * @param varName Environment variable name
 * @returns true if variable is for BTP
 */
export function isBtpEnvVar(varName: string): boolean {
  return Object.values(BTP_ENV_VARS).includes(varName as any);
}

