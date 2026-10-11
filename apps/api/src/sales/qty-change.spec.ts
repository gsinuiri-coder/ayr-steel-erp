import { Decimal } from '@ayr/shared';
import {
  lengthLabel,
  lengthRows,
  piecesByLength,
  piecesMinus,
  piecesSummary,
  qtyFloorViolation,
  qtyKindOf,
  releaseSplit,
  samePieces,
} from './qty-change';

const p = (meters: number, qty: number) => ({ lengthMm: (meters * 1000).toFixed(2), qty });
const d = (v: string) => new Decimal(v);

describe('cc45 — aritmética de «Cambiar cantidad» (D-603, D-604)', () => {
  it('qtyKindOf: por largo, en planchas, en metros o en su unidad', () => {
    expect(qtyKindOf({ unit: 'MTR', roofingKind: 'A_MEDIDA', lengthMm: null }, true)).toBe(
      'PIECES',
    );
    expect(qtyKindOf({ unit: 'MTR', roofingKind: 'ACCESORIO', lengthMm: null }, true)).toBe(
      'METERS',
    );
    expect(qtyKindOf({ unit: 'NIU', roofingKind: 'PLANCHA', lengthMm: '2000.00' }, true)).toBe(
      'UNITS',
    );
    // Sin producción, una plancha de stock (o cualquier producto) se mide en su unidad.
    expect(qtyKindOf({ unit: 'NIU', roofingKind: 'PLANCHA', lengthMm: '2000.00' }, false)).toBe(
      'QTY',
    );
    expect(qtyKindOf({ unit: 'NIU', roofingKind: null, lengthMm: null }, false)).toBe('QTY');
  });

  it('piecesByLength suma por largo y descarta los ceros', () => {
    expect([...piecesByLength([p(6, 2), p(6, 1), p(4, 0), { lengthMm: '6000', qty: 1 }])]).toEqual([
      ['6000.00', 4],
    ]);
  });

  it('lengthRows une lo pedido y lo registrado, de mayor a menor', () => {
    expect(lengthRows([p(6, 10), p(2.4, 10)], [p(6, 10), p(5, 2)])).toEqual([
      { lengthMm: '6000.00', ordered: 10, registered: 10 },
      { lengthMm: '5000.00', ordered: 0, registered: 2 },
      { lengthMm: '2400.00', ordered: 10, registered: 0 },
    ]);
    expect(lengthLabel('2400.00')).toBe('2.40 m');
  });

  it('qtyFloorViolation: por largo, por lo registrado y por lo despachado', () => {
    const base = {
      kind: 'PIECES' as const,
      unitLabel: 'm',
      registeredPieces: [p(6, 10)],
      registeredQty: d('60'),
      dispatchedQty: d('0'),
    };
    expect(qtyFloorViolation({ ...base, qty: d('54'), pieces: [p(6, 9)] })).toBe(
      'El largo 6.00 m no puede bajar de 10 planchas: ya están registradas',
    );
    // Quitar el largo registrado entero también baja de su piso.
    expect(qtyFloorViolation({ ...base, qty: d('60'), pieces: [p(3, 20)] })).toContain(
      'El largo 6.00 m',
    );
    expect(qtyFloorViolation({ ...base, qty: d('60'), pieces: [p(6, 10)] })).toBeNull();
    expect(
      qtyFloorViolation({
        kind: 'METERS',
        unitLabel: 'm',
        qty: d('4'),
        pieces: [],
        registeredPieces: [],
        registeredQty: d('5'),
        dispatchedQty: d('0'),
      }),
    ).toBe('La cantidad no puede bajar de 5.000 m: ya están registrados');
    expect(
      qtyFloorViolation({
        kind: 'QTY',
        unitLabel: 'und',
        qty: d('3'),
        pieces: [],
        registeredPieces: [],
        registeredQty: d('0'),
        dispatchedQty: d('4'),
      }),
    ).toBe('La cantidad no puede bajar de 4.000 und: ya se despacharon');
  });

  it('piecesMinus deja lo que falta por largo, sin negativos', () => {
    expect(piecesMinus([p(6, 10), p(3, 6)], [p(6, 10)])).toEqual([p(3, 6)]);
    expect(piecesMinus([p(6, 10)], [p(6, 12)])).toEqual([]);
    expect(piecesMinus([p(6, 4), p(2.4, 2)], [p(5, 3)])).toEqual([p(6, 4), p(2.4, 2)]);
    expect(piecesSummary([p(6, 2), p(3, 2)])).toEqual({ count: 4, meters: d('18') });
  });

  it('releaseSplit baja primero el faltante y después lo reservado', () => {
    expect(releaseSplit({ delta: d('-10'), qty: d('30'), shortfall: d('4') })).toEqual({
      qty: d('24'),
      shortfall: d('0'),
      released: d('6'),
    });
    expect(releaseSplit({ delta: d('-3'), qty: d('30'), shortfall: d('4') })).toEqual({
      qty: d('30'),
      shortfall: d('1'),
      released: d('0'),
    });
    // Nunca negativo: lo que se pide de más que lo prometido no se libera.
    expect(releaseSplit({ delta: d('-50'), qty: d('30'), shortfall: d('0') })).toEqual({
      qty: d('0'),
      shortfall: d('0'),
      released: d('30'),
    });
  });

  it('samePieces compara por largo sin importar el orden', () => {
    expect(samePieces([p(6, 2), p(3, 1)], [p(3, 1), p(6, 2)])).toBe(true);
    expect(samePieces([p(6, 2)], [p(6, 3)])).toBe(false);
    expect(samePieces([p(6, 2)], [p(6, 2), p(3, 1)])).toBe(false);
  });
});
