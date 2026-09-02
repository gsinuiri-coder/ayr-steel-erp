import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  Currency,
  InventoryRefType,
  ProductSource,
  Prisma,
  type Coil,
} from '@prisma/client';
import {
  coilCode,
  coilProductName,
  coilSku,
  coilTypeKey,
  toDecimal,
  toFixedString,
  Unit,
  type CoilDto,
  type CoilQuery,
  type CoilSplitDto,
} from '@ayr/shared';
import { toSharedLineCode, toPrismaLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

/** Datos mínimos para dar de alta una bobina. Los códigos se derivan aquí, no los trae el llamador. */
export interface CreateCoilInput {
  businessLineId: string;
  supplierId: string;
  purchaseId?: string;
  purchaseItemId?: string;
  finishId: string;
  weightKg: string;
  widthMm: string;
  thicknessMm: string;
  currency: Currency;
  exchangeRate: string;
  /** Costo por kg SIN IGV (D-038). */
  unitCostPerKg: string;
  refType: InventoryRefType;
  refId?: string;
  actorId: string;
  /** Bobina madre y partido que la originaron (RF-15). */
  parentCoilId?: string;
  splitId?: string;
  /**
   * Costo en soles con el que la bobina entra al kardex, cuando no es simplemente
   * `unitCostPerKg × exchangeRate`. Lo usa el partido: las hijas entran al costo
   * promedio vigente de la madre, que ya puede incluir landed cost (D-043).
   */
  kardexUnitCostPen?: string;
  notes?: string;
}

/**
 * Bobinas (RF-10..RF-14). El alta llega siempre desde una de las tres vías de Fase 2a
 * (compra manual, XML de factura, planilla); no hay creación suelta por HTTP.
 * Toda alta emite su entrada de kardex vía `InventoryService` (§3.2).
 */
@Injectable()
export class CoilsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Crea la bobina dentro de la transacción del llamador: el código correlativo
   * (RF-13), el producto de catálogo para venta directa (D-037) y el movimiento de
   * kardex tienen que entrar o fallar juntos.
   */
  async create(tx: Prisma.TransactionClient, input: CreateCoilInput): Promise<Coil> {
    const [supplier, finish] = await Promise.all([
      tx.supplier.findUnique({ where: { id: input.supplierId } }),
      tx.finish.findUnique({ where: { id: input.finishId } }),
    ]);
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (!finish) throw new NotFoundException('Acabado no encontrado');

    const weightKg = toDecimal(input.weightKg);
    const unitCostPerKg = toDecimal(input.unitCostPerKg);
    const exchangeRate = toDecimal(input.exchangeRate);
    const totalCost = weightKg.times(unitCostPerKg);

    const sequence = await this.nextSequence(tx, input.supplierId);
    const typeKey = coilTypeKey(finish.code, input.thicknessMm);

    const coil = await tx.coil.create({
      data: {
        code: coilCode({
          supplierCode: supplier.code,
          finishCode: finish.code,
          thicknessMm: input.thicknessMm,
          weightKg: input.weightKg,
          sequence,
        }),
        typeKey,
        businessLineId: input.businessLineId,
        supplierId: input.supplierId,
        purchaseId: input.purchaseId ?? null,
        purchaseItemId: input.purchaseItemId ?? null,
        finishId: input.finishId,
        weightKg: toFixedString(weightKg, 'KG'),
        widthMm: toFixedString(input.widthMm, 'MM'),
        thicknessMm: toFixedString(input.thicknessMm, 'MM'),
        currency: input.currency,
        exchangeRate: toFixedString(exchangeRate, 'RATE'),
        unitCostPerKg: toFixedString(unitCostPerKg, 'MONEY'),
        totalCost: toFixedString(totalCost, 'MONEY'),
        totalCostPen: toFixedString(totalCost.times(exchangeRate), 'MONEY'),
        parentCoilId: input.parentCoilId ?? null,
        splitId: input.splitId ?? null,
        notes: input.notes ?? null,
        createdById: input.actorId,
      },
    });

    await this.ensureTradingProduct(tx, finish, input.thicknessMm);

    const movement = await this.inventory.record(tx, {
      businessLineId: input.businessLineId,
      itemType: 'COIL',
      itemId: coil.id,
      type: 'IN',
      qty: toFixedString(weightKg, 'KG'),
      unit: Unit.KGM,
      // El kardex se lleva siempre en soles (D-042). La bobina conserva su moneda y su
      // tipo de cambio para el documento; el promedio ponderado necesita una sola escala.
      unitCost: toFixedString(
        input.kardexUnitCostPen ?? unitCostPerKg.times(exchangeRate),
        'MONEY',
      ),
      refType: input.refType,
      refId: input.refId,
      actorId: input.actorId,
    });
    if (!movement) {
      // Solo pasaría en una línea `NOOP` (§2.2), donde una bobina no tiene sentido:
      // sin este corte quedaría una fila de bobina con saldo cero para siempre.
      throw new BadRequestException(
        'La línea de negocio de la bobina no lleva inventario: no puede tener bobinas',
      );
    }

    return coil;
  }

  /**
   * Correlativo por proveedor del código RF-13. El `UPDATE ... RETURNING` toma el
   * lock de la fila del proveedor, así que dos altas concurrentes del mismo proveedor
   * reciben números distintos sin necesidad de una tabla de contadores aparte.
   */
  private async nextSequence(tx: Prisma.TransactionClient, supplierId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ coil_seq: number }[]>`
      UPDATE "suppliers"
      SET "coil_seq" = "coil_seq" + 1
      WHERE "id" = ${supplierId}::uuid
      RETURNING "coil_seq"
    `;
    const seq = rows[0]?.coil_seq;
    if (seq === undefined) throw new NotFoundException('Proveedor no encontrado');
    return seq;
  }

  /**
   * D-037: la bobina sin transformar se vende como un producto de la línea `trading`
   * con SKU `BOB{finishCode}{thicknessMm}`, uno por `typeKey`. Se crea al dar de alta
   * la primera bobina de ese tipo; si ya existe, no se toca.
   */
  private async ensureTradingProduct(
    tx: Prisma.TransactionClient,
    finish: { code: string; name: string },
    thicknessMm: string,
  ): Promise<void> {
    const trading = await tx.businessLine.findUnique({
      where: { code: BusinessLineCode.TRADING },
    });
    if (!trading) return;

    const sku = coilSku(finish.code, thicknessMm);
    await tx.product.upsert({
      where: { businessLineId_sku: { businessLineId: trading.id, sku } },
      create: {
        businessLineId: trading.id,
        sku,
        name: coilProductName(finish.name, thicknessMm),
        unit: Unit.KGM,
        source: ProductSource.PURCHASED,
      },
      update: {},
    });
  }

  async findAll(query: CoilQuery): Promise<CoilDto[]> {
    const coils = await this.prisma.coil.findMany({
      where: {
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        finishId: query.finishId,
        status: query.status,
        supplierId: query.supplierId,
        thicknessMm: query.thicknessMm,
        ...(query.search
          ? {
              OR: [
                { code: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                { typeKey: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              ],
            }
          : {}),
      },
      include: COIL_RELATIONS,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return this.toDtos(coils);
  }

  async findOne(id: string): Promise<CoilDto> {
    const coil = await this.prisma.coil.findUnique({
      where: { id },
      include: COIL_RELATIONS,
    });
    if (!coil) throw new NotFoundException('Bobina no encontrada');
    const [dto] = await this.toDtos([coil]);
    if (!dto) throw new NotFoundException('Bobina no encontrada');
    return dto;
  }

  /** Bobinas hijas nacidas de partidos de esta bobina (RF-15), incluidas las revertidas. */
  async findChildren(parentCoilId: string): Promise<CoilDto[]> {
    const coils = await this.prisma.coil.findMany({
      where: { parentCoilId },
      include: COIL_RELATIONS,
      orderBy: { createdAt: 'asc' },
    });
    return this.toDtos(coils);
  }

  /** Partidos de una bobina (RF-15/RF-16), con sus hijas, para la vista de detalle. */
  async findSplits(parentCoilId: string): Promise<CoilSplitDto[]> {
    const splits = await this.prisma.coilSplit.findMany({
      where: { parentCoilId },
      include: {
        parentCoil: { select: { code: true } },
        children: {
          select: { id: true, code: true, widthMm: true, weightKg: true, status: true },
          orderBy: { code: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const actorNames = await this.resolveActorNames(splits.map((s) => s.createdById));

    return splits.map((s) => ({
      id: s.id,
      parentCoilId: s.parentCoilId,
      parentCoilCode: s.parentCoil.code,
      splitWeightKg: s.splitWeightKg.toFixed(3),
      kerfLossMm: s.kerfLossMm.toFixed(2),
      kerfLossKg: s.kerfLossKg.toFixed(3),
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      createdByName: actorNames.get(s.createdById) ?? null,
      revertedAt: s.revertedAt ? s.revertedAt.toISOString() : null,
      children: s.children.map((c) => ({
        id: c.id,
        code: c.code,
        widthMm: c.widthMm.toFixed(2),
        weightKg: c.weightKg.toFixed(3),
        status: c.status,
      })),
    }));
  }

  private async resolveActorNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Adjunta a cada bobina sus kilos disponibles según el kardex (no según `weightKg`). */
  private async toDtos(coils: CoilWithRelations[]): Promise<CoilDto[]> {
    if (coils.length === 0) return [];
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
      select: { itemId: true, qty: true },
    });
    const available = new Map(balances.map((b) => [b.itemId, b.qty.toFixed(3)]));

    return coils.map((c) => ({
      id: c.id,
      code: c.code,
      typeKey: c.typeKey,
      businessLine: toSharedLineCode(c.businessLine.code),
      supplierId: c.supplierId,
      supplierName: c.supplier.name,
      purchaseId: c.purchaseId,
      purchaseLabel: c.purchase ? `${c.purchase.series}-${c.purchase.number}` : null,
      finishId: c.finishId,
      finishCode: c.finish.code,
      finishName: c.finish.name,
      weightKg: c.weightKg.toFixed(3),
      widthMm: c.widthMm.toFixed(2),
      thicknessMm: c.thicknessMm.toFixed(2),
      currency: c.currency,
      exchangeRate: c.exchangeRate.toFixed(4),
      unitCostPerKg: c.unitCostPerKg.toFixed(4),
      totalCost: c.totalCost.toFixed(4),
      totalCostPen: c.totalCostPen.toFixed(4),
      status: c.status,
      parentCoilId: c.parentCoilId,
      parentCoilCode: c.parentCoil?.code ?? null,
      splitId: c.splitId,
      notes: c.notes,
      availableKg: available.get(c.id) ?? '0.000',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }
}

/** Relaciones que necesita `toDtos`. Una sola definición para lista y detalle. */
export const COIL_RELATIONS = {
  businessLine: true,
  supplier: { select: { name: true } },
  finish: { select: { code: true, name: true } },
  purchase: { select: { series: true, number: true } },
  parentCoil: { select: { code: true } },
} satisfies Prisma.CoilInclude;

type CoilWithRelations = Coil & {
  businessLine: { code: BusinessLineCode };
  supplier: { name: string };
  finish: { code: string; name: string };
  purchase: { series: string; number: string } | null;
  parentCoil: { code: string } | null;
};
