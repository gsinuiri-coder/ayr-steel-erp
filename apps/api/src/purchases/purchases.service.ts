import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessLineCode,
  CoilStatus,
  Currency,
  CuttingOrderStatus,
  ExchangeRateSource,
  InventoryStrategy,
  Prisma,
  PurchaseStatus,
  PurchaseType,
  ServiceKind,
  type InventoryItemType,
  type Purchase,
  type PurchaseItem,
  type SupplierPayment,
} from '@prisma/client';
import {
  Decimal,
  LANDED_COST_SERVICE_KINDS,
  Role,
  SERVICE_KIND_LABELS,
  STOCK_PURCHASE_TYPES,
  toDecimal,
  toFixedString,
  Unit,
  type CreatePurchaseInput,
  type CreateSupplierPaymentInput,
  type InvoiceXmlPreviewDto,
  type PurchaseDto,
  type PurchaseListItemDto,
  type PurchaseQuery,
  type ReversePaymentInput,
  type SupplierPaymentDto,
  type SupplierStatementDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { CoilsService } from '../coils/coils.service';
import { StorageService } from '../documents/storage.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import { assertStripsNotAssigned } from '../production/production-assignments';
import { prorateByWeight } from './landed-cost';
import { parseInvoiceXml } from './invoice-xml';
import {
  computeDueDate,
  computeTotals,
  daysBetween,
  paidAmount,
  purchaseBalance,
  startOfDayUtc,
  toPurchaseCurrency,
} from './purchase-math';

/** Compras a proveedor (D-030): registro → recepción → cuenta por pagar → pagos. */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly storage: StorageService,
  ) {}

  /**
   * RF-11: lee el XML UBL 2.1 de la factura del proveedor, lo guarda en R2 y devuelve
   * la compra prellenada para que el usuario la revise. No crea nada en la base: el
   * alta real sigue siendo un `POST /purchases` con el `sourceXmlKey` que devuelve acá.
   */
  async previewFromXml(
    actor: RequestUser,
    file: { originalname: string; buffer: Buffer },
  ): Promise<InvoiceXmlPreviewDto> {
    const parsed = parseInvoiceXml(file.buffer);

    const supplier = parsed.supplierDocNumber
      ? await this.prisma.supplier.findFirst({
          where: { docNumber: parsed.supplierDocNumber, isActive: true },
          select: { id: true, code: true },
        })
      : null;

    const warnings = [...parsed.warnings];
    if (!supplier && parsed.supplierDocNumber) {
      warnings.push(
        `No hay un proveedor activo con documento ${parsed.supplierDocNumber}: créalo o elige otro`,
      );
    }

    const safeName =
      file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-150) || 'factura.xml';
    const sourceXmlKey = `purchases/xml/${randomUUID()}-${safeName}`;
    await this.storage.putObject(sourceXmlKey, file.buffer, 'application/xml');

    await this.audit.log({
      actorId: actor.id,
      action: 'purchases.xml-preview',
      entity: 'purchases',
      entityId: null,
      after: {
        sourceXmlKey,
        document: `${parsed.series}-${parsed.number}`,
        supplierDocNumber: parsed.supplierDocNumber,
      },
    });

    return {
      sourceXmlKey,
      supplierDocNumber: parsed.supplierDocNumber,
      supplierName: parsed.supplierName,
      supplierId: supplier?.id ?? null,
      supplierCode: supplier?.code ?? null,
      docType: parsed.docType,
      series: parsed.series,
      number: parsed.number,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate,
      currency: parsed.currency,
      paymentTerms: parsed.paymentTerms,
      creditDays: parsed.creditDays,
      igvRate: parsed.igvRate,
      subtotal: parsed.subtotal,
      igv: parsed.igv,
      total: parsed.total,
      lines: parsed.lines,
      warnings,
    };
  }

  async create(actor: RequestUser, input: CreatePurchaseInput): Promise<PurchaseDto> {
    const [supplier, businessLine] = await Promise.all([
      this.prisma.supplier.findUnique({ where: { id: input.supplierId } }),
      this.prisma.businessLine.findUnique({
        where: { code: toPrismaLineCode(input.businessLine) },
      }),
    ]);
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    if (!supplier.isActive) throw new BadRequestException('El proveedor está desactivado');
    if (!businessLine) throw new NotFoundException('Línea de negocio no encontrada');
    if (
      STOCK_PURCHASE_TYPES.includes(input.type) &&
      businessLine.inventoryStrategy === InventoryStrategy.NOOP
    ) {
      // Sin esto la recepción crearía bobinas o productos y el kardex los ignoraría en
      // silencio (§2.2: `services` es NOOP), dejando stock fantasma con saldo cero.
      throw new BadRequestException(
        `La línea "${input.businessLine}" no lleva inventario: no admite compras de ${input.type === PurchaseType.COIL ? 'bobinas' : 'producto terminado'}`,
      );
    }

    await this.assertItemsAreConsistent(input, businessLine.id);
    await this.assertLandedCostLinkIsValid(actor, input, businessLine.id);
    await this.assertCuttingOrderLinkIsValid(actor, input, businessLine.id);

    const { rate, source } = await this.resolveExchangeRate(input);
    const totals = computeTotals(input);
    const dueDate = computeDueDate(input);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const purchase = await tx.purchase.create({
          data: {
            supplierId: input.supplierId,
            businessLineId: businessLine.id,
            type: input.type,
            docType: input.docType,
            series: input.series,
            number: input.number,
            issueDate: new Date(`${input.issueDate}T00:00:00.000Z`),
            currency: input.currency,
            exchangeRate: toFixedString(rate, 'RATE'),
            exchangeRateSource: source,
            subtotal: toFixedString(totals.subtotal, 'MONEY'),
            igv: toFixedString(totals.igv, 'MONEY'),
            total: toFixedString(totals.total, 'MONEY'),
            totalPen: toFixedString(totals.total.times(rate), 'MONEY'),
            paymentTerms: input.paymentTerms,
            creditDays: input.paymentTerms === 'CREDITO' ? (input.creditDays ?? null) : null,
            dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null,
            serviceKind: input.type === PurchaseType.SERVICE ? (input.serviceKind ?? null) : null,
            relatedPurchaseId:
              input.type === PurchaseType.SERVICE ? (input.relatedPurchaseId ?? null) : null,
            relatedCuttingOrderId:
              input.type === PurchaseType.SERVICE ? (input.relatedCuttingOrderId ?? null) : null,
            sourceXmlKey: input.sourceXmlKey ?? null,
            notes: input.notes ?? null,
            createdById: actor.id,
            items: {
              create: totals.items.map((item, index) => ({
                lineNumber: index + 1,
                productId: item.productId ?? null,
                description: item.description,
                qty: toFixedString(item.qty, 'KG'),
                unit: item.unit,
                unitPrice: toFixedString(item.unitPrice, 'MONEY'),
                subtotal: toFixedString(item.subtotal, 'MONEY'),
                igv: toFixedString(item.igv, 'MONEY'),
                total: toFixedString(item.total, 'MONEY'),
                finishId: item.finishId ?? null,
                widthMm: item.widthMm ? toFixedString(item.widthMm, 'MM') : null,
                thicknessMm: item.thicknessMm ? toFixedString(item.thicknessMm, 'MM') : null,
              })),
            },
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'purchases.create',
          entity: 'purchases',
          entityId: purchase.id,
          after: {
            supplierId: purchase.supplierId,
            type: purchase.type,
            document: `${purchase.series}-${purchase.number}`,
            total: purchase.total.toFixed(4),
            currency: purchase.currency,
          },
        });
        return purchase;
      });
      return await this.findOne(created.id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ese comprobante ya está registrado para este proveedor');
      }
      throw err;
    }
  }

  /**
   * Recepción (D-030). COIL crea una bobina por línea, FINISHED_GOOD mueve el producto
   * de catálogo, SERVICE y EXPENSE no tocan inventario. Todo en una sola transacción:
   * o la compra queda recibida con sus movimientos, o no cambia nada.
   */
  async receive(actor: RequestUser, id: string): Promise<PurchaseDto> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!purchase) throw new NotFoundException('Compra no encontrada');
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('La compra está anulada');
    }
    if (purchase.status === PurchaseStatus.RECEIVED) {
      throw new BadRequestException('La compra ya fue recibida');
    }

    await this.prisma.$transaction(
      async (tx) => {
        // El cambio de estado va PRIMERO y condicionado a que siga en DRAFT: toma el lock
        // de la fila y hace que dos recepciones simultáneas no dupliquen movimientos de
        // kardex (la segunda ve 0 filas afectadas y aborta sin escribir nada).
        const claimed = await tx.purchase.updateMany({
          where: { id: purchase.id, status: PurchaseStatus.DRAFT },
          data: { status: PurchaseStatus.RECEIVED, receivedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ConflictException('La compra ya fue recibida o anulada por otra operación');
        }

        for (const item of purchase.items) {
          if (purchase.type === PurchaseType.COIL) {
            await this.coils.create(tx, {
              businessLineId: purchase.businessLineId,
              supplierId: purchase.supplierId,
              purchaseId: purchase.id,
              purchaseItemId: item.id,
              finishId: requireField(item.finishId, 'La línea no tiene acabado'),
              weightKg: item.qty.toFixed(3),
              widthMm: requireField(item.widthMm, 'La línea no tiene ancho').toFixed(2),
              thicknessMm: requireField(item.thicknessMm, 'La línea no tiene espesor').toFixed(2),
              currency: purchase.currency,
              exchangeRate: purchase.exchangeRate.toFixed(4),
              unitCostPerKg: item.unitPrice.toFixed(4),
              refType: 'PURCHASE',
              refId: purchase.id,
              actorId: actor.id,
            });
          } else if (purchase.type === PurchaseType.FINISHED_GOOD) {
            await this.inventory.record(tx, {
              businessLineId: purchase.businessLineId,
              itemType: 'PRODUCT',
              itemId: requireField(item.productId, 'La línea no tiene producto de catálogo'),
              type: 'IN',
              qty: item.qty.toFixed(3),
              unit: item.unit,
              // El kardex se lleva siempre en soles (D-042): una compra en USD y otra en
              // PEN del mismo producto tienen que promediar sobre la misma escala.
              unitCost: toFixedString(
                toDecimal(item.unitPrice.toString()).times(purchase.exchangeRate.toString()),
                'MONEY',
              ),
              refType: 'PURCHASE',
              refId: purchase.id,
              actorId: actor.id,
            });
          }
          // SERVICE y EXPENSE no mueven inventario (D-030): solo generan cuenta por pagar.
        }

        // Landed cost (D-043): un flete, una aduana o un seguro vinculados a una compra
        // de bobinas reparten su costo sin IGV entre esas bobinas al recibirse.
        const landed = await this.applyLandedCost(tx, purchase, actor);
        // Costo de corte tercerizado (RF-41): igual que el landed cost, pero prorrateado
        // entre los flejes ya recibidos de la orden de corte vinculada, sin importar si
        // esta compra llega antes o después de la recepción física (D-033).
        const cuttingCost = await this.applyCuttingOrderCost(tx, purchase, actor);

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'purchases.receive',
          entity: 'purchases',
          entityId: purchase.id,
          before: { status: purchase.status },
          after: {
            status: PurchaseStatus.RECEIVED,
            items: purchase.items.length,
            ...(landed ? { landedCost: landed } : {}),
            ...(cuttingCost ? { cuttingCost } : {}),
          },
        });
      },
      { timeout: 30_000 },
    );

    return this.findOne(id);
  }

  /**
   * Anular una compra. En `DRAFT` es solo un cambio de estado; una compra ya recibida
   * revierte además todos sus movimientos de kardex (Fase 2b) y anula las bobinas que
   * creó. Se bloquea si algo de lo que entró con esa compra ya se movió después:
   * revertir el ingreso de kilos que ya salieron dejaría el saldo en negativo.
   */
  async cancel(actor: RequestUser, id: string, reason: string): Promise<PurchaseDto> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!purchase) throw new NotFoundException('Compra no encontrada');
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('La compra ya está anulada');
    }

    await this.prisma.$transaction(
      async (tx) => {
        // El cambio de estado va primero y condicionado al estado leído: dos anulaciones
        // simultáneas no pueden revertir los mismos movimientos dos veces.
        const claimed = await tx.purchase.updateMany({
          where: { id, status: purchase.status },
          data: { status: PurchaseStatus.CANCELLED, cancelledAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ConflictException('La compra cambió de estado por otra operación');
        }

        // Los pagos se comprueban DENTRO de la transacción, después de tomar el lock de
        // la fila: leerlos antes dejaba pasar un pago concurrente y la compra quedaba
        // anulada con dinero aplicado, descuadrando el estado de cuenta del proveedor.
        // Solo cuentan los VIGENTES (Sesión M-2): uno ya anulado no es dinero aplicado,
        // es justamente lo que la reversa de pago existe para poder destrabar.
        const payments = await tx.supplierPayment.count({
          where: { purchaseId: id, reversedAt: null },
        });
        if (payments > 0) {
          throw new BadRequestException(
            'La compra tiene pagos registrados: anula primero los pagos al proveedor',
          );
        }

        let cancelledCoils = 0;
        if (purchase.status === PurchaseStatus.RECEIVED) {
          const own = await tx.inventoryMovement.findMany({
            where: { refType: 'PURCHASE', refId: id },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          // Para decidir qué es "posterior" cuentan TODOS los movimientos de la compra,
          // incluidos los ya revertidos y sus reversas: son suyos igual.
          await this.assertNothingMovedAfter(tx, own);

          // Pero solo se revierte lo que sigue vivo. Un recosteo (D-045) o una bobina
          // anulada (RF-21) dejan bajo el mismo `refId` un ingreso ya revertido más su
          // reversa: sin este filtro el bucle intentaba anular una anulación y la
          // compra quedaba sin poder anularse nunca, con un mensaje que no decía nada.
          const movements = liveMovements(own);

          // Del más nuevo al más viejo: si una compra generó un ingreso y luego un
          // ajuste de costo sobre el mismo ítem, el ajuste tiene que deshacerse primero.
          for (const movement of [...movements].reverse()) {
            await this.inventory.reverse(tx, movement.id, actor.id, reason);
            if (movement.type === 'ADJUST' && movement.itemType === 'COIL') {
              // El kardex ya volvió atrás; el costo del documento de la bobina también
              // tiene que hacerlo, o quedaría mostrando un landed cost que ya no existe.
              await this.bumpCoilDocumentCost(
                tx,
                movement.itemId,
                toDecimal(movement.totalCost.toString()).negated(),
                toDecimal(movement.qty.toString()),
              );
            }
          }

          // D-050: enviar una bobina a corte tercerizado no genera movimiento de kardex,
          // así que `assertNothingMovedAfter` no la detecta como "posterior". Sin este
          // chequeo, anular la compra la cancelaba igual, dejando la orden de corte
          // apuntando a una bobina que ya no existe.
          const outAtCutter = await tx.coil.findMany({
            where: { purchaseId: id, status: CoilStatus.IN_THIRD_PARTY },
            select: { code: true },
          });
          if (outAtCutter.length > 0) {
            throw new BadRequestException(
              `No se puede anular la compra: ${outAtCutter.map((c) => c.code).join(', ')} está en corte tercerizado. Recíbela o cancela esa orden primero.`,
            );
          }

          // D-060: mismo hueco que el anterior, ahora con producción. Los flejes que
          // nacieron de una bobina de esta compra heredan su `purchaseId`, y montarlos en
          // una OP tampoco deja movimiento de kardex que `assertNothingMovedAfter` pueda
          // ver: sin este chequeo la anulación los cancelaba con la orden en curso.
          const purchaseCoils = await tx.coil.findMany({
            where: { purchaseId: id, status: { not: CoilStatus.CANCELLED } },
            select: { id: true },
          });
          await assertStripsNotAssigned(
            tx,
            purchaseCoils.map((c) => c.id),
            'anular la compra',
          );

          const cancelled = await tx.coil.updateMany({
            where: { purchaseId: id, status: { not: CoilStatus.CANCELLED } },
            data: { status: CoilStatus.CANCELLED },
          });
          cancelledCoils = cancelled.count;
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'purchases.cancel',
          entity: 'purchases',
          entityId: id,
          before: { status: purchase.status },
          after: {
            status: PurchaseStatus.CANCELLED,
            reason,
            cancelledCoils,
          },
        });
      },
      // Una compra admite 200 líneas y cada reversa son varios viajes a Neon: con 30 s
      // una anulación grande se quedaba sin tiempo, hacía rollback y la compra no se
      // podía anular nunca. Ver la nota de rendimiento en docs/PROGRESO.md.
      { timeout: 120_000, maxWait: 10_000 },
    );
    return this.findOne(id);
  }

  /**
   * Corta la anulación si algún ítem que entró con la compra tiene movimientos ajenos a
   * ella (una venta, un partido, una merma, un landed cost de otra compra). El mensaje
   * nombra el ítem y qué lo movió: sin eso el usuario solo sabe que no puede y no por qué.
   */
  private async assertNothingMovedAfter(
    tx: Prisma.TransactionClient,
    movements: { id: bigint; itemType: InventoryItemType; itemId: string }[],
  ): Promise<void> {
    if (movements.length === 0) return;
    const ownIds = new Set(movements.map((m) => m.id));

    // "Posterior" se mide por ítem y contra el ÚLTIMO movimiento que esta compra le
    // hizo, no contra el conjunto entero. Anular un flete (D-043) no puede quedar
    // bloqueado por el ingreso de la bobina, que es anterior a su propio ajuste.
    const lastOwnId = new Map<string, bigint>();
    for (const m of movements) {
      const current = lastOwnId.get(m.itemId);
      if (current === undefined || m.id > current) lastOwnId.set(m.itemId, m.id);
    }

    const later = await tx.inventoryMovement.findMany({
      where: {
        OR: [...lastOwnId].map(([itemId, id]) => ({ itemId, id: { gt: id } })),
      },
      orderBy: { id: 'asc' },
      include: { reversals: { select: { id: true } } },
      take: 50,
    });
    // Lo que ya se anuló no bloquea: una merma registrada y anulada después deja el
    // saldo intacto, y contarla dejaría la compra sin poder anularse nunca más.
    const blocking = liveMovements(later)
      .filter((m) => !ownIds.has(m.id))
      .slice(0, 5);
    if (blocking.length === 0) return;

    const labels = await this.resolveMovementLabels(tx, blocking);
    const detail = blocking
      .map((m) => `${labels.get(m.itemId) ?? m.itemId} (${m.refType})`)
      .join(', ');
    throw new BadRequestException(
      `No se puede anular la compra: ${detail} ya tiene movimientos posteriores. Anúlalos primero.`,
    );
  }

  private async resolveMovementLabels(
    tx: Prisma.TransactionClient,
    movements: { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, string>> {
    const coilIds = movements.filter((m) => m.itemType === 'COIL').map((m) => m.itemId);
    const productIds = movements.filter((m) => m.itemType === 'PRODUCT').map((m) => m.itemId);
    const [coils, products] = await Promise.all([
      coilIds.length
        ? tx.coil.findMany({ where: { id: { in: coilIds } }, select: { id: true, code: true } })
        : Promise.resolve([]),
      productIds.length
        ? tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true },
          })
        : Promise.resolve([]),
    ]);
    return new Map([
      ...coils.map((c) => [c.id, c.code] as const),
      ...products.map((p) => [p.id, p.sku] as const),
    ]);
  }

  /**
   * D-043. Reparte el costo sin IGV de una compra de servicio, ya convertido a soles,
   * entre las bobinas con saldo de la compra `COIL` vinculada, **por kilo**. Cada
   * bobina recibe un `ADJUST` de costo (no de cantidad) y ve subir su `unitCostPerKg`.
   * Devuelve `null` cuando la compra no es un servicio imputable.
   */
  private async applyLandedCost(
    tx: Prisma.TransactionClient,
    purchase: Purchase,
    actor: RequestUser,
  ): Promise<{ amountPen: string; coils: number; imputed: boolean } | null> {
    if (purchase.type !== PurchaseType.SERVICE || !purchase.relatedPurchaseId) return null;
    if (!purchase.serviceKind || !LANDED_COST_SERVICE_KINDS.includes(purchase.serviceKind)) {
      return null;
    }

    const related = await tx.purchase.findUnique({
      where: { id: purchase.relatedPurchaseId },
      select: { id: true, status: true, series: true, number: true },
    });
    if (!related) throw new NotFoundException('La compra de bobinas vinculada no existe');
    const service = SERVICE_KIND_LABELS[purchase.serviceKind].toLowerCase();
    if (related.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException(
        `La compra ${related.series}-${related.number} está anulada: registra el ${service} sin vincularlo a ella`,
      );
    }
    if (related.status !== PurchaseStatus.RECEIVED) {
      throw new BadRequestException(
        `La compra ${related.series}-${related.number} todavía no fue recibida: recíbela antes de imputarle el ${service}`,
      );
    }

    const coils = await tx.coil.findMany({
      where: { purchaseId: related.id, status: { not: CoilStatus.CANCELLED } },
      select: { id: true, code: true, businessLineId: true },
      orderBy: { code: 'asc' },
    });
    if (coils.length === 0) return { amountPen: '0.0000', coils: 0, imputed: false };

    // Se bloquean las bobinas antes de leer sus saldos: sin esto, entre la lectura y el
    // `FOR UPDATE` interno de `adjustCost` alguien puede consumir la bobina y el ajuste
    // se pierde, dejando el costo del documento inflado sin movimiento que lo respalde.
    // (`assertStripsNotAssigned` toma el mismo lock, así que este bloque queda cubierto.)
    // D-060: un fleje nacido de estas bobinas puede estar montado en una OP viva —los
    // flejes heredan el `purchaseId` de su madre—, y subirle el costo a mitad de corrida
    // haría que los reportes previos y los siguientes salieran a costos distintos. Es la
    // misma razón por la que D-045 (recostear una bobina) ya está bloqueado.
    await assertStripsNotAssigned(
      tx,
      coils.map((c) => c.id),
      'imputar este costo',
    );

    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
      select: { itemId: true, qty: true },
    });
    const availableKg = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    // Una bobina ya consumida no recibe imputación: su costo salió del inventario y
    // reescribirlo tocaría movimientos pasados (D-043).
    const targets = coils.filter((c) => (availableKg.get(c.id) ?? new Decimal(0)).gt(0));
    if (targets.length === 0) {
      // La recepción NO se aborta: la deuda con el proveedor del servicio existe igual
      // y tiene que llegar a la cuenta por pagar (D-030). Solo no hay dónde imputar el
      // costo, y eso queda dicho en la auditoría de la recepción.
      return { amountPen: '0.0000', coils: 0, imputed: false };
    }

    const amountPen = toDecimal(purchase.subtotal.toString()).times(
      purchase.exchangeRate.toString(),
    );
    const shares = prorateByWeight(
      amountPen,
      targets.map((c) => ({ id: c.id, qtyKg: availableKg.get(c.id) ?? new Decimal(0) })),
    );
    const noteLabel = `${SERVICE_KIND_LABELS[purchase.serviceKind]} ${purchase.series}-${purchase.number} (D-043)`;

    let imputedCoils = 0;
    for (const share of shares) {
      const coil = targets.find((c) => c.id === share.id);
      const qty = availableKg.get(share.id);
      if (!coil || !qty || qty.lte(0) || share.amountPen.isZero()) continue;

      const movement = await this.inventory.adjustCost(tx, {
        businessLineId: coil.businessLineId,
        itemType: 'COIL',
        itemId: coil.id,
        unit: Unit.KGM,
        amountPen: toFixedString(share.amountPen, 'MONEY'),
        refType: 'PURCHASE',
        refId: purchase.id,
        notes: noteLabel,
        actorId: actor.id,
      });
      // Si el kardex no aceptó el ajuste (línea NOOP o saldo en cero), el documento de
      // la bobina tampoco se toca: un `unitCostPerKg` sin movimiento detrás no se puede
      // revertir después y quedaría mintiendo para siempre.
      if (!movement) continue;

      imputedCoils += 1;
      const before = await this.bumpCoilDocumentCost(
        tx,
        coil.id,
        share.amountPen,
        toDecimal(movement.qty.toString()),
      );
      // Auditoría por bobina (RF-95): el `unitCostPerKg` de una bobina también cambia
      // por acá, no solo por RF-20, y con un único registro a nivel de compra no se
      // podría reconstruir después qué costo tenía cada bobina antes del flete.
      if (before) {
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'coils.landed-cost',
          entity: 'coils',
          entityId: coil.id,
          before: { unitCostPerKg: before.from },
          after: {
            unitCostPerKg: before.to,
            amountPen: toFixedString(share.amountPen, 'MONEY'),
            servicePurchaseId: purchase.id,
            reason: noteLabel,
          },
        });
      }
    }

    return {
      amountPen: toFixedString(amountPen, 'MONEY'),
      coils: imputedCoils,
      imputed: imputedCoils > 0,
    };
  }

  /**
   * RF-41. Reparte el costo sin IGV de una compra de servicio `CUTTING`, ya convertido a
   * soles, entre los flejes **recibidos** de la orden de corte vinculada que todavía
   * tengan saldo, por kilo — misma mecánica que `applyLandedCost` (D-043), incluido el
   * `refType='PURCHASE'` para que `cancel` la revierta igual que un landed cost. No
   * importa si esta compra se registra antes o después de la recepción física (D-033):
   * cada vez que se recibe, reparte entre lo que exista en ese momento.
   */
  private async applyCuttingOrderCost(
    tx: Prisma.TransactionClient,
    purchase: Purchase,
    actor: RequestUser,
  ): Promise<{ amountPen: string; strips: number; imputed: boolean } | null> {
    if (purchase.type !== PurchaseType.SERVICE || !purchase.relatedCuttingOrderId) return null;
    if (purchase.serviceKind !== ServiceKind.CUTTING) return null;

    const order = await tx.cuttingOrder.findUnique({
      where: { id: purchase.relatedCuttingOrderId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('La orden de corte vinculada no existe');
    if (order.status === CuttingOrderStatus.CANCELLED) {
      throw new BadRequestException(
        'La orden de corte vinculada está anulada: registra el corte sin vincularlo a ella',
      );
    }

    const strips = await tx.coil.findMany({
      where: {
        cuttingOrderCoil: { cuttingOrderId: order.id },
        status: { not: CoilStatus.CANCELLED },
      },
      select: { id: true, code: true, businessLineId: true },
      orderBy: { code: 'asc' },
    });
    if (strips.length === 0) return { amountPen: '0.0000', strips: 0, imputed: false };

    // Mismo cuidado que `applyLandedCost`: bloquear antes de leer saldos evita que un
    // consumo concurrente deje el costo del documento inflado sin movimiento detrás, y el
    // guardrail de D-060 impide subirle el costo a un fleje que una OP viva ya está
    // perfilando (sus reportes previos habrían salido a otro costo que los siguientes).
    await assertStripsNotAssigned(
      tx,
      strips.map((s) => s.id),
      'imputar el costo del corte',
    );

    const balances = await tx.inventoryBalance.findMany({
      where: { itemType: 'COIL', itemId: { in: strips.map((s) => s.id) } },
      select: { itemId: true, qty: true },
    });
    const availableKg = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
    const targets = strips.filter((s) => (availableKg.get(s.id) ?? new Decimal(0)).gt(0));
    if (targets.length === 0) {
      // La deuda con el proveedor de corte existe igual (D-030); solo no hay dónde
      // imputar el costo porque los flejes ya se consumieron.
      return { amountPen: '0.0000', strips: 0, imputed: false };
    }

    const amountPen = toDecimal(purchase.subtotal.toString()).times(
      purchase.exchangeRate.toString(),
    );
    const shares = prorateByWeight(
      amountPen,
      targets.map((s) => ({ id: s.id, qtyKg: availableKg.get(s.id) ?? new Decimal(0) })),
    );
    const noteLabel = `Corte tercerizado ${purchase.series}-${purchase.number} (RF-41)`;

    let imputedStrips = 0;
    for (const share of shares) {
      const strip = targets.find((s) => s.id === share.id);
      const qty = availableKg.get(share.id);
      if (!strip || !qty || qty.lte(0) || share.amountPen.isZero()) continue;

      const movement = await this.inventory.adjustCost(tx, {
        businessLineId: strip.businessLineId,
        itemType: 'COIL',
        itemId: strip.id,
        unit: Unit.KGM,
        amountPen: toFixedString(share.amountPen, 'MONEY'),
        refType: 'PURCHASE',
        refId: purchase.id,
        notes: noteLabel,
        actorId: actor.id,
      });
      if (!movement) continue;

      imputedStrips += 1;
      const before = await this.bumpCoilDocumentCost(
        tx,
        strip.id,
        share.amountPen,
        toDecimal(movement.qty.toString()),
      );
      if (before) {
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'coils.cutting-cost',
          entity: 'coils',
          entityId: strip.id,
          before: { unitCostPerKg: before.from },
          after: {
            unitCostPerKg: before.to,
            amountPen: toFixedString(share.amountPen, 'MONEY'),
            servicePurchaseId: purchase.id,
            reason: noteLabel,
          },
        });
      }
    }

    return {
      amountPen: toFixedString(amountPen, 'MONEY'),
      strips: imputedStrips,
      imputed: imputedStrips > 0,
    };
  }

  /**
   * Mueve el costo del **documento** de una bobina (`unitCostPerKg` y sus totales) por
   * el mismo monto que se le imputó al kardex. El kardex va en soles (D-042) y el
   * documento en la moneda de la bobina (D-038), así que el delta se divide por su
   * tipo de cambio. `amountPen` negativo deshace la imputación.
   */
  private async bumpCoilDocumentCost(
    tx: Prisma.TransactionClient,
    coilId: string,
    amountPen: Decimal,
    qtyKg: Decimal,
  ): Promise<{ from: string; to: string } | null> {
    if (qtyKg.lte(0) || amountPen.isZero()) return null;
    const coil = await tx.coil.findUnique({
      where: { id: coilId },
      select: { weightKg: true, exchangeRate: true, unitCostPerKg: true },
    });
    if (!coil) return null;

    const exchangeRate = toDecimal(coil.exchangeRate.toString());
    const deltaPerKg = amountPen.div(qtyKg).div(exchangeRate);
    const newUnitCost = Decimal.max(
      toDecimal(coil.unitCostPerKg.toString()).plus(deltaPerKg),
      new Decimal(0),
    );
    const totalCost = toDecimal(coil.weightKg.toString()).times(newUnitCost);
    await tx.coil.update({
      where: { id: coilId },
      data: {
        unitCostPerKg: toFixedString(newUnitCost, 'MONEY'),
        totalCost: toFixedString(totalCost, 'MONEY'),
        totalCostPen: toFixedString(totalCost.times(exchangeRate), 'MONEY'),
      },
    });
    return { from: coil.unitCostPerKg.toFixed(4), to: toFixedString(newUnitCost, 'MONEY') };
  }

  /** Pago parcial o total (D-039). El saldo se recalcula, nunca se almacena. */
  async addPayment(
    actor: RequestUser,
    purchaseId: string,
    input: CreateSupplierPaymentInput,
  ): Promise<PurchaseDto> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: { payments: true },
    });
    if (!purchase) throw new NotFoundException('Compra no encontrada');
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('La compra está anulada');
    }

    // El tipo de cambio que convierte el pago es siempre el de la moneda extranjera en
    // juego, no el de la moneda del pago: pagar S/ contra una factura en USD sin este
    // ajuste resolvería un TC de 1.0000 y cancelaría el saldo con la cifra equivocada.
    const rateCurrency = input.currency === Currency.PEN ? purchase.currency : input.currency;
    const rate = input.exchangeRate
      ? toDecimal(input.exchangeRate)
      : (await this.rateFor(input.date, rateCurrency)).rate;

    const applied = toPurchaseCurrency(
      toDecimal(input.amount),
      input.currency,
      purchase.currency,
      rate,
    );

    await this.prisma.$transaction(async (tx) => {
      // Bloquea la compra y recalcula el saldo dentro de la transacción: dos pagos
      // concurrentes que por separado caben en el saldo no pueden sobrepagarla.
      await tx.$queryRaw`SELECT "id" FROM "purchases" WHERE "id" = ${purchaseId}::uuid FOR UPDATE`;
      const current = await tx.purchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { payments: true },
      });
      if (current.status === PurchaseStatus.CANCELLED) {
        throw new BadRequestException('La compra está anulada');
      }
      const balance = purchaseBalance(current, current.payments);
      if (applied.gt(balance)) {
        throw new BadRequestException(
          `El pago excede el saldo pendiente (${balance.toFixed(2)} ${current.currency})`,
        );
      }

      const payment = await tx.supplierPayment.create({
        data: {
          purchaseId,
          date: new Date(`${input.date}T00:00:00.000Z`),
          amount: toFixedString(input.amount, 'MONEY'),
          currency: input.currency,
          exchangeRate: toFixedString(rate, 'RATE'),
          method: input.method,
          reference: input.reference ?? null,
          createdById: actor.id,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'purchases.payment',
        entity: 'supplier_payments',
        entityId: payment.id,
        after: {
          purchaseId,
          amount: payment.amount.toFixed(4),
          currency: payment.currency,
          method: payment.method,
        },
      });
    });
    return this.findOne(purchaseId);
  }

  /**
   * Anular un pago (Sesión M-2, cierra D-039: "anular un pago se resuelve en Fase 2b
   * junto con el resto de anulaciones", nunca construido). El monto vuelve a formar
   * parte del saldo pendiente; la fila nunca se borra (append-only, igual que RF-16 y
   * D-052), se marca `reversedAt`/`reversedById` y el motivo queda en la auditoría.
   *
   * Guardrail "todo o nada", mismo criterio que el resto de reversas del proyecto:
   * - el pago no puede estar ya anulado (idempotencia, como `InventoryService.reverse`);
   * - la compra no puede estar `CANCELLED` — hoy es inalcanzable por la API (`cancel()`
   *   exige cero pagos vigentes antes de anular, así que una compra `CANCELLED` nunca
   *   tiene un pago vivo que revertir), pero se comprueba igual, por defensa, con el
   *   mismo criterio que ya usa `addPayment`.
   */
  async reversePayment(
    actor: RequestUser,
    purchaseId: string,
    paymentId: string,
    input: ReversePaymentInput,
  ): Promise<PurchaseDto> {
    await this.prisma.$transaction(async (tx) => {
      // Mismo lock que `addPayment`/`cancel`: no cambia el resultado de esta operación
      // (revertir un pago solo puede subir el saldo, nunca dejarlo negativo), pero
      // mantiene un único punto de serialización por compra para todo lo que toca su
      // cuenta por pagar, en vez de que cada mutación decida su propio criterio.
      await tx.$queryRaw`SELECT "id" FROM "purchases" WHERE "id" = ${purchaseId}::uuid FOR UPDATE`;
      const purchase = await tx.purchase.findUnique({ where: { id: purchaseId } });
      if (!purchase) throw new NotFoundException('Compra no encontrada');
      if (purchase.status === PurchaseStatus.CANCELLED) {
        throw new BadRequestException('La compra está anulada');
      }

      const payment = await tx.supplierPayment.findFirst({
        where: { id: paymentId, purchaseId },
      });
      if (!payment) throw new NotFoundException('Pago no encontrado');

      // El cambio de estado va primero y condicionado al estado leído (mismo patrón que
      // `cancel()`): dos anulaciones simultáneas del mismo pago no pueden convivir.
      const claimed = await tx.supplierPayment.updateMany({
        where: { id: paymentId, reversedAt: null },
        data: { reversedById: actor.id, reversedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException('Ese pago ya fue anulado');
      }

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'purchases.payment-reverse',
        entity: 'supplier_payments',
        entityId: paymentId,
        before: {
          purchaseId,
          amount: payment.amount.toFixed(4),
          currency: payment.currency,
          method: payment.method,
        },
        after: { reason: input.reason },
      });
    });
    return this.findOne(purchaseId);
  }

  async findAll(query: PurchaseQuery): Promise<PurchaseListItemDto[]> {
    const purchases = await this.prisma.purchase.findMany({
      where: {
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
        type: query.type,
        status: query.status,
        supplierId: query.supplierId,
        issueDate: {
          gte: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
          lte: query.to ? new Date(`${query.to}T00:00:00.000Z`) : undefined,
        },
        ...(query.search
          ? {
              OR: [
                { number: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                { series: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
                {
                  supplier: {
                    name: { contains: query.search, mode: Prisma.QueryMode.insensitive },
                  },
                },
              ],
            }
          : {}),
      },
      include: PURCHASE_RELATIONS,
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });

    const dtos = purchases.map((p) => toListDto(p));
    return query.onlyWithBalance ? dtos.filter((p) => toDecimal(p.balance).gt(0)) : dtos;
  }

  async findOne(id: string): Promise<PurchaseDto> {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: {
        ...PURCHASE_RELATIONS,
        items: {
          orderBy: { lineNumber: 'asc' },
          include: {
            product: { select: { sku: true } },
            finish: { select: { code: true } },
            coil: { select: { code: true } },
          },
        },
      },
    });
    if (!purchase) throw new NotFoundException('Compra no encontrada');
    return {
      ...toListDto(purchase),
      items: purchase.items.map(toItemDto),
      payments: purchase.payments.map(toPaymentDto),
    };
  }

  /** Estado de cuenta por proveedor (D-039): compras con saldo, antigüedad y total adeudado. */
  async supplierStatement(supplierId: string): Promise<SupplierStatementDto> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');

    const purchases = await this.prisma.purchase.findMany({
      where: { supplierId, status: { not: PurchaseStatus.CANCELLED } },
      include: PURCHASE_RELATIONS,
      orderBy: [{ issueDate: 'asc' }],
    });

    const today = startOfDayUtc(new Date());
    const rows = purchases
      .map((p) => {
        const dto = toListDto(p);
        const balance = toDecimal(dto.balance);
        return {
          ...dto,
          balancePen: toFixedString(balance.times(toDecimal(dto.exchangeRate)), 'MONEY'),
          overdueDays: p.dueDate ? daysBetween(startOfDayUtc(p.dueDate), today) : null,
        };
      })
      .filter((p) => toDecimal(p.balance).gt(0));

    const totalBalancePen = rows.reduce(
      (acc, row) => acc.plus(toDecimal(row.balancePen)),
      new Decimal(0),
    );

    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierCode: supplier.code,
      totalBalancePen: toFixedString(totalBalancePen, 'MONEY'),
      purchases: rows,
    };
  }

  /** Valida que cada línea case con el tipo de compra y con la línea de negocio elegida. */
  private async assertItemsAreConsistent(
    input: CreatePurchaseInput,
    businessLineId: string,
  ): Promise<void> {
    if (input.type === PurchaseType.COIL) {
      const finishIds = [
        ...new Set(input.items.map((i) => i.finishId).filter(Boolean)),
      ] as string[];
      const finishes = await this.prisma.finish.findMany({
        where: { id: { in: finishIds }, isActive: true },
        select: { id: true },
      });
      if (finishes.length !== finishIds.length) {
        throw new BadRequestException('Alguna línea usa un acabado inexistente o desactivado');
      }
    }
    if (input.type === PurchaseType.FINISHED_GOOD) {
      const productIds = [
        ...new Set(input.items.map((i) => i.productId).filter(Boolean)),
      ] as string[];
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds }, isActive: true },
        select: { id: true, businessLineId: true },
      });
      if (products.length !== productIds.length) {
        throw new BadRequestException('Alguna línea usa un producto inexistente o desactivado');
      }
      if (products.some((p) => p.businessLineId !== businessLineId)) {
        throw new BadRequestException(
          'Todos los productos de la compra deben ser de la línea de negocio elegida',
        );
      }
    }
  }

  /**
   * D-043: el vínculo de landed cost solo vale hacia una compra `COIL` viva. El schema
   * Zod ya cortó los `serviceKind` que no se imputan; acá se valida lo que necesita la
   * base de datos delante.
   */
  private async assertLandedCostLinkIsValid(
    actor: RequestUser,
    input: CreatePurchaseInput,
    businessLineId: string,
  ): Promise<void> {
    if (!input.relatedPurchaseId) return;
    // Imputar landed cost mueve el costo promedio del inventario, que es exactamente lo
    // que D-045 y §3.4 reservan a ADMINISTRADOR: sin este corte, un supervisor podría
    // inflar el valorizado con una factura de flete inventada y nadie podría revertirlo
    // en cuanto esas bobinas se movieran (lo levantó `auditor-seguridad`).
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException(
        'Solo un administrador puede imputar el costo de un servicio a una compra de bobinas',
      );
    }
    const related = await this.prisma.purchase.findUnique({
      where: { id: input.relatedPurchaseId },
      select: { id: true, type: true, status: true, businessLineId: true },
    });
    if (!related) throw new NotFoundException('La compra de bobinas vinculada no existe');
    if (related.type !== PurchaseType.COIL) {
      throw new BadRequestException(
        'El costo de un servicio solo se imputa a una compra de bobinas (D-043)',
      );
    }
    if (related.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('La compra de bobinas vinculada está anulada');
    }
    // El `ADJUST` se graba con la línea de la bobina: si el servicio se registró en otra
    // línea, el valorizado de esa línea (RF-51) subiría por un costo que no aparece en
    // ninguna de sus compras y el margen por línea dejaría de cuadrar.
    if (related.businessLineId !== businessLineId) {
      throw new BadRequestException(
        'El servicio y la compra de bobinas tienen que estar en la misma línea de negocio',
      );
    }
  }

  /**
   * RF-41: el vínculo a una orden de corte solo vale para `serviceKind=CUTTING` y solo
   * ADMINISTRADOR lo puede crear, por el mismo motivo que el landed cost (D-043): mueve
   * el costo promedio del inventario sin tope y sin poder revertirlo una vez que los
   * flejes se mueven.
   */
  private async assertCuttingOrderLinkIsValid(
    actor: RequestUser,
    input: CreatePurchaseInput,
    businessLineId: string,
  ): Promise<void> {
    if (!input.relatedCuttingOrderId) return;
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException(
        'Solo un administrador puede imputar el costo de un servicio a una orden de corte',
      );
    }
    const order = await this.prisma.cuttingOrder.findUnique({
      where: { id: input.relatedCuttingOrderId },
      select: { id: true, status: true, businessLineId: true },
    });
    if (!order) throw new NotFoundException('La orden de corte vinculada no existe');
    if (order.status === CuttingOrderStatus.CANCELLED) {
      throw new BadRequestException('La orden de corte vinculada está anulada');
    }
    if (order.businessLineId !== businessLineId) {
      throw new BadRequestException(
        'El servicio y la orden de corte tienen que estar en la misma línea de negocio',
      );
    }
  }

  private async resolveExchangeRate(
    input: CreatePurchaseInput,
  ): Promise<{ rate: Decimal; source: ExchangeRateSource }> {
    if (input.exchangeRate) {
      return { rate: toDecimal(input.exchangeRate), source: ExchangeRateSource.MANUAL };
    }
    return this.rateFor(input.issueDate, input.currency);
  }

  /** TC del día (D-029). Para pagar en moneda extranjera se compra al tipo de venta. */
  private async rateFor(
    date: string,
    currency: Currency,
  ): Promise<{ rate: Decimal; source: ExchangeRateSource }> {
    if (currency === Currency.PEN) {
      return { rate: new Decimal(1), source: ExchangeRateSource.MANUAL };
    }
    const dto = await this.exchangeRates.getRate(date, currency);
    return { rate: toDecimal(dto.sell), source: dto.source };
  }
}

