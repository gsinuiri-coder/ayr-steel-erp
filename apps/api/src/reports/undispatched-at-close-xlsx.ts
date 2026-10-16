import { UNDISPATCHED_AT_CLOSE_STATUS_LABELS, type UndispatchedAtCloseDto } from '@ayr/shared';
import { build, num, TWO_DECIMALS, type Sheet } from './reports-xlsx';

/**
 * cc56 (D-670) — «Facturado y no despachado al cierre» en xlsx, del mismo DTO que la pantalla. Una
 * fila por comprobante y el total al pie; la nota dice qué es y qué no es.
 */
export function undispatchedAtCloseXlsx(report: UndispatchedAtCloseDto): {
  buffer: Buffer;
  filename: string;
} {
  const t = report.totals;
  const sheet: Sheet = {
    name: 'Facturado no despachado',
    header: [
      'Comprobante',
      'Emisión',
      'Cliente',
      'Venta sin IGV (S/)',
      'Costo estimado (S/)',
      'Salida real',
      'Estado',
    ],
    widths: [16, 11, 40, 18, 19, 24, 30],
    formats: [null, null, null, TWO_DECIMALS, TWO_DECIMALS, null, null],
    rows: [
      ...report.rows.map((r) => [
        r.number,
        r.issueDate,
        r.customerName,
        num(r.salesPen),
        num(r.estimatedCostPen),
        r.dispatchDates.join(', '),
        UNDISPATCHED_AT_CLOSE_STATUS_LABELS[r.status],
      ]),
      [
        `Total · ${String(t.count)} ${t.count === 1 ? 'comprobante' : 'comprobantes'}`,
        '',
        '',
        num(t.salesPen),
        num(t.estimatedCostPen),
        '',
        t.withoutCostCount > 0 ? `${String(t.withoutCostCount)} sin salida (sin costo)` : '',
      ],
      [],
      [
        `Facturado del ${report.from} al ${report.to} cuya mercadería sale del kardex después del ${report.to} (o todavía no sale). ` +
          'El costo estimado es el de Ventas y margen; esa mercadería todavía figura en el inventario al cierre. No cambia ningún otro reporte.',
      ],
    ],
  };
  return {
    buffer: build([sheet]),
    filename: `facturado-no-despachado-${report.from}-a-${report.to}.xlsx`,
  };
}
