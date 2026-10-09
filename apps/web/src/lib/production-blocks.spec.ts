import { describe, expect, it } from 'vitest';
import {
  blockFigures,
  coilOfRowError,
  fillFromRemaining,
  planSquare,
  withoutRowPrefix,
} from './production-blocks';

/**
 * cc35 (ESPEC §1): el modelo M, bloque por bobina. Bobina de prueba: 1 000 mm × 0.50 mm, densidad
 * 8.0 con el 1 % de D-165 ⇒ 4.04 kg por metro.
 */
const p = (lengthM: string, qty: number) => ({
  lengthMm: (Number(lengthM) * 1000).toFixed(2),
  qty,
});
const coil = (remainingKg: string) => ({
  coilCode: 'BOB-A',
  widthMm: '1000.00',
  thicknessMm: '0.50',
  densityFactor: '8.0000',
  remainingKg,
});

describe('fillFromRemaining — el último bloque se llena con lo que falta', () => {
  it('es lo que falta del plan menos lo que llevan los otros bloques, largo por largo', () => {
    const remaining = [p('6.00', 10), p('5.20', 8), p('4.80', 6)];
    const others = [
      [p('6.00', 10), p('5.20', 3)],
      [p('5.20', 5), p('4.80', 2)],
    ];
    expect(fillFromRemaining(remaining, others)).toEqual([
      { lineNumber: 1, lengthMm: '4800.00', qty: 4 },
    ]);
  });

  it('con un solo bloque es todo lo que falta', () => {
    expect(fillFromRemaining([p('4.00', 10)], [])).toEqual([
      { lineNumber: 1, lengthMm: '4000.00', qty: 10 },
    ]);
  });

  it('si los otros bloques ya cubren todo, queda vacío', () => {
    expect(fillFromRemaining([p('4.00', 10)], [[p('4.00', 12)]])).toEqual([]);
  });
});

describe('blockFigures — las cifras de un bloque', () => {
  it('sin kg consumidos vale el teórico: sin despunte, y la bobina sigue montada', () => {
    const f = blockFigures(coil('1000.000'), [p('4.00', 10)], '');
    expect(f.meters.toFixed(3)).toBe('40.000');
    expect(f.theoreticalKg.toFixed(3)).toBe('161.600');
    expect(f.outKg.toFixed(3)).toBe('161.600');
    expect(f.scrapKg.toFixed(3)).toBe('0.000');
    expect(f.leftKg.toFixed(3)).toBe('838.400');
    expect(f.terminated).toBe(false);
  });

  it('con kg consumidos, el despunte cae en esta bobina y si llega al saldo «se terminó»', () => {
    const f = blockFigures(coil('165.000'), [p('4.00', 10)], '165');
    expect(f.declaredKg?.toFixed(3)).toBe('165.000');
    expect(f.scrapKg.toFixed(3)).toBe('3.400');
    expect(f.leftKg.toFixed(3)).toBe('0.000');
    expect(f.terminated).toBe(true);
  });

  it('pasado el 1 % de lo montado, el bloque pide la casilla (y no bloquea)', () => {
    const f = blockFigures(coil('150.000'), [p('4.00', 10)], '');
    expect(f.error).toBeNull();
    expect(f.excess?.excessKg).toBe('11.600');
    expect(f.excess?.severe).toBe(true);
    expect(f.terminated).toBe(true);
  });

  it('dentro de la tolerancia avisa (rindió más) sin casilla', () => {
    const f = blockFigures(coil('161.000'), [p('4.00', 10)], '');
    expect(f.excess).toBeNull();
    expect(f.note).toMatch(/rindió más de lo teórico/);
  });

  it('lo declarado que se aleja más del 10 % del teórico avisa «revisa que no falte un dígito»', () => {
    const f = blockFigures(coil('1000.000'), [p('4.00', 10)], '16.16');
    expect(f.deviation).toMatch(/Revisa que no falte un dígito/);
  });

  it('declarar más que lo montado es un error del bloque', () => {
    const f = blockFigures(coil('100.000'), [p('2.00', 10)], '120');
    expect(f.error).toMatch(/100\.000 kg montados y se declaran 120\.000 kg/);
  });

  it('kilos mal escritos son un error del bloque', () => {
    expect(blockFigures(coil('100.000'), [p('2.00', 1)], '1,5').error).toMatch(/tres decimales/);
  });
});

describe('coilOfRowError — un error de commit señala el bloque correcto', () => {
  const drafts = [
    { rowNumber: 1, coilId: 'coil-a' },
    { rowNumber: 2, coilId: 'coil-b' },
  ];
  it('«Fila 2: …» es el bloque de la segunda bobina', () => {
    expect(coilOfRowError('Fila 2: BOB-B tiene 3.000 kg montados', drafts)).toBe('coil-b');
    expect(withoutRowPrefix('Fila 2: BOB-B tiene 3.000 kg montados')).toBe(
      'BOB-B tiene 3.000 kg montados',
    );
  });
  it('un mensaje sin fila, o con una fila que no está, no señala ninguno', () => {
    expect(coilOfRowError('La orden está cerrada', drafts)).toBeNull();
    expect(coilOfRowError('Fila 9: algo', drafts)).toBeNull();
  });
});

describe('planSquare — la franja de cuadre', () => {
  const plan = [p('6.00', 10), p('5.20', 8)];
  it('reportado + bloques igual al plan, cada largo completo', () => {
    const square = planSquare(
      plan,
      [p('6.00', 6), p('5.20', 8)],
      [[p('6.00', 4)], [p('6.00', 2), p('5.20', 8)]],
    );
    expect(square).toEqual({ planned: 18, covered: 18, complete: true });
  });
  it('un largo incompleto o uno de más no cuadra', () => {
    expect(planSquare(plan, plan, [[p('6.00', 10)]]).complete).toBe(false);
    expect(planSquare(plan, plan, [[p('6.00', 10), p('5.20', 8), p('1.00', 1)]]).complete).toBe(
      false,
    );
  });
});
