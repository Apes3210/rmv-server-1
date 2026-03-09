import { describe, expect, it } from 'vitest';
import { getRefreshTokenFromRequest } from './auth.tokens.js';

describe('getRefreshTokenFromRequest', () => {
  it('prefers the per-tab refresh token header over cookie and body tokens', () => {
    expect(
      getRefreshTokenFromRequest({
        headers: { 'x-refresh-token': 'header-token' },
        cookies: { refreshToken: 'cookie-token' },
        body: { refreshToken: 'body-token' },
      }),
    ).toBe('header-token');
  });

  it('falls back to the cookie token when the header is missing', () => {
    expect(
      getRefreshTokenFromRequest({
        cookies: { refreshToken: 'cookie-token' },
        body: { refreshToken: 'body-token' },
      }),
    ).toBe('cookie-token');
  });

  it('falls back to the request body token when no header or cookie is present', () => {
    expect(
      getRefreshTokenFromRequest({
        body: { refreshToken: 'body-token' },
      }),
    ).toBe('body-token');
  });

  it('supports array header values by taking the first refresh token', () => {
    expect(
      getRefreshTokenFromRequest({
        headers: { 'x-refresh-token': ['first-token', 'second-token'] },
      }),
    ).toBe('first-token');
  });

  it('returns undefined when no refresh token source exists', () => {
    expect(getRefreshTokenFromRequest({})).toBeUndefined();
  });
});