import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCreditNoteSchema,
  createCustomerSchema,
  createDispatchSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  registerCreditNoteSchema,
  salesMarginQuerySchema,
  type FiscalDocumentDto,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { ReceivablesAgingService } from '../reports/receivables-aging.service';
import { SalesByMaterialService } from '../reports/sales-by-material.service';
import { SalesMarginService } from '../reports/sales-margin.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { DispatchesService } from './dispatches.service';
import { FiscalImportService } from './fiscal-import.service';
import { invoicedByOrderItem } from './invoicing-net';
import { InvoicingService } from './invoicing.service';
import { ReceivablesService } from './receivables.service';

/**
 * cc54 (D-654..D-663) — **la nota de crédito por motivo SUNAT, contra una base real.** Un caso por
 * motivo, por el camino de un solo paso (`registerCreditNote`, D-660), y la medición de una NC de
 * devolución en dos pasos (alta + registro) contra uno.
 *
 * Escenario de cada caso: un producto de reventa entra 10 u a S/ 20 el día 5 del mes anterior; se
 * vende 5 u a S/ 50 + IGV (S/ 59 con IGV, S/ 295 la factura) y se despacha el día 10.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

/** Cuenta las sentencias que manda el cliente de Prisma (para la medición). */
class CountingPrisma extends PrismaService {
  count = 0;
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (this as unknown as { $on: (e: 'query', cb: () => void) => void }).$on('query', () => {
      this.count += 1;
    });
  }
}

let moduleRef: TestingModule;
let prisma: CountingPrisma;
let invoicing: InvoicingService;
let admin: RequestUser;
let supplierId = '';
let customerId = '';
let otherCustomerId = '';
let tradingLineId = '';
let correlative = Math.floor(Math.random() * 50_000) + 60_000;

const TODAY = businessToday();
const [ty, tm] = TODAY.split('-').map(Number) as [number, number];
const prevMonth =
  tm === 1 ? `${String(ty - 1)}-12` : `${String(ty)}-${String(tm - 1).padStart(2, '0')}`;
const PREV = (day: number) => `${prevMonth}-${String(day).padStart(2, '0')}`;

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');

async function newCustomer(name: string): Promise<string> {
  return (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name,
        creditDays: 30,
      }),
    )
  ).id;
}

beforeAll(async () => {
  assertTestDatabase();
  prisma = new CountingPrisma();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
  invoicing = moduleRef.get(InvoicingService);
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  admin = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };
  tradingLineId = (await prisma.businessLine.findUniqueOrThrow({ where: { code: 'TRADING' } })).id;
  supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc54 NC',
        creditDays: 0,
      }),
    )
  ).id;
  customerId = await newCustomer('Cliente cc54 NC');
  otherCustomerId = await newCustomer('Cliente correcto cc54 NC');
});

afterAll(async () => {
  await moduleRef?.close();
});

interface Sold {
  productId: string;
  invoiceId: string;
  orderId: string;
  itemId: string;
}

