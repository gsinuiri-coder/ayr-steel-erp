import { describe, expect, it } from 'vitest';
import { toDecimal } from '@ayr/shared';
import {
  accessoryBlock,
  accessoryFill,
  EMPTY_ACCESSORY_EDIT,
  typedMeters,
} from './accessory-blocks';

/**
 * cc35 (ESPEC §2): un accesorio no tiene plan de corte; cada bloque lleva los metros de bobina que
 * salieron. Bobina de prueba: 1 000 mm × 0.50 mm, densidad 8.0 con el 1 % ⇒ 4.04 kg por metro.
 */
const coil = (remainingKg: string) => ({
  coilCode: 'BOB-A',
  widthMm: '1000.00',
  thicknessMm: '0.50',
  densityFactor: '8.0000',
  remainingKg,
});

describe('accessory-blocks', () => {
  it('el último bloque se llena con lo que falta del pedido menos los otros bloques', () => {
    expect(accessoryFill('30.000', [toDecimal('5'), toDecimal('5'), null]).toFixed(3)).toBe(
      '20.000',
    );
    expect(accessoryFill('10.000', [toDecimal('12')]).toFixed(3)).toBe('0.000');
  });

  it('los kilos salen de los metros con el kg por metro de la bobina', () => {
    const check = accessoryBlock(coil('100.000'), { ...EMPTY_ACCESSORY_EDIT, meters: '5' });
    expect(check.figures.theoreticalKg.toFixed(3)).toBe('20.200');
    expect(check.figures.leftKg.toFixed(3)).toBe('79.800');
    expect(check.error).toBeNull();
  });

  it('con kg consumidos, el despunte cae en la bobina; las piezas son solo información', () => {
    const check = accessoryBlock(coil('21.000'), { meters: '5', pieces: '2', consumedKg: '21' });
    expect(check.pieces).toBe(2);
    expect(check.figures.scrapKg.toFixed(3)).toBe('0.800');
    expect(check.figures.terminated).toBe(true);
  });

  it('metros, piezas o kilos mal escritos son un error del bloque', () => {
    expect(typedMeters('0')).toBeNull();
    expect(accessoryBlock(coil('100'), { ...EMPTY_ACCESSORY_EDIT, meters: '5,5' }).error).toMatch(
      /metros/,
    );
    expect(
      accessoryBlock(coil('100'), { ...EMPTY_ACCESSORY_EDIT, meters: '5', pieces: '1.5' }).error,
    ).toMatch(/piezas/);
    expect(accessoryBlock(coil('100'), { ...EMPTY_ACCESSORY_EDIT, consumedKg: '3' }).error).toMatch(
      /metros de esta bobina/,
    );
  });
});
