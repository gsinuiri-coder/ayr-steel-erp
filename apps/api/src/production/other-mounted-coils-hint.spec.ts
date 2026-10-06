import { toDecimal } from '@ayr/shared';
import { otherMountedCoilsHint } from './production-shared';

/**
 * cc28 (P2-2 de cc20): el rechazo por tolerancia nombra las otras bobinas montadas con saldo,
 * porque lo que falta en una puede haber salido de la otra.
 */
describe('otherMountedCoilsHint', () => {
  const coil = (code: string, kg: string) => ({ code, remainingKg: toDecimal(kg) });

  it('nombra las otras bobinas con saldo, con sus kilos', () => {
    const hint = otherMountedCoilsHint('B-A', [coil('B-A', '0'), coil('B-B', '3000')]);
    expect(hint).toContain('B-B (3000.000 kg)');
    expect(hint).not.toContain('B-A');
  });

  it('una sola bobina montada, u otras sin saldo: no dice nada', () => {
    expect(otherMountedCoilsHint('B-A', [coil('B-A', '500')])).toBeNull();
    expect(otherMountedCoilsHint('B-A', [coil('B-A', '500'), coil('B-C', '0')])).toBeNull();
  });

  it('varias con saldo, todas', () => {
    const hint = otherMountedCoilsHint('B-A', [
      coil('B-A', '10'),
      coil('B-B', '200.5'),
      coil('B-C', '75'),
    ]);
    expect(hint).toContain('B-B (200.500 kg), B-C (75.000 kg)');
  });
});
