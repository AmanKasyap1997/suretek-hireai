import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { readConfig } from '../../platform/config';
export const SESSION_COOKIE = 'hireai_session';
export function cookieToken(req: Request): string | undefined {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}
export function assertBrowserOrigin(req: Request) {
  if (
    !req.headers.origin ||
    !readConfig().CORS_ORIGINS.split(',').includes(req.headers.origin)
  )
    throw new ForbiddenException('Browser origin not permitted');
}
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: readConfig().NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/api/v1',
  };
}
