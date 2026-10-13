import { BadRequestException } from '@nestjs/common';
import type { FiscalDocumentDto } from '@ayr/shared';
import { applyAtCostMarks } from '../invoicing/invoicing.service';
import type { PriceFloor, PriceFloorCandidate } from './price-floor';
import { assertAtCostAllowed, attachAtCost, markAtCostCandidates } from './sales-lines';

/** cc51 (D-641): dónde se admite la marca «A costo» y cómo viaja hasta guardarse y mostrarse. */
const MARK = { reason: 'LIQUIDACION' as const };

function candidate(at: string): PriceFloorCandidate {
  return {
    at,
    sku: 'SKU',
    businessLineId: 'bl',
    basis: { kind: 'UNIT', unitLabel: 'NIU' },
    unitValuePen: '20.0000',
    cost: { kind: 'PRODUCT', productId: 'p' },
  };
}

describe('assertAtCostAllowed', () => {
  const floor = { toleranceMm: '0.05' };
  const notPaper = () => false;
  it('sin marca, cualquier ruta', () => {
    expect(() => assertAtCostAllowed([{ productId: 'p', qty: '1' }], notPaper, {})).not.toThrow();
  });
  it('fuera de la cotización (sin allowAtCost) es un 400 que dice dónde se marca', () => {
    expect(() =>
      assertAtCostAllowed([{ qty: '1', atCost: MARK }], notPaper, { priceFloor: floor }),
    ).toThrow(/se marca en la cotización/);
  });
  it('sin piso (importador o importada del ADMINISTRADOR) o en la línea del papel, 400', () => {
    expect(() =>
      assertAtCostAllowed([{ qty: '1', atCost: MARK }], notPaper, { allowAtCost: true }),
    ).toThrow(/comprobante importado/);
    expect(() =>
      assertAtCostAllowed([{ qty: '1', atCost: MARK }], () => true, {
        allowAtCost: true,
        priceFloor: floor,
      }),
    ).toThrow(BadRequestException);
  });
  it('en la cotización con piso, pasa; el rechazo nombra la línea con su número', () => {
    expect(() =>
      assertAtCostAllowed([{ qty: '1', atCost: MARK }], notPaper, {
        allowAtCost: true,
        priceFloor: floor,
      }),
    ).not.toThrow();
    expect(() =>
      assertAtCostAllowed([{ qty: '1' }, { qty: '1', atCost: MARK }], notPaper, {
        firstLineNumber: 5,
      }),
    ).toThrow(/^Línea 6:/);
  });
});

describe('markAtCostCandidates', () => {
  it('marca solo los candidatos de las líneas a costo', () => {
    const candidates = [candidate('Línea 1'), candidate('Línea 2')];
    markAtCostCandidates([{}, { atCost: MARK }], candidates, 1);
    expect(candidates.map((c) => c.atCost === true)).toEqual([false, true]);
  });
  it('respeta la primera línea del documento', () => {
    const candidates = [candidate('Línea 3')];
    markAtCostCandidates([{ atCost: MARK }], candidates, 3);
    expect(candidates[0]?.atCost).toBe(true);
  });
  it('una línea a costo sin candidato (servicio o sin costo) es un 400', () => {
    expect(() => markAtCostCandidates([{ atCost: MARK }], [], 1)).toThrow(
      /no tiene costo de referencia/,
    );
  });
});

describe('attachAtCost', () => {
  const floor: PriceFloor = {
    minValuePen: '20.0000',
    minPricePen: '23.60',
    priceUnitLabel: 'und',
    costPen: '20.0000',
    minMarginPct: '0.0000',
  };
  it('la marca y el piso a costo en la línea marcada; nada en la normal', () => {
    const out = attachAtCost(
      [{ n: 1 }, { n: 2 }],
      [{ atCost: { reason: 'OTRO', note: 'Obra' } }, {}],
      new Map([['Línea 1', floor]]),
      1,
    );
    expect(out[0]).toEqual({
      n: 1,
      atCostReason: 'OTRO',
      atCostNote: 'Obra',
      atCostFloor: { costPen: '20.0000', minPricePen: '23.60', priceUnitLabel: 'und' },
    });
    expect(out[1]).toEqual({ n: 2, atCostReason: null, atCostNote: null, atCostFloor: null });
  });
  it('sin piso calculado (sin piso en la llamada), la marca sin piso', () => {
    const [line] = attachAtCost([{ n: 1 }], [{ atCost: MARK }], new Map(), 1);
    expect(line).toMatchObject({ atCostReason: 'LIQUIDACION', atCostFloor: null });
  });
});

describe('applyAtCostMarks (comprobante)', () => {
  const item = (id: string, salesOrderItemId: string | null) =>
    ({ id, salesOrderItemId, atCostReason: null, atCostNote: null }) as never;
  const dto = {
    items: [item('a', 'oi-1'), item('b', 'oi-2'), item('c', null)],
  } as unknown as FiscalDocumentDto;
  it('cada línea toma la marca de su línea de pedido', () => {
    const out = applyAtCostMarks(dto, [
      { id: 'oi-2', atCostReason: 'FRECUENTE', atCostNote: null },
    ]);
    expect(out.items.map((i) => i.atCostReason)).toEqual([null, 'FRECUENTE', null]);
  });
  it('sin marcas, el mismo documento', () => {
    expect(applyAtCostMarks(dto, [])).toBe(dto);
  });
});
