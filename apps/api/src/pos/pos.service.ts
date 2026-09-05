import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CashSessionStatus,
  DispatchStatus,
  FiscalDocType,
  FiscalDocumentStatus,
  PosSaleStatus,
  Prisma,
  SalesOrderStatus,
  TransferMode,
} from '@prisma/client';
import {
  CreditNoteReason,
  Decimal,
  GENERIC_CUSTOMER_DOC_NUMBER,
  GENERIC_CUSTOMER_MAX_TOTAL_PEN,
  Role,
  businessToday,
  dispatchCode,
  LIVE_DOCUMENT_STATUSES as SHARED_LIVE_DOCUMENT_STATUSES,
  posSaleCode,
  salesOrderCode,
  toDecimal,
  toFixedString,
  voidPathFor,
  type CreatePosSaleInput,
  type PosContextDto,
  type PosProductDto,
  type PosProductQuery,
  type BusinessLine,
  type PosSaleListItemDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { DispatchesService } from '../invoicing/dispatches.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { ReceivablesService } from '../invoicing/receivables.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { CashSessionsService } from './cash-sessions.service';

/**
 * Punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * **Este servicio no sabe nada de stock, de kardex ni de correlativos.** Es un orquestador:
 * llama a los cuatro servicios que ya hacían este trabajo desde la Fase 5b —pedido,
 * despacho, comprobante y cobro— dentro de **una sola transacción**, y guarda una fila que
 * dice que los cuatro nacieron juntos. Ese es literalmente todo el POS (D-099).
 *
 * De ahí salen sus propiedades sin escribir una línea para conseguirlas: la invariante
 * `disponible ≥ reservado` se aplica igual, la reserva se crea y se consume igual, el
 * kardex sale por `InventoryService` igual, el correlativo se toma igual y la contingencia
 * del PSE funciona igual. Si al mostrador no le alcanza el disponible, la venta se rechaza
 * con el mismo mensaje que cualquier otro pedido.
 *
 * Lo único que este archivo decide por su cuenta:
 *
 * - **qué se puede vender** (D-098): stock del propio producto, nunca material a medida;
 * - **cómo se documenta el traslado** (D-103): recojo en mostrador, sin guía;
 * - **cuándo se envía al PSE** (D-102): fuera de la transacción, como manda D-073, así que
 *   una caída del PSE deja la venta hecha y el comprobante pendiente;
 * - **cómo se deshace** (D-100): la cadena de reversas que ya existe, en orden.
 */
@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cashSessions: CashSessionsService,
    private readonly salesOrders: SalesOrdersService,
    private readonly dispatches: DispatchesService,
    private readonly invoicing: InvoicingService,
    private readonly receivables: ReceivablesService,
  ) {}

  // -------------------------------------------------------------------------
  // Lo que la pantalla necesita para abrirse
  // -------------------------------------------------------------------------

  async context(actor: RequestUser): Promise<PosContextDto> {
    const [session, generic, settings] = await Promise.all([
      this.cashSessions.current(actor),
      this.genericCustomer(),
      this.invoicing.settings(),
    ]);
    return {
      session,
      genericCustomerId: generic.id,
      genericCustomerName: generic.name,
      genericMaxTotalPen: GENERIC_CUSTOMER_MAX_TOTAL_PEN,
      providerConfigured: settings.providerConfigured,
      providerOffline: settings.providerOffline,
    };
  }

  /**
   * Productos vendibles en mostrador: **con disponible real** y de venta simple.
   *
   * Los dos filtros son la misma regla de D-098 vista desde el buscador. Se excluye la
   * unidad `MTR` porque es la marca de una cobertura a medida (D-083): esa se cotiza, no se
   * despacha del mostrador. Y se ordena por disponible descendente porque en un mostrador
   * lo primero que importa es qué hay.
   *
   * **La consulta arranca por el saldo y no por el catálogo**, que es lo contrario de lo
   * intuitivo. Empezando por `products` con un `take` hacía falta cortar por algún orden, y
   * el único disponible ahí es alfabético: con el catálogo crecido, un producto con stock
   * podía quedar fuera de los primeros SKU y no aparecer nunca sin escribir su código
   * exacto. Las filas de `inventory_balances` con saldo positivo son pocas por definición
   * —solo lo que de verdad hay en el almacén—, así que ese es el conjunto por el que se
   * empieza.
   */
  async findProducts(query: PosProductQuery): Promise<PosProductDto[]> {
    const search = query.search?.trim();
    const withStock = await this.prisma.inventoryBalance.findMany({
      where: { itemType: 'PRODUCT', qty: { gt: 0 } },
      select: { itemId: true, qty: true },
    });
    if (withStock.length === 0) return [];

    const stockIds = withStock.map((b) => b.itemId);
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: stockIds },
        isActive: true,
        // D-098: `MTR` es la unidad de la cobertura a medida. El mostrador no la vende.
        unit: { not: 'MTR' },
        businessLine: {
          inventoryStrategy: 'STOCK',
          ...(query.businessLine ? { code: toPrismaLineCode(query.businessLine) } : {}),
        },
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        listPricePen: true,
        businessLine: { select: { code: true, name: true } },
      },
    });
    if (products.length === 0) return [];

    const ids = products.map((p) => p.id);
    const reserved = await this.prisma.reservation.groupBy({
      by: ['itemId'],
      where: { itemType: 'PRODUCT', itemId: { in: ids }, status: 'ACTIVE' },
      _sum: { qty: true },
    });
    const balances = withStock;
    const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const reservedById = new Map(
      reserved.map((r) => [r.itemId, toDecimal((r._sum.qty ?? new Prisma.Decimal(0)).toString())]),
    );

    return products
      .map((p) => {
        const available = (qtyById.get(p.id) ?? new Decimal(0)).minus(
          reservedById.get(p.id) ?? new Decimal(0),
        );
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          unit: p.unit,
          businessLine: toSharedLineCode(p.businessLine.code),
          businessLineName: p.businessLine.name,
          listPricePen: p.listPricePen === null ? null : p.listPricePen.toFixed(4),
          availableQty: available.toFixed(3),
          _available: available,
        };
      })
      .filter((p) => p._available.gt(0))
      .sort((a, b) => b._available.comparedTo(a._available))
      .slice(0, 50)
      .map(({ _available, ...dto }) => dto);
  }

  // -------------------------------------------------------------------------
  // RF-60 — la venta
  // -------------------------------------------------------------------------

  /**
   * Una venta de mostrador, de punta a punta.
   *
   * **Las dos fases de D-073, con la primera más ancha.** Dentro de la transacción se crean
   * el pedido, el despacho, el comprobante con su correlativo y el cobro; al confirmarse,
   * la venta existe entera y la mercadería ya salió del kardex. El envío al PSE ocurre
   * **después**, fuera de la transacción, y si falla no pasa nada: el comprobante queda
   * pendiente y el job lo recoge (D-073). Es exactamente el orden que `send` ya usaba; lo
   * único que cambia es que la primera fase abarca la venta completa en vez de un documento
   * suelto, para que no exista un estado intermedio en el que la mercadería salió y el
   * comprobante no.
   */
  async sell(actor: RequestUser, input: CreatePosSaleInput): Promise<PosSaleListItemDto> {
    const today = businessToday();
    const { saleId, documentId } = await this.prisma.$transaction(
      async (tx) => {
        const session = await this.cashSessions.lockOpenSession(tx, actor);

        // 1. El cliente. Sin `customerId` es el sembrado de D-077 y la venta va con boleta.
        const customer = await this.resolveCustomer(tx, input.customerId);
        const docType =
          customer.docType === 'RUC' && !customer.isSystem
            ? FiscalDocType.FACTURA
            : FiscalDocType.BOLETA;

        // 2. La línea de negocio. Un pedido tiene una sola (`sales_orders.business_line_id`),
        //    así que un carrito que mezcle líneas no cabe en el modelo — y partirlo en dos
        //    pedidos daría dos comprobantes por una sola venta de mostrador, que es peor
        //    para el cliente que la restricción (D-104).
        const businessLine = await this.resolveBusinessLine(
          tx,
          input.items.map((i) => i.productId),
        );

        // 3. El pedido, con sus reservas. Mismo servicio, mismos guardrails (D-099).
        const salesOrderId = await this.salesOrders.createDirectInTx(
          tx,
          actor,
          {
            customerId: customer.id,
            businessLine,
            issueDate: today,
            notes: input.notes,
            items: input.items.map((i) => ({
              productId: i.productId,
              qty: i.qty,
              unitPricePen: i.unitPricePen,
            })),
          },
          { counterSale: true },
        );
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: salesOrderId },
          include: { items: { orderBy: { lineNumber: 'asc' } } },
        });

        // 4. El despacho: la mercadería sale en el acto y se la lleva el comprador (D-103).
        const pickup = await this.pickupLocation(tx);
        const dispatchId = await this.dispatches.createInTx(tx, actor, {
          salesOrderId,
          dispatchDate: today,
          originAddress: pickup.address,
          destinationAddress: pickup.address,
          originUbigeo: pickup.ubigeo,
          destinationUbigeo: pickup.ubigeo,
          transferMode: TransferMode.PICKUP,
          // Sin peso: un recojo no genera guía y no hay dónde declararlo (D-103).
          items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty.toFixed(3) })),
        });

        // 5. El comprobante, con su correlativo tomado (fase 1 de D-073).
        const fiscalDocumentId = await this.invoicing.createInTx(tx, actor, {
          docType,
          customerId: customer.id,
          salesOrderId,
          issueDate: today,
          paymentTerms: 'CONTADO',
          forceGenericCustomer: input.forceGenericCustomer,
          notes: input.notes,
          items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty.toFixed(3) })),
        });
        await this.invoicing.assignInTx(tx, actor, fiscalDocumentId);

        // 6. El cobro. El mostrador es contado: la venta se cobra entera en el acto, y el
        //    monto sale del **comprobante**, que es contra quien `addPaymentInTx` valida el
        //    saldo. Hoy coincide con el total del pedido porque el POS factura las líneas
        //    enteras; leerlo del documento quita esa coincidencia implícita del medio.
        const invoiced = await tx.fiscalDocument.findUniqueOrThrow({
          where: { id: fiscalDocumentId },
          select: { totalPen: true },
        });
        const totalPen = toFixedString(invoiced.totalPen.toString(), 'MONEY');
        const customerPaymentId = await this.receivables.addPaymentInTx(
          tx,
          actor,
          fiscalDocumentId,
          { date: today, amountPen: totalPen, method: input.method, reference: input.reference },
        );

        // 7. Lo único que este módulo agrega: que los cuatro son una venta de mostrador.
        const sale = await tx.posSale.create({
          data: {
            cashSessionId: session.id,
            salesOrderId,
            dispatchId,
            fiscalDocumentId,
            customerPaymentId,
            method: input.method,
            totalPen,
            createdById: actor.id,
          },
        });

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'pos.sale.create',
          entity: 'pos_sales',
          entityId: sale.id,
          after: {
            code: posSaleCode(sale.seq),
            salesOrder: salesOrderCode(order.seq),
            docType,
            method: input.method,
            totalPen,
            customer: customer.name,
          },
        });
        return { saleId: sale.id, documentId: fiscalDocumentId };
      },
      // Una venta de mostrador toma los mismos locks que un pedido y un despacho juntos.
      { timeout: 30_000 },
    );

    // Fase 2 de D-073, **fuera de la transacción**: si el PSE no contesta, la venta ya está
    // hecha y el comprobante queda pendiente para el job. Nunca se propaga el error: la
    // operación no se detiene por el PSE, que es el punto entero de esa decisión.
    try {
      await this.invoicing.deliver(documentId);
    } catch (error) {
      this.logger.warn(
        `Venta de mostrador ${saleId}: el envío del comprobante al PSE no entró (${String(error)}). Queda pendiente; lo recoge el job.`,
      );
    }

    return this.findOne(saleId);
  }

  // -------------------------------------------------------------------------
  // D-100 — anular una venta de mostrador
  // -------------------------------------------------------------------------

  /**
   * Deshace una venta de mostrador encadenando las reversas que ya existen, en el único
   * orden en que funcionan (el mismo que usa `pnpm prod:purge-e2e`):
   *
   * 1. **el cobro**, porque un comprobante con cobros vigentes no se da de baja ni queda
   *    coherente tras una nota de crédito;
   * 2. **el comprobante**, por el camino que le corresponda (`voidPathFor`, D-072): baja
   *    para una factura dentro del plazo, nota de crédito total para una boleta;
   * 3. **el despacho**, que devuelve el stock al kardex y restaura la reserva;
   * 4. **el pedido**, que libera lo que quede prometido.
   *
   * **Por qué exige un comprobante aceptado.** Ni la baja ni la nota de crédito existen
   * sobre un documento que el PSE todavía no aceptó: el correlativo está tomado y el envío
   * sigue pendiente (D-073), así que deshacerlo por dentro dejaría al job mandando después
   * un comprobante de una venta que ya no existe. Con producción sin credenciales del PSE
   * (D-080) esto significa que una venta de mostrador **no se anula hasta que el
   * comprobante se resuelva**, y el mensaje lo dice en vez de fallar con un error opaco.
   *
   * **La cadena no es atómica, y no puede serlo**: el paso 2 habla con el PSE, y D-073
   * prohíbe que una llamada al proveedor viva dentro de una transacción. A cambio, cada paso
   * comprueba su propio estado antes de actuar —cobro sin revertir, despacho vivo, pedido no
   * anulado—, así que **reintentar la anulación retoma donde se cortó** en vez de duplicar
   * reversas. Es el mismo criterio por el que `prod:purge-e2e` se puede correr dos veces
   * seguidas sin romper nada.
   */
  async voidSale(actor: RequestUser, id: string, reason: string): Promise<PosSaleListItemDto> {
    const sale = await this.prisma.posSale.findUnique({
      where: { id },
      include: {
        cashSession: { select: { id: true, status: true, seq: true } },
        fiscalDocument: { select: { id: true, docType: true, status: true, issueDate: true } },
        customerPayment: { select: { id: true, reversedAt: true } },
        dispatch: { select: { id: true, status: true } },
        salesOrder: { select: { id: true, status: true } },
      },
    });
    if (!sale) throw new NotFoundException('Venta de mostrador no encontrada');
    if (sale.status === PosSaleStatus.VOIDED) {
      throw new BadRequestException('Esa venta ya está anulada');
    }

    const document = sale.fiscalDocument;
    // El comprobante ya deshecho no vuelve a deshacerse: un reintento se salta el paso 2 y
    // sigue por el despacho. `VOID_PENDING` cuenta como deshecho — la baja está comunicada y
    // en trámite—, y una nota de crédito viva sobre él dice lo mismo por el otro camino.
    const alreadyUndone =
      document.status === FiscalDocumentStatus.VOIDED ||
      document.status === FiscalDocumentStatus.VOID_PENDING ||
      (await this.hasLiveCreditNote(document.id));
    if (!alreadyUndone && document.status !== FiscalDocumentStatus.ACCEPTED) {
      throw new BadRequestException(
        `El comprobante de esa venta todavía no fue aceptado por SUNAT (está ${document.status}): no se puede deshacer hasta que el PSE lo resuelva. Usa «Consultar al PSE» sobre el comprobante.`,
      );
    }

    // **El reclamo, antes del primer paso y bajo el lock del turno.**
    //
    // Hace dos cosas que la comprobación suelta de `cashSession.status` no podía hacer:
    //
    // 1. **Serializa contra el cierre de caja.** `CashSessionsService.close` toma `FOR UPDATE`
    //    sobre `cash_sessions`, así que tomando el mismo lock acá un arqueo no puede confirmarse
    //    en medio de una anulación. Sin esto, el cierre congelaba `expectedCashPen` contando
    //    como vigente una venta cuyo cobro ya se había revertido — un faltante inventado sobre
    //    el número que el cajero firma, que es justo lo que D-101 existe para evitar.
    // 2. **Impide que dos anulaciones corran a la vez.** `ACTIVE → VOIDING` es condicional, así
    //    que la segunda no encuentra nada que reclamar y sale. Sin eso, dos peticiones podían
    //    llegar juntas a `createCreditNote` y emitir **dos notas de crédito** sobre la misma
    //    boleta: dos correlativos gastados y un saldo negativo que no se deshace.
    //
    // Desde `VOIDING` la venta deja de contar para el arqueo (`expectedCash` solo suma las
    // `ACTIVE`), y las tres marcas de anulación se escriben acá y no al final para que un
    // reintento sepa quién la empezó y por qué.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "cash_sessions" WHERE "id" = ${sale.cashSessionId}::uuid FOR UPDATE
      `;
      const session = await tx.cashSession.findUniqueOrThrow({
        where: { id: sale.cashSessionId },
        select: { status: true },
      });
      // D-100: solo dentro del turno abierto. Anular una venta de un turno ya arqueado movería
      // el efectivo esperado de una caja que alguien firmó; ahí el camino es la nota de
      // crédito desde `/comprobantes`, que no toca la caja de ayer.
      if (session.status !== CashSessionStatus.OPEN) {
        throw new BadRequestException(
          'El turno de esa venta ya está cerrado: emite una nota de crédito desde el comprobante en vez de anular la venta',
        );
      }
      if (sale.status === PosSaleStatus.ACTIVE) {
        const claimed = await tx.posSale.updateMany({
          where: { id, status: PosSaleStatus.ACTIVE },
          data: {
            status: PosSaleStatus.VOIDING,
            voidedById: actor.id,
            voidedAt: new Date(),
            voidReason: reason,
          },
        });
        if (claimed.count === 0) {
          throw new ConflictException('Esa venta ya se está anulando: espera a que termine');
        }
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'pos.sale.void-start',
          entity: 'pos_sales',
          entityId: id,
          before: { status: PosSaleStatus.ACTIVE, totalPen: sale.totalPen.toFixed(4) },
          after: { status: PosSaleStatus.VOIDING, reason },
        });
      }
    });

    // 1. El cobro.
    if (sale.customerPayment.reversedAt === null) {
      await this.receivables.reversePayment(actor, document.id, sale.customerPayment.id, reason);
    }

    // 2. El comprobante, por el camino que le corresponde. Si un intento anterior ya lo
    //    deshizo —dado de baja, en trámite de baja o acreditado con una nota viva— se salta:
    //    volver a acreditar emitiría una segunda nota de crédito sobre lo mismo.
    const path = alreadyUndone
      ? 'DONE'
      : voidPathFor(
          document.docType,
          document.issueDate.toISOString().slice(0, 10),
          businessToday(),
        );
    if (path === 'DONE') {
      // Nada que deshacer: el comprobante ya está resuelto por un intento anterior. Salvo que
      // ese intento lo dejara con la baja **en trámite**, y ahí sí hay algo que hacer:
      // preguntarle al PSE si SUNAT ya la confirmó. Sin esto, un reintento chocaba contra el
      // paso 3 con un mensaje sobre facturación que no explicaba nada.
      if (document.status === FiscalDocumentStatus.VOID_PENDING) {
        const current = await this.invoicing
          .refreshStatus(actor, document.id)
          .catch(() => this.invoicing.findOne(document.id));
        if (current.status === FiscalDocumentStatus.VOID_PENDING) {
          throw new ConflictException(
            `La baja del comprobante ${current.number ?? ''} sigue en trámite ante SUNAT: vuelve a anular la venta en cuanto figure como anulado.`,
          );
        }
      }
    } else if (path === 'VOID') {
      await this.invoicing.voidDocument(actor, document.id, reason);
    } else if (path === 'CREDIT_NOTE') {
      // Nota de crédito **total**: sin `items`, `createCreditNote` copia lo que quede por
      // acreditar de cada línea (D-072). Motivo 01 del catálogo 09, que es el que
      // corresponde a una anulación de la operación.
      const creditNote = await this.invoicing.createCreditNote(actor, document.id, {
        reason: CreditNoteReason.ANULACION_OPERACION,
        issueDate: businessToday(),
      });
      // **Y se emite en el acto.** `createCreditNote` deja un borrador, y un borrador no
      // acredita nada: no tiene correlativo, no está en los estados vivos y `documentBalance`
      // no lo cuenta. Sin emitirlo, la boleta seguiría facturando sus líneas enteras y el
      // paso siguiente —revertir el despacho— se bloquearía contra una nota que existe pero
      // todavía no es un documento. La emisión toma número y confirma; el envío al PSE queda
      // fuera, como en toda emisión (D-073), así que una caída no deja la anulación a medias.
      if (creditNote.status === FiscalDocumentStatus.DRAFT) {
        await this.invoicing.send(actor, creditNote.id);
      }
    } else {
      throw new BadRequestException(
        'El comprobante de esa venta ya no se puede deshacer: pasó el plazo de la comunicación de baja y una nota de crédito no se acredita con otra',
      );
    }

    // **La baja no es instantánea.** SUNAT resuelve la comunicación de baja por ticket, así
    // que `voidDocument` puede dejar el comprobante en `VOID_PENDING`: comunicada y sin
    // confirmar. En ese estado el documento **sigue declarando el traslado** (D-074), así que
    // el paso siguiente se bloquearía contra él. Se consulta al PSE —lo mismo que haría el
    // operario— y solo si sigue en trámite se corta, diciendo exactamente dónde quedó: la
    // venta está reclamada en `VOIDING`, el cobro ya se revirtió, y reintentar la anulación
    // retoma desde el despacho en cuanto SUNAT confirme.
    if (path === 'VOID') {
      let current = await this.invoicing.findOne(document.id);
      if (current.status === FiscalDocumentStatus.VOID_PENDING) {
        current = await this.invoicing
          .refreshStatus(actor, document.id)
          .catch(() => this.invoicing.findOne(document.id));
      }
      if (current.status === FiscalDocumentStatus.VOID_PENDING) {
        throw new ConflictException(
          `La baja del comprobante ${current.number ?? ''} quedó en trámite ante SUNAT: el cobro ya se revirtió y la venta está marcada en anulación. Usa «Consultar al PSE» sobre el comprobante y vuelve a anular la venta en cuanto figure como anulado.`,
        );
      }
    }

    // 3. El despacho: devuelve el stock y restaura la reserva.
    if (sale.dispatch.status === DispatchStatus.ISSUED) {
      await this.dispatches.reverse(actor, sale.dispatch.id, reason);
    }

    // 4. El pedido: libera lo que quede prometido.
    if (sale.salesOrder.status !== SalesOrderStatus.CANCELLED) {
      await this.salesOrders.cancel(actor, sale.salesOrder.id, reason);
    }

    await this.prisma.$transaction(async (tx) => {
      const closed = await tx.posSale.updateMany({
        where: { id, status: { in: [PosSaleStatus.ACTIVE, PosSaleStatus.VOIDING] } },
        data: {
          status: PosSaleStatus.VOIDED,
          voidedById: actor.id,
          voidedAt: new Date(),
          voidReason: reason,
        },
      });
      if (closed.count === 0) return;
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'pos.sale.void',
        entity: 'pos_sales',
        entityId: id,
        before: { status: PosSaleStatus.VOIDING, totalPen: sale.totalPen.toFixed(4) },
        after: { status: PosSaleStatus.VOIDED, reason, fiscalPath: path },
      });
    });

    return this.findOne(id);
  }

  // -------------------------------------------------------------------------
  // Lecturas
  // -------------------------------------------------------------------------

  async findByCashSession(
    actor: RequestUser,
    cashSessionId: string,
  ): Promise<PosSaleListItemDto[]> {
    const session = await this.prisma.cashSession.findUnique({
      where: { id: cashSessionId },
      select: { userId: true },
    });
    if (!session) throw new NotFoundException('Caja no encontrada');
    if (actor.role !== Role.ADMINISTRADOR && session.userId !== actor.id) {
      throw new ForbiddenException('Esa caja es de otro usuario');
    }
    const rows = await this.prisma.posSale.findMany({
      where: { cashSessionId },
      include: saleInclude,
      orderBy: { createdAt: 'desc' },
    });
    const names = await this.actorNames(rows.flatMap((r) => [r.createdById, r.voidedById]));
    return rows.map((r) => toSaleDto(r, names));
  }

  /**
   * Una venta de mostrador, con la misma regla de propiedad que su turno: el dueño de la
   * caja o un administrador. `actor` es opcional solo para los llamadores internos que ya
   * hicieron la comprobación —`sell` y `voidSale` devuelven la venta que acaban de tocar—;
   * la ruta HTTP siempre lo pasa.
   */
  async findOne(id: string, actor?: RequestUser): Promise<PosSaleListItemDto> {
    const row = await this.prisma.posSale.findUnique({
      where: { id },
      include: { ...saleInclude, cashSession: { select: { userId: true } } },
    });
    if (!row) throw new NotFoundException('Venta de mostrador no encontrada');
    if (
      actor !== undefined &&
      actor.role !== Role.ADMINISTRADOR &&
      row.cashSession.userId !== actor.id
    ) {
      throw new ForbiddenException('Esa venta es de la caja de otro usuario');
    }
    const names = await this.actorNames([row.createdById, row.voidedById]);
    return toSaleDto(row, names);
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /** El cliente de la venta: el que pidieron, o el sembrado de D-077. */
  private async resolveCustomer(
    tx: Prisma.TransactionClient,
    customerId: string | undefined,
  ): Promise<{ id: string; name: string; docType: string; isSystem: boolean }> {
    if (customerId === undefined) {
      const generic = await tx.customer.findFirst({
        where: { isSystem: true, docNumber: GENERIC_CUSTOMER_DOC_NUMBER },
        select: { id: true, name: true, docType: true, isSystem: true },
      });
      if (!generic) {
        throw new NotFoundException(
          'No existe el cliente "público en general" sembrado (D-077): no se puede emitir una boleta sin identificar',
        );
      }
      return generic;
    }
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, docType: true, isSystem: true, isActive: true },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (!customer.isActive) throw new BadRequestException('El cliente está desactivado');
    return customer;
  }

  /**
   * ¿El comprobante ya tiene una nota de crédito **viva**?
   *
   * Es la mitad del "ya está deshecho" que el estado del documento no cuenta: una boleta
   * acreditada por completo sigue `ACCEPTED` para siempre (D-072), así que sin mirar sus
   * notas un reintento de la anulación emitiría una segunda sobre lo mismo.
   */
  private async hasLiveCreditNote(documentId: string): Promise<boolean> {
    const note = await this.prisma.fiscalDocument.findFirst({
      where: {
        affectedDocumentId: documentId,
        status: { in: LIVE_FISCAL_STATUSES },
        // RF-72: una NC archivada por reimportación dejó de acreditar nada.
        archivedAt: null,
      },
      select: { id: true },
    });
    return note !== null;
  }

  private async genericCustomer(): Promise<{ id: string; name: string }> {
    const generic = await this.prisma.customer.findFirst({
      where: { isSystem: true, docNumber: GENERIC_CUSTOMER_DOC_NUMBER },
      select: { id: true, name: true },
    });
    if (!generic) {
      throw new NotFoundException('No existe el cliente "público en general" sembrado (D-077)');
    }
    return generic;
  }

  /**
   * La línea de negocio del carrito, comprobando que sea **una sola** (D-104).
   *
   * El mensaje nombra los dos productos que no coinciden y no solo la regla: en un
   * mostrador, quien lo lee tiene el carrito delante y necesita saber cuál sacar.
   */
  private async resolveBusinessLine(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<BusinessLine> {
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, businessLine: { select: { code: true, name: true } } },
    });
    if (products.length !== new Set(productIds).size) {
      throw new NotFoundException('Hay un producto del carrito que no existe');
    }
    const [first] = products;
    if (!first) throw new BadRequestException('El carrito está vacío');
    const other = products.find((p) => p.businessLine.code !== first.businessLine.code);
    if (other) {
      throw new BadRequestException(
        `Una venta de mostrador es de una sola línea de negocio: ${first.sku} es de ${first.businessLine.name} y ${other.sku} de ${other.businessLine.name}. Cóbralas por separado.`,
      );
    }
    return toSharedLineCode(first.businessLine.code);
  }

  /**
   * Dónde ocurre el recojo (D-103).
   *
   * Hereda el punto de partida del último despacho registrado, que es el almacén real de la
   * empresa, y solo cae en la constante si todavía no hay ninguno. Es el mismo criterio con
   * el que `transportSuggestions` autocompleta el formulario de despacho: el dato correcto
   * ya está en los datos, no hace falta pedirlo otra vez ni inventarlo en la configuración.
   *
   * En un recojo ninguno de los dos campos llega a un documento —no hay guía—, así que su
   * papel es puramente el de dejar el registro interno legible.
   */
  private async pickupLocation(
    tx: Prisma.TransactionClient,
  ): Promise<{ address: string; ubigeo: string }> {
    const last = await tx.dispatch.findFirst({
      where: { transferMode: { not: TransferMode.PICKUP } },
      orderBy: { createdAt: 'desc' },
      select: { originAddress: true, originUbigeo: true },
    });
    return last === null
      ? DEFAULT_PICKUP
      : { address: last.originAddress, ubigeo: last.originUbigeo };
  }

  private async actorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => i !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

/**
 * Punto de recojo por defecto, solo hasta que exista el primer despacho con transporte.
 * Lima cercado: es la sede, y este dato no llega a ningún documento fiscal (D-103).
 */
const DEFAULT_PICKUP = { address: 'Mostrador — recojo en tienda', ubigeo: '150101' };

/** Estados en los que un comprobante **existe y sigue en pie** (espejo de `invoicing`). */
const LIVE_FISCAL_STATUSES: FiscalDocumentStatus[] = [...SHARED_LIVE_DOCUMENT_STATUSES];

/** Estados en los que el comprobante todavía espera respuesta del PSE (D-073). */
const PENDING_FISCAL_STATUSES: FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ISSUED,
  FiscalDocumentStatus.SEND_ERROR,
];

const saleInclude = {
  salesOrder: {
    select: {
      seq: true,
      customer: { select: { name: true, docNumber: true } },
    },
  },
  dispatch: { select: { seq: true } },
  fiscalDocument: { select: { number: true, status: true } },
} satisfies Prisma.PosSaleInclude;

type SaleRow = Prisma.PosSaleGetPayload<{ include: typeof saleInclude }>;

function toSaleDto(row: SaleRow, names: Map<string, string>): PosSaleListItemDto {
  return {
    id: row.id,
    code: posSaleCode(row.seq),
    status: row.status,
    cashSessionId: row.cashSessionId,
    customerName: row.salesOrder.customer.name,
    customerDocNumber: row.salesOrder.customer.docNumber,
    method: row.method as PosSaleListItemDto['method'],
    totalPen: row.totalPen.toFixed(4),
    salesOrderId: row.salesOrderId,
    salesOrderCode: salesOrderCode(row.salesOrder.seq),
    dispatchId: row.dispatchId,
    dispatchCode: dispatchCode(row.dispatch.seq),
    fiscalDocumentId: row.fiscalDocumentId,
    fiscalDocumentNumber: row.fiscalDocument.number,
    fiscalDocumentStatus: row.fiscalDocument.status,
    fiscalPending: PENDING_FISCAL_STATUSES.includes(row.fiscalDocument.status),
    createdAt: row.createdAt.toISOString(),
    createdByName: names.get(row.createdById) ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidedByName: row.voidedById === null ? null : (names.get(row.voidedById) ?? null),
    voidReason: row.voidReason,
  };
}
