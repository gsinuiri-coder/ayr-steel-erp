import * as XLSX from 'xlsx';
import { undispatchedAtClose } from './undispatched-at-close';
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

describe('facturado y no despachado al cierre (D-670)', () => {
  const report = undispatchedAtClose({
    from: '2026-09-01',
    to: '2026-09-30',
    documents: [
      doc('b', '2026-09-24'),
      doc('a', '2026-09-10'),
      doc('c', '2026-09-12'),
      doc('d', '2026-09-15', null),
      doc('e', '2026-09-20'),
    ],
    dispatches: [
      { invoiceId: 'a', dispatchDate: '2026-09-15' }, // salió en el mes: no va
      { invoiceId: 'b', dispatchDate: '2026-10-07' },
      { invoiceId: 'c', dispatchDate: '2026-10-02' },
      { invoiceId: 'c', dispatchDate: '2026-09-20' },
      { invoiceId: 'e', dispatchDate: '2026-09-30' }, // el día del cierre cuenta como dentro
    ],
  });

  it('deja solo lo que sale después del cierre o no salió, en orden de emisión', () => {
    expect(
      report.rows.map((r) => [r.number, r.status, r.dispatchDates, r.estimatedCostPen]),
    ).toEqual([
      ['F-c', 'PARCIAL', ['2026-09-20', '2026-10-02'], '700.0000'],
      ['F-d', 'SIN_SALIDA', [], null],
      ['F-b', 'DESPACHADO_DESPUES', ['2026-10-07'], '700.0000'],
    ]);
    expect(report.totals).toEqual({
      count: 3,
      salesPen: '3000.0000',
      estimatedCostPen: '1400.0000',
      withoutCostCount: 1,
    });
  });

  it('el Excel trae las mismas filas, el total y la nota', () => {
    const { buffer, filename } = undispatchedAtCloseXlsx(report);
    expect(filename).toBe('facturado-no-despachado-2026-09-01-a-2026-09-30.xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      book.Sheets['Facturado no despachado'] as XLSX.WorkSheet,
      {
        header: 1,
      },
    );
    expect(rows[1]).toEqual([
      'F-c',
      '2026-09-12',
      'ACME',
      1000,
      700,
      '2026-09-20, 2026-10-02',
      'Parte salió después del cierre',
    ]);
    expect(rows[4]).toEqual([
      'Total · 3 comprobantes',
      '',
      '',
      3000,
      1400,
      '',
      '1 sin salida (sin costo)',
    ]);
    expect(String((rows[6] as unknown[])[0])).toMatch(/No cambia ningún otro reporte/);
  });

  it('el servicio toma los comprobantes de Ventas y margen y sus despachos vivos', async () => {
    const prisma = {
      dispatch: {
        findMany: jest.fn((..._a: unknown[]) =>
          Promise.resolve([
            { invoiceId: 'x', dispatchDate: new Date('2026-10-07T00:00:00Z') },
            { invoiceId: null, dispatchDate: new Date('2026-10-07T00:00:00Z') },
          ]),
        ),
      },
    };
    const margin = {
      salesMargin: jest.fn((..._a: unknown[]) =>
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
                {
                  id: 'y',
                  number: null,
                  docType: 'BOLETA',
                  issueDate: '2026-09-26',
                  salesPen: '5',
                  costPen: null,
                },
              ],
            },
          ],
        }),
      ),
    };
    const service = new UndispatchedAtCloseService(prisma as never, margin as never);
    const r = await service.report({ from: '2026-09-01', to: '2026-09-30' });
    expect(margin.salesMargin).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-30' });
    expect(prisma.dispatch.findMany).toHaveBeenCalledWith({
      where: { invoiceId: { in: ['x', 'y'] }, status: 'ISSUED' },
      select: { invoiceId: true, dispatchDate: true },
    });
    expect(r.rows.map((row) => [row.number, row.status])).toEqual([
      ['F-1', 'DESPACHADO_DESPUES'],
      ['(sin número)', 'SIN_SALIDA'],
    ]);
  });
});
