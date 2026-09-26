import { BusinessLineCode, ProductBomKind, ProductSource, type Prisma } from '@prisma/client';
import { toDecimal, type NoFloorReason } from '@ayr/shared';
import type { PriceFloorCost } from './price-floor';

/**
 * D-342 — de dónde sale el costo del piso de un producto del catálogo, decidido **en un solo
 * lugar** para que la cotización, el panel de stock, el catálogo y el importador de listas no
 * puedan discrepar (D-150: dos guardrails que envejecen por separado).
 *
 * - Un producto cualquiera (trading, perfil comprado, plancha): el costo promedio de su saldo en
 *   el kardex, como siempre (D-163).
 * - **Un perfil de drywall fabricado**: el kardex no sirve —un perfil que nadie produjo todavía
 *   no tiene saldo, y el que sí lo tiene arrastra un costo histórico— así que el costo sale de su
 *   **receta**: kilos de la pieza × costo por kilo ponderado de los flejes que la receta consume
 *   (`STRIP_RECIPE`, misma cuenta por kilo que el agregado de una cobertura). Sin receta activa
 *   no hay piso, y se dice por qué.
 *
 * Lo que decide «esto es un perfil de drywall» es la línea de negocio y el origen del SKU, no un
 * subtipo: `ProductBom` es exclusivo de drywall (D-122).
 */

/** Lo que hace falta saber de un producto para decidir su costo de piso. */
export interface FloorCostProduct {
  id: string;
  source: ProductSource;
  pieceWeightKg: Prisma.Decimal | null;
  businessLine: { code: BusinessLineCode };
  businessLineId: string;
  bom: {
    isActive: boolean;
    kind: ProductBomKind;
    finishId: string;
    inputThicknessMm: Prisma.Decimal;
    inputWidthMm: Prisma.Decimal | null;
  } | null;
}

/** El `select` de Prisma con lo que `productFloorCost` lee. */
export const FLOOR_COST_SELECT = {
  id: true,
  source: true,
  pieceWeightKg: true,
  businessLineId: true,
  businessLine: { select: { code: true } },
  bom: {
    select: {
      isActive: true,
      kind: true,
      finishId: true,
      inputThicknessMm: true,
      inputWidthMm: true,
    },
  },
} satisfies Prisma.ProductSelect;

/** ¿Es un perfil de drywall fabricado, o sea, de los que llevan receta? */
export function isDrywallProfile(
  product: Pick<FloorCostProduct, 'source' | 'businessLine'>,
): boolean {
  return (
    product.source === ProductSource.MANUFACTURED &&
    product.businessLine.code === BusinessLineCode.DRYWALL
  );
}

export type ProductFloorCost = { cost: PriceFloorCost } | { noFloorReason: NoFloorReason };

/** El costo de piso de un producto, o el motivo por el que no lo tiene. */
export function productFloorCost(product: FloorCostProduct): ProductFloorCost {
  if (!isDrywallProfile(product)) return { cost: { kind: 'PRODUCT', productId: product.id } };
  const { bom } = product;
  if (
    bom === null ||
    !bom.isActive ||
    bom.kind !== ProductBomKind.DRYWALL ||
    bom.inputWidthMm === null
  ) {
    return { noFloorReason: 'NO_RECIPE' };
  }
  if (product.pieceWeightKg === null || product.pieceWeightKg.lte(0)) {
    return { noFloorReason: 'NO_PIECE_WEIGHT' };
  }
  return {
    cost: {
      kind: 'STRIP_RECIPE',
      businessLineId: product.businessLineId,
      finishId: bom.finishId,
      inputThicknessMm: bom.inputThicknessMm.toFixed(2),
      inputWidthMm: bom.inputWidthMm.toFixed(2),
      // El peso declarado **ya lleva** el 1 % de merma normal: se sugiere desde
      // `theoreticalKgPerPiece`, que usa la densidad estándar (D-165). No se suma otra vez.
      kgPerUnit: toDecimal(product.pieceWeightKg.toFixed(3)),
    },
  };
}

/**
 * El motivo **estático** de que un producto no tenga piso —el que se sabe sin mirar saldos—, o
 * `null` si no es un perfil de drywall o tiene receta y peso. Es el que viaja en `ProductDto`.
 */
export function staticNoFloorReason(product: FloorCostProduct): NoFloorReason | null {
  const result = productFloorCost(product);
  return 'noFloorReason' in result ? result.noFloorReason : null;
}
