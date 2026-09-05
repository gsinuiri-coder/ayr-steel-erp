import { z } from 'zod';
import { Decimal, decimalStringSchema, MAX_VALUE, toDecimal, type DecimalInput } from '../decimal';
import { BUSINESS_LINES, DOC_TYPES, PaymentMethod, type PaymentMethod as Method } from '../enums';
import { reasonSchema } from './coil';

/**
 * Punto de venta de mostrador (RF-60; D-098..D-104).
 *
 * **El POS no es un camino paralelo de stock** (D-099). Es una UI rápida que, en una sola
 * transacción, crea el pedido, el despacho, el comprobante y el cobro que ya existen desde
 * la Fase 5b, reusando sus servicios: los mismos guardrails, la misma reserva, el mismo
 * kardex, la misma invariante `disponible ≥ reservado`. Si al mostrador no le alcanza el
 * disponible, la venta se rechaza exactamente igual que cualquier otro pedido.
 *
 * De ahí sale casi todo lo que este archivo **no** tiene: no hay precios propios, ni un
 * estado de pedido nuevo, ni una tabla de movimientos de caja. Lo único que se agrega es
 * lo que no se puede derivar de las filas existentes: a qué **turno de caja** entró el
 * dinero y qué cuatro documentos nacieron juntos en el mostrador.
 */

// --------------------------------------------------------------------------
// Constantes del dominio
// --------------------------------------------------------------------------

/**
 * Tope de líneas de una venta de mostrador. Más bajo que `MAX_SALES_ITEMS` a propósito:
 * un carrito de mostrador con más de veinte productos distintos no es una venta de
 * mostrador, es un pedido, y ese camino ya existe con su cotización y su despacho aparte.
 */
export const MAX_POS_ITEMS = 20;

/**
 * Medios de pago que el mostrador ofrece (D-101). Es un subconjunto de `PaymentMethod`,
 * no un enum nuevo: el cobro que se registra es un `customer_payments` como cualquier
 * otro. Cheque y depósito quedan fuera porque no son formas de pagar en un mostrador.
 */
export const POS_PAYMENT_METHODS = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.WALLET,
  PaymentMethod.TRANSFER,
] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/**
 * El único medio que pone billetes en el cajón, y por lo tanto el único que entra al
 * arqueo (D-101). Una venta con tarjeta o Yape se cobra igual y se lista igual, pero
 * sumarla al efectivo esperado haría que toda caja con tarjetas cerrara con faltante.
 */
export const ARQUEO_METHOD: Method = PaymentMethod.CASH;

export const CashSessionStatus = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;
export type CashSessionStatus = (typeof CashSessionStatus)[keyof typeof CashSessionStatus];
export const CASH_SESSION_STATUSES = Object.values(CashSessionStatus) as [
  CashSessionStatus,
  ...CashSessionStatus[],
];
export const CASH_SESSION_STATUS_LABELS: Record<CashSessionStatus, string> = {
  OPEN: 'Abierta',
  CLOSED: 'Cerrada',
};

/**
 * Estado de una venta de mostrador (D-100).
 *
 * `VOIDING` es la venta ya **reclamada** por una anulación cuya cadena todavía no terminó.
 * No puede ser atómica —el paso del comprobante habla con el PSE— así que el estado existe
 * para que, mientras dura, la venta deje de contar para el arqueo, un cierre de caja
 * concurrente no la congele como vigente y una segunda anulación no emita una nota de
 * crédito duplicada.
 */
export const PosSaleStatus = { ACTIVE: 'ACTIVE', VOIDING: 'VOIDING', VOIDED: 'VOIDED' } as const;
export type PosSaleStatus = (typeof PosSaleStatus)[keyof typeof PosSaleStatus];
export const POS_SALE_STATUSES = Object.values(PosSaleStatus) as [
  PosSaleStatus,
  ...PosSaleStatus[],
];
export const POS_SALE_STATUS_LABELS: Record<PosSaleStatus, string> = {
  ACTIVE: 'Vigente',
  VOIDING: 'Anulándose',
  VOIDED: 'Anulada',
};

