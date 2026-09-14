import { addBusinessDays, capToQuotationValidity, temporaryReservationExpiry } from '@ayr/shared';

/**
 * D-185: el vencimiento de una reserva temporal. Es aritmética de calendario sin
 * compilador que la proteja: un día de más o de menos pasa todos los tipos.
 */
describe('reserva temporal — días hábiles (D-185)', () => {
  it('no cuenta el día de partida y salta el fin de semana', () => {
    // 2026-09-11 es viernes: tres días hábiles son lunes, martes y miércoles.
    expect(addBusinessDays('2026-09-11', 3)).toBe('2026-09-16');
    // Un sábado arranca a contar desde el lunes.
    expect(addBusinessDays('2026-09-12', 1)).toBe('2026-09-14');
    // Un lunes con tres días hábiles vence el jueves.
    expect(addBusinessDays('2026-09-14', 3)).toBe('2026-09-17');
  });

  it('vence al final del último día hábil en Lima, no en UTC', () => {
    // Martes 15 a las 20:00 de Lima (01:00 UTC del miércoles): el día de negocio es el 15.
    const now = new Date('2026-09-16T01:00:00.000Z');
    const expiry = temporaryReservationExpiry(3, now);
    expect(expiry.toISOString()).toBe('2026-09-19T04:59:59.999Z');
  });

  // F8-S4/M0: acortar la vigencia al editar tiene que acortar la reserva.
  describe('nunca vence después que la cotización', () => {
    const byBusinessDays = new Date('2026-09-19T04:59:59.999Z'); // fin del 18 en Lima

    it('una vigencia que termina antes recorta al fin de ese día en Lima', () => {
      expect(capToQuotationValidity(byBusinessDays, '2026-09-16').toISOString()).toBe(
        '2026-09-17T04:59:59.999Z',
      );
    });

    it('una vigencia que termina después o el mismo día no estira nada', () => {
      expect(capToQuotationValidity(byBusinessDays, '2026-09-30')).toBe(byBusinessDays);
      expect(capToQuotationValidity(byBusinessDays, '2026-09-18')).toBe(byBusinessDays);
    });

    it('sin vencimiento (D-157) no recorta', () => {
      expect(capToQuotationValidity(byBusinessDays, null)).toBe(byBusinessDays);
    });
  });
});
