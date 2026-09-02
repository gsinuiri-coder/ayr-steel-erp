import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryItemType,
  InventoryStrategy,
  Prisma,
  type InventoryMovement,
  type InventoryRefType,
} from '@prisma/client';
import {
  Decimal,
  toDecimal,
  toFixedString,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
} from '@ayr/shared';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Entrada de `InventoryService.record`. `qty` siempre positiva: el sentido lo da `type`
 * (§3.2). `unitCost` solo aplica a las entradas; las salidas se valorizan al costo
 * promedio vigente (D-028, D-040).
 */
export interface RecordMovementInput {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  /** `ADJUST` queda reservado para Fase 2b (RF-20); `record` solo emite IN/OUT. */
  type: 'IN' | 'OUT';
  qty: string;
  unit: string;
  /** Obligatorio en `IN`. En `OUT` se ignora: manda el promedio ponderado vigente. */
  unitCost?: string;
  refType: InventoryRefType;
  refId?: string;
  actorId: string;
}

/** Saldo vigente de un ítem, ya en Decimal. */
interface BalanceRow {
  id: string;
  qty: Decimal;
  avgCost: Decimal;
}

/**
 * Kardex (§3.2, D-028). **Único escritor** de `inventory_movements` e
 * `inventory_balances`: ningún otro módulo toca esas tablas. El movimiento y el saldo
 * se escriben en la misma transacción que la operación que los origina, por eso
 * `record` exige el `tx` del llamador en vez de abrir el suyo.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra un movimiento y actualiza el saldo con promedio ponderado.
   * Devuelve `null` si la línea de negocio es `NOOP` (§2.2: `services` no lleva stock),
   * que es un no-op explícito, no un error.
   */
  async record(
    tx: Prisma.TransactionClient,
    input: RecordMovementInput,
  ): Promise<InventoryMovement | null> {
    const line = await tx.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    if (line.inventoryStrategy === InventoryStrategy.NOOP) return null;

    const qty = toDecimal(input.qty);
    if (!qty.isFinite() || qty.lte(0)) {
      throw new BadRequestException('La cantidad de un movimiento debe ser mayor a cero');
    }

    const balance = await this.lockBalance(tx, input);

    let unitCost: Decimal;
    let newQty: Decimal;
    let newAvgCost: Decimal;

    if (input.type === 'IN') {
      if (input.unitCost === undefined) {
        throw new BadRequestException('Una entrada de inventario necesita su costo unitario');
      }
      unitCost = toDecimal(input.unitCost);
      if (unitCost.isNegative()) {
        throw new BadRequestException('El costo unitario no puede ser negativo');
      }
      newQty = balance.qty.plus(qty);
      // Promedio ponderado (D-028). Con saldo previo <= 0 el promedio anterior no
      // aporta información: el costo de la entrada pasa a ser el promedio.
      newAvgCost = balance.qty.lte(0)
        ? unitCost
        : balance.qty.times(balance.avgCost).plus(qty.times(unitCost)).div(newQty);
    } else {
      if (qty.gt(balance.qty)) {
        throw new BadRequestException(
          `Stock insuficiente: hay ${balance.qty.toFixed(3)} y se intentan retirar ${qty.toFixed(3)}`,
        );
      }
      // Una salida no cambia el costo promedio; sale valorizada al promedio vigente.
      unitCost = balance.avgCost;
      newQty = balance.qty.minus(qty);
      newAvgCost = balance.avgCost;
    }

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        qty: toFixedString(newQty, 'KG'),
        avgCost: toFixedString(newAvgCost, 'MONEY'),
        unit: input.unit,
      },
    });

    return tx.inventoryMovement.create({
      data: {
        businessLineId: input.businessLineId,
        itemType: input.itemType,
        itemId: input.itemId,
        type: input.type,
        qty: toFixedString(qty, 'KG'),
        unit: input.unit,
        unitCost: toFixedString(unitCost, 'MONEY'),
        totalCost: toFixedString(qty.times(unitCost), 'MONEY'),
        refType: input.refType,
        refId: input.refId ?? null,
        actorId: input.actorId,
      },
    });
  }

  /**
   * Crea el saldo si no existe y lo bloquea (`FOR UPDATE`) hasta el fin de la
   * transacción, para que dos movimientos concurrentes del mismo ítem no calculen el
   * promedio ponderado sobre el mismo saldo previo.
   */
  private async lockBalance(
    tx: Prisma.TransactionClient,
    input: RecordMovementInput,
  ): Promise<BalanceRow> {
    await tx.$executeRaw`
      INSERT INTO "inventory_balances"
        ("id", "business_line_id", "item_type", "item_id", "qty", "avg_cost", "unit", "updated_at")
      VALUES (
        ${randomUUID()}::uuid,
        ${input.businessLineId}::uuid,
        ${input.itemType}::"InventoryItemType",
        ${input.itemId}::uuid,
        0, 0, ${input.unit}, NOW()
      )
      ON CONFLICT ("item_type", "item_id") DO NOTHING
    `;

    const rows = await tx.$queryRaw<
      { id: string; qty: Prisma.Decimal; avg_cost: Prisma.Decimal }[]
    >`
      SELECT "id", "qty", "avg_cost"
      FROM "inventory_balances"
      WHERE "item_type" = ${input.itemType}::"InventoryItemType"
        AND "item_id" = ${input.itemId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('No se pudo obtener el saldo de inventario del ítem');

    return {
      id: row.id,
      qty: toDecimal(row.qty.toString()),
      avgCost: toDecimal(row.avg_cost.toString()),
    };
  }

  /** Saldo vigente de un ítem, o `null` si nunca tuvo movimientos. */
  async getBalance(
    itemType: InventoryItemType,
    itemId: string,
  ): Promise<{ qty: Decimal; avgCost: Decimal } | null> {
    const balance = await this.prisma.inventoryBalance.findUnique({
      where: { itemType_itemId: { itemType, itemId } },
    });
    if (!balance) return null;
    return {
      qty: toDecimal(balance.qty.toString()),
      avgCost: toDecimal(balance.avgCost.toString()),
    };
  }

  /** Inventario valorizado (RF-51, base de RF-90). */
  async findBalances(query: InventoryQuery): Promise<InventoryBalanceDto[]> {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        itemType: query.itemType,
        itemId: query.itemId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
      },
      include: { businessLine: true },
      orderBy: { updatedAt: 'desc' },
    });

    const labels = await this.resolveItemLabels(balances);
    return balances.map((b) => {
      const qty = toDecimal(b.qty.toString());
      const avgCost = toDecimal(b.avgCost.toString());
      const label = labels.get(labelKey(b.itemType, b.itemId));
      return {
        id: b.id,
        businessLine: toSharedLineCode(b.businessLine.code),
        itemType: b.itemType,
        itemId: b.itemId,
        itemLabel: label?.code ?? b.itemId,
        itemName: label?.name ?? '',
        qty: qty.toFixed(3),
        unit: b.unit,
        avgCost: avgCost.toFixed(4),
        totalValue: toFixedString(qty.times(avgCost), 'MONEY'),
        updatedAt: b.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Movimientos de kardex (RF-53). Cuando la consulta apunta a un ítem concreto se
   * devuelve además el saldo corrido después de cada movimiento, recalculado en orden
   * cronológico; en un listado mezclado ese saldo no tiene sentido y va en `null`.
   */
  async findMovements(query: InventoryQuery): Promise<InventoryMovementDto[]> {
    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        itemType: query.itemType,
        itemId: query.itemId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        at: {
          gte: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
          lte: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
        },
      },
      include: { businessLine: true },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: 2000,
    });

    const singleItem = Boolean(query.itemId && query.itemType);
    const labels = await this.resolveItemLabels(movements);
    const actors = await this.resolveActorNames(movements);

    let runningQty = new Decimal(0);
    let runningAvg = new Decimal(0);

    const dtos = movements.map((m) => {
      const qty = toDecimal(m.qty.toString());
      const unitCost = toDecimal(m.unitCost.toString());
      if (singleItem) {
        if (m.type === 'IN') {
          const next = runningQty.plus(qty);
          runningAvg = runningQty.lte(0)
            ? unitCost
            : runningQty.times(runningAvg).plus(qty.times(unitCost)).div(next);
          runningQty = next;
        } else if (m.type === 'OUT') {
          runningQty = runningQty.minus(qty);
        }
      }
      const label = labels.get(labelKey(m.itemType, m.itemId));
      return {
        id: m.id.toString(),
        businessLine: toSharedLineCode(m.businessLine.code),
        itemType: m.itemType,
        itemId: m.itemId,
        itemLabel: label?.code ?? m.itemId,
        type: m.type,
        qty: qty.toFixed(3),
        unit: m.unit,
        unitCost: unitCost.toFixed(4),
        totalCost: m.totalCost.toFixed(4),
        refType: m.refType,
        refId: m.refId,
        reversalOfId: m.reversalOfId === null ? null : m.reversalOfId.toString(),
        actorId: m.actorId,
        actorName: m.actorId ? (actors.get(m.actorId) ?? null) : null,
        at: m.at.toISOString(),
        balanceQty: singleItem ? runningQty.toFixed(3) : null,
        balanceAvgCost: singleItem ? toFixedString(runningAvg, 'MONEY') : null,
      } satisfies InventoryMovementDto;
    });

    // Más reciente primero para la vista; el cálculo del saldo corrido necesitaba el orden inverso.
    return dtos.reverse();
  }

  /** Resuelve el código y nombre legible de cada ítem referido (SKU o código de bobina). */
  private async resolveItemLabels(
    rows: { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, { code: string; name: string }>> {
    const productIds = [
      ...new Set(rows.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId)),
    ];
    const coilIds = [...new Set(rows.filter((r) => r.itemType === 'COIL').map((r) => r.itemId))];

    const [products, coils] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true, name: true },
          })
        : Promise.resolve([]),
      coilIds.length
        ? this.prisma.coil.findMany({
            where: { id: { in: coilIds } },
            select: { id: true, code: true, typeKey: true },
          })
        : Promise.resolve([]),
    ]);

    const labels = new Map<string, { code: string; name: string }>();
    for (const p of products) {
      labels.set(labelKey('PRODUCT', p.id), { code: p.sku, name: p.name });
    }
    for (const c of coils) {
      labels.set(labelKey('COIL', c.id), { code: c.code, name: c.typeKey });
    }
    return labels;
  }

  private async resolveActorNames(
    rows: { actorId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

function labelKey(itemType: InventoryItemType, itemId: string): string {
  return `${itemType}:${itemId}`;
}
