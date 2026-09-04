import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DispatchStatus,
  DocType,
  FiscalDocType,
  FiscalDocumentStatus,
  Prisma,
  type InventoryItemType,
} from '@prisma/client';
import {
  businessToday,
  Decimal,
  documentBalance,
  fiscalDocumentNumber,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  IGV_RATE_PCT,
  RETRYABLE_DOCUMENT_STATUSES,
  Role,
  salesOrderCode,
  salesTotals,
  serializeSalesTotals,
  toDecimal,
  toFixedString,
  VOID_WINDOW_DAYS,
  voidPathFor,
  dispatchCode as toDispatchCode,
  type CreateCreditNoteInput,
  type CreateInvoiceInput,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type FiscalDocumentQuery,
  type CreateFiscalSeriesInput,
  type FiscalSeriesDto,
  type InvoicingSettingsDto,
  type SalesOrderProgressDto,
  type UpdateInvoicingSettingsInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { dueDateFor, isStalled, pendingQty } from './invoicing-math';
import {
  ELECTRONIC_INVOICING_PROVIDER,
  type ElectronicInvoicingProvider,
  type IssueDocumentCommand,
  type PartyRef,
  type ProviderResult,
} from './ports/electronic-invoicing.port';

/**
 * Comprobantes electrónicos (RF-70, RF-74..RF-76; D-071..D-073, D-077).
 *
 * Las tres reglas que explican casi todo lo que hay acá:
 *
 * 1. **El dominio no conoce al PSE** (D-071). Este archivo habla con el puerto y con
 *    nadie más; la respuesta cruda se archiva sin leerla.
 * 2. **El correlativo se toma al enviar** (D-072), dentro de la transacción que deja el
 *    documento en `ISSUED`, y **el envío ocurre fuera de esa transacción** (D-073): así
 *    una caída del PSE no revierte un número ya tomado ni deja un camión esperando.
 * 3. **Un rechazo es terminal.** Se corrige creando un documento nuevo que apunta al
 *    rechazado; el rechazado conserva su número y queda en el historial.
 */

const documentInclude = {
  customer: {
    select: {
      id: true,
      name: true,
      docType: true,
      docNumber: true,
      address: true,
      email: true,
      isSystem: true,
    },
  },
  seriesRef: { select: { series: true } },
  salesOrder: { select: { id: true, seq: true } },
  dispatch: { select: { id: true, seq: true } },
  affectedDocument: {
    select: {
      id: true,
      number: true,
      docType: true,
      correlative: true,
      seriesRef: { select: { series: true } },
    },
  },
  replacesDocument: { select: { id: true, number: true } },
  replacedBy: { select: { id: true, number: true } },
  items: { orderBy: { lineNumber: 'asc' }, include: { product: { select: { sku: true } } } },
  payments: { orderBy: { createdAt: 'asc' } },
  creditNotes: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, number: true, status: true, issueDate: true, totalPen: true },
  },
} satisfies Prisma.FiscalDocumentInclude;

type DocumentRow = Prisma.FiscalDocumentGetPayload<{ include: typeof documentInclude }>;

function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Copia mutable de la constante de `@ayr/shared`: los filtros de Prisma piden un array
 * mutable y la del paquete es `readonly` a propósito, para que nadie la modifique.
 */
const RETRYABLE: FiscalDocumentStatus[] = [...RETRYABLE_DOCUMENT_STATUSES];

/**
 * Tope de un archivo descargado del PSE. Un PDF de comprobante pesa decenas de kilobytes;
 * veinte megas es holgado y a la vez impide que un cuerpo enorme agote la memoria de una
 * instancia de Cloud Run.
 */
const MAX_DOCUMENT_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Estados en los que el comprobante **ya existe** y consume pedido: tiene correlativo
 * tomado y sigue en pie.
 *
 * `SEND_ERROR` está adentro y no es un detalle: es el estado de un documento que tomó su
 * número y que el job va a seguir reintentando hasta que entre (D-073). Dejarlo fuera
 * hacía que, **justo con el PSE caído** —el escenario para el que existe la contingencia—,
 * la misma línea de pedido se pudiera facturar dos veces.
 *
 * Los que no cuentan son los tres que nunca llegaron a existir o dejaron de existir:
 * `DRAFT` (sin correlativo), `REJECTED` (SUNAT no lo aceptó) y `VOIDED` (dado de baja).
 */
const LIVE_DOCUMENT_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOID_PENDING,
];

