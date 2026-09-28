import { z } from 'zod';
import { operationDateSchema } from './operation';

/**
 * D-354 — «Ventas por material» de Coberturas Aluzinc (correcciones 05, punto 5).
 *
 * Una fila por tipo × espesor × color del **producto vendido**. El universo es el de «Ventas y
 * margen» (comprobantes vivos por fecha de emisión, netos de notas de crédito), así que la venta
 * cuadra por construcción. El peso real y el costo salen de los movimientos de kardex de las
 * bobinas que consumió la producción de cada línea de pedido (reportes de la OP + despunte al
 * cerrarla, D-089), prorrateados por lo facturado neto ÷ lo producido de la línea. Lo que no se
 * puede trazar va aparte, con su motivo, y nunca se estima (criterio de D-243).
 */
export const SALES_MATERIAL_KINDS = ['COBERTURA', 'ACCESORIO', 'BOBINA', 'PLANCHA'] as const;
export type SalesMaterialKind = (typeof SALES_MATERIAL_KINDS)[number];

export const SALES_MATERIAL_KIND_LABELS: Record<SalesMaterialKind, string> = {
  COBERTURA: 'Coberturas',
  ACCESORIO: 'Accesorios',
  BOBINA: 'Bobinas (venta entera)',
  PLANCHA: 'Planchas',
};

/**
 * Por qué una porción de venta no tiene peso real ni costo trazable.
 *
 * - `SIN_PRODUCCION`: la línea se facturó y todavía no se produjo nada para ella.
 * - `PRODUCCION_PARCIAL`: se facturó más de lo que se produjo; la parte producida sí se traza.
 * - `DESDE_STOCK`: la línea se despachó sin OP propia (planchas de una corrida a stock, D-140):
 *   el material de esa corrida no pertenece a ningún pedido.
 * - `SIN_PEDIDO`: la línea del comprobante no apunta a una línea de pedido.
 * - `SIN_DESPACHO`: una bobina vendida entera que todavía no salió del almacén (o solo en parte).
 * - `SIN_METRO`: la unidad de venta no se convierte a metros (una plancha en kilos, una en piezas
 *   sin largo en el SKU, una bobina sin geometría): no hay ML ni una base de producción comparable.
 */
export const SALES_MATERIAL_UNTRACEABLE_REASONS = [
  'SIN_PRODUCCION',
  'PRODUCCION_PARCIAL',
  'DESDE_STOCK',
  'SIN_PEDIDO',
  'SIN_DESPACHO',
  'SIN_METRO',
] as const;
export type SalesMaterialUntraceableReason = (typeof SALES_MATERIAL_UNTRACEABLE_REASONS)[number];

export const SALES_MATERIAL_UNTRACEABLE_LABELS: Record<SalesMaterialUntraceableReason, string> = {
  SIN_PRODUCCION: 'Sin producción aún',
  PRODUCCION_PARCIAL: 'Producción parcial: la parte no producida',
  DESDE_STOCK: 'Atendida desde stock (sin OP propia)',
  SIN_PEDIDO: 'Sin línea de pedido vinculada',
  SIN_DESPACHO: 'Bobina sin despachar aún',
  SIN_METRO: 'Unidad sin conversión a metros lineales',
};

const thicknessFilterSchema = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Espesor inválido');

export const salesByMaterialQuerySchema = z
  .object({
    from: operationDateSchema,
    to: operationDateSchema,
    kind: z.enum(SALES_MATERIAL_KINDS).optional(),
    /** Espesor del producto vendido, en mm (`0.30`). */
    thicknessMm: thicknessFilterSchema.optional(),
    /** Color comercial del producto vendido, por su etiqueta (la que muestra la fila). */
    color: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type SalesByMaterialQuery = z.infer<typeof salesByMaterialQuerySchema>;

/** Kilos y costo de una bobina dentro de una fila (el modal «cuántas bobinas»). */
export const salesMaterialCoilSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  /** Espesor y color **de la bobina**: por tolerancia pudo usarse otra (0.38 para 0.40). */
  thicknessMm: z.string(),
  colorLabel: z.string(),
  kg: z.string(),
  costPen: z.string(),
});
export type SalesMaterialCoilDto = z.infer<typeof salesMaterialCoilSchema>;

