import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type BusinessLineCode, type Color, type Finish } from '@prisma/client';
import {
  finishColorError,
  type BusinessLine,
  type CreateFinishInput,
  type FinishDto,
  type FinishKind,
  type UpdateFinishInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

type FinishRow = Finish & {
  color: Color | null;
  businessLine: { code: BusinessLineCode } | null;
};

const FINISH_INCLUDE = {
  color: true,
  businessLine: { select: { code: true } },
} as const;

/**
 * Acabados de bobina (RF-25). Mutaciones solo ADMINISTRADOR (guard en el controller).
 *
 * D-203: un acabado es tipo + color + línea, y el color de sus bobinas sale de él. Por eso tipo,
 * color y línea **no se cambian** en un acabado que ya tiene bobinas o compras: repintaría hacia
 * atrás material ya comprado. Para otro color se crea otro acabado.
 */
@Injectable()
export class FinishesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<FinishDto[]> {
    const finishes = await this.prisma.finish.findMany({
      include: FINISH_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return finishes.map(toDto);
  }

  async findOne(id: string): Promise<FinishDto> {
    const finish = await this.prisma.finish.findUnique({ where: { id }, include: FINISH_INCLUDE });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    return toDto(finish);
  }

  async create(actor: RequestUser, input: CreateFinishInput): Promise<FinishDto> {
    try {
      const finish = await this.prisma.$transaction(async (tx) => {
        const colorId = await resolveColor(tx, input.kind, input.colorId ?? null);
        const businessLineId = await resolveLine(tx, input.businessLine);
        const created = await tx.finish.create({
          data: {
            code: input.code,
            name: input.name,
            densityFactor: input.densityFactor,
            kind: input.kind,
            colorId,
            businessLineId,
          },
          include: FINISH_INCLUDE,
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'finishes.create',
          entity: 'finishes',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(finish);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un acabado con ese código');
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateFinishInput): Promise<FinishDto> {
    const after = await this.prisma.$transaction(async (tx) => {
      // Lock de la fila: una recepción de bobina que lea este acabado en paralelo no ve un color
      // a medio cambiar.
      await tx.$queryRaw`SELECT "id" FROM "finishes" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.finish.findUnique({ where: { id }, include: FINISH_INCLUDE });
      if (!before) throw new NotFoundException('Acabado no encontrado');

      const data: Prisma.FinishUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.densityFactor !== undefined) data.densityFactor = input.densityFactor;
      if (input.isActive !== undefined) data.isActive = input.isActive;

      const touchesIdentity =
        input.kind !== undefined || input.colorId !== undefined || input.businessLine !== undefined;
      let colorChanged = false;
      if (touchesIdentity) {
        const kind = input.kind ?? before.kind;
        if (kind === null) {
          throw new BadRequestException('Elige el tipo de acabado');
        }
        // Lo que no viaja se toma del actual; pero pasar a un tipo sin color limpia el color.
        const requestedColor =
          input.colorId !== undefined
            ? input.colorId
            : input.kind !== undefined && input.kind !== before.kind
              ? null
              : before.colorId;
        const colorId = await resolveColor(tx, kind, requestedColor, before.colorId);
        const businessLineId =
          input.businessLine !== undefined
            ? await resolveLine(tx, input.businessLine)
            : before.businessLineId;
        if (businessLineId === null) {
          throw new BadRequestException('Elige la línea del acabado');
        }

        const changed =
          kind !== before.kind ||
          colorId !== before.colorId ||
          businessLineId !== before.businessLineId;
        // Un acabado anterior a D-203 sin mapear (sin tipo) sí se completa aunque tenga uso: es
        // justamente el paso que le falta. Uno ya mapeado con uso no cambia de identidad.
        if (changed && before.kind !== null) {
          const uses = await countUses(tx, id);
          if (uses.coils > 0 || uses.purchaseItems > 0) {
            throw new BadRequestException(
              `El acabado ya tiene ${uses.coils} bobina(s) y ${uses.purchaseItems} ítem(s) de compra: ` +
                'su tipo, color y línea no se cambian porque repintaría ese material. Crea un acabado nuevo',
            );
          }
        }
        data.kind = kind;
        data.colorId = colorId;
        data.businessLineId = businessLineId;
        colorChanged = colorId !== before.colorId;
      }

      const updated = await tx.finish.update({ where: { id }, data, include: FINISH_INCLUDE });
      // El color de las bobinas y compras de este acabado es el del acabado (D-203). Solo puede
      // moverse al completar un acabado sin mapear; se alinea en la misma transacción.
      if (colorChanged) {
        await tx.coil.updateMany({ where: { finishId: id }, data: { colorId: updated.colorId } });
        await tx.purchaseItem.updateMany({
          where: { finishId: id },
          data: { colorId: updated.colorId },
        });
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'finishes.update',
        entity: 'finishes',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }
}

/**
 * Color para un acabado de tipo `kind`, con la regla de D-203. Un color desactivado no se asigna,
 * salvo que sea el que el acabado ya tenía (`current`): editar el nombre de un acabado no obliga a
 * reactivar su color.
 */
async function resolveColor(
  tx: Prisma.TransactionClient,
  kind: FinishKind,
  colorId: string | null,
  current: string | null = null,
): Promise<string | null> {
  const error = finishColorError(kind, colorId);
  if (error) throw new BadRequestException(error);
  if (colorId === null) return null;
  const color = await tx.color.findUnique({
    where: { id: colorId },
    select: { id: true, isActive: true },
  });
  if (!color) throw new NotFoundException('Color no encontrado');
  if (!color.isActive && color.id !== current) {
    throw new BadRequestException('El color está desactivado');
  }
  return color.id;
}

async function resolveLine(tx: Prisma.TransactionClient, line: BusinessLine): Promise<string> {
  const row = await tx.businessLine.findUnique({
    where: { code: toPrismaLineCode(line) },
    select: { id: true },
  });
  if (!row) throw new NotFoundException('Línea de negocio no encontrada');
  return row.id;
}

async function countUses(
  tx: Prisma.TransactionClient,
  finishId: string,
): Promise<{ coils: number; purchaseItems: number }> {
  const [coils, purchaseItems] = await Promise.all([
    tx.coil.count({ where: { finishId } }),
    tx.purchaseItem.count({ where: { finishId } }),
  ]);
  return { coils, purchaseItems };
}

function toDto(f: FinishRow): FinishDto {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    densityFactor: f.densityFactor.toFixed(4),
    kind: f.kind,
    colorId: f.colorId,
    colorName: f.color?.name ?? null,
    colorHex: f.color?.hexColor ?? null,
    colorRal: f.color?.ralCode ?? null,
    businessLine: f.businessLine ? toSharedLineCode(f.businessLine.code) : null,
    isActive: f.isActive,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function auditView(f: FinishRow): Prisma.InputJsonObject {
  return {
    code: f.code,
    name: f.name,
    densityFactor: f.densityFactor.toFixed(4),
    kind: f.kind,
    color: f.color?.name ?? null,
    businessLine: f.businessLine ? toSharedLineCode(f.businessLine.code) : null,
    isActive: f.isActive,
  };
}
