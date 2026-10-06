import {
  BUSINESS_LINE_LABELS,
  PURCHASE_STATUS_LABELS,
  PURCHASE_TYPE_LABELS,
  toDecimal,
  toFixedString,
  type PurchaseListItemDto,
  type Role,
} from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';
import { num } from '../reports/reports-xlsx';

/**
 * cc26 M2 (D-provisional): las columnas del Excel de la lista de compras, las de la pantalla
 * (`compras-view.tsx`) con sus mismas etiquetas.
 *
 * **Lectura conservadora, provisional:** los importes de una compra son costo de compra. La
 * pantalla se los muestra también al SUPERVISOR_PLANTA, pero la regla del dueño para los Excel
 * de listas (D-438: nunca costos ni márgenes para quien no es ADMINISTRADOR) manda sobre «lo que
 * la pantalla muestra»: en el archivo, toda columna de importe es `adminOnly`. El supervisor
 * recibe las filas (comprobante, proveedor, línea, tipo, fechas, estado) sin montos.
 *
 * **Moneda.** La pantalla muestra el total y el saldo en la moneda de cada compra; sumar soles
 * con dólares no es un total. Esas dos columnas van en su moneda y no suman; la fila de total
 * suma las dos en soles: el total en soles que la compra ya guarda (`totalPen`, a su TC) y el
 * saldo a su propio TC, la misma cuenta del estado de cuenta del proveedor (D-039).
 */
export const PURCHASE_LIST_COLUMNS: readonly ListColumn<PurchaseListItemDto>[] = [
  { header: 'Comprobante', width: 18, cell: (p) => p.documentLabel },
  { header: 'Proveedor', width: 36, cell: (p) => p.supplierName },
  { header: 'Línea', width: 14, cell: (p) => BUSINESS_LINE_LABELS[p.businessLine] },
  { header: 'Tipo', width: 18, cell: (p) => PURCHASE_TYPE_LABELS[p.type] },
  { header: 'Emisión', width: 12, cell: (p) => p.issueDate },
  { header: 'Vence', width: 12, cell: (p) => p.dueDate ?? '' },
  { header: 'Moneda', width: 8, cell: (p) => p.currency, adminOnly: true },
  { header: 'Total', width: 14, cell: (p) => num(p.total), adminOnly: true },
  { header: 'Saldo', width: 14, cell: (p) => num(p.balance), adminOnly: true },
  {
    header: 'Total (S/)',
    width: 14,
    cell: (p) => num(p.totalPen),
    amount: (p) => p.totalPen,
    adminOnly: true,
  },
  {
    header: 'Saldo (S/)',
    width: 14,
    cell: (p) => num(balancePen(p)),
    amount: balancePen,
    adminOnly: true,
  },
  { header: 'Estado', width: 12, cell: (p) => PURCHASE_STATUS_LABELS[p.status] },
];

/** El saldo en soles a su propio TC, como `supplierStatement` (D-039). */
export function balancePen(p: PurchaseListItemDto): string {
  return toFixedString(toDecimal(p.balance).times(toDecimal(p.exchangeRate)), 'MONEY');
}

export function purchasesXlsx(
  rows: readonly PurchaseListItemDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Compras',
    columns: PURCHASE_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'compra', plural: 'compras' },
    filename: `compras-${today}.xlsx`,
  });
}
