/**
 * Lo que manda una anulación o una reversa (D-124): el motivo obligatorio (RF-95) y la
 * fecha de operación de **la propia reversa**, que por defecto es hoy y jamás hereda la del
 * hecho que corrige.
 *
 * Vive acá y no repetido en cada vista porque son una docena de mutaciones con la misma
 * forma, y una que se olvide del segundo campo deja al administrador sin poder fechar esa
 * anulación sin ningún error visible.
 */
export interface ReverseArgs {
  reason: string;
  operationDate: string | undefined;
}
