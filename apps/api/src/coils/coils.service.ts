import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  Currency,
  InventoryRefType,
  ProductSource,
  Prisma,
  type Coil,
} from '@prisma/client';
import {
  businessToday,
  coilCode,
  coilProductName,
  coilSku,
  coilTypeKey,
  equivalentMeters,
  fromDateOnly,
  MAX_PAGE_SIZE,
  paginate,
  productionOrderCode,
  salesOrderCode,
  toDateOnly,
  toDecimal,
  toFixedString,
  toSkipTake,
  Unit,
  type CoilConsumptionDto,
  type CoilDto,
  type CoilQuery,
  type CoilSplitDto,
  type PaginatedResult,
} from '@ayr/shared';
import { toSharedLineCode, toPrismaLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildCoilPdf, buildCoilsReportPdf } from './coil-pdf';

/** Datos mínimos para dar de alta una bobina. Los códigos se derivan aquí, no los trae el llamador. */
export interface CreateCoilInput {
  businessLineId: string;
  supplierId: string;
  purchaseId?: string;
  purchaseItemId?: string;
  finishId: string;
  /**
   * D-085: color de la bobina. Las prepintadas lo llevan y las galvanizadas no; una hija de
   * partido o un fleje de corte **heredan el de la madre**, porque rolar o cortar no cambia
   * el color del material.
   */
  colorId?: string | null;
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
  /** `STRIP` cuando la crea un partido interno o una recepción de corte (D-049). */
  kind?: CoilKind;
  /**
   * D-116 (Fase 7e): estado con el que nace la bobina. Por defecto `OPEN` — el fleje y la
   * hija de un partido tienen que poder entrar directo a producción (D-060). Solo el alta
   * de una bobina nueva por compra o planilla manda `CLOSED` (el default que pide el
   * dueño); el usuario lo puede editar a `OPEN` en el propio formulario.
   */
  status?: CoilStatus;
  /** Fila de recepción de corte tercerizado que originó este fleje (RF-41, D-049). */
  cuttingOrderCoilId?: string;
  /**
   * D-124: día de negocio en que la bobina entró (`YYYY-MM-DD`, Lima). Por defecto hoy.
   * Una hija de partido, un fleje de corte o una bobina de compra la reciben de la
   * operación que las crea, para que madre e hija queden fechadas el mismo día.
   */
  operationDate?: string;
  /**
   * Costo en soles con el que la bobina entra al kardex, cuando no es simplemente
   * `unitCostPerKg × exchangeRate`. Lo usa el partido: las hijas entran al costo
   * promedio vigente de la madre, que ya puede incluir landed cost (D-043).
   */
  kardexUnitCostPen?: string;
  notes?: string;
}

/**
 * Datos que una tanda de altas comparte (partido, RF-15): proveedor, acabado y el
 * primer correlativo reservado. `create` los reusa en vez de volver a consultarlos y
 * de tomar el lock del proveedor una vez por hija.
 */
