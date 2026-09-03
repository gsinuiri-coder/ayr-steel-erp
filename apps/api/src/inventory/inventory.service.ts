import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryItemType,
  InventoryStrategy,
  Prisma,
  type InventoryMovement,
  type InventoryMovementType,
  type InventoryRefType,
} from '@prisma/client';
import {
  Decimal,
  toDecimal,
  toFixedString,
  type BusinessLine,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
  type InventorySummaryDto,
  type InventorySummaryRowDto,
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
  /** `ADJUST` no se emite por acá: mueve costo sin cantidad y tiene su propio método. */
  type: 'IN' | 'OUT';
  qty: string;
  unit: string;
  /** Obligatorio en `IN`. En `OUT` se ignora: manda el promedio ponderado vigente. */
  unitCost?: string;
  refType: InventoryRefType;
  refId?: string;
  /** Motivo escrito por el usuario (merma, ajuste). Se guarda tal cual en el kardex. */
  notes?: string;
  actorId: string;
}

/**
 * Ajuste de **costo** sin cambio de cantidad (D-043, landed cost). `amountPen` es el
 * monto en soles que se suma al valor del saldo; puede ser negativo si se está
 * corrigiendo hacia abajo, pero el valor del saldo nunca queda por debajo de cero.
 */
export interface AdjustCostInput {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
  amountPen: string;
  refType: InventoryRefType;
  refId?: string;
  notes?: string;
  actorId: string;
}

/** Saldo vigente de un ítem, ya en Decimal. */
interface BalanceRow {
  id: string;
  qty: Decimal;
  avgCost: Decimal;
  unit: string;
}

/** Coordenadas de un ítem en el kardex; lo mínimo para bloquear su saldo. */
interface ItemRef {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
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

