import { describe, expect, it } from 'vitest';
import type { SalesOrderItemQtyPreviewDto } from '@ayr/shared';
import {
  addedRow,
  draftFromRows,
  draftFromSingle,
  initialRows,
  lowerRowsToRegistered,
  rowMeters,
  sameAsCurrent,
  totalDifference,
} from './qty-change';

const preview = (over: Partial<SalesOrderItemQtyPreviewDto> = {}): SalesOrderItemQtyPreviewDto => ({
  itemId: 'i-1',
  lineNumber: 1,
  productSku: 'COB028ROJO',
  kind: 'PIECES',
  unit: 'MTR',
  qty: '84.000',
  meters: '84.000',
  pieces: 16,
  totalPen: '1000.00',
  orderTotalPen: '1000.00',
  rows: [
    { lengthMm: '6000.00', ordered: 10, registered: 10 },
    { lengthMm: '4000.00', ordered: 6, registered: 0 },
  ],
  registeredQty: '60.000',
  dispatchedQty: '0.000',
  minQty: '60.000',
  hasProduction: true,
  hasDispatches: false,
  adminOnly: true,
  blocked: null,
  productionOrders: [],
  outcome: null,
  ...over,
});

describe('cc45 — el diálogo «Cambiar cantidad» (D-603)', () => {
  it('arranca con lo pedido y «Bajar a lo registrado» deja cada largo en lo registrado', () => {
    const rows = initialRows(preview());
    expect(rows.map((r) => r.next)).toEqual(['10', '6']);
    expect(sameAsCurrent(draftFromRows(rows), preview())).toBe(true);
    const lowered = lowerRowsToRegistered(rows);
    expect(lowered.map((r) => r.next)).toEqual(['10', '0']);
    const draft = draftFromRows(lowered);
    expect(draft).toMatchObject({
      ok: true,
      qty: '60.000',
      pieces: [{ lengthMm: '6000.00', qty: 10 }],
    });
    expect(sameAsCurrent(draft, preview())).toBe(false);
  });

  it('un largo por debajo de lo registrado no se manda', () => {
    const rows = initialRows(preview()).map((r) =>
      r.lengthMm === '6000.00' ? { ...r, next: '9' } : r,
    );
    expect(draftFromRows(rows)).toEqual({
      ok: false,
      reason: 'El largo 6.00 m no puede bajar de 10 planchas: ya están registradas.',
    });
  });

  it('«+ Otro largo» suma una fila con su largo en metros', () => {
    const extra = { ...addedRow(), lengthM: '3', next: '6' };
    expect(rowMeters(extra)).toBe('18.000');
    expect(rowMeters({ ...extra, lengthM: 'x' })).toBeNull();
    const draft = draftFromRows([...initialRows(preview()), extra]);
    expect(draft).toMatchObject({ ok: true, qty: '102.000' });
    expect(addedRow().key).not.toBe(addedRow().key);
  });

  it('rechaza planchas que no son enteras y una línea vacía', () => {
    const [row] = initialRows(
      preview({ rows: [{ lengthMm: '6000.00', ordered: 2, registered: 0 }] }),
    );
    if (!row) throw new Error('sin fila');
    expect(draftFromRows([{ ...row, next: '1.5' }])).toMatchObject({ ok: false });
    expect(draftFromRows([{ ...row, next: '0' }])).toEqual({
      ok: false,
      reason: 'La línea no puede quedar sin planchas.',
    });
    expect(rowMeters({ ...row, next: '' })).toBeNull();
  });

  it('fila única: planchas enteras, metros con 3 decimales y el piso', () => {
    const units = preview({ kind: 'UNITS', unit: 'NIU', qty: '10.000', minQty: '4.000' });
    expect(draftFromSingle('4', units)).toEqual({ ok: true, qty: '4.000' });
    expect(draftFromSingle('3', units)).toMatchObject({ ok: false });
    expect(draftFromSingle('4.5', units)).toMatchObject({ ok: false });
    const meters = preview({ kind: 'METERS', qty: '5.000', minQty: '6.000' });
    expect(draftFromSingle('6.5', meters)).toEqual({ ok: true, qty: '6.500' });
    expect(draftFromSingle('5.999', meters)).toMatchObject({ ok: false });
    expect(draftFromSingle('0', preview({ kind: 'QTY', minQty: '0.000' }))).toMatchObject({
      ok: false,
    });
    expect(sameAsCurrent({ ok: true, qty: '5.000' }, meters)).toBe(true);
    expect(sameAsCurrent({ ok: false, reason: 'x' }, meters)).toBe(false);
  });

  it('la diferencia del total con su signo', () => {
    expect(totalDifference('4787.80', '4144.00')).toEqual({ sign: '−', abs: '643.80' });
    expect(totalDifference('4787.80', '5120.80')).toEqual({ sign: '+', abs: '333.00' });
  });
});
