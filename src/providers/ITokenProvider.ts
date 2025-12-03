/**
 * Token Provider interface
 * 
 * Converts IAuthorizationConfig to IConnectionConfig by obtaining tokens.
 * Different implementations handle different authentication flows:
 * - XSUAA: client_credentials grant type (no browser)
 * - BTP/ABAP: browser-based OAuth2 or refresh token
 */

import { IAuthorizationConfig, IConnectionConfig } from '../stores/interfaces';

/**
 * Result from token provider
 */
export interface TokenProviderResult {
  /** Connection configuration with authorization token */
  connectionConfig: IConnectionConfig;
  /** Refresh token (optional, for BTP/ABAP) */
  refreshToken?: string;
}

/**
 * Interface for token providers
 * 
 * Takes authorization configuration and returns connection configuration with token.
 */
export interface ITokenProvider {
  /**
   * Get connection configuration with token from authorization configuration
   * @param authConfig Authorization configuration (UAA credentials, optional refresh token)
   * @param options Optional provider-specific options (e.g., browser type for BTP)
   * @returns Promise that resolves to connection configuration with authorization token and optional refresh token
   */
  getConnectionConfig(
    authConfig: IAuthorizationConfig,
    options?: TokenProviderOptions
  ): Promise<TokenProviderResult>;

  /**
   * Validate JWT token by testing connection to service
   * @param token JWT token to validate
   * @param serviceUrl Service URL (optional, for services that require URL validation)
   * @returns Promise that resolves to true if token is valid, false otherwise
   */
  validateToken?(token: string, serviceUrl?: string): Promise<boolean>;
}

/**
 * Options for token providers
 */
export interface TokenProviderOptions {
  /** Browser type for browser-based authentication (chrome, edge, firefox, system, none) */
  browser?: string;
  /** Logger instance for logging */
  logger?: import('@mcp-abap-adt/logger').Logger;
}

