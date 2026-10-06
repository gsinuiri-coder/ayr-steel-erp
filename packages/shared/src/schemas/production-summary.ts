import { z } from 'zod';
import { operationDateSchema } from './operation';
import { COIL_REPORT_LINES } from './report-lines';

/* ------------------------------------------------------------------------------------- *
 * cc29 (M2, D-420, D-464, D-468) — Reporte de producción.
 *
 * Una fila por OP (que es un producto y una línea del pedido, D-464), con el detalle por bobina
 * de lo que sus reportes sacaron según el kardex, y un subtotal por pedido. Pestañas Coberturas
 * Aluzinc y Drywall, como la merma (D-424). Solo lectura: no escribe nada.
 *
 * Las cifras son las de los movimientos de kardex **vivos** del rango (ni anulados ni la anulación
 * de otro), por su fecha de operación, que es la del reporte de planta que los generó:
 *
 * - kg salido: las salidas `PRODUCTION` de la OP (la suma, bobina por bobina, de lo que sacaron
 *   sus reportes);
 * - kg teórico: el teórico de esos reportes (D-047), por OP, sin repartir entre bobinas (D-433);
 * - despunte: las salidas `SCRAP` del cierre de la OP (D-057, D-089). Es un total de la OP; por
 *   bobina va solo como lo registró el kardex, «repartido en orden de montaje», sin reasignar
 *   nada (D-433);
 * - % sobre el estándar = (salido − teórico + despunte) ÷ teórico (D-434: el teórico ya lleva el
 *   1 % normal), en rojo pasado el 1 %.
 *
 * El ajuste de cierre de una bobina (D-164) no es de ninguna línea: no entra acá, queda en la
 * merma por bobina. Los costos (valor de lo salido y del despunte) solo van al administrador.
 * ------------------------------------------------------------------------------------- */

export type ProductionSummaryLine = (typeof COIL_REPORT_LINES)[number];

export const productionSummaryQuerySchema = z
  .object({
    from: operationDateSchema,
    to: operationDateSchema,
    /** La pestaña; sin ella, Coberturas Aluzinc (D-418). */
    businessLine: z.enum(COIL_REPORT_LINES).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type ProductionSummaryQuery = z.infer<typeof productionSummaryQuerySchema>;

/** Lo que la OP sacó de una bobina en el rango. */
export const productionSummaryCoilSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  /** Salidas `PRODUCTION` de la OP desde esta bobina. */
  consumedKg: z.string(),
  /** El despunte de la OP como lo registró el kardex en esta bobina (repartido en orden de montaje). */
  trimKg: z.string(),
});
export type ProductionSummaryCoilDto = z.infer<typeof productionSummaryCoilSchema>;

/** Las cifras de una OP, de un pedido o del total. */
const figuresShape = {
  theoreticalKg: z.string(),
  consumedKg: z.string(),
  trimKg: z.string(),
  /** D-434: (salido − teórico + despunte) ÷ teórico, dos decimales; `null` con teórico cero. */
  wastePct: z.string().nullable(),
  /** D-434: pasa la tolerancia del 1 % sobre el estándar. */
  overStandard: z.boolean(),
  /** Solo el administrador: el valor de lo salido y del despunte. `null` para el supervisor. */
  materialCostPen: z.string().nullable(),
  trimCostPen: z.string().nullable(),
};

export const productionSummaryOrderSchema = z.object({
  productionOrderId: z.string().uuid(),
  /** `OP-000123`. */
  code: z.string(),
  status: z.string(),
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  /** El número de línea del pedido; `null` en una corrida a stock. */
  lineNumber: z.number().int().nullable(),
  productId: z.string().uuid(),
  productSku: z.string(),
  productName: z.string(),
  /** Lo producido en el rango: metros (producto en MTR) o piezas. */
  quantity: z.string(),
  quantityUnit: z.enum(['m', 'pzs']),
  reportCount: z.number().int(),
  ...figuresShape,
  coils: z.array(productionSummaryCoilSchema),
});
export type ProductionSummaryOrderDto = z.infer<typeof productionSummaryOrderSchema>;

export const productionSummaryGroupSchema = z.object({
  /** `null`: las corridas a stock, sin pedido. */
  salesOrderId: z.string().uuid().nullable(),
  salesOrderCode: z.string().nullable(),
  orders: z.array(productionSummaryOrderSchema),
  subtotal: z.object(figuresShape),
});
export type ProductionSummaryGroupDto = z.infer<typeof productionSummaryGroupSchema>;

export const productionSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  businessLine: z.enum(COIL_REPORT_LINES),
  standardPct: z.string(),
  /** Si las cifras llevan costos (solo el administrador). */
  withCosts: z.boolean(),
  /** Por pedido (el correlativo), y al final las corridas sin pedido. */
  groups: z.array(productionSummaryGroupSchema),
  totals: z.object({
    orderCount: z.number().int(),
    ...figuresShape,
    /**
     * Salidas `PRODUCTION` del rango que no apuntan a un reporte de planta: no son de ninguna OP,
     * pero son kardex de producción del rango y se declaran para que el total cuadre.
     */
    unattributedKg: z.string(),
  }),
});
export type ProductionSummaryDto = z.infer<typeof productionSummarySchema>;
