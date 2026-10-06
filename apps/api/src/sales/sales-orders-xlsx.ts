import { ORDER_STAGE_LABELS, type Role, type SalesOrderListItemDto } from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';
import { num } from '../reports/reports-xlsx';

/**
 * cc26 M2 (D-provisional): las columnas del Excel de la lista de pedidos, las de la pantalla
 * (`pedidos-view.tsx`) con sus mismas etiquetas, más el documento del cliente, que la pantalla
 * muestra al lado del nombre.
 *
 * La lista no trae costos ni márgenes (`SalesOrderListItemDto`: el total de venta, que el
 * vendedor ve para trabajar): ninguna columna es `adminOnly` y los dos roles reciben las mismas.
 * El alcance del vendedor ya lo aplicó la consulta.
 */
export const SALES_ORDER_LIST_COLUMNS: readonly ListColumn<SalesOrderListItemDto>[] = [
  { header: 'Código', width: 12, cell: (o) => o.code },
  { header: 'Cliente', width: 36, cell: (o) => o.customerName },
  { header: 'Documento', width: 14, cell: (o) => o.customerDocNumber },
  // Como la pantalla: sin cotización, el pedido es «Directo».
  { header: 'Cotización', width: 12, cell: (o) => o.quotationCode ?? 'Directo' },
  { header: 'Comprobante', width: 24, cell: documentsCell },
  { header: 'Fecha', width: 12, cell: (o) => o.issueDate },
  {
    header: 'Total (S/)',
    width: 14,
    cell: (o) => num(o.totalPen),
    amount: (o) => o.totalPen,
  },
  { header: 'Reservas activas', width: 10, cell: (o) => o.activeReservations },
  // D-277: el estado que se muestra (el persistido más «Listo»), como `OrderStageBadge`.
  { header: 'Estado', width: 16, cell: (o) => ORDER_STAGE_LABELS[o.stage] },
];

/**
 * Los comprobantes vivos (Correcciones 05 / M4), todos y no «+N», con la nota de crédito marcada
 * como en `OrderDocumentLinks`.
 */
function documentsCell(o: SalesOrderListItemDto): string {
  return (o.documents ?? [])
    .map((d) => {
      const number = d.number ?? 'Sin número';
      return d.docType === 'NOTA_CREDITO' ? `${number} (NC)` : number;
    })
    .join(', ');
}

export function salesOrdersXlsx(
  rows: readonly SalesOrderListItemDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Pedidos',
    columns: SALES_ORDER_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'pedido', plural: 'pedidos' },
    filename: `pedidos-${today}.xlsx`,
  });
}
