import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Color } from '@prisma/client';
import type { ColorDto, CreateColorInput, UpdateColorInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Maestro de colores (RF-54, D-085). Mutaciones solo ADMINISTRADOR (guard en el controller).
 *
 * Baja lógica, nunca `DELETE`: un color desactivado sigue explicando los productos y las
 * bobinas que ya lo llevan, y el `SET NULL` de la FK lo borraría de ellos en silencio.
 */
@Injectable()
export class ColorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<ColorDto[]> {
    const colors = await this.prisma.color.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return colors.map(toDto);
  }

  async findOne(id: string): Promise<ColorDto> {
    const color = await this.prisma.color.findUnique({ where: { id } });
    if (!color) throw new NotFoundException('Color no encontrado');
    return toDto(color);
  }

  async create(actor: RequestUser, input: CreateColorInput): Promise<ColorDto> {
    try {
      const color = await this.prisma.$transaction(async (tx) => {
        const created = await tx.color.create({
          data: { code: input.code, name: input.name, hexColor: input.hexColor },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'colors.create',
          entity: 'colors',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(color);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un color con ese código');
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateColorInput): Promise<ColorDto> {
    const before = await this.prisma.color.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Color no encontrado');

    // Desactivar un color que un producto o una bobina viva todavía usa dejaría el filtro
    // de la OP (D-086) emparejando contra un maestro que la UI ya no ofrece: el operario
    // vería un rollo cuyo color no puede elegir en ninguna pantalla. Se bloquea con el
    // mismo criterio conservador del resto del proyecto — decir qué falta, no adivinar.
    if (input.isActive === false && before.isActive) {
      const [products, coils] = await Promise.all([
        this.prisma.product.count({ where: { colorId: id, isActive: true } }),
        this.prisma.coil.count({ where: { colorId: id, status: { not: 'CANCELLED' } } }),
      ]);
      if (products > 0 || coils > 0) {
        throw new BadRequestException(
          `El color lo usan ${products} producto(s) activo(s) y ${coils} bobina(s) viva(s): quítalo de ellos antes de desactivarlo`,
        );
      }
    }

    const data: Prisma.ColorUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.hexColor !== undefined) data.hexColor = input.hexColor;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.color.update({ where: { id }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'colors.update',
        entity: 'colors',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }

  /**
   * Color válido para asignar a un producto o a una bobina. Devuelve `null` cuando el
   * llamador no manda ninguno, que es el caso normal fuera de coberturas prepintadas.
   */
  async resolveActive(colorId: string | null | undefined): Promise<string | null> {
    if (colorId === null || colorId === undefined || colorId === '') return null;
    const color = await this.prisma.color.findUnique({
      where: { id: colorId },
      select: { id: true, isActive: true },
    });
    if (!color) throw new NotFoundException('Color no encontrado');
    if (!color.isActive) throw new BadRequestException('El color está desactivado');
    return color.id;
  }
}

export function toDto(c: Color): ColorDto {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    hexColor: c.hexColor,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function auditView(c: Color): Prisma.InputJsonObject {
  return { code: c.code, name: c.name, hexColor: c.hexColor, isActive: c.isActive };
}
