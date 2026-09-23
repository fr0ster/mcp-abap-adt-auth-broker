/**
 * Token Provider interface
 *
 * Stateful providers handle token lifecycle internally (refresh/relogin).
 */

// Import interfaces from shared package
import type {
  ITokenProvider,
  ITokenProviderOptions,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IAuthorizationConfig,
  IConnectionConfig,
} from '@mcp-abap-adt/interfaces-auth-sap';

// Re-export for backward compatibility
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  ITokenProvider,
  ITokenResult,
};
export type TokenProviderOptions = ITokenProviderOptions;
