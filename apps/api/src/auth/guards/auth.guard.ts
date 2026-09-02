import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { ACCESS_COOKIE, type RequestUser } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Rutas permitidas mientras el usuario aún debe cambiar su contraseña temporal. */
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = ['/auth/me', '/auth/change-password', '/auth/logout'];

/** Guard global: exige access token (cookie o Bearer) salvo rutas @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('No autenticado');
    const user = await this.auth.validateAccessToken(token);

    if (user.mustChangePassword && !ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.includes(req.path)) {
      throw new ForbiddenException('Debes cambiar tu contraseña temporal antes de continuar');
    }
    req.user = user;
    return true;
  }
}

function extractToken(req: Request): string | undefined {
  const cookies = req.cookies as Partial<Record<string, string>> | undefined;
  const fromCookie = cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}
