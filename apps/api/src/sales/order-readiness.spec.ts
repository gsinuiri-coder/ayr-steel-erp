import { deriveOrderReadiness } from './order-readiness';

describe('deriveOrderReadiness', () => {
  it.each([
    [[], 'SIN_PRODUCCION'],
    [[{ status: 'IN_PROGRESS', orderedMl: '10', reportedMl: '4' }], 'EN_PRODUCCION'],
    [[{ status: 'CLOSED', orderedMl: '10', reportedMl: '10' }], 'LISTO'],
    [[{ status: 'CLOSED', orderedMl: '10', reportedMl: '4' }], 'LISTO_CON_FALTANTE'],
    [[{ status: 'CANCELLED', orderedMl: '10', reportedMl: '10' }], 'SIN_PRODUCCION'],
  ] as const)('deriva %s', (orders, status) => { expect(deriveOrderReadiness([...orders]).status).toBe(status); },
  );
});
