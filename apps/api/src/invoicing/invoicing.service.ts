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
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  type InventoryItemType,
} from '@prisma/client';
import {
  businessToday,
  shiftDate,
  Decimal,
  DERIVED_FILTER_FETCH_CAP,
  documentBalance,
  fiscalDocumentNumber,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  hasCollectibleBalance,
  GRE_TRANSFER_MODES,
  TransferMode,
  IGV_RATE_PCT,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  paginate,
  STANDING_DOCUMENT_STATUSES,
  RETRYABLE_DOCUMENT_STATUSES,
  Role,
  salesOrderCode,
  salesTotals,
  serializeSalesTotals,
  sumLineTotals,
  theoreticalKgPerSellingUnit,
  toDecimal,
  toFixedString,
  VOID_WINDOW_DAYS,
  voidPathFor,
  dispatchCode as toDispatchCode,
  type CreateCreditNoteInput,
  type CreateInvoiceInput,
  type RegisterManualInput,
  type UpdateManualIssueDateInput,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type FiscalDocumentExportQuery,
  type FiscalDocumentQuery,
  type PaginatedResult,
  type CreateFiscalSeriesInput,
  type FiscalSeriesDto,
  type InvoicingSettingsDto,
  type SalesOrderProgressDto,
  type UpdateInvoicingSettingsInput,
  fromDateOnly,
  isReturnCreditNoteReason,
  salesReturnCode,
  CREDIT_NOTE_REASON_SUNAT_CODE,
  CreditNoteReason,
  creditNoteDeadlineWarning,
  creditsQty,
  DISCOUNT_CREDIT_NOTE_REASONS,
  effectiveDueDate,
  isZeroAmountCreditNote,
  returnsStock,
  type CreditNotePreviewDto,
  type CreditNoteReplacementInput,
  type RegisterCreditNoteInput,
  type SalesLineTotals,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { fiscalDocumentListWhere } from './fiscal-document-where';
import { assertSellerAccess } from '../auth/seller-scope';
import {
  assertAffectedStillCreditable,
  draftCreditNoteBlock,
  VOID_AUDIT,
  VOID_IN_FLIGHT_MESSAGE,
  VOID_IN_FLIGHT_MS,
  VOID_IN_PROGRESS,
} from './credit-note-guards';
import { claimIdempotencyKey } from '../common/idempotency';
import { OperationDateService } from '../common/operation-date.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { rawMaterialSpecLabels } from '../sales/raw-material';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceDispatchService } from './invoice-dispatch.service';
import { SalesReturnsService } from './sales-returns.service';
import {
  dueDateFor,
  exceedsOrderTotal,
  isStalled,
  pendingQty,
  PartLedger,
  partKind,
  pendingWithDrafts,
} from './invoicing-math';
import { invoicedByOrderItem, withReturnedQty } from './invoicing-net';
import { dispatchLinksByDocument } from './document-dispatches';
import {
  ELECTRONIC_INVOICING_PROVIDER,
  type ElectronicInvoicingProvider,
  type IssueDocumentCommand,
  type PartyRef,
  type ProviderResult,
} from './ports/electronic-invoicing.port';
import { fiscalDocumentOrderBy } from '../common/list-orderings';
import {
  assertDerivedUniverseComplete,
  assertExportable,
  exportWindow,
  pageWindow,
  type ListWindow,
} from '../common/list-export';
import { lockDocuments } from '../inventory/document-locks';
import { KARDEX_TX_OPTIONS } from '../common/transaction-options';
import {
  amountCreditLines,
  creditsByLine,
  priceCreditLines,
  qtyCreditLines,
  zeroCreditLines,
  type AffectedLine,
  type NoteLine,
} from './credit-note-lines';

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
  salesOrder: { select: { id: true, seq: true, sellerId: true, status: true } },
  dispatch: { select: { id: true, seq: true, salesOrder: { select: { sellerId: true } } } },
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
  supersededBy: { select: { id: true } },
  items: { orderBy: { lineNumber: 'asc' }, include: { product: { select: { sku: true } } } },
  payments: { orderBy: { createdAt: 'asc' } },
  creditNotes: {
    // RF-72: una versión archivada dejó de ser el documento, así que tampoco acredita nada.
    where: { archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      number: true,
      status: true,
      issueDate: true,
      totalPen: true,
      // cc54 (D-657): el motivo y el vencimiento que declara un 13 (`effectiveDueDate`).
      creditNoteReason: true,
      dueDate: true,
      createdAt: true,
      // cc52 (D-646): la devolución de cada NC de devolución, para enlazarla.
      salesReturn: { select: { id: true, seq: true, status: true } },
    },
  },
} satisfies Prisma.FiscalDocumentInclude;

/**
 * F8-S7/M1: el historial de correcciones de fecha, **solo para el detalle**.
 *
 * Aparte de `documentInclude` a propósito: el listado descarta este campo (`toListDtos`), así
 * que traerlo ahí sería un join por página —y con `pendingOnly`, por `DERIVED_FILTER_FETCH_CAP`
 * filas— para tirarlo a la basura. Más reciente primero, que es como se lee un historial.
 */
const documentDetailInclude = {
  ...documentInclude,
  // cc54 (D-654): en el detalle, las líneas de cada NC, para mostrar la descripción corregida por
  // un 03 en la línea que corrige.
  creditNotes: {
    ...documentInclude.creditNotes,
    select: {
      ...documentInclude.creditNotes.select,
      items: { select: { affectedItemId: true, description: true } },
    },
  },
  issueDateChanges: { orderBy: { changedAt: 'desc' } },
  // cc52 (D-646): la devolución que generó esta NC, si es de devolución.
  salesReturn: { select: { id: true, seq: true, status: true } },
} satisfies Prisma.FiscalDocumentInclude;

type DocumentRow = Prisma.FiscalDocumentGetPayload<{ include: typeof documentInclude }>;

/** cc54: el comprobante que una NC acredita, con lo que el motivo necesita mirar. */
const CREDIT_NOTE_AFFECTED_INCLUDE = {
  items: { orderBy: { lineNumber: 'asc' } },
  customer: true,
  salesOrder: { select: { sellerId: true, status: true, seq: true } },
  dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
  payments: { where: { reversedAt: null }, select: { amountPen: true } },
  creditNotes: {
    where: { status: { in: [...SHARED_LIVE_DOCUMENT_STATUSES] }, archivedAt: null },
    select: {
      number: true,
      status: true,
      totalPen: true,
      creditNoteReason: true,
      dueDate: true,
      issueDate: true,
      createdAt: true,
    },
  },
} satisfies Prisma.FiscalDocumentInclude;

/** cc54: lo que una NC va a ser, antes de escribirla (`planCreditNote`). */
interface CreditNotePlan {
  affected: Prisma.FiscalDocumentGetPayload<{ include: typeof CREDIT_NOTE_AFFECTED_INCLUDE }>;
  lines: NoteLine[];
  totals: SalesLineTotals;
  /** El vencimiento vigente del afectado (D-657). */
  dueDate: string | null;
  replacement: {
    customerId: string;
    customerName: string;
    number: string;
    series: string;
    correlative: number;
    issueDate: string;
  } | null;
}

/** cc54 (D-655): lo que el reemplazo de un 02 mira del comprobante anulado. */
interface ReplacementSubject {
  id: string;
  number: string | null;
  docType: FiscalDocType;
  customerId: string;
  salesOrderId: string | null;
  issueDate: Date;
  payments: { amountPen: Prisma.Decimal }[];
  creditNotes: { number: string | null }[];
  salesOrder: { status: string; seq: number } | null;
}
/** Lo mismo más el historial de correcciones de fecha (F8-S7/M1), solo en el detalle. */
type DocumentDetailRow = Prisma.FiscalDocumentGetPayload<{
  include: typeof documentDetailInclude;
}>;

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
const LIVE_DOCUMENT_STATUSES: FiscalDocumentStatus[] = [...SHARED_LIVE_DOCUMENT_STATUSES];

/**
 * D-105: un comprobante **importado** no tiene contraparte del otro lado.
 *
 * Entró ya emitido por planilla (RF-71), así que el PSE no lo conoce como nuestro: pedirle
 * su baja, mandarle una nota de crédito contra él o preguntarle su estado son tres formas
 * de hablar de un documento que, para el proveedor, no existe. Lo que sí se puede hacer
 * con él es lo que no toca al PSE: cobrarlo, verlo y reimportarlo.
 *
 * Los estados hacen la mitad del trabajo —un importado nace `ACCEPTED`, así que ni `send`
 * ni `retry` ni `correct` lo alcanzan—, pero la baja y la nota de crédito **sí** exigen
 * exactamente ese estado. Este corte es el que las frena.
 */
function assertIssuedHere(
  document: { origin: FiscalDocumentOrigin; number: string | null },
  action: string,
): void {
  // **La pregunta es la que dice el nombre**, y desde D-153 no es la misma que "¿no es
  // importado?": hay dos orígenes que el ERP no emitió electrónicamente y los dos tienen que
  // caer acá. Con la forma vieja (`!== IMPORTED`), un comprobante manual se habría podido
  // mandar a Nubefact — el papel ya existe, así que serían dos comprobantes para una venta.
  if (document.origin === FiscalDocumentOrigin.ISSUED_HERE) return;
  throw new BadRequestException(
    document.origin === FiscalDocumentOrigin.MANUAL
      ? `El comprobante ${document.number ?? ''} se registró como manual: ${action} se hace donde se emitió, y el resultado se registra acá`
      : `El comprobante ${document.number ?? ''} se importó ya emitido: ${action} se hace donde se emitió`,
  );
}

/** `FFA1-1349` → `FFA1`. Null cuando el documento todavía no tiene número (borrador). */
function seriesOf(number: string | null): string | null {
  if (number === null) return null;
  const [series] = number.split('-');
  return series ?? null;
}

