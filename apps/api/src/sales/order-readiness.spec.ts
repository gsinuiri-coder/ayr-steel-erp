import { deriveOrderReadiness } from './order-readiness';

describe('deriveOrderReadiness', () => {
  it.each([
    // Sin OPs
    [[], 'SIN_PRODUCCION', '0.000', '0.000'],

    // OPs canceladas
    [
      [{ status: 'CANCELLED', orderedMl: '10', reportedMl: '10' }],
      'SIN_PRODUCCION',
      '0.000',
      '0.000',
    ],

    // Producción normal
    [
      [{ status: 'IN_PROGRESS', orderedMl: '10.500', reportedMl: '4.000' }],
      'EN_PRODUCCION',
      '10.500',
      '4.000',
    ],

    // Listo perfecto
    [
      [{ status: 'CLOSED', orderedMl: '10.000', reportedMl: '10.000' }],
      'LISTO',
      '10.000',
      '10.000',
    ],

    // Cierre corto (LISTO_CON_FALTANTE)
    [
      [{ status: 'CLOSED', orderedMl: '10.000', reportedMl: '8.000' }],
      'LISTO_CON_FALTANTE',
      '10.000',
      '8.000',
    ],

    // Añadir ítems tras LISTO (hay DRAFT o IN_PROGRESS nuevas)
    [
      [
        { status: 'CLOSED', orderedMl: '10.000', reportedMl: '10.000' },
        { status: 'DRAFT', orderedMl: '5.000', reportedMl: '0.000' },
      ],
      'EN_PRODUCCION',
      '15.000',
      '10.000',
    ],

    // Reapertura D-193 (Vuelve a EN_PRODUCCION por OP viva)
    [
      [
        { status: 'CLOSED', orderedMl: '10.000', reportedMl: '10.000' },
        { status: 'IN_PROGRESS', orderedMl: '5.000', reportedMl: '2.000' },
      ],
      'EN_PRODUCCION',
      '15.000',
      '12.000',
    ],

    // Múltiples OPs vivas
    [
      [
        { status: 'CLOSED', orderedMl: '10.000', reportedMl: '9.000' },
        { status: 'CLOSED', orderedMl: '10.000', reportedMl: '10.000' },
      ],
      'LISTO_CON_FALTANTE',
      '20.000',
      '19.000',
    ],
  ] as const)('deriva %j a %s con %s / %s', (orders, status, ordered, reported) => {
    const res = deriveOrderReadiness([...orders]);
    expect(res.status).toBe(status);
    expect(res.orderedMl).toBe(ordered);
    expect(res.reportedMl).toBe(reported);
  });
});
