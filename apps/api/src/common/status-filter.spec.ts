import {
  NEGATIVE_TERMINAL_STATUSES,
  quotationQuerySchema,
  salesOrderQuerySchema,
  statusCondition,
} from '@ayr/shared';
import { orderStagesWhere } from '../sales/order-readiness';

// D-289: filtro de estado múltiple y default que omite los terminales negativos.
describe('statusListSchema (vía las consultas de lista)', () => {
  it('acepta un estado, varios separados por coma y la forma repetida de Express', () => {
    expect(quotationQuerySchema.parse({ status: 'EMITTED' }).status).toEqual(['EMITTED']);
    expect(quotationQuerySchema.parse({ status: 'EMITTED,CANCELLED' }).status).toEqual([
      'EMITTED',
      'CANCELLED',
    ]);
    expect(quotationQuerySchema.parse({ status: ['DRAFT', 'EXPIRED'] }).status).toEqual([
      'DRAFT',
      'EXPIRED',
    ]);
  });

  it('un valor vacío o ausente equivale a no filtrar', () => {
    expect(quotationQuerySchema.parse({}).status).toBeUndefined();
    expect(quotationQuerySchema.parse({ status: '' }).status).toBeUndefined();
  });

  it('rechaza un estado que no existe', () => {
    expect(quotationQuerySchema.safeParse({ status: 'EMITTED,NOPE' }).success).toBe(false);
  });

  it('`stage` de pedidos acepta «Listo» junto a estados persistidos', () => {
    expect(salesOrderQuerySchema.parse({ stage: 'READY,FULFILLED' }).stage).toEqual([
      'READY',
      'FULFILLED',
    ]);
  });
});

describe('statusCondition', () => {
  const negatives = NEGATIVE_TERMINAL_STATUSES.salesOrder;

  it('con estados explícitos manda `in`, aunque incluyan un terminal negativo', () => {
    expect(statusCondition(['CANCELLED'], negatives, false)).toEqual({ in: ['CANCELLED'] });
  });

  it('sin estados omite los terminales negativos', () => {
    expect(statusCondition(undefined, negatives, false)).toEqual({ notIn: ['CANCELLED'] });
  });

  it('sin estados y con búsqueda (o acotado a un padre) no filtra', () => {
    expect(statusCondition(undefined, negatives, true)).toBeUndefined();
  });

  it('un comprobante RECHAZADO sigue en la bandeja: se corrige y reenvía', () => {
    const negs: readonly string[] = NEGATIVE_TERMINAL_STATUSES.fiscalDocument;
    expect(negs).toEqual(['VOIDED', 'ANNULLED']);
    expect(negs).not.toContain('REJECTED');
  });
});

describe('orderStagesWhere', () => {
  it('con un solo estado es la condición de siempre', () => {
    expect(orderStagesWhere(['FULFILLED'])).toEqual({ status: 'FULFILLED' });
  });

  it('con varios los une en AND/OR sin usar el OR de la raíz (lo usa la búsqueda)', () => {
    const where = orderStagesWhere(['FULFILLED', 'CANCELLED']);
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([{ OR: [{ status: 'FULFILLED' }, { status: 'CANCELLED' }] }]);
  });
});
