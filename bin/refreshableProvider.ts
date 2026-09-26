/**
 * An `IRefreshableTokenProvider` over providers that only implement
 * `ITokenProvider`.
 *
 * TODO(auth-providers 4.2.0): delete this file. In 4.2.0 every provider
 * implements `refreshTokens()` itself, and the CLIs pass the provider to
 * `AuthBroker` directly. `SsoProviderFactory.create()` must also be typed as
 * returning `IRefreshableTokenProvider` for bin/mcp-sso.ts to do the same.
 *
 * Until then a forced refresh is obtained honestly, without casts: a provider
 * built afresh has no cached token, so its `getTokens()` uses the refresh token
 * it is seeded with, or logs in when there is none or the refresh is refused.
 * The fresh instance then becomes the current one.
 */

import type {
  IRefreshableTokenProvider,
  ITokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';

/** What a provider built for a forced refresh is seeded with. */
export interface RefreshSeed {
  /** The refresh token the last result carried, if any did. */
  refreshToken?: string;
}

/**
 * @param build Builds a provider. Called with no seed once, for the first
 *              provider, which the caller seeds from its own stores. Called
 *              with a seed for a forced refresh: that provider must be given no
 *              access token — a cached one would be answered again — and the
 *              seed's refresh token, or the caller's stored one when the seed
 *              has none.
 */
export function refreshableProvider(
  build: (refresh?: RefreshSeed) => ITokenProvider,
): IRefreshableTokenProvider {
  let current = build();
  let lastRefreshToken: string | undefined;
  const remember = (result: ITokenResult): ITokenResult => {
    if (result.refreshToken) {
      lastRefreshToken = result.refreshToken;
    }
    return result;
  };
  return {
    async getTokens() {
      return remember(await current.getTokens());
    },
    async refreshTokens() {
      current = build({ refreshToken: lastRefreshToken });
      return remember(await current.getTokens());
    },
  };
}
