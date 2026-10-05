import { z } from 'zod';
import { operationDateSchema } from './operation';
import { SALES_BY_MATERIAL_LINES } from './report-lines';

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
export const SALES_MATERIAL_KINDS = [
  'COBERTURA',
  'ACCESORIO',
  'BOBINA',
  'PLANCHA',
  'PERFIL',
] as const;
export type SalesMaterialKind = (typeof SALES_MATERIAL_KINDS)[number];

export const SALES_MATERIAL_KIND_LABELS: Record<SalesMaterialKind, string> = {
  COBERTURA: 'Coberturas',
  ACCESORIO: 'Accesorios',
  BOBINA: 'Bobinas (venta entera)',
  PLANCHA: 'Planchas',
  // cc24 (D-414): los perfiles de Drywall que se fabrican desde fleje.
  PERFIL: 'Perfiles',
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
    /** cc24 (D-406, D-407): la pestaña; sin ella, Coberturas Aluzinc. */
    businessLine: z.enum(SALES_BY_MATERIAL_LINES).optional(),
    kind: z.enum(SALES_MATERIAL_KINDS).optional(),
    /** Espesor del producto vendido, en mm (`0.30`). */
    thicknessMm: thicknessFilterSchema.optional(),
    /** Color comercial del producto vendido, por su etiqueta (la que muestra la fila). */
    color: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type SalesByMaterialQuery = z.infer<typeof salesByMaterialQuerySchema>;

/**
 * D-370 — nivel 2 del desglose: lo que un comprobante se llevó de una bobina dentro de una fila.
 * Una nota de crédito aparece como su propio comprobante, con kilos y metros negativos.
 */
export const salesMaterialCoilDocumentSchema = z.object({
  documentId: z.string().uuid(),
  documentNumber: z.string().nullable(),
  issueDate: z.string(),
  customerName: z.string(),
  /** Kilos de la bobina atribuidos a las líneas de este comprobante (prorrateados). */
  kg: z.string(),
  /** Metros lineales de la bobina atribuidos a esas líneas. */
  meters: z.string(),
});
export type SalesMaterialCoilDocumentDto = z.infer<typeof salesMaterialCoilDocumentSchema>;

/** Kilos y costo de una bobina dentro de una fila (nivel 1 del desglose, D-370). */
export const salesMaterialCoilSchema = z.object({
  coilId: z.string().uuid(),
  code: z.string(),
  /** RF-14: tipo de bobina (acabado + espesor), el mismo «Tipo» del listado de bobinas. */
  typeKey: z.string(),
  /** Espesor y color **de la bobina**: por tolerancia (±0,02 mm, D-086) pudo usarse otra. */
  thicknessMm: z.string(),
  colorLabel: z.string(),
  kg: z.string(),
  /** D-369: el teórico de esos metros con la geometría de la bobina, sin el 1 % de D-165. */
  theoreticalKg: z.string(),
  meters: z.string(),
  /** Costo de kardex de los kilos consumidos (el dato principal). */
  costPen: z.string(),
  /** Costo promedio por kg de la bobina en su saldo de kardex (dato secundario). */
  avgCostPen: z.string().nullable(),
  documents: z.array(salesMaterialCoilDocumentSchema),
});
export type SalesMaterialCoilDto = z.infer<typeof salesMaterialCoilSchema>;

/** Las columnas de la planilla del cliente. Se repiten en filas, subtotales y total. */
export const salesMaterialFiguresSchema = z.object({
  /** Metros lineales vendidos (planchas: cantidad × largo; bobina entera: ML teórico). */
  metersSold: z.string(),
  /**
   * D-369: suma del teórico de las bobinas que alimentaron la venta —metros rolados de cada una
   * × ancho × espesor de **la bobina** × densidad cruda del acabado—, sin el 1 % de D-165. En
   * una bobina entera, sus propios kilos.
   */
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
  /** C06: venta sin IGV ÷ ML vendido. Null sin metros («—»). */
  pricePerMeterPen: z.string().nullable(),
  /** C06: costo ÷ ML vendido. */
  costPerMeterPen: z.string().nullable(),
  /** C06: (venta − costo) ÷ ML vendido. */
  marginPerMeterPen: z.string().nullable(),
  /** C06: unidad de venta de lo sumado (`MTR`, `NIU`, `KGM`); null si se mezclan unidades. */
  unit: z.string().nullable(),
  /** C06: cantidad vendida en esa unidad; null si se mezclan unidades. */
  qty: z.string().nullable(),
  /** C06: costo promedio por unidad de venta (costo ÷ cantidad); null con cantidad 0 o unidades mezcladas. */
  costPerUnitPen: z.string().nullable(),
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

/**
 * cc24 (D-417): por qué la venta de un producto sin bobina (Coberturas UPVC, Reventa) no tiene
 * costo trazable.
 *
 * - `SIN_DESPACHO_DECLARADO`: ningún despacho declara el comprobante (D-205/D-213), así que no se
 *   sabe qué salida de kardex le corresponde.
 * - `DESPACHO_PARCIAL`: se despachó, contra ese comprobante, menos de lo facturado; la parte
 *   despachada sí se traza.
 * - `NOTA_CREDITO`: la nota de crédito resta venta; el costo vuelve, si vuelve, con la reversa
 *   del despacho del comprobante que afecta.
 * - `SIN_SALIDA_KARDEX`: el despacho declarado tiene ítems sin salida de kardex (D-285): con
 *   costo 0 el margen sería del 100 %.
 */
export const SALES_PRODUCT_UNTRACEABLE_REASONS = [
  'SIN_DESPACHO_DECLARADO',
  'DESPACHO_PARCIAL',
  'NOTA_CREDITO',
  'SIN_SALIDA_KARDEX',
] as const;
export type SalesProductUntraceableReason = (typeof SALES_PRODUCT_UNTRACEABLE_REASONS)[number];

export const SALES_PRODUCT_UNTRACEABLE_LABELS: Record<SalesProductUntraceableReason, string> = {
  SIN_DESPACHO_DECLARADO: 'Ningún despacho declara el comprobante',
  DESPACHO_PARCIAL: 'Despacho parcial: la parte no despachada',
  NOTA_CREDITO: 'Nota de crédito (resta venta)',
  SIN_SALIDA_KARDEX: 'Despachado sin salida de kardex',
};

/** cc24 (D-417): una fila por producto, con el costo de kardex de lo despachado. */
export const salesProductRowSchema = z.object({
  sku: z.string(),
  name: z.string(),
  /** Unidad de venta (`MTR`, `NIU`, `KGM`…). */
  unit: z.string(),
  /** Cantidad trazada, en la unidad de venta. */
  qty: z.string(),
  salesPen: z.string(),
  costPen: z.string(),
  profitPen: z.string(),
  /** Costo ÷ cantidad; null con cantidad 0. */
  costPerUnitPen: z.string().nullable(),
  /** Cuántas líneas de comprobante suman en la fila. */
  lineCount: z.number().int(),
});
export type SalesProductRowDto = z.infer<typeof salesProductRowSchema>;

export const salesProductUntraceableSchema = z.object({
  reason: z.enum(SALES_PRODUCT_UNTRACEABLE_REASONS),
  documentId: z.string().uuid(),
  documentNumber: z.string().nullable(),
  issueDate: z.string(),
  orderCode: z.string().nullable(),
  sku: z.string(),
  unit: z.string(),
  qty: z.string(),
  salesPen: z.string(),
});
export type SalesProductUntraceableDto = z.infer<typeof salesProductUntraceableSchema>;

export const salesByProductSchema = z.object({
  rows: z.array(salesProductRowSchema),
  total: z.object({ salesPen: z.string(), costPen: z.string(), profitPen: z.string() }),
  untraceable: z.array(salesProductUntraceableSchema),
});
export type SalesByProductDto = z.infer<typeof salesByProductSchema>;

export const salesByMaterialSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** cc24: la línea del reporte (la pestaña). */
  businessLine: z.enum(SALES_BY_MATERIAL_LINES),
  rows: z.array(salesMaterialRowSchema),
  subtotals: z.array(salesMaterialSubtotalSchema),
  /** Total de las filas trazables. */
  total: salesMaterialFiguresSchema,
  untraceable: z.array(salesMaterialUntraceableSchema),
  untraceableSalesPen: z.string(),
  /**
   * Cuadre con «Ventas y margen», sin filtros de tipo/espesor/color, en dos partes (D-354,
   * D-413): la venta de los productos de la línea (trazable + no trazable + sin subtipo), que es
   * la de la línea en «Ventas y margen», y la de las bobinas enteras de la línea, que allá caen
   * en `trading` (D-247). Una venta de bobina entera cuya línea de pedido no apunta a una bobina
   * no se puede atribuir a una línea de negocio y no entra.
   *
   * `unclassifiedSalesPen`: venta de productos de la línea que no entran a las filas: en
   * Coberturas Aluzinc, sin subtipo de cobertura (el CHECK del catálogo admite `roofing_kind`
   * nulo); en Drywall, los comprados (D-414). Cuenta en el cuadre y no en las filas.
   */
  reconciliation: z.object({
    lineSalesPen: z.string(),
    /**
     * Alias de `lineSalesPen` con el nombre anterior a cc24, solo para que la web vieja no se
     * rompa entre el deploy de la API y el merge (convivencia de versiones). Retirarlo en la
     * pieza siguiente.
     */
    roofingSalesPen: z.string().optional(),
    coilSalesPen: z.string(),
    unclassifiedSalesPen: z.string(),
  }),
  /**
   * D-407: venta del rango en líneas de comprobante sin producto (texto libre). No tiene línea
   * de negocio (D-398) ni entra a ninguna pestaña; se declara con un aviso.
   */
  noLineSalesPen: z.string(),
  /**
   * cc24 (D-417): en Coberturas (UPVC) y Reventa, las filas por producto; `null` en las pestañas
   * por material. En esas pestañas `rows`, `subtotals` y `untraceable` van vacíos y
   * `untraceableSalesPen` es la venta no trazable de los productos.
   */
  products: salesByProductSchema.nullable(),
});
export type SalesByMaterialDto = z.infer<typeof salesByMaterialSchema>;
