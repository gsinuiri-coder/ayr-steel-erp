import { z } from 'zod';
import {
  BUSINESS_LINES,
  COIL_KINDS,
  COIL_STATUSES,
  FISCAL_DOCUMENT_ORIGINS,
  FISCAL_DOCUMENT_STATUSES,
  FISCAL_DOC_TYPES,
} from '../enums';
import { FINISH_KIND_LABELS } from './finish';
import { monthSchema, operationDateSchema } from './operation';

/**
 * Reportes con corte mensual (RF-90..RF-94, adelanto de la Fase 7f).
 *
 * Existen recién ahora porque hasta D-124 no había con qué cortarlos: sin fecha de
 * operación, todo lo registrado quedaba fechado el día en que se tipeó y un reporte de
 * agosto no podía distinguirse de uno de septiembre.
 */
export const coilMonthReportQuerySchema = z.object({
  /** Mes del corte, `YYYY-MM`. Por defecto, el mes en curso en Lima. */
  month: monthSchema.optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type CoilMonthReportQuery = z.infer<typeof coilMonthReportQuerySchema>;

export const coilMonthReportRowSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  /** RF-14: acabado + espesor, sin ancho. */
  typeKey: z.string(),
  kind: z.enum(COIL_KINDS),
  businessLine: z.enum(BUSINESS_LINES),
  colorName: z.string().nullable(),
  widthMm: z.string(),
  /**
   * Saldo de kardex al **primer día del mes**, antes de cualquier movimiento del mes. Es la
   * columna que el dueño pidió en lugar de la empresa proveedora: sale de sumar los
   * movimientos con \`operationDate\` anterior al corte, y por eso no existía antes de D-124.
   */
  openingKg: z.string(),
  /** Peso nominal con el que la bobina se dio de alta (RF-13). No cambia con los consumos. */
  weightKg: z.string(),
  /** Saldo de kardex al **último día del mes**. En el mes en curso, es el saldo de hoy. */
  closingKg: z.string(),
  /** Costo por kg del documento, sin IGV (D-038). `null` para quien no ve costos. */
  unitCostPerKg: z.string().nullable(),
  status: z.enum(COIL_STATUSES),
  /** D-124: día de negocio en que la bobina entró. */
  operationDate: z.string(),
});
export type CoilMonthReportRowDto = z.infer<typeof coilMonthReportRowSchema>;

export const coilMonthReportSchema = z.object({
  month: monthSchema,
  /** Primer y último día del mes, `YYYY-MM-DD`, para rotular el corte sin recalcularlo. */
  from: z.string(),
  to: z.string(),
  rows: z.array(coilMonthReportRowSchema),
  totals: z.object({
    openingKg: z.string(),
    weightKg: z.string(),
    closingKg: z.string(),
  }),
});
export type CoilMonthReportDto = z.infer<typeof coilMonthReportSchema>;

/* ------------------------------------------------------------------------------------- *
 * RF-S4a/M1 — Inventario valorizado a la fecha de corte.
 *
 * No reemplaza a `GET /inventory/summary` (RF-51) ni lo toca: ese sigue siendo la pantalla
 * operativa de una línea, abierta al vendedor con los costos enmascarados. Este responde
 * otra pregunta —cuánto vale todo el inventario hoy, agrupado como lo mira administración—
 * y por eso es **solo ADMINISTRADOR**: lleva costos en cada fila y no los enmascara nunca.
 *
 * El grano de agrupación también es distinto y por eso no se podía reusar el otro: las
 * bobinas van por **línea / espesor / color**, y el `typeKey` de RF-14 (acabado + espesor)
 * no sabe de color. Los productos van por SKU dentro de su línea.
 * ------------------------------------------------------------------------------------- */

