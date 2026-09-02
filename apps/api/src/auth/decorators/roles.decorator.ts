import { SetMetadata } from '@nestjs/common';
import type { Role } from '@ayr/shared';

export const ROLES_KEY = 'roles';
/** Restringe la ruta a los roles indicados (RF-02). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
