/**
 * Token Provider interface
 *
 * Stateful providers handle token lifecycle internally (refresh/relogin).
 */

// Import interfaces from shared package
import type {
  IAuthorizationConfig,
  IConnectionConfig,
  ITokenProvider,
  ITokenProviderOptions,
  ITokenResult,
} from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type {
  ITokenProvider,
  IAuthorizationConfig,
  IConnectionConfig,
  ITokenResult,
};
export type TokenProviderOptions = ITokenProviderOptions;