/** `123` → `CAJA-000123`. Correlativo legible de un turno de caja. */
export function cashSessionCode(seq: number): string {
  return `CAJA-${String(seq).padStart(6, '0')}`;
}

/** `123` → `MOS-000123`. Correlativo interno de una venta de mostrador; no es fiscal. */
export function posSaleCode(seq: number): string {
  return `MOS-${String(seq).padStart(6, '0')}`;
}

// --------------------------------------------------------------------------
// Aritmética del arqueo, compartida entre web y API
// --------------------------------------------------------------------------

export interface CashSaleLike {
  method: Method;
  totalPen: DecimalInput;
  status: PosSaleStatus;
}

/**
 * Efectivo que **debería** haber en el cajón: la apertura más las ventas vigentes en
 * efectivo del turno.
 *
 * Vive acá y no en el API por el mismo motivo que `salesLineTotals` (D-068): la cifra que
 * el cajero ve mientras cuenta tiene que ser exactamente la que el API guarda como
 * esperado. Si divergieran, la diferencia registrada sería la de dos cuentas distintas.
 *
 * Las ventas anuladas no cuentan: su cobro se revirtió, así que ese dinero salió del cajón
 * por el mismo camino por el que entró.
 */
export function expectedCash(openingAmountPen: DecimalInput, sales: CashSaleLike[]): Decimal {
  return sales
    .filter((s) => s.status === PosSaleStatus.ACTIVE && s.method === ARQUEO_METHOD)
    .reduce((acc, s) => acc.plus(toDecimal(s.totalPen)), toDecimal(openingAmountPen));
}

/** Totales del turno por medio de pago, solo sobre las ventas vigentes. */
export function totalsByMethod(sales: CashSaleLike[]): Record<Method, Decimal> {
  const totals = Object.fromEntries(
    Object.values(PaymentMethod).map((m) => [m, new Decimal(0)]),
  ) as Record<Method, Decimal>;
  for (const sale of sales) {
    if (sale.status !== PosSaleStatus.ACTIVE) continue;
    totals[sale.method] = totals[sale.method].plus(toDecimal(sale.totalPen));
  }
  return totals;
}

// --------------------------------------------------------------------------
// Entradas
// --------------------------------------------------------------------------

const moneySchema = decimalStringSchema('MONEY', { max: MAX_VALUE.MONEY });
const positiveMoneySchema = decimalStringSchema('MONEY', { positive: true, max: MAX_VALUE.MONEY });
const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });

/** Apertura del turno (D-101). El monto puede ser cero: un cajón que arranca vacío. */
export const openCashSessionSchema = z.object({
  openingAmountPen: moneySchema.refine(
    (v) => toDecimal(v).gte(0),
    'El monto de apertura no puede ser negativo',
  ),
  notes: z.string().trim().max(500).optional(),
});
export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;

/**
 * Cierre con arqueo (D-101). `countedCashPen` es lo que el cajero contó; el esperado lo
 * calcula el API con `expectedCash` y **no** se acepta del cliente: es la cifra contra la
 * que se mide el faltante, así que dejarla entrar por el body sería dejar que quien cuenta
 * elija también contra qué se lo compara.
 *
 * El motivo se exige cuando hay diferencia. Se comprueba acá para que el web lo diga antes
 * de mandar, y otra vez en el API con el esperado ya calculado, que es el único momento en
 * que la diferencia se conoce de verdad.
 */
export const closeCashSessionSchema = z.object({
  countedCashPen: moneySchema.refine(
    (v) => toDecimal(v).gte(0),
    'El efectivo contado no puede ser negativo',
  ),
  notes: z.string().trim().max(500).optional(),
});
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;

/**
 * Línea del carrito.
 *
 * **No tiene `reserveFromCoilId` ni `pieces`, y esa ausencia es la regla** (D-098): el
 * mostrador vende lo que está en stock contra el propio producto, nunca material a medida
 * contra una bobina. Al no existir el campo, no hay forma de que una venta de mostrador
 * arme una línea que la Fase 6 tendría que fabricar.
 */