    if (balance.unit !== input.unit && !balance.qty.isZero()) {
      // Mezclar unidades en el mismo saldo (kilos con unidades) haría del promedio y del
      // valorizado un número sin significado.
      throw new BadRequestException(
        `El ítem ya tiene saldo en ${balance.unit}: no se puede mover en ${input.unit}`,
      );
    }

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
        notes: input.notes ?? null,
        actorId: input.actorId,
      },
    });
  }

  /**
   * Ajuste de costo sin movimiento de cantidad (D-043). El movimiento guarda en `qty`
   * los kilos afectados —el `CHECK qty > 0` de la base sigue valiendo— y en `unitCost`
   * el delta por kilo, de modo que `totalCost` es exactamente el monto imputado.
   * Devuelve `null` en líneas `NOOP` y también cuando el ítem no tiene saldo: un costo
   * repartido sobre cero kilos no tiene dónde ir y reescribir el pasado no es opción.
   */
  async adjustCost(
    tx: Prisma.TransactionClient,
    input: AdjustCostInput,
  ): Promise<InventoryMovement | null> {
    const line = await tx.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    if (line.inventoryStrategy === InventoryStrategy.NOOP) return null;

    const amount = toDecimal(input.amountPen);
    if (!amount.isFinite()) throw new BadRequestException('Monto de ajuste inválido');
    if (amount.isZero()) return null;

    const balance = await this.lockBalance(tx, input);
    if (balance.qty.lte(0)) return null;

    // El valor del saldo no puede quedar negativo: un ajuste a la baja mayor que el
    // valor en stock significaría que se está descontando costo que ya salió.
    const currentValue = balance.qty.times(balance.avgCost);
    const newValue = currentValue.plus(amount);
    if (newValue.isNegative()) {
      throw new BadRequestException(
        `El ajuste deja el inventario del ítem con valor negativo (${currentValue.toFixed(2)} en stock)`,
      );
    }
    const newAvgCost = newValue.div(balance.qty);

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: { avgCost: toFixedString(newAvgCost, 'MONEY'), unit: balance.unit },
    });

    return tx.inventoryMovement.create({
      data: {
        businessLineId: input.businessLineId,
        itemType: input.itemType,
        itemId: input.itemId,
        type: 'ADJUST',
        qty: toFixedString(balance.qty, 'KG'),
        unit: balance.unit,
        unitCost: toFixedString(amount.div(balance.qty), 'MONEY'),
        totalCost: toFixedString(amount, 'MONEY'),
        refType: input.refType,
        refId: input.refId ?? null,
        notes: input.notes ?? null,
        actorId: input.actorId,
      },
    });
  }

  /**
   * Anula un movimiento emitiendo su inverso (§3.2: nunca `UPDATE` ni `DELETE`). El
   * inverso arrastra el **mismo valor** que el original, no el promedio del momento:
   * revertir un ingreso tiene que sacar del saldo exactamente el costo que metió, o
   * el promedio ponderado quedaría contaminado por la anulación.
   *
   * Idempotente: `inventory_movements.reversal_of_id` es único, así que dos reversas
   * simultáneas del mismo movimiento no pueden convivir; la segunda choca contra el
   * índice y se traduce a un 409 legible.
   */
  async reverse(
    tx: Prisma.TransactionClient,
    movementId: bigint,
    actorId: string,
    reason: string,
  ): Promise<InventoryMovement> {
    const original = await tx.inventoryMovement.findUnique({ where: { id: movementId } });
    if (!original) throw new NotFoundException('Movimiento de kardex no encontrado');
    if (original.reversalOfId !== null) {
      throw new BadRequestException('Un movimiento de anulación no se puede volver a anular');
    }
    const existing = await tx.inventoryMovement.findFirst({
      where: { reversalOfId: movementId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Ese movimiento ya fue anulado');
    }

    const item: ItemRef = {
      businessLineId: original.businessLineId,
      itemType: original.itemType,
      itemId: original.itemId,
      unit: original.unit,
    };
    const balance = await this.lockBalance(tx, item);
    const origQty = toDecimal(original.qty.toString());
    const origValue = toDecimal(original.totalCost.toString());
    const currentValue = balance.qty.times(balance.avgCost);

    let type: InventoryMovementType;
    let qty: Decimal;
    let unitCost: Decimal;
    let totalCost: Decimal;
    let newQty: Decimal;
    let newValue: Decimal;

    if (original.type === 'IN') {
      if (origQty.gt(balance.qty)) {
        throw new BadRequestException(
          `No se puede anular el ingreso: quedan ${balance.qty.toFixed(3)} de los ${origQty.toFixed(3)} que ingresaron`,
        );
      }
      type = 'OUT';
      qty = origQty;
      unitCost = toDecimal(original.unitCost.toString());
      totalCost = origValue;
      newQty = balance.qty.minus(origQty);
      newValue = currentValue.minus(origValue);
    } else if (original.type === 'OUT') {
      type = 'IN';
      qty = origQty;
      unitCost = toDecimal(original.unitCost.toString());
      totalCost = origValue;
      newQty = balance.qty.plus(origQty);
      newValue = currentValue.plus(origValue);
    } else {
      // Un ADJUST solo movió valor. Su reversa saca la parte de ese valor que TODAVÍA
      // está en el saldo: el ajuste repartió `origValue` sobre `origQty` kilos, así que
      // si hoy quedan menos, lo que sigue adentro es la fracción proporcional. Sacar el
      // monto completo dejaría el promedio por debajo del costo real del stock que
      // sobrevive, y ese error viaja al precio sugerido (D-032) y al costeo (D-035).
      if (balance.qty.lte(0)) {
        throw new BadRequestException(
          'No se puede anular el ajuste de costo: el ítem ya no tiene saldo',
        );
      }
      const surviving = Decimal.min(balance.qty, origQty);
      type = 'ADJUST';
      qty = balance.qty;
      totalCost = origValue.times(surviving).div(origQty).negated();
      unitCost = totalCost.div(balance.qty);
      newQty = balance.qty;
      newValue = currentValue.plus(totalCost);
    }

    if (newValue.isNegative()) {
      if (newQty.lte(0)) {
        // Sin kilos, un residuo negativo es ruido de redondeo del promedio guardado con
        // 4 decimales: el saldo vacío se cierra en cero y no hay nada que distorsionar.
        newValue = new Decimal(0);
      } else {
        // Con kilos en stock sí importa: recortarlo a cero en silencio dejaría el
        // valorizado por debajo del costo real sin error, sin auditoría y sin traza.
        throw new ConflictException(
          `No se puede anular el movimiento: sacaría ${origValue.toFixed(2)} de un saldo valorizado en ${currentValue.toFixed(2)}. Revisa los movimientos posteriores del ítem.`,
        );
      }
    }
    const newAvgCost = newQty.lte(0) ? new Decimal(0) : newValue.div(newQty);

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        qty: toFixedString(newQty, 'KG'),
        avgCost: toFixedString(newAvgCost, 'MONEY'),
        unit: balance.unit,
      },
    });

    try {
      return await tx.inventoryMovement.create({
        data: {
          businessLineId: original.businessLineId,
          itemType: original.itemType,
          itemId: original.itemId,
          type,
          qty: toFixedString(qty, 'KG'),
          unit: original.unit,
          unitCost: toFixedString(unitCost, 'MONEY'),
          totalCost: toFixedString(totalCost, 'MONEY'),
          refType: original.refType,
          refId: original.refId,
          notes: reason,
          reversalOfId: original.id,
          actorId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ese movimiento ya fue anulado por otra operación');
      }
      throw err;
    }
  }

  /**
   * Crea el saldo si no existe y lo bloquea (`FOR UPDATE`) hasta el fin de la
   * transacción, para que dos movimientos concurrentes del mismo ítem no calculen el
   * promedio ponderado sobre el mismo saldo previo.
   */
  private async lockBalance(tx: Prisma.TransactionClient, input: ItemRef): Promise<BalanceRow> {
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
      {
        id: string;
        qty: Prisma.Decimal;
        avg_cost: Prisma.Decimal;
        unit: string;
        business_line_id: string;
      }[]
    >`
      SELECT "id", "qty", "avg_cost", "unit", "business_line_id"
      FROM "inventory_balances"
      WHERE "item_type" = ${input.itemType}::"InventoryItemType"
        AND "item_id" = ${input.itemId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('No se pudo obtener el saldo de inventario del ítem');
    // El saldo es único por (itemType, itemId), no por línea: un movimiento emitido con
    // la línea equivocada actualizaría el saldo de otra línea sin que nada avisara, y el
    // valorizado por línea (RF-51) empezaría a mentir en las dos.
    if (row.business_line_id !== input.businessLineId) {
      throw new BadRequestException(
        'El ítem ya tiene saldo en otra línea de negocio: un mismo ítem no se mueve en dos líneas',
      );
    }

    return {
      id: row.id,
      qty: toDecimal(row.qty.toString()),
      avgCost: toDecimal(row.avg_cost.toString()),
      unit: row.unit,
    };
  }

  /** Inventario valorizado (RF-51, base de RF-90). */
  async findBalances(query: InventoryQuery, showCosts: boolean): Promise<InventoryBalanceDto[]> {
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
      take: 1000,
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
        avgCost: showCosts ? avgCost.toFixed(4) : null,
        totalValue: showCosts ? toFixedString(qty.times(avgCost), 'MONEY') : null,
        updatedAt: b.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Inventario valorizado de una línea (RF-51). Las bobinas se agregan por `typeKey`
   * (RF-14) porque el partido cambia el ancho pero no el material; los productos de
   * catálogo van uno por SKU. Todo en soles (D-042).
   *
   * El promedio del grupo se calcula como valor total / cantidad total y no como
   * promedio de promedios: dos bobinas del mismo tipo con pesos distintos tienen que
   * pesar distinto en el costo agregado.
   */
  async summary(businessLine: BusinessLine, showCosts: boolean): Promise<InventorySummaryDto> {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { businessLine: { code: toPrismaLineCode(businessLine) } },
      take: 5000,
    });
    const withStock = balances.filter((b) => toDecimal(b.qty.toString()).gt(0));
    const labels = await this.resolveItemLabels(withStock);

    const groups = new Map<
      string,
      { itemType: InventoryItemType; name: string; unit: string; ids: string[] } & {
        qty: Decimal;
        value: Decimal;
      }
    >();

    for (const b of withStock) {
      const label = labels.get(labelKey(b.itemType, b.itemId));
      // Las bobinas se agrupan por su `typeKey`, que `resolveItemLabels` devuelve en
      // `name`; los productos, por su SKU, que es único dentro de la línea.
      const key = b.itemType === 'COIL' ? (label?.name ?? b.itemId) : (label?.code ?? b.itemId);
      const qty = toDecimal(b.qty.toString());
      const value = qty.times(toDecimal(b.avgCost.toString()));
      const current = groups.get(`${b.itemType}:${key}`);
      if (current) {
        current.qty = current.qty.plus(qty);
        current.value = current.value.plus(value);
        current.ids.push(b.itemId);
      } else {
        groups.set(`${b.itemType}:${key}`, {
          itemType: b.itemType,
          name: b.itemType === 'COIL' ? (label?.name ?? key) : (label?.name ?? ''),
          unit: b.unit,
          ids: [b.itemId],
          qty,
          value,
        });
      }
    }

    const rows: (InventorySummaryRowDto & { itemType: InventoryItemType })[] = [];
    for (const [mapKey, g] of groups) {
      rows.push({
        key: mapKey.slice(mapKey.indexOf(':') + 1),
        itemType: g.itemType,
        name: g.name,
        qty: g.qty.toFixed(3),
        unit: g.unit,
        avgCostPen: showCosts
          ? toFixedString(g.qty.lte(0) ? new Decimal(0) : g.value.div(g.qty), 'MONEY')
          : null,
        totalValuePen: showCosts ? toFixedString(g.value, 'MONEY') : null,
        itemCount: g.ids.length,
        // Solo tiene sentido enlazar al kardex de un ítem cuando el grupo es uno solo.
        itemId: g.ids.length === 1 ? (g.ids[0] ?? null) : null,
      });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));

    const total = rows.reduce(
      (acc, r) => acc.plus(toDecimal(r.totalValuePen ?? '0')),
      new Decimal(0),
    );
    return {
      businessLine,
      coils: rows.filter((r) => r.itemType === 'COIL'),
      products: rows.filter((r) => r.itemType === 'PRODUCT'),
      totalValuePen: showCosts ? toFixedString(total, 'MONEY') : null,
    };
  }

  /**
   * Movimientos de kardex (RF-53). Cuando la consulta apunta a un ítem concreto se
   * devuelve además el saldo corrido después de cada movimiento, recalculado en orden
   * cronológico; en un listado mezclado ese saldo no tiene sentido y va en `null`.
   */
  async findMovements(query: InventoryQuery, showCosts: boolean): Promise<InventoryMovementDto[]> {
    const singleItem = Boolean(query.itemId && query.itemType);

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
      include: { businessLine: true, reversals: { select: { id: true } } },
      // El kardex de un ítem concreto se lee completo y en orden cronológico, porque el
      // saldo corrido solo se puede calcular desde el primer movimiento. El listado
      // mezclado, en cambio, se recorta a los más RECIENTES: cortar por los más antiguos
      // mostraba justo lo contrario de lo que dice la vista.
      orderBy: singleItem ? [{ at: 'asc' }, { id: 'asc' }] : [{ at: 'desc' }, { id: 'desc' }],
      take: singleItem ? 10_000 : 500,
    });
    if (!singleItem) movements.reverse();

    const labels = await this.resolveItemLabels(movements);
    const actors = await this.resolveActorNames(movements);

    // El saldo corrido se lleva por VALOR, no recalculando el promedio ponderado a
    // partir del `unitCost` de cada fila: una anulación (RF-18, RF-21) saca del saldo
    // el costo exacto que el movimiento original metió, no el promedio del momento, y
    // un `ADJUST` mueve valor sin mover cantidad. Con `totalCost` las tres formas caen
    // en la misma cuenta y esta vista no puede divergir de `inventory_balances`.
    //
    // Con filtro `desde` hay que arrancar del saldo de apertura, no de cero: si no, un
    // kardex filtrado por fecha muestra cantidades y promedios que no son los del ítem.
    const opening = singleItem && query.from ? await this.openingBalance(query, query.from) : null;
    let runningQty = opening?.qty ?? new Decimal(0);
    let runningValue = opening?.value ?? new Decimal(0);

    const dtos = movements.map((m) => {
      const qty = toDecimal(m.qty.toString());
      const unitCost = toDecimal(m.unitCost.toString());
      const totalCost = toDecimal(m.totalCost.toString());
      if (singleItem) {
        if (m.type === 'IN') {
          runningQty = runningQty.plus(qty);
          runningValue = runningValue.plus(totalCost);
        } else if (m.type === 'OUT') {
          runningQty = runningQty.minus(qty);
          runningValue = runningValue.minus(totalCost);
        } else {
          runningValue = runningValue.plus(totalCost);
        }
        if (runningValue.isNegative()) runningValue = new Decimal(0);
      }
      const runningAvg = runningQty.lte(0) ? new Decimal(0) : runningValue.div(runningQty);
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
        unitCost: showCosts ? unitCost.toFixed(4) : null,
        totalCost: showCosts ? m.totalCost.toFixed(4) : null,
        refType: m.refType,
        refId: m.refId,
        notes: m.notes,
        reversalOfId: m.reversalOfId === null ? null : m.reversalOfId.toString(),
        reversedById: m.reversals[0] ? m.reversals[0].id.toString() : null,
        actorId: m.actorId,
        actorName: m.actorId ? (actors.get(m.actorId) ?? null) : null,
        at: m.at.toISOString(),
        balanceQty: singleItem ? runningQty.toFixed(3) : null,
        balanceAvgCost: singleItem && showCosts ? toFixedString(runningAvg, 'MONEY') : null,
      } satisfies InventoryMovementDto;
    });

    // Más reciente primero para la vista; el cálculo del saldo corrido necesitaba el orden inverso.
    return dtos.reverse();
  }

  /**
   * Saldo de un ítem justo antes de `from`, con la misma cuenta por valor que usa el
   * saldo corrido: entradas suman cantidad y valor, salidas restan ambas y los ajustes
   * solo mueven valor. Se calcula en SQL para no traer a memoria un histórico entero
   * que la vista después descarta.
   */
  private async openingBalance(
    query: InventoryQuery,
    from: string,
  ): Promise<{ qty: Decimal; value: Decimal }> {
    const rows = await this.prisma.$queryRaw<{ qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
      SELECT
        COALESCE(SUM(CASE "type" WHEN 'IN' THEN "qty" WHEN 'OUT' THEN -"qty" ELSE 0 END), 0) AS "qty",
        COALESCE(SUM(CASE "type" WHEN 'OUT' THEN -"total_cost" ELSE "total_cost" END), 0) AS "value"
      FROM "inventory_movements"
      WHERE "item_type" = ${query.itemType}::"InventoryItemType"
        AND "item_id" = ${query.itemId}::uuid
        AND "at" < ${new Date(`${from}T00:00:00.000Z`)}
    `;
    const row = rows[0];
    return {
      qty: toDecimal(row?.qty.toString() ?? '0'),
      value: Decimal.max(toDecimal(row?.value.toString() ?? '0'), new Decimal(0)),
    };
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
