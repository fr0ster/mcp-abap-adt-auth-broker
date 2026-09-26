import type {
  ITokenProvider,
  ITokenResult,
} from '@mcp-abap-adt/interfaces-auth';
import {
  type RefreshSeed,
  refreshableProvider,
} from '../../../bin/refreshableProvider';

/** A provider answering its cache, as BaseTokenProvider does while valid. */
function cachingProvider(token: string, refreshToken?: string): ITokenProvider {
  const result: ITokenResult = {
    authorizationToken: token,
    refreshToken,
    authType: 'authorization_code',
  };
  return { getTokens: jest.fn(async () => result) };
}

describe('refreshableProvider (until auth-providers 4.2.0)', () => {
  it('getTokens() answers the current provider', async () => {
    const build = jest.fn((_seed?: RefreshSeed) => cachingProvider('t1', 'r1'));
    const provider = refreshableProvider(build);

    await expect(provider.getTokens()).resolves.toMatchObject({
      authorizationToken: 't1',
    });
    await provider.getTokens();

    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith();
  });

  it('refreshTokens() builds a fresh provider seeded with the last refresh token, and keeps it', async () => {
    let n = 0;
    const build = jest.fn((_seed?: RefreshSeed) => {
      n += 1;
      return cachingProvider(`t${n}`, `r${n}`);
    });
    const provider = refreshableProvider(build);

    await provider.getTokens();
    await expect(provider.refreshTokens()).resolves.toMatchObject({
      authorizationToken: 't2',
    });
    await expect(provider.getTokens()).resolves.toMatchObject({
      authorizationToken: 't2',
    });

    expect(build).toHaveBeenNthCalledWith(2, { refreshToken: 'r1' });
  });

  it('seeds a refresh with no refresh token when none was ever returned', async () => {
    const build = jest.fn((_seed?: RefreshSeed) => cachingProvider('t'));
    const provider = refreshableProvider(build);

    await provider.refreshTokens();

    expect(build).toHaveBeenNthCalledWith(2, { refreshToken: undefined });
  });
});
