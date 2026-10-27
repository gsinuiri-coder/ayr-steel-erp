import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import {
  businessToday,
  createCreditNoteSchema,
  createCustomerSchema,
  createDispatchSchema,
  createFinishSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  reverseMovementSchema,
  salesMarginQuerySchema,
  type SalesMarginDto,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { InventoryValuationService } from '../reports/inventory-valuation.service';
import { SalesMarginService } from '../reports/sales-margin.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { DispatchesService } from './dispatches.service';
import { FiscalImportService } from './fiscal-import.service';
import { InvoicingService } from './invoicing.service';
import { SalesReturnsService } from './sales-returns.service';

/**
 * cc52 (D-645..D-647) — **nota de crédito con devolución, contra una base real.**
 *
 * Un producto de reventa entra 10 u a S/ 20 el día 5 del mes anterior; se venden y despachan 5 u
 * el día 10 (salen a S/ 20); entran 10 u a S/ 30 el día 20 (el promedio de hoy queda en 26.6667).
 * La NC de devolución de hoy reingresa al costo con que salió (20), no al promedio de hoy.
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let invoicing: InvoicingService;
let fiscalImport: FiscalImportService;
let admin: RequestUser;
let supplierId = '';
let customerId = '';
let tradingLineId = '';
let correlative = Math.floor(Math.random() * 50_000) + 10_000;

const TODAY = businessToday();
const [ty, tm] = TODAY.split('-').map(Number) as [number, number];
const prevMonth =
  tm === 1 ? `${String(ty - 1)}-12` : `${String(ty)}-${String(tm - 1).padStart(2, '0')}`;
const PREV = (day: number) => `${prevMonth}-${String(day).padStart(2, '0')}`;
const PREV_FROM = PREV(1);
const PREV_TO = new Date(Date.UTC(ty, tm - 1, 0)).toISOString().slice(0, 10);
const THIS_FROM = `${TODAY.slice(0, 7)}-01`;

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  invoicing = moduleRef.get(InvoicingService);
  fiscalImport = moduleRef.get(FiscalImportService);
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
        name: 'Proveedor cc52 NC',
        creditDays: 0,
      }),
    )
  ).id;
  customerId = (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc52 NC',
        creditDays: 0,
      }),
    )
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

async function buy(productId: string, qty: string, unitPrice: string, date: string) {
  const purchases = moduleRef.get(PurchasesService);
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number: digits(8),
      issueDate: date,
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'trading',
      type: 'FINISHED_GOOD',
      items: [{ productId, description: 'Producto cc52', qty, unit: 'NIU', unitPrice }],
    }),
  );
  await purchases.receive(admin, purchase.id, { operationDate: date, confirmBackdate: true });
}

/** El escenario: compra a 20, venta y despacho de 5 u el día 10 con factura manual, compra a 30. */
async function sold(): Promise<{ productId: string; invoiceId: string; orderId: string }> {
  const productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC52NC-${letters(8)}`,
        name: 'Producto cc52 NC',
        unit: 'NIU',
        source: 'PURCHASED',
      }),
    )
  ).id;
  await buy(productId, '10', '20', PREV(5));
  const order = await moduleRef.get(SalesOrdersService).createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: PREV(10),
      items: [{ productId, qty: '5', unitPricePen: '50' }],
    }),
  );
  await moduleRef.get(DispatchesService).create(
    admin,
    createDispatchSchema.parse({
      salesOrderId: order.id,
      dispatchDate: PREV(10),
      confirmBackdate: true,
      originAddress: 'Almacén cc52',
      destinationAddress: 'Cliente cc52',
      originUbigeo: '150101',
      destinationUbigeo: '150101',
      transferMode: 'PICKUP',
      items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
    }),
  );
  const draft = await invoicing.create(
    admin,
    createInvoiceSchema.parse({
      docType: 'FACTURA',
      customerId,
      salesOrderId: order.id,
      issueDate: PREV(10),
      items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
    }),
  );
  const invoice = await invoicing.registerManual(admin, draft.id, {
    series: 'F952',
    correlative: (correlative += 1),
  });
  await buy(productId, '10', '30', PREV(20));
  return { productId, invoiceId: invoice.id, orderId: order.id };
}

async function creditNote(
  invoiceId: string,
  reason: string,
  qty: string | null,
  issueDate = TODAY,
) {
  const detail = await invoicing.findOne(invoiceId);
  const note = await invoicing.createCreditNote(
    admin,
    invoiceId,
    createCreditNoteSchema.parse({
      reason,
      issueDate,
      // cc54 (D-663): el 05 rebaja el precio (con IGV) en vez de acreditar cantidad.
      ...(reason === 'DESCUENTO_ITEM'
        ? {
            prices: [
              { affectedItemId: detail.items[0]?.id ?? '', unitPriceWithIgvPen: qty ?? '0' },
            ],
          }
        : qty === null
          ? {}
          : { items: [{ affectedItemId: detail.items[0]?.id ?? '', qty }] }),
    }),
  );
  return invoicing.registerManual(admin, note.id, {
    series: 'F953',
    correlative: (correlative += 1),
  });
}

function returnMovements(productId: string) {
  return prisma.inventoryMovement.findMany({
    where: { itemId: productId, refType: 'SALES_RETURN' },
    orderBy: { id: 'asc' },
  });
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

function orderRow(report: SalesMarginDto, orderId: string) {
  return report.orders.find((o) => o.salesOrderId === orderId);
}

/** Pedido directo con su despacho de hoy, para revender el stock. */
async function sellToday(line: { productId: string; qty: string } | { saleCoilId: string }) {
  const order = await moduleRef.get(SalesOrdersService).createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: TODAY,
      items: [
        'saleCoilId' in line
          ? { saleCoilId: line.saleCoilId, qty: '1', unitPricePen: '15000' }
          : { productId: line.productId, qty: line.qty, unitPricePen: '50' },
      ],
    }),
  );
  await moduleRef.get(DispatchesService).create(
    admin,
    createDispatchSchema.parse({
      salesOrderId: order.id,
      dispatchDate: TODAY,
      originAddress: 'Almacén cc52',
      destinationAddress: 'Cliente cc52',
      originUbigeo: '150101',
      destinationUbigeo: '150101',
      transferMode: 'PICKUP',
      items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
    }),
  );
  return order;
}

describe('cc52: nota de crédito con devolución', () => {
  it('devolución parcial: reingresa con la fecha de la NC y al costo con que salió, con su documento', async () => {
    const { productId, invoiceId, orderId } = await sold();
    const note = await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    expect(note.salesReturn?.code).toMatch(/^DEV-\d{6}$/);
    const [movement] = await returnMovements(productId);
    expect(movement?.type).toBe('IN');
    expect(movement?.qty.toFixed(3)).toBe('2.000');
    expect(movement?.unitCost.toFixed(4)).toBe('20.0000');
    expect(movement?.totalCost.toFixed(4)).toBe('40.0000');
    expect(movement?.operationDate.toISOString().slice(0, 10)).toBe(TODAY);
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { itemType_itemId: { itemType: 'PRODUCT', itemId: productId } },
    });
    expect(balance.qty.toFixed(3)).toBe('17.000');
    // En el «Historial» de la devolución, la NC, el comprobante y el pedido.
    const ret = await prisma.salesReturn.findUniqueOrThrow({ where: { creditNoteId: note.id } });
    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'sales.return.create',
        entityId: { in: [ret.id, note.id, invoiceId, orderId] },
      },
      select: { entity: true, entityId: true },
    });
    expect(new Set(audits.map((a) => a.entityId))).toEqual(
      new Set([ret.id, note.id, invoiceId, orderId]),
    );
    // La NC también queda en el historial del comprobante y del pedido.
    const created = await prisma.auditLog.count({
      where: { action: 'invoicing.credit-note.create', entityId: { in: [invoiceId, orderId] } },
    });
    expect(created).toBe(2);
  });

  it('devolución total de lo que queda, y nunca más de lo vendido menos lo ya devuelto', async () => {
    const { productId, invoiceId } = await sold();
    await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    const over = await rejection(creditNote(invoiceId, 'DEVOLUCION_ITEM', '4'));
    expect(over.status).toBe(400);
    await creditNote(invoiceId, 'DEVOLUCION_TOTAL', null);
    const moves = await returnMovements(productId);
    expect(moves.map((m) => m.qty.toFixed(3))).toEqual(['2.000', '3.000']);
    expect(moves[1]?.totalCost.toFixed(4)).toBe('60.0000');
    const sumReturned = await prisma.salesReturnItem.aggregate({
      where: { itemId: productId },
      _sum: { qty: true },
    });
    expect(sumReturned._sum.qty?.toFixed(3)).toBe('5.000');
  });

  it('un despacho con devolución vigente no se revierte (reingresaría dos veces): 409', async () => {
    const { orderId, invoiceId } = await sold();
    await creditNote(invoiceId, 'DEVOLUCION_TOTAL', null);
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: orderId } });
    const r = await rejection(
      moduleRef
        .get(DispatchesService)
        .reverse(
          admin,
          dispatch.id,
          reverseMovementSchema.parse({ reason: 'cc52 doble reingreso' }),
        ),
    );
    expect(r.status).toBe(409);
    expect(r.message).toContain('anula primero su nota de crédito');
  });

  it('lo devuelto no vuelve a quedar pendiente de facturar', async () => {
    const { invoiceId, orderId } = await sold();
    await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    const order = await moduleRef.get(SalesOrdersService).findOne(orderId, admin);
    const r = await rejection(
      invoicing.create(
        admin,
        createInvoiceSchema.parse({
          docType: 'FACTURA',
          customerId,
          salesOrderId: orderId,
          issueDate: TODAY,
          items: [{ salesOrderItemId: order.items[0]?.id ?? '', qty: '2' }],
        }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it('descuento: solo monto, no mueve el almacén ni crea devolución', async () => {
    const { productId, invoiceId } = await sold();
    const note = await creditNote(invoiceId, 'DESCUENTO_ITEM', '1');
    expect(note.salesReturn ?? null).toBeNull();
    expect(await returnMovements(productId)).toHaveLength(0);
  });

  it('la fecha de la NC no puede ser anterior al comprobante', async () => {
    const { invoiceId } = await sold();
    const r = await rejection(creditNote(invoiceId, 'DESCUENTO_ITEM', '1', PREV(9)));
    expect(r.status).toBe(400);
    expect(r.message).toContain('anterior al comprobante');
  });

  it('una NC con devolución no cambia de fecha después', async () => {
    const { invoiceId } = await sold();
    const note = await creditNote(invoiceId, 'DEVOLUCION_ITEM', '1');
    const r = await rejection(
      invoicing.updateManualIssueDate(admin, note.id, {
        issueDate: PREV(25),
        reason: 'cc52 prueba de fecha',
      }),
    );
    expect(r.status).toBe(409);
  });

  it('anular la NC revierte la devolución con movimientos inversos; si ya se revendió, 409', async () => {
    const { productId, invoiceId } = await sold();
    const note = await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    await fiscalImport.annulExternal(admin, note.id, 'cc52 anular la NC');
    const moves = await returnMovements(productId);
    expect(moves.map((m) => m.type)).toEqual(['IN', 'OUT']);
    expect(moves[1]?.reversalOfId).toBe(moves[0]?.id);
    expect(moves[1]?.totalCost.toFixed(4)).toBe('40.0000');
    const ret = await prisma.salesReturn.findUniqueOrThrow({ where: { creditNoteId: note.id } });
    expect(ret.status).toBe('REVERSED');
  });

  it('si lo devuelto ya se volvió a vender, anular la NC da 409 y no toca nada', async () => {
    const { productId, invoiceId } = await sold();
    const note = await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    await sellToday({ productId, qty: '17' });
    const r = await rejection(fiscalImport.annulExternal(admin, note.id, 'cc52 anular tarde'));
    expect(r.status).toBe(409);
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: note.id } })).status).toBe(
      'ACCEPTED',
    );
    expect(await returnMovements(productId)).toHaveLength(1);
  });

  it('bobina vendida entera: vuelve la misma bobina con su peso y se reabre; al anular la NC se cierra', async () => {
    const red = (await prisma.color.findUniqueOrThrow({ where: { code: 'ROJO' } })).id;
    const finishId = (
      await moduleRef.get(FinishesService).create(
        admin,
        createFinishSchema.parse({
          code: `E${letters(5)}`,
          name: 'Acabado cc52',
          densityFactor: '8',
          kind: 'PREPINTADO',
          colorId: red,
          businessLine: 'metallic-roofing',
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
        issueDate: TODAY,
        currency: 'PEN',
        paymentTerms: 'CONTADO',
        businessLine: 'metallic-roofing',
        type: 'COIL',
        items: [
          {
            description: 'Bobina cc52',
            qty: '2000',
            unit: 'KGM',
            unitPrice: '5',
            finishId,
            widthMm: '1000',
            thicknessMm: '0.47',
            coilStatus: 'OPEN',
          },
        ],
      }),
    );
    await purchases.receive(admin, purchase.id);
    const coil = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    const order = await sellToday({ saleCoilId: coil.id });
    expect((await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).status).toBe('CLOSED');
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        salesOrderId: order.id,
        issueDate: TODAY,
        items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
      }),
    );
    const invoice = await invoicing.registerManual(admin, draft.id, {
      series: 'F954',
      correlative: (correlative += 1),
    });
    const note = await creditNote(invoice.id, 'DEVOLUCION_TOTAL', null);
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { itemType_itemId: { itemType: 'COIL', itemId: coil.id } },
    });
    expect(balance.qty.toFixed(3)).toBe('2000.000');
    const [movement] = await returnMovements(coil.id);
    expect(movement?.totalCost.toFixed(4)).toBe('10000.0000');
    expect((await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).status).toBe('OPEN');
    await fiscalImport.annulExternal(admin, note.id, 'cc52 anular la NC de la bobina');
    expect((await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).status).toBe('CLOSED');
    // Vuelve a estar vendida por su despacho: anular la factura y revertir el despacho la reabre
    // con su peso (D-170), en vez de dejarla cerrada con saldo.
    await fiscalImport.annulExternal(admin, invoice.id, 'cc52 anular la factura de la bobina');
    const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: order.id } });
    await moduleRef
      .get(DispatchesService)
      .reverse(
        admin,
        dispatch.id,
        reverseMovementSchema.parse({ reason: 'cc52 revertir despacho' }),
      );
    expect((await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).status).toBe('OPEN');
  });

  it('Ventas y margen: la NC del mes siguiente no cambia el mes original y resta venta y costo en el suyo', async () => {
    const { invoiceId, orderId } = await sold();
    const margin = moduleRef.get(SalesMarginService);
    const prevQuery = salesMarginQuerySchema.parse({ from: PREV_FROM, to: PREV_TO });
    const before = orderRow(await margin.salesMargin(prevQuery), orderId);
    expect(before?.costPen).toBe('100.0000');
    const note = await creditNote(invoiceId, 'DEVOLUCION_ITEM', '2');
    const after = orderRow(await margin.salesMargin(prevQuery), orderId);
    expect(after).toEqual(before);
    const report = await margin.salesMargin(
      salesMarginQuerySchema.parse({ from: THIS_FROM, to: TODAY }),
    );
    const current = orderRow(report, orderId);
    expect(current?.costStatus).not.toBe('NO_COMPARABLE');
    expect(current?.costPen).toBe('-40.0000');
    const subtotal = (await invoicing.findOne(note.id)).subtotalPen;
    expect(current?.salesPen).toBe(`-${subtotal}`);

    // cc67 (D-720): la NC aparte, marcada como de un comprobante del mes anterior, y los totales
    // separados: netas = `totals` y brutas + NC = netas, al céntimo.
    const row = report.creditNotes.find((n) => n.id === note.id);
    expect(row).toMatchObject({
      affectedDocumentId: invoiceId,
      affectedEarlierMonth: true,
      reason: 'DEVOLUCION_ITEM',
      salesPen: `-${subtotal}`,
      costPen: '-40.0000',
      inTotals: true,
    });
    const c = report.creditTotals;
    const t = report.totals;
    expect([c.netSalesPen, c.netCostPen, c.netMarginPen, c.netMarginPct]).toEqual([
      t.salesPen,
      t.costPen,
      t.marginPen,
      t.marginPct,
    ]);
    expect(new Prisma.Decimal(c.grossSalesPen).plus(c.creditSalesPen).toFixed(4)).toBe(t.salesPen);
    expect(new Prisma.Decimal(c.grossCostPen).plus(c.creditCostPen).toFixed(4)).toBe(t.costPen);
    const inTotals = report.creditNotes.filter((n) => n.inTotals);
    expect(
      inTotals.reduce((acc, n) => acc.plus(n.costPen ?? 0), new Prisma.Decimal(0)).toFixed(4),
    ).toBe(c.creditCostPen);
  });

  it('cc67 (D-720): una NC 01 sin DEV-, con el despacho revertido aparte, se lleva la reversa', async () => {
    // Decisión del dueño (cc67): la factura queda en brutas con su costo real y la NC resta venta
    // y costo. Una NC 01 registrada a mano hoy devuelve con su DEV- lo despachado (D-656), así que
    // el caso se arma con la NC antes del despacho (no hay nada que devolver) y el despacho y su
    // reversa después: la reversa es una fila `SALE` sin comprobante declarado, como la de una
    // anulación del mostrador o de un despacho revertido a mano antes de cc54.
    const productId = (
      await moduleRef.get(CatalogService).create(
        admin,
        createProductSchema.parse({
          businessLineId: tradingLineId,
          sku: `T-CC67NC-${letters(8)}`,
          name: 'Producto cc67 NC 01',
          unit: 'NIU',
          source: 'PURCHASED',
        }),
      )
    ).id;
    await buy(productId, '10', '20', PREV(5));
    const salesOrder = await moduleRef.get(SalesOrdersService).createDirect(
      admin,
      createSalesOrderSchema.parse({
        customerId,
        issueDate: PREV(10),
        items: [{ productId, qty: '5', unitPricePen: '50' }],
      }),
    );
    const orderId = salesOrder.id;
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        salesOrderId: orderId,
        issueDate: PREV(10),
        items: salesOrder.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
      }),
    );
    const invoice = await invoicing.registerManual(admin, draft.id, {
      series: 'F952',
      correlative: (correlative += 1),
    });
    const note = await creditNote(invoice.id, 'ANULACION_OPERACION', null, PREV(12));
    expect(await prisma.salesReturn.count({ where: { creditNoteId: note.id } })).toBe(0);
    const dispatch = await moduleRef.get(DispatchesService).create(
      admin,
      createDispatchSchema.parse({
        salesOrderId: orderId,
        dispatchDate: PREV(14),
        confirmBackdate: true,
        originAddress: 'Almacén cc67',
        destinationAddress: 'Cliente cc67',
        originUbigeo: '150101',
        destinationUbigeo: '150101',
        transferMode: 'PICKUP',
        items: salesOrder.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
      }),
    );
    await moduleRef
      .get(DispatchesService)
      .reverse(
        admin,
        dispatch.id,
        reverseMovementSchema.parse({ reason: 'cc67 revertir despacho' }),
      );

    const report = await moduleRef
      .get(SalesMarginService)
      .salesMargin(salesMarginQuerySchema.parse({ from: PREV_FROM, to: PREV_TO }));
    const order = orderRow(report, orderId);
    // El pedido entero: la venta se anula y el costo vuelve con la reversa.
    expect(order?.salesPen).toBe('0.0000');
    expect(order?.costPen).toBe('0.0000');
    const subtotal = (await invoicing.findOne(note.id)).subtotalPen;
    expect(report.creditNotes.find((n) => n.id === note.id)).toMatchObject({
      salesPen: `-${subtotal}`,
      costPen: '-100.0000',
      marginPen: new Prisma.Decimal(subtotal).negated().plus(100).toFixed(4),
      inTotals: true,
    });
    const c = report.creditTotals;
    const t = report.totals;
    expect([c.netSalesPen, c.netCostPen, c.netMarginPen]).toEqual([
      t.salesPen,
      t.costPen,
      t.marginPen,
    ]);
  });
});

/**
 * cc69 (D-728) — **la NC conserva su fecha; lo que sale de un despacho posterior reingresa en la
 * fecha de ese despacho**, al costo con que salió. Ventas y margen sigue en el mes de la NC.
 */
describe('cc69 (D-728): NC fechada antes del despacho', () => {
  async function newProduct(label: string) {
    return (
      await moduleRef.get(CatalogService).create(
        admin,
        createProductSchema.parse({
          businessLineId: tradingLineId,
          sku: `T-CC69-${label}-${letters(6)}`,
          name: `Producto cc69 ${label}`,
          unit: 'NIU',
          source: 'PURCHASED',
        }),
      )
    ).id;
  }

  async function order(productId: string, qty: string, issueDate: string) {
    return moduleRef.get(SalesOrdersService).createDirect(
      admin,
      createSalesOrderSchema.parse({
        customerId,
        issueDate,
        items: [{ productId, qty, unitPricePen: '50' }],
      }),
    );
  }

  type Order = Awaited<ReturnType<typeof order>>;

  async function dispatch(o: Order, qty: string, date: string) {
    await moduleRef.get(DispatchesService).create(
      admin,
      createDispatchSchema.parse({
        salesOrderId: o.id,
        dispatchDate: date,
        confirmBackdate: true,
        originAddress: 'Almacén cc69',
        destinationAddress: 'Cliente cc69',
        originUbigeo: '150101',
        destinationUbigeo: '150101',
        transferMode: 'PICKUP',
        items: o.items.map((i) => ({ salesOrderItemId: i.id, qty })),
      }),
    );
  }

  async function invoice(o: Order, issueDate: string) {
    const draft = await invoicing.create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        salesOrderId: o.id,
        issueDate,
        items: o.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
      }),
    );
    return invoicing.registerManual(admin, draft.id, {
      series: 'F955',
      correlative: (correlative += 1),
    });
  }

  const day = (d: Date | undefined) => d?.toISOString().slice(0, 10);

  async function valuationOf(productId: string) {
    const report = await moduleRef.get(InventoryValuationService).valuation();
    return report.products.find((p) => p.itemId === productId);
  }

  async function marginNote(from: string, to: string, noteId: string) {
    const report = await moduleRef
      .get(SalesMarginService)
      .salesMargin(salesMarginQuerySchema.parse({ from, to }));
    const c = report.creditTotals;
    const t = report.totals;
    // D-720: netas = `totals`, al céntimo.
    expect([c.netSalesPen, c.netCostPen]).toEqual([t.salesPen, t.costPen]);
    return report.creditNotes.find((n) => n.id === noteId);
  }

  it('mismo mes: la NC queda en su fecha y el reingreso entra el día del despacho', async () => {
    const productId = await newProduct('MES');
    await buy(productId, '10', '20', PREV(5));
    const o = await order(productId, '5', PREV(6));
    const inv = await invoice(o, PREV(7));
    await dispatch(o, '5', PREV(12));
    const detail = await invoicing.findOne(inv.id);
    const preview = await invoicing.previewCreditNote(
      admin,
      inv.id,
      createCreditNoteSchema.parse({
        reason: 'DEVOLUCION_ITEM',
        issueDate: PREV(8),
        items: [{ affectedItemId: detail.items[0]?.id ?? '', qty: '2' }],
      }),
    );
    expect(preview.stock).toEqual([
      expect.objectContaining({ entryDate: PREV(12), afterCreditNote: true, qty: '2.000' }),
    ]);
    const note = await creditNote(inv.id, 'DEVOLUCION_ITEM', '2', PREV(8));
    const stored = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: note.id } });
    expect(day(stored.issueDate)).toBe(PREV(8));
    const [movement] = await returnMovements(productId);
    expect(movement?.type).toBe('IN');
    expect(day(movement?.operationDate)).toBe(PREV(12));
    expect(movement?.totalCost.toFixed(4)).toBe('40.0000');
    const ret = await prisma.salesReturn.findUniqueOrThrow({ where: { creditNoteId: note.id } });
    expect(day(ret.operationDate)).toBe(PREV(12));
    const dto = await moduleRef.get(SalesReturnsService).findOne(ret.id);
    expect(dto).toMatchObject({ operationDate: PREV(12), creditNoteDate: PREV(8) });
    expect(dto.items[0]).toMatchObject({ operationDate: PREV(12), dispatchDate: PREV(12) });

    expect(await marginNote(PREV_FROM, PREV_TO, note.id)).toMatchObject({ costPen: '-40.0000' });
    expect(await valuationOf(productId)).toMatchObject({ qty: '7.000', totalValuePen: '140.0000' });
  });

  it('mes anterior: venta y costo bajan en el mes de la NC; el almacén, el día del despacho', async () => {
    const productId = await newProduct('ANT');
    await buy(productId, '10', '20', PREV(5));
    const o = await order(productId, '5', PREV(25));
    const inv = await invoice(o, PREV(26));
    await dispatch(o, '5', THIS_FROM);
    const note = await creditNote(inv.id, 'DEVOLUCION_TOTAL', null, PREV(27));
    const [movement] = await returnMovements(productId);
    expect(day(movement?.operationDate)).toBe(THIS_FROM);
    expect(movement?.totalCost.toFixed(4)).toBe('100.0000');
    expect(await marginNote(PREV_FROM, PREV_TO, note.id)).toMatchObject({
      costPen: '-100.0000',
      inTotals: true,
    });
    expect(await marginNote(THIS_FROM, TODAY, note.id)).toBeUndefined();
    expect(await valuationOf(productId)).toMatchObject({
      qty: '10.000',
      totalValuePen: '200.0000',
    });
  });

  it('repartida en dos despachos: cada parte con su fecha y el costo de su salida, recosteada', async () => {
    // 2 u a 20 y 8 u a 30. DES-A (día 5) saca 2 a 20; DES-B (día 15) saca 3 al promedio de ese día.
    // La NC del día 10 devuelve 4: 2 de DES-A (hasta la NC, el día 10) y 2 de DES-B (el día 15).
    // La parte del día 10 vuelve a 20 y recostea DES-B: 10 u por 280 → 28; DES-B sale a 84 y su
    // parte devuelta lo sigue (2/3 de 84 = 56). Grabada antes la parte temprana, quedaría a 60.
    const productId = await newProduct('DOS');
    await buy(productId, '2', '20', PREV(3));
    // El pedido reserva al crearse: la segunda compra se graba antes, con su fecha (día 9).
    await buy(productId, '8', '30', PREV(9));
    const o = await order(productId, '5', PREV(4));
    await dispatch(o, '2', PREV(5));
    const inv = await invoice(o, PREV(6));
    await dispatch(o, '3', PREV(15));
    const note = await creditNote(inv.id, 'DEVOLUCION_ITEM', '4', PREV(10));
    const ret = await prisma.salesReturn.findUniqueOrThrow({
      where: { creditNoteId: note.id },
      include: { items: { orderBy: { lineNumber: 'asc' }, include: { movement: true } } },
    });
    expect(day(ret.operationDate)).toBe(PREV(15));
    expect(ret.items.map((i) => [i.qty.toFixed(3), day(i.movement.operationDate)])).toEqual([
      ['2.000', PREV(10)],
      ['2.000', PREV(15)],
    ]);
    const recosts = await prisma.inventoryMovement.aggregate({
      where: { recostOfId: { in: ret.items.map((i) => i.movementId) } },
      _sum: { totalCost: true },
    });
    const effective = ret.items
      .reduce((acc, i) => acc.plus(i.totalCost), new Prisma.Decimal(0))
      .plus(recosts._sum.totalCost ?? 0);
    expect(effective.toFixed(4)).toBe('96.0000');
    // La DEV- muestra ese mismo costo efectivo (autorrevisión de cc69, P2-1).
    const dto = await moduleRef.get(SalesReturnsService).findOne(ret.id);
    expect(dto.totalCostPen).toBe('96.0000');
    expect(await valuationOf(productId)).toMatchObject({ qty: '9.000', totalValuePen: '252.0000' });
    expect(await marginNote(PREV_FROM, PREV_TO, note.id)).toMatchObject({ costPen: '-96.0000' });
  });

  it('anular la NC revierte cada reingreso con la fecha del día en que se anula', async () => {
    const productId = await newProduct('ANU');
    await buy(productId, '10', '20', PREV(5));
    const o = await order(productId, '5', PREV(6));
    const inv = await invoice(o, PREV(7));
    await dispatch(o, '5', PREV(12));
    const note = await creditNote(inv.id, 'DEVOLUCION_ITEM', '2', PREV(8));
    await fiscalImport.annulExternal(admin, note.id, 'cc69 anular la NC');
    const moves = await returnMovements(productId);
    expect(moves.map((m) => [m.type, day(m.operationDate)])).toEqual([
      ['IN', PREV(12)],
      ['OUT', TODAY],
    ]);
    expect(moves[1]?.reversalOfId).toBe(moves[0]?.id);
    expect(await valuationOf(productId)).toMatchObject({ qty: '5.000', totalValuePen: '100.0000' });
  });

  it('la 01 también devuelve lo despachado después de la NC, en la fecha del despacho', async () => {
    const productId = await newProduct('ANU01');
    await buy(productId, '10', '20', PREV(5));
    const o = await order(productId, '5', PREV(6));
    const inv = await invoice(o, PREV(7));
    await dispatch(o, '5', PREV(12));
    const note = await creditNote(inv.id, 'ANULACION_OPERACION', null, PREV(8));
    const [movement] = await returnMovements(productId);
    expect([movement?.qty.toFixed(3), day(movement?.operationDate)]).toEqual(['5.000', PREV(12)]);
    expect(await marginNote(PREV_FROM, PREV_TO, note.id)).toMatchObject({ costPen: '-100.0000' });
    expect(await valuationOf(productId)).toMatchObject({
      qty: '10.000',
      totalValuePen: '200.0000',
    });
  });

  it('sin despacho todavía, lo dice con la causa real', async () => {
    const productId = await newProduct('SIN');
    await buy(productId, '10', '20', PREV(5));
    const o = await order(productId, '5', PREV(6));
    const inv = await invoice(o, PREV(7));
    const r = await rejection(creditNote(inv.id, 'DEVOLUCION_ITEM', '2', PREV(8)));
    expect(r).toEqual({
      status: 400,
      message:
        'Línea 1: no hay nada despachado de este comprobante; si la mercadería no salió del almacén, usa «Rebajar el precio».',
    });
  });
});