export const posSaleItemInputSchema = z.object({
  productId: z.string({ required_error: 'El producto es obligatorio' }).uuid(),
  qty: qtySchema,
  /** Override de precio del vendedor (D-068). Sin él manda el precio de lista. */
  unitPricePen: positiveMoneySchema.optional(),
});
export type PosSaleItemInput = z.infer<typeof posSaleItemInputSchema>;

/**
 * Una venta de mostrador (D-099).
 *
 * No lleva fecha: el mostrador vende hoy, y `businessToday()` (D-069) la resuelve en el
 * API. Tampoco lleva condición de pago: el mostrador es contado, y de ahí sale que el
 * cobro se registre en el acto.
 */
export const createPosSaleSchema = z
  .object({
    /**
     * Cliente. Omitirlo significa "público en general": el API resuelve el cliente
     * sembrado de D-077 y emite boleta. Con un cliente con RUC se emite factura.
     */
    customerId: z.string().uuid().optional(),
    method: z.enum(POS_PAYMENT_METHODS, {
      errorMap: () => ({ message: 'Medio de pago no disponible en mostrador' }),
    }),
    /** Referencia del medio: últimos dígitos de la tarjeta, código de operación de Yape. */
    reference: z.string().trim().max(120).optional(),
    /**
     * D-077: fuerza la boleta a "público en general" por encima del tope de S/ 700. Solo
     * ADMINISTRADOR; el API lo rechaza para cualquier otro rol y lo deja registrado en el
     * comprobante y en la auditoría.
     */
    forceGenericCustomer: z.boolean().default(false),
    notes: z.string().trim().max(500).optional(),
    items: z
      .array(posSaleItemInputSchema)
      .min(1, 'El carrito está vacío')
      .max(MAX_POS_ITEMS, `Máximo ${MAX_POS_ITEMS} productos por venta`),
  })
  .superRefine((input, ctx) => {
    // Dos líneas del mismo producto se comprobarían por separado contra el disponible y
    // juntas podrían llevarse más de lo que hay. En un mostrador además no significan
    // nada: es la misma línea con más cantidad.
    const seen = new Set<string>();
    for (const [i, item] of input.items.entries()) {
      if (seen.has(item.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'productId'],
          message: 'El producto ya está en el carrito: cambia su cantidad',
        });
      }
      seen.add(item.productId);
    }
  });
export type CreatePosSaleInput = z.infer<typeof createPosSaleSchema>;

/** Anular una venta de mostrador (D-100): cadena de reversas, motivo obligatorio. */
export const voidPosSaleSchema = z.object({ reason: reasonSchema });
export type VoidPosSaleInput = z.infer<typeof voidPosSaleSchema>;

// --------------------------------------------------------------------------
// Salidas
// --------------------------------------------------------------------------

/**
 * Un producto vendible en mostrador: lo que el buscador muestra.
 *
 * `availableQty` es el disponible **real** (físico menos reservado, D-066), no el saldo
 * del kardex: es la única cifra con la que el vendedor puede prometer algo en el acto.
 */
export const posProductSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  businessLine: z.enum(BUSINESS_LINES),
  businessLineName: z.string(),
  /** Precio de lista sin IGV. Null si el producto no tiene: ahí hay que escribirlo. */
  listPricePen: z.string().nullable(),
  availableQty: z.string(),
});
export type PosProductDto = z.infer<typeof posProductSchema>;

export const posProductQuerySchema = z.object({
  /** Busca por SKU o por nombre. Sin él, devuelve los primeros productos con saldo. */
  search: z.string().trim().max(80).optional(),
  businessLine: z.enum(BUSINESS_LINES).optional(),
});
export type PosProductQuery = z.infer<typeof posProductQuerySchema>;

