/**
 * Client Credentials authentication for XSUAA
 * 
 * For XSUAA service keys, tokens are obtained via client_credentials grant type
 * using POST request to UAA token endpoint (no browser required)
 */

import axios from 'axios';

export interface ClientCredentialsResult {
  accessToken: string;
  expiresIn?: number;
}

/**
 * Get access token using client_credentials grant type
 * @param uaaUrl UAA URL (e.g., https://your-account.authentication.eu10.hana.ondemand.com)
 * @param clientId UAA client ID
 * @param clientSecret UAA client secret
 * @returns Promise that resolves to access token
 */
export async function getTokenWithClientCredentials(
  uaaUrl: string,
  clientId: string,
  clientSecret: string
): Promise<ClientCredentialsResult> {
  try {
    const tokenUrl = `${uaaUrl}/oauth/token`;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await axios({
      method: 'post',
      url: tokenUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: params.toString(),
      timeout: 30000, // 30 seconds timeout to prevent hanging
    });

    if (response.data && response.data.access_token) {
      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in,
      };
    } else {
      throw new Error('Response does not contain access_token');
    }
  } catch (error: any) {
    if (error.response) {
      throw new Error(
        `Client credentials authentication failed (${error.response.status}): ${JSON.stringify(error.response.data)}`
      );
    } else {
      throw new Error(`Client credentials authentication failed: ${error.message}`);
    }
  }
}

