import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCoilScrapSchema,
  createCoilSplitSchema,
  createCustomerSchema,
  createDispatchSchema,
  createFinishSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  type SalesOrderDto,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CoilOperationsService } from '../coils/coil-operations.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';

/**
 * cc57 (B-02 de audit-01) — **las creaciones repetibles que movían stock sin clave, contra una base
 * real.** Pedido directo (reservas), despacho (salida de kardex), partido y merma de bobina, y la
 * cotización: el mismo intento (misma `idempotencyKey`, el reintento tras un corte de red) deja un
 * solo efecto y devuelve el mismo recurso, en serie y a la vez; sin clave, dos envíos son dos
 * hechos (el guardrail es opt-in, D-182).
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let admin: RequestUser;
let tradingLineId = '';
let supplierId = '';
let customerId = '';
let finishId = '';

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
        name: 'Proveedor cc57',
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
        name: 'Cliente cc57',
        creditDays: 0,
      }),
    )
  ).id;
  const redColorId = (await prisma.color.findUniqueOrThrow({ where: { code: 'ROJO' } })).id;
  finishId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `E${letters(5)}`,
        name: 'Acabado cc57',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId: redColorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

/** Un producto de reventa con 100 u compradas a S/ 20. */
async function stockedProduct(): Promise<string> {
  const productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC57-${letters(8)}`,
        name: 'Producto cc57',
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
        { productId, description: 'Producto cc57', qty: '100', unit: 'NIU', unitPrice: '20' },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return productId;
}

/** Una bobina de coberturas de 2 000 kg recibida. */
async function coil(): Promise<string> {
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
      businessLine: 'metallic-roofing',
      type: 'COIL',
      items: [
        {
          description: 'Bobina cc57',
          qty: '2000',
          unit: 'KGM',
          unitPrice: '5',
          finishId,
          widthMm: '1000',
          thicknessMm: '0.40',
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return (await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } })).id;
}

function orderInput(productId: string, idempotencyKey?: string) {
  return createSalesOrderSchema.parse({
    customerId,
    issueDate: businessToday(),
    items: [{ productId, qty: '10', unitPricePen: '50' }],
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

function dispatchInput(order: SalesOrderDto, idempotencyKey?: string) {
  return createDispatchSchema.parse({
    salesOrderId: order.id,
    dispatchDate: businessToday(),
    originAddress: 'Almacén cc57',
    destinationAddress: 'Cliente cc57',
    originUbigeo: '150101',
    destinationUbigeo: '150101',
    transferMode: 'PICKUP',
    // Parcial: el reintento podía volver a sacar la misma cantidad.
    items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: '3' })),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

const outs = (productId: string) =>
  prisma.inventoryMovement.count({ where: { itemId: productId, type: 'OUT', refType: 'SALE' } });

describe('cc57 (B-02): pedido directo y despacho con clave de idempotencia', () => {
  it('el mismo intento de pedido directo, en serie y a la vez, deja un solo pedido', async () => {
    const orders = moduleRef.get(SalesOrdersService);
    const productId = await stockedProduct();
    const key = randomUUID();
    const first = await orders.createDirect(admin, orderInput(productId, key));
    const again = await orders.createDirect(admin, orderInput(productId, key));
    expect(again.id).toBe(first.id);
    const raced = randomUUID();
    const [a, b] = await Promise.all([
      orders.createDirect(admin, orderInput(productId, raced)),
      orders.createDirect(admin, orderInput(productId, raced)),
    ]);
    expect(a.id).toBe(b.id);
    const lines = await prisma.salesOrderItem.count({ where: { productId } });
    expect(lines).toBe(2);
  });

  it('el mismo intento de un despacho parcial no saca dos veces del kardex', async () => {
    const productId = await stockedProduct();
    const order = await moduleRef
      .get(SalesOrdersService)
      .createDirect(admin, orderInput(productId));
    const dispatches = moduleRef.get(DispatchesService);
    const key = randomUUID();
    const first = await dispatches.create(admin, dispatchInput(order, key));
    const again = await dispatches.create(admin, dispatchInput(order, key));
    expect(again.id).toBe(first.id);
    expect(await outs(productId)).toBe(1);
    const raced = randomUUID();
    const [a, b] = await Promise.all([
      dispatches.create(admin, dispatchInput(order, raced)),
      dispatches.create(admin, dispatchInput(order, raced)),
    ]);
    expect(a.id).toBe(b.id);
    expect(await outs(productId)).toBe(2);
  });

  it('sin clave, dos despachos parciales iguales son dos despachos (opt-in)', async () => {
    const productId = await stockedProduct();
    const order = await moduleRef
      .get(SalesOrdersService)
      .createDirect(admin, orderInput(productId));
    const dispatches = moduleRef.get(DispatchesService);
    await dispatches.create(admin, dispatchInput(order));
    await dispatches.create(admin, dispatchInput(order));
    expect(await outs(productId)).toBe(2);
  });
});

describe('cc57 (B-02): partido, merma y cotización con clave de idempotencia', () => {
  it('el mismo intento de partido devuelve las mismas hijas y parte una sola vez', async () => {
    const coilOps = moduleRef.get(CoilOperationsService);
    const coilId = await coil();
    const body = (idempotencyKey: string) =>
      createCoilSplitSchema.parse({
        splitWeightKg: '1000',
        children: [{ widthMm: '500.00', count: 2 }],
        idempotencyKey,
      });
    const key = randomUUID();
    const first = await coilOps.split(admin, coilId, body(key));
    const again = await coilOps.split(admin, coilId, body(key));
    expect(again.map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    expect(await prisma.coilSplit.count({ where: { parentCoilId: coilId } })).toBe(1);
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { itemType_itemId: { itemType: 'COIL', itemId: coilId } },
    });
    expect(balance.qty.toString()).toBe('1000');
  });

  it('el mismo intento de merma, a la vez, merma una sola vez', async () => {
    const coilOps = moduleRef.get(CoilOperationsService);
    const coilId = await coil();
    const body = createCoilScrapSchema.parse({
      qtyKg: '50',
      reason: 'merma cc57',
      idempotencyKey: randomUUID(),
    });
    await Promise.all([
      coilOps.registerScrap(admin, coilId, body),
      coilOps.registerScrap(admin, coilId, body),
    ]);
    const scraps = await prisma.inventoryMovement.count({
      where: { itemId: coilId, type: 'OUT', refType: 'SCRAP' },
    });
    expect(scraps).toBe(1);
  });

  it('el mismo intento de cotización devuelve la misma cotización', async () => {
    const quotations = moduleRef.get(QuotationsService);
    const productId = await stockedProduct();
    const body = createQuotationSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: [{ productId, qty: '2', unitPricePen: '50' }],
      idempotencyKey: randomUUID(),
    });
    const first = await quotations.create(admin, body);
    const again = await quotations.create(admin, body);
    expect(again.id).toBe(first.id);
    expect(await prisma.quotationItem.count({ where: { productId } })).toBe(1);
  });
});
