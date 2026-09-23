import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BusinessLineCode,
  FinishKind,
  InventoryItemType,
  QuotationStatus,
  SalesOrderStatus,
  type Prisma,
} from '@prisma/client';
import {
  COIL_SKU_PREFIX,
  Decimal,
  quotationCode,
  salesOrderCode,
  toDecimal,
  toFixedString,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  COIL_SALE_IDENTITY_SELECT,
  coilPoolKeyOf,
  coilPoolKeyOfProduct,
  coilSaleSkus,
} from '../sales/coil-sale-product';
import { mergeProductInto, renameProductSku, type MergeActor } from './product-merge';

/**
 * **Normalización de los SKU de bobina (D-252/D-253, RF-S4b/M1).** Dry-run por defecto.
 *
 * Agrupa los productos de venta de bobina activos por su SKU canónico y dice qué hace falta:
 *
 * - **renombre simple**: un producto → su SKU canónico, conservando el id (y con él la historia);
 * - **unión**: varios productos → uno. El principal es el que ya tiene el código canónico o, si
 *   ninguno lo tiene, el que tiene más movimientos (líneas de cotización, pedido, comprobante y
 *   despacho); ese toma el canónico y los demás quedan inactivos con su código viejo y
 *   `mergedIntoId` al principal;
 * - **no interpretables**: productos `BOB…` cuyo color o tipo no mapea al catálogo.
 *
 * **Las bobinas no se mueven.** Su saldo vive en su propio kardex y el producto se deduce de ellas
 * (D-252), así que no hay movimientos que parear: lo que cambia es a qué producto resuelve cada
 * una. Por eso el cuadre de kilos es **bobina por bobina**: cada bobina con saldo tiene que
 * resolver a un producto antes y después, y el total tiene que ser el mismo.
 *
 * **Paradas (D-230):** un producto a unir con saldo propio o con cotizaciones o pedidos abiertos
 * (se listan; el execute exige reconocerlos), un color o tipo que no mapea, un choque de base,
 * un empate al elegir el principal, un SKU canónico tomado por un producto inactivo y cualquier
 * descuadre de kilos.
 */

export interface NormalizationProductRef {
  id: string;
  sku: string;
  name: string;
  /** Líneas de cotización, pedido, comprobante y despacho que lo usan. */
  uses: number;
}

export interface NormalizationGroup {
  canonicalSku: string;
  principal: NormalizationProductRef;
  /** `true` si el principal cambia de SKU. */
  renamePrincipal: boolean;
  /** Los que se unen al principal. Vacío en un renombre simple. */
  merged: NormalizationProductRef[];
  coils: number;
  kg: string;
}

export interface NormalizationOpenDocument {
  productSku: string;
  kind: 'COTIZACION' | 'PEDIDO';
  code: string;
  status: string;
}

export interface NormalizationPlan {
  renames: NormalizationGroup[];
  merges: NormalizationGroup[];
  unchanged: number;
  uninterpretable: { id: string; sku: string; name: string }[];
  openDocuments: NormalizationOpenDocument[];
  /** Paradas que el execute no atraviesa nunca. */
  stops: string[];
  kg: {
    coils: number;
    /** Kilos de todas las bobinas con saldo (kardex de bobinas). */
    total: string;
    /** Kilos que hoy resuelven a un producto activo. */
    before: string;
    /** Kilos que resolverían al principal de su grupo después. Tiene que ser igual a `total`. */
    after: string;
    /** Bobinas con saldo que no resuelven a ningún producto activo. */
    unresolvedBefore: string[];
    unresolvedAfter: string[];
  };
}

const OPEN_QUOTATION = [QuotationStatus.DRAFT, QuotationStatus.EMITTED];
const OPEN_ORDER = [
  SalesOrderStatus.CONFIRMED,
  SalesOrderStatus.IN_PRODUCTION,
  SalesOrderStatus.PARTIALLY_FULFILLED,
];