@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(ELECTRONIC_INVOICING_PROVIDER)
    private readonly provider: ElectronicInvoicingProvider,
    private readonly operationDate: OperationDateService,
    // F8-S7/M3: para escribir `dispatches.invoice_id` por el mismo camino que el mostrador
    // (D-205). El módulo ya importaba `InventoryModule` porque el despacho mueve kardex.
    private readonly inventory: InventoryService,
    // D-216/M0d: `PSE_ENABLED`. `ConfigModule` es `@Global()`, así que no hace falta tocar
    // los imports del módulo.
    @Inject(ENV) private readonly env: Env,
    // D-288: re-fechar el despacho «a la fecha del comprobante» al corregir la emisión.
    private readonly invoiceDispatch: InvoiceDispatchService,
    // cc52 (D-646): la devolución de mercadería de una NC de devolución.
    private readonly salesReturns: SalesReturnsService,
  ) {}

  /**
   * El gate explícito de D-216: sin `PSE_ENABLED`, cualquier camino que hablaría con el PSE
   * rechaza acá, **antes** de tomar correlativo o de llamar al proveedor. No reemplaza a
   * `NullInvoicingProvider` (D-071/D-073, la contingencia de una caída real): la diferencia
   * es que esto es a propósito y lo dice, en vez de terminar en `SEND_ERROR` tras gastar un
   * número.
   */
  private assertPseEnabled(): void {
    if (!this.env.PSE_ENABLED) {
      throw new BadRequestException('Emisión electrónica no habilitada en este entorno');
    }
  }

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
    manualByDefault: boolean;
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
      manualByDefault: row.manualByDefault,
      alertAfterHours: row.alertAfterHours,
      providerConfigured: this.provider.configured,
      providerName: this.provider.name,
      pseEnabled: this.env.PSE_ENABLED,
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
          manualByDefault: input.manualByDefault ?? row.manualByDefault,
          alertAfterHours: input.alertAfterHours ?? row.alertAfterHours,
          updatedById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.settings.update',
        entity: 'invoicing_settings',
        entityId: row.id,
        before: {
          providerOffline: row.providerOffline,
          manualByDefault: row.manualByDefault,
          alertAfterHours: row.alertAfterHours,
        },
        after: {
          providerOffline: input.providerOffline ?? row.providerOffline,
          manualByDefault: input.manualByDefault ?? row.manualByDefault,
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
    const id = await this.prisma.$transaction((tx) => this.createInTx(tx, actor, input), {
      timeout: 30_000,
    });
    return this.findOne(id, actor);
  }

  /**
   * El cuerpo de `create`, **dentro de una transacción que abre el llamador**.
   *
   * Lo usa el mostrador (RF-60, D-099): un borrador que se confirme por su cuenta y una
   * asignación de correlativo que falle después dejarían un comprobante huérfano por cada
   * venta que no cerró.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: CreateInvoiceInput,
  ): Promise<string> {
    // D-133: la ventana de SUNAT la valida el schema (D-072); acá se decide **quién** la
    // puede usar. Un VENDEDOR emite con fecha de hoy y nada más.
    this.operationDate.assertIssueDate(actor, input.issueDate);

    // HOTFIX-401/M2: un doble click o un reintento de red no debe crear un segundo borrador
    // — mismo criterio que ya usa un cobro (D-182). Sin `idempotencyKey` (el mostrador, que
    // abre su propia transacción y llama esto directo) siempre `claimed: true`: el guardrail
    // es opt-in, no un requisito nuevo para quien no lo pide.
    const claim = await claimIdempotencyKey(tx, 'invoice-create', input.idempotencyKey);
    if (!claim.claimed) return claim.resourceId;

    // D-187: el comprobante es el corte de la edición del pedido confirmado (precio, cliente,
    // ítems, cantidades), y esas ediciones toman el lock del pedido. Tomarlo acá **antes** de
    // leer cliente y líneas serializa las dos cosas: sin él, un borrador creado mientras el
    // administrador cambiaba un precio copiaba el precio viejo y el registro decía otro.
    // HOTFIX-401/M2: la misma fila trae `total_pen`, que hace falta más abajo para el tope
    // de cuánto de este pedido ya está facturado o en borrador.
    // cc30 (D-471, cruce C8): el despacho declarado y el pedido, juntos y en ese orden —despacho →
    // pedido, como la reversa y el re-fechado—. Antes se tomaba el pedido y después el despacho, y
    // revertir ese despacho a la vez se cruzaba.
    let orderTotalPen: string | null = null;
    await lockDocuments(tx, {
      dispatches: [input.dispatchId],
      salesOrders: [input.salesOrderId],
    });
    if (input.salesOrderId) {
      const locked = await tx.salesOrder.findUnique({
        where: { id: input.salesOrderId },
        select: { totalPen: true, sellerId: true, status: true, seq: true, customerId: true },
      });
      if (!locked) throw new NotFoundException('Pedido no encontrado');
      // cc33 N2: el alcance del vendedor se mira **antes de escribir**, con la fila ya bloqueada.
      // Antes se miraba después, en `findOne`: el vendedor de otro pedido recibía 404, pero el
      // borrador, el enlace del despacho y la clave de idempotencia ya estaban confirmados, y ese
      // borrador ajeno bloqueaba facturar, editar y anular el pedido.
      assertSellerAccess(actor, locked.sellerId, 'Pedido');
      // cc33 N4: estado y cliente se validan en la cabecera. `resolveLines` lo hacía solo por
      // línea de pedido, así que un comprobante de líneas libres pasaba sobre un pedido anulado
      // o de otro cliente.
      if (locked.status === 'CANCELLED') {
        throw new BadRequestException(
          `El pedido ${salesOrderCode(locked.seq)} está anulado: no se puede facturar`,
        );
      }
      if (locked.customerId !== input.customerId) {
        throw new BadRequestException('El comprobante y el pedido son de clientes distintos');
      }
      orderTotalPen = locked.totalPen.toString();
    }

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

    // F8-S7/M3 (D-205): el despacho que este comprobante cubre, **declarado**. Se valida que
    // exista, que sea del mismo pedido y que no esté ya facturado; nada se infiere. Sin esta
    // comprobación, `dispatch_id` podía apuntar al despacho de otro cliente por un uuid mal
    // copiado, y el enlace que D-205 creó para auditar habría pasado a mentir.
    if (input.dispatchId) {
      // **El lock va antes de leer `invoice_id`**, igual que `issueDispatchNote` sobre esta
      // misma tabla. Sin él, dos emisiones concurrentes sobre el mismo despacho leen las dos
      // un `invoice_id` nulo y las dos pasan: `linkInvoiceToDispatch` es idempotente
      // (`WHERE invoice_id IS NULL`), así que la que pierde no escribe **y no se entera**, y
      // el despacho queda declarando cubrir un comprobante que no es el que lo declaró. cc30: ya
      // viene tomado de arriba, antes que el pedido.
      const dispatch = await tx.dispatch.findUnique({
        where: { id: input.dispatchId },
        select: {
          id: true,
          salesOrderId: true,
          status: true,
          invoice: { select: { id: true, number: true, status: true } },
        },
      });
      if (!dispatch) throw new NotFoundException('El despacho no existe');
      // **Solo un comprobante vivo ocupa el despacho.** Con `invoice_id !== null` a secas, un
      // borrador descartado, un rechazado o un anulado lo dejaban ocupado para siempre: el
      // enlace se toma al crear el borrador, que es antes de saber si ese comprobante va a
      // existir de verdad. Misma lista blanca que usan la baja y la anulación.
      if (dispatch.invoice && LIVE_DOCUMENT_STATUSES.includes(dispatch.invoice.status)) {
        throw new ConflictException(
          `Ese despacho ya está enlazado al comprobante ${dispatch.invoice.number ?? 'en borrador'}`,
        );
      }
      if (!input.salesOrderId || dispatch.salesOrderId !== input.salesOrderId) {
        throw new BadRequestException('El despacho no pertenece al pedido que se está facturando');
      }
      // Un despacho revertido devolvió su mercadería al stock (RF-71): no hay nada que
      // facturar, y enlazarlo sería declarar una salida que el kardex ya deshizo.
      if (dispatch.status === DispatchStatus.REVERSED) {
        throw new BadRequestException('Un despacho revertido no se factura');
      }
    }

    const lines = await this.resolveLines(tx, input);
    // D-169: **la cabecera suma sus propias líneas.** Recalcularla desde `cantidad × unitario`
    // deshacía, un renglón más abajo, lo que `resolveLines` acababa de hacer: la línea que
    // factura un pedido entero **copia** el importe del papel, y el total volvía a derivarse
    // del unitario redondeado. La cuenta por cobrar sale de `totalPen`, así que el saldo
    // quedaba unos céntimos por debajo del comprobante y cobrar el importe real se rechazaba
    // por exceso — exactamente el daño que D-169 vino a cerrar, sobrevivido una pantalla más
    // adelante. Pasaba desapercibido porque el total recalculado se ve «más limpio» que el
    // correcto.
    const totals = sumLineTotals(lines);
    const serialized = serializeSalesTotals(totals);

    // HOTFIX-401/M2: la suma de lo ya facturado o en borrador de este pedido, más este
    // comprobante, no puede pasar el total del pedido. Sin este tope, cada click de
    // "Facturar" que no declaraba un despacho creaba un borrador nuevo por el total
    // completo — nada impedía tres borradores del mismo pedido a la vez.
    // D-223: las notas de crédito vivas del pedido restan (`exceedsOrderTotal`); lo que una
    // nota devolvió se puede volver a facturar.
    if (input.salesOrderId && orderTotalPen !== null) {
      const [existing, creditNotes] = await Promise.all([
        tx.fiscalDocument.aggregate({
          where: {
            salesOrderId: input.salesOrderId,
            status: { in: [...STANDING_DOCUMENT_STATUSES] },
            docType: { not: FiscalDocType.NOTA_CREDITO },
            archivedAt: null,
          },
          _sum: { totalPen: true },
          _count: { _all: true },
        }),
        tx.fiscalDocument.aggregate({
          where: {
            salesOrderId: input.salesOrderId,
            status: { in: LIVE_DOCUMENT_STATUSES },
            docType: FiscalDocType.NOTA_CREDITO,
            archivedAt: null,
          },
          _sum: { totalPen: true },
          _count: { _all: true },
        }),
      ]);
      const orderTotal = toDecimal(orderTotalPen);
      const cap = exceedsOrderTotal({
        orderTotal,
        committed: (existing._sum?.totalPen ?? new Prisma.Decimal(0)).toString(),
        credited: (creditNotes._sum?.totalPen ?? new Prisma.Decimal(0)).toString(),
        newTotal: totals.total,
        // D-377: cada documento —comprobante o nota— redondea su total al céntimo por su cuenta.
        committedCount: existing._count._all + creditNotes._count._all,
      });
      if (cap.exceeds) {
        throw new BadRequestException(
          `Este pedido ya tiene S/ ${cap.net.toFixed(2)} entre comprobantes emitidos y borradores (descontadas las notas de crédito), de un total de S/ ${orderTotal.toFixed(2)}: este comprobante de S/ ${totals.total.toFixed(2)} lo pasaría. Descarta algún borrador sobrante antes de crear otro.`,
        );
      }
    }

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
        id: claim.resourceId,
        docType: input.docType,
        status: FiscalDocumentStatus.DRAFT,
        customerId: customer.id,
        salesOrderId: input.salesOrderId ?? null,
        // **`dispatchId` NO se escribe acá, y no es un olvido.** En `fiscal_documents` esa
        // columna significa «esta **guía de remisión** es del despacho X», y el CHECK
        // `fiscal_documents_shape_ck` (Fase 5b) la exige nula en todo lo que no sea una GRE.
        // Además es la que define `Dispatch.documents`: una factura ahí se haría pasar por la
        // guía vigente del despacho y apagaría el botón de emitirla. El enlace de D-205 vive
        // en `dispatches.invoice_id`, que es una pregunta distinta —«qué comprobante cubre
        // esta salida»— y se escribe más abajo.
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

    // F8-S7/M3: el enlace de D-205. Va por `InventoryService`, el mismo camino que usa el
    // mostrador, y no con un `update` suelto: ese servicio es el único que escribe
    // `dispatches.invoice_id`. El despacho puede traer un enlace **muerto** (un borrador
    // descartado, un rechazado), que la validación de arriba ya dejó pasar: se suelta primero
    // para que el `WHERE invoice_id IS NULL` del link pueda escribir.
    if (input.dispatchId) {
      await this.inventory.unlinkInvoiceFromDispatch(tx, input.dispatchId);
      const linked = await this.inventory.linkInvoiceToDispatch(tx, input.dispatchId, created.id);
      // Con el `FOR UPDATE` de arriba esto no debería poder pasar; si pasa, es que alguien
      // enlazó por un camino sin lock y el enlace quedaría mintiendo. Cortar es lo correcto:
      // la transacción entera se deshace y no queda un comprobante declarando lo que no es.
      if (!linked) {
        throw new ConflictException(
          'El despacho fue enlazado a otro comprobante mientras se emitía este: volvé a intentarlo',
        );
      }
    }

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
        dispatchId: input.dispatchId ?? null,
      },
    });
    return created.id;
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

    // Lo ya facturado por línea, **neto de notas de crédito vivas** (D-346): solo cuentan los
    // comprobantes vivos. Un rechazado nunca existió para SUNAT y un anulado dejó de existir;
    // ninguno de los dos consume pedido, y lo que una NC viva devolvió se puede facturar de nuevo.
    // Es la misma función que alimenta `orderProgress`.
    const invoicedNet = await withReturnedQty(
      tx,
      await invoicedByOrderItem(tx, orderItemIds),
      orderItemIds,
    );
    const invoicedByItem = new Map(
      [...invoicedNet].map(([id, net]) => [id, net.qty] as [string, Decimal]),
    );
    // P2-A: los borradores de las mismas líneas no consumen cantidad (D-073), pero cuentan para
    // que la parte que cierra tome el resto (`pendingWithDrafts`).
    const drafted = await tx.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: orderItemIds },
        document: {
          status: FiscalDocumentStatus.DRAFT,
          docType: { not: FiscalDocType.NOTA_CREDITO },
          archivedAt: null,
        },
      },
      _sum: { qty: true, subtotalPen: true, igvPen: true, totalPen: true },
    });
    const draftedByItem = new Map(
      drafted.map((row) => [row.salesOrderItemId ?? '', (row._sum.qty ?? 0).toString()]),
    );
    // D-265: y sus importes, para que la parte que cierra la línea tome el resto. D-346: lo ya
    // hecho entra **neto** de lo acreditado (importes incluidos); con el bruto, la parte que cierra
    // la línea después de una NC parcial tomaría un resto equivocado.
    const parts = new PartLedger(
      [...invoicedNet],
      drafted.map((row) => [row.salesOrderItemId ?? '', row._sum]),
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
        // D-255 (R2): sin precio editado, el unitario de la línea del pedido **derivado de su
        // importe** con diez decimales, nunca los cuatro guardados para mostrar.
        const price =
          item.unitPricePen ??
          derivedUnitValue(orderItem.qty.toString(), orderItem.subtotalPen.toString()).toFixed(
            DERIVED_UNIT_VALUE_DECIMALS,
          );
        // D-169: **la línea que factura el pedido entero a su propio precio copia su importe**
        // en vez de recalcularlo. En un pedido nacido del importador (D-152) ese importe es el
        // del comprobante que ya se emitió, y recalcularlo dejaba la cuenta por cobrar unos
        // céntimos por encima del papel — que es exactamente el daño que D-169 vino a cerrar,
        // una pantalla más adelante.
        //
        // Las dos condiciones son necesarias y ninguna alcanza sola. Si el precio se editó al
        // facturar, el importe del pedido describe otro precio y copiarlo sería mentir. Si se
        // factura una **parte** de la línea, el importe exacto es del total y una fracción de
        // él hay que calcularla: ahí el recálculo desde el unitario es lo único defendible.
        //
        // D-265 (P2-8): y la parte que agota lo pendiente, a su propio precio, toma el resto.
        const closing = pendingWithDrafts({
          qty,
          pending,
          drafts: draftedByItem.get(orderItem.id) ?? '0',
        });
        const totals = parts.part(
          orderItem.id,
          orderItem,
          partKind({
            qty,
            lineQty: orderItem.qty.toString(),
            pending: closing.pending,
            priceEdited: item.unitPricePen !== undefined,
          }),
          () => salesTotals([{ qty: item.qty, unitPricePen: price }]),
          closing.countDrafts,
        );
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
  // RF-76 — nota de crédito (cc54: el motivo SUNAT decide, D-654..D-663)
  // -------------------------------------------------------------------------

  /**
   * Nota de crédito en **borrador** sobre un comprobante vivo (RF-76): el camino electrónico (se
   * envía con la misma ruta y toma su correlativo de `FC01`/`BC01`, D-072) y el de dos pasos de
   * siempre. La manual se registra en un solo paso con `registerCreditNote` (D-660). El 02 lleva su
   * comprobante de reemplazo, que un borrador no guarda: solo en un paso.
   */
  async createCreditNote(
    actor: RequestUser,
    affectedId: string,
    input: CreateCreditNoteInput,
  ): Promise<FiscalDocumentDto> {
    // D-133: mismo control que al emitir. Una nota de crédito también es un hecho fechado.
    this.operationDate.assertIssueDate(actor, input.issueDate);
    if (input.reason === CreditNoteReason.ANULACION_ERROR_RUC) {
      throw new BadRequestException(
        'La anulación por error en el RUC (02) se registra en un solo paso, con su comprobante de reemplazo',
      );
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const plan = await this.planCreditNote(tx, actor, affectedId, input, 'DRAFT');
      return this.writeCreditNote(tx, actor, plan, input);
    }, KARDEX_TX_OPTIONS);
    return this.findOne(id);
  }

  /**
   * cc54 (D-660): la NC **manual en un solo paso**: el alta, el registro con la serie y el número del
   * papel y lo que el motivo genera (la devolución del 01/06/07, el reemplazo del 02), en una sola
   * transacción. Si algo no se puede, no queda nada: ni nota, ni devolución, ni reemplazo.
   */
  async registerCreditNote(
    actor: RequestUser,
    affectedId: string,
    input: RegisterCreditNoteInput,
  ): Promise<FiscalDocumentDto> {
    this.operationDate.assertIssueDate(actor, input.issueDate);
    if (input.replacement) this.operationDate.assertIssueDate(actor, input.replacement.issueDate);
    const id = await this.prisma.$transaction(async (tx) => {
      const plan = await this.planCreditNote(tx, actor, affectedId, input, 'MANUAL');
      const noteId = await this.writeCreditNote(tx, actor, plan, input);
      await this.registerManualInTx(
        tx,
        actor,
        noteId,
        { series: input.series, correlative: input.correlative },
        input.replacement ?? null,
      );
      return noteId;
    }, KARDEX_TX_OPTIONS);
    return this.findOne(id);
  }

  /**
   * cc54: **«Qué va a pasar»** antes de confirmar: la misma cuenta que el registro (líneas, importes,
   * devolución al almacén con su costo, saldo y vencimiento del cliente), sin escribir nada.
   */
  async previewCreditNote(
    actor: RequestUser,
    affectedId: string,
    input: CreateCreditNoteInput,
  ): Promise<CreditNotePreviewDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const plan = await this.planCreditNote(tx, actor, affectedId, input, 'PREVIEW');
        const { affected } = plan;
        const allocations = returnsStock(input.reason)
          ? await this.salesReturns.planForLines(
              tx,
              plan.lines.map((l) => ({
                lineNumber: l.original.lineNumber,
                orderItemId: l.original.salesOrderItemId,
                qty: l.qty,
              })),
              {
                affectedInvoiceId: affected.id,
                asOf: input.issueDate,
                ...(input.reason === CreditNoteReason.ANULACION_OPERACION
                  ? { upToAvailable: true, onlyAffected: true }
                  : {}),
              },
            )
          : [];
        const flat = allocations.flat();
        const labels = await this.kardexItemLabels(
          tx,
          flat.map((a) => ({ itemType: a.stock.itemType, itemId: a.stock.itemId })),
        );
        const notDispatched =
          input.reason === CreditNoteReason.ANULACION_OPERACION
            ? plan.lines.flatMap((l, i) => {
                const back = (allocations[i] ?? []).reduce(
                  (acc, a) => acc.plus(a.qty),
                  new Decimal(0),
                );
                const left = toDecimal(l.qty).minus(back);
                return left.gt(0)
                  ? [{ lineNumber: l.original.lineNumber, qty: left.toFixed(3) }]
                  : [];
              })
            : [];
        const before = documentBalance({
          status: affected.status,
          totalPen: affected.totalPen.toString(),
          paidPen: affected.payments.reduce(
            (acc, p) => acc.plus(toDecimal(p.amountPen.toString())),
            new Decimal(0),
          ),
          creditedPen: affected.creditNotes.reduce(
            (acc, n) => acc.plus(toDecimal(n.totalPen.toString())),
            new Decimal(0),
          ),
        });
        const after = Decimal.max(toDecimal(before).minus(plan.totals.total), new Decimal(0));
        const warnings: string[] = [];
        const late = creditNoteDeadlineWarning(
          input.reason,
          fromDateOnly(affected.issueDate),
          input.issueDate,
        );
        if (late) warnings.push(late);
        if (
          DISCOUNT_CREDIT_NOTE_REASONS.includes(input.reason) &&
          affected.docType === FiscalDocType.BOLETA
        ) {
          warnings.push(
            'SUNAT observa una nota de descuento sobre una boleta (observación 4367): se acepta, pero queda observada.',
          );
        }
        if (notDispatched.length > 0) {
          warnings.push(
            'Parte de lo facturado no salió del almacén: no vuelve nada de eso y queda otra vez pendiente de facturar en el pedido.',
          );
        }
        return {
          reason: input.reason,
          sunatCode: CREDIT_NOTE_REASON_SUNAT_CODE[input.reason],
          ...serializeSalesTotals(plan.totals),
          lines: plan.lines.map((l) => ({
            affectedItemId: l.original.id,
            lineNumber: l.original.lineNumber,
            description: l.description,
            qty: l.qty,
            totalPen: l.totalPen,
          })),
          stock: flat.map((a) => ({
            label: labels.get(`${a.stock.itemType}:${a.stock.itemId}`) ?? a.stock.itemId,
            qty: toFixedString(a.reserveQty, 'KG'),
            unit: a.stock.unit,
            costPen: toFixedString(a.totalCost, 'MONEY'),
            dispatch: a.stock.dispatchCode,
          })),
          notDispatched,
          costPen: toFixedString(
            flat.reduce((acc, a) => acc.plus(a.totalCost), new Decimal(0)),
            'MONEY',
          ),
          receivable: {
            beforePen: toFixedString(before, 'MONEY'),
            afterPen: toFixedString(after, 'MONEY'),
            dueDateBefore: plan.dueDate,
            dueDateAfter:
              input.reason === CreditNoteReason.OTROS_AJUSTES
                ? (input.dueDate ?? null)
                : plan.dueDate,
          },
          replacement: plan.replacement
            ? {
                customerName: plan.replacement.customerName,
                number: plan.replacement.number,
                totalPen: affected.totalPen.toFixed(4),
              }
            : null,
          warnings,
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /** SKU o código de bobina de cada ítem del kardex, para mostrarlo. Dos consultas como mucho. */
  private async kardexItemLabels(
    tx: Prisma.TransactionClient,
    items: readonly { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, string>> {
    const products = items.filter((i) => i.itemType === 'PRODUCT').map((i) => i.itemId);
    const coils = items.filter((i) => i.itemType === 'COIL').map((i) => i.itemId);
    const [p, c] = await Promise.all([
      products.length > 0
        ? tx.product.findMany({ where: { id: { in: products } }, select: { id: true, sku: true } })
        : [],
      coils.length > 0
        ? tx.coil.findMany({ where: { id: { in: coils } }, select: { id: true, code: true } })
        : [],
    ]);
    return new Map([
      ...p.map((x) => [`PRODUCT:${x.id}`, x.sku] as [string, string]),
      ...c.map((x) => [`COIL:${x.id}`, x.code] as [string, string]),
    ]);
  }

  /**
   * Lo que la nota va a ser, **sin escribir**: valida el afectado y el motivo y arma las líneas
   * (`credit-note-lines.ts`). `DRAFT` y `MANUAL` bloquean el afectado antes de leer lo que le queda
   * por acreditar (dos NC concurrentes acreditaban el doble); `PREVIEW` solo lee.
   */
  private async planCreditNote(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    affectedId: string,
    input: CreateCreditNoteInput,
    mode: 'DRAFT' | 'MANUAL' | 'PREVIEW',
  ): Promise<CreditNotePlan> {
    // **El afectado se bloquea antes de leer lo que le queda por acreditar.** Sin esto, dos notas de
    // crédito concurrentes sobre el mismo comprobante calculaban las dos el mismo pendiente y
    // acreditaban el doble. Es el mismo lock que `addPayment` toma para el saldo.
    if (mode !== 'PREVIEW') await lockDocuments(tx, { fiscalDocuments: [affectedId] });
    const affected = await tx.fiscalDocument.findUnique({
      where: { id: affectedId },
      include: CREDIT_NOTE_AFFECTED_INCLUDE,
    });
    if (!affected) throw new NotFoundException('Comprobante no encontrado');
    // RF-S3c: el vendedor solo opera sobre sus propios comprobantes.
    assertSellerAccess(
      actor,
      affected.salesOrder?.sellerId ??
        affected.dispatch?.salesOrder?.sellerId ??
        affected.createdById,
      'Comprobante',
    );
    // D-153: sobre un manual **sí** hay nota de crédito, pero manual. Lo importado no tiene vuelta.
    if (affected.origin === FiscalDocumentOrigin.IMPORTED) {
      throw new BadRequestException(
        `El comprobante ${affected.number ?? ''} se importó ya emitido: su nota de crédito se hace donde se emitió`,
      );
    }
    if (affected.docType === FiscalDocType.NOTA_CREDITO) {
      throw new BadRequestException('Una nota de crédito no se acredita con otra nota de crédito');
    }
    if (affected.docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
      throw new BadRequestException('Una guía de remisión no se acredita: se da de baja');
    }
    if (affected.status === FiscalDocumentStatus.VOID_PENDING) {
      // cc34 (D-536 de fondo): la baja ya salió hacia SUNAT.
      throw new BadRequestException(
        `${affected.number ?? 'El comprobante'} ${VOID_IN_PROGRESS}: espera a que SUNAT la confirme o la rechace antes de emitir una nota de crédito`,
      );
    }
    if (affected.status !== FiscalDocumentStatus.ACCEPTED) {
      throw new BadRequestException(
        `Solo se acredita un comprobante aceptado por SUNAT; este está ${affected.status}`,
      );
    }
    // La NC manual va sobre un manual (D-153); la de un electrónico se emite.
    if (mode === 'MANUAL' && affected.origin !== FiscalDocumentOrigin.MANUAL) {
      throw new BadRequestException(
        `${affected.number ?? 'El comprobante'} no es manual: su nota de crédito se emite, no se registra a mano`,
      );
    }
    // cc52 (D-645): la NC no puede ser anterior al comprobante que acredita.
    const affectedDate = fromDateOnly(affected.issueDate);
    if (input.issueDate < affectedDate) {
      throw new BadRequestException(
        `La nota de crédito no puede ser anterior al comprobante que acredita (${affected.number ?? ''}, del ${affectedDate})`,
      );
    }

    // Lo ya acreditado de cada línea, en una sola lectura: las notas vivas y los borradores. La
    // cantidad la mueven solo los motivos de cantidad; el importe, todos (D-663).
    const prior = await tx.fiscalDocumentItem.findMany({
      where: {
        affectedItemId: { in: affected.items.map((i) => i.id) },
        document: {
          archivedAt: null,
          status: { in: [...LIVE_DOCUMENT_STATUSES, FiscalDocumentStatus.DRAFT] },
        },
      },
      select: {
        affectedItemId: true,
        qty: true,
        subtotalPen: true,
        igvPen: true,
        totalPen: true,
        document: { select: { status: true, creditNoteReason: true } },
      },
    });
    const credited = creditsByLine(
      prior.filter((p) => p.document.status !== FiscalDocumentStatus.DRAFT),
      creditsQty,
    );
    const drafted = creditsByLine(
      prior.filter((p) => p.document.status === FiscalDocumentStatus.DRAFT),
      creditsQty,
    );
    const affectedLines: AffectedLine[] = affected.items.map((i) => ({
      id: i.id,
      lineNumber: i.lineNumber,
      qty: toDecimal(i.qty.toString()),
      subtotalPen: toDecimal(i.subtotalPen.toString()),
      igvPen: toDecimal(i.igvPen.toString()),
      totalPen: toDecimal(i.totalPen.toString()),
      unitPricePen: i.unitPricePen.toString(),
      description: i.description,
      productId: i.productId,
      unit: i.unit,
      salesOrderItemId: i.salesOrderItemId,
    }));

    const reason = input.reason;
    let lines: NoteLine[];
    if (creditsQty(reason)) {
      lines = qtyCreditLines(
        affectedLines,
        input.items && input.items.length > 0 ? input.items : null,
        credited,
        drafted,
      );
    } else if (reason === CreditNoteReason.DESCUENTO_ITEM) {
      lines = priceCreditLines(affectedLines, input.prices ?? [], credited);
    } else if (reason === CreditNoteReason.DESCUENTO_GLOBAL) {
      lines = amountCreditLines(affectedLines, input.amountPen ?? '0', credited);
    } else if (reason === CreditNoteReason.CORRECCION_DESCRIPCION) {
      lines = zeroCreditLines(affectedLines, input.descriptions ?? []);
    } else {
      lines = zeroCreditLines(affectedLines, null);
    }
    if (lines.length === 0) {
      throw new BadRequestException('No queda nada por acreditar en este comprobante');
    }

    const currentDue = effectiveDueDate(
      affected.dueDate ? fromDateOnly(affected.dueDate) : null,
      affected.creditNotes.map((n) => ({
        creditNoteReason: n.creditNoteReason,
        status: n.status,
        dueDate: n.dueDate ? fromDateOnly(n.dueDate) : null,
        issueDate: fromDateOnly(n.issueDate),
        createdAt: n.createdAt.toISOString(),
      })),
    ).dueDate;

    // cc52 (D-646): una NC de devolución solo devuelve lo despachado y aún no devuelto, y solo a mano.
    if (isReturnCreditNoteReason(reason)) {
      if (affected.origin !== FiscalDocumentOrigin.MANUAL) {
        throw new BadRequestException(
          'La devolución de mercadería se registra con una nota de crédito manual: este comprobante no es manual',
        );
      }
      // En un paso, el registro lo comprueba con los despachos bloqueados: no hace falta dos veces.
      if (mode === 'DRAFT') {
        await this.salesReturns.planForLines(
          tx,
          lines.map((l) => ({
            lineNumber: l.original.lineNumber,
            orderItemId: l.original.salesOrderItemId,
            qty: l.qty,
          })),
          { affectedInvoiceId: affected.id, asOf: input.issueDate },
        );
      }
    }

    // cc54 (D-657): el 13 cambia el vencimiento de una factura al crédito; el importe no cambia.
    if (reason === CreditNoteReason.OTROS_AJUSTES) {
      if (affected.docType !== FiscalDocType.FACTURA || affected.paymentTerms !== 'CREDITO') {
        throw new BadRequestException(
          'El vencimiento se corrige solo en una factura al crédito (SUNAT: motivo 13, errores 3259 y 3260)',
        );
      }
      const next = input.dueDate ?? '';
      if (next < affectedDate) {
        throw new BadRequestException(
          `El vencimiento nuevo no puede ser anterior a la emisión del comprobante (${affectedDate})`,
        );
      }
      if (next === currentDue) {
        throw new BadRequestException(`El comprobante ya vence el ${next}: elige otra fecha`);
      }
    }

    const replacement =
      reason === CreditNoteReason.ANULACION_ERROR_RUC && input.replacement
        ? await this.planReplacement(tx, affected, input.replacement)
        : null;

    const totals = isZeroAmountCreditNote(reason)
      ? { subtotal: new Decimal(0), igv: new Decimal(0), total: new Decimal(0) }
      : sumLineTotals(lines);
    return { affected, lines, totals, dueDate: currentDue, replacement };
  }

  /**
   * cc54 (D-655): lo que el reemplazo de un 02 exige, antes de escribir nada. El comprobante
   * anulado no puede tener cobros (primero se anulan) ni otras notas; el cliente correcto tiene que
   * poder recibir ese tipo de comprobante; el pedido no puede tener otros comprobantes del cliente
   * anterior (se le cambia el cliente).
   */
  private async planReplacement(
    tx: Prisma.TransactionClient,
    affected: ReplacementSubject,
    replacement: CreditNoteReplacementInput,
  ): Promise<NonNullable<CreditNotePlan['replacement']>> {
    const label = affected.number ?? 'El comprobante';
    if (affected.payments.length > 0) {
      throw new BadRequestException(
        `${label} tiene cobros registrados: anúlalos primero y después registra la nota de crédito 02`,
      );
    }
    if (affected.creditNotes.length > 0) {
      throw new BadRequestException(
        `${label} ya tiene notas de crédito vivas (${affected.creditNotes.map((n) => n.number ?? 'borrador').join(', ')}): el 02 reemplaza el comprobante entero`,
      );
    }
    if (replacement.issueDate < fromDateOnly(affected.issueDate)) {
      throw new BadRequestException(
        `El comprobante de reemplazo no puede ser anterior al que reemplaza (${fromDateOnly(affected.issueDate)})`,
      );
    }
    const customer = await tx.customer.findUnique({ where: { id: replacement.customerId } });
    if (!customer) throw new NotFoundException('Cliente del reemplazo no encontrado');
    if (!customer.isActive)
      throw new BadRequestException('El cliente del reemplazo está desactivado');
    if (customer.id === affected.customerId) {
      throw new BadRequestException(
        'El reemplazo es del mismo cliente: si no hubo error de cliente, usa «Anular» (01)',
      );
    }
    if (customer.isSystem && affected.docType !== FiscalDocType.BOLETA) {
      throw new BadRequestException(
        'Al cliente "público en general" solo se le emiten boletas: elige un cliente identificado',
      );
    }
    if (affected.docType === FiscalDocType.FACTURA && customer.docType !== DocType.RUC) {
      throw new BadRequestException(
        'El reemplazo de una factura va a un cliente con RUC; para este cliente corresponde una boleta',
      );
    }
    const number = fiscalDocumentNumber(replacement.series, replacement.correlative);
    const clash = await tx.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `Ya hay un comprobante registrado con el número ${number}: revisa la serie y el correlativo del reemplazo`,
      );
    }
    if (affected.salesOrderId) {
      if (affected.salesOrder?.status === 'CANCELLED') {
        throw new BadRequestException(
          `El pedido ${salesOrderCode(affected.salesOrder.seq)} está anulado: el reemplazo no tiene dónde ir`,
        );
      }
      const others = await tx.fiscalDocument.findMany({
        where: {
          salesOrderId: affected.salesOrderId,
          id: { not: affected.id },
          docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
          status: { in: [...STANDING_DOCUMENT_STATUSES] },
          archivedAt: null,
        },
        select: { number: true },
      });
      if (others.length > 0) {
        throw new BadRequestException(
          `El pedido tiene otros comprobantes del cliente anterior (${others.map((o) => o.number ?? 'borrador').join(', ')}): no se le puede cambiar el cliente`,
        );
      }
    }
    return {
      customerId: customer.id,
      customerName: customer.name,
      number,
      series: replacement.series,
      correlative: replacement.correlative,
      issueDate: replacement.issueDate,
    };
  }

  /** Escribe la nota (borrador) y su constancia. Devuelve su id. */
  private async writeCreditNote(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    plan: CreditNotePlan,
    input: CreateCreditNoteInput,
  ): Promise<string> {
    const { affected, lines } = plan;
    const serialized = serializeSalesTotals(plan.totals);
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
        // cc54 (D-657): el 13 declara acá el vencimiento nuevo del afectado (`effectiveDueDate`).
        dueDate:
          input.reason === CreditNoteReason.OTROS_AJUSTES && input.dueDate
            ? toDateOnly(input.dueDate)
            : null,
        subtotalPen: serialized.subtotalPen,
        igvPen: serialized.igvPen,
        totalPen: serialized.totalPen,
        notes: input.notes ?? null,
        createdById: actor.id,
        items: {
          create: lines.map((l, i) => ({
            lineNumber: i + 1,
            productId: l.original.productId,
            description: l.description,
            qty: l.qty,
            unit: l.original.unit,
            unitPricePen: l.unitPricePen,
            subtotalPen: l.subtotalPen,
            igvPen: l.igvPen,
            totalPen: l.totalPen,
            salesOrderItemId: l.original.salesOrderItemId,
            affectedItemId: l.original.id,
          })),
        },
      },
    });

    // cc52 (cc50, D-638): la NC también en el «Historial» del comprobante y del pedido.
    const after = {
      creditNoteId: note.id,
      affects: affected.number,
      reason: input.reason,
      sunatCode: CREDIT_NOTE_REASON_SUNAT_CODE[input.reason],
      issueDate: input.issueDate,
      totalPen: serialized.totalPen,
      partial: (input.items?.length ?? 0) > 0,
      ...(input.reason === CreditNoteReason.OTROS_AJUSTES
        ? { dueDateBefore: plan.dueDate, dueDateAfter: input.dueDate ?? null }
        : {}),
      ...(input.reason === CreditNoteReason.CORRECCION_DESCRIPCION
        ? {
            corrected: lines.map((l) => ({
              line: l.original.lineNumber,
              before: l.original.description,
              after: l.description,
            })),
          }
        : {}),
      ...(plan.replacement
        ? {
            replacement: plan.replacement.number,
            replacementCustomer: plan.replacement.customerName,
          }
        : {}),
    };
    for (const target of [
      { entity: 'fiscal_documents', entityId: note.id },
      { entity: 'fiscal_documents', entityId: affected.id },
      ...(affected.salesOrderId
        ? [{ entity: 'sales_orders', entityId: affected.salesOrderId }]
        : []),
    ]) {
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.credit-note.create',
        ...target,
        after,
      });
    }
    return note.id;
  }

  /**
   * **El otro terminal de un borrador** (D-153): registrarlo como manual.
   *
   * Un borrador tiene dos salidas y son excluyentes. `send` toma un correlativo de la serie
   * del ERP y lo manda a Nubefact; esta lo cierra con la serie y el número que ya trae el papel
   * emitido en la otra app. Que las dos partan del **mismo borrador** no es economía de código:
   * es lo que garantiza que un manual pase por las mismas validaciones que un electrónico —
   * cliente activo, líneas contra el pedido, tope de la boleta genérica, detracción, fecha
   * (D-124/D-133)—, porque son literalmente las de `createInTx`.
   *
   * Lo que **no** hace, y por eso es manual: no toca `fiscal_series` —esa es la numeración
   * propia del ERP y adelantarla quemaría rango de las series con las que se factura de
   * verdad—, no habla con el PSE, no guarda CDR ni XML. Nace `ACCEPTED` por el mismo motivo
   * que un importado (D-105): el papel existe y el otro sistema ya lo declaró.
   */
  async registerManual(
    actor: RequestUser,
    id: string,
    input: RegisterManualInput,
  ): Promise<FiscalDocumentDto> {
    // El mismo control que `send` y `retry`: cerrar un borrador ajeno como comprobante manual
    // es igual de irreversible que emitirlo, y después solo un ADMINISTRADOR puede anularlo.
    await this.assertOwnership(actor, id, 'registrarlo como manual');
    await this.prisma.$transaction(
      (tx) => this.registerManualInTx(tx, actor, id, input, null),
      KARDEX_TX_OPTIONS,
    );
    return this.findOne(id);
  }

  /**
   * El registro como manual dentro de la transacción del llamador: el de un borrador (dos pasos) y
   * el de la NC en un paso (D-660). Una NC que devuelve mercadería (01, 06, 07) genera su devolución;
   * un 02, su comprobante de reemplazo (D-655).
   */
  private async registerManualInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    id: string,
    input: RegisterManualInput,
    replacement: CreditNoteReplacementInput | null,
  ): Promise<void> {
    const rows = await this.lockWithAffected(tx, id);
    if (rows.length === 0) throw new NotFoundException('Comprobante no encontrado');
    const document = await tx.fiscalDocument.findUniqueOrThrow({
      where: { id },
      include: {
        items: {
          select: {
            id: true,
            qty: true,
            totalPen: true,
            salesOrderItemId: true,
            affectedItemId: true,
          },
        },
        affectedDocument: {
          select: { id: true, origin: true, number: true, status: true, archivedAt: true },
        },
      },
    });

    if (document.status !== FiscalDocumentStatus.DRAFT) {
      throw new ConflictException(
        document.status === FiscalDocumentStatus.REJECTED
          ? 'Este comprobante fue rechazado: corrígelo para registrar uno nuevo'
          : 'El comprobante ya dejó de ser un borrador',
      );
    }
    if (document.items.length === 0) {
      throw new BadRequestException('Un comprobante sin líneas no se registra');
    }
    // La simétrica de la guarda de `assignInTx`: la NC de un comprobante electrónico se
    // emite, no se registra a mano — si no, SUNAT se queda sin la nota de crédito de un
    // comprobante que sí le mandamos.
    if (
      document.affectedDocument !== null &&
      document.affectedDocument.origin !== FiscalDocumentOrigin.MANUAL
    ) {
      throw new BadRequestException(
        `${document.affectedDocument.number ?? 'El comprobante afectado'} no es manual: su nota de crédito se emite, no se registra a mano`,
      );
    }
    // cc33 N3: el afectado, ya bloqueado junto con la nota, tiene que seguir aceptado y vigente.
    if (document.affectedDocument !== null)
      assertAffectedStillCreditable(document.affectedDocument);
    const isNote = document.docType === FiscalDocType.NOTA_CREDITO;
    // cc54 (D-655): el 02 sin su reemplazo no se registra (un borrador viejo no lo guarda).
    if (
      isNote &&
      document.creditNoteReason === CreditNoteReason.ANULACION_ERROR_RUC &&
      !replacement
    ) {
      throw new BadRequestException(
        'La anulación por error en el RUC (02) se registra con su comprobante de reemplazo: hazla desde «Nota de crédito»',
      );
    }

    // El mismo último control que `send`: dos borradores sobre la misma línea pasan los dos
    // la validación de creación, y este es el punto en el que todavía se puede decir que no.
    // cc30 (D-471/D-474, matriz F9): con el pedido tomado detrás del comprobante, lo facturado
    // del pedido se lee sin que una edición o una anulación del pedido cambie en el medio.
    // cc52 (D-646): una NC de devolución toma además sus despachos, que van **antes** que el
    // pedido en el orden único (regla dura 17). cc54: también el 01 (D-656) y los despachos que el
    // 02 lleva al reemplazo (D-655).
    const returning = isNote && returnsStock(document.creditNoteReason);
    const returnDispatchIds = returning
      ? await this.salesReturns.dispatchIdsForCreditNote(tx, id)
      : [];
    const movedDispatchIds =
      replacement && document.affectedDocument
        ? (
            await tx.dispatch.findMany({
              where: { invoiceId: document.affectedDocument.id },
              select: { id: true },
            })
          ).map((d) => d.id)
        : [];
    await lockDocuments(tx, {
      dispatches: [...new Set([...returnDispatchIds, ...movedDispatchIds])],
      salesOrders: [document.salesOrderId],
    });
    // Revisión de cc52 (P2): la fecha de la NC es la del reingreso al kardex; quien la registra
    // tiene que poder fechar así (solo ADMINISTRADOR fecha otro día que hoy, D-124/D-133).
    if (returning) this.operationDate.assertIssueDate(actor, fromDateOnly(document.issueDate));
    await this.assertStillAvailable(tx, document);

    const number = fiscalDocumentNumber(input.series, input.correlative);
    // El índice único parcial de `number` ya lo impide en la base; esto es para que el
    // usuario lea el motivo en vez de un choque de constraint.
    const clash = await tx.fiscalDocument.findFirst({
      where: { number, archivedAt: null, id: { not: id } },
      select: { id: true, status: true },
    });
    if (clash) {
      throw new ConflictException(
        `Ya hay un comprobante registrado con el número ${number}: revisa la serie y el correlativo`,
      );
    }

    // El `findFirst` de arriba es una lectura sin lock sobre **otra** fila: dos registros
    // simultáneos con el mismo número lo pasan los dos y el segundo choca contra el índice
    // único parcial. Se traduce acá para que el usuario lea el motivo y no un 500.
    try {
      await this.applyManualNumber(tx, id, input, number, document.status, document.origin, actor);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Ya hay un comprobante registrado con el número ${number}: revisa la serie y el correlativo`,
        );
      }
      throw err;
    }
    // cc52 (D-646): la NC de devolución, ya aceptada, genera su devolución en la misma
    // transacción: si el reingreso no se puede, la NC tampoco queda registrada.
    if (returning) {
      await this.salesReturns.createForCreditNoteInTx(tx, actor, id, returnDispatchIds);
    }
    if (replacement && document.affectedDocument) {
      await this.applyReplacementInTx(tx, actor, id, document.affectedDocument.id, replacement);
    }
  }

  /**
   * cc54 (D-655): el comprobante de reemplazo de un 02, ya registrado en papel al cliente correcto:
   * las **mismas líneas e importes** que el anulado, en el mismo pedido, sin una salida nueva (el
   * despacho pasa del anulado al reemplazo). El pedido cambia de cliente. Todo con su constancia.
   */
  private async applyReplacementInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    noteId: string,
    affectedId: string,
    replacement: CreditNoteReplacementInput,
  ): Promise<void> {
    const affected = await tx.fiscalDocument.findUniqueOrThrow({
      where: { id: affectedId },
      include: { items: { orderBy: { lineNumber: 'asc' } }, customer: { select: { name: true } } },
    });
    const plan = await this.planReplacement(
      tx,
      {
        ...affected,
        payments: await tx.customerPayment.findMany({
          where: { documentId: affectedId, reversedAt: null },
          select: { amountPen: true },
        }),
        // La nota que se está registrando ya acredita al afectado: el control de «otras notas» la
        // excluye (lo hizo `planCreditNote` antes de crearla).
        creditNotes: [],
        salesOrder: affected.salesOrderId
          ? await tx.salesOrder.findUnique({
              where: { id: affected.salesOrderId },
              select: { sellerId: true, status: true, seq: true },
            })
          : null,
      },
      replacement,
    );
    // El plazo del papel se conserva: el reemplazo vence los mismos días después de su emisión.
    const dueDate =
      affected.dueDate === null
        ? null
        : shiftDate(
            fromDateOnly(affected.dueDate),
            fromDateOnly(affected.issueDate),
            plan.issueDate,
          );
    let created: { id: string };
    try {
      created = await tx.fiscalDocument.create({
        data: {
          docType: affected.docType,
          status: FiscalDocumentStatus.ACCEPTED,
          origin: FiscalDocumentOrigin.MANUAL,
          customerId: plan.customerId,
          salesOrderId: affected.salesOrderId,
          replacesDocumentId: affected.id,
          correlative: plan.correlative,
          number: plan.number,
          issueDate: toDateOnly(plan.issueDate),
          paymentTerms: affected.paymentTerms,
          dueDate: dueDate === null ? null : toDateOnly(dueDate),
          subtotalPen: affected.subtotalPen,
          igvPen: affected.igvPen,
          totalPen: affected.totalPen,
          detractionCode: affected.detractionCode,
          detractionPct: affected.detractionPct,
          detractionAmountPen: affected.detractionAmountPen,
          notes: `Reemplaza a ${affected.number ?? ''} (nota de crédito 02 por error en el RUC)`,
          createdById: actor.id,
          issuedAt: new Date(),
          acceptedAt: new Date(),
          items: {
            create: affected.items.map((i) => ({
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
            })),
          },
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `Ya hay un comprobante registrado con el número ${plan.number}: revisa la serie y el correlativo del reemplazo`,
        );
      }
      throw err;
    }
    // El despacho declarado pasa al reemplazo: la mercadería no se mueve (D-205, por la puerta
    // del kardex, la única que escribe `dispatches.invoice_id`).
    const moved = await this.inventory.moveInvoiceDispatches(tx, affected.id, created.id);
    let orderCode: string | null = null;
    if (affected.salesOrderId) {
      const order = await tx.salesOrder.update({
        where: { id: affected.salesOrderId },
        data: { customerId: plan.customerId },
        select: { seq: true },
      });
      orderCode = salesOrderCode(order.seq);
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'sales.order.customer-change',
        entity: 'sales_orders',
        entityId: affected.salesOrderId,
        before: { customerId: affected.customerId, customer: affected.customer.name },
        after: {
          customerId: plan.customerId,
          customer: plan.customerName,
          reason: `Nota de crédito 02 de ${affected.number ?? ''}: el comprobante se reemplaza por ${plan.number}`,
        },
      });
    }
    const detail = {
      creditNoteId: noteId,
      replaced: affected.number,
      replacementId: created.id,
      replacement: plan.number,
      customerBefore: affected.customer.name,
      customerAfter: plan.customerName,
      salesOrder: orderCode,
      dispatchesMoved: moved,
    };
    for (const target of [
      { entity: 'fiscal_documents', entityId: noteId },
      { entity: 'fiscal_documents', entityId: affected.id },
      { entity: 'fiscal_documents', entityId: created.id },
      ...(affected.salesOrderId
        ? [{ entity: 'sales_orders', entityId: affected.salesOrderId }]
        : []),
    ]) {
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.credit-note.replacement',
        ...target,
        after: detail,
      });
    }
  }

  /** El cierre del borrador como manual, aparte para que su `P2002` se pueda distinguir. */
  private async applyManualNumber(
    tx: Prisma.TransactionClient,
    id: string,
    input: RegisterManualInput,
    number: string,
    previousStatus: FiscalDocumentStatus,
    previousOrigin: FiscalDocumentOrigin,
    actor: RequestUser,
  ): Promise<void> {
    await tx.fiscalDocument.update({
      where: { id },
      data: {
        origin: FiscalDocumentOrigin.MANUAL,
        status: FiscalDocumentStatus.ACCEPTED,
        // `seriesId` queda en null a propósito: la serie del papel no es una serie del ERP y
        // no tiene por qué existir en `fiscal_series`.
        seriesId: null,
        correlative: input.correlative,
        number,
        // Las dos fechas, y no solo `issuedAt`: un manual **está** aceptado desde el momento
        // en que se registra, y dejar `acceptedAt` nulo no era neutro — Postgres ordena
        // `DESC` con `NULLS FIRST`, así que un manual ganaba todo desempate por fecha de
        // aceptación contra comprobantes que sí la tenían.
        issuedAt: new Date(),
        acceptedAt: new Date(),
      },
    });

    await this.audit.write(tx, {
      actorId: actor.id,
      action: 'invoicing.document.register-manual',
      entity: 'fiscal_documents',
      entityId: id,
      before: { status: previousStatus, origin: previousOrigin },
      after: {
        status: FiscalDocumentStatus.ACCEPTED,
        origin: FiscalDocumentOrigin.MANUAL,
        number,
      },
    });
  }

  /**
   * Corrige la fecha de emisión de un comprobante **manual** (F8-S7/M1).
   *
   * Pedido del cliente tras cargar los primeros comprobantes de la migración: el papel ya
   * existe con su fecha impresa y al tipearla se puede errar; hasta acá no había ninguna
   * puerta para corregirla.
   *
   * **Por qué solo los manuales.** Un `ISSUED_HERE` mandó su fecha al PSE y la tiene en un
   * CDR firmado: cambiarla en el ERP la desalinearía de lo que SUNAT tiene, en silencio y
   * sin forma de deshacerlo. Un `IMPORTED` es el reflejo de lo que emitió la otra app, y su
   * fecha se corrige allá y se reimporta (RF-72). El manual es el único origen donde el ERP
   * **es** la fuente de verdad del dato (D-153), y por eso el único donde puede corregirlo.
   *
   * **El vencimiento se mueve con la emisión, conservando los días de plazo.** No es un
   * detalle cosmético: dejarlo quieto convierte una factura a 30 días en una a 23 sin que
   * nadie lo pida, y eso sale después en un reporte de mora como si el cliente se hubiera
   * atrasado. Conservar el delta respeta lo que se pactó sin tener que adivinar si la fecha
   * salió de `customers.credit_days` o la tipeó alguien —el dato guardado no lo distingue—.
   * Como igual es un efecto colateral, exige `confirmDueDateShift`: la UI muestra el
   * vencimiento nuevo antes de confirmar, y sin el flag no se toca nada.
   */
  async updateManualIssueDate(
    actor: RequestUser,
    id: string,
    input: UpdateManualIssueDateInput,
  ): Promise<FiscalDocumentDto> {
    // D-133: mismo control de rol y mismas cotas que al emitir. La ventana de SUNAT
    // (D-072/D-210) ya la validó el schema.
    this.operationDate.assertIssueDate(actor, input.issueDate);

    // D-376 (cc10): si re-fechar el despacho dejaría el kardex negativo a la fecha nueva (el
    // mismo bloqueo de D-364), no se re-fecha nada —la transacción entera se deshace y el
    // usuario ve el motivo— y el intento queda auditado fuera de ella, porque el rollback se
    // llevaría consigo cualquier auditoría escrita adentro.
    let redateRejected: string | null = null;
    try {
      await this.updateManualIssueDateInTx(actor, id, input, (message) => {
        redateRejected = message;
      });
    } catch (err) {
      if (redateRejected !== null) {
        await this.audit.log({
          actorId: actor.id,
          action: 'invoicing.dispatch.redate-rejected',
          entity: 'fiscal_documents',
          entityId: id,
          after: { issueDate: input.issueDate, reason: redateRejected },
          reason: input.reason,
        });
      }
      throw err;
    }
    return this.findOne(id);
  }

  private async updateManualIssueDateInTx(
    actor: RequestUser,
    id: string,
    input: UpdateManualIssueDateInput,
    onRedateRejected: (message: string) => void,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // **El lock va antes de leer**, igual que `createCreditNote`, `registerManual`,
        // `voidDocument` y `annulExternal` sobre esta misma tabla. Los guardrails de abajo
        // —que no haya cobro ni nota de crédito por delante de la fecha nueva— se evalúan
        // sobre lo que se lee acá: sin el lock son una foto, y un cobro registrado en paralelo
        // entra por la ventana que el método dice cerrar.
        await lockDocuments(tx, { fiscalDocuments: [id] });
        const document = await tx.fiscalDocument.findUnique({
          where: { id },
          select: {
            id: true,
            docType: true,
            origin: true,
            status: true,
            issueDate: true,
            dueDate: true,
            paymentTerms: true,
            annulledAt: true,
            archivedAt: true,
            // Qué comprobante acredita este, cuando el que se corrige **es** una nota de
            // crédito: `registerManual` también las cierra como manuales, así que la cota vale
            // en los dos sentidos.
            affectedDocument: { select: { number: true, issueDate: true } },
            creditNotes: {
              // Por estado y no solo por `archivedAt`: una nota rechazada o dada de baja no
              // acredita nada, y bloquear la corrección con ella dejaba el comprobante
              // atascado por un papel que no existe. Misma lista blanca que el resto del módulo.
              where: { archivedAt: null, status: { in: LIVE_DOCUMENT_STATUSES } },
              select: { number: true, issueDate: true },
            },
            payments: {
              where: { reversedAt: null },
              select: { date: true },
            },
          },
        });
        if (!document) throw new NotFoundException('El comprobante no existe');
        if (document.origin !== FiscalDocumentOrigin.MANUAL) {
          throw new ConflictException(
            'Solo se puede corregir la fecha de un comprobante manual: la de uno electrónico ' +
              'viajó al PSE y vive en su CDR',
          );
        }
        if (document.annulledAt !== null) {
          throw new ConflictException('Un comprobante anulado ya no se corrige');
        }
        if (document.archivedAt !== null) {
          throw new ConflictException('Esta versión fue archivada por una reimportación');
        }
        // Hoy `origin = MANUAL` implica `ACCEPTED` o `ANNULLED` (`applyManualNumber` los cierra
        // así), pero eso es una invariante implícita de otro método: si algún día un manual
        // puede quedar en otro estado, esto corta acá y no se descubre por un dato raro.
        if (document.status !== FiscalDocumentStatus.ACCEPTED) {
          throw new ConflictException('Solo se corrige la fecha de un comprobante aceptado');
        }

        const before = document.issueDate.toISOString().slice(0, 10);
        if (before === input.issueDate) {
          throw new ConflictException(`La fecha de emisión ya es ${input.issueDate}`);
        }

        // Una nota de crédito no puede ser anterior al comprobante que acredita, y un cobro no
        // puede existir antes de que el comprobante se emita. Las dos son incoherencias que hoy
        // no se pueden crear por ningún otro camino, así que tampoco se crean por este.
        const earlierNote = document.creditNotes.find(
          (n) => n.issueDate.toISOString().slice(0, 10) < input.issueDate,
        );
        if (earlierNote) {
          throw new ConflictException(
            `La nota de crédito ${earlierNote.number ?? ''} es del ` +
              `${earlierNote.issueDate.toISOString().slice(0, 10)}: la emisión no puede quedar después`,
          );
        }
        const earlierPayment = document.payments.find(
          (p) => p.date.toISOString().slice(0, 10) < input.issueDate,
        );
        if (earlierPayment) {
          throw new ConflictException(
            `Hay un cobro del ${earlierPayment.date.toISOString().slice(0, 10)}: ` +
              'la emisión no puede quedar después',
          );
        }
        // La mitad simétrica: si el que se corrige **es** una nota de crédito, no puede quedar
        // fechada antes del comprobante que acredita. Es la misma incoherencia mirada desde el
        // otro lado, y sin esto la cota de arriba solo cubría una dirección.
        // cc52 (D-645): la fecha de una NC con devolución es la de su reingreso al kardex: no se
        // cambia después (se anula la NC, que revierte la devolución, y se registra otra).
        const salesReturn =
          document.docType === FiscalDocType.NOTA_CREDITO
            ? await tx.salesReturn.findFirst({
                where: { creditNoteId: id, status: 'ACTIVE' },
                select: { seq: true },
              })
            : null;
        if (salesReturn) {
          throw new ConflictException(
            `Esta nota de crédito generó la devolución ${salesReturnCode(salesReturn.seq)}: su fecha no se cambia. Anúlala (revierte la devolución) y registra otra con la fecha correcta.`,
          );
        }
        const affected = document.affectedDocument;
        if (affected && input.issueDate < affected.issueDate.toISOString().slice(0, 10)) {
          throw new ConflictException(
            `Esta nota acredita a ${affected.number ?? 'un comprobante'} del ` +
              `${affected.issueDate.toISOString().slice(0, 10)}: no puede quedar fechada antes`,
          );
        }

        // El vencimiento se corre los mismos días que la emisión. `CONTADO` no tiene ninguno.
        const beforeDue = document.dueDate ? document.dueDate.toISOString().slice(0, 10) : null;
        const afterDue = beforeDue === null ? null : shiftDate(beforeDue, before, input.issueDate);
        if (afterDue !== beforeDue && !input.confirmDueDateShift) {
          throw new ConflictException(
            `Mover la emisión al ${input.issueDate} corre el vencimiento del ${beforeDue} al ` +
              `${afterDue}: confirmá el cambio para aplicarlo`,
          );
        }

        // D-288: los despachos creados «a la fecha del comprobante» quedarían con la fecha
        // vieja. La decisión es explícita, como la del vencimiento: sin ella no se toca nada.
        const atIssueDate = (await this.invoiceDispatch.linkedInTx(tx, id)).filter(
          (d) => d.atIssueDate,
        );
        if (atIssueDate.length > 0 && input.redateDispatches === undefined) {
          throw new ConflictException(
            `El comprobante tiene despachos a la fecha del comprobante (` +
              atIssueDate.map((d) => toDispatchCode(d.seq)).join(', ') +
              `): indicá si se re-fechan a la fecha nueva`,
          );
        }

        await tx.fiscalDocument.update({
          where: { id },
          data: {
            issueDate: toDateOnly(input.issueDate),
            dueDate: afterDue ? toDateOnly(afterDue) : null,
          },
        });
        await tx.fiscalDocumentIssueDateChange.create({
          data: {
            documentId: id,
            beforeIssueDate: toDateOnly(before),
            afterIssueDate: toDateOnly(input.issueDate),
            beforeDueDate: beforeDue ? toDateOnly(beforeDue) : null,
            afterDueDate: afterDue ? toDateOnly(afterDue) : null,
            reason: input.reason,
            changedById: actor.id,
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'invoicing.document.update-issue-date',
          entity: 'fiscal_documents',
          entityId: id,
          before: { issueDate: before, dueDate: beforeDue },
          after: {
            issueDate: input.issueDate,
            dueDate: afterDue,
            reason: input.reason,
            ...(atIssueDate.length > 0 ? { redateDispatches: input.redateDispatches } : {}),
          },
        });
        // Después de mover la fecha: el plan del despacho nuevo lee la emisión corregida.
        // Revisión de cc52 (P2): re-fechar revierte el despacho, del que una devolución ya tomó su
        // costo y su enlace: con una devolución vigente, primero se anula su NC.
        if (input.redateDispatches === true && atIssueDate.length > 0) {
          const withReturn = await tx.salesReturn.findFirst({
            where: { status: 'ACTIVE', creditNote: { affectedDocumentId: id } },
            select: { seq: true },
          });
          if (withReturn) {
            throw new ConflictException(
              `La devolución ${salesReturnCode(withReturn.seq)} salió de estos despachos: anula su nota de crédito antes de re-fecharlos`,
            );
          }
        }
        if (input.redateDispatches === true && atIssueDate.length > 0) {
          try {
            await this.invoiceDispatch.redateInTx(tx, actor, id);
          } catch (err) {
            // Los rechazos de D-288 son 400 con el motivo (kardex negativo a la fecha nueva, o el
            // despacho nuevo no sería el mismo): se reportan para la auditoría de afuera.
            if (err instanceof BadRequestException) {
              onRedateRejected(err.message);
            }
            throw err;
          }
        }
        // Revertir y volver a despachar toma los locks y el kardex de siempre: más que el
        // default de 5 s de una transacción interactiva.
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Descarta un borrador (RF-70).
   *
   * **Es la única fila de este módulo que se borra de verdad**, y puede serlo justamente
   * porque un borrador no existe fiscalmente: no tomó correlativo (D-072), no consume
   * pedido, no tiene saldo y SUNAT nunca supo de él. Todo lo demás —un rechazado, una baja,
   * un cobro revertido— se marca y se conserva, porque son hechos que ocurrieron.
   *
   * Sin esto, un borrador creado por error se quedaba en la lista para siempre: la baja
   * exige un comprobante aceptado y no había ninguna otra puerta.
   *
   * HOTFIX-401/M2: `reason` es obligatorio (el schema del controller ya lo exige) — antes
   * la auditoría quedaba con el antes del comprobante y nada de por qué se descartó.
   */
  async discardDraft(actor: RequestUser, id: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // cc30 (D-474, matriz F8): el estado `DRAFT` se lee con el comprobante ya bloqueado. Sin
      // esto, una emisión que confirmaba entre la lectura y el `DELETE` dejaba borrar un
      // comprobante ya numerado: el `DELETE` esperaba la emisión y después borraba por id.
      await lockDocuments(tx, { fiscalDocuments: [id] });
      const document = await tx.fiscalDocument.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          docType: true,
          createdById: true,
          totalPen: true,
          salesOrder: { select: { sellerId: true } },
          dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
        },
      });
      if (!document) throw new NotFoundException('Comprobante no encontrado');
      if (document.status !== FiscalDocumentStatus.DRAFT) {
        throw new BadRequestException(
          'Solo se descarta un borrador: un documento que ya tomó correlativo se da de baja, no se borra',
        );
      }
      {
        const ownerId =
          document.salesOrder?.sellerId ??
          document.dispatch?.salesOrder?.sellerId ??
          document.createdById;
        assertSellerAccess(actor, ownerId, 'Comprobante');
      }

      // La auditoría **antes** del borrado: después no quedaría a qué apuntar, y RF-95 pide
      // que la acción quede registrada aunque la fila desaparezca.
      // D-225: el motivo va en la columna `reason` de D-218, no dentro de `before` — `before`
      // es el estado previo del comprobante, y el visor muestra el motivo en su propia
      // columna. Las filas escritas entre el deploy de `ca6314d` y este cambio lo tienen en
      // `before.reason`; no se reescriben (audit_log es append-only, D-221).
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'invoicing.document.discard-draft',
        entity: 'fiscal_documents',
        entityId: id,
        before: { docType: document.docType, totalPen: document.totalPen.toFixed(4) },
        reason,
      });
      // F8-S7/M3: soltar el enlace de D-205 **antes** de borrar. `dispatches.invoice_id` es
      // `ON DELETE RESTRICT`, así que un borrador que declaró un despacho no se podía
      // descartar por ningún camino: el delete moría con un P2003 y el comprobante quedaba
      // atascado en la lista para siempre. Las líneas sí caen por `onDelete: Cascade`.
      await this.inventory.unlinkInvoiceFromDispatches(tx, id);
      await tx.fiscalDocument.delete({ where: { id } });
    });
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
        include: {
          items: { orderBy: { lineNumber: 'asc' } },
          salesOrder: { select: { sellerId: true } },
          dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
        },
      });
      if (!rejected) throw new NotFoundException('Comprobante no encontrado');
      if (rejected.status !== FiscalDocumentStatus.REJECTED) {
        throw new BadRequestException('Solo se corrige un comprobante rechazado');
      }
      {
        const ownerId =
          rejected.salesOrder?.sellerId ??
          rejected.dispatch?.salesOrder?.sellerId ??
          rejected.createdById;
        assertSellerAccess(actor, ownerId, 'Comprobante');
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
    // D-216/M0d: acá y no en `assignInTx`/`assign`, que el mostrador también usa
    // (D-099) **dentro** de la transacción atómica de la venta — esa vía tiene que seguir
    // completando la venta con el PSE apagado o caído (D-073, "la operación nunca para por
    // el PSE"); rechazar ahí adentro la revertiría entera. `send()` es la emisión
    // **standalone** de un borrador ya creado (botón "Emitir"), sin nada más atado.
    this.assertPseEnabled();
    await this.assertOwnership(actor, id, 'emitirlo');
    await this.assign(actor, id);
    await this.deliver(id);
    return this.findOne(id);
  }

  /**
   * RF-S3c: el vendedor solo opera sobre **sus propios** comprobantes (vía sellerId del
   * pedido). El administrador y otros roles (planta) pasan sin restricción.
   */
  private async assertOwnership(actor: RequestUser, id: string, _action: string): Promise<void> {
    if (actor.role !== Role.VENDEDOR) return;
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      select: {
        createdById: true,
        salesOrder: { select: { sellerId: true } },
        dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
      },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    const ownerId =
      document.salesOrder?.sellerId ??
      document.dispatch?.salesOrder?.sellerId ??
      document.createdById;
    assertSellerAccess(actor, ownerId, 'Comprobante');
  }

  /**
   * cc33 N3: bloquea el documento y, si es una nota de crédito, su afectado, **en una sola llamada**
   * a la puerta: los dos son comprobantes y `lockDocuments` los toma por id ascendente (regla 17,
   * D-471). El afectado se lee antes sin bloquear: `affected_document_id` no cambia nunca.
   */
  private async lockWithAffected(tx: Prisma.TransactionClient, id: string): Promise<string[]> {
    const head = await tx.fiscalDocument.findUnique({
      where: { id },
      select: { affectedDocumentId: true },
    });
    const ids = head?.affectedDocumentId ? [id, head.affectedDocumentId] : [id];
    return (await lockDocuments(tx, { fiscalDocuments: ids })).fiscalDocuments.filter(
      (locked) => locked === id,
    );
  }

  /** Fase 1: correlativo y estado `ISSUED`, en su propia transacción. */
  private async assign(actor: RequestUser, id: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.assignInTx(tx, actor, id));
  }

  /**
   * La fase 1 de D-073 **dentro de una transacción que abre el llamador**.
   *
   * El mostrador (D-099) la usa para que el correlativo se tome en la misma transacción que
   * el pedido, el despacho y el cobro. Eso **no** contradice a D-073: lo que esa decisión
   * exige es que el envío al PSE quede **fuera** de la transacción que toma el número, y
   * sigue quedando fuera — el POS confirma primero y llama a `deliver` después, igual que
   * `send`. Lo que cambia es cuánto abarca esa primera transacción, no su orden.
   */
  async assignInTx(tx: Prisma.TransactionClient, actor: RequestUser, id: string): Promise<void> {
    await this.lockWithAffected(tx, id);
    const found = await tx.fiscalDocument.findUnique({
      where: { id },
      select: { id: true, status: true, docType: true },
    });
    if (!found) throw new NotFoundException('Comprobante no encontrado');
    const head = { id: found.id, status: found.status, doc_type: found.docType };
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
        items: {
          select: {
            id: true,
            qty: true,
            totalPen: true,
            salesOrderItemId: true,
            affectedItemId: true,
          },
        },
        affectedDocument: {
          select: { docType: true, origin: true, number: true, status: true, archivedAt: true },
        },
      },
    });
    if (document.items.length === 0 && document.docType !== FiscalDocType.GUIA_REMISION_REMITENTE) {
      throw new BadRequestException('Un comprobante sin líneas no se emite');
    }
    // D-153: una nota de crédito hereda el modo de su afectado. Emitir electrónicamente la NC
    // de una factura que salió de la otra app dejaría a SUNAT con una nota de crédito sobre un
    // comprobante que este ERP nunca le mandó.
    if (document.affectedDocument?.origin === FiscalDocumentOrigin.MANUAL) {
      throw new BadRequestException(
        `${document.affectedDocument.number ?? 'El comprobante afectado'} es manual: su nota de crédito se registra manual, no se emite`,
      );
    }
    // cc33 N3: el afectado, ya bloqueado junto con la nota, tiene que seguir aceptado y vigente.
    if (document.affectedDocument !== null)
      assertAffectedStillCreditable(document.affectedDocument);
    // cc52 (D-646): la devolución automática nace al **registrar** la NC a mano (Nubefact está
    // fuera del alcance); una NC electrónica de devolución quedaría sin su reingreso.
    if (
      document.docType === FiscalDocType.NOTA_CREDITO &&
      isReturnCreditNoteReason(document.creditNoteReason)
    ) {
      throw new BadRequestException(
        'Una nota de crédito de devolución de mercadería se registra a mano: el reingreso al kardex se genera al registrarla',
      );
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
      // Obligatorios a propósito (cc33, revisión P2): un llamador que los recortara con un
      // `select` apagaría en silencio la comprobación del pedido.
      salesOrderId: string | null;
      customerId: string;
      /** cc54 (D-663): una NC de cantidad se mide en unidades; las demás, en importe. */
      creditNoteReason: string | null;
      items: {
        qty: Prisma.Decimal;
        totalPen: Prisma.Decimal;
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
        select: { id: true, lineNumber: true, qty: true, totalPen: true },
      });
      // cc54 (D-663): la cantidad la consumen solo los motivos de cantidad; el importe, todos.
      const others = await tx.fiscalDocumentItem.findMany({
        where: {
          affectedItemId: { in: ids },
          documentId: { not: document.id },
          document: { status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
        },
        select: {
          affectedItemId: true,
          qty: true,
          subtotalPen: true,
          igvPen: true,
          totalPen: true,
          document: { select: { creditNoteReason: true } },
        },
      });
      const done = creditsByLine(others, creditsQty);
      const byQty = creditsQty(document.creditNoteReason);
      for (const item of document.items) {
        if (!item.affectedItemId) continue;
        const original = originals.find((o) => o.id === item.affectedItemId);
        if (!original) continue;
        const c = done.get(original.id);
        if (byQty) {
          const available = toDecimal(original.qty.toString()).minus(c?.qty ?? new Decimal(0));
          if (toDecimal(item.qty.toString()).gt(available)) {
            throw new ConflictException(
              `Otra nota de crédito ya acreditó la línea ${original.lineNumber}: quedan ${available.toFixed(3)}. Revisa este borrador antes de emitirlo.`,
            );
          }
        } else {
          const credited = c ? c.byQty.total.plus(c.byAmount.total) : new Decimal(0);
          const left = toDecimal(original.totalPen.toString()).minus(credited);
          if (toDecimal(item.totalPen.toString()).gt(left)) {
            throw new ConflictException(
              `Otra nota de crédito ya acreditó la línea ${original.lineNumber}: le quedan S/ ${left.toFixed(2)}. Revisa esta nota antes de registrarla.`,
            );
          }
        }
      }
      return;
    }

    // cc33 N4: estado y cliente del pedido **antes** de la salida temprana. Un borrador de solo
    // líneas libres no tiene ids de línea de pedido, y salía acá sin mirar si el pedido se anuló
    // o es de otro cliente.
    if (document.salesOrderId) {
      const order = await tx.salesOrder.findUnique({
        where: { id: document.salesOrderId },
        select: { seq: true, status: true, customerId: true },
      });
      if (order?.status === 'CANCELLED') {
        throw new ConflictException(
          `El pedido ${salesOrderCode(order.seq)} está anulado: este borrador ya no se registra ni se emite. Descártalo`,
        );
      }
      if (order && order.customerId !== document.customerId) {
        throw new ConflictException(
          `El pedido ${salesOrderCode(order.seq)} es de otro cliente: este borrador ya no se registra ni se emite. Descártalo`,
        );
      }
    }
    const ids = document.items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []));
    if (ids.length === 0) return;
    const orderItems = await tx.salesOrderItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        lineNumber: true,
        qty: true,
        salesOrder: { select: { seq: true, status: true } },
      },
    });
    // D-383: anular un pedido exige que no tenga comprobante vivo, pero un borrador creado antes
    // de anularlo podía registrarse o emitirse después y dejar un comprobante vivo sobre un
    // pedido anulado (así nació FFA1-00001389, D-381). Crear el borrador ya lo impedía
    // (`resolveLines`); este es el último punto en el que se puede decir que no. La anulación
    // toma el lock de los borradores del pedido, así que este control ve el estado ya escrito.
    const cancelled = orderItems.find((o) => o.salesOrder.status === 'CANCELLED');
    if (cancelled) {
      throw new ConflictException(
        `El pedido ${salesOrderCode(cancelled.salesOrder.seq)} está anulado: este borrador ya no se registra ni se emite. Descártalo`,
      );
    }
    // D-346: la misma función neta de NC que el guard de creación; con otra, un borrador que
    // pasó la creación después de una NC se rechazaba justo al emitir.
    const invoicedById = await withReturnedQty(
      tx,
      await invoicedByOrderItem(tx, ids, { excludeDocumentId: document.id }),
      ids,
    );
    for (const item of document.items) {
      if (!item.salesOrderItemId) continue;
      const orderItem = orderItems.find((o) => o.id === item.salesOrderItemId);
      if (!orderItem) continue;
      const available = toDecimal(orderItem.qty.toString()).minus(
        invoicedById.get(orderItem.id)?.qty ?? new Decimal(0),
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
    /**
     * **Reenviar o consultar**, y el criterio no puede ser el ticket.
     *
     * Un documento que el PSE ya recibió y que espera a SUNAT **no siempre trae ticket**:
     * boletas y guías vuelven `PENDING` sin él. Decidir por el ticket hacía que el barrido
     * los reemitiera con la misma serie y correlativo, el PSE los devolviera como
     * duplicados y eso sí se leyera como rechazo terminal — el barrido destruía justo lo
     * que venía a rescatar.
     *
     * El estado ya lo dice, y es lo que hay que mirar:
     * - `SEND_ERROR` — el envío **nunca entró**. Se reenvía.
     * - `ISSUED` con intentos previos — la última respuesta fue `PENDING`, o sea que el
     *   PSE lo tiene. Se consulta.
     * - `ISSUED` sin intentos — recién numerado por `assign`. Se envía por primera vez.
     *
     * `document.sendAttempts` se lee **antes** del reclamo, así que todavía es el contador
     * previo a este intento.
     */
    const alreadyAtProvider =
      document.status === FiscalDocumentStatus.ISSUED &&
      (document.sendAttempts > 0 || document.providerTicket !== null);

    // Consultar no es un intento de envío: no sube el contador.
    if (!(await this.claimAttempt(id, { counts: !alreadyAtProvider }))) return;

    // **Nunca lanza**, y la garantía es de este método, no del adaptador: cualquier fallo
    // acá —incluido el de escribir el resultado— subiría por `send` hasta el usuario como
    // un 500 sobre un documento que ya tomó correlativo, que es exactamente lo que D-073
    // existe para evitar.
    try {
      const result = alreadyAtProvider
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
   * Reclama la salida a la red antes de hacerla (D-073).
   *
   * `applyResult` protege la **escritura** del resultado, pero no la llamada: dos
   * reintentos simultáneos —uno manual y el barrido del job, por ejemplo— leían el mismo
   * estado y llamaban al PSE dos veces con el mismo correlativo. Este `updateMany`
   * condicionado es lo que hace que solo uno de los dos salga; el otro ve cero filas
   * afectadas y se retira.
   *
   * **`counts` decide si además sube el contador de intentos**, y la distinción importa:
   * `sendAttempts` está para separar "todavía no salió" de "salió y no entra", así que
   * sumarle las **consultas** —que no emiten nada— diluye justo la pregunta que responde.
   * Solo cuenta la emisión real.
   */
  private async claimAttempt(id: string, options: { counts: boolean }): Promise<boolean> {
    const claimed = await this.prisma.fiscalDocument.updateMany({
      where: { id, status: { in: RETRYABLE } },
      data: {
        ...(options.counts ? { sendAttempts: { increment: 1 } } : {}),
        lastAttemptAt: new Date(),
      },
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
        // D-255 (R2): al PSE va el unitario **derivado del importe** con diez decimales —lo
        // que acepta `valor_unitario` según el manual JSON v3.0 de Nubefact—, no los cuatro
        // guardados para mostrar: 3.0508 × 3840 no es 11 715.254 y el PSE valida coherencia.
        unitPricePen: derivedUnitValue(i.qty.toString(), i.subtotalPen.toString()).toFixed(
          DERIVED_UNIT_VALUE_DECIMALS,
        ),
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
        // Se avisa con el host para que un cambio de dominio del proveedor se vea en los
        // logs en vez de manifestarse como "los comprobantes no tienen PDF".
        this.logger.warn(
          `El PSE devolvió un enlace de ${ext} en un host no admitido: ${new URL(url).host}`,
        );
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

  /** Hosts admitidos para los archivos, tal como los declara el proveedor atado. */
  private providerHosts(): readonly string[] {
    return this.provider.fileHosts;
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
      // Una **lista** y no un solo host: el PSE sirve los archivos firmados desde un
      // dominio distinto al de su API (`www.…` frente a `api.…`), y exigir el mismo host
      // hacía que ningún PDF, XML ni CDR se guardara nunca — en silencio, salvo por una
      // línea de log. Sin ellos no hay papel que mandarle al cliente ni CDR que mostrar en
      // un requerimiento.
      return this.providerHosts().includes(target.host);
    } catch {
      return false;
    }
  }

  /** Reintento manual del envío (D-073). El job hace lo mismo, sin usuario. */
  async retry(actor: RequestUser, id: string): Promise<FiscalDocumentDto> {
    this.assertPseEnabled();
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
    if (!this.env.PSE_ENABLED) return 0;
    const settings = await this.settingsRow();
    if (settings.providerOffline) return 0;

    const pending = await this.prisma.fiscalDocument.findMany({
      // `origin` es redundante hoy —un importado nace `ACCEPTED` y nunca está en RETRYABLE—
      // y está igual: el día que un importado pueda quedar en otro estado, el job no puede
      // ser el que se entere mandándolo al PSE.
      where: {
        status: { in: RETRYABLE },
        number: { not: null },
        origin: FiscalDocumentOrigin.ISSUED_HERE,
      },
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
    this.assertPseEnabled();
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: documentInclude,
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    assertIssuedHere(document, 'consultar su estado en el PSE');
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
      // cc34 (revisiones del corte 3): mientras la llamada que abrió la baja siga hablando con el PSE
      // no se consulta. Un «rechazo» de una baja que todavía no llegó devolvía la factura a aceptada
      // y la llamada original ya no podía registrar la baja que SUNAT sí recibió.
      if ((await this.voidMarkState(this.prisma, id, document.voidRequestedAt)) === 'IN_FLIGHT') {
        throw new BadRequestException(VOID_IN_FLIGHT_MESSAGE);
      }
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
      // Para una **guía** esta consulta es más que una reconciliación: es la única salida.
      // La operación de baja del proveedor no reconoce una GRE ya aceptada, así que darla
      // de baja se hace en su panel — y sin esto el sistema nunca se enteraba, dejando el
      // despacho bloqueado para siempre por una guía que ya no existe.
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
    this.assertPseEnabled();
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      include: {
        seriesRef: { select: { series: true } },
        payments: { where: { reversedAt: null }, select: { id: true } },
        creditNotes: {
          where: { status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
          select: { number: true },
        },
      },
    });
    if (!document) throw new NotFoundException('Comprobante no encontrado');
    assertIssuedHere(document, 'darlo de baja');
    if (document.status === FiscalDocumentStatus.VOIDED) {
      throw new ConflictException('El comprobante ya está anulado');
    }
    // cc34 (revisiones del corte 3): una baja en trámite solo se reintenta si su marca quedó
    // **huérfana** —la llamada que la abrió no dejó resultado (el proceso se cayó a mitad)— y ya es
    // vieja. Si la baja se está comunicando o ya se comunicó, se consulta al PSE.
    let retryingOrphan = false;
    if (document.status === FiscalDocumentStatus.VOID_PENDING) {
      const mark = await this.voidMarkState(this.prisma, id, document.voidRequestedAt);
      if (mark !== 'ORPHAN') {
        throw new BadRequestException(
          mark === 'IN_FLIGHT'
            ? VOID_IN_FLIGHT_MESSAGE
            : 'La baja ya está en trámite ante SUNAT: usa «Consultar al PSE» para saber si la aceptó',
        );
      }
      retryingOrphan = true;
    } else if (document.status !== FiscalDocumentStatus.ACCEPTED) {
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
    // cc33 N3: un borrador de nota de crédito también bloquea la baja, nombrándolo.
    const draftBlock = await draftCreditNoteBlock(this.prisma, id, 'antes de darlo de baja');
    if (draftBlock) throw new BadRequestException(draftBlock);

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

    // cc34 (arreglo de fondo de D-536, D-542): **la baja queda en trámite antes de hablar con el
    // PSE**, en su propia transacción y con la fila bloqueada. Mientras esté `VOID_PENDING` no se
    // crea, registra ni envía una nota de crédito sobre la factura (`createCreditNote`,
    // `assertAffectedStillCreditable`): ya no puede entrar una NC mientras SUNAT procesa la baja.
    const requestedAt = new Date();
    const fromStatus = retryingOrphan
      ? FiscalDocumentStatus.VOID_PENDING
      : FiscalDocumentStatus.ACCEPTED;
    await this.prisma.$transaction(async (tx) => {
      await lockDocuments(tx, { fiscalDocuments: [id] });
      const live = await tx.fiscalDocument.findUnique({
        where: { id },
        select: { status: true, voidRequestedAt: true },
      });
      if (
        live?.status !== fromStatus ||
        (retryingOrphan && live.voidRequestedAt?.getTime() !== document.voidRequestedAt?.getTime())
      ) {
        throw new ConflictException('El comprobante cambió de estado mientras se daba de baja');
      }
      if ((await tx.customerPayment.count({ where: { documentId: id, reversedAt: null } })) > 0) {
        throw new BadRequestException(
          'El comprobante tiene cobros vigentes: revierte los cobros antes de darlo de baja',
        );
      }
      const notes = await tx.fiscalDocument.count({
        where: { affectedDocumentId: id, status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
      });
      if (notes > 0) {
        throw new BadRequestException(
          'El comprobante ya tiene nota de crédito: su saldo ya está ajustado',
        );
      }
      const lateDraft = await draftCreditNoteBlock(tx, id, 'antes de darlo de baja');
      if (lateDraft) throw new BadRequestException(lateDraft);
      const marked = await tx.fiscalDocument.updateMany({
        where: {
          id,
          status: fromStatus,
          ...(retryingOrphan ? { voidRequestedAt: document.voidRequestedAt } : {}),
        },
        data: {
          status: FiscalDocumentStatus.VOID_PENDING,
          voidRequestedAt: requestedAt,
          voidedById: actor.id,
        },
      });
      if (marked.count !== 1) {
        throw new ConflictException('El comprobante cambió de estado mientras se daba de baja');
      }
      await this.audit.write(tx, {
        actorId: actor.id,
        action: VOID_AUDIT.REQUESTED,
        entity: 'fiscal_documents',
        entityId: id,
        before: { status: fromStatus, number: document.number },
        after: { status: FiscalDocumentStatus.VOID_PENDING, reason, retryingOrphan },
      });
    });

    // Si la baja no llegó a SUNAT, la marca se quita y la factura vuelve a estar aceptada. Solo si
    // sigue puesta la marca **de esta llamada**: nunca se pisa un estado que otro camino escribió.
    const release = async (outcome: string): Promise<boolean> =>
      this.prisma.$transaction(async (tx) => {
        await lockDocuments(tx, { fiscalDocuments: [id] });
        const released = await tx.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.VOID_PENDING, voidRequestedAt: requestedAt },
          data: {
            status: FiscalDocumentStatus.ACCEPTED,
            voidRequestedAt: retryingOrphan ? null : document.voidRequestedAt,
            voidedById: retryingOrphan ? null : document.voidedById,
          },
        });
        if (released.count !== 1) return false;
        await this.audit.write(tx, {
          actorId: actor.id,
          action: VOID_AUDIT.RELEASED,
          entity: 'fiscal_documents',
          entityId: id,
          before: { status: FiscalDocumentStatus.VOID_PENDING },
          after: { status: FiscalDocumentStatus.ACCEPTED, outcome },
        });
        return true;
      });
    const notReleased =
      'El comprobante cambió de estado mientras se comunicaba la baja: usa «Consultar al PSE» para ver dónde quedó';

    const result = await this.callProvider(() =>
      this.provider.voidDocument({
        docType: document.docType,
        series: document.seriesRef?.series ?? '',
        correlative: document.correlative ?? 0,
        reason,
      }),
    );

    if (result.outcome === 'ERROR') {
      // Decisión del dueño (cc34): si la llamada falla, la marca se quita. Como antes de cc34, el
      // mensaje avisa que la baja pudo llegar igual (D-542, riesgo aceptado).
      if (!(await release('ERROR'))) throw new ConflictException(notReleased);
      throw new ConflictException(
        `No se pudo comunicar la baja al PSE: ${result.message ?? 'sin detalle'}. El comprobante sigue vigente; vuelve a intentarlo, o usa «Consultar al PSE» si sospechas que la baja sí llegó.`,
      );
    }
    if (result.outcome === 'REJECTED') {
      if (!(await release('REJECTED'))) throw new ConflictException(notReleased);
      throw new BadRequestException(`El PSE rechazó la baja: ${result.message ?? 'sin detalle'}`);
    }

    const now = new Date();
    const conflict = await this.prisma.$transaction(async (tx): Promise<string | null> => {
      // Los guardrails se revalidan **con la fila bloqueada**: entre la comprobación de
      // arriba y esta escritura pasó una llamada al PSE de hasta un minuto, y en esa
      // ventana alguien pudo registrar un cobro (la marca de trámite no los frena) o, con un
      // registro anterior a cc34, emitir una nota de crédito.
      await lockDocuments(tx, { fiscalDocuments: [id] });
      // cc34 (revisiones): un conflicto ya no deshace lo que el PSE contestó. La baja quedó en
      // trámite con su ticket y su respuesta, y la auditoría lo dice; se cierra consultando al PSE.
      const keepPending = async (message: string): Promise<string> => {
        await tx.fiscalDocument.updateMany({
          where: { id, status: FiscalDocumentStatus.VOID_PENDING, voidRequestedAt: requestedAt },
          data: {
            providerTicket: result.ticket,
            providerResponse: result.raw ?? {},
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: VOID_AUDIT.CONFLICT,
          entity: 'fiscal_documents',
          entityId: id,
          before: { status: FiscalDocumentStatus.VOID_PENDING, number: document.number },
          after: { outcome: result.outcome, reason, conflict: message },
        });
        return message;
      };
      const livePayments = await tx.customerPayment.count({
        where: { documentId: id, reversedAt: null },
      });
      if (livePayments > 0) {
        return keepPending(
          'Se registró un cobro mientras se comunicaba la baja: la baja quedó en trámite ante SUNAT. Revierte el cobro y usa «Consultar al PSE» para cerrarla',
        );
      }
      // cc33 N3: el comentario de arriba promete también las notas de crédito, y solo se contaban
      // los cobros. Una nota **viva** que entró mientras se hablaba con el PSE corta igual que un
      // cobro (D-536: la baja ya se comunicó; se resuelve consultando al PSE). Un **borrador**
      // tardío no corta: con el comprobante dado de baja ya no se registra ni se emite
      // (`assertAffectedStillCreditable`), y rechazar acá dejaría al ERP sin la baja que SUNAT ya
      // aceptó (revisiones de cc33, corte 3).
      const liveNotes = await tx.fiscalDocument.count({
        where: {
          affectedDocumentId: id,
          status: { in: LIVE_DOCUMENT_STATUSES },
          archivedAt: null,
        },
      });
      if (liveNotes > 0) {
        return keepPending(
          'Se emitió una nota de crédito mientras se comunicaba la baja: la baja ya se comunicó al PSE pero no se registró acá. Usa «Consultar al PSE» y revisa la nota de crédito',
        );
      }

      // La baja sale del trámite que esta misma llamada abrió (`voidRequestedAt`).
      const updated = await tx.fiscalDocument.updateMany({
        where: { id, status: FiscalDocumentStatus.VOID_PENDING, voidRequestedAt: requestedAt },
        data:
          result.outcome === 'ACCEPTED'
            ? {
                status: FiscalDocumentStatus.VOIDED,
                voidedAt: now,
                voidedById: actor.id,
                providerTicket: result.ticket,
                providerResponse: (result.raw ?? {}) as Prisma.InputJsonValue,
              }
            : {
                // `PENDING`: hay ticket y SUNAT todavía no confirmó. Marcarlo anulado acá
                // sería declarar por SUNAT algo que SUNAT no dijo: sigue en trámite.
                status: FiscalDocumentStatus.VOID_PENDING,
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
        action: VOID_AUDIT.DONE,
        entity: 'fiscal_documents',
        entityId: id,
        before: { status: FiscalDocumentStatus.VOID_PENDING, number: document.number },
        after: { outcome: result.outcome, reason },
      });
      return null;
    });
    if (conflict !== null) throw new ConflictException(conflict);

    return this.findOne(id);
  }

  /**
   * cc34 (D-542): en qué quedó la marca de una baja en trámite, leído de la auditoría de las bajas.
   * - `COMMUNICATED`: la última llamada dejó resultado (o es un trámite anterior a cc34): se
   *   resuelve consultando al PSE.
   * - `IN_FLIGHT`: la llamada que la abrió todavía puede estar hablando con el PSE.
   * - `ORPHAN`: la llamada que la abrió no dejó resultado y ya pasó su tiempo (el proceso se cayó
   *   a mitad): la baja se puede reintentar.
   */
  private async voidMarkState(
    client: Prisma.TransactionClient | PrismaService,
    id: string,
    voidRequestedAt: Date | null,
  ): Promise<'COMMUNICATED' | 'IN_FLIGHT' | 'ORPHAN'> {
    const last = await client.auditLog.findFirst({
      where: {
        entity: 'fiscal_documents',
        entityId: id,
        action: { in: Object.values(VOID_AUDIT) },
      },
      orderBy: { at: 'desc' },
      select: { action: true },
    });
    if (last?.action !== VOID_AUDIT.REQUESTED) return 'COMMUNICATED';
    const age = Date.now() - (voidRequestedAt?.getTime() ?? 0);
    return age < VOID_IN_FLIGHT_MS ? 'IN_FLIGHT' : 'ORPHAN';
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
    this.assertPseEnabled();
    const documentId = await this.prisma.$transaction(async (tx) => {
      // F8-S1/M2: el mismo lock que `DispatchesService.reverse` sobre esta tabla. Sin él,
      // dos clicks en "Emitir guía" leían los dos `dispatch.documents` sin ninguna vigente
      // todavía, pasaban los dos el chequeo de abajo y cada uno creaba su propio borrador
      // —y su propio correlativo— para el mismo despacho: dos guías electrónicas vigentes
      // para un solo traslado físico.
      await lockDocuments(tx, { dispatches: [dispatchId] });
      const dispatch = await tx.dispatch.findUnique({
        where: { id: dispatchId },
        include: {
          salesOrder: { select: { id: true, customerId: true, sellerId: true } },
          documents: { select: { id: true, number: true, status: true } },
        },
      });
      if (!dispatch) throw new NotFoundException('Despacho no encontrado');
      assertSellerAccess(actor, dispatch.salesOrder.sellerId, 'Despacho');
      if (dispatch.status !== DispatchStatus.ISSUED) {
        throw new BadRequestException('Un despacho revertido no tiene guía que emitir');
      }
      // D-103: en un recojo en mostrador el traslado lo hace el comprador con su propio
      // medio, así que el remitente no emite guía —no hay transportista contratado ni
      // vehículo nuestro que declarar, y el catálogo 18 de SUNAT no tiene un código para
      // esta modalidad justamente porque nunca llega a un documento—.
      if (!GRE_TRANSFER_MODES.includes(dispatch.transferMode)) {
        throw new BadRequestException(
          'Este despacho es un recojo en mostrador: el traslado es del comprador y no genera guía de remisión remitente',
        );
      }
      // Una guía **rechazada o dada de baja** no es la guía del traslado: se puede emitir
      // otra. Solo bloquea la que sigue en pie.
      // **Con el borrador dentro**: una guía nace `DRAFT` y solo después toma número, así
      // que un fallo entremedio la deja así para siempre. Con el corte en los vivos a secas,
      // reintentar habría creado una segunda guía para el mismo despacho.
      const live = dispatch.documents.find((d) => STANDING_DOCUMENT_STATUSES.includes(d.status));
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
    return this.findOne(documentId, actor);
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

    const dispatch = document.dispatch;
    // D-103: un recojo en mostrador no llega a tener guía —`issueDispatchNote` lo rechaza
    // antes de crear el borrador—, así que esta rama solo puede darse si alguien creó la
    // guía y después cambió la modalidad del despacho. Se corta acá antes de gastar un
    // intento contra el PSE con una modalidad que su catálogo no tiene.
    if (!GRE_TRANSFER_MODES.includes(dispatch.transferMode)) {
      throw new BadRequestException(
        'Este despacho es un recojo en mostrador: no corresponde una guía de remisión remitente',
      );
    }
    const transferMode = dispatch.transferMode as Exclude<TransferMode, 'PICKUP'>;
    // El comprobante que respalda el traslado, si el pedido ya tiene uno aceptado.
    //
    // D-153: **solo uno que el ERP haya emitido**. Un manual está aceptado y es del mismo
    // pedido, pero SUNAT no lo recibió de nosotros: ponerlo en la guía sería declarar un
    // respaldo que del otro lado no existe. Además no tiene `accepted_at`, y Postgres ordena
    // `DESC` con `NULLS FIRST`, así que ganaba el desempate y desplazaba a la factura
    // electrónica del mismo pedido que sí podía ir.
    const related = await this.prisma.fiscalDocument.findFirst({
      where: {
        salesOrderId: dispatch.salesOrder.id,
        status: FiscalDocumentStatus.ACCEPTED,
        origin: FiscalDocumentOrigin.ISSUED_HERE,
        docType: { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] },
      },
      orderBy: { acceptedAt: 'desc' },
      include: { seriesRef: { select: { series: true } } },
    });

    // Igual que `deliver`: la garantía de que un fallo del PSE no se convierte en un error
    // del usuario es de este servicio, no del adaptador (D-073). Acá pesa más que en
    // ningún otro lado, porque del otro lado del envío hay un camión esperando.
    // Mismo criterio que `deliver`: si el PSE ya la tiene, se consulta en vez de
    // reemitirla con el mismo correlativo, y consultar no cuenta como intento de envío.
    const noteAlreadyAtProvider =
      document.status === FiscalDocumentStatus.ISSUED &&
      (document.sendAttempts > 0 || document.providerTicket !== null);
    if (!(await this.claimAttempt(id, { counts: !noteAlreadyAtProvider }))) return;
    if (noteAlreadyAtProvider) {
      const queried = await this.callProvider(() =>
        this.provider.queryStatus({
          docType: document.docType,
          series: document.seriesRef?.series ?? '',
          correlative: document.correlative ?? 0,
        }),
      );
      await this.applyResult(id, queried);
      if (queried.outcome === 'ACCEPTED') await this.storeFiles(id, document.number, queried);
      return;
    }

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
        transferMode,
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
    // D-216/M0d: la mitad silenciosa del gate. Los puntos de entrada de arriba
    // (`send`/`retry`/`refreshStatus`/`voidDocument`/`issueDispatchNote`) rechazan con
    // `assertPseEnabled` antes de llegar acá, pero `deliver`/`deliverAny`/`sendPending`
    // también pasan por acá **fuera** de la transacción que abrió el mostrador (D-073: "la
    // operación nunca para por el PSE") — ahí no se puede lanzar. Con el flag apagado, esto
    // deja el resultado exactamente como si no hubiera credenciales (`NullInvoicingProvider`,
    // mismo `code`), en vez de arriesgarse a que un `NUBEFACT_URL`/`TOKEN` configurado por
    // error mientras el flag está apagado igual le hable al proveedor real.
    if (!this.env.PSE_ENABLED) {
      return {
        outcome: 'ERROR',
        ticket: null,
        sunatHash: null,
        pdfUrl: null,
        xmlUrl: null,
        cdrUrl: null,
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Emisión electrónica no habilitada en este entorno',
        raw: { reason: 'PSE_ENABLED=false' },
      };
    }
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
    actor: RequestUser,
    salesOrderId: string,
    options: { withPrices: boolean } = { withPrices: true },
  ): Promise<SalesOrderProgressDto> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      include: {
        customer: { select: { name: true } },
        items: {
          orderBy: { lineNumber: 'asc' },
          include: {
            product: {
              select: {
                sku: true,
                unit: true,
                thicknessMm: true,
                widthMm: true,
                lengthMm: true,
                pieceWeightKg: true,
                finish: { select: { densityFactor: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    assertSellerAccess(actor, order.sellerId, 'Pedido');

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

    // Solo los comprobantes vivos, **netos de las notas de crédito vivas** de cada línea
    // (D-346, deuda de D-223): lo que una NC devolvió vuelve a quedar pendiente de facturar.
    // Es la misma función que usa el guard de `resolveLines`, para que la pantalla y el tope
    // no puedan discrepar.
    const invoicedByItem = await withReturnedQty(
      this.prisma,
      await invoicedByOrderItem(this.prisma, itemIds),
      itemIds,
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
        const invoicedQty = invoicedByItem.get(item.id)?.qty ?? new Decimal(0);
        // F8-S1/M3: kg teórico por unidad de venta, para que el formulario de despacho
        // proponga el peso de línea sin que el usuario tenga que calcularlo. Cobertura por
        // metro o de largo fijo (D-118): geometría del producto. Drywall: su
        // `pieceWeightKg` declarado, porque su sección no es un prisma simple.
        const weightKgPerUnit =
          theoreticalKgPerSellingUnit({
            unit: item.product.unit,
            thicknessMm: item.product.thicknessMm?.toFixed(2) ?? null,
            widthMm: item.product.widthMm?.toFixed(2) ?? null,
            lengthMm: item.product.lengthMm?.toFixed(2) ?? null,
            densityFactor: item.product.finish?.densityFactor.toFixed(4) ?? null,
          })?.toFixed(3) ??
          item.product.pieceWeightKg?.toFixed(3) ??
          null;
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
          weightKgPerUnit,
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
    // D-134: una línea a medida está respaldada por un agregado hasta que la producción la
    // convierte en producto terminado (D-088). Sin esta rama se mostraba como "—" en el
    // progreso del pedido y en el armado del despacho.
    const specIds = items
      .filter((i) => i.reserveItemType === 'RAW_MATERIAL')
      .map((i) => i.reserveItemId);
    if (specIds.length > 0) {
      for (const [id, label] of await rawMaterialSpecLabels(this.prisma, specIds)) {
        out.set(`RAW_MATERIAL:${id}`, label);
      }
    }
    return out;
  }

  async findAll(
    query: FiscalDocumentQuery,
    actor?: RequestUser,
  ): Promise<PaginatedResult<FiscalDocumentListItemDto>> {
    const { items, total } = await this.findWindow(query, actor, pageWindow(query));
    return paginate(items, total, query);
  }

  /**
   * cc26 (D-provisional): el Excel de la lista. Las mismas filas que `findAll` con la misma
   * query, todas y en el mismo orden: es el mismo método con la ventana completa. Pasado el tope
   * (`LIST_XLSX_MAX_ROWS`), 400.
   */
  async exportAll(
    query: FiscalDocumentExportQuery,
    actor?: RequestUser,
  ): Promise<FiscalDocumentListItemDto[]> {
    return (await this.findWindow(query, actor, exportWindow())).items;
  }

  /** El cuerpo de la lista y de su Excel: filtro, alcance y orden, sobre una ventana de filas. */
  private async findWindow(
    query: FiscalDocumentExportQuery,
    actor: RequestUser | undefined,
    window: ListWindow,
  ): Promise<{ items: FiscalDocumentListItemDto[]; total: number }> {
    const where = fiscalDocumentListWhere(query, actor, LIVE_DOCUMENT_STATUSES);
    // D-323: la columna elegida ordena la lista entera (también con `pendingOnly`, antes del tope);
    // la fecha de emisión desempata. Solo columnas propias: el saldo es derivado.
    const orderBy = fiscalDocumentOrderBy(query);

    if (!query.pendingOnly) {
      const { skip, take } = window;
      const findPage = () =>
        this.prisma.fiscalDocument.findMany({
          where,
          include: documentInclude,
          // D-124: por fecha de emisión — la fecha de operación de un comprobante, la misma
          // que trae un importado (RF-71) y la que usan los reportes de ventas.
          orderBy,
          skip,
          take,
        });
      let total: number;
      let rows: Awaited<ReturnType<typeof findPage>>;
      if (window.maxTotal === undefined) {
        [total, rows] = await Promise.all([
          this.prisma.fiscalDocument.count({ where }),
          findPage(),
        ]);
      } else {
        // cc26: la exportación cuenta primero y corta antes de cargar filas si pasa el tope.
        total = await this.prisma.fiscalDocument.count({ where });
        assertExportable(total, window);
        rows = await findPage();
      }
      return { items: await this.withDispatchLinks(await this.toListDtos(rows)), total };
    }

    // `pendingOnly` es un filtro derivado (D-075): el saldo no es una columna, así que no
    // se puede paginar en SQL sin duplicar ahí la regla de `@ayr/shared`. Se trae el
    // universo acotado (`DERIVED_FILTER_FETCH_CAP`) que ya cumple el resto de filtros, se
    // filtra por saldo en memoria y recién ahí se corta la página.
    const rows = await this.prisma.fiscalDocument.findMany({
      where,
      include: documentInclude,
      orderBy,
      take: DERIVED_FILTER_FETCH_CAP,
    });
    // D-377 (arreglo A): pendiente es tener algo que cobrar al céntimo, no una cola de diezmilésimas.
    const pending = (await this.toListDtos(rows)).filter((d) =>
      hasCollectibleBalance(d.balancePen),
    );
    assertDerivedUniverseComplete(rows.length, window);
    assertExportable(pending.length, window);
    // Los despachos, recién sobre la página ya cortada: no sobre todo el universo del tope.
    const page = pending.slice(window.skip, window.skip + window.take);
    return { items: await this.withDispatchLinks(page), total: pending.length };
  }

  /**
   * Correcciones 05 / M5: el despacho declarado de cada comprobante y, si no tiene, los del
   * pedido (rotulados aparte, D-205). Una consulta para toda la lista (`dispatchLinksByDocument`).
   */
  private async withDispatchLinks(
    dtos: FiscalDocumentListItemDto[],
  ): Promise<FiscalDocumentListItemDto[]> {
    const links = await dispatchLinksByDocument(this.prisma, dtos);
    return dtos.map((d) => ({ ...d, ...links.get(d.id) }));
  }

  /** El DTO de listado (sin líneas, cobros ni notas) de un lote de comprobantes. */
  private async toListDtos(rows: DocumentRow[]): Promise<FiscalDocumentListItemDto[]> {
    const settings = await this.settingsRow();
    const actors = await this.resolveActorNames(rows.flatMap((r) => this.actorIdsOf(r)));
    const credited = await this.creditedQtyByItem(rows.flatMap((r) => r.items.map((i) => i.id)));
    return rows.map((row) => {
      const dto = this.toDto(row, settings.alertAfterHours, actors, credited);
      // El listado no lleva líneas, cobros, notas ni correcciones de fecha: la lista muestra
      // totales y estado, y arrastrarlos multiplicaría por diez el tamaño de la respuesta.
      const {
        items,
        payments: _payments,
        creditNotes: _creditNotes,
        salesReturn: _salesReturn,
        issueDateChanges: _issueDateChanges,
        ...rest
      } = dto;
      return { ...rest, itemCount: items.length };
    });
  }

  async findOne(id: string, actor?: RequestUser): Promise<FiscalDocumentDto> {
    const row = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      // El único que trae el historial de correcciones: es lo que se ve en el detalle y lo
      // que el listado tira (F8-S7/M1).
      include: documentDetailInclude,
    });
    if (!row) throw new NotFoundException('Comprobante no encontrado');
    if (actor) {
      const ownerId =
        row.salesOrder?.sellerId ?? row.dispatch?.salesOrder?.sellerId ?? row.createdById;
      assertSellerAccess(actor, ownerId, 'Comprobante');
    }
    const settings = await this.settingsRow();
    const actors = await this.resolveActorNames(this.actorIdsOf(row));
    const credited = await this.creditedQtyByItem(row.items.map((i) => i.id));
    const dto = await this.withAtCostMarks(
      this.toDto(row, settings.alertAfterHours, actors, credited),
    );
    // Correcciones 05 / M5: su despacho declarado o, si no tiene, los del pedido (D-205).
    const links = await dispatchLinksByDocument(this.prisma, [dto]);
    return { ...dto, ...links.get(dto.id) };
  }

  /**
   * cc51 (D-641): la marca «A costo» de las líneas que facturan una línea de pedido vendida a
   * costo. Solo el detalle, y solo si alguna línea sale de un pedido: una consulta.
   */
  private async withAtCostMarks(dto: FiscalDocumentDto): Promise<FiscalDocumentDto> {
    const orderItemIds = dto.items.flatMap((i) => (i.salesOrderItemId ? [i.salesOrderItemId] : []));
    if (orderItemIds.length === 0) return dto;
    const marked = await this.prisma.salesOrderItem.findMany({
      where: { id: { in: orderItemIds }, atCostReason: { not: null } },
      select: { id: true, atCostReason: true, atCostNote: true },
    });
    return applyAtCostMarks(dto, marked);
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
        document: { status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
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
    actor?: RequestUser,
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const row = await this.prisma.fiscalDocument.findUnique({
      where: { id },
      select: {
        number: true,
        pdfKey: true,
        xmlKey: true,
        cdrKey: true,
        createdById: true,
        salesOrder: { select: { sellerId: true } },
        dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
      },
    });
    if (!row) throw new NotFoundException('Comprobante no encontrado');
    if (actor) {
      const ownerId =
        row.salesOrder?.sellerId ?? row.dispatch?.salesOrder?.sellerId ?? row.createdById;
      assertSellerAccess(actor, ownerId, 'Comprobante');
    }
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
  private actorIdsOf(row: DocumentRow | DocumentDetailRow): (string | null)[] {
    return [
      row.createdById,
      row.genericCustomerOverrideById,
      // D-110 y D-072: quién anuló y quién dio de baja. Sin ellos, el nombre salía `null` y
      // la constancia quedaba muda justo en lo primero que se pregunta ante un comprobante
      // que dejó de deber — el `?? null` del DTO lo escondía sin que nada fallara.
      row.annulledById,
      row.voidedById,
      ...row.payments.flatMap((p) => [p.createdById, p.reversedById]),
      // F8-S7/M1: quién corrigió la fecha, por el mismo motivo que los dos de arriba.
      ...('issueDateChanges' in row ? row.issueDateChanges : []).map((c) => c.changedById),
    ];
  }

  private toDto(
    row: DocumentRow | DocumentDetailRow,
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
    // cc54 (D-657): el vencimiento vigente: el de la NC 13 viva más reciente, si hay.
    const due = effectiveDueDate(
      row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
      row.creditNotes.map((n) => ({
        creditNoteReason: n.creditNoteReason,
        status: n.status,
        dueDate: n.dueDate ? n.dueDate.toISOString().slice(0, 10) : null,
        issueDate: n.issueDate.toISOString().slice(0, 10),
        createdAt: n.createdAt.toISOString(),
      })),
    );
    const dueDate = due.dueDate;
    const dueNote = due.changedByNote
      ? (row.creditNotes.find(
          (n) =>
            n.creditNoteReason === CreditNoteReason.OTROS_AJUSTES &&
            LIVE_DOCUMENT_STATUSES.includes(n.status) &&
            n.dueDate?.toISOString().slice(0, 10) === dueDate,
        )?.number ?? null)
      : null;
    const corrected = correctedDescriptions(row.creditNotes);
    const issueDate = row.issueDate.toISOString().slice(0, 10);

    return {
      id: row.id,
      docType: row.docType,
      status: row.status,
      number: row.number,
      // D-153: un manual no cuelga de ninguna `fiscal_series` —la serie del papel no es una
      // serie del ERP—, así que la suya sale de su propio número, que es donde vive. Una sola
      // fuente: `number` es la identidad del comprobante y la que el índice único protege.
      series: row.seriesRef?.series ?? seriesOf(row.number),
      correlative: row.correlative,
      customerId: row.customerId,
      customerName: row.customer.name,
      customerDocType: row.customer.docType,
      customerDocNumber: row.customer.docNumber,
      customerIsGeneric: row.customer.isSystem,
      salesOrderId: row.salesOrderId,
      salesOrderCode: row.salesOrder ? salesOrderCode(row.salesOrder.seq) : null,
      salesOrderStatus: row.salesOrder?.status ?? null,
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
      dueDateChangedByNumber: dueNote,
      subtotalPen: row.subtotalPen.toFixed(4),
      igvPen: row.igvPen.toFixed(4),
      totalPen: row.totalPen.toFixed(4),
      paidPen: paid.toFixed(4),
      creditedPen: credited.toFixed(4),
      balancePen: balance,
      isOverdue: dueDate !== null && dueDate < businessToday() && hasCollectibleBalance(balance),
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
        // Solo lo que el ERP **emitió** tiene camino de baja desde acá (D-105/D-153): lo
        // importado y lo manual se deshacen donde se emitieron. Sin este corte, la pantalla
        // ofrecía un botón que solo podía terminar en un error del servicio — y con la forma
        // vieja (`!== IMPORTED`) volvió a ofrecerlo en cuanto apareció el tercer origen.
        row.status === FiscalDocumentStatus.ACCEPTED &&
        row.origin === FiscalDocumentOrigin.ISSUED_HERE
          ? voidPathFor(row.docType, issueDate, businessToday())
          : null,
      origin: row.origin,
      annulledAt: row.annulledAt?.toISOString() ?? null,
      annulledByName: row.annulledById ? (actors.get(row.annulledById) ?? null) : null,
      annulReason: row.annulReason,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      supersededByDocumentId: row.supersededBy?.id ?? null,
      supersedesDocumentId: row.supersedesDocumentId,
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
        // cc51 (D-641): lo completa `withAtCostMarks` (el detalle); el listado no lo muestra.
        atCostReason: null,
        atCostNote: null,
        correctedDescription: corrected.get(i.id)?.description ?? null,
        correctedByNumber: corrected.get(i.id)?.number ?? null,
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
        creditNoteReason: n.creditNoteReason,
        dueDate: n.dueDate ? n.dueDate.toISOString().slice(0, 10) : null,
        salesReturn: n.salesReturn
          ? {
              id: n.salesReturn.id,
              code: salesReturnCode(n.salesReturn.seq),
              status: n.salesReturn.status,
            }
          : null,
      })),
      salesReturn:
        'salesReturn' in row && row.salesReturn
          ? {
              id: row.salesReturn.id,
              code: salesReturnCode(row.salesReturn.seq),
              status: row.salesReturn.status,
            }
          : null,
      issueDateChanges: ('issueDateChanges' in row ? row.issueDateChanges : []).map((c) => ({
        id: c.id,
        beforeIssueDate: c.beforeIssueDate.toISOString().slice(0, 10),
        afterIssueDate: c.afterIssueDate.toISOString().slice(0, 10),
        beforeDueDate: c.beforeDueDate ? c.beforeDueDate.toISOString().slice(0, 10) : null,
        afterDueDate: c.afterDueDate ? c.afterDueDate.toISOString().slice(0, 10) : null,
        reason: c.reason,
        changedByName: actors.get(c.changedById) ?? null,
        changedAt: c.changedAt.toISOString(),
      })),
    };
  }
}

/**
 * cc54 (D-654): por línea del comprobante, la descripción de la NC 03 viva más reciente que la
 * corrige (las NC vienen en orden de creación). Solo el detalle trae las líneas de las NC.
 */
function correctedDescriptions(
  notes: readonly {
    number: string | null;
    status: FiscalDocumentStatus;
    creditNoteReason: string | null;
    items?: { affectedItemId: string | null; description: string }[];
  }[],
): Map<string, { description: string; number: string | null }> {
  const out = new Map<string, { description: string; number: string | null }>();
  for (const n of notes) {
    if (n.creditNoteReason !== CreditNoteReason.CORRECCION_DESCRIPCION) continue;
    if (!LIVE_DOCUMENT_STATUSES.includes(n.status)) continue;
    for (const i of n.items ?? []) {
      if (i.affectedItemId)
        out.set(i.affectedItemId, { description: i.description, number: n.number });
    }
  }
  return out;
}

/** cc51 (D-641): la marca «A costo» de la línea de pedido, en la línea del comprobante que la factura. */
export function applyAtCostMarks(
  dto: FiscalDocumentDto,
  marked: readonly { id: string; atCostReason: string | null; atCostNote: string | null }[],
): FiscalDocumentDto {
  if (marked.length === 0) return dto;
  const byId = new Map(marked.map((m) => [m.id, m]));
  return {
    ...dto,
    items: dto.items.map((i) => {
      const mark = i.salesOrderItemId ? byId.get(i.salesOrderItemId) : undefined;
      return mark ? { ...i, atCostReason: mark.atCostReason, atCostNote: mark.atCostNote } : i;
    }),
  };
}
