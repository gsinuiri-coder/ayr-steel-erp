import {
  QUOTATION_STATUS_LABELS,
  quotationInvoiceState,
  type QuotationListItemDto,
  type Role,
} from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';
import { num } from '../reports/reports-xlsx';

/**
 * cc26 (D-provisional): las columnas del Excel de la lista de cotizaciones, las de la pantalla
 * (`cotizaciones-view.tsx`) con sus mismas etiquetas, más el documento del cliente, que la
 * pantalla muestra al lado del nombre.
 *
 * La lista no trae costos ni márgenes (`QuotationListItemDto`: precios de venta, que el vendedor
 * ve para trabajar): ninguna columna es `adminOnly` y los dos roles reciben las mismas. El
 * alcance del vendedor ya lo aplicó la consulta.
 */
export const QUOTATION_LIST_COLUMNS: readonly ListColumn<QuotationListItemDto>[] = [
  { header: 'Código', width: 12, cell: (q) => q.code },
  { header: 'Comprobante', width: 24, cell: invoiceCell },
  { header: 'Cliente', width: 36, cell: (q) => q.customerName },
  { header: 'Documento', width: 14, cell: (q) => q.customerDocNumber },
  { header: 'Emisión', width: 12, cell: (q) => q.issueDate },
  // D-157: `null` es «no vence», no «falta el dato».
  { header: 'Vigencia', width: 16, cell: (q) => q.validUntil ?? 'Sin vencimiento' },
  {
    header: 'Total (S/)',
    width: 14,
    cell: (q) => num(q.totalPen),
    amount: (q) => q.totalPen,
  },
  { header: 'Estado', width: 12, cell: statusCell },
  { header: 'Pedido', width: 12, cell: (q) => q.salesOrderCode ?? '' },
];

/**
 * D-387, como la columna de la pantalla (`QuotationInvoice`), en texto: lo que allí dicen el gris,
 * el ícono y el tooltip va escrito. Con varios comprobantes vigentes van todos, no «+N».
 */
function invoiceCell(q: QuotationListItemDto): string {
  const state = quotationInvoiceState(q.externalInvoice, q.invoiceDocuments);
  switch (state.kind) {
    case 'NONE':
      return '';
    case 'REFERENCE':
      return `${state.reference} (solo referencia)`;
    case 'REGISTERED':
      return state.documents.map((d) => d.number).join(', ');
    case 'MISMATCH':
      return `${state.documents.map((d) => d.number).join(', ')} (Excel: ${state.reference})`;
  }
}

/** Como `QuotationStatusBadge`: una emitida ya vencida que el job no marcó se dice «Vencida». */
function statusCell(q: QuotationListItemDto): string {
  return q.status === 'EMITTED' && q.isExpired ? 'Vencida' : QUOTATION_STATUS_LABELS[q.status];
}

export function quotationsXlsx(
  rows: readonly QuotationListItemDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Cotizaciones',
    columns: QUOTATION_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'cotización', plural: 'cotizaciones' },
    filename: `cotizaciones-${today}.xlsx`,
  });
}