function requireField<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new BadRequestException(message);
  return value;
}

// ---------------------------------------------------------------------------
// Mapeo a DTO
// ---------------------------------------------------------------------------

const PURCHASE_RELATIONS = {
  supplier: { select: { name: true, code: true } },
  businessLine: { select: { code: true } },
  payments: { orderBy: { date: 'asc' } },
  relatedPurchase: { select: { series: true, number: true } },
  relatedCuttingOrder: { select: { id: true, supplier: { select: { name: true } } } },
  // Servicios (flete, aduanas, seguro) imputados a esta compra de bobinas (D-043).
  landedCostServices: {
    select: {
      id: true,
      series: true,
      number: true,
      serviceKind: true,
      status: true,
      subtotal: true,
      exchangeRate: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.PurchaseInclude;

type PurchaseWithRelations = Purchase & {
  supplier: { name: string; code: string };
  businessLine: { code: BusinessLineCode };
  payments: SupplierPayment[];
  relatedPurchase: { series: string; number: string } | null;
  relatedCuttingOrder: { id: string; supplier: { name: string } } | null;
  landedCostServices: {
    id: string;
    series: string;
    number: string;
    serviceKind: ServiceKind | null;
    status: PurchaseStatus;
    subtotal: Prisma.Decimal;
    exchangeRate: Prisma.Decimal;
  }[];
};

function toListDto(p: PurchaseWithRelations): PurchaseListItemDto {
  return {
    id: p.id,
    supplierId: p.supplierId,
    supplierName: p.supplier.name,
    supplierCode: p.supplier.code,
    businessLine: toSharedLineCode(p.businessLine.code),
    type: p.type,
    docType: p.docType,
    series: p.series,
    number: p.number,
    documentLabel: `${p.series}-${p.number}`,
    issueDate: p.issueDate.toISOString().slice(0, 10),
    currency: p.currency,
    exchangeRate: p.exchangeRate.toFixed(4),
    exchangeRateSource: p.exchangeRateSource,
    subtotal: p.subtotal.toFixed(4),
    igv: p.igv.toFixed(4),
    total: p.total.toFixed(4),
    totalPen: p.totalPen.toFixed(4),
    paymentTerms: p.paymentTerms,
    creditDays: p.creditDays,
    dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
    status: p.status,
    serviceKind: p.serviceKind,
    relatedPurchaseId: p.relatedPurchaseId,
    relatedPurchaseLabel: p.relatedPurchase
      ? `${p.relatedPurchase.series}-${p.relatedPurchase.number}`
      : null,
    relatedCuttingOrderId: p.relatedCuttingOrderId,
    relatedCuttingOrderLabel: p.relatedCuttingOrder
      ? `Corte · ${p.relatedCuttingOrder.supplier.name}`
      : null,
    // `flatMap` en vez de `filter` + `map`: así TypeScript estrecha `serviceKind` sin
    // una aserción, que es lo que un servicio nunca debería necesitar acá.
    landedCostServices: p.landedCostServices.flatMap((s) =>
      s.serviceKind === null
        ? []
        : [
            {
              purchaseId: s.id,
              documentLabel: `${s.series}-${s.number}`,
              serviceKind: s.serviceKind,
              status: s.status,
              // Sin IGV (D-038) y en soles (D-042): lo que entró al kardex.
              amountPen: toFixedString(
                toDecimal(s.subtotal.toString()).times(s.exchangeRate.toString()),
                'MONEY',
              ),
            },
          ],
    ),
    sourceXmlKey: p.sourceXmlKey,
    notes: p.notes,
    paidAmount: toFixedString(paidAmount(p, p.payments), 'MONEY'),
    balance: toFixedString(purchaseBalance(p, p.payments), 'MONEY'),
    receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

function toItemDto(
  item: PurchaseItem & {
    product: { sku: string } | null;
    finish: { code: string } | null;
    coil: { code: string } | null;
  },
) {
  return {
    id: item.id,
    lineNumber: item.lineNumber,
    productId: item.productId,
    productSku: item.product?.sku ?? null,
    description: item.description,
    qty: item.qty.toFixed(3),
    unit: item.unit,
    unitPrice: item.unitPrice.toFixed(4),
    subtotal: item.subtotal.toFixed(4),
    igv: item.igv.toFixed(4),
    total: item.total.toFixed(4),
    finishId: item.finishId,
    finishCode: item.finish?.code ?? null,
    widthMm: item.widthMm ? item.widthMm.toFixed(2) : null,
    thicknessMm: item.thicknessMm ? item.thicknessMm.toFixed(2) : null,
    coilCode: item.coil?.code ?? null,
  };
}

function toPaymentDto(p: SupplierPayment): SupplierPaymentDto {
  return {
    id: p.id,
    purchaseId: p.purchaseId,
    date: p.date.toISOString().slice(0, 10),
    amount: p.amount.toFixed(4),
    currency: p.currency,
    exchangeRate: p.exchangeRate.toFixed(4),
    method: p.method,
    reference: p.reference,
    createdAt: p.createdAt.toISOString(),
    reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
  };
}
