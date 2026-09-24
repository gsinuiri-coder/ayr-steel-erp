import { BadRequestException } from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  FinishKind,
  InventoryItemType,
  ProductSource,
  QuotationStatus,
  type Prisma,
} from '@prisma/client';
import {
  canonicalCoilSku,
  coilProductName,
  coilSku,
  commercialColorToken,
  COIL_SKU_PREFIX,
  Decimal,
  normalizeCoilSku,
  toDecimal,
  toFixedString,
  Unit,
} from '@ayr/shared';
import { findLiveStripAssignments } from '../production/production-assignments';
import { reservedByItem, type ReservedScope } from './reserved-ledger';

/**
 * **El producto de venta de una bobina (D-252, D-253, D-254 — RF-S4b).**
 *
 * Una bobina no le pertenece a un producto: su saldo vive en el kardex de la propia bobina y el
 * producto `BOB…` de la línea de reventa es solo lo que se factura cuando se la vende. Qué
 * producto es se **deduce** de la bobina: espesor + color comercial o tipo (D-252). Todo lo que
 * responde esa pregunta pasa por acá — el alta de la bobina, la venta de bobina entera, el
 * importador y la herramienta de normalización —, para que no vuelva a pasar lo de D-168: dos
 * cuentas que dicen calcular el mismo SKU y no coinciden.
 *
 * **Transición (D-253).** Hasta que la normalización corra en producción, los productos existentes
 * tienen el SKU viejo (`BOB{acabado}{espesor}`, D-037). La resolución acepta los dos —primero el
 * canónico— y nunca devuelve un producto inactivo, que es como queda un producto unido a otro.
 */

/**
 * D-254: ¿es un producto de venta de bobina? Los de la línea de reventa con prefijo `BOB`: los
 * genera el alta de la bobina (D-252) y el catálogo ya no deja crear uno suelto (D-257), así que
 * el prefijo en esa línea es la marca. Los heredados sueltos (`BOB38AZUL`) también la llevan.
 */
export function isCoilSaleProduct(product: {
  sku: string;
  businessLine: { code: BusinessLineCode };
}): boolean {
  return (
    product.businessLine.code === BusinessLineCode.TRADING &&
    product.sku.toUpperCase().startsWith(COIL_SKU_PREFIX)
  );
}

/** Lo que hace falta de una bobina para saber su SKU. */
export interface CoilSaleIdentity {
  thicknessMm: Prisma.Decimal | string;
  finish: {
    code: string;
    kind: FinishKind;
    color: { code: string } | null;
  };
}

/** El `select` de Prisma que trae exactamente lo que pide {@link CoilSaleIdentity}. */
export const COIL_SALE_IDENTITY_SELECT = {
  thicknessMm: true,
  finish: { select: { code: true, kind: true, color: { select: { code: true } } } },
} as const;

function thicknessOf(identity: CoilSaleIdentity): string {
  return toDecimal(identity.thicknessMm.toString()).toFixed(2);
}

/** D-252: el SKU canónico de la bobina, y el viejo que la transición todavía reconoce. */
export function coilSaleSkus(identity: CoilSaleIdentity): { canonical: string; legacy: string } {
  const thicknessMm = thicknessOf(identity);
  return {
    canonical: canonicalCoilSku(
      { kind: identity.finish.kind, colorCode: identity.finish.color?.code ?? null },
      thicknessMm,
    ),
    legacy: coilSku(identity.finish.code, thicknessMm),
  };
}

export interface CoilSaleProduct {
  id: string;
  sku: string;
  name: string;
  businessLineId: string;
}

/**
 * D-253: el producto de venta de cada identidad, **activo**, canónico primero y el viejo como
 * respaldo. Una sola consulta para toda la tanda. La clave del mapa es el SKU canónico.
 */
