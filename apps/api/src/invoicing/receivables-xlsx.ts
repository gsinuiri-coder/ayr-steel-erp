import type { ReceivableSummaryDto, Role } from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';
import { num } from '../reports/reports-xlsx';

/**
 * cc26 M2 (D-provisional): las columnas del Excel de «Por cliente» en /cobranzas, las de la
 * pantalla (`cobranzas-view.tsx`) con sus mismas etiquetas, más el documento del cliente, que la
 * pantalla muestra al lado del nombre.
 *
 * La ruta es solo de ADMINISTRADOR (la misma que su GET); igual, la tabla no trae costos ni
 * márgenes: ninguna columna es `adminOnly`. La fila de total suma vencido y saldo: es lo que
 * dicen las tarjetas «Vencido» y «Por cobrar» (`GET /invoicing/receivables/summary`).
 */
export const RECEIVABLE_LIST_COLUMNS: readonly ListColumn<ReceivableSummaryDto>[] = [
  { header: 'Cliente', width: 36, cell: (r) => r.customerName },
  { header: 'Documento', width: 14, cell: (r) => r.customerDocNumber },
  { header: 'Comprobantes', width: 12, cell: (r) => r.documentCount },
  // Como la pantalla: sin vencimiento con saldo, todo es al contado.
  { header: 'Vencimiento más próximo', width: 14, cell: (r) => r.nextDueDate ?? 'Contado' },
  {
    header: 'Vencido (S/)',
    width: 14,
    cell: (r) => num(r.overduePen),
    amount: (r) => r.overduePen,
  },
  {
    header: 'Saldo (S/)',
    width: 14,
    cell: (r) => num(r.balancePen),
    amount: (r) => r.balancePen,
  },
];

export function receivablesXlsx(
  rows: readonly ReceivableSummaryDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Por cliente',
    columns: RECEIVABLE_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'cliente', plural: 'clientes' },
    filename: `cobranzas-por-cliente-${today}.xlsx`,
  });
}
