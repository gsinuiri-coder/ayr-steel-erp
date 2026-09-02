import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestUser } from '../auth.types';

/** Inyecta el usuario autenticado que dejó el AuthGuard en `req.user`. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: RequestUser }>();
  return req.user;
});
