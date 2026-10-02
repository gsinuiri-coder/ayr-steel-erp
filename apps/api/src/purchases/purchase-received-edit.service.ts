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
  toDateOnly,
  Role,
  toDecimal,
  toFixedString,
  type CommitReceivedPurchaseEditInput,
  type EditReceivedPurchaseInput,
  type ReceivedEditPlanDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { ENV, type Env } from '../config/env';
import { InventoryService } from '../inventory/inventory.service';
import { liveMovements } from '../inventory/live-movements';
import { PrismaService } from '../prisma/prisma.service';
import { findLiveStripAssignments } from '../production/production-assignments';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import { assertRawMaterialInvariant } from '../sales/raw-material';
import { reservedByItem } from '../sales/reserved-ledger';
import { computeDueDate, receptionCost } from './purchase-math';
import { editedLineAmounts, impliedIgvRatePct, purchaseTotalsOf } from './purchase-draft-edit';
import {
  blockedSummary,
  classifyReceivedEdit,
  type ItemFacts,
  type PurchaseFacts,
  type TargetFacts,
} from './purchase-received-edit';

type MovementRow = Prisma.InventoryMovementGetPayload<{
  include: { reversals: { select: { id: true } } };
}>;

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
        const loaded = await this.load(tx, id);
        const targets = await this.loadTargets(tx, loaded.purchase, loaded.receiptDate, input);
        return classifyReceivedEdit(loaded.facts, input, targets);
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

        const loaded = await this.load(tx, id);
        const targets = await this.loadTargets(tx, loaded.purchase, loaded.receiptDate, input);
        const plan = classifyReceivedEdit(loaded.facts, input, targets);
        if (plan.changes.length === 0) return plan;
        if (!plan.executable) throw new BadRequestException(blockedSummary(plan));

        const movements = await this.applyItems(tx, actor, loaded, input);
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

  private async load(tx: Prisma.TransactionClient, id: string) {
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
        loadedItems.push({
          coilId: coil?.id ?? null,
          ownIn,
          facts: {
            ...baseItemFacts(item, finishCode),
            laterMovements: live
              .filter((m) => m.id !== ownIn?.id)
              .map((m) => ({ refType: m.refType, operationDate: dateOf(m.operationDate) })),
            hasLiveIn: ownIn !== null,
            coilStatus: coil?.status ?? null,
            mountedOrder: assignments.find((a) => a.coilId === coil?.id)?.orderCode ?? null,
            ownReservation: coil ? (ownReserved.get(coil.id) ?? toDecimal('0')).gt(0) : false,
            landedCost: live.some((m) => m.type === 'ADJUST'),
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
        if (ownIn) {
          const balance = await tx.inventoryBalance.findUnique({
            where: { itemType_itemId: { itemType: 'PRODUCT', itemId: ownIn.itemId } },
            select: { qty: true },
          });
          const reserved =
            (await reservedByItem(tx, InventoryItemType.PRODUCT, [ownIn.itemId])).get(
              ownIn.itemId,
            ) ?? toDecimal('0');
          const remaining = toDecimal((balance?.qty ?? 0).toString()).minus(ownIn.qty.toString());
          reservationShort = reserved.gt(0) && reserved.gt(remaining);
        }
        loadedItems.push({
          coilId: null,
          ownIn,
          facts: {
            ...baseItemFacts(item, finishCode),
            laterMovements: later.map((m) => ({
              refType: m.refType,
              operationDate: dateOf(m.operationDate),
            })),
            hasLiveIn: ownIn !== null,
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
        notes: purchase.notes,
      },
      items: loadedItems.map((l) => l.facts),
    };
    return { purchase, facts, items: loadedItems, receiptDate, livePayments };
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
          select: { sku: true, isActive: true, businessLineId: true, unit: true },
        });
        if (!product) {
          invalidProducts.set(edit.productId, 'El producto no existe');
          continue;
        }
        labels.set(edit.productId, product.sku);
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
    return { labels, invalidProducts, invalidFinishes, productsWithLaterMovements };
  }

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  private async applyItems(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    loaded: Awaited<ReturnType<ReceivedPurchaseEditService['load']>>,
    input: CommitReceivedPurchaseEditInput,
  ): Promise<{
    reversed: string[];
    created: string[];
    amountsChanged: boolean;
    linesBefore: PaperLine[];
  }> {
    const reversed: string[] = [];
    const created: string[] = [];
    const linesBefore: PaperLine[] = [];
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

      // La línea: sin cambio de importes se conserva el del papel (D-359). Con cambio, si la
      // cantidad y el precio vuelven a los de una versión anterior de la línea, sus importes de
      // entonces (deshacer exacto, decisión 10); si no, la cuenta del alta y de D-371.
      const restored = amountsChange
        ? paperHistory.find(
            (p) => p.itemId === item.id && qty.equals(p.qty) && unitPrice.equals(p.unitPrice),
          )
        : undefined;
      const amounts = !amountsChange
        ? {
            subtotal: item.subtotal.toString(),
            igv: item.igv.toString(),
            total: item.total.toString(),
          }
        : (restored ??
          editedLineAmounts(
            qty.toString(),
            unitPrice.toString(),
            impliedIgvRatePct(purchase.subtotal.toString(), purchase.igv.toString()),
          ));
      const lineSubtotal = toDecimal(amounts.subtotal.toString());
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

      if ((amountsChange || productChange) && !loadedItem.ownIn) {
        // El clasificador ya lo bloquea (`hasLiveIn`); esto es la red por si dejara de hacerlo:
        // corregir la compra sin su kardex los separaría sin aviso.
        throw new BadRequestException(
          `La línea ${String(item.lineNumber)} no tiene un ingreso de kardex vivo que corregir`,
        );
      }
      if ((amountsChange || productChange) && loadedItem.ownIn) {
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
        await this.inventory.reverse(
          tx,
          ownIn.id,
          actor.id,
          `Corrección de la compra recibida: ${input.reason}`.slice(0, 240),
          date,
          true,
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
      }

      if (purchase.type === PurchaseType.COIL && loadedItem.coilId) {
        const coil = await tx.coil.findUniqueOrThrow({
          where: { id: loadedItem.coilId },
          select: { id: true, finishId: true, colorId: true, thicknessMm: true, widthMm: true },
        });
        const coilData: Prisma.CoilUpdateInput = {};
        if (amountsChange) {
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
      await assertRawMaterialInvariant(tx, [t.coilId], roofingToleranceMm(this.env), {
        alsoAffecting: [
          {
            businessLineId: purchase.businessLineId,
            colorId: t.before.colorId,
            thicknessMm: t.before.thicknessMm,
          },
        ],
      });
    }
    return { reversed, created, amountsChanged, linesBefore };
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

function baseItemFacts(
  item: {
    id: string;
    lineNumber: number;
    productId: string | null;
    product: { sku: string } | null;
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
    unit: item.unit,
    qty: item.qty.toFixed(3),
    unitPrice: item.unitPrice.toFixed(4),
    finishId: item.finishId,
    finishLabel: item.finishId ? (finishCode.get(item.finishId) ?? item.finishId) : null,
    widthMm: item.widthMm === null ? null : item.widthMm.toFixed(2),
    thicknessMm: item.thicknessMm === null ? null : item.thicknessMm.toFixed(2),
  };
}
