import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  QuotationStatus,
  SalesOrderStatus,
  type BusinessLineCode,
  type InventoryItemType,
} from '@prisma/client';
import {
  businessToday,
  defaultValidUntil,
  Role,
  quotationCode,
  salesOrderCode,
  type CreateQuotationInput,
  type QuotationDto,
  type QuotationListItemDto,
  type QuotationQuery,
  type UpdateQuotationInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildQuotationPdf } from './quotation-pdf';
import { documentTotals, resolveSalesLines, toSalesItemDto } from './sales-lines';

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const quotationInclude = {
  customer: { select: { id: true, name: true, docNumber: true, address: true, docType: true } },
  businessLine: { select: { code: true } },
  items: {
    orderBy: { lineNumber: 'asc' },
    include: { product: { select: { sku: true, name: true } } },
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
 * Una cotización es una **simulación de precio**: no toca inventario ni reserva nada
 * (D-054). Lo único que hace con el stock es declarar, línea por línea, qué se reservaría
 * al confirmarla — y confirmar es acto aparte, en `SalesOrdersService`.
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
  ) {}

  /**
   * RF-66 dice "una cotización **propia**": un vendedor no toca las de otro.
   *
   * Sin esto, con solo el id (que `GET /sales/quotations` devuelve a cualquier vendedor) se
   * podía editar el borrador de un compañero, emitirlo, confirmarlo —creando un pedido y una
   * reserva a nombre de su cliente— o anulárselo. El `audit_log` dejaba el rastro, pero el
   * daño ya estaba hecho.
   *
   * La **lectura** sigue abierta a todo el equipo comercial: RF-69 pide una lista de
   * cotizaciones, no una lista por vendedor, y en una empresa de este tamaño ver lo que
   * cotizó el compañero es parte del trabajo. El ADMINISTRADOR opera cualquiera.
   */
  private assertOwnership(actor: RequestUser, createdById: string, action: string): void {
    if (actor.role === Role.ADMINISTRADOR) return;
    if (actor.id === createdById) return;
    throw new ForbiddenException(`La cotización es de otro vendedor: no puedes ${action}`);
  }

  // -------------------------------------------------------------------------
  // RF-61 — alta y edición
  // -------------------------------------------------------------------------

  async create(actor: RequestUser, input: CreateQuotationInput): Promise<QuotationDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      const { customer, line } = await this.requireHeaderRefs(
        tx,
        input.customerId,
        input.businessLine,
      );
      const lines = await resolveSalesLines(tx, line.id, line.quotationRequired, input.items);
      const totals = documentTotals(lines);
      const validUntil = defaultValidUntil(input.issueDate, input.validityDays);

      const quotation = await tx.quotation.create({
        data: {
          customerId: customer.id,
          businessLineId: line.id,
          status: QuotationStatus.DRAFT,
          issueDate: toDateOnly(input.issueDate),
          validUntil: toDateOnly(validUntil),
          subtotalPen: totals.subtotalPen,
          igvPen: totals.igvPen,
          totalPen: totals.totalPen,
          notes: input.notes ?? null,
          createdById: actor.id,
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
    });

    return this.findOne(id);
  }

  /** RF-66: editar una cotización propia mientras siga en borrador. Reemplaza las líneas. */
  async update(actor: RequestUser, id: string, input: UpdateQuotationInput): Promise<QuotationDto> {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockQuotation(tx, id);
      this.assertOwnership(actor, current.createdById, 'editarla');
      if (current.status !== QuotationStatus.DRAFT) {
        throw new BadRequestException(
          `Solo se edita una cotización en borrador; esta está ${current.status}. Anúlala y crea una nueva.`,
        );
      }
      const { customer, line } = await this.requireHeaderRefs(
        tx,
        input.customerId,
        toSharedLineCode(current.businessLineCode),
      );
      const lines = await resolveSalesLines(tx, line.id, line.quotationRequired, input.items);
      const totals = documentTotals(lines);
      const validUntil = defaultValidUntil(input.issueDate, input.validityDays);

      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      await tx.quotation.update({
        where: { id },
        data: {
          customerId: customer.id,
          issueDate: toDateOnly(input.issueDate),
          validUntil: toDateOnly(validUntil),
          subtotalPen: totals.subtotalPen,
          igvPen: totals.igvPen,
          totalPen: totals.totalPen,
          notes: input.notes ?? null,
          items: { create: lines.map(toItemCreate) },
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.update',
        entity: 'quotations',
        entityId: id,
        after: { totalPen: totals.totalPen, items: lines.length },
      });
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // Emitir (y con eso, generar el PDF)
  // -------------------------------------------------------------------------

  /**
   * Pasa la cotización a `EMITIDA` — el único estado desde el que se confirma — y genera
   * su PDF (D-068).
   *
   * El PDF se sube a R2 **fuera** de la transacción: es una llamada de red a un servicio
   * externo y sostenerla dentro del `$transaction` mantendría abierta una transacción de
   * Postgres a merced de la latencia de R2. Si la subida falla, la cotización queda emitida
   * igual y sin PDF: emitir es el hecho de negocio, el PDF es un adjunto que se puede
   * regenerar reemitiendo.
   */
  async emit(actor: RequestUser, id: string): Promise<QuotationDto> {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockQuotation(tx, id);
      this.assertOwnership(actor, current.createdById, 'emitirla');
      if (current.status === QuotationStatus.EMITTED) {
        throw new ConflictException('La cotización ya está emitida');
      }
      if (current.status !== QuotationStatus.DRAFT) {
        throw new BadRequestException(
          `Solo se emite una cotización en borrador; esta está ${current.status}`,
        );
      }
      const itemCount = await tx.quotationItem.count({ where: { quotationId: id } });
      if (itemCount === 0) {
        throw new BadRequestException('Una cotización sin líneas no se puede emitir');
      }
      await tx.quotation.update({
        where: { id },
        data: { status: QuotationStatus.EMITTED, emittedAt: new Date() },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.emit',
        entity: 'quotations',
        entityId: id,
        after: { status: QuotationStatus.EMITTED },
      });
    });

    await this.generatePdf(id);
    return this.findOne(id);
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
  private effectiveStatus(row: { status: QuotationStatus; validUntil: Date }): QuotationStatus {
    const validUntil = row.validUntil.toISOString().slice(0, 10);
    return row.status === QuotationStatus.EMITTED && validUntil < businessToday()
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
      validUntil: row.validUntil.toISOString().slice(0, 10),
      customerName: row.customer.name,
      customerDoc: `${row.customer.docType} ${row.customer.docNumber}`,
      customerAddress: row.customer.address,
      notes: row.notes,
      items: row.items.map((i) => ({
        description: i.description,
        qty: i.qty.toFixed(3),
        unit: i.unit,
        unitPricePen: i.unitPricePen.toFixed(4),
        totalPen: i.subtotalPen.toFixed(4),
      })),
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
    });
  }

  /**
   * Genera el PDF, lo sube a R2 y guarda su key. Solo lo llama `emit`: es el momento en que
   * el documento pasa a existir. Los fallos de R2 no tumban la emisión (D-068).
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
    }
  }

  /**
   * Descarga el PDF de la cotización.
   *
   * **Una cotización en borrador no tiene PDF**, y no es un detalle: sin ese corte, un
   * vendedor podía armar un borrador con el precio que quisiera, no emitirlo nunca —así no
   * queda emitido ni confirmable— y aun así mandarle al cliente un documento idéntico a uno
   * válido. El documento existe recién cuando se emite.
   *
   * Fuera de `EMITIDA`/`CONFIRMADA` el PDF **se arma al vuelo y no se guarda**: el archivo
   * de R2 se congeló al emitir y diría "Emitida" sobre una cotización que hoy está anulada
   * o vencida. Redibujarlo con el estado de hoy es lo que hace que el papel no mienta.
   *
   * Ese es también el motivo de que este `GET` no escriba nada: la única escritura del PDF
   * ocurre en `emit`, que es un `POST`.
   */
  async pdf(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.prisma.quotation.findUnique({
      where: { id },
      select: { id: true, seq: true, status: true, validUntil: true, pdfKey: true },
    });
    if (!row) throw new NotFoundException('Cotización no encontrada');
    if (row.status === QuotationStatus.DRAFT) {
      throw new BadRequestException(
        'Una cotización en borrador todavía no tiene documento: emítela primero',
      );
    }

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
      this.assertOwnership(actor, current.createdById, 'anularla');
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
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.quotation.cancel',
        entity: 'quotations',
        entityId: id,
        before: { status: current.status },
        after: { status: QuotationStatus.CANCELLED, reason },
      });
    });

    return this.findOne(id);
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

  async findAll(query: QuotationQuery): Promise<QuotationListItemDto[]> {
    const rows = await this.prisma.quotation.findMany({
      where: {
        status: query.status,
        customerId: query.customerId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        ...(query.search
          ? {
              OR: [
                { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { customer: { docNumber: { contains: query.search } } },
              ],
            }
          : {}),
      },
      // La lista muestra totales, no líneas: traer `items` con su producto para 500
      // cotizaciones era arrastrar miles de filas por pantallazo y descartarlas.
      include: { ...quotationInclude, items: false, _count: { select: { items: true } } },
      orderBy: { seq: 'desc' },
      take: 500,
    });
    const actors = await this.resolveActorNames(rows.map((r) => r.createdById));
    return rows.map((r) => {
      const { items: _items, ...rest } = this.toDto({ ...r, items: [] }, new Map(), actors);
      return { ...rest, itemCount: r._count.items };
    });
  }

  async findOne(id: string): Promise<QuotationDto> {
    const row = await this.prisma.quotation.findUnique({
      where: { id },
      include: quotationInclude,
    });
    if (!row) throw new NotFoundException('Cotización no encontrada');
    const labels = await this.reserveLabels(row.items);
    const actors = await this.resolveActorNames([row.createdById]);
    return this.toDto(row, labels, actors);
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
    businessLineId: string;
    businessLineCode: BusinessLineCode;
    validUntil: Date;
    createdById: string;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        seq: number;
        status: QuotationStatus;
        business_line_id: string;
        valid_until: Date;
        created_by_id: string;
      }[]
    >`
      SELECT "id", "seq", "status", "business_line_id", "valid_until", "created_by_id"
      FROM "quotations" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Cotización no encontrada');
    const line = await tx.businessLine.findUniqueOrThrow({
      where: { id: row.business_line_id },
      select: { code: true },
    });
    return {
      id: row.id,
      seq: row.seq,
      status: row.status,
      businessLineId: row.business_line_id,
      businessLineCode: line.code,
      validUntil: row.valid_until,
      createdById: row.created_by_id,
    };
  }

  private async requireHeaderRefs(
    tx: Prisma.TransactionClient,
    customerId: string,
    businessLine: ReturnType<typeof toSharedLineCode>,
  ): Promise<{
    customer: { id: string; name: string };
    line: { id: string; quotationRequired: boolean };
  }> {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, isActive: true },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');

    const line = await tx.businessLine.findUnique({
      where: { code: toPrismaLineCode(businessLine) },
      select: { id: true, quotationRequired: true, inventoryStrategy: true },
    });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    if (line.inventoryStrategy === 'NOOP') {
      throw new BadRequestException('La línea services no lleva stock: no se cotiza por acá');
    }
    return { customer, line };
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
  ): QuotationDto {
    const validUntil = row.validUntil.toISOString().slice(0, 10);
    const liveOrder = row.salesOrders[0];
    return {
      id: row.id,
      code: quotationCode(row.seq),
      customerId: row.customer.id,
      customerName: row.customer.name,
      customerDocNumber: row.customer.docNumber,
      businessLine: toSharedLineCode(row.businessLine.code),
      status: row.status,
      issueDate: row.issueDate.toISOString().slice(0, 10),
      validUntil,
      isExpired: validUntil < businessToday(),
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
      emittedAt: row.emittedAt?.toISOString() ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
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
    subtotalPen: line.subtotalPen,
    igvPen: line.igvPen,
    totalPen: line.totalPen,
    reserveItemType: line.reserveItemType,
    reserveItemId: line.reserveItemId,
    reserveQty: line.reserveQty,
    reserveUnit: line.reserveUnit,
  };
}
