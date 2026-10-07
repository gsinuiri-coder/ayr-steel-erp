import { describe, expect, it } from 'vitest';
import { orderStages, quotationStages } from './stages';

/** cc31: las etapas de cotización y pedido (ESPEC §4). */
describe('etapas de un documento', () => {
  it('la cotización: borrador, emitida, confirmada; anulada o vencida salen del recorrido', () => {
    expect(quotationStages('DRAFT').current).toBe(0);
    expect(quotationStages('EMITTED').current).toBe(1);
    expect(quotationStages('CONFIRMED').current).toBe(3);
    expect(quotationStages('CANCELLED').current).toBeNull();
    expect(quotationStages('EXPIRED').current).toBeNull();
  });

  it('el pedido sigue su etapa y termina atendido', () => {
    expect(orderStages('CONFIRMED')).toEqual({
      steps: ['Confirmado', 'En producción', 'Listo', 'Atendido'],
      current: 0,
    });
    expect(orderStages('READY').current).toBe(2);
    expect(orderStages('PARTIALLY_FULFILLED').current).toBe(3);
    expect(orderStages('FULFILLED').current).toBe(4);
    expect(orderStages('CANCELLED').current).toBeNull();
  });
});
