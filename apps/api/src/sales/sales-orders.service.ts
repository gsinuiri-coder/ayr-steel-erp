import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoilKind,
  CoilStatus,
  FiscalDocType,
  Prisma,
  ProductionOrderStatus,
  ProductionReportStatus,
  QuotationStatus,
  ReservationStatus,
  SalesOrderOrigin,
  SalesOrderStatus,
  TemporaryReservationStatus,
  InventoryItemType as InventoryItemTypeEnum,
  type InventoryItemType,
  type InventoryStrategy,
} from '@prisma/client';
import {
  businessToday,
  carriesInventory,
  COIL_BUSINESS_LINES,
  DEFAULT_TEMPORARY_RESERVATION_BUSINESS_DAYS,
  Decimal,
  temporaryReservationExpiry,
  capToQuotationValidity,
  type ConfirmPreviewDto,
  type ConfirmPreviewLineDto,
  type QuotationTemporaryReservationDto,
  type SalesSettingsDto,
  type TemporaryReservationLineDto,
  type TemporaryReservationListItemDto,
  type UpdateSalesSettingsInput,
  DERIVED_FILTER_FETCH_CAP,
  describePieces,
  fromDateOnly,
  isQuotationExpired,
  kgPerMeter,
  paginate,
  rawMaterialLabel,
  productionOrderCode,
  queueSemaphore,
  quotationCode,
  RESERVATION_STALE_DAYS,
  Role,
  STANDING_DOCUMENT_STATUSES,
  salesOrderCode,
  toDecimal,
  toFixedString,
  toSkipTake,
  Unit,
  type BusinessLine,
  type CreateSalesOrderInput,
  type PaginatedResult,
  type LineWithoutOrderDto,
  type QueueSemaphore,
  type QueueStatus,
  type ReservationDto,
  type ReservationQuery,
  type SalesOrderDto,
  type SalesOrderListItemDto,
  type SalesOrderQuery,
  type ProductStockDto,
  type QuotationStockShortageDto,
  type RawMaterialStockDto,
  sellsByFixedLength,
  type SellableCoilDto,
  type StockPanelDto,
  type StockPanelQuery,
  type SellableCoilQuery,
  type OrderReadinessDto,
} from '@ayr/shared';
import { deriveOrderReadiness } from './order-readiness';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import type { RequestUser } from '../auth/auth.types';
import { assertSellerAccess, quotationSellerWhere, sellerWhere } from '../auth/seller-scope';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertStripsNotAssigned,
  findLiveStripAssignments,
} from '../production/production-assignments';
import {
  derivePiecesPlan,
  roofingTheoreticalKg,
  type CoilGeometry,
} from '../production/roofing-math';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { RoofingProductionService } from '../production/roofing-production.service';
import {
  documentTotals,
  isMadeToOrder,
  orderedMeters,
  resolveSalesLines,
  ROOFING_PRODUCT_SELECT,
  roofingSpecThicknessMm,
  theoreticalKgForMeters,
  toSalesItemDto,
} from './sales-lines';
import { buildPlantOrderPdf } from './plant-order-pdf';
import { findPriceChanges } from './price-changes';
import {
  liveTemporaryWhere,
  reservedByItem,
  sweepExpiredTemporaryReservations,
} from './reserved-ledger';
import { computePriceFloors, type PriceFloorCandidate } from './price-floor';
import {
  assertRawMaterialInvariant,
  rawMaterialAvailability,
  rawMaterialSpecLabels,
  resolveRawMaterialSpec,
  findRawMaterialSpec,
  findRawMaterialSpecs,
  rawMaterialCoilIds,
  type RawMaterialSpecRef,
} from './raw-material';

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Orden binario estable para UUID, SKU y firmas internas; reproduce `Array.sort()` sin locale. */
export function compareTechnicalCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const orderInclude = {
  customer: { select: { id: true, name: true, docNumber: true } },
  quotation: { select: { id: true, seq: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: {
      // D-119: `businessLine` de cada producto arma `businessLines` del pedido (puede
      // mezclar líneas).
      product: { select: { sku: true, name: true, businessLine: { select: { code: true } } } },
      // D-083: copia congelada de los largos que se cotizaron.
      pieces: { orderBy: { lineNumber: 'asc' } },
    },
  },
  reservations: {
    orderBy: { createdAt: 'asc' },
    include: {
      salesOrder: {
        select: {
          seq: true,
          customer: { select: { name: true } },
          items: { select: { productId: true } },
        },
      },
      productionOrders: {
        // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
        // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
        // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
        // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
        // fabricarla.
        where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
        select: { id: true, seq: true },
        take: 1,
      },
    },
  },
  /**
   * D-141: el comprobante importado del que nació el pedido. Es la mitad "pedido →
   * documento" del enlace bidireccional, y no hay columna nueva: se lee la misma relación
   * `fiscal_documents.sales_order_id` desde este lado.
   *
   * El filtro por `IMPORTED` es lo que la hace 1:1 de verdad. Sin él, un pedido normal que
   * después se facturó acá —dos comprobantes, uno anulado y otro emitido— habría llenado
   * este campo con cualquiera de los dos y el detalle habría dicho "importado de F001-…"
   * sobre un pedido que el ERP creó.
   */
  fiscalDocuments: {
    where: { origin: 'IMPORTED', archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, number: true },
    take: 1,
  },
} satisfies Prisma.SalesOrderInclude;

type OrderRow = Prisma.SalesOrderGetPayload<{ include: typeof orderInclude }>;
type ReservationRow = OrderRow['reservations'][number];

/** RF-S3/M2: lo mismo que `previewLinesOf` necesita de una cotización, para `findStockShortages`. */
const shortageQuotationInclude = {
  customer: { select: { name: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: {
        select: {
          sku: true,
          lengthMm: true,
          businessLine: { select: { inventoryStrategy: true } },
        },
      },
      pieces: { orderBy: { lineNumber: 'asc' } },
    },
  },
} satisfies Prisma.QuotationInclude;
type ShortageQuotation = Prisma.QuotationGetPayload<{ include: typeof shortageQuotationInclude }>;

/** Lo que cada línea resuelve para reservar, ya sin depender de la cotización que lo pidió. */
interface ShortageReserveInfo {
  reserveItemType: InventoryItemType;
  reserveItemId: string;
  reserveQty: string;
  reserveUnit: string;
}

/** Lo que puede cambiar el llamador de `createDirectInTx` (ver cada campo). */
export interface CreateDirectOptions {
  /**
   * Venta de mostrador (D-098/D-099). **No relaja nada**: cambia una regla por otra más
   * estricta — se salta `quotation_required` y a cambio exige que cada línea esté
   * respaldada por su propio producto.
   */
  counterSale?: boolean;
}

/** Lo que una línea (de pedido o de cotización) necesita para poder reservar. */
interface ReservableLine {
  lineNumber: number;
  productId: string;
  reserveItemType: InventoryItemType;
  reserveItemId: string;
  reserveQty: Prisma.Decimal | string;
  reserveUnit: string;
}

/** Las dos formas en que una fila nombra al ítem del kardex que reserva. */
type ReserveRef =
  | { itemType: InventoryItemType; itemId: string }
  | { reserveItemType: InventoryItemType; reserveItemId: string };

/**
 * Pedidos y ledger de reservas (RF-62; D-054, D-065, D-066).
 *
 * Confirmar una cotización crea el pedido **y** sus reservas en una sola transacción: si
 * una sola línea no tiene disponible, no se crea nada (D-054, "falla completa, nunca
 * parcial"). Anular el pedido libera las reservas por el mismo camino, y se bloquea
 * mientras una orden de producción viva esté fabricando con ese material.
 */
@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly roofing: RoofingProductionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // RF-62 — confirmar una cotización
  // -------------------------------------------------------------------------

  /**
   * Confirmar (acto del vendedor, D-054): crea el pedido y las reservas juntos.
   *
   * La vigencia se revalida acá aunque el job de vencimiento (D-069) exista: el job es una
   * comodidad de la lista, no la regla. Si el API estuvo dormido, una cotización vencida
   * seguiría figurando `EMITIDA` y sin este chequeo se podría confirmar.
   */
  async confirm(
    actor: RequestUser,
    quotationId: string,
    promisedDeliveryDate?: string,
  ): Promise<SalesOrderDto> {
    const orderId = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            seq: number;
            status: QuotationStatus;
            valid_until: Date | null;
            created_by_id: string;
            seller_id: string | null;
          }[]
        >`
        SELECT "id", "seq", "status", "valid_until", "created_by_id", "seller_id"
        FROM "quotations" WHERE "id" = ${quotationId}::uuid FOR UPDATE
      `;
        const head = rows[0];
        if (!head) throw new NotFoundException('Cotización no encontrada');
        assertSellerAccess(actor, head.seller_id, 'Cotización');

        if (head.status === QuotationStatus.CONFIRMED) {
          throw new ConflictException('La cotización ya fue confirmada');
        }
        if (head.status !== QuotationStatus.EMITTED) {
          throw new BadRequestException(
            head.status === QuotationStatus.EXPIRED
              ? 'La cotización está vencida: no se puede confirmar'
              : `Solo se confirma una cotización emitida; esta está ${head.status}`,
          );
        }
        // D-157: `null` es **sin vencimiento** y nunca bloquea. Es lo que hace confirmable una
        // cotización importada (D-152): el comprobante que la originó ya se vendió, así que
        // no hay vigencia que respetar, y con una fecha inventada este chequeo la rechazaba
        // en el paso siguiente a haberla creado.
        const validUntil = head.valid_until?.toISOString().slice(0, 10) ?? null;
        // `validUntil !== null` y no `isQuotationExpired`: son la misma condición, pero escrita
        // así el compilador sabe que el mensaje tiene una fecha que mostrar. Con la función,
        // el `?? ''` que hacía falta para compilar era otra vez la cadena vacía que D-157 vino
        // a sacar del medio — una rama muerta que el día que deje de serlo no avisa.
        if (validUntil !== null && isQuotationExpired(validUntil, businessToday())) {
          throw new BadRequestException(
            `La cotización venció el ${validUntil}: no se puede confirmar`,
          );
        }

        const quotation = await tx.quotation.findUniqueOrThrow({
          where: { id: quotationId },
          include: {
            items: {
              orderBy: { lineNumber: 'asc' },
              include: { pieces: { orderBy: { lineNumber: 'asc' } } },
            },
          },
        });
        if (quotation.items.length === 0) {
          throw new BadRequestException('La cotización no tiene líneas');
        }

        // Entre emitir y confirmar pueden pasar hasta 365 días (D-069): en ese lapso el
        // cliente o un producto pueden haberse dado de baja. `resolveSalesLines` lo valida
        // al **crear** la cotización, así que sin este chequeo la confirmación era la única
        // puerta del ciclo que no lo miraba, y el pedido nacía contra un maestro muerto.
        const customer = await tx.customer.findUniqueOrThrow({
          where: { id: quotation.customerId },
          select: { isActive: true, name: true },
        });
        if (!customer.isActive) {
          throw new BadRequestException(
            `El cliente ${customer.name} está desactivado: reactívalo o cotiza a otro cliente`,
          );
        }
        const inactive = await tx.product.findFirst({
          where: {
            id: { in: quotation.items.map((i) => i.productId) },
            isActive: false,
          },
          select: { sku: true },
        });
        if (inactive) {
          throw new BadRequestException(
            `El producto ${inactive.sku} está desactivado desde que se emitió la cotización: crea una nueva`,
          );
        }

        // D-134: las coordenadas de materia prima de una línea a medida se **recalculan**
        // acá, no se copian. La cotización ya guarda el agregado y los kilos teóricos, pero
        // vive hasta 365 días (D-069) y en ese plazo el catálogo puede haber cambiado el
        // color, la geometría o el espesor de la receta: confirmar contra lo congelado
        // prometería material que ya no es el que ese SKU necesita. Recalcular contra el
        // maestro de hoy también es lo que arregla solas las cotizaciones anteriores a
        // D-134, que guardaron `PRODUCT` + metros.
        const rawMaterialByLine = await this.resolveRawMaterial(
          tx,
          quotation.items.map((i) => ({
            lineNumber: i.lineNumber,
            productId: i.productId,
            qty: i.qty.toString(),
          })),
        );

        const order = await tx.salesOrder.create({
          data: {
            quotationId,
            sellerId: quotation.sellerId ?? quotation.createdById,
            customerId: quotation.customerId,
            status: SalesOrderStatus.CONFIRMED,
            issueDate: toDateOnly(businessToday()),
            subtotalPen: quotation.subtotalPen,
            igvPen: quotation.igvPen,
            totalPen: quotation.totalPen,
            notes: quotation.notes,
            createdById: actor.id,
            // D-096: única ventana en la que el vendedor la fija; después es de ADMINISTRADOR.
            promisedDeliveryDate: promisedDeliveryDate ? toDateOnly(promisedDeliveryDate) : null,
            items: {
              create: quotation.items.map((i) => {
                // D-134: si la línea es a medida, el agregado y los kilos que se acaban de
                // recalcular reemplazan lo que la cotización había congelado; el resto se
                // copia tal cual.
                const raw = rawMaterialByLine.get(i.lineNumber);
                return {
                  lineNumber: i.lineNumber,
                  productId: i.productId,
                  description: i.description,
                  qty: i.qty,
                  unit: i.unit,
                  listPricePen: i.listPricePen,
                  unitPricePen: i.unitPricePen,
                  // D-161: el pedido congela el valor por metro igual que congela el unitario.
                  valuePerMeterPen: i.valuePerMeterPen,
                  subtotalPen: i.subtotalPen,
                  igvPen: i.igvPen,
                  totalPen: i.totalPen,
                  reserveItemType: raw ? InventoryItemTypeEnum.RAW_MATERIAL : i.reserveItemType,
                  reserveItemId: raw ? raw.specId : i.reserveItemId,
                  reserveQty: raw ? raw.kg : i.reserveQty.toString(),
                  reserveUnit: raw ? Unit.KGM : i.reserveUnit,
                  // D-083: el pedido congela los largos igual que congela el precio; a partir
                  // de acá la cotización puede reemitirse y estos no se mueven.
                  ...(i.pieces.length > 0
                    ? {
                        pieces: {
                          create: i.pieces.map((p) => ({
                            lineNumber: p.lineNumber,
                            lengthMm: p.lengthMm,
                            qty: p.qty,
                          })),
                        },
                      }
                    : {}),
                };
              }),
            },
          },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });

        // D-186: la reserva temporal de la cotización **se convierte** en firme. Se termina
        // antes de reservar para que el guardrail de disponible no la cuente contra el mismo
        // pedido que viene a cumplirla; si algo de abajo falla, la transacción se deshace y
        // la temporal vuelve a estar vigente.
        await sweepExpiredTemporaryReservations(tx, { quotationId });
        const converted = await this.endTemporaryInTx(tx, quotationId, {
          status: TemporaryReservationStatus.CONVERTED,
          actorId: actor.id,
          reason: `Convertida en firme al confirmar ${salesOrderCode(order.seq)}`,
          salesOrderId: order.id,
        });

        await this.createReservations(tx, actor, order.id, order.items);

        // D-186: confirmar ya deja las órdenes en cola. Cada línea que reserva materia prima
        // es una línea que se fabrica contra el pedido (D-134/D-171), y su OP nace por el
        // mismo camino que el botón de una orden y la importación de ventas — con el plan de
        // corte por defecto, que es lo que el pedido encargó (D-084). Las líneas de stock, de
        // reventa o de servicios no generan nada.
        const productionReservations = await tx.reservation.findMany({
          where: {
            salesOrderId: order.id,
            status: ReservationStatus.ACTIVE,
            itemType: InventoryItemTypeEnum.RAW_MATERIAL,
          },
          select: { id: true },
          orderBy: { salesOrderItem: { lineNumber: 'asc' } },
        });
        const productionOrderIds: string[] = [];
        for (const reservation of productionReservations) {
          productionOrderIds.push(
            await this.roofing.createFromReservationInTx(tx, actor, {
              reservationId: reservation.id,
              operationDate: businessToday(),
              notes: null,
            }),
          );
        }

        await tx.quotation.update({
          where: { id: quotationId },
          data: { status: QuotationStatus.CONFIRMED, confirmedAt: new Date() },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.order.confirm',
          entity: 'sales_orders',
          entityId: order.id,
          after: {
            code: salesOrderCode(order.seq),
            quotationCode: quotationCode(head.seq),
            totalPen: order.totalPen.toFixed(4),
            convertedTemporaryLines: converted,
            productionOrders: productionOrderIds.length,
          },
        });
        return order.id;
      },
      // Una confirmación toma un lock por línea (hasta `MAX_SALES_ITEMS`) sobre bobinas y
      // saldos, y desde D-186 además crea una OP por línea a fabricar. Mismo presupuesto que
      // «generar todas las órdenes» (D-148), que hacía la mitad de este trabajo.
      { timeout: 60_000, maxWait: 15_000 },
    );

    return this.findOne(orderId);
  }

  /**
   * D-186: lo que confirmar va a hacer, **antes** de hacerlo: qué reserva cada línea, qué
   * órdenes de producción salen con qué plan, qué líneas no generan nada y, si falta
   * material, cuánto y dónde.
   *
   * Es una lectura sin locks: la palabra final la tiene `confirm`, bajo el lock de la
   * cotización y de las bobinas. Por eso los mismos rechazos que `confirm` lanza aparecen acá
   * como `blockers` — un botón deshabilitado con el motivo es mejor que un 400 después del
   * clic, pero no lo reemplaza.
   */
  async confirmPreview(actor: RequestUser, quotationId: string): Promise<ConfirmPreviewDto> {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id: quotationId },
      include: {
        customer: { select: { name: true, isActive: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          include: {
            product: {
              select: {
                sku: true,
                isActive: true,
                lengthMm: true,
                businessLine: { select: { inventoryStrategy: true } },
              },
            },
            pieces: { orderBy: { lineNumber: 'asc' } },
          },
        },
      },
    });
    if (!quotation) throw new NotFoundException('Cotización no encontrada');
    assertSellerAccess(actor, quotation.sellerId, 'Cotización');

    const blockers: string[] = [];
    const validUntil = quotation.validUntil?.toISOString().slice(0, 10) ?? null;
    if (quotation.status !== QuotationStatus.EMITTED) {
      blockers.push(`Solo se confirma una cotización emitida; esta está ${quotation.status}`);
    } else if (validUntil !== null && isQuotationExpired(validUntil, businessToday())) {
      blockers.push(`La cotización venció el ${validUntil}: renuévala editándola`);
    }
    if (!quotation.customer.isActive) {
      blockers.push(`El cliente ${quotation.customer.name} está desactivado`);
    }
    for (const item of quotation.items) {
      if (!item.product.isActive) {
        blockers.push(
          `Línea ${String(item.lineNumber)}: el producto ${item.product.sku} está desactivado`,
        );
      }
    }

    const temporary = await this.prisma.quotationReservation.findFirst({
      where: { quotationId, ...liveTemporaryWhere() },
      select: { expiresAt: true },
    });

    const { lines: previewLines, blockers: shortfallBlockers } = await this.previewLinesOf(
      quotationId,
      quotation.items,
    );
    blockers.push(...shortfallBlockers);

    return {
      quotationId,
      quotationCode: quotationCode(quotation.seq),
      temporaryReservationExpiresAt: temporary?.expiresAt.toISOString() ?? null,
      lines: previewLines,
      blockers,
    };
  }

  /**
   * El corazón de `confirmPreview` (D-186), separado de sus bloqueadores de dueño, vigencia
   * y cliente: qué reserva cada línea, cuánto hay disponible y cuánto falta.
   *
   * F8-S2b/M1 también lo usa (`findStockShortages`) para el aviso "sin stock disponible" —
   * la misma cuenta del gate de confirmar, nunca una paralela que se pueda desincronizar
   * (D-150: dos guardrails que envejecen por separado es la forma en que uno se olvida).
   */
  private async previewLinesOf(
    quotationId: string,
    items: {
      lineNumber: number;
      productId: string;
      qty: Prisma.Decimal;
      unit: string;
      description: string;
      reserveItemType: InventoryItemType;
      reserveItemId: string;
      reserveQty: Prisma.Decimal;
      reserveUnit: string;
      product: {
        sku: string;
        lengthMm: Prisma.Decimal | null;
        businessLine: { inventoryStrategy: InventoryStrategy };
      };
      pieces: { lengthMm: Prisma.Decimal; qty: number }[];
    }[],
  ): Promise<{ lines: ConfirmPreviewLineDto[]; blockers: string[] }> {
    const blockers: string[] = [];
    let lines: ReservableLine[] = [];
    try {
      const raw = await this.resolveRawMaterial(
        this.prisma,
        items.map((i) => ({
          lineNumber: i.lineNumber,
          productId: i.productId,
          qty: i.qty.toString(),
        })),
        { readOnly: true },
      );
      lines = items.map((i) => {
        const r = raw.get(i.lineNumber);
        return {
          lineNumber: i.lineNumber,
          productId: i.productId,
          reserveItemType: r ? InventoryItemTypeEnum.RAW_MATERIAL : i.reserveItemType,
          reserveItemId: r ? r.specId : i.reserveItemId,
          reserveQty: r ? r.kg : i.reserveQty.toFixed(3),
          reserveUnit: r ? Unit.KGM : i.reserveUnit,
        };
      });
    } catch (err) {
      // Un producto a medida con el catálogo incompleto no deja calcular el material: es el
      // mismo 400 que daría confirmar, dicho antes.
      blockers.push(err instanceof Error ? err.message : 'No se pudo calcular el material');
    }

    const scope = { exceptQuotationIds: [quotationId] };
    const tolerance = roofingToleranceMm(this.env);
    // Lo que las líneas anteriores del mismo documento ya tomaron de cada ítem: dos líneas del
    // mismo color y espesor compiten por el mismo agregado, igual que en `reserveLines`.
    const taken = new Map<string, Decimal>();
    const labels = await this.reserveLabels(lines);
    const previewLines: ConfirmPreviewLineDto[] = [];

    for (const item of items) {
      const line = lines.find((l) => l.lineNumber === item.lineNumber);
      const base = {
        lineNumber: item.lineNumber,
        productSku: item.product.sku,
        description: item.description,
        qty: item.qty.toFixed(3),
        unit: item.unit,
      };
      const withoutInventory = !carriesInventory(item.product.businessLine);
      if (!line || (line.reserveItemType === InventoryItemTypeEnum.PRODUCT && withoutInventory)) {
        previewLines.push({
          ...base,
          action: 'NONE',
          reserveLabel: null,
          reserveQty: null,
          reserveUnit: null,
          availableQty: null,
          shortfallQty: null,
          plan: null,
        });
        continue;
      }

      const qty = toDecimal(line.reserveQty.toString());
      const key = `${line.reserveItemType}:${line.reserveItemId}`;
      let available: Decimal;
      let plan: string | null = null;
      if (line.reserveItemType === InventoryItemTypeEnum.RAW_MATERIAL) {
        const spec = (await findRawMaterialSpecs(this.prisma, [line.reserveItemId])).get(
          line.reserveItemId,
        );
        available = spec
          ? (await rawMaterialAvailability(this.prisma, spec, tolerance, scope)).available
          : new Decimal(0);
        const pieces = derivePiecesPlan(
          item.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty })),
          item.product.lengthMm === null ? null : item.product.lengthMm.toFixed(2),
          item.qty.toString(),
        );
        plan = pieces.length > 0 ? describePieces(pieces) : null;
        try {
          await this.roofing.assertProducible(item.productId);
        } catch (err) {
          blockers.push(
            `Línea ${String(item.lineNumber)}: ${err instanceof Error ? err.message : 'no se puede producir'}`,
          );
        }
      } else {
        const [balances, reserved] = await Promise.all([
          this.prisma.inventoryBalance.findMany({
            where: { itemType: line.reserveItemType, itemId: line.reserveItemId },
            select: { qty: true },
          }),
          reservedByItem(this.prisma, line.reserveItemType, [line.reserveItemId], scope),
        ]);
        const physical = balances.reduce(
          (acc, b) => acc.plus(toDecimal(b.qty.toString())),
          new Decimal(0),
        );
        available = physical.minus(reserved.get(line.reserveItemId) ?? new Decimal(0));
      }

      const forThisLine = available.minus(taken.get(key) ?? new Decimal(0));
      taken.set(key, (taken.get(key) ?? new Decimal(0)).plus(qty));
      const shortfall = qty.gt(forThisLine)
        ? qty.minus(Decimal.max(forThisLine, new Decimal(0)))
        : null;
      const label = labels.get(line.reserveItemId)?.label ?? line.reserveItemId;
      if (shortfall !== null) {
        blockers.push(
          `Línea ${String(item.lineNumber)}: ${label} tiene ${Decimal.max(forThisLine, new Decimal(0)).toFixed(3)} ${line.reserveUnit} disponibles y el pedido necesita ${qty.toFixed(3)} — faltan ${shortfall.toFixed(3)}`,
        );
      }
      previewLines.push({
        ...base,
        action:
          line.reserveItemType === InventoryItemTypeEnum.RAW_MATERIAL ? 'PRODUCE' : 'RESERVE_STOCK',
        reserveLabel: label,
        reserveQty: qty.toFixed(3),
        reserveUnit: line.reserveUnit,
        availableQty: Decimal.max(forThisLine, new Decimal(0)).toFixed(3),
        shortfallQty: shortfall?.toFixed(3) ?? null,
        plan,
      });
    }

    return { lines: previewLines, blockers };
  }

  /**
   * F8-S2b/M1: cotizaciones emitidas y vigentes cuya materia prima o producto no alcanza
   * **hoy** para lo que prometen. La misma cuenta de `confirmPreview` (`previewLinesOf`), sin
   * sus bloqueadores de dueño, cliente ni catálogo — esos no son "falta de stock", y mezclar
   * las dos cosas en un mismo aviso confundiría al vendedor sobre por qué apareció acá.
   *
   * **Lazy, sin flag guardado ni job**: no hay nada que limpiar cuando la cotización se
   * confirma (deja de estar `EMITTED`, sale del `where`), vence (`isQuotationExpired` la
   * descarta) o el material llega a cubrir (`shortfallQty` da `null` en la próxima lectura).
   * El costo es leer todas las emitidas vigentes en cada consulta — aceptable: es el mismo
   * conjunto, acotado, que ya recorre `/reservas-temporales` y la propia cola de vencimiento.
   */
  async findStockShortages(actor: RequestUser): Promise<QuotationStockShortageDto[]> {
    const quotations = await this.prisma.quotation.findMany({
      where: { status: QuotationStatus.EMITTED, ...quotationSellerWhere(actor) },
      include: shortageQuotationInclude,
      orderBy: { seq: 'asc' },
    });
    if (quotations.length === 0) return [];

    const today = businessToday();
    const live = quotations.filter((q) => {
      if (q.items.length === 0) return false;
      const validUntil = q.validUntil?.toISOString().slice(0, 10) ?? null;
      return !(validUntil !== null && isQuotationExpired(validUntil, today));
    });
    if (live.length === 0) return [];

    // RF-S3/M2 (D-228): antes, `previewLinesOf` corría una vez **por cotización** y dentro
    // otra vez **por línea** — el número de consultas crecía con las dos cosas. Acá se
    // resuelve todo en dos pasadas batcheadas (clasificar, después traer el disponible una
    // vez por cada ítem/spec **distinto**, no por cotización ni por línea) y el resto es
    // aritmética en memoria; ver `resolveLinesForShortages`/`availabilityForShortages`.
    const { resolved, specRefById } = await this.resolveLinesForShortages(live);
    const { baseAvailable, ownTemporary, labels } = await this.availabilityForShortages(
      live,
      resolved,
      specRefById,
    );

    const out: QuotationStockShortageDto[] = [];
    for (const quotation of live) {
      // Lo que las líneas anteriores del mismo documento ya tomaron de cada ítem: dos líneas
      // del mismo color y espesor compiten por el mismo agregado (igual que `previewLinesOf`).
      const taken = new Map<string, Decimal>();
      const short: QuotationStockShortageDto['lines'] = [];
      for (const item of quotation.items) {
        const line = resolved.get(`${quotation.id}|${String(item.lineNumber)}`);
        const withoutInventory = !carriesInventory(item.product.businessLine);
        if (!line || (line.reserveItemType === InventoryItemTypeEnum.PRODUCT && withoutInventory)) {
          continue;
        }
        const qty = toDecimal(line.reserveQty);
        const key = `${line.reserveItemType}:${line.reserveItemId}`;
        const base = baseAvailable.get(key) ?? new Decimal(0);
        const own = ownTemporary.get(`${quotation.id}|${key}`) ?? new Decimal(0);
        const available = base.plus(own);
        const forThisLine = available.minus(taken.get(key) ?? new Decimal(0));
        taken.set(key, (taken.get(key) ?? new Decimal(0)).plus(qty));
        if (qty.lte(forThisLine)) continue;
        short.push({
          lineNumber: item.lineNumber,
          productSku: item.product.sku,
          label: labels.get(line.reserveItemId)?.label ?? line.reserveItemId,
          missingQty: qty.minus(Decimal.max(forThisLine, new Decimal(0))).toFixed(3),
          unit: line.reserveUnit,
        });
      }
      if (short.length === 0) continue;
      out.push({
        quotationId: quotation.id,
        quotationCode: quotationCode(quotation.seq),
        customerName: quotation.customer.name,
        lines: short,
      });
    }
    return out;
  }

  /**
   * RF-S3/M2: clasifica cada línea de cada cotización (materia prima a medida vs. lo que ya
   * tenía guardado) y resuelve las specs de materia prima **una vez por combinación
   * distinta** de línea/color/espesor, no una vez por línea. Mismo criterio de
   * `resolveRawMaterial`: si una sola línea de una cotización no se puede clasificar (le
   * falta espesor/ancho al catálogo), **ninguna** línea de esa cotización entra al resultado
   * — la fila entera queda fuera de `resolved`, y el llamador la trata como `NONE`.
   */
  private async resolveLinesForShortages(quotations: ShortageQuotation[]): Promise<{
    resolved: Map<string, ShortageReserveInfo>;
    specRefById: Map<string, RawMaterialSpecRef>;
  }> {
    const productIds = [...new Set(quotations.flatMap((q) => q.items.map((i) => i.productId)))];
    const products =
      productIds.length === 0
        ? []
        : await this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: ROOFING_PRODUCT_SELECT,
          });
    const productById = new Map(products.map((p) => [p.id, p]));

    interface RawCandidate {
      tripleKey: string;
      kg: string;
    }
    const rawByLineKey = new Map<string, RawCandidate>();
    const stockByLineKey = new Map<string, ShortageReserveInfo>();
    const tripleByKey = new Map<
      string,
      { businessLineId: string; colorId: string | null; thicknessMm: string }
    >();
    const failedQuotationIds = new Set<string>();

    for (const quotation of quotations) {
      const lineKeysOfThisQuotation: string[] = [];
      try {
        for (const item of quotation.items) {
          const lineKey = `${quotation.id}|${String(item.lineNumber)}`;
          lineKeysOfThisQuotation.push(lineKey);
          const product = productById.get(item.productId);
          if (product && isMadeToOrder(product)) {
            const at = `Línea ${String(item.lineNumber)}`;
            const thicknessMm = roofingSpecThicknessMm(product, at);
            const tripleKey = `${product.businessLineId}|${product.colorId ?? ''}|${thicknessMm}`;
            tripleByKey.set(tripleKey, {
              businessLineId: product.businessLineId,
              colorId: product.colorId,
              thicknessMm,
            });
            const kg = toFixedString(
              theoreticalKgForMeters(product, orderedMeters(product, item.qty.toString()), at),
              'KG',
            );
            rawByLineKey.set(lineKey, { tripleKey, kg });
          } else {
            stockByLineKey.set(lineKey, {
              reserveItemType: item.reserveItemType,
              reserveItemId: item.reserveItemId,
              reserveQty: item.reserveQty.toFixed(3),
              reserveUnit: item.reserveUnit,
            });
          }
        }
      } catch {
        // Un producto a medida con el catálogo incompleto no deja calcular el material: la
        // cotización entera queda sin datos de faltante, igual que hoy (regla dura 12: se
        // documenta la equivalencia, no se inventa una mejora que `previewLinesOf` no tiene).
        failedQuotationIds.add(quotation.id);
        for (const lineKey of lineKeysOfThisQuotation) {
          rawByLineKey.delete(lineKey);
          stockByLineKey.delete(lineKey);
        }
      }
    }

    // Las specs reales, de una sola pasada: se sobre-trae por línea de negocio (Prisma no
    // compara tuplas) y la tripla exacta se filtra en memoria — mismo costo que hoy paga
    // `findRawMaterialSpec`, una vez para todas las combinaciones en vez de una por línea.
    const businessLineIds = [...new Set([...tripleByKey.values()].map((t) => t.businessLineId))];
    const specRows =
      businessLineIds.length === 0
        ? []
        : await this.prisma.rawMaterialSpec.findMany({
            where: { businessLineId: { in: businessLineIds } },
            select: { id: true, businessLineId: true, colorId: true, thicknessMm: true },
          });
    const specByTripleKey = new Map<string, RawMaterialSpecRef>();
    for (const row of specRows) {
      const spec: RawMaterialSpecRef = {
        id: row.id,
        businessLineId: row.businessLineId,
        colorId: row.colorId,
        thicknessMm: row.thicknessMm.toFixed(2),
      };
      specByTripleKey.set(`${spec.businessLineId}|${spec.colorId ?? ''}|${spec.thicknessMm}`, spec);
    }

    const resolved = new Map<string, ShortageReserveInfo>();
    const specRefById = new Map<string, RawMaterialSpecRef>();
    for (const quotation of quotations) {
      if (failedQuotationIds.has(quotation.id)) continue;
      for (const item of quotation.items) {
        const lineKey = `${quotation.id}|${String(item.lineNumber)}`;
        const raw = rawByLineKey.get(lineKey);
        if (raw) {
          // Una spec sin fila todavía (`findRawMaterialSpec` la llamaría "virtual") se queda
          // sin id — igual que hoy: `previewLinesOf` la vuelve a buscar por id después de
          // resolverla y no la encuentra, así que su disponible es 0 (ver
          // `availabilityForShortages`), nunca el disponible real de las bobinas que calzan.
          const spec = specByTripleKey.get(raw.tripleKey);
          if (spec) specRefById.set(spec.id, spec);
          resolved.set(lineKey, {
            reserveItemType: InventoryItemTypeEnum.RAW_MATERIAL,
            reserveItemId: spec?.id ?? '',
            reserveQty: raw.kg,
            reserveUnit: Unit.KGM,
          });
        } else {
          const stock = stockByLineKey.get(lineKey);
          if (stock) resolved.set(lineKey, stock);
        }
      }
    }
    return { resolved, specRefById };
  }

  /**
   * RF-S3/M2: el disponible de cada ítem/spec **distinto** que aparece en `resolved`, una
   * sola vez cada uno — nunca una vez por cotización ni por línea. El ajuste por cotización
   * (D-185/D-186: la reserva temporal propia no se resta a sí misma) se separa en una sola
   * consulta agrupada por cotización e ítem, en vez de repetir `rawMaterialAvailability`/
   * `reservedByItem` con `exceptQuotationIds` distinto para cada una.
   */
  private async availabilityForShortages(
    quotations: ShortageQuotation[],
    resolved: Map<string, ShortageReserveInfo>,
    specRefById: Map<string, RawMaterialSpecRef>,
  ): Promise<{
    baseAvailable: Map<string, Decimal>;
    ownTemporary: Map<string, Decimal>;
    labels: Map<string, { label: string; name: string }>;
  }> {
    const tolerance = roofingToleranceMm(this.env);
    const allLines = [...resolved.values()];
    const baseAvailable = new Map<string, Decimal>();

    // Materia prima: una llamada a `rawMaterialAvailability` por spec real distinta, todas
    // en paralelo (hallazgo de `revisor`: antes era secuencial, desentonaba con el resto del
    // método, que sí batchea con `Promise.all`). Sin `exceptQuotationIds` — el ajuste "no
    // restarse a sí misma" se suma después, por cotización, con `ownTemporary`.
    const specAvailabilities = await Promise.all(
      [...specRefById.values()].map(async (spec) => ({
        spec,
        availability: await rawMaterialAvailability(this.prisma, spec, tolerance, {}),
      })),
    );
    for (const { spec, availability } of specAvailabilities) {
      baseAvailable.set(`${InventoryItemTypeEnum.RAW_MATERIAL}:${spec.id}`, availability.available);
    }
    // La spec virtual (sin fila todavía) vale 0 — ver el comentario en `resolveLinesForShortages`.
    baseAvailable.set(`${InventoryItemTypeEnum.RAW_MATERIAL}:`, new Decimal(0));

    // Estable/producto (y bobina completa, D-170): un `inventoryBalance.findMany` y un
    // `reservedByItem` por **tipo** de ítem presente, no por línea.
    const idsByType = new Map<InventoryItemType, Set<string>>();
    for (const line of allLines) {
      if (line.reserveItemType === InventoryItemTypeEnum.RAW_MATERIAL) continue;
      const ids = idsByType.get(line.reserveItemType) ?? new Set<string>();
      ids.add(line.reserveItemId);
      idsByType.set(line.reserveItemType, ids);
    }
    for (const [itemType, idsSet] of idsByType) {
      const ids = [...idsSet];
      const [balances, reserved] = await Promise.all([
        this.prisma.inventoryBalance.findMany({
          where: { itemType, itemId: { in: ids } },
          select: { itemId: true, qty: true },
        }),
        reservedByItem(this.prisma, itemType, ids, {}),
      ]);
      const physicalById = new Map<string, Decimal>();
      for (const b of balances) {
        physicalById.set(
          b.itemId,
          (physicalById.get(b.itemId) ?? new Decimal(0)).plus(toDecimal(b.qty.toString())),
        );
      }
      for (const id of ids) {
        const physical = physicalById.get(id) ?? new Decimal(0);
        baseAvailable.set(`${itemType}:${id}`, physical.minus(reserved.get(id) ?? new Decimal(0)));
      }
    }

    // El ajuste por cotización: cuánto tiene reservado de forma temporal, ella sola, cada
    // (cotización, ítem) — una sola consulta agrupada, en vez de una por cotización.
    const realKeys = [...baseAvailable.keys()].filter((k) => !k.endsWith(':'));
    const ownTemporary = new Map<string, Decimal>();
    const quotationIds = quotations.map((q) => q.id);
    if (quotationIds.length > 0 && realKeys.length > 0) {
      const itemIds = [...new Set(realKeys.map((k) => k.slice(k.indexOf(':') + 1)))];
      const rows = await this.prisma.quotationReservation.findMany({
        where: {
          ...liveTemporaryWhere(),
          quotationId: { in: quotationIds },
          itemId: { in: itemIds },
        },
        select: { quotationId: true, itemType: true, itemId: true, qty: true },
      });
      for (const row of rows) {
        const key = `${row.quotationId}|${row.itemType}:${row.itemId}`;
        ownTemporary.set(
          key,
          (ownTemporary.get(key) ?? new Decimal(0)).plus(toDecimal(row.qty.toString())),
        );
      }
    }

    const labels = await this.reserveLabels(allLines);
    return { baseAvailable, ownTemporary, labels };
  }

  // -------------------------------------------------------------------------
  // D-065 — pedido directo, sin cotización
  // -------------------------------------------------------------------------

  /**
   * Alta directa de pedido. Solo en líneas cuya cotización es **opcional**: en las que la
   * exigen (coberturas, RF-31) este es exactamente el camino que hay que cerrar, o el flag
   * de D-065 no significaría nada.
   */
  async createDirect(actor: RequestUser, input: CreateSalesOrderInput): Promise<SalesOrderDto> {
    const orderId = await this.prisma.$transaction(
      (tx) => this.createDirectInTx(tx, actor, input),
      // Mismo motivo que `confirm`: un lock por línea sobre bobinas y saldos.
      { timeout: 30_000 },
    );
    return this.findOne(orderId);
  }

  /**
   * El cuerpo de `createDirect`, **dentro de una transacción que abre el llamador**.
   *
   * Existe porque el mostrador (RF-60, D-099) crea pedido, despacho, comprobante y cobro en
   * una sola transacción: si cada uno abriera la suya, una venta podría quedar con el
   * pedido creado y el kardex sin mover. Es el mismo patrón que ya usan `assign` y
   * `deliver` en `invoicing` para partir una operación en tramos con dueño explícito.
   *
   * `counterSale` **no relaja nada**: cambia una regla por otra más estricta. El pedido de
   * mostrador se salta `quotation_required` (D-065) —una plancha de catálogo en stock se
   * vende sin cotizar— y a cambio exige que **cada línea esté respaldada por su propio
   * producto**, que es exactamente lo que RF-31 protege: sin bobina reservada y sin
   * subítems de largo, no hay forma de que una venta de mostrador arme una línea que
   * después haya que fabricar.
   */
  async createDirectInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: CreateSalesOrderInput,
    options: CreateDirectOptions = {},
  ): Promise<string> {
    const customer = await tx.customer.findUnique({
      where: { id: input.customerId },
      select: { id: true, isActive: true },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');

    const lines = await resolveSalesLines(tx, input.items, {
      // D-163: un pedido directo es una venta nueva, así que tiene el mismo piso que una
      // cotización. Confirmar una cotización ya validada no vuelve a pasar por acá: copia las
      // líneas tal como se cotizaron, y el precio se congeló cuando el piso ya lo había visto.
      //
      // **El mostrador queda fuera, y a propósito.** El alcance de D-163 es la cotización, y
      // el carrito de caja no tiene dónde mostrar el mínimo: el cajero lo descubriría al
      // cobrar, con el cliente delante, y el rechazo tira abajo la transacción entera de
      // D-099 —pedido, despacho, comprobante y cobro—. Como además el piso nuevo es **más
      // alto** que el de D-032, todo SKU cuyo precio de lista quedó entre los dos dejaría de
      // venderse en caja sin aviso. Antes de esta sesión el mostrador tampoco tenía piso, así
      // que dejarlo afuera no abre nada que no estuviera abierto; ponerlo sí rompería algo
      // que hoy funciona. Queda anotado para el dueño en `docs/PROGRESO.md`.
      ...(options.counterSale === true
        ? {}
        : { priceFloor: { toleranceMm: roofingToleranceMm(this.env) } }),
    });

    // D-119: un pedido directo (sin cotización) exige que **ninguna** línea venga de una
    // línea de negocio que obliga a cotizar (RF-31). Antes era un chequeo del documento
    // entero contra una sola línea; con líneas mixtas cada una puede venir de una línea de
    // negocio distinta, así que se comprueba una por una. El mostrador (`counterSale`) no
    // exige cotización nunca (D-098) y se salta este chequeo por completo.
    if (options.counterSale !== true) {
      const lineIds = [...new Set(lines.map((l) => l.businessLineId))];
      const businessLines = await tx.businessLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, quotationRequired: true },
      });
      const requiredById = new Map(businessLines.map((b) => [b.id, b.quotationRequired]));
      const blocked = lines.find((l) => requiredById.get(l.businessLineId) === true);
      if (blocked) {
        throw new BadRequestException(
          `Línea ${blocked.lineNumber}: ${blocked.productSku} exige una cotización confirmada (RF-31): crea la cotización, emítela y confírmala`,
        );
      }
    }

    // D-098: el mostrador vende **stock del propio producto**. Una línea respaldada por
    // otro ítem —la bobina de una cobertura a medida— es justo la que hay que fabricar,
    // y ese camino es el de la Fase 6, no el del mostrador. El esquema del POS ni
    // siquiera tiene el campo para pedirlo; esto es el cinturón por si algún día otro
    // llamador reusa este método con `counterSale`.
    if (options.counterSale === true) {
      const madeToOrder = lines.find(
        (l) =>
          l.reserveItemType !== InventoryItemTypeEnum.PRODUCT ||
          l.reserveItemId !== l.productId ||
          l.pieces.length > 0,
      );
      if (madeToOrder) {
        throw new BadRequestException(
          `Línea ${madeToOrder.lineNumber}: ${madeToOrder.productSku} se fabrica contra el pedido y no se vende en mostrador: cotízalo (RF-31)`,
        );
      }
    }
    const totals = documentTotals(lines);

    const order = await tx.salesOrder.create({
      data: {
        quotationId: null,
        customerId: customer.id,
        status: SalesOrderStatus.CONFIRMED,
        // D-150: `IMPORTED` ya no lo escribe nadie — el pedido cáscara se fue con el módulo
        // de importaciones. El valor sigue en el enum porque describe filas que existen.
        origin: SalesOrderOrigin.CREATED_HERE,
        issueDate: toDateOnly(input.issueDate),
        subtotalPen: totals.subtotalPen,
        igvPen: totals.igvPen,
        totalPen: totals.totalPen,
        notes: input.notes ?? null,
        createdById: actor.id,
        sellerId: actor.id,
        promisedDeliveryDate: input.promisedDeliveryDate
          ? toDateOnly(input.promisedDeliveryDate)
          : null,
        items: {
          create: lines.map((l) => ({
            lineNumber: l.lineNumber,
            productId: l.productId,
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            listPricePen: l.listPricePen,
            unitPricePen: l.unitPricePen,
            valuePerMeterPen: l.valuePerMeterPen,
            subtotalPen: l.subtotalPen,
            igvPen: l.igvPen,
            totalPen: l.totalPen,
            reserveItemType: l.reserveItemType,
            reserveItemId: l.reserveItemId,
            reserveQty: l.reserveQty,
            reserveUnit: l.reserveUnit,
            ...(l.pieces.length > 0
              ? {
                  pieces: {
                    create: l.pieces.map((p) => ({
                      lineNumber: p.lineNumber,
                      lengthMm: p.lengthMm,
                      qty: p.qty,
                    })),
                  },
                }
              : {}),
          })),
        },
      },
      include: { items: { orderBy: { lineNumber: 'asc' } } },
    });

    await this.createReservations(tx, actor, order.id, order.items);

    await this.audit.write(tx, {
      actorId: actor.id,
      action: options.counterSale === true ? 'pos.order.create' : 'sales.order.create-direct',
      entity: 'sales_orders',
      entityId: order.id,
      after: {
        code: salesOrderCode(order.seq),
        totalPen: totals.totalPen,
      },
    });
    return order.id;
  }

  // -------------------------------------------------------------------------
  // D-141 — el pedido cáscara de un comprobante ya entregado
  // -------------------------------------------------------------------------

  /**
   * D-134: el agregado de materia prima y los kilos teóricos de las líneas **a medida**.
   *
   * Se recalcula contra el maestro de hoy en vez de copiar lo que la cotización congeló,
   * por la misma razón por la que el precio sí se copia y esto no: el precio es un acuerdo
   * con el cliente y tiene que quedar quieto; qué material hace falta es un hecho técnico
   * que depende del catálogo, y si el catálogo cambió, lo congelado está mal.
   *
   * Vive en este servicio y no en `resolveSalesLines` solo porque acá la entrada son líneas
   * ya persistidas de una cotización; la aritmética es la misma y sale del mismo módulo.
   */
  private async resolveRawMaterial(
    tx: Prisma.TransactionClient,
    lines: { lineNumber: number; productId?: string; qty: string }[],
    /**
     * D-186: la vista previa de confirmar es un `GET` y no puede crear el agregado. Con
     * `readOnly` la spec que todavía no existe vuelve virtual (id vacío), igual que en el
     * panel de stock: nadie pudo prometer contra ella.
     */
    options: { readOnly?: boolean } = {},
  ): Promise<Map<number, { specId: string; kg: string }>> {
    // `flatMap` y no `filter`: además de descartar, estrecha el tipo de `productId`, así que
    // de acá para abajo no hacen falta aserciones.
    const candidates = lines.flatMap((l) =>
      l.productId !== undefined
        ? [{ lineNumber: l.lineNumber, productId: l.productId, qty: l.qty }]
        : [],
    );
    if (candidates.length === 0) return new Map();

    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(candidates.map((l) => l.productId))] } },
      select: ROOFING_PRODUCT_SELECT,
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const out = new Map<number, { specId: string; kg: string }>();
    for (const line of candidates) {
      const product = productById.get(line.productId);
      // D-171: **también la plancha de catálogo.** Recalcular acá es, además, lo que hace que
      // las cotizaciones de plancha emitidas bajo el modelo viejo —que guardaron `PRODUCT` y
      // unidades— se confirmen solas bajo el nuevo, sin migrar una fila. Es exactamente el
      // mismo mecanismo con el que D-134 arregló las anteriores a él.
      if (!product || !isMadeToOrder(product)) continue;
      const at = `Línea ${line.lineNumber}`;
      const specInput = {
        businessLineId: product.businessLineId,
        colorId: product.colorId,
        thicknessMm: roofingSpecThicknessMm(product, at),
      };
      const spec =
        options.readOnly === true
          ? await findRawMaterialSpec(tx, specInput)
          : await resolveRawMaterialSpec(tx, specInput);
      out.set(line.lineNumber, {
        specId: spec.id,
        kg: toFixedString(
          theoreticalKgForMeters(product, orderedMeters(product, line.qty), at),
          'KG',
        ),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // El corazón: crear las reservas comprobando disponible
  // -------------------------------------------------------------------------

  /**
   * Una reserva por línea, con el saldo del ítem bloqueado. Si a una línea no le alcanza el
   * disponible, lanza y **toda** la transacción se cae: el pedido no queda a medias con
   * unas líneas reservadas y otras no (D-054).
   *
   * **Orden de locks: primero las bobinas, después los saldos.** Es el mismo orden que ya
   * usan `production.consume` (`lockCoil` → `record`) y `coils.split`, y no es negociable:
   * comprobar el disponible bajo el lock del **saldo** no serializa contra
   * `production.consume` ni `cutting.send`, que bloquean la fila de la **bobina** y ni
   * siquiera tocan el saldo (D-050/D-060: asignar y enviar no mueven kardex). Sin este
   * lock previo quedaba una ventana en la que una confirmación y un envío a corte se
   * cruzaban y la bobina terminaba reservada **y** en poder de un tercero.
   *
   * Dentro de cada grupo las filas se piden por id ascendente y las líneas se ordenan por
   * `(itemType, itemId)`, así que dos confirmaciones simultáneas que compartan ítems se
   * serializan en vez de trabarse en un deadlock.
   */
  // Público desde D-187: agregar ítems a un pedido confirmado y cambiar la cantidad de una línea
  // (`SalesOrderEditsService`) reservan por esta misma puerta, con los mismos locks.
  async createReservations(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    items: (ReservableLine & { id: string })[],
  ): Promise<void> {
    await this.reserveLines(tx, items, 'el pedido', async (item) => {
      // `upsert` y no `create` desde D-187: cambiar la cantidad de una línea confirmada libera
      // su reserva y vuelve a reservar la misma línea sobre el mismo ítem, y la tabla admite una
      // sola fila por (línea, ítem). La fila liberada **revive** con la cantidad nueva —y con
      // ella la OP que ya colgaba de su id—; el rastro de la liberación queda en `audit_log`.
      // En confirmar y agregar ítems la línea es nueva y siempre cae en `create`.
      await tx.reservation.upsert({
        where: {
          salesOrderItemId_itemType_itemId: {
            salesOrderItemId: item.id,
            itemType: item.reserveItemType,
            itemId: item.reserveItemId,
          },
        },
        create: {
          salesOrderId: orderId,
          salesOrderItemId: item.id,
          itemType: item.reserveItemType,
          itemId: item.reserveItemId,
          qty: item.reserveQty,
          unit: item.reserveUnit,
          status: ReservationStatus.ACTIVE,
          createdById: actor.id,
        },
        update: {
          qty: item.reserveQty,
          unit: item.reserveUnit,
          status: ReservationStatus.ACTIVE,
          releasedAt: null,
          releasedById: null,
        },
      });
    });
  }

  /**
   * El corazón de `createReservations`, sin decidir **dónde** se escribe la promesa (D-185).
   *
   * La reserva firme del pedido y la temporal de la cotización comprueban exactamente lo
   * mismo —bobinas bloqueadas en un solo orden, estado de la bobina, custodia, disponible del
   * ítem o del agregado— y difieren solo en la fila que escriben. Copiar esta función para la
   * temporal habría dejado dos guardrails que envejecen por separado, que es la lección
   * repetida del proyecto (D-150). `write` recibe cada línea que sí reserva algo; devuelve
   * cuántas fueron, para que la temporal pueda decir "no hay nada que reservar".
   */
  private async reserveLines<T extends ReservableLine>(
    tx: Prisma.TransactionClient,
    items: T[],
    /** Quién necesita el material, para el mensaje: «el pedido», «la reserva». */
    holder: string,
    write: (item: T) => Promise<void>,
  ): Promise<number> {
    let written = 0;
    const sorted = [...items].sort((a, b) =>
      `${a.reserveItemType}:${a.reserveItemId}`.localeCompare(
        `${b.reserveItemType}:${b.reserveItemId}`,
      ),
    );

    const coilItems = sorted.filter((i) => i.reserveItemType === InventoryItemTypeEnum.COIL);
    const coilIds = [...new Set(coilItems.map((i) => i.reserveItemId))].sort(compareTechnicalCode);

    // D-134: las líneas que prometen materia prima genérica. El agregado no es un ítem de
    // inventario y no tiene saldo propio que bloquear, pero **sí** tiene bobinas: las que
    // hoy cumplen su spec. Se resuelven acá arriba para poder bloquearlas junto con las demás.
    const rawItems = sorted.filter((i) => i.reserveItemType === InventoryItemTypeEnum.RAW_MATERIAL);
    const rawSpecs = await findRawMaterialSpecs(
      tx,
      rawItems.map((i) => i.reserveItemId),
    );
    const rawCoilIds: string[] = [];
    for (const spec of rawSpecs.values()) {
      rawCoilIds.push(...(await rawMaterialCoilIds(tx, spec, roofingToleranceMm(this.env))));
    }

    // **Un solo lock, sobre la unión y en orden de id.** Dos locks separados —primero las
    // bobinas nombradas y después las del agregado— se cruzan en un deadlock en cuanto los
    // conjuntos se solapan: una transacción tiene la #5 y espera la #3 mientras la otra
    // tiene la #3 y espera la #5. Ordenar dentro de cada lock no alcanza; hay que ordenar
    // el conjunto entero y pedirlo de una vez.
    const lockIds = [...new Set([...coilIds, ...rawCoilIds])].sort(compareTechnicalCode);
    if (lockIds.length > 0) {
      await tx.$queryRaw`
        SELECT "id" FROM "coils" WHERE "id" = ANY(${lockIds}::uuid[]) ORDER BY "id" FOR UPDATE
      `;
    }

    // D-119: el saldo de una bobina vive bajo **su propia** línea de negocio (Drywall o
    // Metallic Roofing), que puede no ser la del producto que la reserva (venta de bobina
    // completa, D-116: el producto es de `trading`). `lockBalance` exige la línea exacta
    // que ya tiene el saldo.
    const coilBusinessLineById = new Map<string, string>();
    if (coilIds.length > 0) {
      // D-116: una línea que reserva kilos de bobina para **producirla** (coberturas a
      // medida) sigue exigiendo `OPEN` —de acá sale material que todavía tiene que montarse
      // en una OP—, pero una línea que **vende la bobina tal cual** (RF-73, producto sin
      // receta) también acepta `CLOSED`: es justo el estado con el que C recomienda dar de
      // alta una bobina que ya se sabe que se va a vender entera, y bloquearlo la dejaría
      // sin ninguna forma de reservarse.
      const boms = await tx.productBom.findMany({
        where: {
          productId: { in: [...new Set(coilItems.map((i) => i.productId))] },
          isActive: true,
        },
        select: { productId: true },
      });
      const madeToOrderProductIds = new Set(boms.map((b) => b.productId));
      const requiresOpenByCoilId = new Map<string, boolean>();
      for (const item of coilItems) {
        if (madeToOrderProductIds.has(item.productId)) {
          requiresOpenByCoilId.set(item.reserveItemId, true);
        } else if (!requiresOpenByCoilId.has(item.reserveItemId)) {
          requiresOpenByCoilId.set(item.reserveItemId, false);
        }
      }

      // **La invariante también vale al revés.** Comprobar el disponible no alcanza para
      // decidir si el material se puede prometer: entre cotizar y confirmar, la bobina pudo
      // irse a un tercero (D-050) o quedar montada en una orden de producción (D-060), y
      // ninguna de esas dos cosas mueve un gramo de kardex, así que el saldo se ve intacto.
      // Prometerla igual deja al pedido comprometiendo material que no está, y —peor— hace
      // que la recepción del corte o el reporte de esa OP se caigan después contra la
      // invariante, sin más salida que liberar la reserva a mano.
      const coils = await tx.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true, status: true, businessLineId: true },
      });
      const unavailable = coils.filter((c) => {
        const allowed: CoilStatus[] = requiresOpenByCoilId.get(c.id)
          ? [CoilStatus.OPEN]
          : [CoilStatus.OPEN, CoilStatus.CLOSED];
        return !allowed.includes(c.status);
      });
      if (unavailable.length > 0) {
        const detail = unavailable.map((c) => `${c.code} (${c.status})`).join(', ');
        throw new BadRequestException(
          `No se puede reservar material de una bobina que no está disponible: ${detail}.`,
        );
      }
      await assertStripsNotAssigned(tx, coilIds, 'reservar su material para un pedido');
      for (const c of coils) coilBusinessLineById.set(c.id, c.businessLineId);
    }

    // D-119: para un ítem PRODUCT, la línea dueña del saldo es la del propio producto —
    // siempre coincide con `productId` porque una reserva PRODUCT reserva el producto de
    // la línea, nunca otro.
    const productItems = sorted.filter((i) => i.reserveItemType === InventoryItemTypeEnum.PRODUCT);
    const productLines =
      productItems.length === 0
        ? []
        : await tx.product.findMany({
            where: { id: { in: [...new Set(productItems.map((i) => i.reserveItemId))] } },
            select: {
              id: true,
              businessLineId: true,
              // D-167: para saber cuáles de estos productos **no** se reservan.
              businessLine: { select: { inventoryStrategy: true } },
            },
          });
    const productBusinessLineById = new Map(productLines.map((p) => [p.id, p.businessLineId]));
    // D-167: los productos de una línea `NOOP`. No es «los que no tienen saldo»: es que a
    // estos la pregunta no se les hace. Abrirles una reserva los mandaría a `lockAvailability`,
    // que crearía la fila de saldo de un ítem que nunca va a tener movimientos y rechazaría el
    // pedido con «tiene 0.000 disponibles» — el mismo callejón que D-167 vino a cerrar, un
    // paso más adelante.
    const withoutInventory = new Set(
      productLines.filter((p) => !carriesInventory(p.businessLine)).map((p) => p.id),
    );

    for (const item of sorted) {
      const qty = toDecimal(item.reserveQty.toString());

      if (
        item.reserveItemType === InventoryItemTypeEnum.PRODUCT &&
        withoutInventory.has(item.reserveItemId)
      ) {
        continue;
      }

      // D-134: la promesa genérica se comprueba contra la **suma** del agregado, no contra
      // el saldo de un ítem. Es la misma invariante de D-066 —no prometer lo que no está—
      // aplicada al único objeto que la línea nombra.
      if (item.reserveItemType === InventoryItemTypeEnum.RAW_MATERIAL) {
        const spec = rawSpecs.get(item.reserveItemId);
        if (!spec) {
          throw new NotFoundException(
            `Línea ${item.lineNumber}: no se encontró el agregado de materia prima reservado`,
          );
        }
        // Sin `lockCoils`: las bobinas del agregado ya quedaron bloqueadas arriba, junto
        // con las demás y en un solo orden.
        const availability = await rawMaterialAvailability(tx, spec, roofingToleranceMm(this.env));
        if (qty.gt(availability.available)) {
          const label =
            (await rawMaterialSpecLabels(tx, [spec.id])).get(spec.id) ?? 'la materia prima';
          // D-134 (hallazgo de Fase 7-final): una bobina montada en una OP (D-060) no mueve
          // kardex, así que no aparece en "físicos" ni en "comprometidos" — el vendedor veía
          // cero material sobre un almacén que sí lo tenía, solo que en la roladora. Si algo
          // está montado, se lo dice.
          const mountedNote = availability.mountedKg.gt(0)
            ? ` y ${availability.mountedKg.toFixed(3)} kg montados en ${availability.mountedOrderCodes.join(', ')}`
            : '';
          throw new BadRequestException(
            `Línea ${item.lineNumber}: ${label} tiene ${availability.available.toFixed(3)} kg disponibles ` +
              `(${availability.physical.toFixed(3)} físicos menos ${availability.reservedOnCoils
                .plus(availability.reservedGeneric)
                .toFixed(
                  3,
                )} ya comprometidos${mountedNote}) y ${holder} necesita ${qty.toFixed(3)}. ` +
              'Compra o abre una bobina de ese color y espesor antes de continuar.',
          );
        }
        await write(item);
        written += 1;
        continue;
      }

      const itemBusinessLineId =
        item.reserveItemType === InventoryItemTypeEnum.COIL
          ? coilBusinessLineById.get(item.reserveItemId)
          : productBusinessLineById.get(item.reserveItemId);
      if (!itemBusinessLineId) {
        throw new NotFoundException(
          `Línea ${item.lineNumber}: no se pudo resolver su línea de negocio`,
        );
      }
      const availability = await this.inventory.lockAvailability(tx, {
        businessLineId: itemBusinessLineId,
        itemType: item.reserveItemType,
        itemId: item.reserveItemId,
        unit: item.reserveUnit,
      });
      if (qty.gt(availability.available)) {
        const label = await this.itemLabel(tx, item.reserveItemType, item.reserveItemId);
        throw new BadRequestException(
          `Línea ${item.lineNumber}: ${label} tiene ${availability.available.toFixed(3)} ${availability.unit} disponibles (${availability.qty.toFixed(3)} físicos menos ${availability.reserved.toFixed(3)} ya reservados) y ${holder} necesita ${qty.toFixed(3)}.`,
        );
      }
      await write(item);
      written += 1;
    }

    // D-134: vender una bobina entera (RF-73) le saca kilos al agregado sin mover un gramo
    // de kardex — la reserva sobre el rollo lo deja fuera del disponible genérico. Sin esta
    // comprobación, ese pedido pasaría y el que ya tenía prometidos esos kilos se quedaría
    // sin material, descubriéndolo recién al montar la OP.
    if (coilIds.length > 0) {
      await assertRawMaterialInvariant(tx, coilIds, roofingToleranceMm(this.env));
    }
    return written;
  }

  // -------------------------------------------------------------------------
  // D-185 — reserva temporal sobre una cotización emitida
  // -------------------------------------------------------------------------

  /**
   * Lo que cada línea de una cotización reservaría **hoy**: lo mismo que va a reservar el
   * pedido al confirmar. Una línea que se fabrica contra el pedido recalcula su agregado y
   * sus kilos contra el catálogo vigente (D-134), igual que `confirm`; el resto copia lo que
   * la cotización declaró.
   */
  private async quotationReservableLines(
    tx: Prisma.TransactionClient,
    items: {
      lineNumber: number;
      productId: string;
      qty: Prisma.Decimal;
      reserveItemType: InventoryItemType;
      reserveItemId: string;
      reserveQty: Prisma.Decimal;
      reserveUnit: string;
    }[],
  ): Promise<ReservableLine[]> {
    const raw = await this.resolveRawMaterial(
      tx,
      items.map((i) => ({
        lineNumber: i.lineNumber,
        productId: i.productId,
        qty: i.qty.toString(),
      })),
    );
    return items.map((i) => {
      const line = raw.get(i.lineNumber);
      return {
        lineNumber: i.lineNumber,
        productId: i.productId,
        reserveItemType: line ? InventoryItemTypeEnum.RAW_MATERIAL : i.reserveItemType,
        reserveItemId: line ? line.specId : i.reserveItemId,
        reserveQty: line ? line.kg : i.reserveQty.toFixed(3),
        reserveUnit: line ? Unit.KGM : i.reserveUnit,
      };
    });
  }

  /** Días hábiles de una reserva temporal: lo que fijó Administración o el defecto. */
  private async temporaryBusinessDays(tx: Prisma.TransactionClient): Promise<number> {
    const settings = await tx.salesSettings.findUnique({ where: { id: 1 } });
    return (
      settings?.temporaryReservationBusinessDays ?? DEFAULT_TEMPORARY_RESERVATION_BUSINESS_DAYS
    );
  }

  async getSalesSettings(): Promise<SalesSettingsDto> {
    return { temporaryReservationBusinessDays: await this.temporaryBusinessDays(this.prisma) };
  }

  async updateSalesSettings(
    actor: RequestUser,
    input: UpdateSalesSettingsInput,
  ): Promise<SalesSettingsDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.temporaryBusinessDays(tx);
      await tx.salesSettings.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          temporaryReservationBusinessDays: input.temporaryReservationBusinessDays,
          updatedById: actor.id,
        },
        update: {
          temporaryReservationBusinessDays: input.temporaryReservationBusinessDays,
          updatedById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.settings.update',
        entity: 'sales_settings',
        entityId: '1',
        before: { temporaryReservationBusinessDays: before },
        after: { temporaryReservationBusinessDays: input.temporaryReservationBusinessDays },
      });
    });
    return this.getSalesSettings();
  }

  /**
   * Bloquea la cotización y valida que quien opera pueda operarla (RF-66: la propia, o
   * cualquiera si es ADMINISTRADOR). Devuelve la cabecera ya bloqueada.
   */
  private async lockOwnQuotation(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    quotationId: string,
    _action: string,
  ): Promise<{
    id: string;
    seq: number;
    status: QuotationStatus;
    validUntil: string | null;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        seq: number;
        status: QuotationStatus;
        valid_until: Date | null;
        created_by_id: string;
        seller_id: string | null;
      }[]
    >`
      SELECT "id", "seq", "status", "valid_until", "created_by_id", "seller_id"
      FROM "quotations" WHERE "id" = ${quotationId}::uuid FOR UPDATE
    `;
    const head = rows[0];
    if (!head) throw new NotFoundException('Cotización no encontrada');
    if (actor.role !== Role.ADMINISTRADOR && actor.id !== (head.seller_id ?? head.created_by_id)) {
      throw new NotFoundException('Cotización no encontrada');
    }
    return {
      id: head.id,
      seq: head.seq,
      status: head.status,
      validUntil: head.valid_until?.toISOString().slice(0, 10) ?? null,
    };
  }

  /**
   * «Reservar»: aparta el material de una cotización emitida mientras el cliente deposita,
   * sin crear el pedido (D-185).
   *
   * Reserva **exactamente** lo que confirmar reservaría —con el mismo guardrail de
   * disponible, las mismas bobinas bloqueadas y el mismo orden de locks—, pero en la tabla de
   * temporales y con vencimiento a N días hábiles. Una línea sin inventario (un servicio) no
   * aparta nada; si ninguna línea aparta nada, no hay reserva que crear.
   */
  async reserveTemporarily(actor: RequestUser, quotationId: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const head = await this.lockOwnQuotation(tx, actor, quotationId, 'reservarla');
        await sweepExpiredTemporaryReservations(tx, { quotationId });
        if (head.status !== QuotationStatus.EMITTED) {
          throw new BadRequestException(
            `Solo se reserva una cotización emitida; esta está ${head.status}`,
          );
        }
        if (head.validUntil !== null && isQuotationExpired(head.validUntil, businessToday())) {
          throw new BadRequestException(
            `La cotización venció el ${head.validUntil}: renuévala editándola antes de reservar`,
          );
        }
        const live = await tx.quotationReservation.count({
          where: { quotationId, ...liveTemporaryWhere() },
        });
        if (live > 0) {
          throw new ConflictException('La cotización ya tiene una reserva temporal vigente');
        }

        const items = await tx.quotationItem.findMany({
          where: { quotationId },
          orderBy: { lineNumber: 'asc' },
        });
        const lines = await this.quotationReservableLines(tx, items);
        const days = await this.temporaryBusinessDays(tx);
        // Nunca más allá de la vigencia de la cotización: pasado ese día ya no se puede
        // confirmar, y seguir apartando material para algo que no se puede confirmar es
        // quitárselo a otro sin motivo. `null` es sin vencimiento (D-157) y no recorta nada.
        const expiresAt = capToQuotationValidity(temporaryReservationExpiry(days), head.validUntil);
        const written = await this.reserveLines(tx, lines, 'la reserva', async (line) => {
          await tx.quotationReservation.create({
            data: {
              quotationId,
              lineNumber: line.lineNumber,
              itemType: line.reserveItemType,
              itemId: line.reserveItemId,
              qty: line.reserveQty,
              unit: line.reserveUnit,
              expiresAt,
              createdById: actor.id,
            },
          });
        });
        if (written === 0) {
          throw new BadRequestException(
            'La cotización no tiene ninguna línea con material que apartar: sus líneas no llevan inventario',
          );
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.quotation.reserve-temporary',
          entity: 'quotations',
          entityId: quotationId,
          after: {
            code: quotationCode(head.seq),
            expiresAt: expiresAt.toISOString(),
            businessDays: days,
            lines: written,
          },
        });
      },
      // Mismo presupuesto que `confirm`: toma los mismos locks por línea.
      { timeout: 30_000 },
    );
  }

  /** Liberar a mano la reserva temporal vigente de una cotización (D-185). */
  async releaseTemporary(actor: RequestUser, quotationId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const head = await this.lockOwnQuotation(tx, actor, quotationId, 'liberar su reserva');
      await sweepExpiredTemporaryReservations(tx, { quotationId });
      const released = await this.endTemporaryInTx(tx, quotationId, {
        status: TemporaryReservationStatus.RELEASED,
        actorId: actor.id,
        reason,
      });
      if (released === 0) {
        throw new ConflictException('La cotización no tiene una reserva temporal vigente');
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.release-temporary',
        entity: 'quotations',
        entityId: quotationId,
        after: { code: quotationCode(head.seq), lines: released, reason },
      });
    });
  }

  /**
   * Termina las temporales vigentes de una cotización. La usan la liberación manual, la
   * anulación de la cotización, la edición que recalcula y la confirmación que las convierte.
   */
  async endTemporaryInTx(
    tx: Prisma.TransactionClient,
    quotationId: string,
    end: {
      status: TemporaryReservationStatus;
      actorId: string | null;
      reason: string;
      salesOrderId?: string;
    },
  ): Promise<number> {
    const result = await tx.quotationReservation.updateMany({
      where: { quotationId, ...liveTemporaryWhere() },
      data: {
        status: end.status,
        endedAt: new Date(),
        endedById: end.actorId,
        endReason: end.reason.slice(0, 240),
        ...(end.salesOrderId === undefined ? {} : { salesOrderId: end.salesOrderId }),
      },
    });
    return result.count;
  }

  /**
   * Editar una cotización con reserva temporal la **recalcula** (D-185), dentro de la misma
   * transacción de la edición y después de reescribir las líneas.
   *
   * Si lo que las líneas nuevas reservan es igual a lo vigente **y** la vigencia de la
   * cotización no quedó antes del vencimiento, no toca nada. Si no, libera lo vigente y vuelve a
   * reservar con el mismo guardrail de disponible y un vencimiento que es el **menor** entre el
   * que tenía y el fin de la vigencia nueva: editar no es una forma de estirar el plazo, y una
   * reserva nunca vence después que su cotización (F8-S4/M0 — acortar la vigencia dejaba la
   * reserva apartando material para algo que ya no se podía confirmar). Si lo nuevo no alcanza,
   * lanza y la edición entera se deshace — la reserva vieja queda como estaba, nunca se libera
   * en silencio ni se reserva de más sin validar.
   */
  async recalculateTemporaryInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    quotationId: string,
  ): Promise<void> {
    await sweepExpiredTemporaryReservations(tx, { quotationId });
    const current = await tx.quotationReservation.findMany({
      where: { quotationId, ...liveTemporaryWhere() },
      orderBy: { lineNumber: 'asc' },
    });
    const first = current[0];
    if (!first) return;

    const items = await tx.quotationItem.findMany({
      where: { quotationId },
      orderBy: { lineNumber: 'asc' },
    });
    const lines = await this.quotationReservableLines(tx, items);
    const signature = (
      rows: { lineNumber: number; type: string; id: string; qty: string }[],
    ): string =>
      rows
        .map((r) => `${String(r.lineNumber)}|${r.type}|${r.id}|${toDecimal(r.qty).toFixed(3)}`)
        .sort(compareTechnicalCode)
        .join(';');
    const before = signature(
      current.map((r) => ({
        lineNumber: r.lineNumber,
        type: r.itemType,
        id: r.itemId,
        qty: r.qty.toString(),
      })),
    );
    const after = signature(
      (await this.linesWithInventory(tx, lines)).map((l) => ({
        lineNumber: l.lineNumber,
        type: l.reserveItemType,
        id: l.reserveItemId,
        qty: l.reserveQty.toString(),
      })),
    );
    const quotation = await tx.quotation.findUniqueOrThrow({
      where: { id: quotationId },
      select: { validUntil: true },
    });
    const expiresAt = capToQuotationValidity(
      first.expiresAt,
      quotation.validUntil === null ? null : quotation.validUntil.toISOString().slice(0, 10),
    );
    const shortened = expiresAt.getTime() < first.expiresAt.getTime();
    // La edición no tocó nada de lo reservado (cambió un precio, una observación) ni acortó la
    // vigencia: la reserva queda como estaba, sin filas liberadas que no cuenten ninguna historia.
    if (before === after && !shortened) return;

    // La vigencia nueva ya pasó: no hay nada que confirmar, así que la reserva termina vencida
    // en vez de recrearse con un vencimiento en el pasado.
    if (expiresAt.getTime() <= Date.now()) {
      const ended = await this.endTemporaryInTx(tx, quotationId, {
        status: TemporaryReservationStatus.EXPIRED,
        actorId: actor.id,
        reason: 'Edición de la cotización: la vigencia nueva ya venció',
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.recalculate-temporary',
        entity: 'quotations',
        entityId: quotationId,
        before: { lines: current.length, expiresAt: first.expiresAt.toISOString() },
        after: { lines: ended, status: TemporaryReservationStatus.EXPIRED },
      });
      return;
    }

    // Solo se acortó el plazo: lo reservado no cambia, así que se mueve el vencimiento sin liberar
    // ni volver a reservar. Re-reservar revalidaría el disponible, y un agregado que bajó por un
    // camino que avisa en vez de rechazar (merma, consumo a stock, D-154) tumbaría una edición
    // que solo **reduce** el compromiso.
    if (before === after) {
      await tx.quotationReservation.updateMany({
        where: { quotationId, ...liveTemporaryWhere() },
        data: { expiresAt },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.recalculate-temporary',
        entity: 'quotations',
        entityId: quotationId,
        before: { lines: current.length, expiresAt: first.expiresAt.toISOString() },
        after: { lines: current.length, expiresAt: expiresAt.toISOString() },
      });
      return;
    }

    await this.endTemporaryInTx(tx, quotationId, {
      status: TemporaryReservationStatus.RELEASED,
      actorId: actor.id,
      reason: 'Edición de la cotización: se recalculó la reserva',
    });
    let created = 0;
    await this.reserveLines(tx, lines, 'la reserva', async (line) => {
      created += 1;
      await tx.quotationReservation.create({
        data: {
          quotationId,
          lineNumber: line.lineNumber,
          itemType: line.reserveItemType,
          itemId: line.reserveItemId,
          qty: line.reserveQty,
          unit: line.reserveUnit,
          expiresAt,
          createdById: actor.id,
        },
      });
    });
    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.quotation.recalculate-temporary',
      entity: 'quotations',
      entityId: quotationId,
      before: { lines: current.length, expiresAt: first.expiresAt.toISOString() },
      after: { lines: created, expiresAt: expiresAt.toISOString() },
    });
  }

  /** La vista «Reservas temporales vigentes» (D-185): una fila por cotización. */
  async findTemporaryReservations(actor: RequestUser): Promise<TemporaryReservationListItemDto[]> {
    await this.prisma.$transaction((tx) => sweepExpiredTemporaryReservations(tx));
    const rows = await this.prisma.quotationReservation.findMany({
      where: { ...liveTemporaryWhere(), quotation: quotationSellerWhere(actor) },
      include: {
        quotation: { select: { id: true, seq: true, customer: { select: { name: true } } } },
      },
      orderBy: [{ expiresAt: 'asc' }, { lineNumber: 'asc' }],
    });
    const labels = await this.temporaryLabels(rows);
    const actors = await this.resolveActorNames(rows.map((r) => r.createdById));
    const byQuotation = new Map<string, TemporaryReservationListItemDto>();
    for (const r of rows) {
      const entry =
        byQuotation.get(r.quotationId) ??
        ({
          quotationId: r.quotation.id,
          quotationCode: quotationCode(r.quotation.seq),
          customerName: r.quotation.customer.name,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          createdByName: actors.get(r.createdById) ?? null,
          lines: [],
        } satisfies TemporaryReservationListItemDto);
      entry.lines.push(toTemporaryLine(r, labels));
      byQuotation.set(r.quotationId, entry);
    }
    return [...byQuotation.values()];
  }

  /** La reserva temporal vigente de una cotización, para su detalle. */
  async findQuotationTemporaryReservation(
    quotationId: string,
  ): Promise<QuotationTemporaryReservationDto | null> {
    const rows = await this.prisma.quotationReservation.findMany({
      where: { quotationId, ...liveTemporaryWhere() },
      orderBy: { lineNumber: 'asc' },
    });
    const first = rows[0];
    if (!first) return null;
    const labels = await this.temporaryLabels(rows);
    const actors = await this.resolveActorNames([first.createdById]);
    return {
      expiresAt: first.expiresAt.toISOString(),
      createdAt: first.createdAt.toISOString(),
      createdByName: actors.get(first.createdById) ?? null,
      lines: rows.map((r) => toTemporaryLine(r, labels)),
    };
  }

  private async temporaryLabels(
    rows: { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const [itemId, value] of await this.reserveLabels(rows)) map.set(itemId, value.label);
    return map;
  }

  /**
   * Las líneas que de verdad dejan una reserva: las de un producto sin inventario (D-167) se
   * saltan en `reserveLines`, así que tampoco cuentan al comparar lo reservado.
   */
  private async linesWithInventory(
    tx: Prisma.TransactionClient,
    lines: ReservableLine[],
  ): Promise<ReservableLine[]> {
    const productIds = lines
      .filter((l) => l.reserveItemType === InventoryItemTypeEnum.PRODUCT)
      .map((l) => l.reserveItemId);
    if (productIds.length === 0) return lines;
    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(productIds)] } },
      select: { id: true, businessLine: { select: { inventoryStrategy: true } } },
    });
    const noInventory = new Set(
      products.filter((p) => !carriesInventory(p.businessLine)).map((p) => p.id),
    );
    return lines.filter(
      (l) =>
        !(l.reserveItemType === InventoryItemTypeEnum.PRODUCT && noInventory.has(l.reserveItemId)),
    );
  }

  // -------------------------------------------------------------------------
  // Anular el pedido (libera las reservas)
  // -------------------------------------------------------------------------

  /**
   * Anula el pedido y libera sus reservas activas.
   *
   * **Se bloquea mientras exista una OP viva (`DRAFT`/`IN_PROGRESS`) colgada de cualquiera
   * de sus reservas**, sin importar en qué estado esté la reserva. La distinción importa:
   * una OP que ya montó el fleje (`consume`) pero todavía no reportó tiene su reserva en
   * `ACTIVA`, y filtrar por `CONSUMIDA` dejaba anular el pedido en silencio — la reserva
   * pasaba a `LIBERADA`, la orden seguía fabricando para un pedido que ya no existía y su
   * primer reporte no encontraba nada que consumir.
   *
   * Que el bloqueo mire el **estado de la orden** y no el de la reserva es lo que evita el
   * otro extremo: deshacer la producción (revertir el reporte, anular la OP) devuelve la
   * reserva a `ACTIVA` y libera este bloqueo, así que un pedido nunca queda sin poder
   * anularse para siempre — el agujero que D-061 tuvo que cerrar con los pagos a proveedor.
   *
   * Con la OP cerrada no hay nada que impedir: el material ya salió y anular el pedido es un
   * acto puramente comercial.
   *
   * Si el pedido venía de una cotización, esa cotización vuelve a `EMITIDA` cuando sigue
   * vigente — el cliente puede volver a aceptarla— y queda `VENCIDA` cuando ya no.
   */
  async cancel(actor: RequestUser, id: string, reason: string): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id);
      if (order.status === SalesOrderStatus.CANCELLED) {
        throw new ConflictException('El pedido ya está anulado');
      }
      if (order.status === SalesOrderStatus.FULFILLED) {
        throw new BadRequestException('Un pedido ya atendido no se anula');
      }

      // Lock de las reservas antes de leerlas, en orden de id. `production.report` escribe
      // primero el pedido y después la reserva; sin este lock, las dos transacciones tomaban
      // los mismos dos recursos en orden inverso y Postgres abortaba una con un deadlock que
      // salía al usuario como un 500 opaco.
      await tx.$queryRaw`
        SELECT "id" FROM "reservations" WHERE "sales_order_id" = ${id}::uuid
        ORDER BY "id" FOR UPDATE
      `;
      const reservations = await tx.reservation.findMany({
        where: { salesOrderId: id },
        include: {
          productionOrders: {
            where: {
              status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
            },
            select: { id: true, seq: true, status: true },
          },
        },
      });
      const liveOrders = reservations.flatMap((r) => r.productionOrders);
      // D-186: confirmar ya deja una OP en cola por línea a fabricar, así que anular el pedido
      // arrastra las que **nadie empezó** —en borrador: sin bobina montada (montar la pasa a
      // en curso) y sin reportes—. Exigir anularlas una por una antes era una traba nacida de
      // la automatización, no una protección: no hay material en custodia ni producción que
      // deshacer. Una OP en curso sigue bloqueando, como siempre.
      const idleIds: string[] = [];
      for (const op of liveOrders) {
        if (op.status !== ProductionOrderStatus.DRAFT) continue;
        const reported = await tx.productionReport.findFirst({
          where: { productionOrderId: op.id, status: ProductionReportStatus.ACTIVE },
          select: { id: true },
        });
        if (!reported) idleIds.push(op.id);
      }
      const blocking = liveOrders.filter((op) => !idleIds.includes(op.id));
      if (blocking.length > 0) {
        const detail = blocking.map((op) => `orden ${productionOrderCode(op.seq)}`).join(', ');
        throw new BadRequestException(
          `No se puede anular: ${detail} está fabricando con el material reservado. Anula la orden de producción primero.`,
        );
      }

      if (idleIds.length > 0) {
        // Sin lock previo de las OP a propósito: montar una bobina bloquea la OP y después la
        // reserva, y tomarlas acá en el orden inverso abriría un deadlock. En su lugar, la
        // condición `DRAFT` se reevalúa al escribir: si planta montó una bobina entre la lectura
        // y esta escritura, la fila ya no es `DRAFT`, se actualizan menos y la anulación entera
        // se deshace — nunca queda una OP en curso sobre un pedido anulado.
        const cancelledOrders = await tx.productionOrder.updateMany({
          where: { id: { in: idleIds }, status: ProductionOrderStatus.DRAFT },
          data: {
            status: ProductionOrderStatus.CANCELLED,
            cancelledById: actor.id,
            cancelledAt: new Date(),
          },
        });
        if (cancelledOrders.count !== idleIds.length) {
          throw new ConflictException(
            'Una orden de producción del pedido empezó a fabricarse mientras se anulaba: vuelve a intentarlo',
          );
        }
      }

      const active = reservations.filter((r) => r.status === ReservationStatus.ACTIVE);
      if (active.length > 0) {
        await tx.reservation.updateMany({
          where: { id: { in: active.map((r) => r.id) }, status: ReservationStatus.ACTIVE },
          data: {
            // D-054: lo que queda "prometido" cuando una reserva deja de estar ACTIVA es
            // cero — mismo criterio que `reduceReservation`/`releaseRemainingReservation`
            // (reservation-guard.ts). Sin esto, `reservations.qty` queda mintiendo el monto
            // original sobre una fila ya RELEASED (hallazgo de `qa`, Fase 7e).
            qty: '0',
            status: ReservationStatus.RELEASED,
            releasedAt: new Date(),
            releasedById: actor.id,
          },
        });
      }

      await tx.salesOrder.update({
        where: { id },
        data: {
          status: SalesOrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: actor.id,
        },
      });

      if (order.quotationId) {
        const quotation = await tx.quotation.findUniqueOrThrow({
          where: { id: order.quotationId },
          select: { validUntil: true, status: true },
        });
        const validUntil = quotation.validUntil?.toISOString().slice(0, 10) ?? null;
        const back = isQuotationExpired(validUntil, businessToday())
          ? QuotationStatus.EXPIRED
          : QuotationStatus.EMITTED;
        await tx.quotation.update({
          where: { id: order.quotationId },
          data: {
            status: back,
            confirmedAt: null,
            expiredAt: back === QuotationStatus.EXPIRED ? new Date() : null,
          },
        });
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.cancel',
        entity: 'sales_orders',
        entityId: id,
        before: { status: order.status, activeReservations: active.length },
        after: {
          status: SalesOrderStatus.CANCELLED,
          reason,
          cancelledProductionOrders: liveOrders
            .filter((op) => idleIds.includes(op.id))
            .map((op) => productionOrderCode(op.seq)),
        },
      });
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // D-054 — liberación manual de una reserva
  // -------------------------------------------------------------------------

  /**
   * Libera una reserva sin anular el pedido (D-054: sin vencimiento automático, alerta +
   * liberación manual). Solo ADMINISTRADOR, siempre con motivo: es material que se le
   * prometió a un cliente y que a partir de acá cualquier otra operación puede tomar.
   */
  async releaseReservation(
    actor: RequestUser,
    reservationId: string,
    reason: string,
  ): Promise<ReservationDto> {
    await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: {
          id: true,
          status: true,
          salesOrderId: true,
          productionOrders: {
            where: {
              status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
            },
            select: { seq: true },
            take: 1,
          },
        },
      });
      if (!reservation) throw new NotFoundException('Reserva no encontrada');
      if (reservation.status === ReservationStatus.RELEASED) {
        throw new ConflictException('La reserva ya está liberada');
      }
      if (reservation.status === ReservationStatus.CONSUMED) {
        throw new BadRequestException(
          'La reserva ya fue consumida por una orden de producción: no hay nada que liberar',
        );
      }
      // Mismo bloqueo que anular el pedido, y por el mismo motivo: si se libera el material
      // que una OP ya tiene montado, otro pedido lo puede reservar y el reporte de esa OP
      // queda trabado contra la invariante, sin culpa de planta.
      const busy = reservation.productionOrders[0];
      if (busy) {
        throw new BadRequestException(
          `La orden de producción ${productionOrderCode(busy.seq)} está fabricando con este material. Anúlala antes de liberar la reserva.`,
        );
      }
      const released = await tx.reservation.updateMany({
        where: { id: reservationId, status: ReservationStatus.ACTIVE },
        data: {
          status: ReservationStatus.RELEASED,
          releasedAt: new Date(),
          releasedById: actor.id,
        },
      });
      if (released.count !== 1) {
        throw new ConflictException('La reserva cambió de estado mientras se liberaba');
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.reservation.release',
        entity: 'reservations',
        entityId: reservationId,
        before: { status: ReservationStatus.ACTIVE },
        after: { status: ReservationStatus.RELEASED, reason },
      });
    });

    const row = await this.prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: {
        salesOrder: {
          select: {
            seq: true,
            customer: { select: { name: true } },
            items: { select: { productId: true } },
          },
        },
        productionOrders: {
          // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
          // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
          // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
          // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
          // fabricarla.
          where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
          select: { id: true, seq: true },
          take: 1,
        },
      },
    });
    const labels = await this.reserveLabels([row]);
    return this.toReservationDto(row, labels);
  }

  // -------------------------------------------------------------------------
  // Fase 7 — cola de producción (D-092..D-096)
  // -------------------------------------------------------------------------

  // D-189: la prioridad manual dejó de ser del pedido — se fija por orden de producción en
  // `RoofingProductionService.setPriority`.

  /**
   * Fecha prometida de entrega, después de que el pedido existe (D-096): el vendedor solo la
   * fija al confirmar/crear (`confirm`/`createDirect`); de acá en adelante es de
   * ADMINISTRADOR. `null` la borra.
   */
  async setPromisedDeliveryDate(
    actor: RequestUser,
    id: string,
    promisedDeliveryDate: string | null,
  ): Promise<SalesOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id);
      if (order.status === SalesOrderStatus.CANCELLED) {
        throw new BadRequestException('El pedido está anulado');
      }
      await tx.salesOrder.update({
        where: { id },
        data: {
          promisedDeliveryDate: promisedDeliveryDate ? toDateOnly(promisedDeliveryDate) : null,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.promised-delivery-date',
        entity: 'sales_orders',
        entityId: id,
        before: { promisedDeliveryDate: order.promisedDeliveryDate },
        after: { promisedDeliveryDate },
      });
    });
    return this.findOne(id);
  }

  /**
   * Líneas sin orden viva (D-093 original): pedidos con reserva de **materia prima** activa
   * sobre un producto que se fabrica contra el pedido (misma señal que
   * `resolveDispatchTarget`, D-088) y sin OP viva. No hay tabla: se recalcula en cada lectura.
   *
   * **D-189: esto dejó de ser la cola.** Desde D-186 confirmar crea las OPs, así que la cola
   * son las órdenes no iniciadas (`RoofingProductionService.queue`). Lo que queda acá es lo que
   * perdió su orden —una OP anulada devuelve la reserva, D-066— o un pedido anterior a D-186:
   * el punto desde el que planta vuelve a abrir una orden. Sin prioridad: la prioridad es de
   * la orden, y estas líneas todavía no tienen una.
   *
   * D-134: una venta de bobina entera (RF-73) sigue siendo una reserva `COIL` y **no** entra:
   * ese rollo se despacha, no se fabrica.
   */
  async findLinesWithoutOrder(actor: RequestUser): Promise<LineWithoutOrderDto[]> {
    const reservations = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        itemType: InventoryItemTypeEnum.RAW_MATERIAL,
        salesOrder: sellerWhere(actor),
      },
      include: {
        salesOrder: {
          select: {
            id: true,
            seq: true,
            createdAt: true,
            promisedDeliveryDate: true,
            customer: { select: { name: true } },
          },
        },
        salesOrderItem: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
            pieces: { orderBy: { lineNumber: 'asc' } },
          },
        },
        productionOrders: {
          where: {
            status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
          },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const pending = reservations.filter((r) => r.productionOrders.length === 0);
    if (pending.length === 0) return [];

    // D-092/D-122: v1 es solo Metallic Roofing, y lo que decide si una línea se fabrica es
    // el **producto**: su subtipo y su geometría. Hasta D-122 esto miraba la receta —el
    // filtro por `kind` descartaba el caso de una línea de drywall reservando bobina, que
    // habría recibido la aritmética de coberturas—; desde D-134 la reserva ya es
    // `RAW_MATERIAL` y solo la abre una cobertura a medida, así que el filtro es directo.
    const productIds = [...new Set(pending.map((r) => r.salesOrderItem.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, roofingKind: { not: null } },
      select: {
        id: true,
        lengthMm: true,
        thicknessMm: true,
        widthMm: true,
        finish: { select: { densityFactor: true } },
      },
    });
    const productById = new Map(products.map((p) => [p.id, p]));
    const eligible = pending.filter((r) => productById.has(r.salesOrderItem.productId));
    if (eligible.length === 0) return [];

    const today = businessToday();
    const entries = eligible.flatMap((r): LineWithoutOrderDto[] => {
      const product = productById.get(r.salesOrderItem.productId);
      if (!product) return [];
      const pieces = derivePiecesPlan(
        r.salesOrderItem.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty })),
        product.lengthMm === null ? null : product.lengthMm.toFixed(2),
        r.salesOrderItem.qty.toString(),
      );
      // D-134/D-122: el kilo teórico de la cola sale de la geometría **del SKU**, no de la
      // bobina reservada — que ya no existe: la reserva nombra un agregado. Es además el
      // mismo número que el vendedor vio al cotizar, que es lo que planta necesita para
      // saber cuánto material va a pedir esta orden antes de montar nada.
      const geometry: CoilGeometry | null =
        product.thicknessMm !== null && product.widthMm !== null && product.finish !== null
          ? {
              widthMm: product.widthMm.toFixed(2),
              thicknessMm: product.thicknessMm.toFixed(2),
              densityFactor: product.finish.densityFactor.toFixed(4),
            }
          : null;
      const promisedDeliveryDate = r.salesOrder.promisedDeliveryDate
        ? r.salesOrder.promisedDeliveryDate.toISOString().slice(0, 10)
        : null;
      return [
        {
          salesOrderId: r.salesOrder.id,
          salesOrderCode: salesOrderCode(r.salesOrder.seq),
          salesOrderItemId: r.salesOrderItemId,
          reservationId: r.id,
          customerName: r.salesOrder.customer.name,
          productId: r.salesOrderItem.productId,
          productSku: r.salesOrderItem.product.sku,
          productName: r.salesOrderItem.product.name,
          pieces,
          theoreticalKg: geometry ? roofingTheoreticalKg(geometry, pieces).toFixed(3) : null,
          promisedDeliveryDate,
          semaphore: queueSemaphore(promisedDeliveryDate, today),
          createdAt: r.salesOrder.createdAt.toISOString(),
        },
      ];
    });

    // Semáforo y después el pedido más antiguo. Estas líneas no tienen prioridad (D-189).
    const semaphoreRank: Record<QueueSemaphore, number> = {
      VENCIDO: 0,
      PROXIMO: 1,
      A_TIEMPO: 2,
      SIN_FECHA: 3,
    };
    return entries.sort((a, b) => {
      const rankDiff = semaphoreRank[a.semaphore] - semaphoreRank[b.semaphore];
      if (rankDiff !== 0) return rankDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  private async computeOrderContext(row: OrderRow): Promise<{
    queueStatus: QueueStatus | null;
    readiness: OrderReadinessDto;
  }> {
    const ops = await this.prisma.productionOrder.findMany({
      where: { reservation: { salesOrderId: row.id } },
      select: {
        status: true,
        kind: true,
        reservation: {
          select: {
            salesOrderItem: {
              select: { reserveQty: true },
            },
          },
        },
        reports: {
          where: { status: 'ACTIVE' },
          select: { metersM: true },
        },
      },
    });

    const liveRoofing = ops.filter(
      (o) => o.kind === 'ROOFING' && (o.status === 'DRAFT' || o.status === 'IN_PROGRESS'),
    );
    const queueStatus = liveRoofing.some((o) => o.status === 'IN_PROGRESS')
      ? 'EN_PRODUCCION'
      : liveRoofing.length > 0
        ? 'EN_COLA'
        : null;

    const readinessOrders = ops.map((op) => {
      const orderedMl = op.reservation?.salesOrderItem?.reserveQty?.toString() ?? '0.000';
      const reportedMl = op.reports
        .reduce((sum, r) => sum + (r.metersM ? Number(r.metersM) : 0), 0)
        .toFixed(3);

      return {
        status: op.status,
        orderedMl,
        reportedMl,
      };
    });
    const readiness = deriveOrderReadiness(readinessOrders);

    return { queueStatus, readiness };
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async findAll(
    actor: RequestUser,
    query: SalesOrderQuery,
  ): Promise<PaginatedResult<SalesOrderListItemDto>> {
    // El código del pedido (`PED-000123`) es `salesOrderCode(seq)`, no una columna: buscar
    // "PED-000123" o solo "123" tiene que extraer el número y filtrar por `seq`, o quien
    // pega el código de un pedido para encontrarlo (el uso más común del buscador) se
    // quedaba sin resultados (Fase 7d, hallazgo de revisión).
    const searchSeq = query.search ? query.search.replace(/\D/g, '') : '';
    const where: Prisma.SalesOrderWhereInput = {
      ...sellerWhere(actor),
      status: query.status,
      customerId: query.customerId,
      // D-119: sin `businessLineId` propio, "de esta línea" es "tiene algún ítem de esta
      // línea" — un pedido mixto aparece en el filtro de cualquiera de sus líneas.
      items: query.businessLine
        ? { some: { product: { businessLine: { code: toPrismaLineCode(query.businessLine) } } } }
        : undefined,
      ...(query.search
        ? {
            OR: [
              { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
              { customer: { docNumber: { contains: query.search } } },
              ...(searchSeq ? [{ seq: Number(searchSeq) }] : []),
            ],
          }
        : {}),
    };
    const { skip, take } = toSkipTake(query);
    const [total, rows] = await Promise.all([
      this.prisma.salesOrder.count({ where }),
      this.prisma.salesOrder.findMany({
        where,
        // Igual que la lista de cotizaciones: totales, no detalle. Las reservas activas se
        // cuentan con un `_count` filtrado en vez de materializar cada una con su pedido,
        // su cliente y su orden de producción.
        include: {
          ...orderInclude,
          items: false,
          reservations: false,
          // D-141: el número del comprobante importado no se muestra en la lista y traerlo
          // costaba una consulta más por página. `origin` sí viaja: es una columna de la
          // propia fila.
          fiscalDocuments: false,
          _count: {
            select: {
              items: true,
              reservations: { where: { status: ReservationStatus.ACTIVE } },
            },
          },
        },
        orderBy: { seq: 'desc' },
        skip,
        take,
      }),
    ]);
    const actors = await this.resolveActorNames(rows.map((r) => r.createdById));

    // M2: Compute readiness for list
    const ops = await this.prisma.productionOrder.findMany({
      where: { reservation: { salesOrderId: { in: rows.map((r) => r.id) } } },
      select: {
        status: true,
        kind: true,
        reservation: {
          select: { salesOrderId: true, salesOrderItem: { select: { reserveQty: true } } },
        },
        reports: { where: { status: 'ACTIVE' }, select: { metersM: true } },
      },
    });

    const contextByOrderId = new Map<
      string,
      { queueStatus: QueueStatus | null; readiness: OrderReadinessDto }
    >();
    for (const row of rows) {
      const orderOps = ops.filter((op) => op.reservation?.salesOrderId === row.id);
      const liveRoofing = orderOps.filter(
        (o) => o.kind === 'ROOFING' && (o.status === 'DRAFT' || o.status === 'IN_PROGRESS'),
      );
      const queueStatus = liveRoofing.some((o) => o.status === 'IN_PROGRESS')
        ? 'EN_PRODUCCION'
        : liveRoofing.length > 0
          ? 'EN_COLA'
          : null;

      const readinessOrders = orderOps.map((op) => {
        const orderedMl = op.reservation?.salesOrderItem?.reserveQty?.toString() ?? '0.000';
        const reportedMl = op.reports
          .reduce((sum, r) => sum + (r.metersM ? Number(r.metersM) : 0), 0)
          .toFixed(3);
        return { status: op.status, orderedMl, reportedMl };
      });
      const readiness = deriveOrderReadiness(readinessOrders);
      contextByOrderId.set(row.id, { queueStatus, readiness });
    }

    const items = rows.map((r) => {
      const dto = this.toDto(
        { ...r, items: [], reservations: [], fiscalDocuments: [] },
        new Map(),
        actors,
        contextByOrderId.get(r.id),
      );
      const {
        items: _items,
        reservations: _reservations,
        importedDocumentId: _importedDocumentId,
        importedDocumentNumber: _importedDocumentNumber,
        priceChanges: _priceChanges,
        isEditable: _isEditable,
        ...rest
      } = dto;
      return {
        ...rest,
        itemCount: r._count.items,
        activeReservations: r._count.reservations,
      };
    });
    return paginate(items, total, query);
  }

  async findOne(id: string, actor?: RequestUser): Promise<SalesOrderDto> {
    const row = await this.prisma.salesOrder.findUnique({ where: { id }, include: orderInclude });
    if (!row) throw new NotFoundException('Pedido no encontrado');
    if (actor) assertSellerAccess(actor, row.sellerId, 'Pedido');
    const labels = await this.reserveLabels([...row.items.map(toReserveRef), ...row.reservations]);
    const [actors, context, priceChanges, invoice] = await Promise.all([
      this.resolveActorNames([row.createdById]),
      this.computeOrderContext(row),
      findPriceChanges(this.prisma, { salesOrderId: id }),
      // D-187: el mismo corte que `SalesOrderEditsService.lockEditable`.
      this.prisma.fiscalDocument.findFirst({
        where: {
          salesOrderId: id,
          docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
          status: { in: [...STANDING_DOCUMENT_STATUSES] },
          archivedAt: null,
        },
        select: { id: true },
      }),
    ]);
    return {
      ...this.toDto(row, labels, actors, context),
      priceChanges,
      isEditable: row.status !== SalesOrderStatus.CANCELLED && !invoice,
    };
  }

  /**
   * Hoja de planta del pedido (D-149): el papel que baja al taller.
   *
   * Se arma al vuelo y **no** se guarda en R2, a diferencia del PDF de la cotización
   * (D-068): aquel es un documento que se le manda al cliente y tiene que quedar congelado
   * tal como se envió; este es una copia de trabajo del estado actual del pedido, y una
   * versión vieja guardada sería justamente lo que no se quiere que baje a la planta.
   *
   * Sin importes, a propósito: ver `plant-order-pdf.ts`.
   */
  async plantPdf(id: string, actor: RequestUser): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.prisma.salesOrder.findUnique({
      where: { id },
      select: {
        sellerId: true,
        seq: true,
        status: true,
        issueDate: true,
        promisedDeliveryDate: true,
        notes: true,
        // D-189: la prioridad es de cada orden viva del pedido; el papel dice las que la tengan.
        reservations: {
          select: {
            productionOrders: {
              where: { status: { in: ['DRAFT', 'IN_PROGRESS'] }, priorityAt: { not: null } },
              select: { seq: true, priorityReason: true },
            },
          },
        },
        customer: { select: { name: true, docType: true, docNumber: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          select: {
            lineNumber: true,
            qty: true,
            unit: true,
            pieces: { orderBy: { lineNumber: 'asc' } },
            product: {
              select: {
                sku: true,
                name: true,
                thicknessMm: true,
                widthMm: true,
                lengthMm: true,
                color: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Pedido no encontrado');
    assertSellerAccess(actor, row.sellerId, 'Pedido');
    if (row.status === SalesOrderStatus.CANCELLED) {
      throw new BadRequestException('El pedido está anulado: no hay nada que producir');
    }

    const buffer = await buildPlantOrderPdf({
      code: salesOrderCode(row.seq),
      issueDate: fromDateOnly(row.issueDate),
      promisedDeliveryDate: row.promisedDeliveryDate
        ? fromDateOnly(row.promisedDeliveryDate)
        : null,
      customerName: row.customer.name,
      customerDoc: `${row.customer.docType} ${row.customer.docNumber}`,
      // Solo cuando alguna orden está priorizada: el motivo sin la marca no significa nada.
      priorityReason: priorityNoteOf(row.reservations.flatMap((r) => r.productionOrders)),
      notes: row.notes,
      lines: row.items.map((item) => {
        const product = item.product;
        // D-171: una plancha no trae subítems —su largo está en el SKU— y hasta acá el papel
        // que se lleva planta imprimía «—» en la columna del plan de corte, justo ahora que es
        // la línea que hay que rolar. Se deriva con la **misma** función que usa la cola
        // (D-093) y que copia la OP al nacer (D-084), así que el papel, la pantalla y la orden
        // dicen los mismos largos.
        const pieces =
          item.pieces.length > 0
            ? item.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty }))
            : derivePiecesPlan(
                [],
                product.lengthMm === null ? null : product.lengthMm.toFixed(2),
                item.qty.toString(),
              ).map((p) => ({ lengthMm: p.lengthMm, qty: p.qty }));
        // Lo que decide qué bobina se monta (D-086): espesor, ancho y color. El largo fijo
        // solo lo tiene una plancha de catálogo (D-127).
        const measures = [
          product.thicknessMm === null ? null : `${product.thicknessMm.toFixed(2)} mm`,
          product.widthMm === null ? null : `${product.widthMm.toFixed(2)} mm de ancho`,
          product.lengthMm === null
            ? null
            : `largo fijo ${toDecimal(product.lengthMm.toString()).div(1000).toFixed(2)} m`,
          product.color?.name ?? null,
        ].filter((v): v is string => v !== null);
        return {
          lineNumber: item.lineNumber,
          productSku: product.sku,
          productName: product.name,
          quantity: toDecimal(item.qty.toString()).toFixed(item.unit === Unit.MTR ? 3 : 0),
          unitLabel: item.unit === Unit.MTR ? 'm' : 'u',
          pieces: pieces.length === 0 ? '—' : describePieces(pieces),
          measures: measures.length === 0 ? '—' : measures.join(' · '),
        };
      }),
    });
    return { buffer, filename: `${salesOrderCode(row.seq)}-planta.pdf` };
  }

  /**
   * El panel de stock en vivo del formulario de cotización (D-136).
   *
   * Reemplaza al selector de bobina que D-134 eliminó, y cambia de pregunta: aquel pedía
   * **cuál rollo**, este responde **cuánto hay**. Vive acá y no en `coils` porque VENDEDOR
   * no llega a esa ruta —expone costos y proveedor, que §3.4 le oculta— y acá no viaja
   * ningún costo.
   *
   * Dos mitades, porque el vendedor vende dos cosas distintas: el **agregado** de materia
   * prima (lo que una cobertura a medida va a consumir, en kilos y en metros teóricos) y el
   * **stock por SKU** (lo que se vende tal cual: planchas, perfiles, UPVC).
   */
  async stockPanel(actor: RequestUser, query: StockPanelQuery): Promise<StockPanelDto> {
    const [rawMaterial, products] = await Promise.all([
      query.businessLine === undefined
        ? Promise.resolve<RawMaterialStockDto[]>([])
        : this.rawMaterialStock(query.businessLine),
      this.productStock(query.productIds),
    ]);
    return { rawMaterial, products };
  }

  /**
   * Las bobinas abiertas de una línea, agrupadas por **espesor + color**, que es el agregado
   * contra el que se promete (D-134).
   *
   * Se descuentan las bobinas que una OP viva tiene montadas (D-060): su saldo se ve intacto
   * porque asignar no mueve kardex, y ofrecerlas llevaría al vendedor a un 400 al confirmar
   * o —peor— a trabar esa corrida de planta.
   */
  private async rawMaterialStock(businessLine: BusinessLine): Promise<RawMaterialStockDto[]> {
    const coils = await this.prisma.coil.findMany({
      where: {
        kind: CoilKind.COIL,
        status: CoilStatus.OPEN,
        businessLine: { code: toPrismaLineCode(businessLine) },
      },
      select: {
        id: true,
        widthMm: true,
        thicknessMm: true,
        colorId: true,
        color: { select: { name: true, hexColor: true } },
        finish: { select: { densityFactor: true } },
      },
      orderBy: { code: 'asc' },
      take: DERIVED_FILTER_FETCH_CAP,
    });
    if (coils.length === 0) return [];

    const ids = coils.map((c) => c.id);
    const [balances, reservedById, mounted, specs] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: InventoryItemTypeEnum.COIL, itemId: { in: ids } },
        select: { itemId: true, qty: true },
      }),
      // D-185: firme más temporal vigente.
      reservedByItem(this.prisma, InventoryItemTypeEnum.COIL, ids),
      findLiveStripAssignments(this.prisma, ids),
      this.prisma.rawMaterialSpec.findMany({
        where: { businessLine: { code: toPrismaLineCode(businessLine) } },
        select: { id: true, colorId: true, thicknessMm: true },
      }),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const takenByProduction = new Set(mounted.map((m) => m.coilId));

    // Lo prometido de forma genérica, por spec. Se reparte después entre los grupos que la
    // tolerancia alcanza (ver el comentario del DTO: el reparto se puede solapar, y ante la
    // duda el panel muestra de menos).
    const promisedBySpec = await reservedByItem(
      this.prisma,
      InventoryItemTypeEnum.RAW_MATERIAL,
      specs.map((sp) => sp.id),
    );
    const tolerance = toDecimal(roofingToleranceMm(this.env));

    const groups = new Map<string, RawMaterialStockDto & { thickness: Decimal }>();
    for (const coil of coils) {
      if (takenByProduction.has(coil.id)) continue;
      const physical = qtyById.get(coil.id) ?? new Decimal(0);
      const onCoil = reservedById.get(coil.id) ?? new Decimal(0);
      const thicknessMm = coil.thicknessMm.toFixed(2);
      const key = `${coil.colorId ?? '-'}|${thicknessMm}`;
      // Metros por kilo de ESTE rollo: el ancho es suyo, no del grupo, así que los metros se
      // suman rollo por rollo y no se derivan del total de kilos.
      const perMeter = kgPerMeter({
        widthMm: coil.widthMm.toFixed(2),
        thicknessMm,
        densityFactor: coil.finish.densityFactor.toFixed(4),
      });
      const group = groups.get(key) ?? {
        colorId: coil.colorId,
        colorName: coil.color?.name ?? null,
        colorHex: coil.color?.hexColor ?? null,
        thicknessMm,
        coils: 0,
        physicalKg: '0',
        reservedKg: '0',
        availableKg: '0',
        theoreticalMeters: '0',
        thickness: toDecimal(thicknessMm),
      };
      group.coils += 1;
      group.physicalKg = toDecimal(group.physicalKg).plus(physical).toFixed(3);
      group.reservedKg = toDecimal(group.reservedKg).plus(onCoil).toFixed(3);
      group.theoreticalMeters = toDecimal(group.theoreticalMeters)
        .plus(
          perMeter.isZero()
            ? new Decimal(0)
            : Decimal.max(physical.minus(onCoil), new Decimal(0)).div(perMeter),
        )
        .toFixed(3);
      groups.set(key, group);
    }

    const out: RawMaterialStockDto[] = [];
    for (const group of groups.values()) {
      const promised = specs
        .filter(
          (sp) =>
            sp.colorId === group.colorId &&
            toDecimal(sp.thicknessMm.toString()).minus(group.thickness).abs().lte(tolerance),
        )
        .reduce((acc, sp) => acc.plus(promisedBySpec.get(sp.id) ?? new Decimal(0)), new Decimal(0));
      const reserved = toDecimal(group.reservedKg).plus(promised);
      const { thickness: _thickness, ...dto } = group;
      out.push({
        ...dto,
        reservedKg: reserved.toFixed(3),
        availableKg: Decimal.max(
          toDecimal(group.physicalKg).minus(reserved),
          new Decimal(0),
        ).toFixed(3),
      });
    }
    return out.sort(
      (a, b) =>
        (a.colorName ?? '').localeCompare(b.colorName ?? '') ||
        a.thicknessMm.localeCompare(b.thicknessMm),
    );
  }

  /** Disponible por SKU, en su unidad de venta, más el agregado de las coberturas a medida. */
  private async productStock(productIds: string[]): Promise<ProductStockDto[]> {
    if (productIds.length === 0) return [];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        name: true,
        // D-163: `ROOFING_PRODUCT_SELECT` ya trae `businessLineId` —lo que el piso de precio
        // necesita para encontrar el margen mínimo de la línea— y, desde D-171, también
        // `unit` y `lengthMm`, que `orderedMeters` usa para convertir planchas en metros.
        ...ROOFING_PRODUCT_SELECT,
        // D-167: si la línea lleva existencias. El panel lo muestra en vez de un cero.
        businessLine: { select: { inventoryStrategy: true } },
      },
    });
    if (products.length === 0) return [];

    const [balances, reservedById] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: InventoryItemTypeEnum.PRODUCT, itemId: { in: productIds } },
        select: { itemId: true, qty: true },
      }),
      // D-185: firme más temporal vigente.
      reservedByItem(this.prisma, InventoryItemTypeEnum.PRODUCT, productIds),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));

    // D-163: el piso de precio de cada SKU, con la **misma** función que lo va a exigir al
    // guardar. Los candidatos se arman **dentro** del bucle de abajo y no en uno propio, para
    // reusar el agregado que ese bucle ya resuelve: en una cobertura a medida el costo por
    // metro sale de las mismas bobinas cuyo disponible se está leyendo, y resolver la spec dos
    // veces era duplicar la consulta más cara de una ruta que el formulario llama en cada
    // cambio de selección.
    const floorCandidates: PriceFloorCandidate[] = [];

    const out: ProductStockDto[] = [];
    for (const product of products) {
      const available = Decimal.max(
        (qtyById.get(product.id) ?? new Decimal(0)).minus(
          reservedById.get(product.id) ?? new Decimal(0),
        ),
        new Decimal(0),
      );
      let rawMaterialAvailableKg: string | null = null;
      let rawLabel: string | null = null;
      let perMeter: string | null = null;
      // D-161: si el SKU se cotiza por metro contra su largo fijo, el mínimo se calcula —y se
      // muestra— **por metro**, que es la unidad en la que el vendedor lo va a tipear.
      const basis: PriceFloorCandidate['basis'] =
        sellsByFixedLength({
          roofingKind: product.roofingKind,
          unit: product.unit,
          lengthMm: product.lengthMm === null ? null : product.lengthMm.toFixed(2),
        }) && product.lengthMm !== null
          ? { kind: 'PER_METER', lengthMm: product.lengthMm.toFixed(2) }
          : { kind: 'UNIT', unitLabel: product.unit };
      // D-134: una cobertura no se atiende con stock del producto —siempre cero— sino con el
      // agregado. Mostrarle al vendedor el cero del SKU sería mentirle sobre lo único que
      // decide si puede prometer. **D-171: y la plancha de catálogo tampoco**, desde que se
      // produce contra el pedido; ese cero era literalmente el mensaje de la captura del
      // dueño («0.000 NIU disponibles… necesita 10»).
      if (isMadeToOrder(product) && product.thicknessMm !== null && product.finish !== null) {
        // D-136: el panel es una **lectura**. `findRawMaterialSpec` no crea la fila si no
        // existe: el disponible de un agregado que nadie prometió todavía es el mismo.
        const spec = await findRawMaterialSpec(this.prisma, {
          businessLineId: product.businessLineId,
          colorId: product.colorId,
          thicknessMm: product.thicknessMm.toFixed(2),
        });
        const availability = await rawMaterialAvailability(
          this.prisma,
          spec,
          roofingToleranceMm(this.env),
        );
        rawMaterialAvailableKg = Decimal.max(availability.available, new Decimal(0)).toFixed(3);
        // La etiqueta se arma con el propio producto y no consultando el agregado: así vale
        // igual exista o no todavía su fila —el caso de un SKU nuevo que nadie cotizó— y de
        // paso se ahorra una consulta por producto en una ruta que el formulario llama en
        // cada cambio.
        rawLabel = rawMaterialLabel({
          thicknessMm: product.thicknessMm.toFixed(2),
          colorName: product.color?.name ?? null,
        });
        if (product.widthMm !== null && product.thicknessMm !== null) {
          perMeter = kgPerMeter({
            widthMm: product.widthMm.toFixed(2),
            thicknessMm: product.thicknessMm.toFixed(2),
            densityFactor: product.finish.densityFactor.toFixed(4),
          }).toFixed(3);
          // D-163: el costo por metro de la cobertura, contra el agregado que se acaba de
          // resolver arriba. Sin `widthMm` no hay kilo por metro y por lo tanto no hay piso.
          floorCandidates.push({
            at: product.id,
            sku: product.sku,
            businessLineId: product.businessLineId,
            basis,
            // La lectura no compara contra nada: el valor propuesto es irrelevante y va en cero.
            unitValuePen: '0.0000',
            cost: {
              kind: 'RAW_MATERIAL',
              spec,
              // D-171: el kilo de **una unidad de venta**, que en una plancha lleva su largo
              // adentro. Con el `'1'` a secas, el piso de una plancha de 6 m salía calculado
              // sobre el material de un solo metro: seis veces más barato de lo que cuesta.
              kgPerUnit: theoreticalKgForMeters(product, orderedMeters(product, '1'), product.sku),
            },
          });
        }
      } else if (carriesInventory(product.businessLine)) {
        floorCandidates.push({
          at: product.id,
          sku: product.sku,
          businessLineId: product.businessLineId,
          basis,
          unitValuePen: '0.0000',
          cost: { kind: 'PRODUCT', productId: product.id },
        });
      }
      out.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        availableQty: available.toFixed(3),
        rawMaterialAvailableKg,
        rawMaterialLabel: rawLabel,
        kgPerMeter: perMeter,
        // Se completan abajo, cuando estén todos los candidatos juntos: el piso se calcula en
        // una tanda para no repetir por SKU la consulta de márgenes y la de costos.
        minPricePen: null,
        minValuePen: null,
        carriesInventory: carriesInventory(product.businessLine),
      });
    }

    const floors = await computePriceFloors(
      this.prisma,
      floorCandidates,
      roofingToleranceMm(this.env),
    );
    return out.map((row) => {
      const floor = floors.get(row.productId);
      return floor === undefined
        ? row
        : { ...row, minPricePen: floor.minPricePen, minValuePen: floor.minValuePen };
    });
  }

  /**
   * Bobinas DISPONIBLES para vender enteras (D-116): `OPEN` o `CLOSED` (nunca en corte ni
   * anulada/vendida), de kind `COIL` (un fleje no se vende como bobina), sin custodia de
   * producción y con saldo. Solo Drywall y Metallic Roofing tienen bobina (C).
   */
  async findSellableCoils(
    actor: RequestUser,
    query: SellableCoilQuery,
  ): Promise<SellableCoilDto[]> {
    const lines = query.businessLine ? [query.businessLine] : [...COIL_BUSINESS_LINES];
    const coils = await this.prisma.coil.findMany({
      where: {
        kind: CoilKind.COIL,
        status: { in: [CoilStatus.OPEN, CoilStatus.CLOSED] },
        businessLine: { code: { in: lines.map(toPrismaLineCode) } },
        ...(query.search
          ? { code: { contains: query.search, mode: Prisma.QueryMode.insensitive } }
          : {}),
      },
      select: {
        id: true,
        code: true,
        typeKey: true,
        widthMm: true,
        thicknessMm: true,
        status: true,
        // D-163: el margen mínimo del piso es por línea de negocio.
        businessLineId: true,
        businessLine: { select: { code: true } },
        finish: { select: { code: true, name: true } },
        color: { select: { code: true, name: true } },
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
    if (coils.length === 0) return [];

    const ids = coils.map((c) => c.id);
    const [balances, reservedById, assigned] = await Promise.all([
      this.prisma.inventoryBalance.findMany({
        where: { itemType: InventoryItemTypeEnum.COIL, itemId: { in: ids } },
        // D-170: el promedio viaja junto al saldo — es a lo que el kardex va a dar de baja
        // el rollo cuando la venta lo despache, y el número contra el que el vendedor
        // negocia el precio por kilo.
        select: { itemId: true, qty: true, avgCost: true },
      }),
      // D-185 (F8-S2b): firme más temporal vigente, salvo la reserva propia de la cotización
      // que se está editando — es su bobina, y el picker tiene que volver a ofrecerla. Una
      // bobina reservada por otra cotización sigue descontada, como siempre.
      reservedByItem(this.prisma, InventoryItemTypeEnum.COIL, ids, {
        exceptQuotationIds: query.excludeQuotationId ? [query.excludeQuotationId] : [],
      }),
      // D-060: montada en una OP viva (roofing) no se puede vender aunque el saldo esté
      // intacto — asignar no mueve kardex, así que el disponible no lo delata.
      this.prisma.productionOrderConsumption.findMany({
        where: {
          coilId: { in: ids },
          releasedAt: null,
          productionOrder: {
            status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
          },
        },
        select: { coilId: true },
      }),
    ]);
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const avgCostById = new Map(balances.map((b) => [b.itemId, b.avgCost.toFixed(4)]));
    const assignedIds = new Set(assigned.map((a) => a.coilId));

    // D-163: el piso por kg de cada rollo vendible, con la misma función que lo va a exigir
    // al guardar. Se calcula sobre los que sobreviven al filtro, no sobre los 500 leídos.
    const sellable = coils.filter((c) => !assignedIds.has(c.id));
    const floors = await computePriceFloors(
      this.prisma,
      sellable.map((c) => ({
        at: c.id,
        sku: c.code,
        businessLineId: c.businessLineId,
        basis: { kind: 'UNIT' as const, unitLabel: 'kg' },
        // La lectura no compara contra nada: el valor propuesto es irrelevante y va en cero.
        unitValuePen: '0.0000',
        cost: { kind: 'COIL' as const, coilId: c.id },
      })),
      roofingToleranceMm(this.env),
    );

    return sellable
      .map((c) => {
        const qty = qtyById.get(c.id) ?? toDecimal('0');
        const res = reservedById.get(c.id) ?? toDecimal('0');
        return {
          coilId: c.id,
          code: c.code,
          businessLine: toSharedLineCode(c.businessLine.code),
          typeKey: c.typeKey,
          finishCode: c.finish.code,
          finishName: c.finish.name,
          colorCode: c.color?.code ?? null,
          colorName: c.color?.name ?? null,
          widthMm: c.widthMm.toFixed(2),
          thicknessMm: c.thicknessMm.toFixed(2),
          status: c.status as 'OPEN' | 'CLOSED',
          availableQty: qty.minus(res).toFixed(3),
          minPricePen: floors.get(c.id)?.minPricePen ?? null,
          ...(actor.role === Role.ADMINISTRADOR
            ? { avgCostPen: avgCostById.get(c.id) ?? null }
            : {}),
        };
      })
      .filter((c) => toDecimal(c.availableQty).gt(0));
  }

  async findReservations(actor: RequestUser, query: ReservationQuery): Promise<ReservationDto[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        status: query.status,
        itemId: query.itemId,
        salesOrderId: query.salesOrderId,
        salesOrder: sellerWhere(actor),
      },
      include: {
        salesOrder: {
          select: {
            seq: true,
            customer: { select: { name: true } },
            items: { select: { productId: true } },
          },
        },
        productionOrders: {
          // Solo la OP **viva** (D-084): anular una de coberturas deja `reservation_id`
          // apuntando a la reserva y la devuelve a ACTIVA (D-066), así que con la última a
          // secas la reserva quedaba con una OP anulada colgada — y `/planta`, que ofrece las
          // reservas sin OP, la hacía desaparecer del único punto de entrada para volver a
          // fabricarla.
          where: { status: { in: ['DRAFT', 'IN_PROGRESS'] } },
          select: { id: true, seq: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const labels = await this.reserveLabels(rows);
    return rows.map((r) => this.toReservationDto(r, labels));
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  private async lockOrder(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{
    id: string;
    seq: number;
    status: SalesOrderStatus;
    /** D-141: quién creó el pedido; lo mira el archivado por reimportación. */
    origin: SalesOrderOrigin;
    quotationId: string | null;
    promisedDeliveryDate: string | null;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        seq: number;
        status: SalesOrderStatus;
        origin: SalesOrderOrigin;
        quotation_id: string | null;
        promised_delivery_date: Date | null;
      }[]
    >`
      SELECT "id", "seq", "status", "origin", "quotation_id",
             "promised_delivery_date"
      FROM "sales_orders" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Pedido no encontrado');
    return {
      id: row.id,
      seq: row.seq,
      status: row.status,
      origin: row.origin,
      quotationId: row.quotation_id,
      promisedDeliveryDate: row.promised_delivery_date
        ? row.promised_delivery_date.toISOString().slice(0, 10)
        : null,
    };
  }

  private async itemLabel(
    tx: Prisma.TransactionClient,
    itemType: InventoryItemType,
    itemId: string,
  ): Promise<string> {
    if (itemType === 'COIL') {
      const coil = await tx.coil.findUnique({ where: { id: itemId }, select: { code: true } });
      return coil?.code ?? 'la bobina';
    }
    if (itemType === 'RAW_MATERIAL') {
      return (await rawMaterialSpecLabels(tx, [itemId])).get(itemId) ?? 'la materia prima';
    }
    const product = await tx.product.findUnique({ where: { id: itemId }, select: { sku: true } });
    return product?.sku ?? 'el producto';
  }

  /**
   * Etiqueta y nombre de cada ítem reservado, en dos consultas para toda la lista. Acepta
   * tanto filas de reserva (`itemType`/`itemId`) como líneas de pedido
   * (`reserveItemType`/`reserveItemId`), que son las mismas coordenadas con otro nombre.
   */
  private async reserveLabels(
    rows: ReserveRef[],
  ): Promise<Map<string, { label: string; name: string }>> {
    const refs = rows.map((r) => ({
      itemType: 'itemType' in r ? r.itemType : r.reserveItemType,
      itemId: 'itemId' in r ? r.itemId : r.reserveItemId,
    }));
    const map = new Map<string, { label: string; name: string }>();
    const coilIds = refs.filter((r) => r.itemType === 'COIL').map((r) => r.itemId);
    const productIds = refs.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId);
    // D-134: el agregado no es una bobina ni un producto, así que necesita su propia
    // etiqueta. Sin esta rama la línea de una cobertura a medida se mostraba con el id
    // crudo, que es lo que D-088 dejó dicho que pasa cuando se agrega una coordenada y no
    // se recorren todos sus lectores.
    const specIds = refs.filter((r) => r.itemType === 'RAW_MATERIAL').map((r) => r.itemId);
    if (specIds.length > 0) {
      const labels = await rawMaterialSpecLabels(this.prisma, specIds);
      for (const [id, label] of labels) map.set(id, { label, name: label });
    }
    if (coilIds.length > 0) {
      const coils = await this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true, typeKey: true },
      });
      for (const c of coils) map.set(c.id, { label: c.code, name: c.typeKey });
    }
    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true },
      });
      for (const p of products) map.set(p.id, { label: p.sku, name: p.name });
    }
    return map;
  }

  private toReservationDto(
    row: ReservationRow,
    labels: Map<string, { label: string; name: string }>,
  ): ReservationDto {
    const op = row.productionOrders[0];
    const staleFrom = new Date(Date.now() - RESERVATION_STALE_DAYS * 24 * 60 * 60 * 1000);
    const label = labels.get(row.itemId);
    return {
      id: row.id,
      salesOrderId: row.salesOrderId,
      salesOrderCode: salesOrderCode(row.salesOrder.seq),
      salesOrderItemId: row.salesOrderItemId,
      customerName: row.salesOrder.customer.name,
      orderProductIds: [...new Set(row.salesOrder.items.map((i) => i.productId))],
      itemType: row.itemType,
      itemId: row.itemId,
      itemLabel: label?.label ?? row.itemId,
      itemName: label?.name ?? '',
      qty: row.qty.toFixed(3),
      unit: row.unit,
      status: row.status,
      productionOrderId: op?.id ?? null,
      productionOrderCode: op ? productionOrderCode(op.seq) : null,
      isStale: row.status === ReservationStatus.ACTIVE && row.createdAt < staleFrom,
      createdAt: row.createdAt.toISOString(),
      consumedAt: row.consumedAt?.toISOString() ?? null,
      releasedAt: row.releasedAt?.toISOString() ?? null,
    };
  }

  /** Nombres de los usuarios que crearon las filas, en una sola consulta. */
  private async resolveActorNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(
    row: OrderRow,
    labels: Map<string, { label: string; name: string }>,
    actors: Map<string, string>,
    context?: { queueStatus: QueueStatus | null; readiness: OrderReadinessDto },
  ): SalesOrderDto {
    return {
      id: row.id,
      code: salesOrderCode(row.seq),
      quotationId: row.quotation?.id ?? null,
      quotationCode: row.quotation ? quotationCode(row.quotation.seq) : null,
      customerId: row.customer.id,
      customerName: row.customer.name,
      customerDocNumber: row.customer.docNumber,
      // D-119: distintas, en el orden en que aparecen los ítems — sin una línea "del
      // documento" que ordene de otra forma.
      businessLines: [
        ...new Set(row.items.map((i) => toSharedLineCode(i.product.businessLine.code))),
      ],
      status: row.status,
      origin: row.origin,
      importedDocumentId: row.fiscalDocuments[0]?.id ?? null,
      importedDocumentNumber: row.fiscalDocuments[0]?.number ?? null,
      issueDate: row.issueDate.toISOString().slice(0, 10),
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
      notes: row.notes,
      items: row.items.map((i) => toSalesItemDto(i, labels.get(i.reserveItemId)?.label ?? '')),
      reservations: row.reservations.map((r) => this.toReservationDto(r, labels)),
      createdAt: row.createdAt.toISOString(),
      createdById: row.createdById,
      createdByName: actors.get(row.createdById) ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      promisedDeliveryDate: row.promisedDeliveryDate
        ? row.promisedDeliveryDate.toISOString().slice(0, 10)
        : null,
      queueStatus: context?.queueStatus ?? null,
      priceChanges: [],
      isEditable: false,
      readiness: context?.readiness ?? {
        status: 'SIN_PRODUCCION',
        orderedMl: '0.000',
        reportedMl: '0.000',
        missingMl: '0.000',
      },
    };
  }
}

/**
 * D-189: el renglón «Prioridad» de la hoja de planta, armado con las órdenes vivas del pedido
 * que la tienen. `null` si ninguna: el motivo sin la marca no significa nada.
 */
function priorityNoteOf(
  orders: readonly { seq: number; priorityReason: string | null }[],
): string | null {
  if (orders.length === 0) return null;
  return [...orders]
    .sort((a, b) => a.seq - b.seq)
    .map((o) => `${productionOrderCode(o.seq)}: ${o.priorityReason ?? 'sin motivo escrito'}`)
    .join(' · ');
}

function toTemporaryLine(
  row: {
    id: string;
    lineNumber: number;
    itemType: InventoryItemType;
    itemId: string;
    qty: Prisma.Decimal;
    unit: string;
  },
  labels: Map<string, string>,
): TemporaryReservationLineDto {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    itemType: row.itemType,
    itemId: row.itemId,
    itemLabel: labels.get(row.itemId) ?? row.itemId,
    qty: row.qty.toFixed(3),
    unit: row.unit,
  };
}

function toReserveRef(item: { reserveItemType: InventoryItemType; reserveItemId: string }): {
  itemType: InventoryItemType;
  itemId: string;
} {
  return { itemType: item.reserveItemType, itemId: item.reserveItemId };
}
