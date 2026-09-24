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
import {
  executeColorRetirement,
  planColorRetirement,
  type ColorRetirementPlan,
} from './color-retirement';

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
        await assertNameFree(tx, input.name);
        const created = await tx.color.create({
          data: {
            code: input.code,
            name: input.name,
            ralCode: input.ralCode ?? null,
            hexColor: input.hexColor,
          },
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
        throw new ConflictException('Ya existe un color con ese código o ese nombre');
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
      const [products, coils, finishes] = await Promise.all([
        this.prisma.product.count({ where: { colorId: id, isActive: true } }),
        this.prisma.coil.count({ where: { colorId: id, status: { not: 'CANCELLED' } } }),
        // D-203: un acabado activo con este color lo seguiría ofreciendo al registrar bobinas.
        this.prisma.finish.count({ where: { colorId: id, isActive: true } }),
      ]);
      if (products > 0 || coils > 0 || finishes > 0) {
        throw new BadRequestException(
          `El color lo usan ${products} producto(s) activo(s), ${finishes} acabado(s) activo(s) y ${coils} bobina(s) viva(s): quítalo de ellos antes de desactivarlo`,
        );
      }
    }

    const data: Prisma.ColorUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.ralCode !== undefined) data.ralCode = input.ralCode;
    if (input.hexColor !== undefined) data.hexColor = input.hexColor;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma
      .$transaction(async (tx) => {
        if (input.name !== undefined) await assertNameFree(tx, input.name, id);
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
      })
      .catch((err: unknown) => {
        // Dos renombres simultáneos al mismo nombre pasan los dos `assertNameFree`; el índice
        // `colors_name_lower_key` decide, y eso es un 409, no un 500.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('Ya existe un color con ese nombre');
        }
        throw err;
      });
    return toDto(after);
  }

  /** D-274: qué haría el retiro de un color sin uso, sin escribir nada. */
  planRetirement(code: string): Promise<ColorRetirementPlan> {
    return this.prisma.$transaction((tx) => planColorRetirement(tx, code), RETIREMENT_TX);
  }

  /** D-274: retira un color sin uso y sus specs sobrantes. Se niega con una sola referencia. */
  retire(actor: Pick<RequestUser, 'id'>, code: string): Promise<ColorRetirementPlan> {
    return this.prisma.$transaction(
      (tx) => executeColorRetirement(tx, this.audit, actor.id, code),
      RETIREMENT_TX,
    );
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

/**
 * D-274: el retiro corre desde la CLI contra Neon, con una docena de consultas en serie dentro
 * de la transacción. Los 5 s por defecto de Prisma no alcanzan desde afuera de la región (el
 * mismo «timeout 5 s» que apareció en el ensayo de RF-S4b).
 */
const RETIREMENT_TX = { timeout: 60_000, maxWait: 20_000 } as const;

export function toDto(c: Color): ColorDto {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    ralCode: c.ralCode,
    hexColor: c.hexColor,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function auditView(c: Color): Prisma.InputJsonObject {
  return {
    code: c.code,
    name: c.name,
    ralCode: c.ralCode,
    hexColor: c.hexColor,
    isActive: c.isActive,
  };
}

/**
 * D-203: el nombre de un color es único sin distinguir mayúsculas («Rojo» y «ROJO» son el mismo
 * color para quien lo elige). La base lo sostiene con `colors_name_lower_key`; esto da el mensaje
 * claro antes de llegar al índice.
 */
async function assertNameFree(
  tx: Prisma.TransactionClient,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.color.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true },
  });
  if (clash) throw new ConflictException(`Ya existe el color «${clash.name}»`);
}
