// src/__tests__/cli/publicClientEnv.test.ts
import { renderPublicClientEnv } from '../../cli/publicClientEnv';

describe('renderPublicClientEnv', () => {
  it('renders BTP_* vars with empty client_secret', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'https://abap.example/',
      uaaUrl: 'https://uaa.example',
      clientId: 'sb-xs-foo!b1|xsuaa-bar!b2',
      accessToken: 'jwt.access.token',
      refreshToken: 'rt-value',
    });
    expect(out).toContain('BTP_ABAP_URL=https://abap.example/');
    expect(out).toContain('BTP_UAA_URL=https://uaa.example');
    expect(out).toContain('BTP_UAA_CLIENT_ID=sb-xs-foo!b1|xsuaa-bar!b2');
    expect(out).toContain('BTP_UAA_CLIENT_SECRET=');
    expect(out).toContain('BTP_JWT_TOKEN=jwt.access.token');
    expect(out).toContain('BTP_REFRESH_TOKEN=rt-value');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('omits refresh token line when not provided', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'https://abap.example/',
      uaaUrl: 'https://uaa.example',
      clientId: 'cid',
      accessToken: 'jwt',
    });
    expect(out).not.toContain('BTP_REFRESH_TOKEN');
  });

  it('always emits BTP_UAA_CLIENT_SECRET= as the public-client marker', () => {
    const out = renderPublicClientEnv({
      abapUrl: 'a',
      uaaUrl: 'b',
      clientId: 'c',
      accessToken: 'd',
    });
    expect(out).toMatch(/^BTP_UAA_CLIENT_SECRET=$/m);
  });
});