export const posSaleListItemSchema = z.object({
  id: z.string().uuid(),
  /** `MOS-000123`. */
  code: z.string(),
  status: z.enum(POS_SALE_STATUSES),
  cashSessionId: z.string().uuid(),
  customerName: z.string(),
  customerDocNumber: z.string(),
  method: z.enum(POS_PAYMENT_METHODS),
  totalPen: z.string(),
  salesOrderId: z.string().uuid(),
  salesOrderCode: z.string(),
  dispatchId: z.string().uuid(),
  dispatchCode: z.string(),
  fiscalDocumentId: z.string().uuid(),
  /** Número fiscal (`B001-00000123`). Nunca null: el POS emite siempre (D-102). */
  fiscalDocumentNumber: z.string().nullable(),
  fiscalDocumentStatus: z.string(),
  /** `true` mientras el comprobante no llegó a un estado terminal del PSE (D-073). */
  fiscalPending: z.boolean(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidedByName: z.string().nullable(),
  voidReason: z.string().nullable(),
});
export type PosSaleListItemDto = z.infer<typeof posSaleListItemSchema>;

/** Un total por medio de pago, para el resumen del turno. */
export const cashMethodTotalSchema = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  saleCount: z.number().int(),
  totalPen: z.string(),
});
export type CashMethodTotalDto = z.infer<typeof cashMethodTotalSchema>;

export const cashSessionSchema = z.object({
  id: z.string().uuid(),
  /** `CAJA-000123`. */
  code: z.string(),
  status: z.enum(CASH_SESSION_STATUSES),
  userId: z.string().uuid(),
  userName: z.string(),
  openingAmountPen: z.string(),
  openedAt: z.string(),
  openingNotes: z.string().nullable(),
  /**
   * Arqueo. En un turno abierto, `expectedCashPen` es el esperado **al día de hoy** y los
   * otros tres son null; en uno cerrado, los cuatro son los del cierre y `expectedCashPen`
   * queda congelado en lo que se arqueó (D-101).
   */
  expectedCashPen: z.string(),
  countedCashPen: z.string().nullable(),
  differencePen: z.string().nullable(),
  closingNotes: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedByName: z.string().nullable(),
  /** Ventas vigentes del turno, por medio de pago. */
  totals: z.array(cashMethodTotalSchema),
  saleCount: z.number().int(),
  voidedCount: z.number().int(),
  totalPen: z.string(),
});
export type CashSessionDto = z.infer<typeof cashSessionSchema>;

export const cashSessionQuerySchema = z.object({
  status: z.enum(CASH_SESSION_STATUSES).optional(),
  /**
   * Por defecto **solo los turnos propios**, para cualquier rol. Un ADMINISTRADOR pide
   * `mine=false` para ver los de todos; sin eso, la pantalla de caja le mostraba como suyo
   * el turno abierto más reciente de cualquier cajero.
   */
  mine: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .default(true)
    .transform((v) => v !== false && v !== 'false'),
  /** Filtra por cajero. Solo lo respeta un ADMINISTRADOR que además pidió `mine=false`. */
  userId: z.string().uuid().optional(),
});
export type CashSessionQuery = z.infer<typeof cashSessionQuerySchema>;

/**
 * Lo que `/pos` necesita saber al abrirse, en una sola llamada: si hay turno, si el PSE
 * está atado y quién es el cliente genérico.
 *
 * El aviso de contingencia (D-102) sale de acá: mientras producción corra sin credenciales
 * del PSE (D-080), la pantalla lo dice en vez de dejar que el vendedor descubra por su
 * cuenta que el comprobante quedó pendiente.
 */
export const posContextSchema = z.object({
  /** Turno abierto del usuario, o null si no abrió caja. */
  session: cashSessionSchema.nullable(),
  genericCustomerId: z.string().uuid(),
  genericCustomerName: z.string(),
  /** Tope de la boleta a público en general, en soles (D-077). */
  genericMaxTotalPen: z.string(),
  /** `false` cuando toda emisión cae en contingencia por diseño (D-080). */
  providerConfigured: z.boolean(),
  /** Interruptor manual de contingencia (D-073). */
  providerOffline: z.boolean(),
});
export type PosContextDto = z.infer<typeof posContextSchema>;

/**
 * Cliente rápido del mostrador: lo mínimo para emitirle un comprobante. Reusa el lookup
 * de documento de D-067 desde el web; acá solo viaja el resultado.
 */
export const posCustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  docType: z.enum(DOC_TYPES),
  docNumber: z.string(),
  isGeneric: z.boolean(),
});
export type PosCustomerDto = z.infer<typeof posCustomerSchema>;
