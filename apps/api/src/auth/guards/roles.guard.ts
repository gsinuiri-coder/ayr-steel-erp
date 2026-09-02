import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@ayr/shared';
import type { RequestUser } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Guard global por rol (RF-02). Se evalúa después de AuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (!req.user) return false;
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenException('No tienes permiso para esta acción');
    }
    return true;
  }
}
