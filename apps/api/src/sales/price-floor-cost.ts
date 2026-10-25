import { BusinessLineCode, ProductSource, type Prisma } from '@prisma/client';
import { toDecimal, type NoFloorReason } from '@ayr/shared';
import { drywallStripSpec } from '../common/drywall-strip';
import type { PriceFloorCost } from './price-floor';

/**
 * D-342/D-344 — de dónde sale el costo del piso de un producto del catálogo, decidido **en un
 * solo lugar** para que la cotización, el panel de stock, el catálogo y el importador de listas
 * no puedan discrepar (D-150: dos guardrails que envejecen por separado).
 *
 * - Un producto cualquiera (trading, perfil comprado, plancha): el costo promedio de su saldo en
 *   el kardex, como siempre (D-163).
 * - **Un perfil de drywall fabricado sin saldo**: un perfil que nadie produjo todavía no tiene
 *   costo en el kardex, así que el costo sale de su **SKU**: kilos de la pieza × costo por kilo ponderado de los flejes galvanizados de su
 *   espesor y su ancho (`STRIP_SKU`, misma cuenta por kilo que el agregado de una cobertura).
 *   Desde D-344 no hay receta: el espesor y el ancho del fleje son datos del SKU.
 *   **D-713 (dw-03):** si el perfil sí tiene saldo en el kardex (fabricado o de la carga inicial),
 *   manda el costo promedio de ese saldo; los flejes quedan para el perfil sin saldo. Lo decide
 *   `computePriceFloors` al leer saldos: aquí solo se arma el costo `STRIP_SKU` con el producto.
 *
 * Lo que decide «esto es un perfil de drywall» es la línea de negocio y el origen del SKU, no un
 * subtipo.
 */

/** Lo que hace falta saber de un producto para decidir su costo de piso. */
export interface FloorCostProduct {
  id: string;
  source: ProductSource;
  pieceWeightKg: Prisma.Decimal | null;
  /** D-344: en drywall, el espesor **del fleje**. */
  thicknessMm: Prisma.Decimal | null;
  /** D-344: en drywall, el ancho **del fleje** (desarrollo). */
  widthMm: Prisma.Decimal | null;
  businessLine: { code: BusinessLineCode };
  businessLineId: string;
}

/** El `select` de Prisma con lo que `productFloorCost` lee. */
export const FLOOR_COST_SELECT = {
  id: true,
  source: true,
  pieceWeightKg: true,
  thicknessMm: true,
  widthMm: true,
  businessLineId: true,
  businessLine: { select: { code: true } },
} satisfies Prisma.ProductSelect;

/** ¿Es un perfil de drywall fabricado, o sea, de los que se producen desde un fleje? */
export function isDrywallProfile(
  product: Pick<FloorCostProduct, 'source' | 'businessLine'>,
): boolean {
  return (
    product.source === ProductSource.MANUFACTURED &&
    product.businessLine.code === BusinessLineCode.DRYWALL
  );
}

export type ProductFloorCost =
  | {
      cost: PriceFloorCost;
      /**
       * D-713: un perfil al que le falta espesor, ancho o peso en el SKU no puede costearse por
       * flejes, pero si tiene saldo su piso sale del kardex (`PROFILE_STOCK`), y
       * este es el motivo que se muestra cuando, además, no tiene saldo.
       */
      noStockReason?: NoFloorReason;
    }
  | { noFloorReason: NoFloorReason };

/** El costo de piso de un producto, o el motivo por el que no lo tiene. */
export function productFloorCost(product: FloorCostProduct): ProductFloorCost {
  if (!isDrywallProfile(product)) return { cost: { kind: 'PRODUCT', productId: product.id } };
  const strip = drywallStripSpec(product);
  if ('noFloorReason' in strip) {
    return {
      cost: { kind: 'PROFILE_STOCK', productId: product.id },
      noStockReason: strip.noFloorReason,
    };
  }
  if (product.pieceWeightKg === null || product.pieceWeightKg.lte(0)) {
    return {
      cost: { kind: 'PROFILE_STOCK', productId: product.id },
      noStockReason: 'NO_PIECE_WEIGHT',
    };
  }
  return {
    cost: {
      kind: 'STRIP_SKU',
      productId: product.id,
      businessLineId: product.businessLineId,
      thicknessMm: strip.thicknessMm,
      widthMm: strip.widthMm,
      // El peso declarado **ya lleva** el 1 % de merma normal: se sugiere desde
      // `theoreticalKgPerPiece`, que usa la densidad estándar (D-165). No se suma otra vez.
      kgPerUnit: toDecimal(product.pieceWeightKg.toFixed(3)),
    },
  };
}

/**
 * El motivo **estático** de que un producto no tenga piso —el que se sabe sin mirar saldos—, o
 * `null` si no es un perfil de drywall o su SKU trae espesor, ancho y peso. Es el que viaja en
 * `ProductDto`.
 */
export function staticNoFloorReason(product: FloorCostProduct): NoFloorReason | null {
  const result = productFloorCost(product);
  return 'noFloorReason' in result ? result.noFloorReason : (result.noStockReason ?? null);
}

/**
 * D-713: el motivo de un producto que salió **sin** piso de `computePriceFloorOutcomes`. Primero el
 * dato que le falta al SKU (lo que el dueño tiene que cargar); si no le falta nada, en un perfil
 * costeado por flejes, la falta de flejes o de margen; en cualquier otro, ninguno.
 */
export function missingFloorReason(
  floorCost: Extract<ProductFloorCost, { cost: PriceFloorCost }>,
  outcome: 'NO_COST' | 'NO_MARGIN',
): NoFloorReason | null {
  if (floorCost.noStockReason !== undefined) return floorCost.noStockReason;
  return floorCost.cost.kind === 'STRIP_SKU' ? stripSkuNoFloorReason(outcome) : null;
}

/**
 * D-344: por qué un candidato con costo por SKU **no** salió con piso, cuando `computePriceFloors`
 * lo omitió. Antes de esto se decía siempre «sin costo de flejes», aunque la causa fuera que la
 * línea no tiene margen configurado.
 */
export function stripSkuNoFloorReason(outcome: 'NO_COST' | 'NO_MARGIN'): NoFloorReason {
  return outcome === 'NO_MARGIN' ? 'NO_MARGIN' : 'NO_COMPATIBLE_STRIPS';
}
