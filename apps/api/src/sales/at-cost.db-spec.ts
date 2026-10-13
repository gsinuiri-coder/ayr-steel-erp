import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCustomerSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  salesMarginQuerySchema,
  updateSalesOrderItemPriceSchema,
  type SalesItemInput,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesMarginService } from '../reports/sales-margin.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { QuotationsService } from './quotations.service';
import { SalesOrderEditsService } from './sales-order-edits.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * cc51 (D-641) — **vender a costo, contra una base real.** Un producto de reventa comprado a
 * S/ 20.00 (sin IGV): con el margen mínimo de la semilla (10 %) el piso es S/ 22.2222 de valor
 * (S/ 26.23 con IGV); a costo, S/ 20.0000 (S/ 23.60 con IGV).
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let quotations: QuotationsService;
let salesOrders: SalesOrdersService;
let edits: SalesOrderEditsService;
let audit: AuditService;
let admin: RequestUser;
let seller: RequestUser;
let customerId = '';
let productId = '';

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
  quotations = moduleRef.get(QuotationsService);
  salesOrders = moduleRef.get(SalesOrdersService);
  edits = moduleRef.get(SalesOrderEditsService);
  audit = moduleRef.get(AuditService);

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
  // El mismo usuario con rol VENDEDOR: es dueño de lo que cotiza, así que el alcance por vendedor
  // no interfiere y lo único que cambia es el rol.
  seller = { ...admin, role: Role.VENDEDOR };

  const tradingLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'TRADING' } })
  ).id;
  const supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc51',
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
        name: 'Cliente cc51',
        creditDays: 0,
      }),
    )
  ).id;
  productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC51-${letters(8)}`,
        name: 'Producto cc51',
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
      issueDate: businessToday(),
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'trading',
      type: 'FINISHED_GOOD',
      items: [
        { productId, description: 'Producto cc51', qty: '100', unit: 'NIU', unitPrice: '20' },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await moduleRef?.close();
});

const atCost = { reason: 'LIQUIDACION' as const };

function quote(actor: RequestUser, items: SalesItemInput[]) {
  return quotations.create(
    actor,
    createQuotationSchema.parse({ customerId, issueDate: businessToday(), items }),
  );
}

function line(unitPriceWithIgvPen: string, mark?: SalesItemInput['atCost']): SalesItemInput {
  return { productId, qty: '2.000', unitPriceWithIgvPen, ...(mark ? { atCost: mark } : {}) };
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

function atCostAudits(quotationId: string) {
  return prisma.auditLog.findMany({
    where: { entity: 'quotations', entityId: quotationId, action: 'sales.quotation.line-at-cost' },
    orderBy: { id: 'asc' },
  });
}

describe('cc51 (D-641) — vender a costo en la cotización', () => {
  it('el ADMINISTRADOR vende a costo con motivo: la línea queda marcada y auditada con su costo', async () => {
    const q = await quote(admin, [line('23.60', atCost)]);
    expect(q.items[0]).toMatchObject({ atCostReason: 'LIQUIDACION', atCostNote: null });
    expect(q.items[0]?.unitPricePen).toBe('20.0000');
    const rows = await atCostAudits(q.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(admin.id);
    expect(rows[0]?.reason).toBe('Liquidación de stock');
    expect(rows[0]?.after).toMatchObject({
      lineNumber: 1,
      unitValuePen: '20.0000',
      costPen: '20.0000',
      atCostPricePen: '23.60',
      atCostReason: 'LIQUIDACION',
    });
  });

  it('por debajo del costo se rechaza, con un mensaje que dice el precio a costo', async () => {
    const r = await rejection(quote(admin, [line('23.59', atCost)]));
    expect(r.status).toBe(400);
    expect(r.message).toContain('a costo el precio es S/ 23.60');
    expect(r.message).toContain('Por debajo del costo no se vende');
  });

  it('el VENDEDOR no puede marcar una línea a costo (403)', async () => {
    const before = await prisma.quotation.count();
    const r = await rejection(quote(seller, [line('23.60', atCost)]));
    expect(r.status).toBe(403);
    expect(await prisma.quotation.count()).toBe(before);
    // Revisión P1: con un precio bajo el costo también es 403, sin pasar por el piso: el rechazo
    // a costo diría el costo, que un VENDEDOR no ve.
    const low = await rejection(quote(seller, [line('0.01', atCost)]));
    expect(low.status).toBe(403);
    expect(low.message).not.toMatch(/\d+\.\d{2}/);
  });

  it('el VENDEDOR sigue con el piso de hoy en una línea normal', async () => {
    const r = await rejection(quote(seller, [line('23.60')]));
    expect(r.status).toBe(400);
    expect(r.message).toContain('margen mínimo');
  });

  it('sin motivo no hay marca: el motivo es parte del schema, y «Otro» pide el texto', () => {
    const parse = (item: unknown) =>
      createQuotationSchema.safeParse({ customerId, issueDate: businessToday(), items: [item] })
        .success;
    expect(parse({ productId, qty: '1', atCost: {} })).toBe(false);
    expect(parse({ productId, qty: '1', atCost: { reason: 'OTRO' } })).toBe(false);
    expect(parse({ productId, qty: '1', atCost: { reason: 'OTRO', note: 'Muestra' } })).toBe(true);
    expect(parse({ productId, qty: '1', atCost: { reason: 'FRECUENTE', note: 'x' } })).toBe(false);
  });

  it('una línea normal no cambia: misma fórmula de margen sobre venta y mismo redondeo', async () => {
    const q = await quote(admin, [line('26.23')]);
    expect(q.items[0]).toMatchObject({
      unitPricePen: '22.2288',
      subtotalPen: '44.4576',
      totalPen: '52.4600',
      atCostReason: null,
    });
    expect(await atCostAudits(q.id)).toHaveLength(0);
    // Un céntimo bajo el piso normal sigue rebotando para el ADMINISTRADOR sin la marca.
    expect((await rejection(quote(admin, [line('26.22')]))).status).toBe(400);
  });

  it('si el registro de auditoría falla, la cotización no se guarda', async () => {
    const original = audit.write.bind(audit);
    const spy = jest
      .spyOn(audit, 'write')
      .mockImplementation((tx, entry: AuditEntry) =>
        entry.action === 'sales.quotation.line-at-cost'
          ? Promise.reject(new Error('auditoría caída'))
          : original(tx, entry),
      );
    const before = await prisma.quotation.count();
    try {
      await expect(quote(admin, [line('23.60', atCost)])).rejects.toThrow('auditoría caída');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.quotation.count()).toBe(before);
  });

  it('el VENDEDOR edita una cotización con una línea a costo: igual pasa, cambiada no', async () => {
    const q = await quote(admin, [line('23.60', atCost)]);
    const body = (items: SalesItemInput[]) =>
      createQuotationSchema.parse({ customerId, issueDate: businessToday(), items });
    // Igual: misma línea, mismo precio y motivo, y una línea normal nueva al lado.
    const same = await quotations.update(
      seller,
      q.id,
      body([line('23.60', atCost), line('30.00')]),
    );
    expect(same.items.map((i) => i.atCostReason)).toEqual(['LIQUIDACION', null]);
    expect(await atCostAudits(q.id)).toHaveLength(1);
    // Cambiada (otro precio, aun por encima del costo): 403.
    expect(
      (await rejection(quotations.update(seller, q.id, body([line('23.70', atCost)])))).status,
    ).toBe(403);
    // Otro motivo: también.
    expect(
      (
        await rejection(
          quotations.update(seller, q.id, body([line('23.60', { reason: 'FRECUENTE' })])),
        )
      ).status,
    ).toBe(403);
    // El VENDEDOR tampoco «mueve» la marca a otro producto ni la agrega en otra línea.
    expect(
      (
        await rejection(
          quotations.update(seller, q.id, body([line('23.60', atCost), line('23.60', atCost)])),
        )
      ).status,
    ).toBe(403);
    // El ADMINISTRADOR sí la cambia, y queda un registro más.
    await quotations.update(admin, q.id, body([line('23.70', atCost)]));
    expect(await atCostAudits(q.id)).toHaveLength(2);
    // Revisión P2: quitar la marca también queda en la cotización.
    await quotations.update(admin, q.id, body([line('30.00')]));
    const removed = await prisma.auditLog.findMany({
      where: {
        entity: 'quotations',
        entityId: q.id,
        action: 'sales.quotation.line-at-cost-removed',
      },
    });
    expect(removed).toHaveLength(1);
    expect(removed[0]?.actorId).toBe(admin.id);
    expect(removed[0]?.before).toMatchObject({ productId, atCostReason: 'LIQUIDACION' });
  });

  it('el pedido hereda la marca al confirmar; cambiarle el precio la quita y pasa por el piso', async () => {
    const q = await quote(admin, [line('23.60', { reason: 'OTRO', note: 'Muestra para obra' })]);
    const order = await salesOrders.confirm(admin, q.id, {});
    expect(order.items[0]).toMatchObject({ atCostReason: 'OTRO', atCostNote: 'Muestra para obra' });
    const itemId = order.items[0]?.id ?? '';
    // El piso del pedido es el de siempre: a costo ya no pasa.
    expect(
      (
        await rejection(
          edits.updateItemPrice(
            admin,
            order.id,
            itemId,
            updateSalesOrderItemPriceSchema.parse({ unitPriceWithIgvPen: '23.70' }),
          ),
        )
      ).status,
    ).toBe(400);
    const repriced = await edits.updateItemPrice(
      admin,
      order.id,
      itemId,
      updateSalesOrderItemPriceSchema.parse({ unitPriceWithIgvPen: '27.00' }),
    );
    expect(repriced.items[0]?.atCostReason).toBeNull();
  });

  it('fuera de la cotización (pedido directo) la marca es un 400', async () => {
    const r = await rejection(
      salesOrders.createDirect(
        admin,
        createSalesOrderSchema.parse({
          customerId,
          issueDate: businessToday(),
          items: [line('23.60', atCost)],
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain('se marca en la cotización');
  });

  it('Ventas y margen: el filtro «A costo» deja los pedidos con alguna línea a costo', async () => {
    const invoicing = moduleRef.get(InvoicingService);
    let correlative = Math.floor(Math.random() * 50_000) + 10_000;
    /** Cotiza, confirma y factura (manual) una línea; devuelve el pedido. */
    async function sold(item: SalesItemInput): Promise<string> {
      const q = await quote(admin, [item]);
      const order = await salesOrders.confirm(admin, q.id, {});
      const draft = await invoicing.create(
        admin,
        createInvoiceSchema.parse({
          docType: 'FACTURA',
          customerId,
          salesOrderId: order.id,
          issueDate: businessToday(),
          items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
        }),
      );
      const invoice = await invoicing.registerManual(admin, draft.id, {
        series: 'F951',
        correlative: (correlative += 1),
      });
      // El detalle del comprobante lleva la marca de su línea de pedido (solo pantalla).
      const detail = await invoicing.findOne(invoice.id);
      expect(detail.items[0]?.atCostReason).toBe(item.atCost ? 'LIQUIDACION' : null);
      return order.id;
    }
    const atCostOrder = await sold(line('23.60', atCost));
    const normalOrder = await sold(line('30.00'));

    const margin = moduleRef.get(SalesMarginService);
    const today = businessToday();
    const all = await margin.salesMargin(salesMarginQuerySchema.parse({ from: today, to: today }));
    const only = await margin.salesMargin(
      salesMarginQuerySchema.parse({ from: today, to: today, atCost: 'true' }),
    );
    const ids = (r: typeof all) => r.orders.map((o) => o.salesOrderId);
    expect(ids(all)).toEqual(expect.arrayContaining([atCostOrder, normalOrder]));
    expect(ids(only)).toContain(atCostOrder);
    expect(ids(only)).not.toContain(normalOrder);
    expect(only.orders.every((o) => o.atCost)).toBe(true);
    expect(all.orders.find((o) => o.salesOrderId === normalOrder)?.atCost).toBe(false);
  });

  it('autorrevisión: el VENDEDOR no cambia la cantidad de una línea a costo ni el cliente', async () => {
    const q = await quote(admin, [line('23.60', atCost)]);
    // La cotización pasa a ser del vendedor (mismo usuario con otro rol, ver arriba).
    const otherCustomer = (
      await moduleRef.get(CustomersService).create(
        admin,
        createCustomerSchema.parse({
          docType: 'RUC',
          docNumber: `20${digits(9)}`,
          name: 'Otro cliente cc51',
          creditDays: 0,
        }),
      )
    ).id;
    expect(
      (
        await rejection(
          quotations.update(
            seller,
            q.id,
            createQuotationSchema.parse({
              customerId: otherCustomer,
              issueDate: businessToday(),
              items: [line('23.60', atCost)],
            }),
          ),
        )
      ).status,
    ).toBe(403);
    const order = await salesOrders.confirm(admin, q.id, {});
    const r = await rejection(
      edits.updateItemQty(seller, order.id, order.items[0]?.id ?? '', { qty: '5.000' } as never),
    );
    expect(r.status).toBe(403);
  });

  it('autorrevisión: duplicar como ADMINISTRADOR conserva la marca; como VENDEDOR, no', async () => {
    const q = await quote(admin, [line('23.60', atCost)]);
    const copy = await quotations.duplicate(admin, q.id);
    const copied = await quotations.findOne(copy.id, admin);
    expect(copied.items[0]?.atCostReason).toBe('LIQUIDACION');
    // El vendedor duplica sin la marca: la línea pasa por el piso de siempre y rebota.
    expect((await rejection(quotations.duplicate(seller, q.id))).status).toBe(400);
  });
});
