/**
 * Type definitions for auth-broker package
 */

/**
 * Environment configuration loaded from .env file
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

