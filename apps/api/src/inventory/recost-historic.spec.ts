import { Decimal } from '@ayr/shared';
import {
  comparePreviews,
  diff,
  monthlyDeltas,
  renderHistoricPreview,
  type HistoricPreview,
} from './recost-historic';

const d = (v: string) => new Decimal(v);

function preview(overrides: Partial<HistoricPreview> = {}): HistoricPreview {
  return {
    branch: 'local',
    generatedAt: '2026-10-14 (Lima)',
    skus: ['SKU-A'],
    adjustments: 2,
    rowsReplayed: 10,
    months: monthlyDeltas([
      { item: 'SKU-A', operationDate: '2026-09-03', type: 'OUT', refType: 'SALE', delta: d('10') },
      { item: 'SKU-A', operationDate: '2026-10-07', type: 'OUT', refType: 'SALE', delta: d('-4') },
    ]),
    documents: [
      {
        number: 'F001-1',
        issueDate: '2026-09-03',
        salesPen: '100',
        costBefore: '50',
        costAfter: '60',
        profitBefore: '50',
        profitAfter: '40',
        marginBefore: '50.00',
        marginAfter: '40.00',
      },
    ],
    salesMargin: [{ label: '2026-09 costo', before: '50', after: '60' }],
    inventory: [{ label: 'SKU-A', before: '100', after: '94' }],
    residual: 0,
    ...overrides,
  };
}

describe('monthlyDeltas (D-651)', () => {
  it('separa costo de venta del resto, con el signo del costo', () => {
    const rows = monthlyDeltas([
      { item: 'B', operationDate: '2026-09-01', type: 'OUT', refType: 'SALE', delta: d('5') },
      { item: 'B', operationDate: '2026-09-02', type: 'IN', refType: 'SALE', delta: d('2') },
      { item: 'B', operationDate: '2026-09-03', type: 'OUT', refType: 'PRODUCTION', delta: d('7') },
      {
        item: 'A',
        operationDate: '2026-10-01',
        type: 'IN',
        refType: 'SALES_RETURN',
        delta: d('1'),
      },
    ]);
    expect(
      rows.map((r) => [r.item, r.month, r.costOfSales.toFixed(2), r.other.toFixed(2), r.rows]),
    ).toEqual([
      ['A', '2026-10', '-1.00', '0.00', 1],
      ['B', '2026-09', '3.00', '7.00', 3],
    ]);
  });
});

describe('vista previa (D-651)', () => {
  it('arma las cuatro tablas', () => {
    const md = renderHistoricPreview(preview());
    expect(md).toContain('| SKU-A | 2026-09 | 10.00 |');
    expect(md).toContain('| F001-1 | 2026-09-03 | 100.00 | 50.00 | 60.00 |');
    expect(md).toContain('| 2026-09 costo | 50.00 | 60.00 | 10.00 |');
    expect(md).toContain('| SKU-A | 100.00 | 94.00 | -6.00 |');
    expect(diff('1', '1.5')).toBe('0.50');
  });

  it('compara al céntimo y avisa de lo distinto, lo nuevo y el residuo', () => {
    expect(comparePreviews(preview(), preview())).toEqual([]);
    const changed = preview({
      inventory: [{ label: 'SKU-A', before: '100', after: '93.99' }],
      salesMargin: [
        { label: '2026-09 costo', before: '50', after: '60' },
        { label: '2026-10 costo', before: '1', after: '1' },
      ],
      residual: 1,
    });
    expect(comparePreviews(preview(), changed)).toEqual([
      'inventario SKU-A: esperado 94.00, quedó 93.99',
      'margen 2026-10 costo: no estaba en la vista previa',
      'residuo 1 (debe ser 0)',
    ]);
  });
});