/** Compra, venta de 5 u (despachadas o no) y su factura manual. */
async function sold(
  options: {
    dispatch?: boolean;
    declare?: boolean;
    paymentTerms?: 'CONTADO' | 'CREDITO';
    /** Cuánto se despacha (por defecto, todo). */
    dispatchQty?: string;
  } = {},
): Promise<Sold> {
  const productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC54NC-${letters(8)}`,
        name: 'Producto cc54 NC',
        unit: 'NIU',
        source: 'PURCHASED',
      }),
    )
  ).id;
  const purchases = moduleRef.get(PurchasesService);
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number: digits(8),
      issueDate: PREV(5),
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'trading',
      type: 'FINISHED_GOOD',
      items: [{ productId, description: 'Producto cc54', qty: '10', unit: 'NIU', unitPrice: '20' }],
    }),
  );
  await purchases.receive(admin, purchase.id, { operationDate: PREV(5), confirmBackdate: true });
  const order = await moduleRef.get(SalesOrdersService).createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: PREV(10),
      items: [{ productId, qty: '5', unitPricePen: '50' }],
    }),
  );
  let dispatchId: string | null = null;
  if (options.dispatch !== false) {
    dispatchId = (
      await moduleRef.get(DispatchesService).create(
        admin,
        createDispatchSchema.parse({
          salesOrderId: order.id,
          dispatchDate: PREV(10),
          confirmBackdate: true,
          originAddress: 'Almacén cc54',
          destinationAddress: 'Cliente cc54',
          originUbigeo: '150101',
          destinationUbigeo: '150101',
          transferMode: 'PICKUP',
          items: order.items.map((i) => ({
            salesOrderItemId: i.id,
            qty: options.dispatchQty ?? i.qty,
          })),
        }),
      )
    ).id;
  }
  const credit = options.paymentTerms === 'CREDITO';
  const draft = await invoicing.create(
    admin,
    createInvoiceSchema.parse({
      docType: 'FACTURA',
      customerId,
      salesOrderId: order.id,
      issueDate: PREV(10),
      paymentTerms: credit ? 'CREDITO' : 'CONTADO',
      ...(credit ? { dueDate: PREV(25) } : {}),
      // D-205: la factura declara el despacho que cubre.
      ...(options.declare && dispatchId ? { dispatchId } : {}),
      items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
    }),
  );
  const invoice = await invoicing.registerManual(admin, draft.id, {
    series: 'F954',
    correlative: (correlative += 1),
  });
  return {
    productId,
    invoiceId: invoice.id,
    orderId: order.id,
    itemId: invoice.items[0]?.id ?? '',
  };
}

/** La NC en un solo paso (D-660). */
function register(invoiceId: string, body: Record<string, unknown>): Promise<FiscalDocumentDto> {
  return invoicing.registerCreditNote(
    admin,
    invoiceId,
    registerCreditNoteSchema.parse({
      issueDate: TODAY,
      series: 'FC54',
      correlative: (correlative += 1),
      ...body,
    }),
  );
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { getStatus?: () => number; message: string };
    return { status: e.getStatus?.() ?? 500, message: e.message };
  }
  throw new Error('Se esperaba un rechazo');
}

const returns = (productId: string) =>
  prisma.inventoryMovement.findMany({
    where: { itemId: productId, refType: 'SALES_RETURN' },
    orderBy: { id: 'asc' },
  });

const pendingOf = async (orderId: string) =>
  (await invoicing.orderProgress(admin, orderId)).lines[0]?.pendingInvoiceQty;

describe('cc54: nota de crédito por motivo SUNAT', () => {
  it('01 con despacho: anula y devuelve lo despachado (DEV-) al costo con que salió (D-656)', async () => {
    const s = await sold();
    const note = await register(s.invoiceId, { reason: 'ANULACION_OPERACION' });
    expect(note.totalPen).toBe('295.0000');
    expect(note.salesReturn).not.toBeNull();
    const back = await returns(s.productId);
    expect(back.map((m) => [m.qty.toString(), m.totalCost.toString()])).toEqual([['5', '100']]);
    expect((await invoicing.findOne(s.invoiceId)).balancePen).toBe('0.0000');
    // Lo devuelto no vuelve a quedar pendiente de facturar.
    expect(await pendingOf(s.orderId)).toBe('0.000');
    // cc58 (D-680): el pedido sigue atendido, y el detalle sabe que volvió entero.
    const order = await moduleRef.get(SalesOrdersService).findOne(s.orderId, admin);
    expect(order.status).toBe('FULFILLED');
    expect(order.returns?.fullyReturned).toBe(true);
    expect(order.returns?.returns.map((r) => r.creditNoteId)).toEqual([note.id]);
  });

  it('01 con despacho parcial: después se puede anular el pedido; la NC ya no se anula (revisiones)', async () => {
    // Despachado a medias (un pedido atendido entero no se anula, regla de siempre).
    const s = await sold({ dispatchQty: '2' });
    const note = await register(s.invoiceId, { reason: 'ANULACION_OPERACION' });
    // El despacho quedó devuelto entero: ya no bloquea la anulación del pedido.
    const order = await moduleRef
      .get(SalesOrdersService)
      .cancel(admin, s.orderId, { reason: 'prueba cc54', acknowledgeFabricated: true });
    expect(order.status).toBe('CANCELLED');
    // Con el pedido anulado, la devolución no se deshace.
    const r = await rejection(
      moduleRef.get(FiscalImportService).annulExternal(admin, note.id, 'prueba'),
    );
    expect(r.message).toContain('está anulado');
  });

  it('01 con una línea sin pedido (flete): esa línea no devuelve nada y no falla', async () => {
    const s = await sold();
    // Una segunda factura del mismo cliente con una línea libre.
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        issueDate: PREV(11),
        items: [{ description: 'Flete cc54', qty: '1', unitPricePen: '20' }],
      }),
    );
    const free = await invoicing.registerManual(admin, draft.id, {
      series: 'F954',
      correlative: (correlative += 1),
    });
    const preview = await invoicing.previewCreditNote(
      admin,
      free.id,
      createCreditNoteSchema.parse({ reason: 'ANULACION_OPERACION', issueDate: TODAY }),
    );
    expect(preview.stock).toEqual([]);
    const note = await register(free.id, { reason: 'ANULACION_OPERACION' });
    expect(note.totalPen).toBe('23.6000');
    expect(note.salesReturn).toBeNull();
    expect(await returns(s.productId)).toHaveLength(0);
  });

  it('01 sin despacho: no mueve stock y lo facturado vuelve a quedar pendiente', async () => {
    const s = await sold({ dispatch: false });
    const preview = await invoicing.previewCreditNote(
      admin,
      s.invoiceId,
      createCreditNoteSchema.parse({ reason: 'ANULACION_OPERACION', issueDate: TODAY }),
    );
    expect(preview.stock).toEqual([]);
    expect(preview.notDispatched).toEqual([{ lineNumber: 1, qty: '5.000' }]);
    const note = await register(s.invoiceId, { reason: 'ANULACION_OPERACION' });
    expect(note.salesReturn).toBeNull();
    expect(await returns(s.productId)).toHaveLength(0);
    expect(await pendingOf(s.orderId)).toBe('5.000');
  });

  it('02: el reemplazo al cliente correcto toma el despacho y el pedido cambia de cliente (D-655)', async () => {
    const s = await sold({ declare: true });
    const number = correlative + 1000;
    const note = await register(s.invoiceId, {
      reason: 'ANULACION_ERROR_RUC',
      replacement: {
        customerId: otherCustomerId,
        issueDate: TODAY,
        series: 'F955',
        correlative: number,
      },
    });
    expect(note.totalPen).toBe('295.0000');
    const replacement = await prisma.fiscalDocument.findFirstOrThrow({
      where: { replacesDocumentId: s.invoiceId },
    });
    expect(replacement).toMatchObject({
      customerId: otherCustomerId,
      status: 'ACCEPTED',
      origin: 'MANUAL',
      number: `F955-${String(number).padStart(8, '0')}`,
    });
    expect(replacement.totalPen.toString()).toBe('295');
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    expect(dispatch.invoiceId).toBe(replacement.id);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } });
    expect(order.customerId).toBe(otherCustomerId);
    expect(await returns(s.productId)).toHaveLength(0);
    expect((await invoicing.findOne(s.invoiceId)).balancePen).toBe('0.0000');
    expect((await invoicing.findOne(replacement.id)).balancePen).toBe('295.0000');
    // La NC 02 no se anula con el reemplazo vivo.
    const r = await rejection(
      moduleRef.get(FiscalImportService).annulExternal(admin, note.id, 'prueba'),
    );
    expect(r.message).toContain('reemplazo vivo');
    // Anulado el reemplazo, anular la 02 devuelve el despacho y el cliente del pedido.
    await moduleRef.get(FiscalImportService).annulExternal(admin, replacement.id, 'prueba');
    await moduleRef.get(FiscalImportService).annulExternal(admin, note.id, 'prueba');
    const back = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    expect(back.invoiceId).toBe(s.invoiceId);
    const restored = await prisma.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } });
    expect(restored.customerId).toBe(customerId);
    // Un segundo 02 sobre el mismo comprobante no se registra (el reemplazo es único).
    const again = await rejection(
      register(s.invoiceId, {
        reason: 'ANULACION_ERROR_RUC',
        replacement: {
          customerId: otherCustomerId,
          issueDate: TODAY,
          series: 'F955',
          correlative: correlative + 3000,
        },
      }),
    );
    expect(again.message).toContain('ya tuvo un comprobante de reemplazo');
    // cc58 (D-677): no hay segundo 02; el mensaje da el camino (01 y volver a emitir).
    expect(again.message).toContain('hoy anulado');
    expect(again.message).toContain('no se permite');
    expect(again.message).toContain('nota de crédito 01');
    expect(again.message).toContain('vuelve a emitir');
  });

  it('cc61 (D-698, NC-01 de audit-02): la 02 no se anula si el pedido ya tiene otro comprobante vivo', async () => {
    const s = await sold({ declare: true });
    const note = await register(s.invoiceId, {
      reason: 'ANULACION_ERROR_RUC',
      replacement: {
        customerId: otherCustomerId,
        issueDate: TODAY,
        series: 'F955',
        correlative: correlative + 5000,
      },
    });
    const replacement = await prisma.fiscalDocument.findFirstOrThrow({
      where: { replacesDocumentId: s.invoiceId },
    });
    const fiscalImport = moduleRef.get(FiscalImportService);
    // Anulado el reemplazo, las líneas quedan pendientes de facturar y se registra otro comprobante
    // sobre ellas, al cliente que hoy tiene el pedido.
    await fiscalImport.annulExternal(admin, replacement.id, 'prueba');
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    const orderItem = await prisma.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: s.orderId },
    });
    expect((await invoicedByOrderItem(prisma, [orderItem.id])).get(orderItem.id)?.qty.toFixed(3)).toBe(
      '0.000',
    );
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId: otherCustomerId,
        salesOrderId: s.orderId,
        issueDate: TODAY,
        paymentTerms: 'CONTADO',
        dispatchId: dispatch.id,
        items: [{ salesOrderItemId: orderItem.id, qty: '5' }],
      }),
    );
    const third = await invoicing.registerManual(admin, draft.id, {
      series: 'F956',
      correlative: (correlative += 1),
    });
    // Anular la 02 ahora devolvería el original a la vida: la línea quedaría facturada dos veces.
    const r = await rejection(fiscalImport.annulExternal(admin, note.id, 'prueba'));
    expect(r.status).toBe(400);
    expect(r.message).toContain(third.number ?? '');
    expect(r.message).toContain('anúlalo antes de anular esta nota de crédito 02');
    expect((await invoicedByOrderItem(prisma, [orderItem.id])).get(orderItem.id)?.qty.toFixed(3)).toBe(
      '5.000',
    );
    const f1 = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s.invoiceId } });
    expect(f1.status).toBe('ACCEPTED');
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: note.id } })).status).toBe(
      'ACCEPTED',
    );
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } });
    expect(order.customerId).toBe(otherCustomerId);
    // Anulado ese comprobante, la 02 sí se anula y el pedido vuelve a su cliente (D-655). El
    // despacho que el otro comprobante declaró quedó suelto al anularlo (D-664): el original
    // vuelve sin despacho declarado.
    await fiscalImport.annulExternal(admin, third.id, 'prueba');
    await fiscalImport.annulExternal(admin, note.id, 'prueba');
    const back = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    expect(back.invoiceId).toBeNull();
    expect(
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } })).customerId,
    ).toBe(customerId);
  });

  it('02: con cobros en el comprobante, se bloquea con un mensaje claro', async () => {
    const s = await sold();
    await moduleRef.get(ReceivablesService).addPayment(admin, s.invoiceId, {
      date: TODAY,
      amountPen: '10.00',
      method: 'CASH',
    } as never);
    const r = await rejection(
      register(s.invoiceId, {
        reason: 'ANULACION_ERROR_RUC',
        replacement: {
          customerId: otherCustomerId,
          issueDate: TODAY,
          series: 'F955',
          correlative: correlative + 2000,
        },
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain('tiene cobros registrados');
  });

  it('03: importe 0, la línea muestra la descripción corregida y nada más cambia (D-654)', async () => {
    const s = await sold();
    const note = await register(s.invoiceId, {
      reason: 'CORRECCION_DESCRIPCION',
      descriptions: [{ affectedItemId: s.itemId, description: 'Producto cc54 corregido' }],
    });
    expect(note.totalPen).toBe('0.0000');
    const affected = await invoicing.findOne(s.invoiceId);
    expect(affected.items[0]).toMatchObject({
      correctedDescription: 'Producto cc54 corregido',
      correctedByNumber: note.number,
    });
    expect(affected.balancePen).toBe('295.0000');
    expect(await pendingOf(s.orderId)).toBe('0.000');
  });

  it('04: la rebaja global suma exactamente el monto y no devuelve cantidad', async () => {
    const s = await sold();
    const note = await register(s.invoiceId, { reason: 'DESCUENTO_GLOBAL', amountPen: '59.00' });
    expect(note.totalPen).toBe('59.0000');
    expect(note.subtotalPen).toBe('50.0000');
    expect((await invoicing.findOne(s.invoiceId)).balancePen).toBe('236.0000');
    expect(await pendingOf(s.orderId)).toBe('0.000');
    expect(await returns(s.productId)).toHaveLength(0);
  });

  it('05 y después 07: la devolución acredita lo que queda, no el precio del papel', async () => {
    const s = await sold();
    const rebate = await register(s.invoiceId, {
      reason: 'DESCUENTO_ITEM',
      prices: [{ affectedItemId: s.itemId, unitPriceWithIgvPen: '49' }],
    });
    // 5 × (59 − 49) = 50 con IGV.
    expect(rebate.totalPen).toBe('50.0000');
    const back = await register(s.invoiceId, {
      reason: 'DEVOLUCION_ITEM',
      items: [{ affectedItemId: s.itemId, qty: '5' }],
    });
    // Lo que queda: 295 − 50.
    expect(back.totalPen).toBe('245.0000');
    expect((await invoicing.findOne(s.invoiceId)).balancePen).toBe('0.0000');
  });

  it('13: cambia el vencimiento de una factura al crédito, sin importe, y se deshace al anularla (D-657)', async () => {
    const s = await sold({ paymentTerms: 'CREDITO' });
    const due = PREV(28);
    const note = await register(s.invoiceId, { reason: 'OTROS_AJUSTES', dueDate: due });
    expect(note.totalPen).toBe('0.0000');
    const affected = await invoicing.findOne(s.invoiceId);
    expect(affected.dueDate).toBe(due);
    expect(affected.dueDateChangedByNumber).toBe(note.number);
    expect(affected.balancePen).toBe('295.0000');
    const aging = await moduleRef.get(ReceivablesAgingService).report({});
    const row = aging.customers.flatMap((c) => c.documents).find((d) => d.id === s.invoiceId);
    expect(row?.dueDate).toBe(due);
    await moduleRef.get(FiscalImportService).annulExternal(admin, note.id, 'prueba');
    expect((await invoicing.findOne(s.invoiceId)).dueDate).toBe(PREV(25));
  });

  it('13 sobre una factura al contado: no corresponde', async () => {
    const s = await sold();
    const r = await rejection(register(s.invoiceId, { reason: 'OTROS_AJUSTES', dueDate: TODAY }));
    expect(r.status).toBe(400);
    expect(r.message).toContain('factura al crédito');
  });

  it('Ventas y margen: 03 y 13 no cambian la venta; 04 resta venta sin costo', async () => {
    const margin = moduleRef.get(SalesMarginService);
    const month = { from: `${TODAY.slice(0, 7)}-01`, to: TODAY };
    const s = await sold({ paymentTerms: 'CREDITO' });
    const before = (await margin.salesMargin(salesMarginQuerySchema.parse(month))).totals;
    await register(s.invoiceId, {
      reason: 'CORRECCION_DESCRIPCION',
      descriptions: [{ affectedItemId: s.itemId, description: 'Otra descripción cc54' }],
    });
    await register(s.invoiceId, { reason: 'OTROS_AJUSTES', dueDate: PREV(27) });
    const mid = (await margin.salesMargin(salesMarginQuerySchema.parse(month))).totals;
    expect(mid.salesPen).toBe(before.salesPen);
    expect(mid.costPen).toBe(before.costPen);
    await register(s.invoiceId, { reason: 'DESCUENTO_GLOBAL', amountPen: '11.80' });
    const after = (await margin.salesMargin(salesMarginQuerySchema.parse(month))).totals;
    expect(Number(after.salesPen) - Number(before.salesPen)).toBeCloseTo(-10, 2);
    expect(after.costPen).toBe(before.costPen);
  });

  it('medición: una devolución en dos pasos contra un paso (consultas y ms, en local-data)', async () => {
    const measure = async (run: () => Promise<unknown>) => {
      const q = prisma.count;
      const t = performance.now();
      await run();
      return { queries: prisma.count - q, ms: Math.round(performance.now() - t) };
    };
    const a = await sold();
    const twoSteps = await measure(async () => {
      const draft = await invoicing.createCreditNote(
        admin,
        a.invoiceId,
        createCreditNoteSchema.parse({
          reason: 'DEVOLUCION_ITEM',
          issueDate: TODAY,
          items: [{ affectedItemId: a.itemId, qty: '2' }],
        }),
      );
      await invoicing.registerManual(admin, draft.id, {
        series: 'FC54',
        correlative: (correlative += 1),
      });
    });
    const b = await sold();
    const oneStep = await measure(() =>
      register(b.invoiceId, {
        reason: 'DEVOLUCION_ITEM',
        items: [{ affectedItemId: b.itemId, qty: '2' }],
      }),
    );
    const out = resolve(__dirname, '../../../../local-data/cc54');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      resolve(out, 'medicion-nc-devolucion.json'),
      JSON.stringify({ twoSteps, oneStep, at: new Date().toISOString() }, null, 2),
    );
    expect(oneStep.queries).toBeLessThan(twoSteps.queries);
  });
});

describe('cc55 (D-664): hallazgos de audit-01 sobre la nota de crédito', () => {
  it('D-04: anular internamente la factura suelta su despacho, y el 01 sobre la corregida devuelve el stock', async () => {
    const s = await sold({ declare: true });
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    expect(dispatch.invoiceId).toBe(s.invoiceId);

    await moduleRef.get(FiscalImportService).annulExternal(admin, s.invoiceId, 'error de tipeo');
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).invoiceId,
    ).toBeNull();

    // La factura corregida, por las mismas líneas y sin declarar despacho (lo normal: ya salió).
    const order = await moduleRef.get(SalesOrdersService).findOne(s.orderId, admin);
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        salesOrderId: s.orderId,
        issueDate: PREV(10),
        paymentTerms: 'CONTADO',
        items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
      }),
    );
    const corrected = await invoicing.registerManual(admin, draft.id, {
      series: 'F954',
      correlative: (correlative += 1),
    });

    const note = await register(corrected.id, { reason: 'ANULACION_OPERACION' });
    expect(note.salesReturn).not.toBeNull();
    const back = await returns(s.productId);
    expect(back.map((m) => [m.qty.toString(), m.totalCost.toString()])).toEqual([['5', '100']]);
    // Lo devuelto no vuelve a quedar pendiente de facturar.
    expect(await pendingOf(s.orderId)).toBe('0.000');
  });

  it('cc58 (D-678, autorrevisión P1): un borrador 01 no lo registra a mano un vendedor', async () => {
    const s = await sold();
    const draft = await invoicing.createCreditNote(
      admin,
      s.invoiceId,
      createCreditNoteSchema.parse({ reason: 'ANULACION_OPERACION', issueDate: TODAY }),
    );
    const seller: RequestUser = { ...admin, role: Role.VENDEDOR };
    const r = await rejection(
      invoicing.registerManual(seller, draft.id, { series: 'FC77', correlative: 7701 }),
    );
    expect(r.message).toContain('la registra un administrador');
    expect(await returns(s.productId)).toEqual([]);
  });

  it('C-01: la vista previa no devuelve costos a quien no es ADMINISTRADOR', async () => {
    const s = await sold();
    const body = createCreditNoteSchema.parse({ reason: 'ANULACION_OPERACION', issueDate: TODAY });
    const asAdmin = await invoicing.previewCreditNote(admin, s.invoiceId, body);
    expect(asAdmin.costPen).toBe('100.0000');
    expect(asAdmin.stock.map((x) => x.costPen)).toEqual(['100.0000']);
    // El mismo usuario (dueño del pedido) con rol de vendedor: misma vista, sin cifras de costo.
    const seller: RequestUser = { ...admin, role: Role.VENDEDOR };
    const asSeller = await invoicing.previewCreditNote(seller, s.invoiceId, body);
    expect(asSeller.costPen).toBeNull();
    expect(asSeller.stock.map((x) => x.costPen)).toEqual([null]);
    expect(asSeller.stock.map((x) => x.qty)).toEqual(asAdmin.stock.map((x) => x.qty));
  });
});

describe('cc55 (revisiones del corte A): reactivar repone el enlace que la anulación soltó', () => {
  it('R-2: anular suelta el despacho y reactivar lo vuelve a declarar', async () => {
    const s = await sold({ declare: true });
    const imports = moduleRef.get(FiscalImportService);
    await imports.annulExternal(admin, s.invoiceId, 'por error');
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: s.orderId } });
    expect(dispatch.invoiceId).toBeNull();
    await imports.reactivateExternal(admin, s.invoiceId, {
      reason: 'la anulación fue un error',
      confirmStillValid: true,
    });
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).invoiceId,
    ).toBe(s.invoiceId);
  });
});

describe('cc57 (E-03 de audit-01): una NC de reventa en «Ventas por material» y en «Ventas y margen»', () => {
  it('la fila del producto resta la venta y el costo de la devolución, como Ventas y margen', async () => {
    const s = await sold({ declare: true });
    await register(s.invoiceId, {
      reason: 'DEVOLUCION_ITEM',
      items: [{ affectedItemId: s.itemId, qty: '2' }],
    });
    const range = { from: PREV(1), to: TODAY };
    const material = await moduleRef
      .get(SalesByMaterialService)
      .report({ ...range, businessLine: 'trading' } as never);
    const sku = (await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).sku;
    const row = material.products?.rows.find((r) => r.sku === sku);
    const margin = await moduleRef
      .get(SalesMarginService)
      .salesMargin(salesMarginQuerySchema.parse(range));
    const order = margin.orders.find((o) => o.salesOrderId === s.orderId);
    // 5 u a S/ 50 menos 2 devueltas; costo 5 × 20 menos los 2 que reingresaron (40).
    expect(row).toMatchObject({ qty: '3.000', salesPen: '150.0000', costPen: '60.0000' });
    expect(order?.salesPen).toBe(row?.salesPen);
    expect(order?.costPen).toBe(row?.costPen);
    expect(material.products?.untraceable.some((u) => u.sku === sku)).toBe(false);
  });
});

describe('cc57 (E-16 de audit-01): el vendedor de una venta sin pedido en «Ventas y margen»', () => {
  it('es quien registró el comprobante, como en CxC y en el Panel del vendedor', async () => {
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        issueDate: TODAY,
        items: [{ description: 'Servicio cc57', qty: '1', unitPricePen: '20' }],
      }),
    );
    const free = await invoicing.registerManual(admin, draft.id, {
      series: 'F954',
      correlative: (correlative += 1),
    });
    const margin = await moduleRef
      .get(SalesMarginService)
      .salesMargin(salesMarginQuerySchema.parse({ from: TODAY, to: TODAY }));
    const row = margin.orders.find((o) => o.documents.some((d) => d.id === free.id));
    expect(row?.salesOrderId).toBeNull();
    expect(row?.sellerId).toBe(admin.id);
  });
});

describe('cc57 (E-06 de audit-01): la lectura de cobranzas filtra en SQL lo ya cobrado', () => {
  it('lo cobrado entero y lo acreditado entero no se traen; lo cobrado en parte sí, con su saldo', async () => {
    const paid = await sold();
    await moduleRef.get(ReceivablesService).addPayment(admin, paid.invoiceId, {
      date: TODAY,
      amountPen: '295.00',
      method: 'CASH',
    } as never);
    const half = await sold();
    await moduleRef.get(ReceivablesService).addPayment(admin, half.invoiceId, {
      date: TODAY,
      amountPen: '100.00',
      method: 'CASH',
    } as never);
    const credited = await sold();
    await register(credited.invoiceId, { reason: 'ANULACION_OPERACION' });
    // Un cobro revertido no cobra: el comprobante sigue debiendo entero.
    const reverted = await sold();
    await moduleRef.get(ReceivablesService).addPayment(admin, reverted.invoiceId, {
      date: TODAY,
      amountPen: '295.00',
      method: 'CASH',
    } as never);
    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: { documentId: reverted.invoiceId },
    });
    await moduleRef
      .get(ReceivablesService)
      .reversePayment(admin, reverted.invoiceId, payment.id, 'cobro mal registrado');
    const { loadCollectibleDocuments } = await import('./collectible-documents');
    const rows = await loadCollectibleDocuments(prisma);
    const ids = new Set(rows.map((r) => r.document.id));
    expect(ids.has(paid.invoiceId)).toBe(false);
    expect(ids.has(credited.invoiceId)).toBe(false);
    expect(rows.find((r) => r.document.id === half.invoiceId)?.balance.toFixed(4)).toBe('195.0000');
    expect(rows.find((r) => r.document.id === reverted.invoiceId)?.balance.toFixed(4)).toBe(
      '295.0000',
    );
  });
});
