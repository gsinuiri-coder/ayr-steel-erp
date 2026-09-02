import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, type User } from '@prisma/client';
import type { CreateUserInput, UpdateUserInput, UserDto } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/** RF-04: alta, edición y baja de usuarios. Solo ADMINISTRADOR (guard en el controller). */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<UserDto[]> {
    const users = await this.prisma.user.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return users.map(toDto);
  }

  async findOne(id: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return toDto(user);
  }

  async create(actor: RequestUser, input: CreateUserInput): Promise<UserDto> {
    const passwordHash = await this.auth.hashPassword(input.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            role: input.role,
            passwordHash,
            mustChangePassword: true,
            active: true,
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'users.create',
          entity: 'users',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un usuario con ese correo');
      }
      throw err;
    }
  }

  /**
   * Edita nombre, rol, estado o resetea contraseña. Cambiar rol, desactivar o
   * resetear contraseña invalida todas las sesiones del usuario (RF-03).
   */
  async update(actor: RequestUser, id: string, input: UpdateUserInput): Promise<UserDto> {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Usuario no encontrado');

    const roleChanged = input.role !== undefined && input.role !== before.role;
    const deactivated = input.active === false && before.active;
    const passwordReset = input.password !== undefined;

    if (id === actor.id && deactivated) {
      throw new BadRequestException('No puedes desactivar tu propio usuario');
    }
    if (id === actor.id && roleChanged) {
      throw new BadRequestException('No puedes cambiar tu propio rol');
    }
    if (before.role === Role.ADMINISTRADOR && before.active && (deactivated || roleChanged)) {
      const otherAdmins = await this.prisma.user.count({
        where: { role: Role.ADMINISTRADOR, active: true, id: { not: id } },
      });
      if (otherAdmins === 0) {
        throw new BadRequestException('No se puede quitar al último administrador activo');
      }
    }

    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.role !== undefined) data.role = input.role;
    if (input.active !== undefined) data.active = input.active;
    if (input.password !== undefined) {
      data.passwordHash = await this.auth.hashPassword(input.password);
      data.mustChangePassword = true;
    }

    const action = deactivated
      ? 'users.deactivate'
      : roleChanged
        ? 'users.role.change'
        : passwordReset
          ? 'users.password.reset'
          : 'users.update';

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action,
        entity: 'users',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });

    if (roleChanged || deactivated || passwordReset) {
      await this.auth.revokeAllSessions(id);
    }
    return toDto(after);
  }

  /** Baja lógica: desactiva y revoca sesiones. Nunca borra filas (auditoría). */
  async deactivate(actor: RequestUser, id: string): Promise<UserDto> {
    return this.update(actor, id, { active: false });
  }
}

function toDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

function auditView(u: User): Prisma.InputJsonObject {
  return { email: u.email, name: u.name, role: u.role, active: u.active };
}