/** Detalle de una bobina con saldo, dentro de su grupo. */
export const inventoryValuationCoilSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  typeKey: z.string(),
  kind: z.enum(COIL_KINDS),
  widthMm: z.string(),
  /** D-272: el acabado de la bobina y su RAL (D-270: el RAL vive en el acabado). */
  finishCode: z.string(),
  ral: z.string().nullable(),
  /** Saldo vigente de kardex, en kg. */
  qtyKg: z.string(),
  /** Costo promedio ponderado en soles (D-028, D-042). */
  avgCostPen: z.string(),
  /** `qtyKg × avgCostPen`. */
  totalValuePen: z.string(),
  /**
   * Se muestra porque una bobina con saldo que **no** está `OPEN` es una anomalía de datos
   * (D-164 liquida el remanente al cerrar), y el reporte la delata en vez de filtrarla:
   * filtrarla la escondería del total y rompería la conciliación contra el kardex.
   */
  status: z.enum(COIL_STATUSES),
  operationDate: z.string(),
});
export type InventoryValuationCoilDto = z.infer<typeof inventoryValuationCoilSchema>;

/**
 * D-272: el detalle de un grupo por acabado. Dentro de un color comercial (ROJO) cada acabado es
 * un RAL (3002, 3020): cuánto hay de cada uno y cuánto vale, sin cambiar el total del grupo.
 */
export const inventoryValuationFinishSchema = z.object({
  finishCode: z.string(),
  finishName: z.string(),
  ral: z.string().nullable(),
  coilCount: z.number().int(),
  qtyKg: z.string(),
  totalValuePen: z.string(),
});
export type InventoryValuationFinishDto = z.infer<typeof inventoryValuationFinishSchema>;

/**
 * Grupo de bobinas: línea / espesor / color comercial (D-272). Sin color, el grupo es el tipo
 * del acabado —NATURAL o GALVANIZADO, cada uno el suyo— y `colorName` va en `null`.
 */
export const inventoryValuationCoilGroupSchema = z.object({
  /** Clave estable del grupo, para el `key` de React y para el detalle plegable. */
  key: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  thicknessMm: z.string(),
  colorName: z.string().nullable(),
  /** D-272: el tipo del acabado cuando el grupo no tiene color; `null` si lo tiene. */
  finishKind: z.enum(['NATURAL', 'GALVANIZADO']).nullable(),
  /** D-272: el detalle por acabado (RAL), en orden de código. */
  finishes: z.array(inventoryValuationFinishSchema),
  coilCount: z.number().int(),
  qtyKg: z.string(),
  /**
   * Valor total / cantidad total, **no** promedio de promedios: dos bobinas del mismo
   * grupo con pesos distintos tienen que pesar distinto en el costo agregado.
   */
  avgCostPen: z.string(),
  totalValuePen: z.string(),
  coils: z.array(inventoryValuationCoilSchema),
});
export type InventoryValuationCoilGroupDto = z.infer<typeof inventoryValuationCoilGroupSchema>;

/**
 * D-272: cómo se nombra un grupo de bobinas. Con color, el color comercial; sin color, el tipo
 * del acabado (Natural, Galvanizado). La pantalla y el Excel lo dicen igual.
 */
export function coilGroupLabel(group: {
  colorName: string | null;
  finishKind: InventoryValuationCoilGroupDto['finishKind'];
}): string {
  if (group.colorName !== null) return group.colorName;
  return group.finishKind === null ? 'Sin color' : FINISH_KIND_LABELS[group.finishKind];
}

/** Producto de catálogo con stock. Una fila por SKU. */
export const inventoryValuationProductSchema = z.object({
  itemId: z.string().uuid(),
  businessLine: z.enum(BUSINESS_LINES),
  sku: z.string(),
  name: z.string(),
  qty: z.string(),
  unit: z.string(),
  avgCostPen: z.string(),
  totalValuePen: z.string(),
});
export type InventoryValuationProductDto = z.infer<typeof inventoryValuationProductSchema>;

/** Totales de una línea de negocio: bobinas, productos y su suma. */
export const inventoryValuationLineTotalSchema = z.object({
  businessLine: z.enum(BUSINESS_LINES),
  coilValuePen: z.string(),
  productValuePen: z.string(),
  totalValuePen: z.string(),
});
export type InventoryValuationLineTotalDto = z.infer<typeof inventoryValuationLineTotalSchema>;

