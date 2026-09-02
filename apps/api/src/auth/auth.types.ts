import type { Role } from '@ayr/shared';

/** Payload del JWT de acceso. `sid` = id de sesión para poder invalidar (RF-03). */
export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: Role;
}

/** Usuario que viaja en `req.user` tras pasar el AuthGuard. */
export interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: string;
}

export const ACCESS_COOKIE = 'ayr_access';
export const REFRESH_COOKIE = 'ayr_refresh';
