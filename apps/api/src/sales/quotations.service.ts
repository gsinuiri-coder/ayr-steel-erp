import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  QuotationStatus,
  SalesOrderStatus,
  TemporaryReservationStatus,
  InventoryItemType,
} from '@prisma/client';
import {
  businessToday,
  defaultValidUntil,
  EXTERNAL_INVOICE_NOTES_PREFIX,
  externalInvoiceOf,
  IMPORT_ROUNDING_TOLERANCE_PEN,
  isImportedQuotation,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  keepImportMarker,
  stripImportMarker,
  lineAmounts,
  Role,
  isQuotationExpired,
  quotationValidUntil,
  paginate,
  quotationCode,
  salesOrderCode,
  toDecimal,
  toSkipTake,
  type CreateQuotationInput,
  type CreateQuotationInternalInput,
  type PaginatedResult,
  type QuotationDto,
  type QuotationListItemDto,
  type QuotationQuery,
  type SalesItemInput,
  type UpdateQuotationInput,
  NEGATIVE_TERMINAL_STATUSES,
  statusCondition,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { assertSellerAccess, quotationSellerWhere } from '../auth/seller-scope';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { ENV, type Env } from '../config/env';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { findPriceChanges, recordPriceChanges } from './price-changes';
import { buildQuotationPdf } from './quotation-pdf';
import { rawMaterialSpecLabels } from './raw-material';
import { SalesOrdersService } from './sales-orders.service';
import { lineCoilPool } from './coil-sale-product';
import { documentTotals, resolveSalesLines, toSalesItemDto } from './sales-lines';

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const quotationInclude = {
  customer: { select: { id: true, name: true, docNumber: true, address: true, docType: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: {
      // D-119: `businessLine` de cada producto es lo que arma `businessLines` del
      // documento (una cotización puede mezclar líneas).
      product: { select: { sku: true, name: true, businessLine: { select: { code: true } } } },
      // D-083: los largos de una línea compuesta. Vacío en el resto del catálogo.
      pieces: { orderBy: { lineNumber: 'asc' } },
    },
  },
  // Solo el pedido **vivo**: anular uno devuelve la cotización a EMITIDA y permite
  // confirmarla otra vez, así que una cotización puede acumular varios pedidos anulados y
  // como mucho uno vigente. Mostrar el anulado haría creer que sigue confirmada.
  salesOrders: {
    where: { status: { not: SalesOrderStatus.CANCELLED } },
    select: { id: true, seq: true },
    take: 1,
  },
} satisfies Prisma.QuotationInclude;

type QuotationRow = Prisma.QuotationGetPayload<{ include: typeof quotationInclude }>;

/**
 * Cotizaciones (RF-61, RF-65, RF-66, RF-69; D-064..D-069).
 *
 * Una cotización es una **simulación de precio**: no toca inventario (D-054). Nace emitida y
 * editable hasta confirmarse (D-184). Con el stock hace dos cosas, y las dos viven en
 * `SalesOrdersService`: apartar el material de forma temporal mientras el cliente deposita
 * (D-185) y confirmar, que crea el pedido con su reserva firme.
 *
 * Todo en soles (D-064): no hay moneda ni tipo de cambio en el ciclo comercial.
 */
@Injectable()
export class QuotationsService {
  private readonly logger = new Logger(QuotationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly orders: SalesOrdersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * D-163: el piso duro de precio, tal como lo recibe `resolveSalesLines`. La tolerancia es
   * la del agregado de materia prima (D-134), que es de donde sale el costo de una cobertura
   * a medida.
   */
  private priceFloor(): { toleranceMm: string } {
    return { toleranceMm: roofingToleranceMm(this.env) };
  }

  // -------------------------------------------------------------------------
  // RF-61 — alta y edición
  // -------------------------------------------------------------------------

  async create(actor: RequestUser, input: CreateQuotationInput): Promise<QuotationDto> {
    assertNoTypedImportMarker(null, input.notes);
    const id = await this.prisma.$transaction((tx) => this.createInTx(tx, actor, input));
    await this.generatePdf(id);
    return this.findOne(id, actor);
  }

  /**
   * El cuerpo de `create`, **dentro de la transacción del llamador** (patrón `*InTx`, D-099).
   *
   * Existe para que el importador de cotizaciones (D-152) escriba sus N cotizaciones en una
   * sola transacción todo o nada. Que reuse esto y no una copia es la mitad de lo que D-150
   * vino a arreglar: un importador que reimplementa el alta contra la tabla no hereda ninguna
   * de sus invariantes — las copia, y las copias envejecen.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    // D-157: el tipo interno, que **sí** admite `validityDays: null` (sin vencimiento). El
    // cuerpo HTTP no lo admite: el único que pasa `null` es el importador, por código.
    input: CreateQuotationInternalInput,
    // D-163: el piso duro se aplica **salvo** que el llamador diga que no, y el único que
    // dice que no es el importador de históricos (D-152). El defecto es enforcar a propósito:
    // un alta nueva que se olvide de pasar el flag queda protegida, no desprotegida.
    options: {
      enforcePriceFloor?: boolean;
      /**
       * D-169: el documento del que salen estas líneas trae sus **importes ya fijados** y hay
       * que copiarlos. Es la misma excepción que `enforcePriceFloor: false` y por el mismo
       * motivo —lo que entra por acá es un hecho consumado, no una oferta—, y el defecto
       * también es el mismo: sin la opción, el importe se recalcula.
       */
      exactAmounts?: { tolerancePen: string; documentLabel: string };
    } = {},
  ): Promise<string> {
    const customer = await this.requireActiveCustomer(tx, input.customerId);
    const lines = await resolveSalesLines(tx, input.items, {
      ...((options.enforcePriceFloor ?? true) ? { priceFloor: this.priceFloor() } : {}),
      ...(options.exactAmounts ? { exactAmounts: options.exactAmounts } : {}),
    });
    const totals = documentTotals(lines);
    // D-157: `null` es **sin vencimiento** y se guarda como `NULL`, no como una fecha lejana.
    const validUntil = quotationValidUntil(input.issueDate, input.validityDays);

    const quotation = await tx.quotation.create({
      data: {
        customerId: customer.id,
        // D-184: la cotización nace emitida. El borrador desapareció del flujo: lo que hacía
        // (editar antes de mandarla) ahora lo hace la edición de una emitida, que regenera
        // el PDF.
        status: QuotationStatus.EMITTED,
        emittedAt: new Date(),
        issueDate: toDateOnly(input.issueDate),
        validUntil: validUntil === null ? null : toDateOnly(validUntil),
        subtotalPen: totals.subtotalPen,
        igvPen: totals.igvPen,
        totalPen: totals.totalPen,
        notes: input.notes ?? null,
        createdById: actor.id,
        sellerId: actor.id,
        items: { create: lines.map(toItemCreate) },
      },
    });

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'sales.quotation.create',
      entity: 'quotations',
      entityId: quotation.id,
      after: {
        code: quotationCode(quotation.seq),
        customerId: customer.id,
        totalPen: totals.totalPen,
        items: lines.length,
      },
    });
    return quotation.id;
  }

  /**
   * RF-66 / D-184: editar una cotización propia mientras **no esté confirmada**. Reemplaza
   * las líneas y regenera el PDF: hay una sola versión y la última manda.
   *
   * Una vencida también se edita — es la forma de renovarla: si la vigencia nueva la vuelve
   * a dejar vigente, vuelve a `EMITIDA`. Una confirmada no, porque su precio ya es el del
   * pedido; una anulada tampoco, porque anular es terminal.
   */
  async update(
    actor: RequestUser,
    id: string,
    input: UpdateQuotationInput,
    /** El motivo que queda en la auditoría, cuando la edición la hace una herramienta (barrido). */
    options: {
      auditReason?: string;
      /**
       * D-264: `false` cuando la edición no es de una persona (el barrido): no se registra en
       * `sales_price_changes`, que es lo que el barrido lee como «editada a propósito».
       */
      recordPriceChanges?: boolean;
    } = {},
  ): Promise<QuotationDto> {
    await this.prisma.$transaction(
      async (tx) => {
        const current = await this.lockQuotation(tx, id);
        assertSellerAccess(actor, current.sellerId, 'Cotización');
        assertNoTypedImportMarker(current.notes, input.notes);
        if (current.status === QuotationStatus.CONFIRMED) {
          throw new BadRequestException(
            'La cotización ya está confirmada: lo que se edita desde ahora es el pedido.',
          );
        }
        if (current.status === QuotationStatus.CANCELLED) {
          throw new BadRequestException(
            'La cotización está anulada: duplícala para cotizar de nuevo.',
          );
        }
        const customer = await this.requireActiveCustomer(tx, input.customerId);
        // D-163: una cotización que trajo el importador (D-152) **nace exenta del piso**, y
        // editarla tiene que seguir estando exenta. Sin esto, corregir el producto de una línea
        // en una de las 71 de agosto rebotaba con "el precio mínimo es S/ X" sobre una línea que
        // nadie tocó y cuyo precio es un hecho consumado: la única salida habría sido falsear el
        // precio histórico o mover el margen mínimo de toda la línea de negocio.
        const imported = isImportedQuotation(current.notes);
        // D-169: y por el mismo motivo, sus **importes** también sobreviven a la edición. La
        // exención del piso ya estaba; a los importes les faltaba. Sin esto, corregir el
        // producto mal mapeado de una línea recalculaba las diez y el documento volvía a
        // separarse del comprobante — en silencio, y sin que nadie hubiera tocado los números.
        const { items, unchanged } = imported
          ? await this.withImportedAmounts(tx, id, input.items)
          : { items: input.items, unchanged: new Set<number>() };
        // D-256 (aclaración, revisión cruzada RF-S4b): la exención del piso y la venta parcial de
        // bobina son del **ADMINISTRADOR**. Para cualquier otro rol, solo la línea que sigue
        // representando al comprobante —mismo producto, cantidad y precio— conserva el papel;
        // la que cambió se recalcula y pasa por el piso y por las reglas normales de bobina. El
        // texto de las observaciones nunca otorga permisos.
        const admin = actor.role === Role.ADMINISTRADOR;
        const lines = await resolveSalesLines(tx, items, {
          ...(imported && admin ? {} : { priceFloor: this.priceFloor() }),
          ...(imported
            ? {
                exactAmounts: {
                  tolerancePen: IMPORT_ROUNDING_TOLERANCE_PEN,
                  documentLabel: externalInvoiceOf(current.notes) ?? 'El comprobante importado',
                },
                ...(admin ? {} : { paperLines: unchanged }),
                coilPool: {
                  scope: { exceptQuotationIds: [id] },
                  allowedPools: await this.storedCoilPools(tx, id),
                  preexistingCoilIds: await this.storedCoilIds(tx, id),
                },
              }
            : {}),
        });
        const totals = documentTotals(lines);
        // D-157: una cotización **sin vencimiento** (la trajo el importador) lo sigue siendo al
        // editarla. El cuerpo HTTP no puede expresar `null`, y sin este corte la primera edición
        // le inventaba una fecha a un comprobante ya vendido.
        const validUntil =
          current.validUntil === null
            ? null
            : quotationValidUntil(input.issueDate, input.validityDays);

        const status =
          validUntil !== null && isQuotationExpired(validUntil, businessToday())
            ? QuotationStatus.EXPIRED
            : QuotationStatus.EMITTED;

        // D-187: lo cotizado antes de reescribir las líneas, para registrar qué precio se movió.
        const previousLines = await tx.quotationItem.findMany({
          where: { quotationId: id },
          select: {
            lineNumber: true,
            productId: true,
            unitPricePen: true,
            valuePerMeterPen: true,
          },
        });
        await tx.quotationItem.deleteMany({ where: { quotationId: id } });
        await tx.quotation.update({
          where: { id },
          data: {
            customerId: customer.id,
            status,
            ...(status === QuotationStatus.EMITTED ? { expiredAt: null } : {}),
            issueDate: toDateOnly(input.issueDate),
            validUntil: validUntil === null ? null : toDateOnly(validUntil),
            subtotalPen: totals.subtotalPen,
            igvPen: totals.igvPen,
            totalPen: totals.totalPen,
            // D-152/D-163: la marca del comprobante externo sobrevive a la edición. Es
            // procedencia, no una observación que alguien escribió, y de ella dependen el aviso
            // de reimportación y la exención del piso de precio: borrarla dejaba el documento
            // inválido a partir del **segundo** guardado, con el mismo precio histórico.
            notes: keepImportMarker(current.notes, input.notes ?? null),
            items: { create: lines.map(toItemCreate) },
          },
        });

        const priceChanges =
          options.recordPriceChanges === false
            ? 0
            : await recordPriceChanges(tx, { quotationId: id }, previousLines, lines, actor.id);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'sales.quotation.update',
          entity: 'quotations',
          entityId: id,
          after: {
            customerId: customer.id,
            totalPen: totals.totalPen,
            items: lines.length,
            status,
            priceChanges,
          },
          ...(options.auditReason ? { reason: options.auditReason } : {}),
        });

        // D-185: con reserva temporal vigente, lo reservado sigue a las líneas nuevas — o la
        // edición entera se deshace si ya no alcanza.
        await this.orders.recalculateTemporaryInTx(tx, actor, id);
      },
      // La validación del pool en el servidor (D-254) suma consultas por línea de bobina. Con
      // los 5 s por defecto de Prisma, el barrido contra Neon vencía la transacción a mitad
      // (lo mostró el ensayo en demo); mismo margen que `updateItemCoil`.
      { timeout: 30_000, maxWait: 10_000 },
    );

    await this.generatePdf(id);
    return this.findOne(id);
  }

  /**
   * D-169: le devuelve a cada línea editada el **importe del papel**, si sigue siendo suyo.
   *
   * La edición de una cotización importada llega sin importes: el formulario manda producto,
   * cantidad y precio, que es todo lo que una persona puede tocar. Sin este paso, guardar
   * recalculaba las diez líneas y el documento volvía a separarse del comprobante — sin que
   * nadie hubiera tocado los números, y en silencio.
   *
   * **El criterio de "sigue siendo suyo" es el trío completo** (producto, cantidad, valor
   * unitario). Si alguno cambió, el importe guardado describe otra línea y se deja recalcular:
   * copiar el importe viejo sobre una cantidad nueva sería fijar un total que ya no
   * corresponde a nada, y el rechazo por tolerancia terminaría culpando al archivo de una
   * diferencia que introdujo la corrección.
   *
   * El emparejamiento **consume** cada línea guardada, así que dos líneas idénticas del mismo
   * documento —que existen: el mismo SKU facturado dos veces en la misma factura— reciben cada
   * una su propio importe y no dos veces el primero.
   */
  private async withImportedAmounts(
    tx: Prisma.TransactionClient,
    quotationId: string,
    items: SalesItemInput[],
  ): Promise<{ items: SalesItemInput[]; unchanged: Set<number> }> {
    const stored = await tx.quotationItem.findMany({
      where: { quotationId },
      select: {
        productId: true,
        qty: true,
        unitPricePen: true,
        valuePerMeterPen: true,
        subtotalPen: true,
        igvPen: true,
        totalPen: true,
        reserveItemType: true,
        reserveItemId: true,
      },
      orderBy: { lineNumber: 'asc' },
    });
    type Row = (typeof stored)[number];
    const available = stored.map((row) => ({ row, taken: false }));
    // D-255: con el importe de la línea sigue viajando el IGV y el total **del papel** que la
    // línea tenía guardados, para que editar un documento importado no le recalcule el IGV al
    // 18 % y lo separe del comprobante en diezmilésimas.
    const withPaper = (item: SalesItemInput, row: Row): SalesItemInput => {
      const { unitPricePen: _u, valuePerMeterPen: _v, unitPriceWithIgvPen: _w, ...rest } = item;
      return {
        ...rest,
        netAmountPen: row.subtotalPen.toFixed(4),
        igvAmountPen: row.igvPen.toFixed(4),
        totalAmountPen: row.totalPen.toFixed(4),
      };
    };
    const eq = (a: { toString(): string }, b: string): boolean =>
      toDecimal(a.toString()).equals(toDecimal(b));
    // D-256 (aclaración): el **mismo producto** —o la misma bobina, en una venta de bobina—.
    const sameProduct = (item: SalesItemInput, row: Row): boolean =>
      item.saleCoilId !== undefined
        ? row.reserveItemType === InventoryItemType.COIL && row.reserveItemId === item.saleCoilId
        : item.productId !== undefined && row.productId === item.productId;
    // Y el **mismo precio**, en la forma en que haya llegado.
    const samePrice = (item: SalesItemInput, row: Row): boolean => {
      if (item.netAmountPen !== undefined) {
        if (!eq(row.subtotalPen, item.netAmountPen)) return false;
        if (item.igvAmountPen !== undefined && !eq(row.igvPen, item.igvAmountPen)) return false;
        if (item.totalAmountPen !== undefined && !eq(row.totalPen, item.totalAmountPen)) {
          return false;
        }
        return true;
      }
      if (item.unitPricePen !== undefined) return eq(row.unitPricePen, item.unitPricePen);
      if (item.valuePerMeterPen !== undefined) {
        return row.valuePerMeterPen !== null && eq(row.valuePerMeterPen, item.valuePerMeterPen);
      }
      if (item.unitPriceWithIgvPen !== undefined) {
        const { subtotal } = lineAmounts(item.qty, {
          unitPriceWithIgvPen: item.unitPriceWithIgvPen,
        });
        return subtotal.equals(toDecimal(row.subtotalPen.toString()));
      }
      return false;
    };

    const unchanged = new Set<number>();
    const out = items.map((item, index) => {
      const match = available.find(
        (c) =>
          !c.taken && sameProduct(item, c.row) && eq(c.row.qty, item.qty) && samePrice(item, c.row),
      );
      if (!match) return item;
      match.taken = true;
      unchanged.add(index);
      return withPaper(item, match.row);
    });
    return { items: out, unchanged };
  }

  /**
   * D-254 (revisión cruzada RF-S4b, P2-1): los pools de bobina que la cotización ya tiene —el
   * de cada línea que vende una bobina o que está enganchada a un producto de venta de
   * bobina—. Una línea del papel de esta cotización solo puede atarse a una bobina de uno de
   * ellos: nunca a una de otro espesor o color.
   */
  private async storedCoilPools(
    tx: Prisma.TransactionClient,
    quotationId: string,
  ): Promise<Set<string>> {
    const rows = await tx.quotationItem.findMany({
      where: { quotationId },
      select: {
        description: true,
        reserveItemType: true,
        reserveItemId: true,
        product: { select: { sku: true, name: true, businessLine: { select: { code: true } } } },
      },
    });
    const pools = new Set<string>();
    for (const row of rows) {
      const key = await lineCoilPool(tx, row);
      if (key !== null) pools.add(key.sku);
    }
    return pools;
  }

  /** Las bobinas que la cotización ya vende: su propia línea no compite consigo misma. */
  private async storedCoilIds(
    tx: Prisma.TransactionClient,
    quotationId: string,
  ): Promise<Set<string>> {
    const rows = await tx.quotationItem.findMany({
      where: { quotationId, reserveItemType: InventoryItemType.COIL },
      select: { reserveItemId: true },
    });
    return new Set(rows.map((r) => r.reserveItemId));
  }

  /**
   * D-119: duplica una cotización **en cualquier estado** —incluida una confirmada o
   * anulada— a un `BORRADOR` nuevo, con número propio, mismo cliente y las mismas líneas.
   * No copia las filas tal cual: las vuelve a pasar por `resolveSalesLines`, la misma
   * puerta que usan `create`/`update`, porque entre la original y hoy puede haber pasado
   * cualquier cosa (un producto se desactivó, una bobina que vendía entera ya se despachó).
   * Los precios negociados de la original se copian y quedan editables — es un borrador
   * nuevo — y el precio de lista se refresca contra el catálogo de hoy.
   *
   * Sin chequeo de dueño (RF-66 es sobre **editar/confirmar/anular** la propia; duplicar es
   * "usa esto de plantilla", abierto al mismo equipo que ya lee cualquier cotización).
   */
  async duplicate(actor: RequestUser, id: string): Promise<QuotationDto> {
    const source = await this.prisma.quotation.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { lineNumber: 'asc' },
          include: { pieces: { orderBy: { lineNumber: 'asc' } } },
        },
      },
    });
    if (!source) throw new NotFoundException('Cotización no encontrada');
    if (actor) assertSellerAccess(actor, source.sellerId, 'Cotización');
    if (source.items.length === 0) {
      throw new BadRequestException('La cotización no tiene líneas que duplicar');
    }

    // D-116: una línea de bobina completa no tiene receta (RF-73, producto `trading`); una
    // que reserva materia prima para fabricar sí la tiene (D-088). Es la misma distinción
    // que usa `resolveDispatchTarget`, y la única forma de reconstruir cuál de las dos era
    // cada línea `reserveItemType = COIL` ya persistida.
    const productIds = [...new Set(source.items.map((i) => i.productId))];
    const boms = await this.prisma.productBom.findMany({
      where: { productId: { in: productIds }, isActive: true },
      select: { productId: true },
    });
    const madeToOrderProductIds = new Set(boms.map((b) => b.productId));

    const items: SalesItemInput[] = source.items.map((i) => {
      // D-161: si la línea se cotizó por metro (una plancha de catálogo), el duplicado se
      // vuelve a cotizar por metro y el unitario se recalcula. Mandar los dos es un 400 del
      // schema, y mandar solo el unitario perdería el número que el vendedor negoció.
      const valuePerMeterPen =
        i.valuePerMeterPen === null ? undefined : i.valuePerMeterPen.toFixed(4);
      // D-255: el unitario del duplicado es el **derivado del importe** (diez decimales), no el
      // guardado para mostrar: así la misma cantidad reproduce el mismo importe al céntimo.
      const unitPricePen =
        valuePerMeterPen === undefined
          ? derivedUnitValue(i.qty.toString(), i.subtotalPen.toString()).toFixed(
              DERIVED_UNIT_VALUE_DECIMALS,
            )
          : undefined;
      const price = valuePerMeterPen === undefined ? { unitPricePen } : { valuePerMeterPen };
      const pieces =
        i.pieces.length > 0
          ? i.pieces.map((p) => ({ lengthMm: p.lengthMm.toFixed(2), qty: p.qty }))
          : undefined;
      if (i.reserveItemType === 'COIL' && !madeToOrderProductIds.has(i.productId)) {
        // D-116: venta de bobina completa. El API resuelve producto y cantidad solos a
        // partir del saldo vivo de la bobina; `qty` es obligatoria en el schema pero se
        // ignora para esta línea, así que basta con un valor no vacío.
        return {
          saleCoilId: i.reserveItemId,
          qty: i.qty.toFixed(3),
          unitPricePen: derivedUnitValue(i.qty.toString(), i.subtotalPen.toString()).toFixed(
            DERIVED_UNIT_VALUE_DECIMALS,
          ),
        };
      }
      return {
        productId: i.productId,
        qty: i.qty.toFixed(3),
        ...price,
        ...(pieces ? { pieces } : {}),
        ...(i.reserveItemType === 'COIL'
          ? { reserveFromCoilId: i.reserveItemId, reserveKg: i.reserveQty.toFixed(3) }
          : {}),
      };
    });

    const newId = await this.prisma.$transaction(async (tx) => {
      const customer = await this.requireActiveCustomer(tx, source.customerId);
      // D-163: el duplicado **sí** pasa por el piso, por el mismo motivo por el que vence
      // (D-157): lo que sale es una cotización viva de hoy. Duplicar una importada cuyo
      // precio quedó por debajo del mínimo de hoy rebota, y así tiene que ser.
      const lines = await resolveSalesLines(tx, items, { priceFloor: this.priceFloor() });
      const totals = documentTotals(lines);
      const issueDate = businessToday();
      // D-157: **el duplicado sí vence**, aunque la original no venciera. Duplicar es "usá
      // esto de plantilla": lo que sale es una cotización viva de hoy, y la ausencia de
      // vencimiento de la original era un hecho de su origen —un comprobante ya vendido que
      // el importador cargó (D-152)—, no una condición comercial que se herede.
      const validUntil = defaultValidUntil(issueDate);

      const quotation = await tx.quotation.create({
        data: {
          customerId: customer.id,
          // D-184: el duplicado también nace emitido, igual que cualquier cotización nueva.
          status: QuotationStatus.EMITTED,
          emittedAt: new Date(),
          issueDate: toDateOnly(issueDate),
          validUntil: toDateOnly(validUntil),
          subtotalPen: totals.subtotalPen,
          igvPen: totals.igvPen,
          totalPen: totals.totalPen,
          notes: stripImportMarker(source.notes),
          createdById: actor.id,
          sellerId: actor.id,
          items: { create: lines.map(toItemCreate) },
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.duplicate',
        entity: 'quotations',
        entityId: quotation.id,
        after: {
          code: quotationCode(quotation.seq),
          sourceId: id,
          sourceCode: quotationCode(source.seq),
          totalPen: totals.totalPen,
        },
      });
      return quotation.id;
    });

    await this.generatePdf(newId);
    return this.findOne(newId);
  }

  /**
   * Estado **efectivo** de una cotización: el guardado, salvo que sea una `EMITIDA` cuya
   * vigencia ya pasó y que el job diario (D-069) todavía no marcó.
   *
   * Es exactamente el mismo razonamiento por el que `confirm()` revalida la fecha en vez de
   * confiar en el estado: el API escala a cero y el cron puede no haber corrido. Acá importa
   * igual o más, porque esta es la puerta por la que el documento sale hacia el cliente —
   * durante esa ventana se reenviaba un papel indistinguible de uno vigente sobre una
   * cotización que el propio API ya no dejaba confirmar.
   */
  private effectiveStatus(row: {
    status: QuotationStatus;
    validUntil: Date | null;
  }): QuotationStatus {
    // D-157: sin vencimiento no hay estado efectivo que corregir. `isQuotationExpired` es la
    // única función que responde la pregunta, para que la ausencia de fecha no termine
    // comparándose como cadena vacía en algún lugar suelto.
    const validUntil = row.validUntil?.toISOString().slice(0, 10) ?? null;
    return row.status === QuotationStatus.EMITTED && isQuotationExpired(validUntil, businessToday())
      ? QuotationStatus.EXPIRED
      : row.status;
  }

  /** Arma el PDF de una cotización con su estado actual. No persiste nada. */
  private async renderPdf(id: string): Promise<Buffer> {
    const row = await this.prisma.quotation.findUniqueOrThrow({
      where: { id },
      include: quotationInclude,
    });
    return buildQuotationPdf({
      code: quotationCode(row.seq),
      // El estado va impreso: sin él, el PDF de una cotización anulada o vencida es
      // indistinguible de uno vigente y se le puede reenviar al cliente como si valiera.
      status: this.effectiveStatus(row),
      issueDate: row.issueDate.toISOString().slice(0, 10),
      validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
      customerName: row.customer.name,
      customerDoc: `${row.customer.docType} ${row.customer.docNumber}`,
      customerAddress: row.customer.address,
      notes: row.notes,
      items: row.items.map((i) => ({
        description: i.description,
        qty: i.qty.toFixed(3),
        unit: i.unit,
        unitPricePen: i.unitPricePen.toFixed(4),
        valuePerMeterPen: i.valuePerMeterPen === null ? null : i.valuePerMeterPen.toFixed(4),
        totalPen: i.subtotalPen.toFixed(4),
      })),
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
    });
  }

  /**
   * Genera el PDF, lo sube a R2 y guarda su key (D-068). Lo llaman el alta, la edición y el
   * duplicado (D-184): la key es estable, así que cada edición **pisa** el archivo anterior
   * y la última versión manda, sin rastro de las previas.
   *
   * Se sube **fuera** de la transacción: es una llamada de red y sostenerla dentro del
   * `$transaction` dejaría a Postgres a merced de la latencia de R2. Si falla, la cotización
   * queda guardada igual y `pdf()` la redibuja al vuelo.
   */
  private async generatePdf(id: string): Promise<void> {
    try {
      const row = await this.prisma.quotation.findUniqueOrThrow({
        where: { id },
        select: { seq: true },
      });
      const pdf = await this.renderPdf(id);
      const key = `quotations/${id}/${quotationCode(row.seq)}.pdf`;
      await this.storage.putObject(key, pdf, 'application/pdf');
      await this.prisma.quotation.update({ where: { id }, data: { pdfKey: key } });
    } catch (err) {
      this.logger.warn(`No se pudo generar el PDF de la cotización ${id}: ${String(err)}`);
      // Revisión cruzada RF-S4b (decisión 1 del dueño): el archivo guardado describe la
      // cotización **de antes** de este cambio. Se suelta la clave —el objeto viejo queda en R2,
      // no se borra— y la descarga lo arma al vuelo con los datos vigentes: nunca sirve los
      // importes viejos. Pasa, por ejemplo, con el barrido, que corre sin R2.
      await this.prisma.quotation
        .update({ where: { id }, data: { pdfKey: null } })
        .catch((clearErr: unknown) => {
          this.logger.warn(`No se pudo soltar el PDF viejo de ${id}: ${String(clearErr)}`);
        });
    }
  }

  /**
   * Descarga el PDF de la cotización.
   *
   * Fuera de `EMITIDA`/`CONFIRMADA` el PDF **se arma al vuelo y no se guarda**: el archivo
   * de R2 diría "Emitida" sobre una cotización que hoy está anulada o vencida. Redibujarlo
   * con el estado de hoy es lo que hace que el papel no mienta.
   *
   * Ese es también el motivo de que este `GET` no escriba nada: el PDF se escribe en el
   * alta, la edición y el duplicado, que son `POST`/`PUT`.
   */
  async pdf(id: string, actor?: RequestUser): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.prisma.quotation.findUnique({
      where: { id },
      select: { id: true, seq: true, status: true, validUntil: true, pdfKey: true, sellerId: true },
    });
    if (!row) throw new NotFoundException('Cotización no encontrada');
    if (actor) assertSellerAccess(actor, row.sellerId, 'Cotización');

    const filename = `${quotationCode(row.seq)}.pdf`;
    // Con el estado **efectivo**, no el guardado: una emitida cuya fecha ya pasó no puede
    // servir el archivo congelado en R2, que se dibujó cuando todavía era vigente.
    const status = this.effectiveStatus(row);
    const isCurrent = status === QuotationStatus.EMITTED || status === QuotationStatus.CONFIRMED;
    if (isCurrent && row.pdfKey) {
      try {
        return { buffer: await this.storage.getObject(row.pdfKey), filename };
      } catch (err) {
        // La key existe pero el objeto no (subida a medias, bucket purgado): se rearma en
        // vez de devolver un 500 sobre un documento que sí se puede reconstruir.
        this.logger.warn(`El PDF ${row.pdfKey} no se pudo leer de R2: ${String(err)}`);
      }
    }
    return { buffer: await this.renderPdf(id), filename };
  }

  // -------------------------------------------------------------------------
  // RF-65 — anular
  // -------------------------------------------------------------------------

  /**
   * Anula una cotización en cualquier estado **no confirmado**. Una confirmada no se anula
   * por acá: primero hay que anular el pedido, que es lo que libera la reserva (D-066); esa
   * anulación devuelve la cotización a `EMITIDA` si sigue vigente, y recién ahí se anula.
   */
  async cancel(actor: RequestUser, id: string, reason: string): Promise<QuotationDto> {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockQuotation(tx, id);
      assertSellerAccess(actor, current.sellerId, 'Cotización');
      if (current.status === QuotationStatus.CANCELLED) {
        throw new ConflictException('La cotización ya está anulada');
      }
      if (current.status === QuotationStatus.CONFIRMED) {
        throw new BadRequestException(
          'La cotización está confirmada: anula primero el pedido, que es lo que libera la reserva',
        );
      }
      await tx.quotation.update({
        where: { id },
        data: {
          status: QuotationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: actor.id,
        },
      });
      // D-185: anular suelta lo que la cotización tenía apartado.
      await this.orders.endTemporaryInTx(tx, id, {
        status: TemporaryReservationStatus.RELEASED,
        actorId: actor.id,
        reason: `Cotización anulada: ${reason}`,
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.cancel',
        entity: 'quotations',
        entityId: id,
        before: { status: current.status },
        after: { status: QuotationStatus.CANCELLED, reason },
      });
    });

    return this.findOne(id, actor);
  }

  /**
   * M4: reasignar cotización y pedidos derivados a otro vendedor (solo ADMINISTRADOR).
   */
  async reassign(
    actor: RequestUser,
    id: string,
    newSellerId: string,
    reason: string,
  ): Promise<QuotationDto> {
    const newSeller = await this.prisma.user.findUnique({
      where: { id: newSellerId, active: true, role: 'VENDEDOR' },
    });
    if (!newSeller) {
      throw new BadRequestException(
        'El vendedor destino no existe, no está activo o no tiene rol VENDEDOR',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockQuotation(tx, id);
      if (current.sellerId === newSellerId) {
        throw new BadRequestException('El vendedor de destino es el mismo que el actual');
      }

      await tx.quotation.update({
        where: { id },
        data: { sellerId: newSellerId },
      });

      await tx.salesOrder.updateMany({
        where: { quotationId: id },
        data: { sellerId: newSellerId },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.reassign',
        entity: 'quotations',
        entityId: id,
        before: { sellerId: current.sellerId },
        after: { sellerId: newSellerId, reason },
      });
    });
    return this.findOne(id, actor);
  }

  // -------------------------------------------------------------------------
  // D-069 — vencimiento
  // -------------------------------------------------------------------------

  /**
   * Marca `VENCIDA` toda cotización `EMITIDA` cuya vigencia ya pasó. La corre el job diario
   * de pg-boss y también un endpoint de administrador, porque el API vive en Cloud Run con
   * escalado a cero: si nadie lo despierta, el cron no corre, y el estado tiene que poder
   * ponerse al día bajo demanda.
   *
   * Que el estado quede al día es una comodidad de la lista, no la regla: `confirm()`
   * revalida la vigencia por su cuenta (D-069), así que una cotización vencida no se puede
   * confirmar ni aunque el job no haya corrido nunca.
   */
  async expireDue(actorId: string | null = null): Promise<number> {
    const cutoff = toDateOnly(businessToday());
    const due = await this.prisma.quotation.findMany({
      // D-157: `valid_until < cutoff` es `NULL` para una cotización sin vencimiento, y en SQL
      // eso no es verdadero: las sin vencimiento quedan fuera del barrido sin filtro extra.
      where: { status: QuotationStatus.EMITTED, validUntil: { lt: cutoff } },
      select: { id: true, seq: true },
      // De la más vencida a la más reciente: con más de 500 pendientes, un tope sin orden
      // podía devolver siempre el mismo tramo y dejar las más viejas sin marcar corrida tras
      // corrida. Así cada pasada avanza sobre la cola.
      orderBy: { validUntil: 'asc' },
      take: 500,
    });
    if (due.length === 0) return 0;

    const expired = await this.prisma.$transaction(async (tx) => {
      const result = await tx.quotation.updateMany({
        where: { id: { in: due.map((q) => q.id) }, status: QuotationStatus.EMITTED },
        data: { status: QuotationStatus.EXPIRED, expiredAt: new Date() },
      });
      await this.audit.write(tx, {
        actorId,
        action: 'sales.quotation.expire',
        entity: 'quotations',
        entityId: null,
        // El conteo real del `updateMany`, no el de la lectura previa: entre una y otra,
        // alguna pudo confirmarse o anularse y el filtro de estado la deja fuera.
        after: { count: result.count, codes: due.map((q) => quotationCode(q.seq)) },
      });
      return result.count;
    });
    this.logger.log(`Cotizaciones vencidas: ${expired}`);
    return expired;
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async findAll(
    actor: RequestUser,
    query: QuotationQuery,
  ): Promise<PaginatedResult<QuotationListItemDto>> {
    // El código de la cotización (`COT-000123`) es `quotationCode(seq)`, no una columna:
    // buscar "COT-000123" o solo "123" tiene que extraer el número y filtrar por `seq`, o
    // quien pega el código de una cotización para encontrarla (el uso más común del
    // buscador) se quedaba sin resultados (Fase 7d, hallazgo de revisión).
    const searchSeq = query.search ? query.search.replace(/\D/g, '') : '';
    const where: Prisma.QuotationWhereInput = {
      ...quotationSellerWhere(actor),
      // D-289: sin estado, la bandeja omite las anuladas (no si se busca o se acota a un cliente).
      status: statusCondition(
        query.status,
        NEGATIVE_TERMINAL_STATUSES.quotation,
        Boolean(query.search) || Boolean(query.customerId),
      ),
      customerId: query.customerId,
      // D-119: sin `businessLineId` propio, "de esta línea" es "tiene algún ítem de esta
      // línea" — una cotización mixta aparece en el filtro de cualquiera de sus líneas.
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
      this.prisma.quotation.count({ where }),
      this.prisma.quotation.findMany({
        where,
        // La lista muestra totales, no líneas: traer `items` con su producto para 500
        // cotizaciones era arrastrar miles de filas por pantallazo y descartarlas.
        include: { ...quotationInclude, items: false, _count: { select: { items: true } } },
        orderBy: { seq: 'desc' },
        skip,
        take,
      }),
    ]);
    const actors = await this.resolveActorNames(
      rows.flatMap((r) => [r.createdById, r.sellerId].filter(Boolean) as string[]),
    );
    const items = rows.map((r) => {
      const {
        items: _items,
        temporaryReservation: _temporary,
        priceChanges: _priceChanges,
        ...rest
      } = this.toDto({ ...r, items: [] }, new Map(), actors);
      return { ...rest, itemCount: r._count.items };
    });
    return paginate(items, total, query);
  }

  async findOne(id: string, actor?: RequestUser): Promise<QuotationDto> {
    const row = await this.prisma.quotation.findUnique({
      where: { id },
      include: quotationInclude,
    });
    if (!row) throw new NotFoundException('Cotización no encontrada');
    if (actor) assertSellerAccess(actor, row.sellerId, 'Cotización');
    const labels = await this.reserveLabels(row.items);
    const actors = await this.resolveActorNames(
      [row.createdById, row.sellerId].filter(Boolean) as string[],
    );
    const [temporary, priceChanges] = await Promise.all([
      this.orders.findQuotationTemporaryReservation(id),
      findPriceChanges(this.prisma, { quotationId: id }),
    ]);
    return { ...this.toDto(row, labels, actors, temporary), priceChanges };
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Bloquea la fila de la cotización hasta el fin de la transacción. Todas las
   * transiciones de estado (emitir, confirmar, anular) pasan por acá antes de mirar el
   * estado, para que dos pestañas no confirmen la misma cotización a la vez.
   */
  private async lockQuotation(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{
    id: string;
    seq: number;
    status: QuotationStatus;
    validUntil: Date | null;
    createdById: string;
    sellerId: string;
    notes: string | null;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        seq: number;
        status: QuotationStatus;
        valid_until: Date | null;
        created_by_id: string;
        seller_id: string;
        notes: string | null;
      }[]
    >`
      SELECT id, seq, status, valid_until, created_by_id, seller_id, notes
      FROM "quotations"
      WHERE "id" = ${id}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Cotización no encontrada');
    return {
      id: row.id,
      seq: row.seq,
      status: row.status,
      validUntil: row.valid_until,
      createdById: row.created_by_id,
      sellerId: row.seller_id,
      notes: row.notes,
    };
  }

  /**
   * D-119: ya no valida una línea de negocio del documento (no existe); la línea de cada
   * ítem se valida dentro de `resolveSalesLines`, una por una.
   */
  private async requireActiveCustomer(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<{ id: string; name: string }> {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, isActive: true },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');
    return customer;
  }

  /** Etiqueta legible del ítem reservado: SKU del producto o código de la bobina. */
  private async reserveLabels(
    items: { reserveItemType: InventoryItemType; reserveItemId: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const coilIds = items.filter((i) => i.reserveItemType === 'COIL').map((i) => i.reserveItemId);
    const productIds = items
      .filter((i) => i.reserveItemType === 'PRODUCT')
      .map((i) => i.reserveItemId);
    if (coilIds.length > 0) {
      const coils = await this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: { id: true, code: true },
      });
      for (const c of coils) map.set(c.id, c.code);
    }
    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true },
      });
      for (const p of products) map.set(p.id, p.sku);
    }
    // D-134: desde la reserva genérica, **toda** línea a medida de una cotización apunta a
    // un agregado. Sin esta rama la línea llegaba al DTO y al PDF con la etiqueta vacía.
    const specIds = items
      .filter((i) => i.reserveItemType === 'RAW_MATERIAL')
      .map((i) => i.reserveItemId);
    if (specIds.length > 0) {
      for (const [id, label] of await rawMaterialSpecLabels(this.prisma, specIds)) {
        map.set(id, label);
      }
    }
    return map;
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
    row: QuotationRow,
    labels: Map<string, string>,
    actors: Map<string, string>,
    temporaryReservation: QuotationDto['temporaryReservation'] = null,
  ): QuotationDto {
    const validUntil = row.validUntil?.toISOString().slice(0, 10) ?? null;
    const liveOrder = row.salesOrders[0];
    return {
      id: row.id,
      code: quotationCode(row.seq),
      customerId: row.customer.id,
      customerName: row.customer.name,
      customerDocNumber: row.customer.docNumber,
      // D-119: distintas, en el orden en que aparecen los ítems — no hay una línea "del
      // documento" que ordene de otra forma.
      businessLines: [
        ...new Set(row.items.map((i) => toSharedLineCode(i.product.businessLine.code))),
      ],
      status: row.status,
      issueDate: row.issueDate.toISOString().slice(0, 10),
      validUntil,
      isExpired: isQuotationExpired(validUntil, businessToday()),
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
      notes: row.notes,
      salesOrderId: liveOrder?.id ?? null,
      salesOrderCode: liveOrder ? salesOrderCode(liveOrder.seq) : null,
      pdfKey: row.pdfKey,
      items: row.items.map((i) => toSalesItemDto(i, labels.get(i.reserveItemId) ?? '')),
      createdAt: row.createdAt.toISOString(),
      createdByName: actors.get(row.createdById) ?? null,
      sellerId: row.sellerId ?? row.createdById,
      sellerName: actors.get(row.sellerId ?? row.createdById) ?? null,
      emittedAt: row.emittedAt?.toISOString() ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      temporaryReservation,
      priceChanges: [],
    };
  }
}

function toItemCreate(
  line: Awaited<ReturnType<typeof resolveSalesLines>>[number],
): Prisma.QuotationItemCreateWithoutQuotationInput {
  return {
    lineNumber: line.lineNumber,
    product: { connect: { id: line.productId } },
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    listPricePen: line.listPricePen,
    unitPricePen: line.unitPricePen,
    // D-161: el valor por metro con el que se cotizó una plancha se guarda **junto** al valor
    // unitario que sale de él, no en su lugar: lo que se factura es el unitario.
    valuePerMeterPen: line.valuePerMeterPen,
    subtotalPen: line.subtotalPen,
    igvPen: line.igvPen,
    totalPen: line.totalPen,
    reserveItemType: line.reserveItemType,
    reserveItemId: line.reserveItemId,
    reserveQty: line.reserveQty,
    reserveUnit: line.reserveUnit,
    ...(line.pieces.length > 0
      ? {
          pieces: {
            create: line.pieces.map((p) => ({
              lineNumber: p.lineNumber,
              lengthMm: p.lengthMm,
              qty: p.qty,
            })),
          },
        }
      : {}),
  };
}

/**
 * D-256 (aclaración, revisión cruzada RF-S4b): la marca del comprobante externo (D-152) la
 * escribe **solo** el importador. Tipearla en las observaciones de una cotización que no la
 * tiene se rechaza: el texto de las observaciones nunca otorga permisos.
 */
function assertNoTypedImportMarker(currentNotes: string | null, newNotes?: string | null): void {
  if (isImportedQuotation(currentNotes)) return;
  if (isImportedQuotation(newNotes?.trimStart() ?? null)) {
    throw new BadRequestException(
      `Las observaciones no pueden empezar con «${EXTERNAL_INVOICE_NOTES_PREFIX.trim()}»: esa marca la pone el importador de comprobantes`,
    );
  }
}
