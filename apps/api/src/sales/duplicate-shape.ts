import { detailsLengths, isAccessory, type DetailsLengthsProductLike } from '@ayr/shared';

/** Cómo quedó cotizada una línea: lo que un duplicado copia tal cual. */
export interface QuotedLineShape {
  unit: string;
  hasPieces: boolean;
  hasPiecesHint: boolean;
}

/**
 * D-348: ¿el producto cambió de forma desde que se cotizó la línea? Devuelve **qué** cambió, en
 * español y listo para el rechazo, o `null` si la línea se puede copiar tal cual. Solo mira lo
 * que el duplicado no puede adaptar solo: la unidad (la cantidad dejaría de significar lo mismo),
 * el desglose de largos que pasa a sobrar o a faltar (D-343, `detailsLengths`) y las piezas
 * informativas, que solo lleva un accesorio.
 */
export function duplicateShapeChange(
  line: QuotedLineShape,
  product: DetailsLengthsProductLike,
): string | null {
  if (line.unit !== product.unit) {
    return `cambió de unidad (se cotizó en ${line.unit}, hoy se vende en ${product.unit})`;
  }
  const needsPieces = detailsLengths(product);
  if (line.hasPieces && !needsPieces) {
    return isAccessory(product)
      ? 'pasó a ser un accesorio (sin detalle de largos) y la línea se cotizó con largos'
      : 'dejó de llevar detalle de largos y la línea se cotizó con largos';
  }
  if (!line.hasPieces && needsPieces) {
    return 'pasó a llevar detalle de largos y la línea se cotizó sin ellos';
  }
  if (line.hasPiecesHint && !isAccessory(product)) {
    return 'dejó de ser un accesorio y la línea lleva piezas informativas de accesorio';
  }
  return null;
}
