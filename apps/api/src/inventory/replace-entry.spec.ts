import { Decimal } from '@ayr/shared';
import { minRunningAfterReplace } from './inventory.service';

/**
 * D-372 (cc15b, revisión P1-1) — el saldo corrido más bajo que dejaría reemplazar un ingreso,
 * con todas las filas del kardex en su fecha (también las salidas anuladas y sus reversas).
 */
describe('minRunningAfterReplace', () => {
  const m = (type: string, qty: string, operationDate: string) => ({ type, qty, operationDate });
  const D = (v: string) => new Decimal(v);

  it('con una salida anulada entre fechas, bajar la cantidad deja un tramo negativo', () => {
    const kardex = [
      m('IN', '100', '2026-09-01'), // el ingreso a reemplazar
      m('OUT', '100', '2026-09-10'), // la salida
      m('IN', '100', '2026-10-03'), // su anulación, con fecha de hoy
    ];
    expect(minRunningAfterReplace(kardex, '2026-09-01', D('100'), D('50')).toFixed(3)).toBe(
      '-50.000',
    );
    expect(minRunningAfterReplace(kardex, '2026-09-01', D('100'), D('100')).toFixed(3)).toBe(
      '0.000',
    );
  });

  it('las dos filas del reemplazo van al final de su día: lo de ese día ya está sumado', () => {
    const kardex = [m('IN', '20', '2026-09-01'), m('IN', '100', '2026-09-01')];
    // 120 − 100 = 20, + 60 = 80: el mínimo es el de después de la reversa.
    expect(minRunningAfterReplace(kardex, '2026-09-01', D('100'), D('60')).toFixed(3)).toBe(
      '20.000',
    );
  });

  it('sin filas posteriores, el mínimo es el del propio reemplazo', () => {
    expect(
      minRunningAfterReplace(
        [m('IN', '100', '2026-09-01')],
        '2026-09-01',
        D('100'),
        D('40'),
      ).toFixed(3),
    ).toBe('0.000');
  });

  it('los ajustes de costo no mueven cantidad', () => {
    const kardex = [m('IN', '100', '2026-09-01'), m('ADJUST', '100', '2026-09-05')];
    expect(minRunningAfterReplace(kardex, '2026-09-01', D('100'), D('90')).toFixed(3)).toBe(
      '0.000',
    );
  });
});