export async function findCoilSaleProducts(
  tx: Prisma.TransactionClient,
  identities: readonly CoilSaleIdentity[],
): Promise<Map<string, CoilSaleProduct>> {
  const out = new Map<string, CoilSaleProduct>();
  if (identities.length === 0) return out;
  const trading = await tx.businessLine.findUnique({ where: { code: BusinessLineCode.TRADING } });
  if (!trading) return out;
  const pairs = identities.map(coilSaleSkus);
  const skus = [...new Set(pairs.flatMap((p) => [p.canonical, p.legacy]))];
  const products = await tx.product.findMany({
    where: { businessLineId: trading.id, sku: { in: skus }, isActive: true },
    select: { id: true, sku: true, name: true, businessLineId: true },
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  for (const pair of pairs) {
    const product = bySku.get(pair.canonical) ?? bySku.get(pair.legacy);
    if (product) out.set(pair.canonical, product);
  }
  return out;
}

/**
 * D-252: los tokens de color o tipo que el catálogo conoce, para el normalizador. Los colores
 * del catálogo (por su color comercial) y los tipos sin color.
 */
export async function knownCoilAttributes(tx: Prisma.TransactionClient): Promise<Set<string>> {
  // **Todos** los colores, activos o no: un color dado de baja sigue siendo del catálogo, y sus
  // bobinas y productos existentes tienen que seguir interpretándose. Con solo los activos, la
  // normalización paraba sobre cada `BOB…` de un color retirado (lo mostró la suite E2E).
  const colors = await tx.color.findMany({ select: { code: true } });
  return new Set([
    // Un color cuyo código es solo un RAL no tiene color comercial: no entra como token.
    ...colors.map((c) => commercialColorToken(c.code)).filter((t) => t !== ''),
    FinishKind.NATURAL,
    FinishKind.GALVANIZADO,
  ]);
}

/** El token de color o tipo de un acabado, o `null` si es un prepintado sin color (D-203). */
function attributeOf(finish: { kind: FinishKind; color: { code: string } | null }): string | null {
  if (finish.kind !== FinishKind.PREPINTADO) return finish.kind;
  return finish.color === null ? null : commercialColorToken(finish.color.code);
}

/**
 * D-252 punto 3: dos acabados que comparten SKU **no** pueden diferir en lo que el SKU nuevo ya
 * no dice — la base (aluzinc o galvanizado). Solo un **prepintado** puede esconderla: en uno sin
 * color el tipo (`NATURAL`, `GALVANIZADO`) ya es la base y va en el SKU. En un prepintado el
 * modelo no la guarda en ningún campo propio; lo que la delata es la **densidad** del acabado.
 * La línea de negocio no cuenta: el mismo color vive a propósito en dos líneas con la misma
 * densidad (`finishForCoil`, D-203) y se vende con el mismo SKU de reventa.
 */
export async function assertNoBaseCollision(
  tx: Prisma.TransactionClient,
  finish: {
    id: string;
    code: string;
    kind: FinishKind;
    densityFactor: Prisma.Decimal;
    businessLineId: string;
    color: { code: string } | null;
  },
): Promise<void> {
  const attribute = attributeOf(finish);
  if (attribute === null || finish.kind !== FinishKind.PREPINTADO) return;
  const siblings = await tx.finish.findMany({
    where: { kind: finish.kind, isActive: true, id: { not: finish.id } },
    select: {
      code: true,
      kind: true,
      densityFactor: true,
      businessLineId: true,
      color: { select: { code: true } },
    },
  });
  const clash = siblings.find(
    (s) => attributeOf(s) === attribute && !s.densityFactor.equals(finish.densityFactor),
  );
  if (clash) {
    throw new BadRequestException(
      `Los acabados ${finish.code} y ${clash.code} comparten el SKU de bobina (${COIL_SKU_PREFIX}…${attribute}) pero no la base: ` +
        'tienen densidades distintas. Corrige el catálogo de acabados antes de dar de alta la bobina (D-252).',
    );
  }
}

/**
 * D-252/D-037: asegura el producto de venta de la bobina, con el SKU **canónico**. Si ya existe
 * con ese SKU no se toca; uno viejo con el mismo tipo no se renombra acá —eso es de la
 * normalización (D-253), con dry-run y auditoría—, pero sí sigue resolviendo mientras tanto.
 */
export async function ensureCoilSaleProduct(
  tx: Prisma.TransactionClient,
  finish: {
    id: string;
    code: string;
    name: string;
    kind: FinishKind;
    densityFactor: Prisma.Decimal;
    businessLineId: string;
    color: { code: string } | null;
  },
  thicknessMm: string,
): Promise<void> {
  const trading = await tx.businessLine.findUnique({ where: { code: BusinessLineCode.TRADING } });
  if (!trading) return;
  const { canonical } = coilSaleSkus({ thicknessMm, finish });
  const existing = await tx.product.findUnique({
    where: { businessLineId_sku: { businessLineId: trading.id, sku: canonical } },
    select: { id: true },
  });
  if (existing) return;
  // El choque de base se mira **al crear** el producto, no en cada alta de bobina: si la base ya
  // estaba mezclada en producción, trabar la recepción de compras al día siguiente del deploy
  // sería peor que el problema; esos casos los lista el dry-run de la normalización.
  await assertNoBaseCollision(tx, finish);
  await tx.product.upsert({
    where: { businessLineId_sku: { businessLineId: trading.id, sku: canonical } },
    create: {
      businessLineId: trading.id,
      sku: canonical,
      name: coilProductName(finish.name, thicknessMm),
      unit: Unit.KGM,
      source: ProductSource.PURCHASED,
    },
    update: {},
  });
}

/** El pool de un SKU canónico: el SKU, el espesor y el color comercial o tipo. */
export interface CoilPoolKey {
  sku: string;
  thicknessMm: string;
  attribute: string;
}

/** El pool al que pertenece una bobina concreta. */
export function coilPoolKeyOf(identity: CoilSaleIdentity): CoilPoolKey | null {
  const attribute = attributeOf(identity.finish);
  if (attribute === null) return null;
  return { sku: coilSaleSkus(identity).canonical, thicknessMm: thicknessOf(identity), attribute };
}

/**
 * D-254: el pool de un **producto de venta de bobina**, cualquiera sea la forma de su SKU: el
 * canónico (`BOB038AZUL`), uno heredado cargado a mano (`BOB38AZUL`, que el normalizador
 * interpreta, con la descripción de respaldo) o el viejo de la transición (`BOBALZ-AZUL0.38`,
 * que se reconoce por el código del acabado). `null` si no es un producto de bobina o no se
 * puede interpretar.
 */
export async function coilPoolKeyOfProduct(
  tx: Prisma.TransactionClient,
  product: { sku: string; name: string; businessLine: { code: BusinessLineCode } },
  description?: string | null,
): Promise<CoilPoolKey | null> {
  if (!isCoilSaleProduct(product)) return null;
  const known = await knownCoilAttributes(tx);
  const parsed = normalizeCoilSku(
    { code: product.sku, description: description ?? product.name },
    known,
  );
  if (parsed.ok) {
    return { sku: parsed.sku, thicknessMm: parsed.thicknessMm, attribute: parsed.attribute };
  }
  // El SKU viejo (D-037/D-168): `BOB` + código de acabado + espesor con dos decimales. El
  // espesor lleva **un** dígito entero (`0.38`): con `\d+` un acabado que termina en dígitos
  // (`EDBO089957`) se comía el espesor entero y el producto no se reconocía.
  const legacy = /^BOB(.+?)(\d\.\d{2})$/.exec(product.sku.toUpperCase());
  if (!legacy) return null;
  const [, finishCode = '', thicknessMm = ''] = legacy;
  const finish = await tx.finish.findUnique({
    where: { code: finishCode },
    select: { code: true, kind: true, color: { select: { code: true } } },
  });
  return finish === null ? null : coilPoolKeyOf({ thicknessMm, finish });
}

/**
 * D-254: el pool de una línea de documento. La que ya vende una bobina sale de esa bobina; la
 * que está enganchada a un producto de bobina (COT-000002), de ese producto.
 */
export async function lineCoilPool(
  tx: Prisma.TransactionClient,
  line: {
    description: string;
    reserveItemType: InventoryItemType;
    reserveItemId: string;
    product: { sku: string; name: string; businessLine: { code: BusinessLineCode } };
  },
): Promise<CoilPoolKey | null> {
  if (line.reserveItemType === InventoryItemType.COIL) {
    const coil = await tx.coil.findUnique({
      where: { id: line.reserveItemId },
      select: COIL_SALE_IDENTITY_SELECT,
    });
    return coil === null ? null : coilPoolKeyOf(coil);
  }
  return coilPoolKeyOfProduct(tx, line.product, line.description);
}

/**
 * D-257 (aclaración): las bobinas **abiertas o cerradas con saldo** del pool de un producto de
 * venta de bobina, sin mirar reservas ni OP. Las cerradas cuentan porque D-116 también las vende
 * (revisión cruzada RF-S4b, P2-7): apagar el producto las dejaría sin producto de venta igual. Es lo que impide desactivarlo: apagar el `BOB…` canónico
 * deja sin producto de venta a todas esas bobinas («no existe el producto de venta directa»).
 * Devuelve los códigos, para nombrarlos en el rechazo.
 */
export async function openCoilCodesInPool(
  tx: Prisma.TransactionClient,
  product: { sku: string; name: string; businessLine: { code: BusinessLineCode } },
): Promise<string[]> {
  const key = await coilPoolKeyOfProduct(tx, product);
  if (key === null) return [];
  const coils = await tx.coil.findMany({
    where: {
      kind: CoilKind.COIL,
      status: { in: [CoilStatus.OPEN, CoilStatus.CLOSED] },
      thicknessMm: toFixedString(key.thicknessMm, 'MM'),
    },
    select: {
      id: true,
      code: true,
      finish: { select: { kind: true, color: { select: { code: true } } } },
    },
    orderBy: { code: 'asc' },
  });
  const inPool = coils.filter((c) => attributeOf(c.finish) === key.attribute);
  if (inPool.length === 0) return [];
  const balances = await tx.inventoryBalance.findMany({
    where: {
      itemType: InventoryItemType.COIL,
      itemId: { in: inPool.map((c) => c.id) },
      qty: { gt: 0 },
    },
    select: { itemId: true },
  });
  const withBalance = new Set(balances.map((b) => b.itemId));
  return inPool.filter((c) => withBalance.has(c.id)).map((c) => c.code);
}

// ---------------------------------------------------------------------------
// D-254: el pool de bobinas de un SKU canónico
// ---------------------------------------------------------------------------

export interface CoilPoolCandidate {
  coilId: string;
  code: string;
  widthMm: string;
  /** Saldo del kardex de la bobina, en kg. */
  balanceKg: string;
}

export interface CoilPool {
  /** Suma del saldo de las bobinas del pool que no están comprometidas, en kg. */
  availableKg: string;
  /** Las que pueden atender la línea: libres y con saldo ≥ la cantidad. */
  candidates: CoilPoolCandidate[];
  /** La elegida sin intervención (D-254), o `null` si hay que elegir a mano. */
  autoCoilId: string | null;
}

/**
 * D-254: las bobinas que pueden atender una línea de un SKU canónico.
 *
 * Candidatas: bobinas (no flejes) abiertas, del **espesor exacto** y el mismo color comercial o
 * tipo —ROJO y ROJO-3020 juntos, **solo para venta**: producción sigue con el color exacto de
 * D-085—, con saldo ≥ la cantidad, sin reserva viva de otro documento y sin estar montadas en una
 * OP. La elección automática ocurre solo si hay una única candidata, o si exactamente una tiene
 * saldo igual a la cantidad del papel. Nunca por orden de alta ni al azar.
 *
 * `scope` excluye la reserva del propio documento, para que reatar una línea no se bloquee a sí
 * misma.
 */
export async function coilPoolFor(
  tx: Prisma.TransactionClient,
  pool: { thicknessMm: string; attribute: string },
  qty: string,
  scope: ReservedScope = {},
): Promise<CoilPool> {
  const coils = await tx.coil.findMany({
    where: {
      kind: CoilKind.COIL,
      status: CoilStatus.OPEN,
      thicknessMm: toFixedString(pool.thicknessMm, 'MM'),
    },
    select: {
      id: true,
      code: true,
      widthMm: true,
      finish: { select: { kind: true, color: { select: { code: true } } } },
    },
    orderBy: { code: 'asc' },
  });
  const inPool = coils.filter((c) => attributeOf(c.finish) === pool.attribute);
  const ids = inPool.map((c) => c.id);
  if (ids.length === 0) return { availableKg: '0.000', candidates: [], autoCoilId: null };

  const [balances, reserved, mounted, quoted] = await Promise.all([
    tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: { in: ids } },
      select: { itemId: true, qty: true },
    }),
    reservedByItem(tx, InventoryItemType.COIL, ids, scope),
    findLiveStripAssignments(tx, ids),
    // Una cotización no reserva hasta confirmarse, pero una **abierta** que ya vende esa bobina
    // la tiene tomada para este fin: dos importaciones no pueden elegir sola la misma
    // (autorrevisión RF-S4b). La propia cotización no se excluye a sí misma.
    tx.quotationItem.findMany({
      where: {
        reserveItemType: InventoryItemType.COIL,
        reserveItemId: { in: ids },
        quotation: {
          status: { in: [QuotationStatus.DRAFT, QuotationStatus.EMITTED] },
          ...(scope.exceptQuotationIds?.length ? { id: { notIn: scope.exceptQuotationIds } } : {}),
        },
      },
      select: { reserveItemId: true },
    }),
  ]);
  const balanceById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
  const takenIds = new Set([
    ...mounted.map((m) => m.coilId),
    ...quoted.map((q) => q.reserveItemId),
  ]);
  const need = toDecimal(qty);

  let available = new Decimal(0);
  const candidates: CoilPoolCandidate[] = [];
  for (const coil of inPool) {
    const balance = balanceById.get(coil.id) ?? new Decimal(0);
    const free = !takenIds.has(coil.id) && (reserved.get(coil.id) ?? new Decimal(0)).lte(0);
    if (!free || balance.lte(0)) continue;
    available = available.plus(balance);
    if (balance.gte(need)) {
      candidates.push({
        coilId: coil.id,
        code: coil.code,
        widthMm: coil.widthMm.toFixed(2),
        balanceKg: toFixedString(balance, 'KG'),
      });
    }
  }
  const exact = candidates.filter((c) => toDecimal(c.balanceKg).equals(need));
  const auto = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : undefined;
  return {
    availableKg: toFixedString(available, 'KG'),
    candidates,
    autoCoilId: auto?.coilId ?? null,
  };
}
