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
  GRE_TRANSFER_MODES,
  TransferMode,
  IGV_RATE_PCT,
  DERIVED_UNIT_VALUE_DECIMALS,
  derivedUnitValue,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  paginate,
  paginateInMemory,
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
  toSkipTake,
  VOID_WINDOW_DAYS,
  voidPathFor,
  dispatchCode as toDispatchCode,
  type CreateCreditNoteInput,
  type CreateInvoiceInput,
  type RegisterManualInput,
  type UpdateManualIssueDateInput,
  type FiscalDocumentDto,
  type FiscalDocumentListItemDto,
  type FiscalDocumentQuery,
  type PaginatedResult,
  type CreateFiscalSeriesInput,
  type FiscalSeriesDto,
  type InvoicingSettingsDto,
  type SalesOrderProgressDto,
  type UpdateInvoicingSettingsInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { assertSellerAccess } from '../auth/seller-scope';
import { claimIdempotencyKey } from '../common/idempotency';
import { OperationDateService } from '../common/operation-date.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { rawMaterialSpecLabels } from '../sales/raw-material';
import { StorageService } from '../documents/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { dueDateFor, exceedsOrderTotal, isStalled, pendingQty } from './invoicing-math';
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
  salesOrder: { select: { id: true, seq: true, sellerId: true } },
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
    select: { id: true, number: true, status: true, issueDate: true, totalPen: true },
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
  issueDateChanges: { orderBy: { changedAt: 'desc' } },
} satisfies Prisma.FiscalDocumentInclude;

