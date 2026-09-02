import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.types';
import type { IssuedTokens } from './auth.service';

/**
 * Cookies httpOnly. El web consume el API vía rewrite same-origin (D-015),
 * por eso `sameSite: 'lax'` basta y no se fija `domain`.
 */
function baseOptions(env: Env): CookieOptions {
  return { httpOnly: true, secure: env.cookieSecure, sameSite: 'lax', path: '/' };
}

export function setAuthCookies(res: Response, env: Env, tokens: IssuedTokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseOptions(env),
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOptions(env),
    expires: tokens.refreshExpiresAt,
  });
}

export function clearAuthCookies(res: Response, env: Env): void {
  res.clearCookie(ACCESS_COOKIE, baseOptions(env));
  res.clearCookie(REFRESH_COOKIE, baseOptions(env));
}
