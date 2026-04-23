// src/cli/publicClientBootstrap.ts
import { OidcBrowserProvider } from '@mcp-abap-adt/auth-providers';

export interface PublicClientBootstrapInput {
  uaaUrl: string;
  clientId: string;
  redirectPort?: number;
  browser?: string;
}

export interface PublicClientBootstrapResult {
  accessToken: string;
  refreshToken?: string;
}

export async function bootstrapPublicClient(
  input: PublicClientBootstrapInput,
): Promise<PublicClientBootstrapResult> {
  const base = input.uaaUrl.replace(/\/$/, '');
  const provider = new OidcBrowserProvider({
    clientId: input.clientId,
    authorizationEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    scopes: ['openid'],
    redirectPort: input.redirectPort ?? 3001,
    browser: input.browser ?? 'auto',
  });

  const result = await provider.getTokens();
  if (!result.authorizationToken) {
    throw new Error(
      'OidcBrowserProvider returned no authorizationToken — check client registration',
    );
  }
  return {
    accessToken: result.authorizationToken,
    refreshToken: result.refreshToken,
  };
}