export interface CoilCreateContext {
  supplier: { code: string } | null;
  finish: { code: string; name: string } | null;
  /** Correlativo de ESTA bobina; el llamador lo incrementa por hija. */
  sequence: number;
  tradingProductEnsured: boolean;
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
  async create(
    tx: Prisma.TransactionClient,
    input: CreateCoilInput,
    preloaded?: CoilCreateContext,
  ): Promise<Coil> {
    const [supplier, finish] = preloaded
      ? [preloaded.supplier, preloaded.finish]
      : await Promise.all([
          tx.supplier.findUnique({ where: { id: input.supplierId } }),
          tx.finish.findUnique({ where: { id: input.finishId } }),
        ]);
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (!finish) throw new NotFoundException('Acabado no encontrado');

    const weightKg = toDecimal(input.weightKg);
    const unitCostPerKg = toDecimal(input.unitCostPerKg);
    const exchangeRate = toDecimal(input.exchangeRate);
    const totalCost = weightKg.times(unitCostPerKg);

    // El partido reserva los correlativos de golpe y precarga proveedor y acabado: sin
    // eso, cada hija repetía cuatro consultas y otro `UPDATE suppliers`, que retiene el
    // lock de la fila del proveedor y frena cualquier otra alta de bobina suya.
    const sequence = preloaded?.sequence ?? (await this.nextSequence(tx, input.supplierId));
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
        colorId: input.colorId ?? null,
        currency: input.currency,
        exchangeRate: toFixedString(exchangeRate, 'RATE'),
        unitCostPerKg: toFixedString(unitCostPerKg, 'MONEY'),
        totalCost: toFixedString(totalCost, 'MONEY'),
        totalCostPen: toFixedString(totalCost.times(exchangeRate), 'MONEY'),
        status: input.status ?? CoilStatus.OPEN,
        parentCoilId: input.parentCoilId ?? null,
        splitId: input.splitId ?? null,
        kind: input.kind ?? CoilKind.COIL,
        cuttingOrderCoilId: input.cuttingOrderCoilId ?? null,
        notes: input.notes ?? null,
        createdById: input.actorId,
        operationDate: toDateOnly(input.operationDate ?? businessToday()),
      },
    });

    // El producto de `trading` es uno por `typeKey`: en un partido todas las hijas
    // comparten acabado y espesor, así que basta asegurarlo una vez.
    if (!preloaded?.tradingProductEnsured) {
      await this.ensureTradingProduct(tx, finish, input.thicknessMm);
    }

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
      operationDate: input.operationDate,
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
  /**
   * Reserva `count` correlativos de una vez y devuelve el contexto que `create` reusa
   * para toda una tanda de hijas (RF-15). Un solo `UPDATE` sobre el proveedor en vez de
   * uno por hija: el lock de esa fila se toma y se suelta una sola vez.
   */
  async prepareBatch(
    tx: Prisma.TransactionClient,
    input: { supplierId: string; finishId: string; thicknessMm: string; count: number },
  ): Promise<CoilCreateContext> {
    const [supplier, finish] = await Promise.all([
      tx.supplier.findUnique({ where: { id: input.supplierId } }),
      tx.finish.findUnique({ where: { id: input.finishId } }),
    ]);
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (!finish) throw new NotFoundException('Acabado no encontrado');

    const last = await this.nextSequence(tx, input.supplierId, input.count);
    await this.ensureTradingProduct(tx, finish, input.thicknessMm);

    return {
      supplier,
      finish,
      // `nextSequence` devuelve el último reservado; el primero de la tanda es el que
      // sigue al valor previo.
      sequence: last - input.count + 1,
      tradingProductEnsured: true,
    };
  }

  private async nextSequence(
    tx: Prisma.TransactionClient,
    supplierId: string,
    count = 1,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ coil_seq: number }[]>`
      UPDATE "suppliers"
      SET "coil_seq" = "coil_seq" + ${count}
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

  /**
   * Bloquea la fila de la bobina hasta el fin de la transacción. La usan tanto
   * `CoilOperationsService` (partido, merma, edición, anulación) como `CuttingService`
   * (recepción de corte, RF-41): dos operaciones simultáneas sobre la misma bobina no
   * pueden calcular su plan sobre el mismo saldo/ancho antes de que ninguna escriba.
   */
  async lockCoil(tx: Prisma.TransactionClient, coilId: string): Promise<Coil> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "coils" WHERE "id" = ${coilId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('Bobina no encontrada');
    return tx.coil.findUniqueOrThrow({ where: { id: coilId } });
  }

  async findAll(query: CoilQuery): Promise<PaginatedResult<CoilDto>> {
    // D-121: el saldo vive en el kardex, no en la fila de la bobina, así que el filtro
    // sale de una subconsulta a `inventory_balances` en vez de una condición SQL directa.
    let availabilityIds: string[] | undefined;
    if (query.availability) {
      const balances = await this.prisma.inventoryBalance.findMany({
        where: {
          itemType: 'COIL',
          qty: query.availability === 'available' ? { gt: 0 } : { lte: 0 },
        },
        select: { itemId: true },
      });
      availabilityIds = balances.map((b) => b.itemId);
    }
    const where: Prisma.CoilWhereInput = {
      businessLine: query.businessLine ? { code: toPrismaLineCode(query.businessLine) } : undefined,
      finishId: query.finishId,
      status: query.statusNe ? { equals: query.status, not: query.statusNe } : query.status,
      supplierId: query.supplierId,
      thicknessMm: query.thicknessMm,
      kind: query.kind,
      ...(availabilityIds ? { id: { in: availabilityIds } } : {}),
      // `sin-color` es un filtro real y no la ausencia de filtro: es como se listan las
      // galvanizadas, que son justo las que un producto sin color puede montar (D-086).
      ...(query.colorId === undefined
        ? {}
        : { colorId: query.colorId === 'sin-color' ? null : query.colorId }),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { typeKey: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    const { skip, take } = toSkipTake(query);
    const [total, coils] = await Promise.all([
      this.prisma.coil.count({ where }),
      this.prisma.coil.findMany({
        where,
        include: COIL_RELATIONS,
        // D-124: por día de negocio, no por instante de grabación. Una bobina de agosto
        // cargada hoy tiene que aparecer entre las de agosto, no encabezando la lista.
        orderBy: [{ operationDate: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
    ]);
    return paginate(await this.toDtos(coils), total, query);
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

  /**
   * D-172 (T4): qué OP —y qué pedido detrás de ella— montaron esta bobina. La punta
   * opuesta del `consumptions` que ya trae `ProductionOrderDto` (RF-34, D-060): esa lista
   * las bobinas que una OP montó, esta lista las OP que montaron una bobina.
   */
  async findConsumptions(coilId: string): Promise<CoilConsumptionDto[]> {
    const rows = await this.prisma.productionOrderConsumption.findMany({
      where: { coilId },
      include: {
        productionOrder: {
          select: {
            id: true,
            seq: true,
            kind: true,
            status: true,
            product: { select: { sku: true, name: true } },
            reservation: {
              select: {
                salesOrder: {
                  select: { id: true, seq: true, customer: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => {
      const salesOrder = r.productionOrder.reservation?.salesOrder ?? null;
      return {
        id: r.id,
        productionOrderId: r.productionOrder.id,
        productionOrderCode: productionOrderCode(r.productionOrder.seq),
        productionOrderKind: r.productionOrder.kind,
        productionOrderStatus: r.productionOrder.status,
        productSku: r.productionOrder.product.sku,
        productName: r.productionOrder.product.name,
        assignedKg: r.assignedKg.toFixed(3),
        consumedKg: r.consumedKg.toFixed(3),
        salesOrderId: salesOrder?.id ?? null,
        salesOrderCode: salesOrder ? salesOrderCode(salesOrder.seq) : null,
        customerName: salesOrder?.customer.name ?? null,
        releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** PDF de una sola bobina (T6, D-173): identificación, saldo, OP y kardex. */
  async pdf(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const [coil, consumptions, movements] = await Promise.all([
      this.findOne(id),
      this.findConsumptions(id),
      this.inventory.findMovements(
        { itemType: 'COIL', itemId: id, page: 1, pageSize: MAX_PAGE_SIZE },
        true,
      ),
    ]);
    const buffer = await buildCoilPdf({
      code: coil.code,
      typeKey: coil.typeKey,
      businessLine: coil.businessLine,
      supplierName: coil.supplierName,
      finishLabel: `${coil.finishCode} — ${coil.finishName}`,
      colorName: coil.colorName,
      widthMm: coil.widthMm,
      thicknessMm: coil.thicknessMm,
      status: coil.status,
      weightKg: coil.weightKg,
      availableKg: coil.availableKg,
      avgCostPen: coil.avgCostPen,
      notes: coil.notes,
      operationDate: coil.operationDate,
      consumptions,
      movements: movements.items,
    });
    return { buffer, filename: `${coil.code}.pdf` };
  }

  /**
   * PDF del conjunto filtrado actual de la lista (T6, D-173): mismos filtros que `findAll`,
   * topado a `MAX_PAGE_SIZE` filas — el mismo techo por request que ya respeta cualquier
   * otro listado de la aplicación (D-113); el PDF avisa en el pie si el filtro trae más.
   */
  async reportPdf(query: CoilQuery): Promise<{ buffer: Buffer; filename: string }> {
    const page = await this.findAll({ ...query, page: 1, pageSize: MAX_PAGE_SIZE });
    const buffer = await buildCoilsReportPdf({
      generatedAt: businessToday(),
      totalMatched: page.total,
      rows: page.items,
    });
    return { buffer, filename: `bobinas-${businessToday()}.pdf` };
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
      // D-164: el promedio viaja junto con el saldo para que la pantalla pueda mostrar el
      // remanente valorizado antes de cerrar, sin una segunda consulta por bobina.
      select: { itemId: true, qty: true, avgCost: true },
    });
    const available = new Map(balances.map((b) => [b.itemId, b.qty.toFixed(3)]));
    const avgCost = new Map(balances.map((b) => [b.itemId, b.avgCost.toFixed(4)]));

    return coils.map((c) => {
      const availableKg = available.get(c.id) ?? '0.000';
      const meters = equivalentMeters(
        { widthMm: c.widthMm, thicknessMm: c.thicknessMm, densityFactor: c.finish.densityFactor },
        availableKg,
      );
      return {
        id: c.id,
        code: c.code,
        typeKey: c.typeKey,
        kind: c.kind,
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
        colorId: c.colorId,
        colorCode: c.color?.code ?? null,
        colorName: c.color?.name ?? null,
        colorHex: c.color?.hexColor ?? null,
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
        availableKg,
        avgCostPen: avgCost.get(c.id) ?? '0.0000',
        equivalentMeters: meters === null ? null : meters.toFixed(3),
        operationDate: fromDateOnly(c.operationDate),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });
  }
}

/** Relaciones que necesita `toDtos`. Una sola definición para lista y detalle. */
export const COIL_RELATIONS = {
  businessLine: true,
  supplier: { select: { name: true } },
  finish: { select: { code: true, name: true, densityFactor: true } },
  color: { select: { code: true, name: true, hexColor: true } },
  purchase: { select: { series: true, number: true } },
  parentCoil: { select: { code: true } },
} satisfies Prisma.CoilInclude;

type CoilWithRelations = Coil & {
  businessLine: { code: BusinessLineCode };
  supplier: { name: string };
  finish: { code: string; name: string; densityFactor: Prisma.Decimal };
  color: { code: string; name: string; hexColor: string } | null;
  purchase: { series: string; number: string } | null;
  parentCoil: { code: string } | null;
};