/** Las columnas de la planilla del cliente. Se repiten en filas, subtotales y total. */
export const salesMaterialFiguresSchema = z.object({
  /** Metros lineales vendidos (planchas: cantidad × largo; bobina entera: ML teórico). */
  metersSold: z.string(),
  /** ML × kg/m del ancho, espesor y acabado del producto, con el 1 % de D-165. */
  theoreticalKg: z.string(),
  /** Kilos de bobina que consumió la producción de esas líneas (prorrateados). */
  realKg: z.string(),
  /** Teórico − real. Positivo: la producción rindió más que la geometría. */
  yieldKg: z.string(),
  /** `yieldKg ÷ teórico`, en puntos; null sin teórico. */
  yieldPct: z.string().nullable(),
  /** Venta sin IGV, neta de notas de crédito. */
  salesPen: z.string(),
  /** Costo de los kilos consumidos según el kardex de las bobinas. */
  costPen: z.string(),
  profitPen: z.string(),
  /** Costo ÷ peso real. Null sin peso real. */
  costPerKgPen: z.string().nullable(),
  /** Venta sin IGV ÷ peso real. */
  pricePerKgPen: z.string().nullable(),
  marginPerKgPen: z.string().nullable(),
});
export type SalesMaterialFiguresDto = z.infer<typeof salesMaterialFiguresSchema>;

export const salesMaterialRowSchema = salesMaterialFiguresSchema.extend({
  kind: z.enum(SALES_MATERIAL_KINDS),
  thicknessMm: z.string(),
  colorLabel: z.string(),
  /** Cuántas líneas de comprobante suman en la fila. */
  lineCount: z.number().int(),
  coils: z.array(salesMaterialCoilSchema),
});
export type SalesMaterialRowDto = z.infer<typeof salesMaterialRowSchema>;

export const salesMaterialSubtotalSchema = salesMaterialFiguresSchema.extend({
  kind: z.enum(SALES_MATERIAL_KINDS),
});
export type SalesMaterialSubtotalDto = z.infer<typeof salesMaterialSubtotalSchema>;

/** Una porción de venta no trazable: una por línea de comprobante y motivo. */
export const salesMaterialUntraceableSchema = z.object({
  kind: z.enum(SALES_MATERIAL_KINDS),
  thicknessMm: z.string(),
  colorLabel: z.string(),
  reason: z.enum(SALES_MATERIAL_UNTRACEABLE_REASONS),
  documentId: z.string().uuid(),
  documentNumber: z.string().nullable(),
  issueDate: z.string(),
  orderCode: z.string().nullable(),
  sku: z.string(),
  metersSold: z.string(),
  salesPen: z.string(),
});
export type SalesMaterialUntraceableDto = z.infer<typeof salesMaterialUntraceableSchema>;

export const salesByMaterialSchema = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(salesMaterialRowSchema),
  subtotals: z.array(salesMaterialSubtotalSchema),
  /** Total de las filas trazables. */
  total: salesMaterialFiguresSchema,
  untraceable: z.array(salesMaterialUntraceableSchema),
  untraceableSalesPen: z.string(),
  /**
   * Cuadre con «Ventas y margen», sin filtros de tipo/espesor/color: la venta de las líneas de
   * Coberturas Aluzinc (coberturas, accesorios y planchas, trazable + no trazable) y la de las
   * bobinas enteras de Coberturas Aluzinc, que allá caen en la línea `trading` (D-247). Una
   * venta de bobina entera cuya línea de pedido no apunta a una bobina no se puede atribuir a
   * una línea de negocio y no entra.
   *
   * `unclassifiedSalesPen`: venta de productos de la línea sin subtipo de cobertura (el CHECK
   * del catálogo admite `roofing_kind` nulo). Cuenta en el cuadre y no en las filas.
   */
  reconciliation: z.object({
    roofingSalesPen: z.string(),
    coilSalesPen: z.string(),
    unclassifiedSalesPen: z.string(),
  }),
});
export type SalesByMaterialDto = z.infer<typeof salesByMaterialSchema>;