@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(ELECTRONIC_INVOICING_PROVIDER)
    private readonly provider: ElectronicInvoicingProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Configuración (D-073)
  // -------------------------------------------------------------------------

  /**
   * Fila única de configuración. Se crea al vuelo si falta: la migración la siembra, pero
   * una base restaurada a mano no puede dejar el módulo sin arrancar.
   */
  private async settingsRow(): Promise<{
    id: string;
    providerOffline: boolean;
    alertAfterHours: number;
    updatedAt: Date;
  }> {
    const existing = await this.prisma.invoicingSetting.findFirst();
    if (existing) return existing;
    try {
      return await this.prisma.invoicingSetting.create({ data: {} });
    } catch (err) {
      // El índice de fila única de la migración rechaza la segunda creación concurrente;
      // la que perdió simplemente lee la que ganó. Sin él, dos peticiones sobre una base
      // recién restaurada dejaban dos filas y `providerOffline` pasaba a depender de cuál
      // devolviera `findFirst`.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.invoicingSetting.findFirstOrThrow();
      }
      throw err;
    }
  }

  async settings(): Promise<InvoicingSettingsDto> {
    const row = await this.settingsRow();
    return {
      providerOffline: row.providerOffline,
      alertAfterHours: row.alertAfterHours,
      providerConfigured: this.provider.configured,
      providerName: this.provider.name,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateSettings(
    actor: RequestUser,
    input: UpdateInvoicingSettingsInput,
  ): Promise<InvoicingSettingsDto> {
    const row = await this.settingsRow();
    await this.prisma.$transaction(async (tx) => {
      await tx.invoicingSetting.update({
        where: { id: row.id },
        data: {
          providerOffline: input.providerOffline ?? row.providerOffline,
          alertAfterHours: input.alertAfterHours ?? row.alertAfterHours,
          updatedById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.settings.update',
        entity: 'invoicing_settings',
        entityId: row.id,
        before: { providerOffline: row.providerOffline, alertAfterHours: row.alertAfterHours },
        after: {
          providerOffline: input.providerOffline ?? row.providerOffline,
          alertAfterHours: input.alertAfterHours ?? row.alertAfterHours,
        },
      });
    });
    return this.settings();
  }

  // -------------------------------------------------------------------------
  // D-072 — series del punto de emisión
  // -------------------------------------------------------------------------

  async findSeries(): Promise<FiscalSeriesDto[]> {
    const rows = await this.prisma.fiscalSeries.findMany({
      orderBy: [{ docType: 'asc' }, { series: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      docType: row.docType,
      series: row.series,
      affectedDocType: row.affectedDocType,
      correlative: row.correlative,
      isActive: row.isActive,
    }));
  }

  /**
   * Da de alta una serie (D-072).
   *
   * Las series que siembra la migración son las habituales, pero **la autorización es del
   * PSE por emisor**: una cuenta puede tener `F001` y otra no, y cada intento contra una
   * serie no autorizada cuesta un correlativo rechazado. Poder alinearlas acá es lo que
   * evita que eso sea una migración —y lo que hace que estrenar el módulo con una cuenta
   * nueva no dependa de desplegar de nuevo—.
   *
   * Dar de alta una serie **desactiva la anterior** de la misma combinación: el índice
   * parcial de la migración solo admite una activa, y hacerlo explícito evita que el alta
   * falle con un choque de índice que no le dice nada a nadie.
   */
  async createSeries(actor: RequestUser, input: CreateFiscalSeriesInput): Promise<FiscalSeriesDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      const affectedDocType =
        input.docType === FiscalDocType.NOTA_CREDITO ? (input.affectedDocType ?? null) : null;

      await tx.fiscalSeries.updateMany({
        where: { docType: input.docType, affectedDocType, isActive: true },
        data: { isActive: false },
      });

      const created = await tx.fiscalSeries.create({
        data: {
          docType: input.docType,
          series: input.series,
          affectedDocType,
          correlative: input.correlative,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.series.create',
        entity: 'fiscal_series',
        entityId: created.id,
        after: { docType: input.docType, series: input.series, correlative: input.correlative },
      });
      return created.id;
    });
    const rows = await this.findSeries();
    const created = rows.find((s) => s.id === id);
    if (!created) throw new NotFoundException('Serie no encontrada');
    return created;
  }

  /**
   * Activa o desactiva una serie. **El correlativo no se toca desde acá**: bajarlo emitiría
   * dos veces el mismo número y subirlo abriría un hueco, y las dos cosas son problemas con
   * SUNAT, no con el sistema. Continuar una numeración existente se hace al **crear** la
   * serie, que es cuando todavía no hay nada emitido con ella.
   */
  async setSeriesActive(
    actor: RequestUser,
    id: string,
    isActive: boolean,
  ): Promise<FiscalSeriesDto> {
    await this.prisma.$transaction(async (tx) => {
      const series = await tx.fiscalSeries.findUnique({ where: { id } });
      if (!series) throw new NotFoundException('Serie no encontrada');
      if (series.isActive === isActive) return;

      if (isActive) {
        await tx.fiscalSeries.updateMany({
          where: {
            docType: series.docType,
            affectedDocType: series.affectedDocType,
            isActive: true,
          },
          data: { isActive: false },
        });
      }
      await tx.fiscalSeries.update({ where: { id }, data: { isActive } });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.series.toggle',
        entity: 'fiscal_series',
        entityId: id,
        before: { series: series.series, isActive: series.isActive },
        after: { isActive },
      });
    });
    const rows = await this.findSeries();
    const updated = rows.find((s) => s.id === id);
    if (!updated) throw new NotFoundException('Serie no encontrada');
    return updated;
  }

  // -------------------------------------------------------------------------
  // RF-70 — crear el borrador
  // -------------------------------------------------------------------------

  /**
   * Crea el comprobante en `BORRADOR`. **No toma correlativo** (D-072) y no habla con el
   * PSE: hasta acá todo es reversible sin dejar rastro fiscal.
   */
  async create(actor: RequestUser, input: CreateInvoiceInput): Promise<FiscalDocumentDto> {
    const id = await this.prisma.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
        if (!customer) throw new NotFoundException('Cliente no encontrado');
        if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');

        // D-077: el cliente sembrado solo admite boleta. Una factura necesita RUC, y el
        // genérico no tiene ninguno: emitirla sería mandar al PSE una identidad inventada.
        if (customer.isSystem && input.docType !== FiscalDocType.BOLETA) {
          throw new BadRequestException(
            'Al cliente "público en general" solo se le emiten boletas: elige un cliente identificado para una factura',
          );
        }
        if (input.docType === FiscalDocType.FACTURA && customer.docType !== DocType.RUC) {
          throw new BadRequestException(
            'Una factura se emite a un cliente con RUC; para este cliente corresponde una boleta',
          );
        }

        const lines = await this.resolveLines(tx, input);
        const totals = salesTotals(
          lines.map((l) => ({ qty: l.qty, unitPricePen: l.unitPricePen })),
        );
        const serialized = serializeSalesTotals(totals);

        // D-077: bloqueo suave del tope de SUNAT. La excepción existe, la puede usar solo
        // ADMINISTRADOR y **queda escrita en el propio comprobante**, que es la diferencia
        // entre una regla que se puede saltar y una que se puede saltar dejando constancia.
        let overrideById: string | null = null;
        if (customer.isSystem && totals.total.gt(toDecimal(GENERIC_CUSTOMER_MAX_TOTAL_PEN))) {
          if (!input.forceGenericCustomer) {
            throw new BadRequestException(
              `Una boleta a "público en general" no puede pasar de S/ ${toDecimal(GENERIC_CUSTOMER_MAX_TOTAL_PEN).toFixed(2)}: identifica al cliente (esta es de S/ ${totals.total.toFixed(2)})`,
            );
          }
          if (actor.role !== Role.ADMINISTRADOR) {
            throw new ForbiddenException(
              'Solo un administrador puede emitir una boleta a "público en general" por encima del tope',
            );
          }
          overrideById = actor.id;
        }

        const dueDate = this.resolveDueDate(input, customer.creditDays);

        const created = await tx.fiscalDocument.create({
          data: {
            docType: input.docType,
            status: FiscalDocumentStatus.DRAFT,
            customerId: customer.id,
            salesOrderId: input.salesOrderId ?? null,
            issueDate: toDateOnly(input.issueDate),
            paymentTerms: input.paymentTerms,
            dueDate: dueDate === null ? null : toDateOnly(dueDate),
            subtotalPen: serialized.subtotalPen,
            igvPen: serialized.igvPen,
            totalPen: serialized.totalPen,
            detractionCode: input.detraction?.code ?? null,
            detractionPct: input.detraction?.pct ?? null,
            detractionAmountPen: input.detraction?.amountPen ?? null,
            genericCustomerOverrideById: overrideById,
            notes: input.notes ?? null,
            createdById: actor.id,
            items: {
              create: lines.map((l, i) => ({
                lineNumber: i + 1,
                productId: l.productId,
                description: l.description,
                qty: l.qty,
                unit: l.unit,
                unitPricePen: l.unitPricePen,
                subtotalPen: l.subtotalPen,
                igvPen: l.igvPen,
                totalPen: l.totalPen,
                salesOrderItemId: l.salesOrderItemId,
              })),
            },
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.document.create',
          entity: 'fiscal_documents',
          entityId: created.id,
          after: {
            docType: input.docType,
            customer: customer.name,
            totalPen: serialized.totalPen,
            genericOverride: overrideById !== null,
          },
        });
        return created.id;
      },
      { timeout: 30_000 },
    );

    return this.findOne(id);
  }

  /**
   * Vencimiento: el que mandó el usuario, o el que sale de los días de crédito (D-075).
   *
   * Delega en `dueDateFor`, que es la función con prueba unitaria. Tener una segunda
   * implementación acá hacía que la probada no fuera la que corría: con `CREDITO` y cero
   * días de crédito, esta devolvía la fecha de emisión —un comprobante que nace vencido—
   * y la probada devolvía `null`.
   */
  private resolveDueDate(input: CreateInvoiceInput, creditDays: number): string | null {
    if (input.paymentTerms === 'CONTADO') return null;
    if (input.dueDate) return input.dueDate;
    return dueDateFor(input.issueDate, creditDays);
  }

  /**
   * Resuelve las líneas del comprobante contra el pedido.
   *
   * Una línea con `salesOrderItemId` **no puede facturar más de lo que a esa línea le
   * queda por facturar**: sin esta comprobación, dos comprobantes parciales del mismo
   * pedido podían sumar más que el pedido y el saldo por cobrar mentía en la diferencia.
   */
  private async resolveLines(
    tx: Prisma.TransactionClient,
    input: CreateInvoiceInput,
  ): Promise<
    {
      productId: string | null;
      description: string;
      qty: string;
      unit: string;
      unitPricePen: string;
      subtotalPen: string;
      igvPen: string;
      totalPen: string;
      salesOrderItemId: string | null;
    }[]
  > {
    const orderItemIds = input.items
      .map((i) => i.salesOrderItemId)
      .filter((id): id is string => id !== undefined);

    const orderItems =
      orderItemIds.length > 0
        ? await tx.salesOrderItem.findMany({
            where: { id: { in: orderItemIds } },
            include: {
              product: { select: { sku: true } },
              salesOrder: { select: { id: true, status: true, seq: true, customerId: true } },
            },
          })
        : [];
    const byId = new Map(orderItems.map((i) => [i.id, i]));

    // Lo ya facturado por línea: solo cuentan los comprobantes vivos. Un rechazado nunca
    // existió para SUNAT y un anulado dejó de existir; ninguno de los dos consume pedido.
    const invoiced = await tx.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: orderItemIds },
        document: {
          status: { in: LIVE_DOCUMENT_STATUSES },
          docType: { not: FiscalDocType.NOTA_CREDITO },
        },
      },
      _sum: { qty: true },
    });
    const invoicedByItem = new Map(
      invoiced.map((row) => [
        row.salesOrderItemId ?? '',
        toDecimal((row._sum.qty ?? new Prisma.Decimal(0)).toString()),
      ]),
    );

    // Lo que este mismo comprobante ya comprometió en líneas anteriores. Sin esto, dos
    // líneas del mismo documento apuntando a la misma línea de pedido se comparaban cada
    // una contra el pendiente completo y juntas facturaban el doble en una sola petición.
    const usedHere = new Map<string, Decimal>();

    return input.items.map((item) => {
      const qty = toDecimal(item.qty);
      if (item.salesOrderItemId) {
        const orderItem = byId.get(item.salesOrderItemId);
        if (!orderItem) throw new NotFoundException('Línea de pedido no encontrada');
        if (orderItem.salesOrder.id !== input.salesOrderId) {
          throw new BadRequestException('Hay una línea que no pertenece al pedido indicado');
        }
        if (orderItem.salesOrder.status === 'CANCELLED') {
          throw new BadRequestException(
            `El pedido ${salesOrderCode(orderItem.salesOrder.seq)} está anulado: no se puede facturar`,
          );
        }
        if (orderItem.salesOrder.customerId !== input.customerId) {
          throw new BadRequestException('El comprobante y el pedido son de clientes distintos');
        }
        const already = (invoicedByItem.get(orderItem.id) ?? new Decimal(0)).plus(
          usedHere.get(orderItem.id) ?? new Decimal(0),
        );
        const pending = toDecimal(orderItem.qty.toString()).minus(already);
        if (qty.gt(pending)) {
          throw new BadRequestException(
            `A la línea ${orderItem.lineNumber} (${orderItem.product.sku}) le quedan ${pending.toFixed(3)} por facturar y se intentan facturar ${qty.toFixed(3)}`,
          );
        }
        usedHere.set(orderItem.id, (usedHere.get(orderItem.id) ?? new Decimal(0)).plus(qty));
        const price = item.unitPricePen ?? orderItem.unitPricePen.toString();
        const totals = salesTotals([{ qty: item.qty, unitPricePen: price }]);
        const s = serializeSalesTotals(totals);
        return {
          productId: orderItem.productId,
          description: item.description ?? orderItem.description,
          qty: item.qty,
          unit: item.unit ?? orderItem.unit,
          unitPricePen: toFixedString(price, 'MONEY'),
          ...s,
          salesOrderItemId: orderItem.id,
        };
      }

      // Línea libre. El schema ya exige descripción y precio (`invoiceItemInputSchema`);
      // esto lo vuelve a comprobar para quien llame al servicio sin pasar por el pipe.
      const price = item.unitPricePen;
      const description = item.description;
      if (price === undefined || description === undefined) {
        throw new BadRequestException(
          'Una línea que no viene del pedido necesita descripción y precio unitario',
        );
      }
      const totals = salesTotals([{ qty: item.qty, unitPricePen: price }]);
      return {
        productId: item.productId ?? null,
        description,
        qty: item.qty,
        unit: item.unit ?? 'ZZ',
        unitPricePen: toFixedString(price, 'MONEY'),
        ...serializeSalesTotals(totals),
        salesOrderItemId: null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // RF-76 — nota de crédito
  // -------------------------------------------------------------------------

  /**
   * Nota de crédito sobre un comprobante vivo (RF-76). Sin líneas es **total**; con
   * líneas, parcial, y cada una acredita como mucho lo que a su línea original le queda.
   *
   * Nace en `BORRADOR` como cualquier otro documento: se envía con la misma ruta, toma su
   * correlativo de la serie que corresponde al tipo del afectado (`FC01`/`BC01`, D-072) y
   * pasa por la misma máquina de estados.
   */
  async createCreditNote(
    actor: RequestUser,
    affectedId: string,
    input: CreateCreditNoteInput,
  ): Promise<FiscalDocumentDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      const affected = await tx.fiscalDocument.findUnique({
        where: { id: affectedId },
        include: { items: { orderBy: { lineNumber: 'asc' } }, customer: true },
      });
      if (!affected) throw new NotFoundException('Comprobante no encontrado');
      if (affected.docType === FiscalDocType.NOTA_CREDITO) {
        throw new BadRequestException(
          'Una nota de crédito no se acredita con otra nota de crédito',
        );
      }
      if (affected.docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
        throw new BadRequestException('Una guía de remisión no se acredita: se da de baja');
      }
      if (affected.status !== FiscalDocumentStatus.ACCEPTED) {
        throw new BadRequestException(
          `Solo se acredita un comprobante aceptado por SUNAT; este está ${affected.status}`,
        );
      }
      // Acreditar tiene el mismo efecto económico que dar de baja —el saldo se va a cero—,
      // así que sigue la misma regla de propiedad que emitir.
      if (actor.role !== Role.ADMINISTRADOR && affected.createdById !== actor.id) {
        throw new ForbiddenException(
          'El comprobante es de otro vendedor: no puedes emitir su nota de crédito',
        );
      }

      // Lo ya acreditado por línea, contando solo notas vivas.
      const credited = await tx.fiscalDocumentItem.groupBy({
        by: ['affectedItemId'],
        where: {
          affectedItemId: { in: affected.items.map((i) => i.id) },
          document: { status: { in: LIVE_DOCUMENT_STATUSES } },
        },
        _sum: { qty: true },
      });
      const creditedByItem = new Map(
        credited.map((r) => [
          r.affectedItemId ?? '',
          toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString()),
        ]),
      );

      const requested =
        input.items && input.items.length > 0
          ? input.items
          : affected.items
              // Una "total" sobre un comprobante que ya tuvo una parcial acredita **lo que
              // queda**, no todo: sin este filtro, la primera línea ya acreditada por
              // completo hacía fallar la operación culpando a una línea que el usuario ni
              // siquiera pidió.
              .filter((i) =>
                toDecimal(i.qty.toString())
                  .minus(creditedByItem.get(i.id) ?? new Decimal(0))
                  .gt(0),
              )
              .map((i) => ({
                affectedItemId: i.id,
                qty: toDecimal(i.qty.toString())
                  .minus(creditedByItem.get(i.id) ?? new Decimal(0))
                  .toFixed(3),
              }));

      const byId = new Map(affected.items.map((i) => [i.id, i]));
      // Mismo acumulador que en `resolveLines`, por el mismo motivo: dos líneas de la NC
      // sobre la misma línea del comprobante acreditaban el doble.
      const usedHere = new Map<string, Decimal>();
      const lines = requested.map((line) => {
        const original = byId.get(line.affectedItemId);
        if (!original) {
          throw new BadRequestException('Hay una línea que no pertenece al comprobante afectado');
        }
        const qty = toDecimal(line.qty);
        const pending = toDecimal(original.qty.toString())
          .minus(creditedByItem.get(original.id) ?? new Decimal(0))
          .minus(usedHere.get(original.id) ?? new Decimal(0));
        if (qty.lte(0)) {
          throw new BadRequestException(
            `La línea ${original.lineNumber} ya está acreditada por completo`,
          );
        }
        if (qty.gt(pending)) {
          throw new BadRequestException(
            `A la línea ${original.lineNumber} le quedan ${pending.toFixed(3)} por acreditar y se intentan acreditar ${qty.toFixed(3)}`,
          );
        }
        usedHere.set(original.id, (usedHere.get(original.id) ?? new Decimal(0)).plus(qty));
        const totals = salesTotals([
          { qty: line.qty, unitPricePen: original.unitPricePen.toString() },
        ]);
        return {
          original,
          qty: line.qty,
          ...serializeSalesTotals(totals),
        };
      });

      if (lines.length === 0) {
        throw new BadRequestException('No queda nada por acreditar en este comprobante');
      }

      const totals = salesTotals(
        lines.map((l) => ({
          qty: l.qty,
          unitPricePen: l.original.unitPricePen.toString(),
        })),
      );
      const serialized = serializeSalesTotals(totals);

      const note = await tx.fiscalDocument.create({
        data: {
          docType: FiscalDocType.NOTA_CREDITO,
          status: FiscalDocumentStatus.DRAFT,
          customerId: affected.customerId,
          salesOrderId: affected.salesOrderId,
          affectedDocumentId: affected.id,
          creditNoteReason: input.reason,
          issueDate: toDateOnly(input.issueDate),
          // Una nota de crédito no se cobra: ajusta el saldo del comprobante que afecta.
          paymentTerms: 'CONTADO',
          subtotalPen: serialized.subtotalPen,
          igvPen: serialized.igvPen,
          totalPen: serialized.totalPen,
          notes: input.notes ?? null,
          createdById: actor.id,
          items: {
            create: lines.map((l, i) => ({
              lineNumber: i + 1,
              productId: l.original.productId,
              description: l.original.description,
              qty: l.qty,
              unit: l.original.unit,
              unitPricePen: l.original.unitPricePen,
              subtotalPen: l.subtotalPen,
              igvPen: l.igvPen,
              totalPen: l.totalPen,
              salesOrderItemId: l.original.salesOrderItemId,
              affectedItemId: l.original.id,
            })),
          },
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.credit-note.create',
        entity: 'fiscal_documents',
        entityId: note.id,
        after: {
          affects: affected.number,
          reason: input.reason,
          totalPen: serialized.totalPen,
          partial: (input.items?.length ?? 0) > 0,
        },
      });
      return note.id;
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // RF-74 — corregir un rechazado
  // -------------------------------------------------------------------------

  /**
   * Copia un comprobante rechazado a un borrador nuevo que lo reemplaza (RF-74, D-072).
   *
   * **No reutiliza el correlativo**: el rechazado lo conserva y queda en el historial. Es
   * la regla de SUNAT y también lo honesto — el intento ocurrido ya lo vio la
   * administración, y esconderlo detrás del mismo número sería borrar un hecho.
   */
  async correct(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    try {
      return await this.correctInner(actor, id);
    } catch (err) {
      // `replaces_document_id` es único: dos correcciones simultáneas del mismo rechazado
      // chocan contra el índice, y sin esto la segunda salía como un 500 en vez del 409
      // que la comprobación de más abajo ya quiso dar.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ese comprobante rechazado ya fue corregido');
      }
      throw err;
    }
  }

  private async correctInner(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    const newId = await this.prisma.$transaction(async (tx) => {
      const rejected = await tx.fiscalDocument.findUnique({
        where: { id },
        include: { items: { orderBy: { lineNumber: 'asc' } } },
      });
      if (!rejected) throw new NotFoundException('Comprobante no encontrado');
      if (rejected.status !== FiscalDocumentStatus.REJECTED) {
        throw new BadRequestException('Solo se corrige un comprobante rechazado');
      }
      if (actor.role !== Role.ADMINISTRADOR && rejected.createdById !== actor.id) {
        throw new ForbiddenException('El comprobante es de otro vendedor: no puedes corregirlo');
      }
      const existing = await tx.fiscalDocument.findFirst({
        where: { replacesDocumentId: id },
        select: { id: true, number: true },
      });
      if (existing) {
        throw new ConflictException(
          `Este rechazado ya fue corregido por ${existing.number ?? 'un borrador'}`,
        );
      }

      const copy = await tx.fiscalDocument.create({
        data: {
          docType: rejected.docType,
          status: FiscalDocumentStatus.DRAFT,
          customerId: rejected.customerId,
          salesOrderId: rejected.salesOrderId,
          affectedDocumentId: rejected.affectedDocumentId,
          creditNoteReason: rejected.creditNoteReason,
          // El despacho va con la copia: sin él, corregir una guía rechazada creaba una
          // fila que viola `fiscal_documents_shape_ck` y salía como un 500 de Postgres.
          dispatchId: rejected.dispatchId,
          replacesDocumentId: rejected.id,
          // Fecha de hoy y no la del rechazado: el documento nuevo se emite ahora.
          issueDate: toDateOnly(businessToday()),
          paymentTerms: rejected.paymentTerms,
          dueDate: rejected.dueDate,
          subtotalPen: rejected.subtotalPen,
          igvPen: rejected.igvPen,
          totalPen: rejected.totalPen,
          detractionCode: rejected.detractionCode,
          detractionPct: rejected.detractionPct,
          detractionAmountPen: rejected.detractionAmountPen,
          genericCustomerOverrideById: rejected.genericCustomerOverrideById,
          notes: rejected.notes,
          createdById: actor.id,
          items: {
            create: rejected.items.map((i) => ({
              lineNumber: i.lineNumber,
              productId: i.productId,
              description: i.description,
              qty: i.qty,
              unit: i.unit,
              unitPricePen: i.unitPricePen,
              subtotalPen: i.subtotalPen,
              igvPen: i.igvPen,
              totalPen: i.totalPen,
              salesOrderItemId: i.salesOrderItemId,
              affectedItemId: i.affectedItemId,
            })),
          },
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.document.correct',
        entity: 'fiscal_documents',
        entityId: copy.id,
        before: { rejected: rejected.number, code: rejected.rejectionCode },
        after: { draftOf: rejected.number },
      });
      return copy.id;
    });

    return this.findOne(newId);
  }

  // -------------------------------------------------------------------------
  // D-072/D-073 — enviar
  // -------------------------------------------------------------------------

  /**
   * Envía el comprobante al PSE. **Las dos fases de D-073, en orden:**
   *
   * 1. Una transacción corta toma el correlativo, escribe el número y deja el documento
   *    en `ISSUED`. Al confirmarse, el documento ya existe para la empresa y **habilita el
   *    despacho**, con el PSE caído o no.
   * 2. Fuera de la transacción se intenta el envío. Si el PSE contesta, el documento pasa
   *    a `ACCEPTED` o `REJECTED`; si no, queda en `SEND_ERROR` y lo recoge el job.
   *
   * Invertir el orden —enviar dentro de la transacción— haría que una caída del PSE
   * revirtiera un correlativo ya tomado, que es exactamente el hueco que D-072 evita.
   */
  async send(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    await this.assertOwnership(actor, id, 'emitirlo');
    await this.assign(actor, id);
    await this.deliver(id);
    return this.findOne(id);
  }

  /**
   * Un vendedor solo opera **sobre sus propios** documentos; el administrador, sobre
   * todos. Es la misma regla que RF-66 impuso en cotizaciones (`assertOwnership` en
   * `QuotationsService`) y por el mismo motivo: con solo el id, cualquier vendedor podía
   * emitir el borrador de un compañero — y emitir es irreversible, toma correlativo y lo
   * manda a SUNAT a nombre de la empresa.
   *
   * La **lectura** queda abierta: la lista es del equipo comercial entero.
   */
  private async assertOwnership(actor: RequestUser, id: string, action: string): Promise<void> {
    if (actor.role === Role.ADMINISTRADOR) return;
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      select: { createdById: true },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    if (document.createdById !== actor.id) {
      throw new ForbiddenException(`El comprobante es de otro vendedor: no puedes ${action}`);
    }
  }

  /** Fase 1: correlativo y estado `ISSUED`, en su propia transacción. */
  private async assign(actor: RequestUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; status: FiscalDocumentStatus; doc_type: FiscalDocType }[]
      >`
        SELECT "id", "status", "doc_type" FROM "fiscal_documents"
        WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const head = rows[0];
      if (!head) throw new NotFoundException('Comprobante no encontrado');
      if (head.status !== FiscalDocumentStatus.DRAFT) {
        throw new ConflictException(
          head.status === FiscalDocumentStatus.REJECTED
            ? 'Este comprobante fue rechazado: corrígelo para emitir uno nuevo'
            : 'El comprobante ya fue emitido',
        );
      }

      const document = await tx.fiscalDocument.findUniqueOrThrow({
        where: { id },
        include: {
          items: { select: { id: true, qty: true, salesOrderItemId: true, affectedItemId: true } },
          affectedDocument: { select: { docType: true } },
        },
      });
      if (
        document.items.length === 0 &&
        document.docType !== FiscalDocType.GUIA_REMISION_REMITENTE
      ) {
        throw new BadRequestException('Un comprobante sin líneas no se emite');
      }

      // **Revalidar antes de tomar el correlativo.** Los topes de "cuánto queda por
      // facturar" y "cuánto queda por acreditar" se comprueban al crear el borrador, pero
      // un borrador no consume nada: dos borradores sobre la misma línea pasan los dos esa
      // comprobación y, al enviarse, ambos toman número y sobrefacturan el pedido con dos
      // comprobantes válidos ante SUNAT. Acá, con la fila ya bloqueada, es el último punto
      // en el que todavía se puede decir que no.
      await this.assertStillAvailable(tx, document);

      const affectedDocType =
        document.docType === FiscalDocType.NOTA_CREDITO
          ? (document.affectedDocument?.docType ?? null)
          : null;
      const { seriesId, series, correlative } = await this.allocateNumber(
        tx,
        document.docType,
        affectedDocType,
      );

      await tx.fiscalDocument.update({
        where: { id },
        data: {
          seriesId,
          correlative,
          number: fiscalDocumentNumber(series, correlative),
          status: FiscalDocumentStatus.ISSUED,
          issuedAt: new Date(),
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.document.issue',
        entity: 'fiscal_documents',
        entityId: id,
        after: { number: fiscalDocumentNumber(series, correlative) },
      });
    });
  }

  /**
   * Comprueba, con el documento ya bloqueado, que sus líneas siguen cabiendo en lo que
   * queda por facturar o por acreditar **sin contarse a sí mismo**.
   *
   * Es la misma cuenta que hace `resolveLines`/`createCreditNote` al crear el borrador,
   * repetida en el único momento en que deja de ser una estimación: justo antes de gastar
   * un correlativo, que es lo único de esta fase que no se puede deshacer.
   */
  private async assertStillAvailable(
    tx: Prisma.TransactionClient,
    document: {
      id: string;
      docType: FiscalDocType;
      items: {
        qty: Prisma.Decimal;
        salesOrderItemId: string | null;
        affectedItemId: string | null;
      }[];
    },
  ): Promise<void> {
    if (document.docType === FiscalDocType.GUIA_REMISION_REMITENTE) return;

    if (document.docType === FiscalDocType.NOTA_CREDITO) {
      const ids = document.items.flatMap((i) => (i.affectedItemId ? [i.affectedItemId] : []));
      if (ids.length === 0) return;
      const originals = await tx.fiscalDocumentItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, lineNumber: true, qty: true },
      });
      const credited = await tx.fiscalDocumentItem.groupBy({
        by: ['affectedItemId'],
        where: {
          affectedItemId: { in: ids },
          documentId: { not: document.id },
          document: { status: { in: LIVE_DOCUMENT_STATUSES } },
        },
        _sum: { qty: true },
      });
      const creditedById = new Map(
        credited.flatMap((r) =>
          r.affectedItemId === null
            ? []
            : [
                [r.affectedItemId, toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString())] as [
                  string,
                  Decimal,
                ],
              ],
        ),
      );
      for (const item of document.items) {
        if (!item.affectedItemId) continue;
        const original = originals.find((o) => o.id === item.affectedItemId);
        if (!original) continue;
        const available = toDecimal(original.qty.toString()).minus(
          creditedById.get(original.id) ?? new Decimal(0),
        );
        if (toDecimal(item.qty.toString()).gt(available)) {
          throw new ConflictException(
            `Otra nota de crédito ya acreditó la línea ${original.lineNumber}: quedan ${available.toFixed(3)}. Revisa este borrador antes de emitirlo.`,
          );
        }
      }
      return;
    }

    const ids = document.items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []));
    if (ids.length === 0) return;
    const orderItems = await tx.salesOrderItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, lineNumber: true, qty: true },
    });
    const invoiced = await tx.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: ids },
        documentId: { not: document.id },
        document: {
          status: { in: LIVE_DOCUMENT_STATUSES },
          docType: { not: FiscalDocType.NOTA_CREDITO },
        },
      },
      _sum: { qty: true },
    });
    const invoicedById = new Map(
      invoiced.flatMap((r) =>
        r.salesOrderItemId === null
          ? []
          : [
              [r.salesOrderItemId, toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString())] as [
                string,
                Decimal,
              ],
            ],
      ),
    );
    for (const item of document.items) {
      if (!item.salesOrderItemId) continue;
      const orderItem = orderItems.find((o) => o.id === item.salesOrderItemId);
      if (!orderItem) continue;
      const available = toDecimal(orderItem.qty.toString()).minus(
        invoicedById.get(orderItem.id) ?? new Decimal(0),
      );
      if (toDecimal(item.qty.toString()).gt(available)) {
        throw new ConflictException(
          `Otro comprobante ya facturó la línea ${orderItem.lineNumber} del pedido: quedan ${available.toFixed(3)}. Revisa este borrador antes de emitirlo.`,
        );
      }
    }
  }

  /**
   * Toma el siguiente correlativo de la serie (D-072).
   *
   * `UPDATE … SET correlative = correlative + 1 … RETURNING` en una sola sentencia: el
   * mismo patrón atómico que `suppliers.coil_seq` para el código de bobina (RF-13), y por
   * el mismo motivo — dos emisiones simultáneas no pueden llevarse el mismo número.
   */
  private async allocateNumber(
    tx: Prisma.TransactionClient,
    docType: FiscalDocType,
    affectedDocType: FiscalDocType | null,
  ): Promise<{ seriesId: string; series: string; correlative: number }> {
    const rows = await tx.$queryRaw<{ id: string; series: string; correlative: number }[]>`
      UPDATE "fiscal_series"
      SET "correlative" = "correlative" + 1, "updated_at" = NOW()
      WHERE "id" = (
        SELECT "id" FROM "fiscal_series"
        WHERE "doc_type" = ${docType}::"FiscalDocType"
          AND "is_active"
          AND ("affected_doc_type" IS NOT DISTINCT FROM ${affectedDocType}::"FiscalDocType")
        ORDER BY "series" LIMIT 1
      )
      RETURNING "id", "series", "correlative"
    `;
    const row = rows[0];
    if (!row) {
      throw new BadRequestException(
        `No hay una serie activa para emitir ${docType}${affectedDocType ? ` sobre ${affectedDocType}` : ''}`,
      );
    }
    return { seriesId: row.id, series: row.series, correlative: row.correlative };
  }

  /**
   * Fase 2: el intento de envío, **fuera de toda transacción**.
   *
   * Nunca lanza: un fallo del PSE no puede convertirse en un error del usuario sobre una
   * operación que, por D-073, ya está confirmada. Lo que hace es dejar el documento en el
   * estado que corresponde y anotar por qué.
   */
  async deliver(id: string): Promise<void> {
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: documentInclude,
    });
    if (!document) return;
    // Sin número no hay nada que enviar: el correlativo se toma al emitir (D-072).
    if (document.number === null) return;
    if (!RETRYABLE_DOCUMENT_STATUSES.includes(document.status)) return;

    // La contingencia se mira **antes** de reclamar el intento: un envío que nunca sale a
    // la red no es un intento, y contarlo como tal borra la diferencia entre "todavía no
    // salió" y "salió y no entra", que es lo que `sendAttempts` existe para decir.
    const settings = await this.settingsRow();
    if (settings.providerOffline) {
      await this.applyResult(id, this.offlineResult());
      return;
    }
    if (!(await this.claimAttempt(id))) return;

    // **Nunca lanza**, y la garantía es de este método, no del adaptador: cualquier fallo
    // acá —incluido el de escribir el resultado— subiría por `send` hasta el usuario como
    // un 500 sobre un documento que ya tomó correlativo, que es exactamente lo que D-073
    // existe para evitar.
    try {
      // Con ticket, el documento **ya está en el PSE**: reemitirlo con la misma serie y
      // correlativo lo devolvería como duplicado —o sea, como rechazo— y quemaría el
      // número. Lo que corresponde es preguntar por él.
      const result = document.providerTicket
        ? await this.callProvider(() =>
            this.provider.queryStatus({
              docType: document.docType,
              series: document.seriesRef?.series ?? '',
              correlative: document.correlative ?? 0,
            }),
          )
        : await this.callProvider(() => this.provider.issueDocument(this.toIssueCommand(document)));

      await this.applyResult(document.id, result);
      if (result.outcome === 'ACCEPTED') {
        await this.storeFiles(document.id, document.number, result);
      }
    } catch (err) {
      this.logger.error(`Fallo al enviar ${document.number} al PSE`, err);
    }
  }

  /**
   * Envía el documento por el camino que corresponde a su tipo.
   *
   * Existe porque una guía de remisión y un comprobante de pago arman payloads distintos
   * —la guía no tiene líneas con importes— y ramificar en cada llamador hacía que el
   * reintento manual de una guía terminara mandando un comprobante vacío al PSE.
   */
  private async deliverAny(id: string, docType: FiscalDocType): Promise<void> {
    if (docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
      await this.deliverDispatchNote(id);
    } else {
      await this.deliver(id);
    }
  }

  /**
   * Reclama el intento antes de salir a la red (D-073).
   *
   * `applyResult` protege la **escritura** del resultado, pero no el envío: dos reintentos
   * simultáneos —uno manual y el barrido del job, por ejemplo— leían el mismo estado y
   * llamaban al PSE dos veces con el mismo correlativo. Este `updateMany` condicionado es
   * lo que hace que solo uno de los dos salga; el otro ve cero filas afectadas y se retira.
   *
   * Marcar el intento acá y no después también deja `sendAttempts` contando intentos
   * reales, que es lo que separa "todavía no salió" de "salió y no entra".
   */
  private async claimAttempt(id: string): Promise<boolean> {
    const claimed = await this.prisma.fiscalDocument.updateMany({
      where: { id, status: { in: RETRYABLE } },
      data: { sendAttempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    return claimed.count === 1;
  }

  /** Contingencia manual: no se llama al PSE y el documento queda para el job (D-073). */
  private offlineResult(): ProviderResult {
    return {
      outcome: 'ERROR',
      ticket: null,
      sunatHash: null,
      pdfUrl: null,
      xmlUrl: null,
      cdrUrl: null,
      code: 'OFFLINE',
      message: 'El envío al PSE está en contingencia manual',
      raw: { offline: true },
    };
  }

  /** Traduce la fila al comando del puerto. Es la frontera del dominio (D-071). */
  private toIssueCommand(document: DocumentRow): IssueDocumentCommand {
    return {
      docType: document.docType,
      series: document.seriesRef?.series ?? '',
      correlative: document.correlative ?? 0,
      issueDate: document.issueDate.toISOString().slice(0, 10),
      dueDate: document.dueDate ? document.dueDate.toISOString().slice(0, 10) : null,
      customer: this.toPartyRef(document),
      igvRatePct: IGV_RATE_PCT,
      subtotalPen: document.subtotalPen.toFixed(4),
      igvPen: document.igvPen.toFixed(4),
      totalPen: document.totalPen.toFixed(4),
      lines: document.items.map((i) => ({
        code: i.product?.sku ?? null,
        description: i.description,
        unit: i.unit,
        qty: i.qty.toFixed(3),
        unitPricePen: i.unitPricePen.toFixed(4),
        subtotalPen: i.subtotalPen.toFixed(4),
        igvPen: i.igvPen.toFixed(4),
        totalPen: i.totalPen.toFixed(4),
      })),
      notes: document.notes,
      affects:
        document.affectedDocument && document.creditNoteReason
          ? {
              docType: document.affectedDocument.docType,
              series: document.affectedDocument.seriesRef?.series ?? '',
              correlative: document.affectedDocument.correlative ?? 0,
              reason: document.creditNoteReason,
            }
          : null,
      detraction:
        document.detractionCode && document.detractionPct && document.detractionAmountPen
          ? {
              code: document.detractionCode,
              pct: document.detractionPct.toFixed(2),
              amountPen: document.detractionAmountPen.toFixed(4),
            }
          : null,
    };
  }

  /**
   * D-077: al PSE, el cliente sembrado viaja **sin tipo de documento**. El puerto admite
   * `docType: null` justo para esto, en vez de mandar un DNI inventado que SUNAT tomaría
   * como la identidad de una persona real.
   */
  private toPartyRef(document: DocumentRow): PartyRef {
    const c = document.customer;
    return {
      docType: c.isSystem ? null : c.docType,
      docNumber: c.docNumber,
      name: c.name,
      address: c.address,
      email: c.email,
    };
  }

  /**
   * Escribe el desenlace del envío. Una sola escritura, condicionada al estado leído.
   *
   * El contador de intentos ya lo subió `claimAttempt` antes de salir a la red: acá solo
   * se registra **qué contestó** el PSE.
   */
  private async applyResult(id: string, result: ProviderResult): Promise<void> {
    const now = new Date();
    const data: Prisma.FiscalDocumentUpdateInput = {
      providerResponse: result.raw ?? {},
      providerTicket: result.ticket,
    };

    if (result.outcome === 'ACCEPTED') {
      data.status = FiscalDocumentStatus.ACCEPTED;
      data.acceptedAt = now;
      data.sunatHash = result.sunatHash;
      data.lastSendError = null;
      data.rejectionCode = null;
      data.rejectionMessage = null;
    } else if (result.outcome === 'REJECTED') {
      data.status = FiscalDocumentStatus.REJECTED;
      data.rejectedAt = now;
      data.rejectionCode = result.code;
      data.rejectionMessage = result.message?.slice(0, 500) ?? null;
      data.lastSendError = null;
    } else if (result.outcome === 'PENDING') {
      // Sigue en `ISSUED`: el PSE lo tiene, SUNAT todavía no contestó. Se consulta después.
      data.lastSendError = null;
    } else {
      data.status = FiscalDocumentStatus.SEND_ERROR;
      data.lastSendError = result.message?.slice(0, 500) ?? 'Error de envío';
    }

    const updated = await this.prisma.fiscalDocument.updateMany({
      where: { id, status: { in: RETRYABLE } },
      data: data,
    });

    // RF-95: "SUNAT lo aceptó" y "SUNAT lo rechazó" son exactamente los hechos que un
    // requerimiento fiscal necesita poder mostrar, y hasta acá no dejaban ningún rastro.
    // El actor es `null` porque la transición la decide el PSE, no una persona.
    if (updated.count === 1 && result.outcome !== 'PENDING') {
      await this.audit.log({
        actorId: null,
        action: `invoicing.document.${result.outcome.toLowerCase()}`,
        entity: 'fiscal_documents',
        entityId: id,
        after: { outcome: result.outcome, code: result.code, message: result.message },
      });
    }
  }

  /**
   * Descarga PDF, XML y CDR del PSE y los guarda en R2 (D-007).
   *
   * Best-effort, igual que el PDF de la cotización (D-068): que un archivo no se pueda
   * guardar no puede desaceptar un comprobante que SUNAT ya aceptó. Si falla, el
   * documento queda sin archivo y se puede volver a pedir con `refreshStatus`.
   */
  private async storeFiles(id: string, number: string, result: ProviderResult): Promise<void> {
    const files: [string | null, string, 'pdfKey' | 'xmlKey' | 'cdrKey', string][] = [
      [result.pdfUrl, 'pdf', 'pdfKey', 'application/pdf'],
      [result.xmlUrl, 'xml', 'xmlKey', 'application/xml'],
      [result.cdrUrl, 'zip', 'cdrKey', 'application/zip'],
    ];
    const data: Record<string, string> = {};
    for (const [url, ext, field, contentType] of files) {
      if (!url) continue;
      if (!this.isAllowedFileUrl(url)) {
        this.logger.warn(`El PSE devolvió un enlace de ${ext} fuera de su propio dominio`);
        continue;
      }
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          // Sin seguir redirecciones: la validación de host no sirve de nada si el
          // destino puede reenviar a otra parte después de pasarla.
          redirect: 'manual',
        });
        if (!res.ok) continue;
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_DOCUMENT_FILE_BYTES) {
          this.logger.warn(`El ${ext} de ${number} supera el tamaño máximo; no se guarda`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_DOCUMENT_FILE_BYTES) {
          this.logger.warn(`El ${ext} de ${number} supera el tamaño máximo; no se guarda`);
          continue;
        }
        const key = `fiscal-documents/${id}/${number}.${ext}`;
        await this.storage.putObject(key, buffer, contentType);
        data[field] = key;
      } catch (err) {
        // Sin la URL en el mensaje: es una URL-capacidad del PSE y los logs de Cloud Run
        // los lee más gente que la que puede ver un comprobante.
        this.logger.warn(
          `No se pudo guardar el ${ext} de ${number}: ${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.fiscalDocument.update({ where: { id }, data });
    }
  }

  /** Host admitido para los archivos, tal como lo declara el proveedor atado. */
  private providerHost(): string | null {
    return this.provider.fileHost;
  }

  /**
   * Solo se descargan archivos de **el mismo host del PSE**, y solo por HTTPS.
   *
   * Los enlaces vienen dentro del cuerpo JSON del proveedor, así que sin esta comprobación
   * un PSE comprometido —o un DNS envenenado— convierte al API en un lector de la red
   * interna cuyo resultado, además, queda descargable desde `GET …/pdf`.
   */
  private isAllowedFileUrl(url: string): boolean {
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') return false;
      const base = this.providerHost();
      return base !== null && target.host === base;
    } catch {
      return false;
    }
  }

  /** Reintento manual del envío (D-073). El job hace lo mismo, sin usuario. */
  async retry(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      select: { id: true, status: true, docType: true },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    if (!RETRYABLE_DOCUMENT_STATUSES.includes(document.status)) {
      throw new BadRequestException(
        `Solo se reintenta un comprobante emitido o con error de envío; este está ${document.status}`,
      );
    }
    await this.assertOwnership(actor, id, 'reintentar su envío');
    await this.audit.log({
      actorId: actor.id,
      action: 'invoicing.document.retry',
      entity: 'fiscal_documents',
      entityId: id,
    });
    await this.deliverAny(id, document.docType);
    return this.findOne(id);
  }

  /**
   * Barrido del job (D-073): reintenta lo que quedó pendiente. Devuelve cuántos tocó.
   *
   * Existe además del reintento con backoff de pg-boss porque el API **escala a cero**
   * (§3.6): una instancia dormida no ejecuta ningún trabajo programado, así que el
   * barrido al arrancar es lo que recupera lo que quedó de la noche anterior. Es la misma
   * lección de D-069.
   */
  async sendPending(limit = 20): Promise<number> {
    // Con la contingencia levantada no se sale a la red (D-073). Sin este corte, el barrido
    // recorría la cola cada quince minutos solo para volver a marcarla con error y para
    // inflar el contador de intentos, que es justo lo que distingue "todavía no salió" de
    // "salió y no entra".
    const settings = await this.settingsRow();
    if (settings.providerOffline) return 0;

    const pending = await this.prisma.fiscalDocument.findMany({
      where: { status: { in: RETRYABLE }, number: { not: null } },
      orderBy: { issuedAt: 'asc' },
      take: limit,
      select: { id: true, docType: true },
    });
    for (const doc of pending) {
      await this.deliverAny(doc.id, doc.docType);
    }
    return pending.length;
  }

  /**
   * Consulta el estado real contra el PSE (D-073). Resuelve dos situaciones distintas: un
   * documento que quedó `PENDING` con ticket, y una baja en trámite.
   */
  async refreshStatus(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: documentInclude,
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    if (document.number === null || !document.seriesRef) {
      throw new BadRequestException('Un borrador no tiene nada que consultar');
    }

    const command = {
      docType: document.docType,
      series: document.seriesRef.series,
      correlative: document.correlative ?? 0,
    };

    // Una baja en trámite se consulta con **su propia** operación (D-072). Preguntar por
    // el comprobante daría siempre "aceptado" —un documento con baja en trámite es, por
    // definición, uno que SUNAT aceptó— y el documento se daría por anulado sin que SUNAT
    // lo anulara: la cuenta por cobrar desaparecía mientras el comprobante seguía vigente.
    if (document.status === FiscalDocumentStatus.VOID_PENDING) {
      const voidResult = await this.provider.queryVoidStatus(command);
      if (voidResult.outcome === 'ACCEPTED') {
        const updated = await this.prisma.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.VOID_PENDING },
          data: {
            status: FiscalDocumentStatus.VOIDED,
            voidedAt: new Date(),
            // `voidedById` **no se toca**: ya guarda al administrador que pidió la baja, y
            // pisarlo con quien apretó "consultar" haría que el registro de quién anuló
            // fuera el de cualquiera que refrescó la pantalla.
            providerResponse: voidResult.raw ?? {},
          },
        });
        if (updated.count === 1) {
          await this.audit.log({
            actorId: actor.id,
            action: 'invoicing.document.void-confirmed',
            entity: 'fiscal_documents',
            entityId: id,
            after: { number: document.number },
          });
        }
      } else if (voidResult.outcome === 'REJECTED') {
        // SUNAT rechazó la baja: el comprobante sigue vivo. Sin esto, `VOID_PENDING` era
        // un estado sin salida —ni se anulaba, ni se podía acreditar, ni se reintentaba—
        // y el documento quedaba vigente para el cliente y bloqueado para el sistema.
        await this.prisma.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.VOID_PENDING },
          data: {
            status: FiscalDocumentStatus.ACCEPTED,
            voidRequestedAt: null,
            rejectionCode: voidResult.code,
            rejectionMessage:
              voidResult.message?.slice(0, 500) ?? 'SUNAT rechazó la comunicación de baja',
            providerResponse: voidResult.raw ?? {},
          },
        });
        await this.audit.log({
          actorId: actor.id,
          action: 'invoicing.document.void-rejected',
          entity: 'fiscal_documents',
          entityId: id,
          after: { number: document.number, message: voidResult.message },
        });
      }
      return this.findOne(id);
    }

    // **Reconciliación de una baja perdida.** Un documento puede estar anulado en el PSE y
    // seguir `ACCEPTED` acá: pasa cuando la comunicación de baja llegó al PSE pero la
    // respuesta no volvió, o volvió como error. Sin esta consulta no había ninguna ruta que
    // lo arreglara —la baja contesta "ya fue anulado" para siempre— y el comprobante
    // quedaba contado como deuda vigente de un cliente que ya no la tiene.
    if (document.status === FiscalDocumentStatus.ACCEPTED) {
      const voidResult = await this.callProvider(() => this.provider.queryVoidStatus(command));
      if (voidResult.outcome === 'ACCEPTED') {
        const updated = await this.prisma.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.ACCEPTED },
          data: {
            status: FiscalDocumentStatus.VOIDED,
            voidedAt: new Date(),
            voidRequestedAt: document.voidRequestedAt ?? new Date(),
            providerResponse: voidResult.raw ?? {},
          },
        });
        if (updated.count === 1) {
          await this.audit.log({
            actorId: actor.id,
            action: 'invoicing.document.void-reconciled',
            entity: 'fiscal_documents',
            entityId: id,
            after: { number: document.number, source: 'consulta al PSE' },
          });
          return this.findOne(id);
        }
      }
    }

    const result = await this.callProvider(() => this.provider.queryStatus(command));
    await this.applyResult(id, result);
    if (result.outcome === 'ACCEPTED') await this.storeFiles(id, document.number, result);
    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // RF-75 — comunicación de baja
  // -------------------------------------------------------------------------

  /**
   * Da de baja un comprobante aceptado (RF-75). **Qué camino corresponde lo decide
   * `voidPathFor` en `@ayr/shared`**, la misma función que la UI usa para explicarlo: si
   * divergieran, el botón diría una cosa y el API haría otra.
   *
   * Dos guardrails, los dos de la lección de M-2:
   * - **con cobros vigentes no se da de baja.** Un comprobante anulado no debe nada, así
   *   que la baja dejaría dinero recibido contra un documento que dejó de existir. Primero
   *   se revierte el cobro.
   * - **con notas de crédito vivas tampoco.** El saldo ya está ajustado por ellas; darlo
   *   de baja encima sería restar dos veces la misma operación.
   */
  async voidDocument(actor: RequestUser, id: string, reason: string): Promise<FiscalDocumentDto> {
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: {
        seriesRef: { select: { series: true } },
        payments: { where: { reversedAt: null }, select: { id: true } },
        creditNotes: {
          where: { status: { in: LIVE_DOCUMENT_STATUSES } },
          select: { number: true },
        },
      },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    if (document.status === FiscalDocumentStatus.VOIDED) {
      throw new ConflictException('El comprobante ya está anulado');
    }
    if (document.status !== FiscalDocumentStatus.ACCEPTED) {
      throw new BadRequestException(
        `Solo se da de baja un comprobante aceptado; este está ${document.status}`,
      );
    }
    if (document.payments.length > 0) {
      throw new BadRequestException(
        'El comprobante tiene cobros vigentes: revierte los cobros antes de darlo de baja',
      );
    }
    if (document.creditNotes.length > 0) {
      throw new BadRequestException(
        `El comprobante ya tiene nota de crédito (${document.creditNotes.map((n) => n.number ?? 'borrador').join(', ')}): su saldo ya está ajustado`,
      );
    }

    const path = voidPathFor(
      document.docType,
      document.issueDate.toISOString().slice(0, 10),
      businessToday(),
    );
    if (path !== 'VOID') {
      throw new BadRequestException(
        path === 'NONE'
          ? `Pasaron más de ${VOID_WINDOW_DAYS} días desde su emisión y una nota de crédito no se acredita con otra: este documento ya no se puede deshacer`
          : document.docType === FiscalDocType.FACTURA
            ? 'Pasó el plazo de la comunicación de baja: emite una nota de crédito'
            : 'Una boleta no se da de baja de forma individual: emite una nota de crédito',
      );
    }

    // El interruptor de contingencia también cubre la baja (D-073): durante una caída
    // conocida del PSE, insistir solo agrega ruido y deja al usuario con un error opaco.
    const settings = await this.settingsRow();
    if (settings.providerOffline) {
      throw new ConflictException(
        'El envío al PSE está en contingencia manual: baja el interruptor antes de comunicar una baja',
      );
    }

    const result = await this.callProvider(() =>
      this.provider.voidDocument({
        docType: document.docType,
        series: document.seriesRef?.series ?? '',
        correlative: document.correlative ?? 0,
        reason,
      }),
    );

    if (result.outcome === 'ERROR') {
      throw new ConflictException(
        `No se pudo comunicar la baja al PSE: ${result.message ?? 'sin detalle'}. El comprobante sigue vigente; vuelve a intentarlo, o usa «Consultar al PSE» si sospechas que la baja sí llegó.`,
      );
    }
    if (result.outcome === 'REJECTED') {
      throw new BadRequestException(`El PSE rechazó la baja: ${result.message ?? 'sin detalle'}`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Los guardrails se revalidan **con la fila bloqueada**: entre la comprobación de
      // arriba y esta escritura pasó una llamada al PSE de hasta un minuto, y en esa
      // ventana alguien pudo registrar un cobro o emitir una nota de crédito.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const livePayments = await tx.customerPayment.count({
        where: { documentId: id, reversedAt: null },
      });
      if (livePayments > 0) {
        throw new ConflictException(
          'Se registró un cobro mientras se comunicaba la baja: revierte el cobro y vuelve a intentarlo',
        );
      }

      const updated = await tx.fiscalDocument.updateMany({
        where: { id, status: FiscalDocumentStatus.ACCEPTED },
        data:
          result.outcome === 'ACCEPTED'
            ? {
                status: FiscalDocumentStatus.VOIDED,
                voidedAt: now,
                voidedById: actor.id,
                voidRequestedAt: now,
                providerTicket: result.ticket,
                providerResponse: (result.raw ?? {}) as Prisma.InputJsonValue,
              }
            : {
                // `PENDING`: hay ticket y SUNAT todavía no confirmó. Marcarlo anulado acá
                // sería declarar por SUNAT algo que SUNAT no dijo.
                status: FiscalDocumentStatus.VOID_PENDING,
                voidRequestedAt: now,
                voidedById: actor.id,
                providerTicket: result.ticket,
                providerResponse: (result.raw ?? {}) as Prisma.InputJsonValue,
              },
      });
      // Sin mirar el `count`, dos bajas simultáneas escribían las dos su auditoría de
      // "baja exitosa" aunque solo una hubiera cambiado algo.
      if (updated.count !== 1) {
        throw new ConflictException('El comprobante cambió de estado mientras se daba de baja');
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.document.void',
        entity: 'fiscal_documents',
        entityId: id,
        before: { status: FiscalDocumentStatus.ACCEPTED, number: document.number },
        after: { outcome: result.outcome, reason },
      });
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // Guía de remisión — la emite `dispatches`, la envía este servicio (D-071)
  // -------------------------------------------------------------------------

  /**
   * Emite la guía de remisión remitente de un despacho (RF-78, D-078).
   *
   * Sigue las **mismas dos fases** que un comprobante (D-073): el correlativo y el estado
   * `ISSUED` se confirman antes de hablar con el PSE, así que la mercadería puede salir
   * con la guía todavía sin aceptar. Es el caso en el que esa decisión más se nota: acá hay
   * un camión esperando.
   *
   * Un despacho puede acumular varias guías si alguna fue rechazada —el rechazado conserva
   * su correlativo (D-072)—, pero **solo una vigente a la vez**.
   */
  async issueDispatchNote(actor: RequestUser, dispatchId: string): Promise<FiscalDocumentDto> {
    const documentId = await this.prisma.$transaction(async (tx) => {
      const dispatch = await tx.dispatch.findUnique({
        where: { id: dispatchId },
        include: {
          salesOrder: { select: { id: true, customerId: true } },
          documents: { select: { id: true, number: true, status: true } },
        },
      });
      if (!dispatch) throw new NotFoundException('Despacho no encontrado');
      if (dispatch.status !== DispatchStatus.ISSUED) {
        throw new BadRequestException('Un despacho revertido no tiene guía que emitir');
      }
      // Una guía **rechazada o dada de baja** no es la guía del traslado: se puede emitir
      // otra. Solo bloquea la que sigue en pie.
      const live = dispatch.documents.find(
        (d) =>
          d.status !== FiscalDocumentStatus.REJECTED && d.status !== FiscalDocumentStatus.VOIDED,
      );
      if (live) {
        throw new ConflictException(`El despacho ya tiene la guía ${live.number ?? 'en borrador'}`);
      }

      const created = await tx.fiscalDocument.create({
        data: {
          docType: FiscalDocType.GUIA_REMISION_REMITENTE,
          status: FiscalDocumentStatus.DRAFT,
          customerId: dispatch.salesOrder.customerId,
          dispatchId: dispatch.id,
          // La guía no cuelga del pedido: el `CHECK` de la migración la ata al despacho, y
          // atarla también al pedido la haría aparecer entre los comprobantes de la venta.
          issueDate: toDateOnly(businessToday()),
          paymentTerms: 'CONTADO',
          subtotalPen: '0',
          igvPen: '0',
          totalPen: '0',
          createdById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.dispatch-note.create',
        entity: 'fiscal_documents',
        entityId: created.id,
        after: { dispatchId },
      });
      return created.id;
    });

    await this.assign(actor, documentId);
    await this.deliverDispatchNote(documentId);
    return this.findOne(documentId);
  }

  /**
   * Segunda fase del envío para una guía. Es gemela de `deliver` y está separada solo
   * porque el payload sale del despacho y no de las líneas del documento: una guía no
   * lleva importes y por eso no tiene filas en `fiscal_document_items`.
   */
  async deliverDispatchNote(id: string): Promise<void> {
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: {
        customer: true,
        seriesRef: { select: { series: true } },
        dispatch: {
          include: {
            items: {
              orderBy: { lineNumber: 'asc' },
              include: { product: { select: { sku: true } } },
            },
            salesOrder: { select: { id: true } },
          },
        },
      },
    });
    if (!document?.dispatch || document.number === null) return;
    if (!RETRYABLE_DOCUMENT_STATUSES.includes(document.status)) return;

    // Mismo orden que `deliver`: la contingencia se mira antes de contar un intento.
    const settings = await this.settingsRow();
    if (settings.providerOffline) {
      await this.applyResult(id, this.offlineResult());
      return;
    }
    if (!(await this.claimAttempt(id))) return;

    const dispatch = document.dispatch;
    // El comprobante que respalda el traslado, si el pedido ya tiene uno aceptado.
    const related = await this.prisma.fiscalDocument.findFirst({
      where: {
        salesOrderId: dispatch.salesOrder.id,
        status: FiscalDocumentStatus.ACCEPTED,
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
      },
      orderBy: { acceptedAt: 'desc' },
      include: { seriesRef: { select: { series: true } } },
    });

    // Igual que `deliver`: la garantía de que un fallo del PSE no se convierte en un error
    // del usuario es de este servicio, no del adaptador (D-073). Acá pesa más que en
    // ningún otro lado, porque del otro lado del envío hay un camión esperando.
    const result = await this.callProvider(() =>
      this.provider.issueDispatchNote({
        series: document.seriesRef?.series ?? '',
        correlative: document.correlative ?? 0,
        issueDate: document.issueDate.toISOString().slice(0, 10),
        transferDate: dispatch.dispatchDate.toISOString().slice(0, 10),
        customer: {
          docType: document.customer.isSystem ? null : document.customer.docType,
          docNumber: document.customer.docNumber,
          name: document.customer.name,
          address: document.customer.address,
          email: document.customer.email,
        },
        originAddress: dispatch.originAddress,
        destinationAddress: dispatch.destinationAddress,
        originUbigeo: dispatch.originUbigeo,
        destinationUbigeo: dispatch.destinationUbigeo,
        transferMode: dispatch.transferMode,
        totalWeightKg: dispatch.totalWeightKg.toFixed(3),
        packageCount: dispatch.packageCount,
        vehicle: dispatch.vehiclePlate ? { plate: dispatch.vehiclePlate } : null,
        driver:
          dispatch.driverGivenNames &&
          dispatch.driverFamilyNames &&
          dispatch.driverDocType &&
          dispatch.driverDocNumber &&
          dispatch.driverLicense
            ? {
                givenNames: dispatch.driverGivenNames,
                familyNames: dispatch.driverFamilyNames,
                docType: dispatch.driverDocType,
                docNumber: dispatch.driverDocNumber,
                license: dispatch.driverLicense,
              }
            : null,
        carrier:
          dispatch.carrierDocNumber && dispatch.carrierName
            ? { docNumber: dispatch.carrierDocNumber, name: dispatch.carrierName }
            : null,
        lines: dispatch.items.map((i) => ({
          code: i.product.sku,
          description: i.description,
          unit: i.unit,
          qty: i.qty.toFixed(3),
        })),
        notes: dispatch.notes,
        relatedDocument: related?.seriesRef
          ? {
              docType: related.docType,
              series: related.seriesRef.series,
              correlative: related.correlative ?? 0,
            }
          : null,
      }),
    );

    await this.applyResult(id, result);
    if (result.outcome === 'ACCEPTED') await this.storeFiles(id, document.number, result);
  }

  /**
   * Envuelve una llamada al puerto para que nunca lance.
   *
   * El contrato dice que un adaptador no lanza, pero apoyar en esa disciplina una garantía
   * de D-073 —"la operación nunca para por el PSE"— es apoyarla en el lugar equivocado:
   * un proveedor nuevo, escrito por otra persona, no tiene por qué recordarla.
   */
  private async callProvider(call: () => Promise<ProviderResult>): Promise<ProviderResult> {
    try {
      return await call();
    } catch (err) {
      this.logger.error('El proveedor de facturación lanzó una excepción', err);
      return {
        outcome: 'ERROR',
        ticket: null,
        sunatHash: null,
        pdfUrl: null,
        xmlUrl: null,
        cdrUrl: null,
        code: 'PROVIDER_THREW',
        message: 'No se pudo completar el envío al PSE',
        raw: { error: err instanceof Error ? err.name : 'error' },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /**
   * Lo que a cada línea de un pedido le queda **por despachar** y **por facturar** (D-074).
   *
   * Un solo endpoint para los dos formularios a propósito: el de comprobante y el de
   * despacho preguntan lo mismo sobre el mismo pedido, y tener dos cálculos habría abierto
   * la puerta a que uno ofrezca lo que el otro ya consumió.
   *
   * Las dos cantidades se cuentan **desde las filas** (`dispatch_items`,
   * `fiscal_document_items`) y no desde contadores guardados: un contador se desincroniza
   * con la primera reversa que alguien olvide restar, y acá hay reversas de las dos cosas.
   */
  async orderProgress(
    salesOrderId: string,
    options: { withPrices: boolean } = { withPrices: true },
  ): Promise<SalesOrderProgressDto> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        customer: { select: { name: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          include: { product: { select: { sku: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');

    const itemIds = order.items.map((i) => i.id);

    // Solo los despachos vigentes: uno revertido devolvió el stock y no consumió pedido.
    const dispatched = await this.prisma.dispatchItem.groupBy({
      by: ['salesOrderItemId'],
      where: { salesOrderItemId: { in: itemIds }, dispatch: { status: DispatchStatus.ISSUED } },
      _sum: { qty: true },
    });
    const dispatchedByItem = new Map(
      dispatched.map((r) => [
        r.salesOrderItemId,
        toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString()),
      ]),
    );

    // Solo los comprobantes vivos y **sin contar notas de crédito**: una NC no descuenta
    // pedido, ajusta el saldo del comprobante que afecta (D-075).
    const invoiced = await this.prisma.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: itemIds },
        document: {
          status: { in: LIVE_DOCUMENT_STATUSES },
          docType: { not: FiscalDocType.NOTA_CREDITO },
        },
      },
      _sum: { qty: true },
    });
    const invoicedByItem = new Map(
      invoiced.flatMap((r) =>
        r.salesOrderItemId === null
          ? []
          : [
              [r.salesOrderItemId, toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString())] as [
                string,
                Decimal,
              ],
            ],
      ),
    );

    const labels = await this.itemLabels(order.items);

    return {
      salesOrderId: order.id,
      salesOrderCode: salesOrderCode(order.seq),
      status: order.status,
      customerId: order.customerId,
      customerName: order.customer.name,
      lines: order.items.map((item) => {
        const qty = toDecimal(item.qty.toString());
        const dispatchedQty = dispatchedByItem.get(item.id) ?? new Decimal(0);
        const invoicedQty = invoicedByItem.get(item.id) ?? new Decimal(0);
        return {
          salesOrderItemId: item.id,
          lineNumber: item.lineNumber,
          productId: item.productId,
          productSku: item.product.sku,
          description: item.description,
          qty: qty.toFixed(3),
          unit: item.unit,
          // §3.4: el supervisor de planta no tiene alcance comercial. Necesita saber
          // cuánto puede sacar, no a cuánto se vendió.
          unitPricePen: options.withPrices ? item.unitPricePen.toFixed(4) : '0.0000',
          dispatchedQty: dispatchedQty.toFixed(3),
          pendingDispatchQty: pendingQty(qty, dispatchedQty).toFixed(3),
          invoicedQty: invoicedQty.toFixed(3),
          pendingInvoiceQty: pendingQty(qty, invoicedQty).toFixed(3),
          itemType: item.reserveItemType,
          itemId: item.reserveItemId,
          itemLabel: labels.get(`${item.reserveItemType}:${item.reserveItemId}`) ?? '—',
          reserveQty: item.reserveQty.toFixed(3),
          reserveUnit: item.reserveUnit,
        };
      }),
    };
  }

  /**
   * Etiqueta legible del ítem que respalda cada línea: SKU del producto o código de la
   * bobina. Dos consultas para toda la lista, no una por línea.
   */
  private async itemLabels(
    items: { reserveItemType: InventoryItemType; reserveItemId: string }[],
  ): Promise<Map<string, string>> {
    const productIds = items
      .filter((i) => i.reserveItemType === 'PRODUCT')
      .map((i) => i.reserveItemId);
    const coilIds = items.filter((i) => i.reserveItemType === 'COIL').map((i) => i.reserveItemId);
    const [products, coils] = await Promise.all([
      productIds.length > 0
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true },
          })
        : Promise.resolve([]),
      coilIds.length > 0
        ? this.prisma.coil.findMany({
            where: { id: { in: coilIds } },
            select: { id: true, code: true },
          })
        : Promise.resolve([]),
    ]);
    const out = new Map<string, string>();
    for (const p of products) out.set(`PRODUCT:${p.id}`, p.sku);
    for (const c of coils) out.set(`COIL:${c.id}`, c.code);
    return out;
  }

  async findAll(query: FiscalDocumentQuery): Promise<FiscalDocumentListItemDto[]> {
    const where: Prisma.FiscalDocumentWhereInput = {
      status: query.status,
      docType: query.docType,
      customerId: query.customerId,
      salesOrderId: query.salesOrderId,
    };
    if (query.pendingOnly) {
      // El saldo es derivado (D-075) y no se puede sumar en SQL sin duplicar la regla que
      // vive en `@ayr/shared`. Lo que **sí** se puede acotar en SQL es qué documentos son
      // capaces de tener saldo: sin esto, el tope de 300 filas se llenaba de borradores y
      // notas de crédito y las cuentas por cobrar dejaban de ver deudas reales.
      where.status = { in: LIVE_DOCUMENT_STATUSES };
      where.docType = { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] };
    }
    if (query.search) {
      where.OR = [
        { number: { contains: query.search, mode: 'insensitive' } },
        { customer: { name: { contains: query.search, mode: 'insensitive' } } },
        { customer: { docNumber: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    const rows = await this.prisma.fiscalDocument.findMany({
      where,
      include: documentInclude,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const settings = await this.settingsRow();
    const actors = await this.resolveActorNames(rows.flatMap((r) => this.actorIdsOf(r)));
    const credited = await this.creditedQtyByItem(rows.flatMap((r) => r.items.map((i) => i.id)));
    const dtos = rows.map((row) => {
      const dto = this.toDto(row, settings.alertAfterHours, actors, credited);
      // El listado no lleva líneas, cobros ni notas: la lista muestra totales y estado, y
      // arrastrarlos multiplicaría por diez el tamaño de la respuesta.
      const { items, payments: _payments, creditNotes: _creditNotes, ...rest } = dto;
      return { ...rest, itemCount: items.length };
    });
    // El filtro de saldo va acá y no en SQL porque el saldo es derivado (D-075): sumarlo
    // en la consulta obligaría a duplicar en SQL la regla que ya vive en `@ayr/shared`.
    return query.pendingOnly ? dtos.filter((d) => toDecimal(d.balancePen).gt(0)) : dtos;
  }

  async findOne(id: string): Promise<FiscalDocumentDto> {
    const row = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: documentInclude,
    });
    if (!row) throw new NotFoundException('Comprobante no encontrado');
    const settings = await this.settingsRow();
    const actors = await this.resolveActorNames(this.actorIdsOf(row));
    const credited = await this.creditedQtyByItem(row.items.map((i) => i.id));
    return this.toDto(row, settings.alertAfterHours, actors, credited);
  }

  /**
   * Cantidad ya acreditada de cada línea, contando solo notas de crédito vivas.
   *
   * Se calcula desde las filas y no desde un contador guardado: un contador se
   * desincroniza con la primera baja de nota que alguien olvide restar.
   */
  private async creditedQtyByItem(itemIds: string[]): Promise<Map<string, Decimal>> {
    if (itemIds.length === 0) return new Map();
    const rows = await this.prisma.fiscalDocumentItem.groupBy({
      by: ['affectedItemId'],
      where: {
        affectedItemId: { in: itemIds },
        document: { status: { in: LIVE_DOCUMENT_STATUSES } },
      },
      _sum: { qty: true },
    });
    return new Map(
      rows.flatMap((r) =>
        r.affectedItemId === null
          ? []
          : [
              [r.affectedItemId, toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString())] as [
                string,
                Decimal,
              ],
            ],
      ),
    );
  }

  /** Cuántos documentos pasaron el umbral sin aceptación (D-073): el aviso del menú. */
  async stalledCount(): Promise<{ stalled: number; pending: number }> {
    const settings = await this.settingsRow();
    const threshold = new Date(Date.now() - settings.alertAfterHours * 3_600_000);
    const [pending, stalled] = await Promise.all([
      this.prisma.fiscalDocument.count({
        where: { status: { in: RETRYABLE }, number: { not: null } },
      }),
      this.prisma.fiscalDocument.count({
        where: {
          status: { in: RETRYABLE },
          number: { not: null },
          issuedAt: { lt: threshold },
        },
      }),
    ]);
    return { pending, stalled };
  }

  /** Descarga un archivo del comprobante desde R2. */
  async file(
    id: string,
    kind: 'pdf' | 'xml' | 'cdr',
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const row = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      select: { number: true, pdfKey: true, xmlKey: true, cdrKey: true },
    });
    if (!row) throw new NotFoundException('Comprobante no encontrado');
    const key = kind === 'pdf' ? row.pdfKey : kind === 'xml' ? row.xmlKey : row.cdrKey;
    if (!key) {
      throw new NotFoundException(
        'El comprobante todavía no tiene ese archivo: se guarda cuando SUNAT lo acepta',
      );
    }
    const buffer = await this.storage.getObject(key);
    const contentType =
      kind === 'pdf' ? 'application/pdf' : kind === 'xml' ? 'application/xml' : 'application/zip';
    return {
      buffer,
      filename: `${row.number ?? id}.${kind === 'cdr' ? 'zip' : kind}`,
      contentType,
    };
  }

  /** Nombres de usuario por id, igual que `QuotationsService`: una consulta por lista. */
  private async resolveActorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Todos los ids de usuario que un documento necesita resolver para su DTO. */
  private actorIdsOf(row: DocumentRow): (string | null)[] {
    return [
      row.createdById,
      row.genericCustomerOverrideById,
      ...row.payments.flatMap((p) => [p.createdById, p.reversedById]),
    ];
  }

  private toDto(
    row: DocumentRow,
    alertAfterHours: number,
    actors: Map<string, string>,
    creditedByItem: Map<string, Decimal>,
  ): FiscalDocumentDto {
    const paid = row.payments
      .filter((p) => p.reversedAt === null)
      .reduce((acc, p) => acc.plus(toDecimal(p.amountPen.toString())), new Decimal(0));
    const credited = row.creditNotes
      .filter((n) => LIVE_DOCUMENT_STATUSES.includes(n.status))
      .reduce((acc, n) => acc.plus(toDecimal(n.totalPen.toString())), new Decimal(0));
    const balance = documentBalance({
      status: row.status,
      totalPen: row.totalPen.toString(),
      paidPen: paid,
      creditedPen: credited,
    });
    const dueDate = row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null;
    const issueDate = row.issueDate.toISOString().slice(0, 10);

    return {
      id: row.id,
      docType: row.docType,
      status: row.status,
      number: row.number,
      series: row.seriesRef?.series ?? null,
      correlative: row.correlative,
      customerId: row.customerId,
      customerName: row.customer.name,
      customerDocType: row.customer.docType,
      customerDocNumber: row.customer.docNumber,
      customerIsGeneric: row.customer.isSystem,
      salesOrderId: row.salesOrderId,
      salesOrderCode: row.salesOrder ? salesOrderCode(row.salesOrder.seq) : null,
      dispatchId: row.dispatchId,
      dispatchCode: row.dispatch ? toDispatchCode(row.dispatch.seq) : null,
      affectedDocumentId: row.affectedDocumentId,
      affectedDocumentNumber: row.affectedDocument?.number ?? null,
      creditNoteReason: row.creditNoteReason,
      replacesDocumentId: row.replacesDocumentId,
      replacesDocumentNumber: row.replacesDocument?.number ?? null,
      replacedByDocumentId: row.replacedBy?.id ?? null,
      replacedByDocumentNumber: row.replacedBy?.number ?? null,
      issueDate,
      paymentTerms: row.paymentTerms,
      dueDate,
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
      paidPen: paid.toFixed(4),
      creditedPen: credited.toFixed(4),
      balancePen: balance,
      isOverdue: dueDate !== null && dueDate < businessToday() && toDecimal(balance).gt(0),
      detractionCode: row.detractionCode,
      detractionPct: row.detractionPct ? row.detractionPct.toFixed(2) : null,
      detractionAmountPen: row.detractionAmountPen ? row.detractionAmountPen.toFixed(4) : null,
      genericCustomerOverrideByName: row.genericCustomerOverrideById
        ? (actors.get(row.genericCustomerOverrideById) ?? null)
        : null,
      notes: row.notes,
      sunatHash: row.sunatHash,
      rejectionCode: row.rejectionCode,
      rejectionMessage: row.rejectionMessage,
      hasPdf: row.pdfKey !== null,
      hasXml: row.xmlKey !== null,
      hasCdr: row.cdrKey !== null,
      sendAttempts: row.sendAttempts,
      lastSendError: row.lastSendError,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      isStalled:
        RETRYABLE_DOCUMENT_STATUSES.includes(row.status) &&
        isStalled(row.issuedAt, alertAfterHours),
      voidPath:
        row.status === FiscalDocumentStatus.ACCEPTED
          ? voidPathFor(row.docType, issueDate, businessToday())
          : null,
      createdByName: actors.get(row.createdById) ?? null,
      createdAt: row.createdAt.toISOString(),
      issuedAt: row.issuedAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      items: row.items.map((i) => ({
        id: i.id,
        lineNumber: i.lineNumber,
        productId: i.productId,
        productSku: i.product?.sku ?? null,
        description: i.description,
        qty: i.qty.toFixed(3),
        unit: i.unit,
        unitPricePen: i.unitPricePen.toFixed(4),
        subtotalPen: i.subtotalPen.toFixed(4),
        igvPen: i.igvPen.toFixed(4),
        totalPen: i.totalPen.toFixed(4),
        salesOrderItemId: i.salesOrderItemId,
        affectedItemId: i.affectedItemId,
        creditedQty: (creditedByItem.get(i.id) ?? new Decimal(0)).toFixed(3),
      })),
      payments: row.payments.map((p) => ({
        id: p.id,
        date: p.date.toISOString().slice(0, 10),
        amountPen: p.amountPen.toFixed(4),
        method: p.method,
        reference: p.reference,
        createdByName: actors.get(p.createdById) ?? null,
        createdAt: p.createdAt.toISOString(),
        reversedAt: p.reversedAt?.toISOString() ?? null,
        reversedByName: p.reversedById ? (actors.get(p.reversedById) ?? null) : null,
      })),
      creditNotes: row.creditNotes.map((n) => ({
        id: n.id,
        number: n.number,
        status: n.status,
        issueDate: n.issueDate.toISOString().slice(0, 10),
        totalPen: n.totalPen.toFixed(4),
      })),
    };
  }
}