export const inventoryValuationSchema = z.object({
  /** Fecha de corte, `YYYY-MM-DD`. Hoy en Lima: el saldo valorizado es el de este instante. */
  asOf: z.string(),
  coilGroups: z.array(inventoryValuationCoilGroupSchema),
  products: z.array(inventoryValuationProductSchema),
  totalsByLine: z.array(inventoryValuationLineTotalSchema),
  totals: z.object({
    coilValuePen: z.string(),
    productValuePen: z.string(),
    totalValuePen: z.string(),
  }),
});
export type InventoryValuationDto = z.infer<typeof inventoryValuationSchema>;

/* ------------------------------------------------------------------------------------- *
 * RF-S4a/M2 — Ventas y margen por rango de fechas. Solo ADMINISTRADOR.
 *
 * **La venta** son los comprobantes con `issue_date` dentro del rango: facturas y boletas
 * suman, las notas de crédito restan, y todo va **sin IGV** (`subtotal_pen`), que es la
 * verdad interna del negocio (§7). Los manuales entran como cualquier otro (D-153); los
 * anulados, rechazados y archivados no entran. La guía de remisión no es una venta.
 *
 * **El costo** sale de los movimientos de kardex `refType='SALE'` de los despachos del
 * pedido, que es donde el costo de lo vendido ya está calculado y valorizado al promedio
 * ponderado — para el producto fabricado, para la plancha de catálogo y para la bobina de
 * reventa por igual. No se reconstruye desde el consumo de las OPs: una OP puede producir
 * de más (el excedente queda como stock libre y no es costo de este pedido) y un pedido
 * servido desde stock no tiene OPs propias (D-140/D-145), lo que daría margen 100 %.
 * El material que sí consumieron sus OPs viaja aparte, en `opMaterialCostPen`, rotulado
 * como lo que es: una pregunta de planta, no el costo de esta venta.
 * ------------------------------------------------------------------------------------- */

/**
 * Qué tan completo es el costo de una fila.
 *
 * - `COMPLETO`: todo lo facturado en el rango ya salió del almacén. Entra a los totales.
 * - `PARCIAL`: hay líneas facturadas que todavía no se despacharon, así que el costo es un
 *   piso y el margen un techo. Entra a los totales, marcado, y los totales dicen cuántas
 *   filas están así para que nadie lea el margen como si fuera definitivo.
 * - `NO_COMPARABLE`: el pedido tiene comprobantes dentro **y** fuera del rango y los del
 *   rango no declaran su despacho, así que su venta parcial no se puede cruzar con un costo
 *   de la misma porción. Se muestra la venta, el costo va vacío y **queda fuera de los
 *   totales de margen**, listado aparte. Prorratear daría un número inventado.
 */
export const MARGIN_COST_STATUSES = ['COMPLETO', 'PARCIAL', 'NO_COMPARABLE'] as const;
export type MarginCostStatus = (typeof MARGIN_COST_STATUSES)[number];

