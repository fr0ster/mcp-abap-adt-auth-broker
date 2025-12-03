/**
 * Type definitions for auth-broker package
 */

/**
 * Environment configuration loaded from .env file
 * Used for ABAP connections - contains full SAP configuration
 */
export interface EnvConfig {
  sapUrl: string;
  sapClient?: string;
  jwtToken: string;
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
  language?: string;
}

/**
 * BTP Session configuration
 * Simplified configuration for BTP service connections
 * Contains JWT token, optional MCP server URL, and optional UAA credentials for .env file storage
 * 
 * Note: mcpUrl is optional because it's not part of authentication - it's only needed for making requests.
 * For XSUAA, the service key only provides UAA credentials for authentication.
 * MCP URL can be provided separately via YAML config, parameter, or request header.
 */
export interface BtpSessionConfig {
  mcpUrl?: string; // MCP server URL (optional - not part of authentication)
  jwtToken: string; // JWT token for Authorization: Bearer
  refreshToken?: string; // Optional refresh token for token renewal
  // Optional UAA credentials for saving to .env file
  uaaUrl?: string; // UAA URL for token refresh
  uaaClientId?: string; // UAA client ID
  uaaClientSecret?: string; // UAA client secret
}

/**
 * Service key structure from JSON file
 */
export interface ServiceKey {
  url?: string;
  abap?: {
    url?: string;
    client?: string;
    language?: string;
  };
  sap_url?: string;
  client?: string;
  sap_client?: string;
  language?: string;
  uaa: {
    url: string;
    clientid: string;
    clientsecret: string;
  };
}
