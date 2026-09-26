import { formatToken } from '../../utils/formatting';

/**
 * A log line may say a token is there and how long it is — nothing of the
 * token itself. The previous rule kept tokens of 50 characters or fewer whole,
 * and UAA/XSUAA refresh tokens are about 34, so every one was logged in full.
 */
describe('formatToken', () => {
  it('keeps nothing of a short opaque refresh token', () => {
    const refresh = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-r'; // 34 chars, UAA-shaped
    const logged = formatToken(refresh);

    expect(logged).toBe('<redacted, 34 chars>');
    expect(logged).not.toContain(refresh.slice(0, 8));
  });

  it('keeps nothing of a long access token either', () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${'x'.repeat(400)}.signature`;
    const logged = formatToken(jwt) ?? '';

    expect(logged).toBe(`<redacted, ${jwt.length} chars>`);
    expect(logged).not.toContain('eyJ');
    expect(logged).not.toContain('signature');
  });

  it('says nothing about a token that is not there', () => {
    expect(formatToken(undefined)).toBeUndefined();
    expect(formatToken('')).toBeUndefined();
  });
});
