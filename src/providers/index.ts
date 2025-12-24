/**
 * Token provider interface
 *
 * Provider implementations are in separate packages:
 * - @mcp-abap-adt/auth-providers - XSUAA and BTP providers
 */

export type {
  ITokenProvider,
  ITokenResult,
  TokenProviderOptions,
} from './ITokenProvider';
