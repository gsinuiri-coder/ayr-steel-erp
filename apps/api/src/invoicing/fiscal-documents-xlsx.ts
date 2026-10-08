import {
  FISCAL_DOC_TYPE_LABELS,
  FISCAL_DOCUMENT_ORIGIN_LABELS,
  FISCAL_DOCUMENT_STATUS_LABELS,
  type FiscalDocumentListItemDto,
  type Role,
  noDueDateLabel,
} from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';
import { num } from '../reports/reports-xlsx';

/**
 * cc26 (D-provisional): las columnas del Excel de la lista de comprobantes, las de la pantalla
 * (`comprobantes-view.tsx`) con sus mismas etiquetas. Lo que la pantalla dice con un badge o
 * debajo del número va en su propia columna, para poder filtrarlo en la hoja: el pedido, el
 * vencido y el origen.
 *
 * La lista no trae costos ni márgenes (`FiscalDocumentListItemDto`): ninguna columna es
 * `adminOnly` y los dos roles reciben las mismas. El alcance del vendedor ya lo aplicó la consulta.
 *
 * El total suma las columnas tal como se muestran: una nota de crédito suma su importe como
 * cualquier otra fila, igual que se ve en la pantalla (cc26, D-provisional).
 */
export const FISCAL_DOCUMENT_LIST_COLUMNS: readonly ListColumn<FiscalDocumentListItemDto>[] = [
  // Un borrador todavía no tiene número (D-072): se dice, no se finge.
  { header: 'Número', width: 16, cell: (d) => d.number ?? 'Borrador' },
  { header: 'Pedido', width: 12, cell: (d) => d.salesOrderCode ?? '' },
  { header: 'Tipo', width: 18, cell: (d) => FISCAL_DOC_TYPE_LABELS[d.docType] },
  { header: 'Cliente', width: 36, cell: (d) => d.customerName },
  { header: 'Documento', width: 14, cell: (d) => d.customerDocNumber },
  { header: 'Emisión', width: 12, cell: (d) => d.issueDate },
  // D-537 (cc33 N8): como la pantalla, un crédito sin vencimiento no es «Contado».
  { header: 'Vencimiento', width: 12, cell: (d) => d.dueDate ?? noDueDateLabel(d.paymentTerms) },
  { header: 'Vencido', width: 9, cell: (d) => (d.isOverdue ? 'Sí' : '') },
  { header: 'Despacho', width: 22, cell: dispatchCell },
  {
    header: 'Total (S/)',
    width: 14,
    cell: (d) => num(d.totalPen),
    amount: (d) => d.totalPen,
  },
  {
    header: 'Saldo (S/)',
    width: 14,
    cell: (d) => num(d.balancePen),
    amount: (d) => d.balancePen,
  },
  { header: 'Estado', width: 24, cell: (d) => FISCAL_DOCUMENT_STATUS_LABELS[d.status] },
  { header: 'Origen', width: 18, cell: (d) => FISCAL_DOCUMENT_ORIGIN_LABELS[d.origin] },
];

/**
 * Correcciones 05 / M5 y D-205, como en la pantalla: el despacho declarado; sin él, los del
 * pedido rotulados como tales; sin ninguno, vacío.
 */
function dispatchCell(d: FiscalDocumentListItemDto): string {
  const own = d.invoicedDispatches ?? [];
  if (own.length > 0) return own.map((x) => x.code).join(', ');
  const ofOrder = d.orderDispatches ?? [];
  if (ofOrder.length > 0) return `Del pedido: ${ofOrder.map((x) => x.code).join(', ')}`;
  return '';
}

export function fiscalDocumentsXlsx(
  rows: readonly FiscalDocumentListItemDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Comprobantes',
    columns: FISCAL_DOCUMENT_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'comprobante', plural: 'comprobantes' },
    filename: `comprobantes-${today}.xlsx`,
  });
}
