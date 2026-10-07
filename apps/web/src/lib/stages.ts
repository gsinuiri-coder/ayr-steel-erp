import type { OrderStage, QuotationStatus } from '@ayr/shared';

/**
 * cc31: las etapas de los documentos con recorrido (ESPEC §4). `current` es el índice de la etapa
 * en curso; `steps.length` cuando el recorrido terminó (todas hechas) y `null` cuando el documento
 * salió de él (anulado o vencido): ahí ninguna etapa está en curso y el estado lo dice la etiqueta.
 */
export interface StagesState {
  steps: string[];
  current: number | null;
}

const QUOTATION_STEPS = ['Borrador', 'Emitida', 'Confirmada'];

export function quotationStages(status: QuotationStatus): StagesState {
  const current: Record<QuotationStatus, number | null> = {
    DRAFT: 0,
    EMITTED: 1,
    CONFIRMED: QUOTATION_STEPS.length,
    EXPIRED: null,
    CANCELLED: null,
  };
  return { steps: QUOTATION_STEPS, current: current[status] };
}

const ORDER_STEPS = ['Confirmado', 'En producción', 'Listo', 'Atendido'];

/**
 * El pedido por su etapa (D-277). «Atendido en parte» está despachando: la última etapa en curso.
 * Un pedido que no pasa por producción salta de «Confirmado» a «Listo» y la etapa intermedia queda
 * como hecha: el recorrido es el mismo para todos.
 */
export function orderStages(stage: OrderStage): StagesState {
  const current: Record<OrderStage, number | null> = {
    CONFIRMED: 0,
    IN_PRODUCTION: 1,
    READY: 2,
    PARTIALLY_FULFILLED: 3,
    FULFILLED: ORDER_STEPS.length,
    CANCELLED: null,
  };
  return { steps: ORDER_STEPS, current: current[stage] };
}
