/**
 * BTP/ABAP Token Provider
 * 
 * Uses browser-based OAuth2 or refresh token to obtain tokens.
 * For ABAP and full-scope BTP connections.
 */

import { ITokenProvider, TokenProviderOptions, TokenProviderResult } from './ITokenProvider';
import { IAuthorizationConfig } from '../stores/interfaces';
import { startBrowserAuth } from '../auth/browserAuth';
import { refreshJwtToken } from '../auth/tokenRefresher';

/**
 * BTP/ABAP token provider implementation
 * 
 * Uses browser-based OAuth2 (if no refresh token) or refresh token flow.
 */
export class BtpTokenProvider implements ITokenProvider {
  async getConnectionConfig(
    authConfig: IAuthorizationConfig,
    options?: TokenProviderOptions
  ): Promise<TokenProviderResult> {
    const logger = options?.logger;
    const browser = options?.browser || 'system';
    
    let result: { accessToken: string; refreshToken?: string };

    if (!authConfig.refreshToken) {
      // No refresh token - start browser authentication flow
      if (logger) {
        logger.debug('No refresh token found. Starting browser authentication...');
      }
      result = await startBrowserAuth(authConfig, browser, logger);
    } else {
      // Use refresh token to get new access token
      if (logger) {
        logger.debug('Refreshing token using refresh token...');
      }
      result = await refreshJwtToken(
        authConfig.refreshToken,
        authConfig.uaaUrl,
        authConfig.uaaClientId,
        authConfig.uaaClientSecret
      );
    }

    return {
      connectionConfig: {
        authorizationToken: result.accessToken,
        // serviceUrl, sapClient, language are not part of authorization config
        // They come from service key or session store separately
      },
      refreshToken: result.refreshToken,
    };
  }
}

