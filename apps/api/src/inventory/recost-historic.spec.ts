import { Decimal } from '@ayr/shared';
import {
  comparePreviews,
  DIRTY_SUFFIX,
  diff,
  monthlyDeltas,
  PREVIEW_MAX_AGE_HOURS,
  previewRejection,
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
      'inventario SKU-A: esperado -6.00, quedó -6.01',
      'margen 2026-10 costo: no estaba en la vista previa',
      'residuo 1 (debe ser 0)',
    ]);
  });

  it('cc54: una venta entre el dry-run y la ejecución no cuenta como diferencia', () => {
    // Otra venta movió el costo del mes y el inventario; lo que suma el recosteo es lo mismo.
    const later = preview({
      inventory: [{ label: 'SKU-A', before: '80', after: '74' }],
      salesMargin: [{ label: '2026-09 costo', before: '70', after: '80' }],
    });
    expect(comparePreviews(preview(), later)).toEqual([]);
  });
});

describe('cc54 (P2-6 de cc53, D-653): candado de --execute', () => {
  const sha = 'a'.repeat(40);
  const at = new Date('2026-10-15T15:00:00.000Z');
  const fresh = () =>
    preview({ gitSha: sha, generatedAtIso: new Date(at.getTime() - 3_600_000).toISOString() });

  it('acepta la vista previa de la misma rama, del mismo commit y de menos de 2 h', () => {
    expect(PREVIEW_MAX_AGE_HOURS).toBe(2);
    expect(previewRejection(fresh(), { branch: 'local', gitSha: sha, at })).toBeNull();
  });

  it('rechaza sin vista previa, de otra rama, sin commit, de otro commit o vieja', () => {
    const now = { branch: 'local', gitSha: sha, at };
    expect(previewRejection(null, now)).toMatch(/No hay vista previa/);
    expect(previewRejection(fresh(), { ...now, branch: 'production' })).toMatch(/es de local/);
    expect(previewRejection(preview(), now)).toMatch(/no dice con qué commit/);
    expect(previewRejection(fresh(), { ...now, gitSha: 'b'.repeat(40) })).toMatch(
      /commit aaaaaaaa/,
    );
    const old = preview({
      gitSha: sha,
      generatedAtIso: new Date(at.getTime() - 3 * 3_600_000).toISOString(),
    });
    expect(previewRejection(old, now)).toMatch(/más de 2 h/);
    expect(previewRejection(fresh(), { ...now, gitSha: `${sha}${DIRTY_SUFFIX}` })).toMatch(
      /sin commitear/,
    );
    const future = preview({ gitSha: sha, generatedAtIso: '2026-10-16T00:00:00.000Z' });
    expect(previewRejection(future, now)).toMatch(/no es válida/);
  });

  it('compara también el número de ajustes', () => {
    expect(comparePreviews(preview(), preview({ adjustments: 3 }))).toEqual([
      'ajustes: esperado 2, quedó 3',
    ]);
  });
});
