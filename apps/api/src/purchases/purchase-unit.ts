import { isCatalogUnit, UNIT_LABELS } from '@ayr/shared';

/**
 * cc69 (D-729): una línea de compra con producto va en la unidad del producto. El kardex del
 * producto lleva una sola unidad: una compra de ESQ30 (caja) en «UND» lo dejaría contado en NIU, y
 * con el saldo en cero el kardex lo aceptaría. Devuelve el rechazo, o `null` si coinciden. Lo usan
 * el alta (formulario, XML), el importador de compras y «Editar compra».
 */
export function purchaseUnitMismatch(
  sku: string,
  productUnit: string,
  lineUnit: string,
): string | null {
  if (productUnit === lineUnit) return null;
  return `${sku} se lleva en ${unitLabel(productUnit)} y la línea dice ${unitLabel(lineUnit)}: la unidad de la compra tiene que ser la del producto. Corrige la unidad de la línea (o la del producto, si es la que está mal).`;
}

/** «Caja (BX)»; una unidad vieja, fuera de la lista (D-723), tal como está guardada. */
function unitLabel(unit: string): string {
  return isCatalogUnit(unit) ? UNIT_LABELS[unit] : unit;
}
