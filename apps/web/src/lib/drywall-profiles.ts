import { BusinessLine, toDecimal, Unit, type ProductDto } from '@ayr/shared';

/**
 * D-344 — los perfiles de drywall que planta y corte pueden usar, **sacados del SKU** (ya no hay
 * receta): un perfil fabricado, activo, medido en piezas (`NIU`, D-055) y con los cuatro datos del
 * catálogo completos —espesor y ancho del fleje, largo y peso de la pieza, mayor a cero—. Sin
 * espesor o sin ancho no se sabe qué fleje consume, y sin peso no se sabe cuántos kilos gasta cada
 * pieza; el API rechaza abrir su orden.
 */
export interface DrywallProfile {
  productId: string;
  sku: string;
  name: string;
  /** Espesor del fleje, en mm. */
  thicknessMm: string;
  /** Ancho del fleje (desarrollo), en mm. */
  widthMm: string;
  pieceWeightKg: string;
}

export interface DrywallProfiles {
  /** Los que tienen todo: se ofrecen. */
  ready: DrywallProfile[];
  /** Perfiles activos a los que les falta algún dato: se avisa, no se ofrecen. */
  incomplete: ProductDto[];
}

export function isActiveDrywallProfile(p: ProductDto): boolean {
  return (
    p.isActive &&
    p.businessLineCode === BusinessLine.DRYWALL &&
    p.source === 'MANUFACTURED' &&
    p.unit === Unit.NIU
  );
}

export function drywallProfilesOf(products: readonly ProductDto[]): DrywallProfiles {
  const ready: DrywallProfile[] = [];
  const incomplete: ProductDto[] = [];
  for (const p of products) {
    if (!isActiveDrywallProfile(p)) continue;
    if (
      p.thicknessMm !== null &&
      p.widthMm !== null &&
      p.pieceWeightKg !== null &&
      toDecimal(p.pieceWeightKg).gt(0)
    ) {
      ready.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        thicknessMm: p.thicknessMm,
        widthMm: p.widthMm,
        pieceWeightKg: p.pieceWeightKg,
      });
    } else {
      incomplete.push(p);
    }
  }
  return { ready, incomplete };
}