@Injectable()
export class CoilSkuNormalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Dry-run: el plan, sin escribir nada. */
  plan(): Promise<NormalizationPlan> {
    return this.prisma.$transaction((tx) => buildPlan(tx), { timeout: 120_000 });
  }

  /**
   * Aplica el plan en una transacción. Vuelve a calcularlo adentro —no confía en el dry-run de
   * hace un rato—, se niega si hay paradas (y, si hay documentos abiertos, sin
   * `acknowledgeOpenDocuments`), y al final lo recalcula para comprobar que no quedó nada por hacer
   * y que los kilos cuadran.
   */
  async execute(
    actor: MergeActor,
    options: { acknowledgeOpenDocuments: boolean },
  ): Promise<{ before: NormalizationPlan; after: NormalizationPlan }> {
    return this.prisma.$transaction(
      async (tx) => {
        const before = await buildPlan(tx);
        if (before.stops.length > 0) {
          throw new BadRequestException(
            `La normalización se detiene:\n- ${before.stops.join('\n- ')}`,
          );
        }
        if (before.openDocuments.length > 0 && !options.acknowledgeOpenDocuments) {
          throw new BadRequestException(
            `Hay ${String(before.openDocuments.length)} documento(s) abierto(s) con productos a unir; revísalos en el dry-run y confirma con --ack-open-documents.`,
          );
        }
        const reason = 'Normalización de SKU de bobina (D-252/D-253)';
        for (const group of before.merges) {
          for (const source of group.merged) {
            await mergeProductInto(tx, this.audit, actor, {
              sourceId: source.id,
              targetId: group.principal.id,
              reason,
            });
          }
        }
        for (const group of [...before.merges, ...before.renames]) {
          if (group.renamePrincipal) {
            await renameProductSku(tx, this.audit, actor, {
              productId: group.principal.id,
              newSku: group.canonicalSku,
              reason,
            });
          }
        }
        const after = await buildPlan(tx);
        if (
          after.renames.length > 0 ||
          after.merges.length > 0 ||
          after.stops.length > 0 ||
          after.kg.total !== before.kg.total ||
          after.kg.before !== before.kg.total ||
          after.kg.unresolvedBefore.length > 0
        ) {
          throw new BadRequestException(
            'La normalización no dejó el catálogo como debía (quedan cambios, paradas o un descuadre de kilos): no se aplicó nada.',
          );
        }
        return { before, after };
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
  }
}

/** El plan, calculado dentro de la transacción que se le pase. */
export async function buildPlan(tx: Prisma.TransactionClient): Promise<NormalizationPlan> {
  const stops: string[] = [];
  const trading = await tx.businessLine.findUnique({ where: { code: BusinessLineCode.TRADING } });
  if (!trading) throw new BadRequestException('No existe la línea de reventa');

  const products = await tx.product.findMany({
    where: {
      businessLineId: trading.id,
      sku: { startsWith: COIL_SKU_PREFIX },
      isActive: true,
    },
    select: {
      id: true,
      sku: true,
      name: true,
      businessLine: { select: { code: true } },
      _count: {
        select: {
          quotationItems: true,
          salesOrderItems: true,
          invoiceItems: true,
          dispatchItems: true,
        },
      },
    },
    orderBy: { sku: 'asc' },
  });

  // Las bobinas: su identidad (para saber su pool) y su saldo.
  const coils = await tx.coil.findMany({
    select: { id: true, code: true, finishId: true, ...COIL_SALE_IDENTITY_SELECT },
  });
  const balances = await tx.inventoryBalance.findMany({
    where: { itemType: InventoryItemType.COIL, itemId: { in: coils.map((c) => c.id) } },
    select: { itemId: true, qty: true },
  });
  const kgById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));

  // Productos → grupo canónico.
  const groups = new Map<string, (NormalizationProductRef & { fromCoil: boolean })[]>();
  const uninterpretable: NormalizationPlan['uninterpretable'] = [];
  const legacySkus = new Set(coils.map((c) => coilSaleSkus(c).legacy));
  for (const p of products) {
    const key = await coilPoolKeyOfProduct(tx, p);
    if (key === null) {
      uninterpretable.push({ id: p.id, sku: p.sku, name: p.name });
      continue;
    }
    const ref = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      uses:
        p._count.quotationItems +
        p._count.salesOrderItems +
        p._count.invoiceItems +
        p._count.dispatchItems,
      fromCoil: legacySkus.has(p.sku) || p.sku === key.sku,
    };
    groups.set(key.sku, [...(groups.get(key.sku) ?? []), ref]);
  }
  for (const u of uninterpretable) {
    stops.push(`${u.sku} («${u.name}»): su color o tipo no mapea al catálogo`);
  }

  // Bobinas por grupo canónico, y choques de base dentro del grupo.
  const coilsBySku = new Map<string, typeof coils>();
  for (const coil of coils) {
    const key = coilPoolKeyOf(coil);
    if (key === null) continue;
    coilsBySku.set(key.sku, [...(coilsBySku.get(key.sku) ?? []), coil]);
  }
  const finishes = await tx.finish.findMany({
    where: { id: { in: [...new Set(coils.map((c) => c.finishId))] } },
    select: { id: true, code: true, kind: true, densityFactor: true },
  });
  const finishById = new Map(finishes.map((f) => [f.id, f]));
  for (const [sku, list] of coilsBySku) {
    // Mismo criterio que el alta (`assertNoBaseCollision`): solo un prepintado esconde la base,
    // y lo que la delata es la densidad.
    const used = [...new Set(list.map((c) => c.finishId))].flatMap((id) => {
      const f = finishById.get(id);
      return f?.kind === FinishKind.PREPINTADO ? [f] : [];
    });
    const [first] = used;
    const clash = used.find(
      (f) => first !== undefined && !f.densityFactor.equals(first.densityFactor),
    );
    if (first && clash) {
      stops.push(
        `${sku}: los acabados ${first.code} y ${clash.code} comparten SKU pero no la base (densidades distintas)`,
      );
    }
  }

  // Canónicos tomados por un producto inactivo: renombrar encima chocaría con el índice único.
  const inactiveHolders = await tx.product.findMany({
    where: { businessLineId: trading.id, sku: { in: [...groups.keys()] }, isActive: false },
    select: { sku: true },
  });
  for (const h of inactiveHolders) {
    stops.push(`${h.sku} ya existe como producto inactivo: el canónico no se puede tomar`);
  }

  const renames: NormalizationGroup[] = [];
  const merges: NormalizationGroup[] = [];
  let unchanged = 0;
  const principalBySku = new Map<string, string>();
  for (const [canonicalSku, members] of groups) {
    const exact = members.find((m) => m.sku === canonicalSku);
    let principal = exact;
    if (!principal) {
      // El que más movimientos tiene; en empate, el que una bobina real ya resolvía. Un empate
      // que eso no rompe es del dueño: no se elige por orden de alta.
      const ranked = [...members].sort(
        (a, b) => b.uses - a.uses || Number(b.fromCoil) - Number(a.fromCoil),
      );
      const [top, second] = ranked;
      if (top && second?.uses === top.uses && top.fromCoil === second.fromCoil) {
        stops.push(
          `${canonicalSku}: empate para elegir el principal entre ${top.sku} y ${second.sku} (${String(top.uses)} movimientos cada uno)`,
        );
      }
      principal = top;
    }
    if (!principal) continue;
    principalBySku.set(canonicalSku, principal.id);
    const merged = members.filter((m) => m.id !== principal.id);
    const list = coilsBySku.get(canonicalSku) ?? [];
    const kg = list.reduce((acc, c) => acc.plus(kgById.get(c.id) ?? 0), new Decimal(0));
    const group: NormalizationGroup = {
      canonicalSku,
      principal: {
        id: principal.id,
        sku: principal.sku,
        name: principal.name,
        uses: principal.uses,
      },
      renamePrincipal: principal.sku !== canonicalSku,
      merged: merged.map(({ fromCoil: _f, ...m }) => m),
      coils: list.length,
      kg: toFixedString(kg, 'KG'),
    };
    if (merged.length > 0) merges.push(group);
    else if (group.renamePrincipal) renames.push(group);
    else unchanged += 1;
  }

  // Documentos abiertos de los productos que se van a unir (parada del dueño: se listan).
  const mergedIds = merges.flatMap((g) => g.merged.map((m) => m.id));
  const skuById = new Map(merges.flatMap((g) => g.merged.map((m) => [m.id, m.sku] as const)));
  const openDocuments: NormalizationOpenDocument[] = [];
  if (mergedIds.length > 0) {
    const [quotations, orders] = await Promise.all([
      tx.quotationItem.findMany({
        where: { productId: { in: mergedIds }, quotation: { status: { in: OPEN_QUOTATION } } },
        select: { productId: true, quotation: { select: { seq: true, status: true } } },
      }),
      tx.salesOrderItem.findMany({
        where: { productId: { in: mergedIds }, salesOrder: { status: { in: OPEN_ORDER } } },
        select: { productId: true, salesOrder: { select: { seq: true, status: true } } },
      }),
    ]);
    for (const q of quotations) {
      openDocuments.push({
        productSku: skuById.get(q.productId) ?? q.productId,
        kind: 'COTIZACION',
        code: quotationCode(q.quotation.seq),
        status: q.quotation.status,
      });
    }
    for (const o of orders) {
      openDocuments.push({
        productSku: skuById.get(o.productId) ?? o.productId,
        kind: 'PEDIDO',
        code: salesOrderCode(o.salesOrder.seq),
        status: o.salesOrder.status,
      });
    }
  }

  // El cuadre de kilos, bobina por bobina: antes resuelve por la regla de la transición
  // (canónico o viejo, activos); después, al principal de su grupo canónico.
  const activeBySku = new Map(products.map((p) => [p.sku, p.id]));
  const withKg = coils.filter((c) => (kgById.get(c.id) ?? new Decimal(0)).gt(0));
  let total = new Decimal(0);
  let before = new Decimal(0);
  let after = new Decimal(0);
  const unresolvedBefore: string[] = [];
  const unresolvedAfter: string[] = [];
  for (const coil of withKg) {
    const kg = kgById.get(coil.id) ?? new Decimal(0);
    total = total.plus(kg);
    const skus = coilSaleSkus(coil);
    if (activeBySku.has(skus.canonical) || activeBySku.has(skus.legacy)) before = before.plus(kg);
    else unresolvedBefore.push(coil.code);
    const key = coilPoolKeyOf(coil);
    if (key !== null && principalBySku.has(key.sku)) after = after.plus(kg);
    else unresolvedAfter.push(coil.code);
  }
  // Después, **todo** el kilo de bobina con saldo tiene que resolver a un producto: es el total
  // del kardex de bobinas, no lo que resolvía antes (una bobina que hoy no resuelve y después sí
  // es una mejora, no un descuadre; se informa en `unresolvedBefore`).
  if (!total.equals(after)) {
    stops.push(
      `Descuadre de kilos: hay ${toFixedString(total, 'KG')} kg en bobinas con saldo y ${toFixedString(after, 'KG')} kg resolverían a un producto después`,
    );
  }
  for (const code of unresolvedAfter) {
    stops.push(`La bobina ${code} (con saldo) no resolvería a ningún producto después`);
  }

  return {
    renames,
    merges,
    unchanged,
    uninterpretable,
    openDocuments,
    stops,
    kg: {
      coils: withKg.length,
      total: toFixedString(total, 'KG'),
      before: toFixedString(before, 'KG'),
      after: toFixedString(after, 'KG'),
      unresolvedBefore,
      unresolvedAfter,
    },
  };
}
