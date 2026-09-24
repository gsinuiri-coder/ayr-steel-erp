import { valuePeps, type PepsMovement } from './kardex-peps';

/**
 * D-279 — Kardex PEPS (formato SUNAT 13.1). Casos calculados a mano: la valorización del
 * sistema sigue en costo promedio (D-028); esto es solo el reporte, y lo único que importa
 * probar es que las capas se consumen en orden de llegada y al costo de cada una.
 */

let seq = 0;
function mv(
  type: PepsMovement['type'],
  qty: string,
  totalCost: string,
  operationDate: string,
  extra: Partial<PepsMovement> = {},
): PepsMovement {
  seq += 1;
  return {
    id: String(seq),
    type,
    qty,
    totalCost,
    operationDate,
    reversalOfId: null,
    ...extra,
  };
}

describe('valuePeps', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('una salida que cruza dos capas toma primero la más antigua', () => {
    // Entradas 100 kg a 10 y 50 kg a 12; salida 120 kg → 100×10 + 20×12 = 1240.
    // Saldo: 30 kg a 12 = 360.
    const result = valuePeps(
      [
        mv('IN', '100.000', '1000.0000', '2026-09-01'),
        mv('IN', '50.000', '600.0000', '2026-09-02'),
        mv('OUT', '120.000', '1333.3333', '2026-09-03'), // el promedio registrado no manda
      ],
      '2026-09-01',
      '2026-09-30',
    );
    const out = result.rows[2];
    expect(out?.outQty).toBe('120.000');
    expect(out?.outTotal).toBe('1240.0000');
    expect(out?.outUnitCost).toBe('10.3333');
    expect(out?.balanceQty).toBe('30.000');
    expect(out?.balanceTotal).toBe('360.0000');
    expect(out?.balanceUnitCost).toBe('12.0000');
    expect(result.closing.layers).toEqual([
      { qty: '30.000', unitCost: '12.0000', total: '360.0000' },
    ]);
    expect(result.totals).toEqual({
      inQty: '150.000',
      inTotal: '1600.0000',
      outQty: '120.000',
      outTotal: '1240.0000',
    });
  });

  it('el saldo inicial del rango aplica PEPS a lo anterior y conserva sus capas', () => {
    // Antes del rango: 100 a 10, 50 a 12, salida 80 → quedan 20 a 10 y 50 a 12 (800).
    // En el rango: salida 40 → 20×10 + 20×12 = 440; saldo 30 a 12 = 360.
    const result = valuePeps(
      [
        mv('IN', '100.000', '1000.0000', '2026-08-01'),
        mv('IN', '50.000', '600.0000', '2026-08-15'),
        mv('OUT', '80.000', '853.3333', '2026-08-20'),
        mv('OUT', '40.000', '426.6667', '2026-09-05'),
        mv('IN', '10.000', '150.0000', '2026-10-01'), // después del rango: no entra
      ],
      '2026-09-01',
      '2026-09-30',
    );
    expect(result.opening).toEqual({
      qty: '70.000',
      unitCost: '11.4286',
      total: '800.0000',
      layers: [
        { qty: '20.000', unitCost: '10.0000', total: '200.0000' },
        { qty: '50.000', unitCost: '12.0000', total: '600.0000' },
      ],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.outTotal).toBe('440.0000');
    expect(result.closing.total).toBe('360.0000');
    expect(result.closing.qty).toBe('30.000');
  });

  it('la anulación de una salida devuelve las capas que esa salida consumió, a su costo', () => {
    // 100 a 10, 50 a 12; salida 120 (1000 + 240); anulación → vuelven 100 a 10 y 20 a 12.
    const out = mv('OUT', '120.000', '1333.3333', '2026-09-03');
    const result = valuePeps(
      [
        mv('IN', '100.000', '1000.0000', '2026-09-01'),
        mv('IN', '50.000', '600.0000', '2026-09-02'),
        out,
        mv('IN', '120.000', '1333.3333', '2026-09-04', { reversalOfId: out.id }),
      ],
      '2026-09-01',
      '2026-09-30',
    );
    const back = result.rows[3];
    expect(back?.inTotal).toBe('1240.0000');
    expect(back?.balanceQty).toBe('150.000');
    expect(back?.balanceTotal).toBe('1600.0000');
    // La siguiente salida vuelve a salir de la capa más antigua.
    expect(result.closing.layers[0]).toEqual({
      qty: '100.000',
      unitCost: '10.0000',
      total: '1000.0000',
    });
  });

  it('la anulación de una entrada saca su propia capa, no la más antigua', () => {
    const second = mv('IN', '50.000', '600.0000', '2026-09-02');
    const result = valuePeps(
      [
        mv('IN', '100.000', '1000.0000', '2026-09-01'),
        second,
        mv('OUT', '50.000', '600.0000', '2026-09-03', { reversalOfId: second.id }),
      ],
      '2026-09-01',
      '2026-09-30',
    );
    expect(result.rows[2]?.outTotal).toBe('600.0000');
    expect(result.closing.layers).toEqual([
      { qty: '100.000', unitCost: '10.0000', total: '1000.0000' },
    ]);
  });

  it('un ajuste de costo reparte el monto sobre las capas vivas según sus kilos', () => {
    // 100 a 10 y 100 a 12; ajuste +200 → +1/kg en cada capa: 100 a 11, 100 a 13.
    const result = valuePeps(
      [
        mv('IN', '100.000', '1000.0000', '2026-09-01'),
        mv('IN', '100.000', '1200.0000', '2026-09-02'),
        mv('ADJUST', '200.000', '200.0000', '2026-09-03'),
        mv('OUT', '100.000', '1200.0000', '2026-09-04'),
      ],
      '2026-09-01',
      '2026-09-30',
    );
    const adjust = result.rows[2];
    expect(adjust?.inQty).toBeNull();
    expect(adjust?.inTotal).toBe('200.0000');
    expect(adjust?.balanceTotal).toBe('2400.0000');
    expect(result.rows[3]?.outTotal).toBe('1100.0000');
    expect(result.closing.layers).toEqual([
      { qty: '100.000', unitCost: '13.0000', total: '1300.0000' },
    ]);
  });

  it('una salida sin capas suficientes no inventa costo: se marca y el faltante va al costo registrado', () => {
    // 10 a 10 en capas; sale 15 con costo registrado 10/kg (150). 5 kg sin capa.
    const result = valuePeps(
      [mv('IN', '10.000', '100.0000', '2026-09-01'), mv('OUT', '15.000', '150.0000', '2026-09-02')],
      '2026-09-01',
      '2026-09-30',
    );
    const out = result.rows[1];
    expect(out?.outTotal).toBe('150.0000');
    expect(out?.warning).toMatch(/5\.000/);
    expect(out?.balanceQty).toBe('-5.000');
    expect(result.warnings).toHaveLength(1);
  });

  it('una entrada después de un faltante cubre primero lo que faltaba', () => {
    const result = valuePeps(
      [
        mv('IN', '10.000', '100.0000', '2026-09-01'),
        mv('OUT', '15.000', '150.0000', '2026-09-02'),
        mv('IN', '20.000', '240.0000', '2026-09-03'),
      ],
      '2026-09-01',
      '2026-09-30',
    );
    expect(result.closing.layers).toEqual([
      { qty: '15.000', unitCost: '12.0000', total: '180.0000' },
    ]);
    expect(result.rows[2]?.balanceQty).toBe('15.000');
    expect(result.rows[2]?.balanceTotal).toBe('180.0000');
  });
});
