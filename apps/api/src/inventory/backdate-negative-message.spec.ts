import { backdateNegativeStockMessage, dayMonthYear } from '@ayr/shared';

/**
 * cc54 (P2-3 y P3-3 de la revisión de cc53): el texto del rechazo de D-652 vive en `@ayr/shared`
 * (lo usan el API y la web). Se prueba desde la API, que es la que mide la cobertura de shared.
 */
describe('backdateNegativeStockMessage', () => {
  const base = {
    action: 'Registrar esta salida',
    operationDate: '2026-09-03',
    item: 'SKU-A',
    qty: '12.000',
    unit: 'NIU',
    firstValidDate: '2026-09-10',
  };

  it('fechas DD/MM/YYYY, cantidad sin ceros de relleno y unidad corta', () => {
    expect(backdateNegativeStockMessage(base)).toBe(
      'Registrar esta salida con fecha 03/09/2026 (12 u) dejaría el kardex de SKU-A en negativo ' +
        'en una fecha posterior. Puedes hacerlo con fecha 10/09/2026 o posterior.',
    );
  });

  it('dice qué entrada se saca y por qué (anulación, fecha recibida, cambio de producto)', () => {
    const text = backdateNegativeStockMessage({
      ...base,
      action: 'Sacar del kardex la entrada del 01/08/2026 («corrección de fecha»)',
      qty: '2.500',
      unit: 'KGM',
      firstValidDate: null,
    });
    expect(text).toBe(
      'Sacar del kardex la entrada del 01/08/2026 («corrección de fecha») con fecha 03/09/2026 ' +
        '(2.5 kg) dejaría el kardex de SKU-A en negativo en una fecha posterior. No alcanza el ' +
        'stock ni con la fecha de hoy.',
    );
  });

  it('una unidad sin abreviatura o una cantidad entera quedan tal cual', () => {
    expect(backdateNegativeStockMessage({ ...base, unit: 'ZZ', qty: '7' })).toContain('(7 ZZ)');
  });

  it('dayMonthYear solo convierte YYYY-MM-DD', () => {
    expect(dayMonthYear('2026-10-15')).toBe('15/10/2026');
    expect(dayMonthYear('hoy')).toBe('hoy');
  });
});
