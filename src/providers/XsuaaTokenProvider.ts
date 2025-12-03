/**
 * XSUAA Token Provider
 * 
 * Uses client_credentials grant type to obtain tokens (no browser required).
 * For XSUAA service keys with reduced scope access.
 */

import { ITokenProvider, TokenProviderOptions, TokenProviderResult } from './ITokenProvider';
import { IAuthorizationConfig } from '../stores/interfaces';
import { getTokenWithClientCredentials } from '../auth/clientCredentialsAuth';

/**
 * XSUAA token provider implementation
 * 
 * Uses client_credentials grant type - no browser, no refresh token needed.
 */
export class XsuaaTokenProvider implements ITokenProvider {
  async getConnectionConfig(
    authConfig: IAuthorizationConfig,
    options?: TokenProviderOptions
  ): Promise<TokenProviderResult> {
    const logger = options?.logger;
    
    if (logger) {
      logger.debug('Using client_credentials grant type for XSUAA...');
    }

    // XSUAA uses client_credentials - no refresh token needed
    const result = await getTokenWithClientCredentials(
      authConfig.uaaUrl,
      authConfig.uaaClientId,
      authConfig.uaaClientSecret
    );

    // XSUAA doesn't provide serviceUrl in authorization config
    // It's provided separately (from YAML, parameter, or request header)
    return {
      connectionConfig: {
        authorizationToken: result.accessToken,
        // serviceUrl is undefined for XSUAA - provided separately
      },
      // XSUAA client_credentials doesn't provide refresh token
    };
  }
}

