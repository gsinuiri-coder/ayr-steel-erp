import { deriveOrderReadiness, deriveOrderStage, orderStageWhere } from './order-readiness';

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

/**
 * D-277: el estado que se muestra. El persistido `IN_PRODUCTION` lo pone la primera
 * producción y nadie lo quita al cerrar las OP: PED-000001..21 quedaban «En producción» con
 * todas sus órdenes cerradas y nada despachado (lectura de production del 2026-09-24).
 */
describe('deriveOrderStage (D-277)', () => {
  it.each([
    ['IN_PRODUCTION', 'LISTO', 'READY'],
    ['IN_PRODUCTION', 'LISTO_CON_FALTANTE', 'READY'],
    ['CONFIRMED', 'LISTO', 'READY'],
    ['IN_PRODUCTION', 'EN_PRODUCCION', 'IN_PRODUCTION'],
    ['CONFIRMED', 'EN_PRODUCCION', 'CONFIRMED'],
    ['CONFIRMED', 'SIN_PRODUCCION', 'CONFIRMED'],
    // Lo despachado manda: el comprobante no mueve el estado, el despacho sí.
    ['PARTIALLY_FULFILLED', 'LISTO', 'PARTIALLY_FULFILLED'],
    ['FULFILLED', 'LISTO', 'FULFILLED'],
    ['CANCELLED', 'LISTO', 'CANCELLED'],
  ] as const)('%s + %s → %s', (status, readiness, stage) => {
    expect(deriveOrderStage(status, readiness)).toBe(stage);
  });
});

describe('orderStageWhere (D-277)', () => {
  it('READY: confirmado o en producción, con alguna OP viva y ninguna sin cerrar', () => {
    expect(orderStageWhere('READY')).toEqual({
      status: { in: ['CONFIRMED', 'IN_PRODUCTION'] },
      AND: [
        {
          reservations: { some: { productionOrders: { some: { status: { not: 'CANCELLED' } } } } },
        },
        {
          NOT: {
            reservations: {
              some: { productionOrders: { some: { status: { in: ['DRAFT', 'IN_PROGRESS'] } } } },
            },
          },
        },
      ],
    });
  });

  it('IN_PRODUCTION y CONFIRMED excluyen lo que ya está listo', () => {
    const where = orderStageWhere('IN_PRODUCTION');
    expect(where.status).toBe('IN_PRODUCTION');
    expect(where.NOT).toEqual({ AND: orderStageWhere('READY').AND });
    expect(orderStageWhere('CONFIRMED').status).toBe('CONFIRMED');
  });

  it('el resto filtra por el estado persistido', () => {
    expect(orderStageWhere('FULFILLED')).toEqual({ status: 'FULFILLED' });
  });
});