export const salesMarginQuerySchema = z
  .object({
    from: operationDateSchema,
    to: operationDateSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type SalesMarginQuery = z.infer<typeof salesMarginQuerySchema>;

/** Un comprobante dentro de la fila de su pedido. */
export const salesMarginDocumentSchema = z.object({
  id: z.string().uuid(),
  /** `F001-00000123`. Null solo en un borrador, que este reporte no muestra. */
  number: z.string().nullable(),
  docType: z.enum(FISCAL_DOC_TYPES),
  status: z.enum(FISCAL_DOCUMENT_STATUSES),
  origin: z.enum(FISCAL_DOCUMENT_ORIGINS),
  issueDate: z.string(),
  /** Sin IGV, con signo: una nota de crédito viene en negativo. */
  salesPen: z.string(),
  /**
   * Costo de lo vendido **de este comprobante**, y solo cuando su despacho lo declara
   * (`Dispatch.invoiceId`, D-205/D-213). En cualquier otro caso va `null`: el esquema
   * prohíbe inferir qué despacho cubre qué comprobante, porque un pedido puede tener
   * varios despachos parciales y un enlace falso pesa más en auditoría que uno ausente.
   */
  costPen: z.string().nullable(),
  marginPen: z.string().nullable(),
  marginPct: z.string().nullable(),
});
export type SalesMarginDocumentDto = z.infer<typeof salesMarginDocumentSchema>;

/** Una fila del reporte: un pedido con sus comprobantes del rango. */
export const salesMarginOrderSchema = z.object({
  salesOrderId: z.string().uuid().nullable(),
  /** `PED-000123`. Null en una venta directa sin pedido, que se agrupa sola. */
  orderCode: z.string().nullable(),
  customerName: z.string(),
  sellerName: z.string().nullable(),
  salesPen: z.string(),
  costPen: z.string().nullable(),
  /** Material que consumieron las OPs de este pedido. Columna de planta, no de margen. */
  opMaterialCostPen: z.string(),
  marginPen: z.string().nullable(),
  /** Margen sobre venta en puntos porcentuales (§7). Null si el costo no es comparable. */
  marginPct: z.string().nullable(),
  costStatus: z.enum(MARGIN_COST_STATUSES),
  /** Falso en `NO_COMPARABLE`: la fila se ve pero no suma. */
  inTotals: z.boolean(),
  documents: z.array(salesMarginDocumentSchema),
});
export type SalesMarginOrderDto = z.infer<typeof salesMarginOrderSchema>;

/**
 * Totales por línea de negocio. `businessLine` va en `null` en el grupo «sin línea»: las
 * líneas libres de un comprobante (un servicio, un ajuste de nota de crédito) no tienen
 * producto del cual derivarla, y meterlas en cualquier línea sería inventar.
 */
export const salesMarginLineTotalSchema = z.object({
  businessLine: z.enum(BUSINESS_LINES).nullable(),
  salesPen: z.string(),
  costPen: z.string(),
  marginPen: z.string(),
  /** `null` cuando la venta del grupo no es positiva. Ver `salesMarginSchema.totals`. */
  marginPct: z.string().nullable(),
});
export type SalesMarginLineTotalDto = z.infer<typeof salesMarginLineTotalSchema>;

export const salesMarginSchema = z.object({
  from: z.string(),
  to: z.string(),
  orders: z.array(salesMarginOrderSchema),
  totalsByLine: z.array(salesMarginLineTotalSchema),
  totals: z.object({
    salesPen: z.string(),
    costPen: z.string(),
    marginPen: z.string(),
    /**
     * Margen **sobre venta** (§7), o `null` cuando la venta no es positiva.
     *
     * Con base cero no hay porcentaje, y con base negativa —un rango cuya única actividad en
     * ese grupo es la nota de crédito que anula una venta anterior— la fórmula devuelve
     * `+100 %`, que se lee exactamente al revés de lo que pasó. El monto en soles sigue ahí
     * y dice la verdad; el porcentaje se calla en vez de mentir.
     */
    marginPct: z.string().nullable(),
    /** Cuántas filas de los totales traen costo parcial: el margen de arriba es un techo. */
    partialOrderCount: z.number().int(),
    /** Cuántas filas quedaron fuera por no ser comparables, y cuánta venta se llevaron. */
    excludedOrderCount: z.number().int(),
    excludedSalesPen: z.string(),
  }),
});
export type SalesMarginDto = z.infer<typeof salesMarginSchema>;

/**
 * D-279 — Kardex PEPS de un producto o una bobina, en el formato 13.1 de SUNAT (registro de
 * inventario permanente valorizado). Solo ADMINISTRADOR. Es un reporte: la valorización del
 * sistema sigue en costo promedio (D-028).
 */
export const kardexPepsQuerySchema = z
  .object({
    itemType: z.enum(['PRODUCT', 'COIL'], {
      errorMap: () => ({ message: 'El kardex PEPS es de un producto o de una bobina' }),
    }),
    itemId: z.string().uuid(),
    from: operationDateSchema,
    to: operationDateSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'El rango termina antes de empezar' });
export type KardexPepsQuery = z.infer<typeof kardexPepsQuerySchema>;
