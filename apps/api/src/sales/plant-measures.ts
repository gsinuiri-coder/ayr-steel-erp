import { finishRal, toDecimal } from '@ayr/shared';

/** Lo que la hoja de planta necesita saber de un producto para describir su material. */
export interface PlantMeasuresProduct {
  thicknessMm: string | null;
  widthMm: string | null;
  lengthMm: string | null;
  color: { name: string } | null;
  finish: { code: string; name: string } | null;
}

/**
 * La columna «Medidas» de la hoja de planta (D-149): lo que decide qué bobina se monta.
 *
 * Espesor y ancho, el largo fijo si es una plancha de catálogo (D-127), y el **color
 * comercial** — que es lo que empareja con la bobina (D-270). El RAL del acabado del producto
 * va como preferencia, no como exigencia: planta puede montar otro RAL del mismo color, pero
 * el que se vendió es este y el selector lo ofrece primero (D-271).
 */
export function plantLineMeasures(product: PlantMeasuresProduct): string {
  const ral = product.finish === null ? null : finishRal(product.finish);
  const color =
    product.color === null
      ? null
      : ral === null
        ? product.color.name
        : `${product.color.name}, de preferencia RAL ${ral}`;
  const measures = [
    product.thicknessMm === null ? null : `${product.thicknessMm} mm`,
    product.widthMm === null ? null : `${product.widthMm} mm de ancho`,
    product.lengthMm === null
      ? null
      : `largo fijo ${toDecimal(product.lengthMm).div(1000).toFixed(2)} m`,
    color,
  ].filter((v): v is string => v !== null);
  return measures.length === 0 ? '—' : measures.join(' · ');
}
