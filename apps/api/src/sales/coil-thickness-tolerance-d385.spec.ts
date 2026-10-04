import { FinishKind, Prisma } from '@prisma/client';
import {
  coilSkusWithinThickness,
  parseCanonicalCoilSku,
  ROOFING_THICKNESS_TOLERANCE_MM,
  thicknessWithin,
} from '@ayr/shared';
import { coilPoolFor } from './coil-sale-product';

/**
 * D-385 (A): la bobina se busca con la **tolerancia de espesor de coberturas** (±0.02 mm, la misma
 * constante, `ROOFING_THICKNESS_TOLERANCE_MM`), del mismo color comercial, aunque sea de otro SKU:
 * el papel dice `BOB030AZUL` y la bobina real está registrada como 0.28 (`BOB028AZUL`).
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

const D = (v: string) => new Prisma.Decimal(v);

interface FakeCoil {
  id: string;
  thickness: string;
  color: string;
  balance: string;
}

/** Una base que aplica el filtro de espesor (exacto o rango) como lo haría Postgres. */
function txWith(coils: FakeCoil[]) {
  const rows = coils.map((c) => ({
    id: c.id,
    code: `C-${c.id}`,
    widthMm: D('1200'),
    thicknessMm: D(c.thickness),
    finish: { kind: FinishKind.PREPINTADO, color: { code: c.color } },
  }));
  return {
    coil: {
      findMany: jest.fn(
        ({ where }: { where: { thicknessMm: string | { gte: string; lte: string } } }) =>
          Promise.resolve(
            rows.filter((r) =>
              typeof where.thicknessMm === 'string'
                ? r.thicknessMm.equals(D(where.thicknessMm))
                : r.thicknessMm.gte(D(where.thicknessMm.gte)) &&
                  r.thicknessMm.lte(D(where.thicknessMm.lte)),
            ),
          ),
      ),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(coils.map((c) => ({ itemId: c.id, qty: D(c.balance) }))),
    },
    quotationItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const PAPER = { thicknessMm: '0.30', attribute: 'AZUL' };

describe('D-385 (A) — la tolerancia es la de coberturas', () => {
  it('usa la constante compartida de ±0.02 mm', () => {
    expect(ROOFING_THICKNESS_TOLERANCE_MM).toBe('0.02');
  });

  it('thicknessWithin incluye el borde y excluye lo que pasa de él', () => {
    expect(thicknessWithin('0.30', '0.28', '0.02')).toBe(true);
    expect(thicknessWithin('0.30', '0.32', '0.02')).toBe(true);
    expect(thicknessWithin('0.30', '0.27', '0.02')).toBe(false);
    expect(thicknessWithin('0.30', '0.33', '0.02')).toBe(false);
  });

  it('los SKU del mismo color dentro de la tolerancia, de a centésima', () => {
    expect(coilSkusWithinThickness(PAPER, '0.02').map((s) => s.sku)).toEqual([
      'BOB028AZUL',
      'BOB029AZUL',
      'BOB030AZUL',
      'BOB031AZUL',
      'BOB032AZUL',
    ]);
  });

  it('parseCanonicalCoilSku lee el espesor y el color de un SKU canónico', () => {
    expect(parseCanonicalCoilSku('BOB028AZUL')).toEqual({ thicknessMm: '0.28', attribute: 'AZUL' });
    expect(parseCanonicalCoilSku('BOB38AZUL')).toBeNull();
  });
});

describe('D-385 (A) — coilPoolFor con tolerancia de espesor', () => {
  const coils: FakeCoil[] = [
    { id: 'in-29', thickness: '0.29', color: 'AZUL', balance: '4200' },
    { id: 'edge-28', thickness: '0.28', color: 'AZUL', balance: '4200' },
    { id: 'edge-32', thickness: '0.32', color: 'AZUL', balance: '4200' },
    { id: 'out-27', thickness: '0.27', color: 'AZUL', balance: '4200' },
    { id: 'out-33', thickness: '0.33', color: 'AZUL', balance: '4200' },
    { id: 'rojo-30', thickness: '0.30', color: 'ROJO', balance: '4200' },
  ];

  it('dentro y en el borde entran, aunque sean de otro SKU; fuera y otro color, no', async () => {
    const pool = await coilPoolFor(
      txWith(coils) as never,
      { ...PAPER, toleranceMm: '0.02' },
      '4192.000',
    );
    expect(pool.candidates.map((c) => c.coilId).sort()).toEqual(['edge-28', 'edge-32', 'in-29']);
    expect(pool.candidates.find((c) => c.coilId === 'edge-28')?.thicknessMm).toBe('0.28');
  });

  it('pide a la base el rango del papel ± la tolerancia', async () => {
    const tx = txWith(coils);
    await coilPoolFor(tx as never, { ...PAPER, toleranceMm: '0.02' }, '4192.000');
    expect(tx.coil.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ thicknessMm: { gte: '0.28', lte: '0.32' } }),
      }),
    );
  });

  it('sin tolerancia sigue siendo el pool exacto de siempre (D-254)', async () => {
    const pool = await coilPoolFor(txWith(coils) as never, PAPER, '4192.000');
    expect(pool.candidates).toEqual([]);
  });

  it('el saldo sigue pidiendo ≥ los kilos del papel para la sugerencia', async () => {
    const pool = await coilPoolFor(
      txWith([{ id: 'light', thickness: '0.28', color: 'AZUL', balance: '4180' }]) as never,
      { ...PAPER, toleranceMm: '0.02' },
      '4192.000',
    );
    expect(pool.candidates).toEqual([]);
    expect(pool.availableKg).toBe('4180.000');
  });
});
