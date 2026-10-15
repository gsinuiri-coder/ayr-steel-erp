import { describe, expect, it } from 'vitest';
import { BACKDATE_NEGATIVE_STOCK } from '@ayr/shared';
import { errorBodyText, SERVER_DOWN_MESSAGE } from './api';

describe('cc54: errorBodyText (P2-3 de la revisión de cc53)', () => {
  const negativeStock = {
    action: 'Registrar esta salida',
    operationDate: '2026-09-03',
    item: 'SKU-A',
    qty: '12.000',
    unit: 'NIU',
    firstValidDate: '2026-09-10',
  };

  it('arma el rechazo de D-652 con los datos, sin depender del texto del API', () => {
    expect(
      errorBodyText(400, { code: BACKDATE_NEGATIVE_STOCK, message: 'otro texto', negativeStock }),
    ).toBe(
      'Registrar esta salida con fecha 03/09/2026 (12 u) dejaría el kardex de SKU-A en negativo ' +
        'en una fecha posterior. Puedes hacerlo con fecha 10/09/2026 o posterior.',
    );
  });

  it('sin fecha válida lo dice', () => {
    expect(
      errorBodyText(400, {
        code: BACKDATE_NEGATIVE_STOCK,
        negativeStock: { ...negativeStock, firstValidDate: null, unit: 'KGM', qty: '1.250' },
      }),
    ).toBe(
      'Registrar esta salida con fecha 03/09/2026 (1.25 kg) dejaría el kardex de SKU-A en ' +
        'negativo en una fecha posterior. No alcanza el stock ni con la fecha de hoy.',
    );
  });

  it('cualquier otro error sigue como antes', () => {
    expect(errorBodyText(400, { message: ['a', 'b'] })).toBe('a, b');
    expect(errorBodyText(500, {})).toBe(SERVER_DOWN_MESSAGE);
    expect(errorBodyText(400, { code: BACKDATE_NEGATIVE_STOCK, message: 'texto' })).toBe('texto');
  });
});
