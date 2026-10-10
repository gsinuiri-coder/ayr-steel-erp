import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  type ReceivablesAgingDto,
  noDueDateLabel,
} from '@ayr/shared';
import { build, num, type Sheet } from './reports-xlsx';

/**
 * cc25 (D-426, M3). Cuentas por cobrar en xlsx, del **mismo DTO** que la pantalla y con el
 * mismo filtro de vendedor. Dos hojas: por cliente con sus tramos y una fila de total, y el
 * detalle por comprobante aparte, para poder ordenarlo y filtrarlo sin romper la otra.
 *
 * cc40 (D-588): `notes` son las filas que dicen la búsqueda de la pantalla (`searchNoteRows`),
 * al pie de la hoja principal; el DTO ya llega recortado (`report-xlsx-search.ts`).
 */
export function receivablesAgingXlsx(
  report: ReceivablesAgingDto,
  notes: (string | number | null)[][] = [],
): {
  buffer: Buffer;
  filename: string;
} {
  const sellerName =
    report.sellerId === null
      ? null
      : (report.sellers.find((s) => s.id === report.sellerId)?.name ?? 'vendedor filtrado');
  const bucketHeaders = AGING_BUCKETS.map((b) => `${AGING_BUCKET_LABELS[b]} (S/)`);

  const customers: Sheet = {
    name: 'Por cliente',
    header: ['Cliente', 'Documento', 'Comprobantes', ...bucketHeaders, 'Saldo (S/)'],
    widths: [36, 14, 13, ...AGING_BUCKETS.map(() => 15), 15],
    rows: [
      ...report.customers.map((c) => [
        c.customerName,
        c.customerDocNumber,
        c.documentCount,
        ...AGING_BUCKETS.map((b) => num(c.buckets[b])),
        num(c.balancePen),
      ]),
      [
        sellerName === null
          ? `Total al ${report.asOf}`
          : `Total al ${report.asOf} (vendedor: ${sellerName})`,
        null,
        report.totals.documentCount,
        ...AGING_BUCKETS.map((b) => num(report.totals.buckets[b])),
        num(report.totals.balancePen),
      ],
      ...notes,
    ],
  };

  const documents: Sheet = {
    name: 'Comprobantes',
    header: [
      'Cliente',
      'Documento',
      'Tipo',
      'Comprobante',
      'Pedido',
      'Vendedor',
      'Emisión',
      'Vence',
      'Días vencido',
      'Tramo',
      'Total (S/)',
      'Cobrado (S/)',
      'Notas de crédito (S/)',
      'Saldo (S/)',
    ],
    widths: [36, 14, 10, 16, 12, 22, 11, 11, 12, 15, 13, 13, 18, 13],
    rows: report.customers.flatMap((c) =>
      c.documents.map((d) => [
        c.customerName,
        c.customerDocNumber,
        FISCAL_DOC_TYPE_LABELS[d.docType],
        d.number,
        d.salesOrderCode,
        d.sellerName,
        d.issueDate,
        // D-428: al contado vence al emitir; la columna lo dice en vez de repetir la fecha. D-537:
        // un crédito sin vencimiento se rotula como tal, no como contado.
        d.dueDate ?? noDueDateLabel(d.paymentTerms),
        d.daysOverdue,
        AGING_BUCKET_LABELS[d.bucket],
        num(d.totalPen),
        num(d.paidPen),
        num(d.creditedPen),
        num(d.balancePen),
      ]),
    ),
  };

  return {
    buffer: build([customers, documents]),
    filename: `cuentas-por-cobrar-${report.asOf}.xlsx`,
  };
}
