import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryItemType, Prisma, PurchaseStatus, PurchaseType } from '@prisma/client';
import {
  cents,
  coilTypeKey,
  Decimal,
  dispatchCode,
  money,
  productionOrderCode,
  toDateOnly,
  Role,
  toDecimal,
  toFixedString,
  type CommitReceivedPurchaseEditInput,
  type EditReceivedPurchaseInput,
  type ReceivedEditPlanDto,
  type ReceivedPurchaseItemEdit,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { claimIdempotencyKey } from '../common/idempotency';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import { findLiveStripAssignments } from '../production/production-assignments';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { assertRawMaterialInvariant, findRawMaterialShortfalls } from '../sales/raw-material';
import { reservedByItem } from '../sales/reserved-ledger';
import { computeDueDate, receptionCost } from './purchase-math';
import { editedLineAmounts, impliedIgvRatePct, purchaseTotalsOf } from './purchase-draft-edit';
import {
  blockedSummary,
  classifyReceivedEdit,
  fifoLotConsumption,
  type ItemFacts,
  type LaterMovement,
  type PurchaseFacts,
  type TargetFacts,
} from './purchase-received-edit';

type MovementRow = Prisma.InventoryMovementGetPayload<{
  include: { reversals: { select: { id: true } } };
}>;

type Loaded = Awaited<ReturnType<ReceivedPurchaseEditService['load']>>;

/** Lo que el servicio leyó de una línea, además de los hechos del clasificador. */
interface LoadedItem {
  facts: ItemFacts;
  /** El ingreso vivo de esta compra para la línea (el que se revierte), si hay uno solo. */
  ownIn: MovementRow | null;
  coilId: string | null;
}

/**
 * D-372 (cc14) — editar una compra ya recibida, versión 1. Ver `purchase-received-edit.ts` para
 * las reglas; acá van la lectura de los hechos y la escritura.
 *
 * Deshacer es volver a editar con el valor anterior (decisión 10): la segunda edición ve el
 * ingreso nuevo como el único vivo y hace su propia reversa y su propio reingreso, con su
 * auditoría.
 */
@Injectable()
export class ReceivedPurchaseEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly coils: CoilsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Vista previa: qué camino toma cada cambio y qué queda bloqueado, sin escribir nada. */
  async preview(
    actor: RequestUser,
    id: string,
    input: EditReceivedPurchaseInput,
  ): Promise<ReceivedEditPlanDto> {
    assertAdmin(actor);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const loaded = await this.load(tx, id, touchedItems(input));
        const targets = await this.loadTargets(tx, loaded.purchase, loaded.receiptDate, input);
        const plan = classifyReceivedEdit(loaded.facts, input, targets);
        return (await this.enrichPlan(tx, loaded, input, plan)).plan;
      },
      { timeout: 30_000 },
    );
  }

  /** Confirmar: vuelve a clasificar bajo los locks y escribe solo si nada quedó bloqueado. */
  async commit(
    actor: RequestUser,
    id: string,
    input: CommitReceivedPurchaseEditInput,
  ): Promise<ReceivedEditPlanDto> {
    assertAdmin(actor);
    return this.prisma.$transaction(
      async (tx) => {
        // Lock de la compra: un pago, una anulación o una segunda edición concurrentes esperan.
        await tx.$queryRaw`SELECT "id" FROM "purchases" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const coilIds = (
          await tx.coil.findMany({ where: { purchaseId: id }, select: { id: true } })
        )
          .map((c) => c.id)
          .sort();
        if (coilIds.length > 0) {
          await tx.$queryRaw`SELECT "id" FROM "coils" WHERE "id" = ANY(${coilIds}::uuid[]) ORDER BY "id" FOR UPDATE`;
        }
        // Y los saldos de kardex que la edición puede tocar, **antes** de leer los movimientos
        // posteriores: quien consume o ingresa toma el saldo, no la bobina, así que sin este lock
        // un movimiento confirmado entre la lectura y la reversa no lo vería el clasificador.
        await this.lockBalances(tx, id, coilIds, input);

        // cc15: un mismo envío (doble click, reintento de red) se aplica una sola vez. El que
        // llega segundo ve la edición ya hecha y no repite nada.
        const claim = await claimIdempotencyKey(tx, 'purchase-received-edit', input.idempotencyKey);
        if (!claim.claimed) {
          return { purchaseId: id, changes: [], warnings: [], executable: false, replayed: true };
        }

        const loaded = await this.load(tx, id, touchedItems(input));
        const targets = await this.loadTargets(tx, loaded.purchase, loaded.receiptDate, input);
        const classified = classifyReceivedEdit(loaded.facts, input, targets);
        if (classified.changes.length === 0) return classified;
        if (!classified.executable) throw new BadRequestException(blockedSummary(classified));
        const { plan, adjustments } = await this.enrichPlan(tx, loaded, input, classified);

        const movements = await this.applyItems(tx, actor, loaded, input, adjustments, targets);
        const header = await this.applyHeader(tx, loaded, input, movements.amountsChanged);
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'purchases.update-received',
          entity: 'purchases',
          entityId: id,
          reason: input.reason,
          before: {
            changes: plan.changes.map((c) => ({
              line: c.lineNumber,
              field: c.field,
              value: c.before,
            })),
            total: loaded.purchase.total.toFixed(4),
            // Los importes de las líneas tocadas como estaban (los del papel, D-359): volver a
            // editar con la misma cantidad y el mismo precio los restaura tal cual.
            lines: movements.linesBefore as unknown as Prisma.InputJsonArray,
            // cc15: el vencimiento va en `changes`; el costo de documento de las bobinas, acá.
            dueDate: loaded.facts.header.dueDate,
            coils: movements.coilsBefore as unknown as Prisma.InputJsonArray,
          },
          after: {
            changes: plan.changes.map((c) => ({
              line: c.lineNumber,
              field: c.field,
              value: c.after,
              path: c.path,
            })),
            total: header.total,
            reversedMovementIds: movements.reversed,
            newMovementIds: movements.created,
            // cc15: los ajustes proporcionales, con lo que quedaba y el monto.
            adjustMovementIds: movements.adjusted,
            adjustments: plan.changes.flatMap((c) =>
              c.adjustment
                ? [
                    {
                      line: c.lineNumber,
                      remainingQty: c.adjustment.remainingQty,
                      amountPen: c.adjustment.amountPen,
                      affected: c.adjustment.affected.length,
                    },
                  ]
                : [],
            ),
            reason: input.reason,
          },
        });
        return plan;
      },
      // Hasta 200 líneas con reversa y reingreso: el mismo margen que `cancel`.
      { timeout: 120_000, maxWait: 15_000 },
    );
  }

  /** Bloquea los saldos de los ítems de kardex de la compra y de los productos de destino. */
  private async lockBalances(
    tx: Prisma.TransactionClient,
    id: string,
    coilIds: string[],
    input: EditReceivedPurchaseInput,
  ): Promise<void> {
    const purchase = await tx.purchase.findUnique({
      where: { id },
      select: {
        type: true,
        businessLineId: true,
        items: { select: { id: true, productId: true, unit: true } },
      },
    });
    if (!purchase) return; // `load` responde el 404
    const refs: { itemType: InventoryItemType; itemId: string; unit: string }[] = [];
    if (purchase.type === PurchaseType.COIL) {
      for (const coilId of coilIds) refs.push({ itemType: 'COIL', itemId: coilId, unit: 'KGM' });
    } else if (purchase.type === PurchaseType.FINISHED_GOOD) {
      for (const i of purchase.items) {
        if (i.productId) refs.push({ itemType: 'PRODUCT', itemId: i.productId, unit: i.unit });
      }
      // Los productos de destino, solo los que existen en la línea de la compra con la unidad de
      // la línea: los demás los rechaza el clasificador con su motivo, y bloquear su saldo
      // crearía uno vacío o fallaría con otro mensaje.
      const unitOf = new Map(purchase.items.map((i) => [i.id, i.unit]));
      const targetIds = (input.items ?? []).flatMap((e) => (e.productId ? [e.productId] : []));
      const valid = new Map(
        (
          await tx.product.findMany({
            where: { id: { in: targetIds }, businessLineId: purchase.businessLineId },
            select: { id: true, unit: true },
          })
        ).map((p) => [p.id, p.unit]),
      );
      for (const e of input.items ?? []) {
        const unit = unitOf.get(e.itemId);
        const productUnit = e.productId ? valid.get(e.productId) : undefined;
        if (
          e.productId &&
          unit !== undefined &&
          productUnit !== undefined &&
          productUnit === unit
        ) {
          refs.push({ itemType: 'PRODUCT', itemId: e.productId, unit });
        }
      }
    }
    // Orden fijo para no cruzarse con otra transacción que bloquee los mismos saldos.
    const unique = [...new Map(refs.map((r) => [`${r.itemType}:${r.itemId}`, r])).values()].sort(
      (a, b) => `${a.itemType}:${a.itemId}`.localeCompare(`${b.itemType}:${b.itemId}`),
    );
    for (const ref of unique) {
      await this.inventory.lockAvailability(tx, {
        ...ref,
        businessLineId: purchase.businessLineId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  private async load(
    tx: Prisma.TransactionClient,
    id: string,
    touched: ReadonlyMap<string, ReceivedPurchaseItemEdit> = new Map(),
  ) {
    const purchase = await tx.purchase.findUnique({
      where: { id },
      include: {
        items: { orderBy: { lineNumber: 'asc' }, include: { product: { select: { sku: true } } } },
        supplier: { select: { name: true, docNumber: true } },
      },
    });
    if (!purchase) throw new NotFoundException('Compra no encontrada');
    if (purchase.status !== PurchaseStatus.RECEIVED) {
      throw new BadRequestException(
        purchase.status === PurchaseStatus.DRAFT
          ? 'La compra está en borrador: sus líneas se corrigen con la edición de borradores (D-371)'
          : 'La compra está anulada',
      );
    }
    const livePayments = await tx.supplierPayment.count({
      where: { purchaseId: id, reversedAt: null },
    });
    const finishes = await tx.finish.findMany({
      where: { id: { in: purchase.items.flatMap((i) => (i.finishId ? [i.finishId] : [])) } },
      select: { id: true, code: true },
    });
    const finishCode = new Map(finishes.map((f) => [f.id, f.code]));

    const loadedItems: LoadedItem[] = [];
    let receiptDate: string | null = null;

    if (purchase.type === PurchaseType.COIL) {
      const coils = await tx.coil.findMany({
        where: { purchaseId: id, purchaseItemId: { not: null } },
        select: { id: true, purchaseItemId: true, status: true },
      });
      const coilByItem = new Map(coils.map((c) => [c.purchaseItemId, c]));
      const assignments = await findLiveStripAssignments(
        tx,
        coils.map((c) => c.id),
      );
      const ownReserved = await reservedByItem(
        tx,
        InventoryItemType.COIL,
        coils.map((c) => c.id),
      );
      const coilBalances = new Map(
        (
          await tx.inventoryBalance.findMany({
            where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
            select: { itemId: true, qty: true },
          })
        ).map((b) => [b.itemId, toDecimal(b.qty.toString())]),
      );
      const tolerance = roofingToleranceMm(this.env);
      for (const item of purchase.items) {
        const coil = coilByItem.get(item.id) ?? null;
        const movements = coil
          ? await tx.inventoryMovement.findMany({
              where: { itemType: 'COIL', itemId: coil.id },
              orderBy: { id: 'asc' },
              include: { reversals: { select: { id: true } } },
            })
          : [];
        const live = liveMovements(movements);
        const first = live[0] ?? null;
        const ownIn = first?.type === 'IN' ? first : null;
        if (ownIn && receiptDate === null) receiptDate = dateOf(ownIn.operationDate);
        const edit = touched.get(item.id);
        const intact = coil !== null && ownIn !== null && live.length === 1;
        // D-134 sobre el estado **final** (cc15b, punto 3): el reemplazo deja la bobina con la
        // cantidad nueva, así que solo una baja de kilos puede dejar corto un agregado con
        // promesas. Un cambio de precio no mueve kilos y no se simula.
        const newQty = edit?.qty === undefined ? null : toDecimal(edit.qty);
        const backsPromised =
          coil && intact && newQty?.lt(item.qty.toString())
            ? (
                await findRawMaterialShortfalls(tx, [coil.id], tolerance, {
                  coilQtyOverrides: new Map([[coil.id, newQty]]),
                  firstOnly: true,
                })
              )[0]
            : undefined;
        // Punto 5: un cambio de color o de espesor saca la bobina de su agregado.
        const specPromised =
          coil && intact && edit
            ? await this.specPromised(tx, coil.id, item, edit, tolerance)
            : null;
        loadedItems.push({
          coilId: coil?.id ?? null,
          ownIn,
          facts: {
            ...baseItemFacts(item, finishCode),
            laterMovements: live.filter((m) => m.id !== ownIn?.id).map(laterOf(purchase.id)),
            hasLiveIn: ownIn !== null,
            balanceQty: toFixedString(coil ? (coilBalances.get(coil.id) ?? '0') : '0', 'KG'),
            reservedQty: toFixedString(
              coil ? (ownReserved.get(coil.id) ?? toDecimal('0')) : '0',
              'KG',
            ),
            specPromised,
            backsPromised: backsPromised
              ? backsPromised.orders.map((o) => `${o.code} (${o.qtyKg} kg)`).join(', ')
              : null,
            coilStatus: coil?.status ?? null,
            mountedOrder: assignments.find((a) => a.coilId === coil?.id)?.orderCode ?? null,
            ownReservation: coil ? (ownReserved.get(coil.id) ?? toDecimal('0')).gt(0) : false,
            // El landed cost es un ajuste de **otra** compra (el flete o la aduana). Los ajustes
            // de esta misma compra son sus correcciones de costo con consumo (cc15).
            landedCost: live.some((m) => m.type === 'ADJUST' && m.refId !== purchase.id),
            sharedProduct: false,
          },
        });
      }
    } else if (purchase.type === PurchaseType.FINISHED_GOOD) {
      const ownMovements = await tx.inventoryMovement.findMany({
        where: { refType: 'PURCHASE', refId: id, itemType: 'PRODUCT', type: 'IN' },
        orderBy: { id: 'asc' },
        include: { reversals: { select: { id: true } } },
      });
      const ownLive = liveMovements(ownMovements);
      const productCount = new Map<string, number>();
      for (const item of purchase.items) {
        if (item.productId) {
          productCount.set(item.productId, (productCount.get(item.productId) ?? 0) + 1);
        }
      }
      for (const item of purchase.items) {
        const shared = item.productId !== null && (productCount.get(item.productId) ?? 0) > 1;
        const ownIn = shared ? null : (ownLive.find((m) => m.itemId === item.productId) ?? null);
        if (ownIn && receiptDate === null) receiptDate = dateOf(ownIn.operationDate);
        let later: MovementRow[] = [];
        if (ownIn) {
          const candidates = await tx.inventoryMovement.findMany({
            where: {
              itemType: 'PRODUCT',
              itemId: ownIn.itemId,
              OR: [{ id: { gt: ownIn.id } }, { operationDate: { gt: ownIn.operationDate } }],
            },
            orderBy: { id: 'asc' },
            include: { reversals: { select: { id: true } } },
          });
          later = liveMovements(candidates).filter((m) => m.id !== ownIn.id);
        }
        // La reversa saca el ingreso entero del saldo del producto, que comparte con otras
        // compras: se bloquea si lo reservado no cabe en lo que queda sin este ingreso (D-066).
        let reservationShort = false;
        let balanceQty = toDecimal('0');
        let reserved = toDecimal('0');
        if (ownIn) {
          const balance = await tx.inventoryBalance.findUnique({
            where: { itemType_itemId: { itemType: 'PRODUCT', itemId: ownIn.itemId } },
            select: { qty: true },
          });
          reserved =
            (await reservedByItem(tx, InventoryItemType.PRODUCT, [ownIn.itemId])).get(
              ownIn.itemId,
            ) ?? toDecimal('0');
          balanceQty = toDecimal((balance?.qty ?? 0).toString());
          const remaining = balanceQty.minus(ownIn.qty.toString());
          reservationShort = reserved.gt(0) && reserved.gt(remaining);
        }
        loadedItems.push({
          coilId: null,
          ownIn,
          facts: {
            ...baseItemFacts(item, finishCode),
            laterMovements: later.map(laterOf(purchase.id)),
            hasLiveIn: ownIn !== null,
            balanceQty: toFixedString(balanceQty, 'KG'),
            reservedQty: toFixedString(reserved, 'KG'),
            specPromised: null,
            backsPromised: null,
            coilStatus: null,
            mountedOrder: null,
            ownReservation: reservationShort,
            landedCost: false,
            sharedProduct: shared,
          },
        });
      }
    } else {
      for (const item of purchase.items) {
        loadedItems.push({
          coilId: null,
          ownIn: null,
          facts: {
            ...baseItemFacts(item, finishCode),
            laterMovements: [],
            hasLiveIn: false,
            balanceQty: '0.000',
            reservedQty: '0.000',
            specPromised: null,
            backsPromised: null,
            coilStatus: null,
            mountedOrder: null,
            ownReservation: false,
            landedCost: false,
            sharedProduct: false,
          },
        });
      }
    }

    const facts: PurchaseFacts = {
      purchaseId: purchase.id,
      type: purchase.type,
      livePayments,
      igvRateIssue: igvRateIssueOf(purchase.subtotal.toString(), purchase.igv.toString()),
      header: {
        supplierId: purchase.supplierId,
        supplierLabel: `${purchase.supplier.name} (${purchase.supplier.docNumber})`,
        docType: purchase.docType,
        series: purchase.series,
        number: purchase.number,
        issueDate: dateOf(purchase.issueDate),
        paymentTerms: purchase.paymentTerms,
        creditDays: purchase.creditDays,
        dueDate: purchase.dueDate === null ? null : dateOf(purchase.dueDate),
        notes: purchase.notes,
      },
      items: loadedItems.map((l) => l.facts),
    };
    return { purchase, facts, items: loadedItems, receiptDate, livePayments };
  }

  /**
   * cc15b, punto 5: si la bobina cambia de color o de espesor, deja su agregado de materia prima.
   * Se simula el agregado sin ella y se quedan los que siguen cortos y que la especificación nueva
   * **no** cubre (un espesor que sigue dentro de la tolerancia no saca a la bobina de nada).
   * Devuelve los pedidos que quedarían sin cubrir, o `null`.
   */
  private async specPromised(
    tx: Prisma.TransactionClient,
    coilId: string,
    item: { finishId: string | null; thicknessMm: Prisma.Decimal | null },
    edit: ReceivedPurchaseItemEdit,
    tolerance: string,
  ): Promise<string | null> {
    const finishChange = edit.finishId !== undefined && edit.finishId !== item.finishId;
    const thicknessChange =
      edit.thicknessMm !== undefined &&
      !toDecimal(edit.thicknessMm).equals((item.thicknessMm ?? 0).toString());
    if (!finishChange && !thicknessChange) return null;
    const coil = await tx.coil.findUniqueOrThrow({
      where: { id: coilId },
      select: { businessLineId: true, colorId: true, thicknessMm: true },
    });
    const newColorId =
      finishChange && edit.finishId !== undefined
        ? ((
            await tx.finish.findUnique({
              where: { id: edit.finishId },
              select: { colorId: true },
            })
          )?.colorId ?? null)
        : coil.colorId;
    const newThickness = toDecimal(edit.thicknessMm ?? coil.thicknessMm.toString());
    if (newColorId === coil.colorId && newThickness.equals(coil.thicknessMm.toString())) {
      return null;
    }
    const shortfalls = await findRawMaterialShortfalls(tx, [coilId], tolerance, {
      withoutCoilIds: [coilId],
    });
    if (shortfalls.length === 0) return null;
    const specs = await tx.rawMaterialSpec.findMany({
      where: { id: { in: shortfalls.map((s) => s.specId) } },
      select: { id: true, businessLineId: true, colorId: true, thicknessMm: true },
    });
    const stillCovered = new Set(
      specs
        .filter(
          (s) =>
            s.businessLineId === coil.businessLineId &&
            s.colorId === newColorId &&
            toDecimal(s.thicknessMm.toString()).minus(newThickness).abs().lte(toDecimal(tolerance)),
        )
        .map((s) => s.id),
    );
    const left = shortfalls.filter((s) => !stillCovered.has(s.specId));
    if (left.length === 0) return null;
    return left.flatMap((s) => s.orders.map((o) => `${o.code} (${o.qtyKg} kg)`)).join(', ');
  }

  /** Etiquetas y validez de lo que la edición pide como destino (proveedor, producto, acabado). */
  private async loadTargets(
    tx: Prisma.TransactionClient,
    purchase: { businessLineId: string },
    receiptDate: string | null,
    input: EditReceivedPurchaseInput,
  ): Promise<TargetFacts> {
    const labels = new Map<string, string>();
    const invalidProducts = new Map<string, string>();
    const invalidFinishes = new Map<string, string>();
    const productsWithLaterMovements = new Set<string>();
    const productNames = new Map<string, string>();

    const supplierId = input.header?.supplierId;
    if (supplierId) {
      const supplier = await tx.supplier.findUnique({
        where: { id: supplierId },
        select: { name: true, docNumber: true, isActive: true },
      });
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      if (!supplier.isActive) throw new BadRequestException('El proveedor está desactivado');
      labels.set(supplierId, `${supplier.name} (${supplier.docNumber})`);
    }

    const itemsById = new Map<string, { unit: string }>();
    for (const i of await tx.purchaseItem.findMany({
      where: { id: { in: (input.items ?? []).map((e) => e.itemId) } },
      select: { id: true, unit: true },
    })) {
      itemsById.set(i.id, { unit: i.unit });
    }
    for (const edit of input.items ?? []) {
      if (edit.productId) {
        const product = await tx.product.findUnique({
          where: { id: edit.productId },
          select: { sku: true, name: true, isActive: true, businessLineId: true, unit: true },
        });
        if (!product) {
          invalidProducts.set(edit.productId, 'El producto no existe');
          continue;
        }
        labels.set(edit.productId, product.sku);
        productNames.set(edit.productId, product.name);
        const lineUnit = itemsById.get(edit.itemId)?.unit;
        if (!product.isActive) invalidProducts.set(edit.productId, 'El producto está desactivado');
        else if (product.businessLineId !== purchase.businessLineId) {
          invalidProducts.set(edit.productId, 'El producto es de otra línea de negocio');
        } else if (lineUnit !== undefined && product.unit !== lineUnit) {
          invalidProducts.set(
            edit.productId,
            `El producto se lleva en ${product.unit} y la línea en ${lineUnit}`,
          );
        }
        if (receiptDate !== null) {
          const later = await tx.inventoryMovement.count({
            where: {
              itemType: 'PRODUCT',
              itemId: edit.productId,
              operationDate: { gt: toDateOnly(receiptDate) },
            },
          });
          if (later > 0) productsWithLaterMovements.add(edit.productId);
        }
      }
      if (edit.finishId) {
        const finish = await tx.finish.findUnique({
          where: { id: edit.finishId },
          select: {
            code: true,
            kind: true,
            isActive: true,
            businessLineId: true,
            color: { select: { name: true, isActive: true } },
          },
        });
        if (!finish) {
          invalidFinishes.set(edit.finishId, 'El acabado no existe');
          continue;
        }
        labels.set(edit.finishId, finish.code);
        if (!finish.isActive) invalidFinishes.set(edit.finishId, 'El acabado está desactivado');
        else if (finish.color && !finish.color.isActive) {
          invalidFinishes.set(
            edit.finishId,
            `El color «${finish.color.name}» del acabado está desactivado`,
          );
        } else if (finish.kind === null) {
          invalidFinishes.set(edit.finishId, `El acabado ${finish.code} no tiene tipo ni línea`);
        } else if (finish.businessLineId !== purchase.businessLineId) {
          invalidFinishes.set(
            edit.finishId,
            `El acabado ${finish.code} es de otra línea que la compra`,
          );
        }
      }
    }
    return { labels, invalidProducts, invalidFinishes, productsWithLaterMovements, productNames };
  }

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  private async applyItems(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    loaded: Loaded,
    input: CommitReceivedPurchaseEditInput,
    adjustments: Map<string, LineAdjustment>,
    targets: TargetFacts,
  ): Promise<{
    reversed: string[];
    created: string[];
    adjusted: string[];
    amountsChanged: boolean;
    linesBefore: PaperLine[];
    coilsBefore: CoilCostBefore[];
  }> {
    const reversed: string[] = [];
    const created: string[] = [];
    const adjusted: string[] = [];
    const linesBefore: PaperLine[] = [];
    const coilsBefore: CoilCostBefore[] = [];
    let amountsChanged = false;
    const { purchase } = loaded;
    const exchangeRate = toDecimal(purchase.exchangeRate.toString());
    // Los importes del papel que tuvo cada línea antes de ediciones anteriores (D-359).
    const paperHistory = await this.paperHistory(tx, purchase.id);
    const touchedRawCoils: {
      coilId: string;
      before: { colorId: string | null; thicknessMm: string };
    }[] = [];

    for (const edit of input.items ?? []) {
      const loadedItem = loaded.items.find((l) => l.facts.itemId === edit.itemId);
      const item = purchase.items.find((i) => i.id === edit.itemId);
      if (!loadedItem || !item) continue;

      const qty = toDecimal(edit.qty ?? item.qty.toString());
      const unitPrice = toDecimal(edit.unitPrice ?? item.unitPrice.toString());
      const amountsChange =
        !qty.equals(item.qty.toString()) || !unitPrice.equals(item.unitPrice.toString());
      const productChange = edit.productId !== undefined && edit.productId !== item.productId;
      const finishChange = edit.finishId !== undefined && edit.finishId !== item.finishId;
      const widthChange =
        edit.widthMm !== undefined &&
        !toDecimal(edit.widthMm).equals((item.widthMm ?? 0).toString());
      const thicknessChange =
        edit.thicknessMm !== undefined &&
        !toDecimal(edit.thicknessMm).equals((item.thicknessMm ?? 0).toString());
      if (!amountsChange && !productChange && !finishChange && !widthChange && !thicknessChange) {
        continue;
      }

      const amounts = this.lineAmountsFor(purchase, item, qty, unitPrice, paperHistory);
      const lineSubtotal = toDecimal(amounts.subtotal);
      // Decisión 3 (cc15): con consumo, el precio se corrige con un ajuste sobre lo que queda,
      // sin reversa ni reingreso. El plan ya lo calculó con la misma cuenta que se muestra.
      const adjustment = adjustments.get(item.id);
      if (amountsChange) {
        amountsChanged = true;
        linesBefore.push({
          itemId: item.id,
          qty: item.qty.toFixed(3),
          unitPrice: item.unitPrice.toFixed(4),
          subtotal: item.subtotal.toFixed(4),
          igv: item.igv.toFixed(4),
          total: item.total.toFixed(4),
        });
      }

      if (adjustment && loadedItem.ownIn) {
        const ownIn = loadedItem.ownIn;
        if (!adjustment.amountPen.isZero() && adjustment.remainingQty.gt(0)) {
          const movement = await this.inventory.adjustCost(tx, {
            businessLineId: purchase.businessLineId,
            itemType: ownIn.itemType,
            itemId: ownIn.itemId,
            unit: ownIn.unit,
            amountPen: toFixedString(adjustment.amountPen, 'MONEY'),
            refType: 'PURCHASE',
            refId: purchase.id,
            notes:
              `Corrección de costo de la compra recibida, sobre ${toFixedString(adjustment.remainingQty, 'KG')} que quedan: ${input.reason}`.slice(
                0,
                240,
              ),
            actorId: actor.id,
          });
          if (movement) adjusted.push(movement.id.toString());
        }
      } else if ((amountsChange || productChange) && !loadedItem.ownIn) {
        // El clasificador ya lo bloquea (`hasLiveIn`); esto es la red por si dejara de hacerlo:
        // corregir la compra sin su kardex los separaría sin aviso.
        throw new BadRequestException(
          `La línea ${String(item.lineNumber)} no tiene un ingreso de kardex vivo que corregir`,
        );
      } else if ((amountsChange || productChange) && loadedItem.ownIn) {
        const ownIn = loadedItem.ownIn;
        const date = dateOf(ownIn.operationDate);
        // D-045 generalizado: reversa del ingreso y nuevo ingreso **en la misma fecha**, con el
        // acuse de retrofechado (es el mismo hecho, corregido; el ítem no tiene movimientos
        // posteriores, lo garantiza el clasificador).
        // El ítem que recibe el ingreso nuevo: la misma bobina, o el producto (el nuevo si cambió).
        const targetItemId =
          purchase.type === PurchaseType.COIL
            ? loadedItem.coilId
            : (edit.productId ?? item.productId);
        if (targetItemId === null) {
          throw new BadRequestException(
            `La línea ${String(item.lineNumber)} no tiene ítem de kardex que corregir`,
          );
        }
        const kardexCost =
          purchase.type === PurchaseType.COIL
            ? (() => {
                const totalPen = cents(lineSubtotal.times(exchangeRate));
                return {
                  unitCost: toFixedString(totalPen.div(qty), 'MONEY'),
                  totalCost: toFixedString(totalPen, 'MONEY'),
                };
              })()
            : receptionCost(lineSubtotal, qty, exchangeRate);
        const note = `Corrección de la compra recibida: ${input.reason}`.slice(0, 240);
        if (!productChange) {
          // cc15b: el mismo ítem, por la puerta `replaceEntry` (regla dura 8): reversa y
          // reingreso en la misma fecha, con las reservas y la materia prima comprobadas sobre
          // el estado final. La precondición (sin salidas ni ajustes posteriores) la vuelve a
          // comprobar la primitiva bajo el lock del saldo.
          const replaced = await promisedMaterialMessage(() =>
            this.inventory.replaceEntry(tx, {
              movementId: ownIn.id,
              qty: toFixedString(qty, 'KG'),
              unitCost: kardexCost.unitCost,
              totalCost: kardexCost.totalCost,
              actorId: actor.id,
              reason: note,
            }),
          );
          reversed.push(ownIn.id.toString());
          created.push(replaced.entry.id.toString());
        } else {
          // Cambio de producto: el ingreso pasa a otro ítem, así que sigue siendo reversa del
          // viejo e ingreso del nuevo, con los bloqueos de siempre (sin movimientos posteriores,
          // sin reservas que la reversa deje sin cubrir).
          await promisedMaterialMessage(() =>
            this.inventory.reverse(
              tx,
              ownIn.id,
              actor.id,
              `Corrección de la compra recibida: ${input.reason}`.slice(0, 240),
              date,
              true,
            ),
          );
          reversed.push(ownIn.id.toString());
          const kardexTotalPen = cents(lineSubtotal.times(exchangeRate));
          const movement =
            purchase.type === PurchaseType.COIL
              ? await this.inventory.record(tx, {
                  businessLineId: purchase.businessLineId,
                  itemType: 'COIL',
                  itemId: targetItemId,
                  type: 'IN',
                  qty: toFixedString(qty, 'KG'),
                  unit: ownIn.unit,
                  unitCost: toFixedString(kardexTotalPen.div(qty), 'MONEY'),
                  totalCost: toFixedString(kardexTotalPen, 'MONEY'),
                  refType: 'PURCHASE',
                  refId: purchase.id,
                  notes: `Corrección de la compra recibida: ${input.reason}`.slice(0, 240),
                  actorId: actor.id,
                  operationDate: date,
                  confirmBackdate: true,
                })
              : await this.inventory.record(tx, {
                  businessLineId: purchase.businessLineId,
                  itemType: 'PRODUCT',
                  itemId: targetItemId,
                  type: 'IN',
                  qty: toFixedString(qty, 'KG'),
                  unit: item.unit,
                  ...receptionCost(lineSubtotal, qty, exchangeRate),
                  refType: 'PURCHASE',
                  refId: purchase.id,
                  notes: `Corrección de la compra recibida: ${input.reason}`.slice(0, 240),
                  actorId: actor.id,
                  operationDate: date,
                  confirmBackdate: true,
                });
          if (movement) created.push(movement.id.toString());
        }
      }

      const itemData: Prisma.PurchaseItemUpdateInput = {};
      if (amountsChange) {
        itemData.qty = toFixedString(qty, 'KG');
        itemData.unitPrice = toFixedString(unitPrice, 'MONEY');
        itemData.subtotal = toFixedString(amounts.subtotal, 'MONEY');
        itemData.igv = toFixedString(amounts.igv, 'MONEY');
        itemData.total = toFixedString(amounts.total, 'MONEY');
      }
      if (productChange && edit.productId !== undefined) {
        itemData.product = { connect: { id: edit.productId } };
        // Decisión D (cc15): la descripción pasa a ser el nombre del producto nuevo; la anterior
        // queda en la auditoría (`changes`).
        const name = targets.productNames.get(edit.productId);
        if (name !== undefined) itemData.description = name;
      }

      if (purchase.type === PurchaseType.COIL && loadedItem.coilId) {
        const coil = await tx.coil.findUniqueOrThrow({
          where: { id: loadedItem.coilId },
          select: {
            id: true,
            code: true,
            finishId: true,
            colorId: true,
            thicknessMm: true,
            widthMm: true,
            weightKg: true,
            unitCostPerKg: true,
            totalCost: true,
            totalCostPen: true,
          },
        });
        const coilData: Prisma.CoilUpdateInput = {};
        if (amountsChange) {
          // cc15: el costo de documento anterior de la bobina, para la auditoría.
          coilsBefore.push({
            coilId: coil.id,
            code: coil.code,
            weightKg: coil.weightKg.toFixed(3),
            unitCostPerKg: coil.unitCostPerKg.toFixed(4),
            totalCost: coil.totalCost.toFixed(4),
            totalCostPen: coil.totalCostPen.toFixed(4),
          });
          // El costo de documento de la bobina, con la misma cuenta de `CoilsService.create`. El
          // código **no** se regenera aunque cambie el peso: es la etiqueta física (decisión 5).
          coilData.weightKg = toFixedString(qty, 'KG');
          coilData.unitCostPerKg = toFixedString(unitPrice, 'MONEY');
          coilData.totalCost = toFixedString(lineSubtotal, 'MONEY');
          coilData.totalCostPen = toFixedString(cents(lineSubtotal.times(exchangeRate)), 'MONEY');
        }
        const finishId = edit.finishId ?? coil.finishId;
        const thickness = toFixedString(edit.thicknessMm ?? coil.thicknessMm.toString(), 'MM');
        if (finishChange || thicknessChange) {
          const finish = await tx.finish.findUniqueOrThrow({
            where: { id: finishId },
            select: { code: true, colorId: true },
          });
          coilData.typeKey = coilTypeKey(finish.code, thickness);
          await this.coils.ensureTradingProduct(tx, finishId, thickness);
          touchedRawCoils.push({
            coilId: coil.id,
            before: { colorId: coil.colorId, thicknessMm: coil.thicknessMm.toFixed(2) },
          });
          if (finishChange) {
            coilData.finish = { connect: { id: finishId } };
            coilData.color = finish.colorId
              ? { connect: { id: finish.colorId } }
              : { disconnect: true };
            itemData.finish = { connect: { id: finishId } };
            itemData.color = finish.colorId
              ? { connect: { id: finish.colorId } }
              : { disconnect: true };
          }
          if (thicknessChange) {
            coilData.thicknessMm = thickness;
            itemData.thicknessMm = thickness;
          }
        }
        if (widthChange && edit.widthMm !== undefined) {
          coilData.widthMm = toFixedString(edit.widthMm, 'MM');
          itemData.widthMm = toFixedString(edit.widthMm, 'MM');
        }
        if (Object.keys(coilData).length > 0) {
          await tx.coil.update({ where: { id: coil.id }, data: coilData });
        }
      }
      if (Object.keys(itemData).length > 0) {
        await tx.purchaseItem.update({ where: { id: item.id }, data: itemData });
      }
    }

    // D-134: una bobina que cambia de color o de espesor puede mudarse de agregado de materia
    // prima, y el que abandona puede quedar por debajo de lo prometido. Igual que el cambio de
    // acabado de una bobina suelta (`coils.update`).
    for (const t of touchedRawCoils) {
      await promisedMaterialMessage(() =>
        assertRawMaterialInvariant(tx, [t.coilId], roofingToleranceMm(this.env), {
          alsoAffecting: [
            {
              businessLineId: purchase.businessLineId,
              colorId: t.before.colorId,
              thicknessMm: t.before.thicknessMm,
            },
          ],
        }),
      );
    }
    return { reversed, created, adjusted, amountsChanged, linesBefore, coilsBefore };
  }

  /**
   * Los importes de una línea con su cantidad y su precio nuevos. Sin cambio, los del papel
   * (D-359). Con cambio, si vuelven a una versión anterior de la línea, sus importes de entonces
   * (deshacer exacto, decisión 10); si no, la cuenta del alta y de D-371.
   */
  private lineAmountsFor(
    purchase: Loaded['purchase'],
    item: Loaded['purchase']['items'][number],
    qty: Decimal,
    unitPrice: Decimal,
    paperHistory: PaperLine[],
  ): { subtotal: string; igv: string; total: string } {
    const amountsChange =
      !qty.equals(item.qty.toString()) || !unitPrice.equals(item.unitPrice.toString());
    if (!amountsChange) {
      return {
        subtotal: item.subtotal.toString(),
        igv: item.igv.toString(),
        total: item.total.toString(),
      };
    }
    const restored = paperHistory.find(
      (p) => p.itemId === item.id && qty.equals(p.qty) && unitPrice.equals(p.unitPrice),
    );
    if (restored) return restored;
    const edited = editedLineAmounts(
      qty.toString(),
      unitPrice.toString(),
      impliedIgvRatePct(purchase.subtotal.toString(), purchase.igv.toString()),
    );
    return {
      subtotal: edited.subtotal.toString(),
      igv: edited.igv.toString(),
      total: edited.total.toString(),
    };
  }

  /**
   * Decisión 3 (cc15): el ajuste proporcional de una línea con consumo. El monto es la diferencia
   * del costo de la línea en soles por la parte de la compra que **todavía está** en existencias
   * (decisión A: en orden de llegada); lo que ya salió conserva su costo y se lista.
   */
  private async adjustmentFor(
    tx: Prisma.TransactionClient,
    purchase: Loaded['purchase'],
    loadedItem: LoadedItem,
    item: Loaded['purchase']['items'][number],
    newSubtotal: string,
  ): Promise<LineAdjustment> {
    const ownIn = loadedItem.ownIn;
    if (!ownIn) throw new BadRequestException('La línea no tiene un ingreso de kardex vivo');
    const exchangeRate = toDecimal(purchase.exchangeRate.toString());
    const diffPen = cents(toDecimal(newSubtotal).times(exchangeRate)).minus(
      cents(toDecimal(item.subtotal.toString()).times(exchangeRate)),
    );
    const movements = liveMovements(
      await tx.inventoryMovement.findMany({
        where: { itemType: ownIn.itemType, itemId: ownIn.itemId },
        orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
        include: { reversals: { select: { id: true } } },
      }),
    );
    const { remaining, consumers } = fifoLotConsumption(movements, ownIn.id);
    const balance = await tx.inventoryBalance.findUnique({
      where: { itemType_itemId: { itemType: ownIn.itemType, itemId: ownIn.itemId } },
      select: { qty: true, avgCost: true },
    });
    const lotQty = toDecimal(ownIn.qty.toString());
    const balanceQty = toDecimal((balance?.qty ?? 0).toString());
    const remainingQty = Decimal.max(Decimal.min(remaining, balanceQty, lotQty), new Decimal(0));
    let amountPen = lotQty.isZero()
      ? new Decimal(0)
      : money(diffPen.times(remainingQty).div(lotQty));
    if (ownIn.itemType === InventoryItemType.COIL && remainingQty.gt(0) && !lotQty.isZero()) {
      // En una bobina todo lo que queda es de esta compra, así que el ajuste lleva lo que queda
      // **al costo nuevo del papel**, sea cual sea su valor de hoy. La diferencia unitaria daría
      // lo mismo en el caso normal, pero no si una salida anulada devolvió material al costo
      // viejo: entonces quedaría corto (autorrevisión de cc15a, P1-1).
      const target = cents(toDecimal(newSubtotal).times(exchangeRate))
        .times(remainingQty)
        .div(lotQty);
      // El valor de hoy **de lo que queda de esta compra**, no del saldo entero: en una bobina
      // coinciden, pero así no depende de esa invariante (segunda revisión de cc15a, P2-2).
      const current = remainingQty.times(toDecimal((balance?.avgCost ?? 0).toString()));
      amountPen = money(target.minus(current));
    }
    return {
      remainingQty,
      amountPen,
      consumers,
      // El valor en stock del ítem hoy: `adjustCost` rechaza bajarlo de cero (revisión cc15a).
      stockValuePen: toDecimal((balance?.qty ?? 0).toString()).times(
        toDecimal((balance?.avgCost ?? 0).toString()),
      ),
    };
  }

  /** «Despacho DES-000012», «OP-000003», «Merma»…: qué documento se llevó cada salida. */
  private async documentLabels(
    tx: Prisma.TransactionClient,
    movements: MovementRow[],
  ): Promise<Map<bigint, string>> {
    const idsOf = (refType: string): string[] => [
      ...new Set(
        movements.flatMap((m) => (m.refType === refType && m.refId !== null ? [m.refId] : [])),
      ),
    ];
    const saleIds = idsOf('SALE');
    const productionIds = idsOf('PRODUCTION');
    const [dispatches, reports, orders] = await Promise.all([
      saleIds.length
        ? tx.dispatch.findMany({ where: { id: { in: saleIds } }, select: { id: true, seq: true } })
        : Promise.resolve([]),
      productionIds.length
        ? tx.productionReport.findMany({
            where: { id: { in: productionIds } },
            select: { id: true, productionOrder: { select: { seq: true } } },
          })
        : Promise.resolve([]),
      productionIds.length
        ? tx.productionOrder.findMany({
            where: { id: { in: productionIds } },
            select: { id: true, seq: true },
          })
        : Promise.resolve([]),
    ]);
    const dispatchSeq = new Map(dispatches.map((d) => [d.id, d.seq]));
    const orderSeq = new Map([
      ...orders.map((o) => [o.id, o.seq] as const),
      ...reports.map((r) => [r.id, r.productionOrder.seq] as const),
    ]);
    const labels = new Map<bigint, string>();
    for (const m of movements) {
      const base = REF_DOCUMENT[m.refType] ?? m.refType;
      const ref = m.refId ?? '';
      const seqSale = dispatchSeq.get(ref);
      const seqOrder = orderSeq.get(ref);
      labels.set(
        m.id,
        m.refType === 'SALE' && seqSale !== undefined
          ? `${base} ${dispatchCode(seqSale)}`
          : m.refType === 'PRODUCTION' && seqOrder !== undefined
            ? `${base} ${productionOrderCode(seqOrder)}`
            : base,
      );
    }
    return labels;
  }

  /**
   * Completa el plan con lo que el clasificador puro no puede saber: el monto de cada ajuste
   * proporcional, las salidas que ya se llevaron material al costo anterior y los avisos.
   * Lo usan la vista previa y el guardado, así lo que se muestra es lo que se hace.
   */
  private async enrichPlan(
    tx: Prisma.TransactionClient,
    loaded: Loaded,
    input: EditReceivedPurchaseInput,
    plan: ReceivedEditPlanDto,
  ): Promise<{ plan: ReceivedEditPlanDto; adjustments: Map<string, LineAdjustment> }> {
    const adjustments = new Map<string, LineAdjustment>();
    const warnings: string[] = [];
    const { purchase } = loaded;
    const paperHistory = await this.paperHistory(tx, purchase.id);
    const changes = [];
    for (const change of plan.changes) {
      if (change.path !== 'COST_ADJUST') {
        changes.push(change);
        continue;
      }
      const loadedItem = loaded.items.find((l) => l.facts.lineNumber === change.lineNumber);
      const item = purchase.items.find((i) => i.lineNumber === change.lineNumber);
      const edit = (input.items ?? []).find((e) => e.itemId === item?.id);
      if (!loadedItem || !item || !edit) {
        changes.push(change);
        continue;
      }
      const amounts = this.lineAmountsFor(
        purchase,
        item,
        toDecimal(item.qty.toString()),
        toDecimal(edit.unitPrice ?? item.unitPrice.toString()),
        paperHistory,
      );
      const adjustment = await this.adjustmentFor(tx, purchase, loadedItem, item, amounts.subtotal);
      adjustments.set(item.id, adjustment);
      const labels = await this.documentLabels(
        tx,
        adjustment.consumers.map((c) => c.movement),
      );
      // `adjustCost` rechaza dejar el valor del ítem en negativo: una baja mayor que lo que vale
      // el stock se bloquea acá, así la vista previa dice lo mismo que el guardado.
      const exceedsStock =
        adjustment.amountPen.isNegative() &&
        adjustment.amountPen.negated().gt(adjustment.stockValuePen);
      changes.push({
        ...change,
        ...(exceedsStock
          ? {
              path: 'BLOCKED' as const,
              blockedReason: `La baja de costo (S/ ${toFixedString(adjustment.amountPen.negated(), 'MONEY')}) supera lo que vale hoy el stock del ítem (S/ ${toFixedString(adjustment.stockValuePen, 'MONEY')}): el kardex quedaría con valor negativo`,
            }
          : {}),
        adjustment: {
          remainingQty: toFixedString(adjustment.remainingQty, 'KG'),
          amountPen: toFixedString(adjustment.amountPen, 'MONEY'),
          affected: adjustment.consumers.map((c) => ({
            operationDate: dateOf(c.movement.operationDate),
            document: labels.get(c.movement.id) ?? c.movement.refType,
            qty: toFixedString(c.qty, 'KG'),
            unitCost: toFixedString(c.movement.unitCost.toString(), 'MONEY'),
          })),
        },
      });
    }
    if (adjustments.size > 0) {
      const writes = [...adjustments.values()].some(
        (a) => !a.amountPen.isZero() && a.remainingQty.gt(0),
      );
      warnings.push(
        writes
          ? 'Lo que ya salió conserva el costo con que salió: los márgenes de esos despachos, OP y mermas no se recalculan. El ajuste se registra con la fecha de hoy y solo carga la diferencia sobre lo que queda de esta compra.'
          : 'No queda nada de esta compra en existencias: no se registra ajuste en el kardex; solo cambian la compra y la ficha. Lo que ya salió conserva su costo y sus márgenes no se recalculan.',
        'Deshacer (volver a editar con el precio anterior) ajusta otra vez sobre lo que quede en ese momento: si entre las dos ediciones salió más material, ese material conserva el costo corregido y el resultado no es idéntico al de antes.',
        'El kardex sigue siendo de costo promedio: las próximas salidas toman el promedio nuevo de todo lo que hay en existencias.',
      );
    }
    // cc15b: en producto terminado, el saldo puede mezclar esta compra con otras. El reemplazo
    // recalcula el promedio de todo, y volver al valor anterior lo recalcula otra vez: con otras
    // existencias, el redondeo del promedio a 4 decimales puede no dejarlo idéntico.
    const mixedProduct = changes.some((c) => {
      if (c.path !== 'REVERSE_REENTRY' || purchase.type !== PurchaseType.FINISHED_GOOD) {
        return false;
      }
      const facts = loaded.items.find((l) => l.facts.lineNumber === c.lineNumber)?.facts;
      return facts !== undefined && toDecimal(facts.balanceQty).gt(toDecimal(facts.qty));
    });
    if (mixedProduct) {
      warnings.push(
        'El producto tiene existencias de otras compras: deshacer esta corrección (volver a editar con el valor anterior) puede dejar el costo promedio a ±0,0001 del de hoy, por el redondeo del promedio.',
      );
    }
    const coilCost = changes.some(
      (c) => purchase.type === PurchaseType.COIL && c.field === 'unitPrice' && c.path !== 'BLOCKED',
    );
    if (coilCost) {
      warnings.push(
        'El costo por kg de la bobina cambia en su ficha y, con él, en los reportes mensuales de bobinas ya pasados, que leen la ficha (decisión C).',
      );
      // Los flejes de un corte y las bobinas de un partido nacieron con el costo de entonces y
      // son ítems propios del kardex: la corrección de la madre no los alcanza.
      const coilIds = changes.flatMap((c) => {
        if (c.field !== 'unitPrice' || c.path === 'BLOCKED') return [];
        const coilId = loaded.items.find((l) => l.facts.lineNumber === c.lineNumber)?.coilId;
        return coilId ? [coilId] : [];
      });
      if (coilIds.length > 0) {
        const children = await tx.coil.findMany({
          where: {
            status: { not: 'CANCELLED' },
            OR: [
              { parentCoilId: { in: coilIds } },
              { split: { parentCoilId: { in: coilIds }, revertedAt: null } },
            ],
          },
          select: { code: true },
          orderBy: { code: 'asc' },
        });
        if (children.length > 0) {
          const shown = children
            .slice(0, 8)
            .map((c) => c.code)
            .join(', ');
          const more = children.length > 8 ? ` y ${String(children.length - 8)} más` : '';
          warnings.push(
            `Los flejes o bobinas que salieron de esta bobina (${shown}${more}) conservan el costo con que nacieron: la corrección no los alcanza.`,
          );
        }
      }
    }
    return {
      plan: {
        ...plan,
        changes,
        warnings,
        executable: changes.length > 0 && changes.every((c) => c.path !== 'BLOCKED'),
      },
      adjustments,
    };
  }

  /** Las versiones anteriores de las líneas, de las ediciones ya auditadas de esta compra. */
  private async paperHistory(tx: Prisma.TransactionClient, purchaseId: string) {
    const events = await tx.auditLog.findMany({
      where: { action: 'purchases.update-received', entity: 'purchases', entityId: purchaseId },
      orderBy: { id: 'asc' },
      select: { before: true },
    });
    const lines: (PaperLine & { qty: string; unitPrice: string })[] = [];
    for (const e of events) {
      const before = e.before as { lines?: PaperLine[] } | null;
      for (const l of before?.lines ?? []) lines.push(l);
    }
    // La primera versión de una línea es la del papel original: va primero.
    return lines;
  }

  private async applyHeader(
    tx: Prisma.TransactionClient,
    loaded: Awaited<ReturnType<ReceivedPurchaseEditService['load']>>,
    input: CommitReceivedPurchaseEditInput,
    amountsChanged: boolean,
  ): Promise<{ total: string }> {
    const { purchase } = loaded;
    const header = input.header ?? {};
    const data: Prisma.PurchaseUpdateInput = {};

    const supplierId = header.supplierId ?? purchase.supplierId;
    const docType = header.docType ?? purchase.docType;
    const series = header.series ?? purchase.series;
    const number = header.number ?? purchase.number;
    const identityChanges =
      supplierId !== purchase.supplierId ||
      docType !== purchase.docType ||
      series !== purchase.series ||
      number !== purchase.number;
    if (identityChanges) {
      const clash = await tx.purchase.findFirst({
        where: {
          supplierId,
          docType,
          series,
          number,
          status: { not: PurchaseStatus.CANCELLED },
          id: { not: purchase.id },
        },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          'Ese comprobante ya está registrado para este proveedor en una compra vigente',
        );
      }
      if (supplierId !== purchase.supplierId) {
        data.supplier = { connect: { id: supplierId } };
        // Las bobinas de la compra son del proveedor de la compra. Su código no se regenera:
        // es la etiqueta física (decisión 5).
        await tx.coil.updateMany({ where: { purchaseId: purchase.id }, data: { supplierId } });
      }
      if (docType !== purchase.docType) data.docType = docType;
      if (series !== purchase.series) data.series = series;
      if (number !== purchase.number) data.number = number;
    }

    const issueDate = header.issueDate ?? dateOf(purchase.issueDate);
    const paymentTerms = header.paymentTerms ?? purchase.paymentTerms;
    const creditDays = header.creditDays !== undefined ? header.creditDays : purchase.creditDays;
    if (paymentTerms === 'CREDITO' && (creditDays === null || creditDays <= 0)) {
      throw new BadRequestException('Una compra al crédito necesita días de crédito');
    }
    if (header.issueDate !== undefined) data.issueDate = toDateOnly(issueDate);
    if (
      header.paymentTerms !== undefined ||
      header.creditDays !== undefined ||
      header.issueDate !== undefined
    ) {
      const due = computeDueDate({
        paymentTerms,
        creditDays: creditDays ?? undefined,
        issueDate,
      } as Parameters<typeof computeDueDate>[0]);
      data.paymentTerms = paymentTerms;
      data.creditDays = paymentTerms === 'CREDITO' ? creditDays : null;
      data.dueDate = due ? toDateOnly(due) : null;
    }
    if (header.notes !== undefined) data.notes = header.notes === '' ? null : header.notes;

    // Los totales de la cabecera, con la cuenta de D-371 sobre las líneas ya corregidas. Solo si
    // cambió algún importe: una edición de cáscara no reescribe los totales del papel (D-359).
    let total = purchase.total.toFixed(4);
    if (amountsChanged) {
      const items = await tx.purchaseItem.findMany({
        where: { purchaseId: purchase.id },
        select: { subtotal: true, igv: true },
      });
      const totals = purchaseTotalsOf(
        items.map((i) => ({ subtotal: i.subtotal.toString(), igv: i.igv.toString() })),
        purchase.exchangeRate.toString(),
      );
      data.subtotal = toFixedString(totals.subtotal, 'MONEY');
      data.igv = toFixedString(totals.igv, 'MONEY');
      data.total = toFixedString(totals.total, 'MONEY');
      data.totalPen = toFixedString(totals.totalPen, 'MONEY');
      total = toFixedString(totals.total, 'MONEY');
    }

    try {
      if (Object.keys(data).length > 0) {
        await tx.purchase.update({ where: { id: purchase.id }, data });
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          'Ese comprobante ya está registrado para este proveedor en una compra vigente',
        );
      }
      throw err;
    }
    return { total };
  }
}

/**
 * El rechazo de materia prima (D-134) dicho en los términos de esta pantalla. Llega cuando la
 * corrección ya escribió algo dentro de la transacción; al relanzarlo, `$transaction` deshace
 * todo (la compra, la bobina y los movimientos): el guardado es todo o nada.
 */
async function promisedMaterialMessage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BadRequestException && err.message.includes('prometidos a')) {
      throw new BadRequestException(
        `No se puede corregir porque esta bobina respalda material comprometido. ${err.message}`,
      );
    }
    throw err;
  }
}

/** Las líneas que la edición nombra: solo para ellas se simula la reversa (D-134). */
function touchedItems(input: EditReceivedPurchaseInput): Map<string, ReceivedPurchaseItemEdit> {
  return new Map((input.items ?? []).map((e) => [e.itemId, e]));
}

/** El costo de documento de una bobina antes de la edición (cc15, para la auditoría). */
interface CoilCostBefore {
  coilId: string;
  code: string;
  weightKg: string;
  unitCostPerKg: string;
  totalCost: string;
  totalCostPen: string;
}

/** Una línea como estaba antes de una edición: los importes del papel (D-359). */
interface PaperLine {
  itemId: string;
  qty: string;
  unitPrice: string;
  subtotal: string;
  igv: string;
  total: string;
}

/** El motivo por el que la tasa de IGV no se deduce de los totales, o `null` si se deduce. */
function igvRateIssueOf(subtotal: string, igv: string): string | null {
  try {
    impliedIgvRatePct(subtotal, igv);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'La tasa de IGV de la compra no es estándar';
  }
}

function assertAdmin(actor: RequestUser): void {
  if (actor.role !== Role.ADMINISTRADOR) {
    throw new ForbiddenException('Solo un administrador corrige una compra recibida');
  }
}

function dateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Un movimiento posterior, como lo necesita el clasificador. Un ajuste de **esta misma** compra
 * es una corrección de costo anterior (cc15): se nombra así, no como «otra compra».
 */
function laterOf(purchaseId: string): (m: MovementRow) => LaterMovement {
  return (m) => ({
    type: m.type,
    refType:
      m.type === 'ADJUST' && m.refType === 'PURCHASE' && m.refId === purchaseId
        ? 'OWN_COST_CORRECTION'
        : m.refType,
    operationDate: dateOf(m.operationDate),
  });
}

/** Qué documento movió una salida, para el aviso de los afectados (cc15). */
const REF_DOCUMENT: Record<string, string> = {
  SCRAP: 'Merma',
  SPLIT: 'Partido',
  CLOSE_ADJUSTMENT: 'Cierre de bobina',
  CUTTING: 'Corte tercerizado',
  ADJUSTMENT: 'Ajuste de inventario',
  PURCHASE: 'Compra',
  IMPORT: 'Carga inicial',
  SALE: 'Despacho',
  PRODUCTION: 'Producción',
};

/** El ajuste proporcional de una línea (decisión 3): lo que queda, el monto y lo que ya salió. */
interface LineAdjustment {
  remainingQty: Decimal;
  amountPen: Decimal;
  /** Salidas que se llevaron material de esta compra, con la cantidad que tomaron de ella. */
  consumers: { movement: MovementRow; qty: Decimal }[];
  /** Valor en stock del ítem (saldo × promedio): un ajuste a la baja no puede superarlo. */
  stockValuePen: Decimal;
}

function baseItemFacts(
  item: {
    id: string;
    lineNumber: number;
    productId: string | null;
    product: { sku: string } | null;
    description: string;
    unit: string;
    qty: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    finishId: string | null;
    widthMm: Prisma.Decimal | null;
    thicknessMm: Prisma.Decimal | null;
  },
  finishCode: Map<string, string>,
): Pick<
  ItemFacts,
  | 'itemId'
  | 'lineNumber'
  | 'productId'
  | 'productLabel'
  | 'description'
  | 'unit'
  | 'qty'
  | 'unitPrice'
  | 'finishId'
  | 'finishLabel'
  | 'widthMm'
  | 'thicknessMm'
> {
  return {
    itemId: item.id,
    lineNumber: item.lineNumber,
    productId: item.productId,
    productLabel: item.product?.sku ?? null,
    description: item.description,
    unit: item.unit,
    qty: item.qty.toFixed(3),
    unitPrice: item.unitPrice.toFixed(4),
    finishId: item.finishId,
    finishLabel: item.finishId ? (finishCode.get(item.finishId) ?? item.finishId) : null,
    widthMm: item.widthMm === null ? null : item.widthMm.toFixed(2),
    thicknessMm: item.thicknessMm === null ? null : item.thicknessMm.toFixed(2),
  };
}
