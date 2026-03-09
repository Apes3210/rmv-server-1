interface RefreshTokenRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  cookies?: { refreshToken?: string };
  body?: { refreshToken?: string };
}

export function getRefreshTokenFromRequest(req: RefreshTokenRequestLike): string | undefined {
  const headerValue = req.headers?.['x-refresh-token'];
  const refreshHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return refreshHeader || req.cookies?.refreshToken || req.body?.refreshToken;
}