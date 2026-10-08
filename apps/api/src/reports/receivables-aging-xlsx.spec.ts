import * as XLSX from 'xlsx';
import type { ReceivablesAgingDto } from '@ayr/shared';
import { receivablesAgingXlsx } from './receivables-aging-xlsx';

/** cc25 (M3): el Excel de cuentas por cobrar dice lo mismo que la pantalla. */

const SELLER = '00000000-0000-4000-8000-000000000051';

const REPORT: ReceivablesAgingDto = {
  asOf: '2026-10-05',
  sellerId: null,
  sellers: [{ id: SELLER, name: 'Vendedora Uno' }],
  customers: [
    {
      customerId: '00000000-0000-4000-8000-0000000000a1',
      customerName: 'Cliente A',
      customerDocNumber: '20100000001',
      documentCount: 2,
      balancePen: '1500.0000',
      buckets: {
        CURRENT: '0.0000',
        D1_30: '1000.0000',
        D31_60: '500.0000',
        D61_90: '0.0000',
        OVER_90: '0.0000',
      },
      documents: [
        {
          id: '00000000-0000-4000-9000-000000000001',
          docType: 'FACTURA',
          number: 'F001-00000001',
          issueDate: '2026-08-01',
          paymentTerms: 'CONTADO',
          dueDate: null,
          agingDate: '2026-08-01',
          daysOverdue: 65,
          bucket: 'D61_90',
          totalPen: '500.0000',
          paidPen: '0.0000',
          creditedPen: '0.0000',
          balancePen: '500.0000',
          salesOrderId: null,
          salesOrderCode: null,
          sellerId: SELLER,
          sellerName: 'Vendedora Uno',
        },
        {
          id: '00000000-0000-4000-9000-000000000002',
          docType: 'FACTURA',
          number: 'F001-00000002',
          issueDate: '2026-09-01',
          paymentTerms: 'CREDITO',
          dueDate: '2026-09-20',
          agingDate: '2026-09-20',
          daysOverdue: 15,
          bucket: 'D1_30',
          totalPen: '1180.0000',
          paidPen: '100.0000',
          creditedPen: '80.0000',
          balancePen: '1000.0000',
          salesOrderId: '00000000-0000-4000-8000-000000000123',
          salesOrderCode: 'PED-000123',
          sellerId: SELLER,
          sellerName: 'Vendedora Uno',
        },
      ],
    },
  ],
  totals: {
    balancePen: '1500.0000',
    buckets: {
      CURRENT: '0.0000',
      D1_30: '1000.0000',
      D31_60: '500.0000',
      D61_90: '0.0000',
      OVER_90: '0.0000',
    },
    documentCount: 2,
    customerCount: 1,
  },
};

function rowsOf(buffer: Buffer, sheet: string): unknown[][] {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const ws = book.Sheets[sheet];
  if (!ws) throw new Error(`falta la hoja ${sheet}`);
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
}

describe('receivablesAgingXlsx', () => {
  it('la hoja por cliente lleva los tramos como número y la fila de total', () => {
    const { buffer, filename } = receivablesAgingXlsx(REPORT);
    expect(filename).toBe('cuentas-por-cobrar-2026-10-05.xlsx');
    const rows = rowsOf(buffer, 'Por cliente');
    expect(rows[0]).toEqual([
      'Cliente',
      'Documento',
      'Comprobantes',
      'Por vencer (S/)',
      '1–30 días (S/)',
      '31–60 días (S/)',
      '61–90 días (S/)',
      'Más de 90 días (S/)',
      'Saldo (S/)',
    ]);
    expect(rows[1]).toEqual(['Cliente A', '20100000001', 2, 0, 1000, 500, 0, 0, 1500]);
    expect(rows[2]).toEqual(['Total al 2026-10-05', undefined, 2, 0, 1000, 500, 0, 0, 1500]);
  });

  it('el detalle por comprobante suma el saldo total y dice «Contado» sin vencimiento', () => {
    const rows = rowsOf(receivablesAgingXlsx(REPORT).buffer, 'Comprobantes').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[7])).toEqual(['Contado', '2026-09-20']);
    expect(rows.reduce((acc: number, r) => acc + Number(r[13]), 0)).toBe(1500);
    expect(rows[1]?.[4]).toBe('PED-000123');
  });

  it('D-537 (cc33 N8): un CREDITO sin vencimiento dice «Crédito sin vencimiento», no «Contado»', () => {
    const [customer] = REPORT.customers;
    const [first] = customer?.documents ?? [];
    if (!customer || !first) throw new Error('fixture');
    const report: ReceivablesAgingDto = {
      ...REPORT,
      customers: [{ ...customer, documents: [{ ...first, paymentTerms: 'CREDITO' }] }],
    };
    const rows = rowsOf(receivablesAgingXlsx(report).buffer, 'Comprobantes').slice(1);
    expect(rows[0]?.[7]).toBe('Crédito sin vencimiento');
  });

  it('con vendedor, la fila de total lo nombra', () => {
    const rows = rowsOf(
      receivablesAgingXlsx({ ...REPORT, sellerId: SELLER }).buffer,
      'Por cliente',
    );
    expect(rows[2]?.[0]).toBe('Total al 2026-10-05 (vendedor: Vendedora Uno)');
  });
});
