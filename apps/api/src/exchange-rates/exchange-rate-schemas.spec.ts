import { getExchangeRateQuerySchema, upsertManualExchangeRateSchema } from '@ayr/shared';

/**
 * cc34 (pendiente de cc33): la fecha del tipo de cambio tiene que existir en el calendario, no solo
 * tener el formato. `2026-09-31` pasaba la expresión regular y `new Date` la corría al 1 de octubre.
 */
describe('fecha del tipo de cambio', () => {
  it.each(['2026-02-31', '2026-09-31', '2026-08-32', '2026-13-01'])(
    '%s no existe: se rechaza al consultar y al registrar a mano',
    (date) => {
      const query = getExchangeRateQuerySchema.safeParse({ date, currency: 'USD' });
      expect(query.success).toBe(false);
      expect(JSON.stringify(query.error?.issues)).toContain('no existe en el calendario');
      const manual = upsertManualExchangeRateSchema.safeParse({
        date,
        currency: 'USD',
        buy: '3.7000',
        sell: '3.7100',
      });
      expect(manual.success).toBe(false);
    },
  );

  it.each(['2026-09-30', '2028-02-29'])('%s existe: pasa', (date) => {
    expect(getExchangeRateQuerySchema.safeParse({ date, currency: 'USD' }).success).toBe(true);
  });

  it('el formato sigue validándose con su mensaje', () => {
    const r = getExchangeRateQuerySchema.safeParse({ date: '30/09/2026', currency: 'USD' });
    expect(JSON.stringify(r.error?.issues)).toContain('Formato de fecha inválido');
  });
});