type DocumentRow = Prisma.FiscalDocumentGetPayload<{ include: typeof documentInclude }>;
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
    let orderTotalPen: string | null = null;
    if (input.salesOrderId) {
      const [locked] = await tx.$queryRaw<{ total_pen: Prisma.Decimal }[]>`
        SELECT "total_pen" FROM "sales_orders" WHERE "id" = ${input.salesOrderId}::uuid FOR UPDATE
      `;
      if (!locked) throw new NotFoundException('Pedido no encontrado');
      orderTotalPen = locked.total_pen.toString();
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
      // el despacho queda declarando cubrir un comprobante que no es el que lo declaró.
      await tx.$queryRaw`
        SELECT "id" FROM "dispatches" WHERE "id" = ${input.dispatchId}::uuid FOR UPDATE
      `;
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
        }),
        tx.fiscalDocument.aggregate({
          where: {
            salesOrderId: input.salesOrderId,
            status: { in: LIVE_DOCUMENT_STATUSES },
            docType: FiscalDocType.NOTA_CREDITO,
            archivedAt: null,
          },
          _sum: { totalPen: true },
        }),
      ]);
      const orderTotal = toDecimal(orderTotalPen);
      const cap = exceedsOrderTotal({
        orderTotal,
        committed: (existing._sum?.totalPen ?? new Prisma.Decimal(0)).toString(),
        credited: (creditNotes._sum?.totalPen ?? new Prisma.Decimal(0)).toString(),
        newTotal: totals.total,
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

    // Lo ya facturado por línea: solo cuentan los comprobantes vivos. Un rechazado nunca
    // existió para SUNAT y un anulado dejó de existir; ninguno de los dos consume pedido.
    const invoiced = await tx.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: orderItemIds },
        document: {
          status: { in: LIVE_DOCUMENT_STATUSES },
          docType: { not: FiscalDocType.NOTA_CREDITO },
          archivedAt: null,
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
        const fullLine =
          item.unitPricePen === undefined && qty.equals(toDecimal(orderItem.qty.toString()));
        const totals = fullLine
          ? {
              subtotal: toDecimal(orderItem.subtotalPen.toString()),
              igv: toDecimal(orderItem.igvPen.toString()),
              total: toDecimal(orderItem.totalPen.toString()),
            }
          : salesTotals([{ qty: item.qty, unitPricePen: price }]);
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
    // D-133: mismo control que al emitir. Una nota de crédito también es un hecho fechado.
    this.operationDate.assertIssueDate(actor, input.issueDate);
    const id = await this.prisma.$transaction(async (tx) => {
      // **El afectado se bloquea antes de leer lo que le queda por acreditar.** Sin esto,
      // dos notas de crédito concurrentes sobre el mismo comprobante calculaban las dos el
      // mismo pendiente y acreditaban el doble: dos correlativos gastados, dos documentos
      // ante SUNAT y un saldo negativo que no se deshace —una nota de crédito no se acredita
      // con otra—. Es el mismo lock que `addPayment` toma para el saldo, por el mismo motivo.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${affectedId}::uuid FOR UPDATE
      `;
      const affected = await tx.fiscalDocument.findUnique({
        where: { id: affectedId },
        include: {
          items: { orderBy: { lineNumber: 'asc' } },
          customer: true,
          salesOrder: { select: { sellerId: true } },
          dispatch: { select: { salesOrder: { select: { sellerId: true } } } },
        },
      });
      if (!affected) throw new NotFoundException('Comprobante no encontrado');
      // RF-S3c: el vendedor solo opera sobre sus propios comprobantes.
      {
        const ownerId =
          affected.salesOrder?.sellerId ??
          affected.dispatch?.salesOrder?.sellerId ??
          affected.createdById;
        assertSellerAccess(actor, ownerId, 'Comprobante');
      }
      // D-153: sobre un manual **sí** hay nota de crédito, pero manual — el afectado salió de
      // la otra app y su NC también. Acá solo se corta lo importado, que no tiene vuelta por
      // ningún lado; que el modo del terminal coincida con el del afectado lo exige `send` y
      // `registerManual`, que es donde el documento deja de ser un borrador.
      if (affected.origin === FiscalDocumentOrigin.IMPORTED) {
        throw new BadRequestException(
          `El comprobante ${affected.number ?? ''} se importó ya emitido: su nota de crédito se hace donde se emitió`,
        );
      }
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

      // Lo ya acreditado por línea, contando solo notas vivas.
      const credited = await tx.fiscalDocumentItem.groupBy({
        by: ['affectedItemId'],
        where: {
          affectedItemId: { in: affected.items.map((i) => i.id) },
          document: { status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
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
        // D-169: acreditar la línea **entera** acredita su importe entero, copiado. Con el
        // recálculo desde el unitario, una nota de crédito total sobre un comprobante
        // importado dejaba unos céntimos de deuda que ya nadie podía acreditar ni cobrar: la
        // NC no llegaba al total del afectado y su cuenta por cobrar no cerraba nunca. Una
        // acreditación **parcial** sí se calcula: el importe exacto es del total de la línea y
        // una fracción de él hay que derivarla.
        const totals = toDecimal(line.qty).equals(toDecimal(original.qty.toString()))
          ? {
              subtotal: toDecimal(original.subtotalPen.toString()),
              igv: toDecimal(original.igvPen.toString()),
              total: toDecimal(original.totalPen.toString()),
            }
          : salesTotals([{ qty: line.qty, unitPricePen: original.unitPricePen.toString() }]);
        return {
          original,
          qty: line.qty,
          ...serializeSalesTotals(totals),
        };
      });

      if (lines.length === 0) {
        throw new BadRequestException('No queda nada por acreditar en este comprobante');
      }

      // D-169: la cabecera de la nota **suma sus propias líneas**, igual que la del
      // comprobante. Recalcularla desde el unitario volvía a perder el importe copiado.
      const totals = sumLineTotals(lines);
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

    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException('Comprobante no encontrado');
      const document = await tx.fiscalDocument.findUniqueOrThrow({
        where: { id },
        include: {
          items: { select: { id: true, qty: true, salesOrderItemId: true, affectedItemId: true } },
          affectedDocument: { select: { origin: true, number: true } },
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

      // El mismo último control que `send`: dos borradores sobre la misma línea pasan los dos
      // la validación de creación, y este es el punto en el que todavía se puede decir que no.
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
        await this.applyManualNumber(
          tx,
          id,
          input,
          number,
          document.status,
          document.origin,
          actor,
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `Ya hay un comprobante registrado con el número ${number}: revisa la serie y el correlativo`,
          );
        }
        throw err;
      }
    });

    return this.findOne(id);
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

    await this.prisma.$transaction(async (tx) => {
      // **El lock va antes de leer**, igual que `createCreditNote`, `registerManual`,
      // `voidDocument` y `annulExternal` sobre esta misma tabla. Los guardrails de abajo
      // —que no haya cobro ni nota de crédito por delante de la fecha nueva— se evalúan
      // sobre lo que se lee acá: sin el lock son una foto, y un cobro registrado en paralelo
      // entra por la ventana que el método dice cerrar.
      await tx.$queryRaw`
        SELECT "id" FROM "fiscal_documents" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      const document = await tx.fiscalDocument.findUnique({
        where: { id },
        select: {
          id: true,
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
        after: { issueDate: input.issueDate, dueDate: afterDue, reason: input.reason },
      });
    });

    return this.findOne(id);
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
        affectedDocument: { select: { docType: true, origin: true, number: true } },
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
          document: { status: { in: LIVE_DOCUMENT_STATUSES }, archivedAt: null },
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
          archivedAt: null,
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
    this.assertPseEnabled();
    const documentId = await this.prisma.$transaction(async (tx) => {
      // F8-S1/M2: el mismo lock que `DispatchesService.reverse` sobre esta tabla. Sin él,
      // dos clicks en "Emitir guía" leían los dos `dispatch.documents` sin ninguna vigente
      // todavía, pasaban los dos el chequeo de abajo y cada uno creaba su propio borrador
      // —y su propio correlativo— para el mismo despacho: dos guías electrónicas vigentes
      // para un solo traslado físico.
      await tx.$queryRaw`
        SELECT "id" FROM "dispatches" WHERE "id" = ${dispatchId}::uuid FOR UPDATE
      `;
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

    // Solo los comprobantes vivos y **sin contar notas de crédito**: una NC no descuenta
    // pedido, ajusta el saldo del comprobante que afecta (D-075).
    const invoiced = await this.prisma.fiscalDocumentItem.groupBy({
      by: ['salesOrderItemId'],
      where: {
        salesOrderItemId: { in: itemIds },
        document: {
          status: { in: LIVE_DOCUMENT_STATUSES },
          docType: { not: FiscalDocType.NOTA_CREDITO },
          archivedAt: null,
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
    const where: Prisma.FiscalDocumentWhereInput = {
      status: query.status,
      docType: query.docType,
      customerId: query.customerId,
      salesOrderId: query.salesOrderId,
      origin: query.origin,
      // RF-72: la versión archivada por una reimportación deja de ser el comprobante y sale
      // de la lista. Sigue existiendo, y se llega a ella desde la vigente que la reemplazó.
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(actor && actor.role !== Role.ADMINISTRADOR
        ? {
            OR: [
              { createdById: actor.id },
              { salesOrder: { sellerId: actor.id } },
              { dispatch: { salesOrder: { sellerId: actor.id } } },
            ],
          }
        : {}),
    };
    if (query.pendingOnly) {
      // El saldo es derivado (D-075) y no se puede sumar en SQL sin duplicar la regla que
      // vive en `@ayr/shared`. Lo que **sí** se puede acotar en SQL es qué documentos son
      // capaces de tener saldo: sin esto, el universo a filtrar en memoria se llenaba de
      // borradores y notas de crédito.
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

    if (!query.pendingOnly) {
      const { skip, take } = toSkipTake(query);
      const [total, rows] = await Promise.all([
        this.prisma.fiscalDocument.count({ where }),
        this.prisma.fiscalDocument.findMany({
          where,
          include: documentInclude,
          // D-124: por fecha de emisión — la fecha de operación de un comprobante, la misma
          // que trae un importado (RF-71) y la que usan los reportes de ventas.
          orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
          skip,
          take,
        }),
      ]);
      return paginate(await this.toListDtos(rows), total, query);
    }

    // `pendingOnly` es un filtro derivado (D-075): el saldo no es una columna, así que no
    // se puede paginar en SQL sin duplicar ahí la regla de `@ayr/shared`. Se trae el
    // universo acotado (`DERIVED_FILTER_FETCH_CAP`) que ya cumple el resto de filtros, se
    // filtra por saldo en memoria y recién ahí se corta la página.
    const rows = await this.prisma.fiscalDocument.findMany({
      where,
      include: documentInclude,
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
      take: DERIVED_FILTER_FETCH_CAP,
    });
    const pending = (await this.toListDtos(rows)).filter((d) => toDecimal(d.balancePen).gt(0));
    return paginateInMemory(pending, query);
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
    const dueDate = row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null;
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
