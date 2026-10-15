import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
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
import { SalesMarginService } from '../reports/sales-margin.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { DispatchesService } from './dispatches.service';
import { FiscalImportService } from './fiscal-import.service';
import { InvoicingService } from './invoicing.service';

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
    const current = orderRow(
      await margin.salesMargin(salesMarginQuerySchema.parse({ from: THIS_FROM, to: TODAY })),
      orderId,
    );
    expect(current?.costStatus).not.toBe('NO_COMPARABLE');
    expect(current?.costPen).toBe('-40.0000');
    expect(current?.salesPen).toBe(`-${(await invoicing.findOne(note.id)).subtotalPen}`);
  });
});
