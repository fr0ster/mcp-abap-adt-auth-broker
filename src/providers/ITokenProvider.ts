/**
 * Token Provider interface
 * 
 * Converts IAuthorizationConfig to IConnectionConfig by obtaining tokens.
 * Different implementations handle different authentication flows:
 * - XSUAA: client_credentials grant type (no browser)
 * - BTP/ABAP: browser-based OAuth2 or refresh token
 */

// Import interfaces from shared package
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  ITokenProvider,
  ITokenProviderResult,
  ITokenProviderOptions
} from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type {
  ITokenProvider,
  IAuthorizationConfig,
  IConnectionConfig,
};
export type TokenProviderResult = ITokenProviderResult;
export type TokenProviderOptions = ITokenProviderOptions;

