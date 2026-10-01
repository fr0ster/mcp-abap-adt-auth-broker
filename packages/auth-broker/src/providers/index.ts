/**
 * Token provider interface
 *
 * Provider implementations: `@mcp-abap-adt/auth-providers`, or any
 * `IRefreshableTokenProvider`.
 */

export type {
  IRefreshableTokenProvider,
  ITokenProvider,
  ITokenResult,
  TokenProviderOptions,
} from './ITokenProvider';
