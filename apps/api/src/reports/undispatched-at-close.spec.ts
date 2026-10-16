import * as XLSX from 'xlsx';
import { undispatchedAtClose, type CloseInvoiceLine } from './undispatched-at-close';
import { undispatchedAtCloseXlsx } from './undispatched-at-close-xlsx';
import { UndispatchedAtCloseService } from './undispatched-at-close.service';

const doc = (id: string, issueDate: string, costPen: string | null = '700.0000') => ({
  id,
  number: `F-${id}`,
  issueDate,
  customerName: 'ACME',
  salesPen: '1000.0000',
  costPen,
});
const line = (
  documentId: string,
  issueDate: string,
  item: string,
  qty: string,
  subtotalPen = '1000',
): CloseInvoiceLine => ({
  documentId,
  issueDate,
  number: `F-${documentId}`,
  salesOrderItemId: item,
  qty,
  subtotalPen,
});
const out = (item: string, qty: string, dispatchDate: string) => ({
  salesOrderItemId: item,
  qty,
  dispatchDate,
});

const TO = '2026-09-30';
const run = (input: Omit<Parameters<typeof undispatchedAtClose>[0], 'from' | 'to'>) =>
  undispatchedAtClose({ from: '2026-09-01', to: TO, ...input });

describe('facturado y no despachado al cierre (D-670), por cantidades', () => {
  it('salió después del cierre, con su fecha real; despachar el día del cierre cuenta como dentro', () => {
    const r = run({
      documents: [doc('a', '2026-09-24'), doc('b', '2026-09-10')],
      lines: [line('a', '2026-09-24', 'i1', '10'), line('b', '2026-09-10', 'i2', '5')],
      dispatches: [out('i1', '10', '2026-10-07'), out('i2', '5', TO)],
    });
    expect(r.rows.map((x) => [x.number, x.status, x.dispatchDates, x.estimatedCostPen])).toEqual([
      ['F-a', 'DESPACHADO_DESPUES', ['2026-10-07'], '700.0000'],
    ]);
  });

  it('un despacho del pedido sin declarar el comprobante también cuenta (D-205)', () => {
    const r = run({
      documents: [doc('a', '2026-09-24')],
      lines: [line('a', '2026-09-24', 'i1', '10')],
      dispatches: [out('i1', '10', '2026-09-26')],
    });
    expect(r.rows).toEqual([]);
  });

  it('lo despachado cubre primero lo facturado antes: la factura más nueva queda pendiente', () => {
    const r = run({
      documents: [doc('viejo', '2026-09-05'), doc('nuevo', '2026-09-20')],
      lines: [line('viejo', '2026-09-05', 'i1', '10'), line('nuevo', '2026-09-20', 'i1', '10')],
      dispatches: [out('i1', '10', '2026-09-08'), out('i1', '10', '2026-10-02')],
    });
    expect(r.rows.map((x) => [x.number, x.status])).toEqual([['F-nuevo', 'DESPACHADO_DESPUES']]);
  });

  it('lo facturado en un mes anterior suma a lo facturado hasta el cierre', () => {
    const r = run({
      documents: [doc('sep', '2026-09-20')],
      lines: [line('ago', '2026-08-20', 'i1', '10'), line('sep', '2026-09-20', 'i1', '10')],
      dispatches: [out('i1', '15', '2026-09-25')],
    });
    // Facturado 20, despachado 15: quedan 5, de la de septiembre (la más nueva).
    expect(r.rows.map((x) => [x.number, x.status, x.estimatedCostPen])).toEqual([
      ['F-sep', 'PARCIAL', '350.0000'],
    ]);
  });

  it('parcial por líneas: el costo estimado va en la proporción pendiente (por subtotal)', () => {
    const r = run({
      documents: [doc('a', '2026-09-24')],
      lines: [
        line('a', '2026-09-24', 'i1', '10', '600'),
        line('a', '2026-09-24', 'i2', '4', '400'),
      ],
      dispatches: [out('i1', '10', '2026-09-25'), out('i2', '4', '2026-10-03')],
    });
    expect(r.rows[0]).toMatchObject({
      status: 'PARCIAL',
      estimatedCostPen: '280.0000',
      dispatchDates: ['2026-10-03'],
    });
  });

  it('sin ninguna salida, sin costo o sin líneas de pedido', () => {
    const r = run({
      documents: [doc('a', '2026-09-24'), doc('nc', '2026-09-24', null), doc('serv', '2026-09-24')],
      lines: [line('a', '2026-09-24', 'i1', '10'), line('nc', '2026-09-24', 'i2', '1')],
      dispatches: [],
    });
    expect(r.rows.map((x) => [x.number, x.status, x.estimatedCostPen])).toEqual([
      ['F-a', 'SIN_SALIDA', '700.0000'],
      ['F-nc', 'SIN_SALIDA', null],
    ]);
    expect(r.totals).toEqual({
      count: 2,
      salesPen: '2000.0000',
      estimatedCostPen: '700.0000',
      withoutCostCount: 1,
    });
  });

  it('el Excel trae las mismas filas, el total y la nota', () => {
    const report = run({
      documents: [doc('a', '2026-09-24'), doc('b', '2026-09-25', null)],
      lines: [line('a', '2026-09-24', 'i1', '10'), line('b', '2026-09-25', 'i2', '1')],
      dispatches: [out('i1', '10', '2026-10-07')],
    });
    const { buffer, filename } = undispatchedAtCloseXlsx(report);
    expect(filename).toBe('facturado-no-despachado-2026-09-01-a-2026-09-30.xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['Facturado no despachado']!, {
      header: 1,
    });
    expect(rows[1]).toEqual([
      'F-a',
      '2026-09-24',
      'ACME',
      1000,
      700,
      '2026-10-07',
      'Salió después del cierre',
    ]);
    expect(rows[3]).toEqual([
      'Total · 2 comprobantes',
      '',
      '',
      2000,
      700,
      '',
      '1 sin costo estimado',
    ]);
    expect(String(rows[5]![0])).toMatch(/No cambia ningún otro reporte/);
  });

  it('el servicio lee Ventas y margen, las líneas de pedido y los despachos vivos', async () => {
    const date = (v: string) => new Date(`${v}T00:00:00Z`);
    const prisma = {
      fiscalDocumentItem: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ salesOrderItemId: 'i1' }, { salesOrderItemId: null }])
          .mockResolvedValueOnce([
            {
              documentId: 'x',
              salesOrderItemId: 'i1',
              qty: '10',
              subtotalPen: '10',
              document: { issueDate: date('2026-09-24'), number: 'F-1' },
            },
            {
              documentId: 'z',
              salesOrderItemId: null,
              qty: '1',
              subtotalPen: '1',
              document: { issueDate: date('2026-09-24'), number: null },
            },
          ]),
      },
      dispatchItem: {
        findMany: jest.fn(() =>
          Promise.resolve([
            { salesOrderItemId: 'i1', qty: '10', dispatch: { dispatchDate: date('2026-10-07') } },
          ]),
        ),
      },
    };
    const margin = {
      salesMargin: jest.fn(() =>
        Promise.resolve({
          orders: [
            {
              customerName: 'ACME',
              documents: [
                {
                  id: 'x',
                  number: 'F-1',
                  docType: 'FACTURA',
                  issueDate: '2026-09-24',
                  salesPen: '10',
                  costPen: '7',
                },
                {
                  id: 'n',
                  number: 'NC-1',
                  docType: 'NOTA_CREDITO',
                  issueDate: '2026-09-25',
                  salesPen: '-1',
                  costPen: null,
                },
              ],
            },
          ],
        }),
      ),
    };
    const service = new UndispatchedAtCloseService(prisma as never, margin as never);
    const r = await service.report({ from: '2026-09-01', to: TO });
    expect(margin.salesMargin).toHaveBeenCalledWith({ from: '2026-09-01', to: TO });
    expect(r.rows.map((row) => [row.number, row.status, row.dispatchDates])).toEqual([
      ['F-1', 'DESPACHADO_DESPUES', ['2026-10-07']],
    ]);
    // Sin comprobantes o sin líneas de pedido, no consulta más.
    const none = new UndispatchedAtCloseService(
      { fiscalDocumentItem: { findMany: jest.fn(() => Promise.resolve([])) } } as never,
      { salesMargin: jest.fn(() => Promise.resolve({ orders: [] })) } as never,
    );
    expect((await none.report({ from: '2026-09-01', to: TO })).rows).toEqual([]);
    const noItems = new UndispatchedAtCloseService(
      {
        fiscalDocumentItem: {
          findMany: jest.fn(() => Promise.resolve([{ salesOrderItemId: null }])),
        },
      } as never,
      margin as never,
    );
    expect((await noItems.report({ from: '2026-09-01', to: TO })).rows).toEqual([]);
  });
});
