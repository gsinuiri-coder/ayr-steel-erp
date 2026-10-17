import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCustomerSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createSalesOrderSchema,
  createSupplierSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { InvoicingService, SEND_CLAIM_LEASE_MS } from './invoicing.service';

/**
 * cc57 (B-04 de audit-01) — **el reclamo de un envío al PSE, contra una base real.** Dos envíos a la
 * vez del mismo comprobante (el barrido del job y «Reintentar», o dos instancias) no pueden salir
 * los dos a la red con el mismo correlativo: solo uno reclama; el otro, después del plazo.
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(5 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let invoicing: InvoicingService;
let admin: RequestUser;

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
});

afterAll(async () => {
  await moduleRef?.close();
});

/** Un comprobante en borrador, pasado a `SEND_ERROR` como si su primer envío no hubiera entrado. */
async function failedSend(): Promise<string> {
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
        name: 'Proveedor cc57 PSE',
        creditDays: 0,
      }),
    )
  ).id;
  const customerId = (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc57 PSE',
        creditDays: 0,
      }),
    )
  ).id;
  const productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC57P-${letters(8)}`,
        name: 'Producto cc57 PSE',
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
      items: [{ productId, description: 'Producto', qty: '10', unit: 'NIU', unitPrice: '20' }],
    }),
  );
  await purchases.receive(admin, purchase.id);
  const order = await moduleRef.get(SalesOrdersService).createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: [{ productId, qty: '2', unitPricePen: '50' }],
    }),
  );
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
  // El estado de un envío que no entró (fixture: el PSE está apagado en las pruebas).
  await prisma.fiscalDocument.update({
    where: { id: draft.id },
    data: { status: 'SEND_ERROR', sendAttempts: 1, lastAttemptAt: null },
  });
  return draft.id;
}

const claim = (id: string) =>
  (
    invoicing as unknown as {
      claimAttempt: (id: string, o: { counts: boolean }) => Promise<boolean>;
    }
  ).claimAttempt(id, { counts: true });

describe('cc57 (B-04): un solo envío al PSE a la vez', () => {
  it('dos reclamos simultáneos del mismo comprobante: sale uno solo', async () => {
    const id = await failedSend();
    const results = await Promise.all([claim(id), claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Y uno en serie, todavía dentro del plazo, tampoco sale.
    expect(await claim(id)).toBe(false);
  });

  it('pasado el plazo, el reintento vuelve a reclamar', async () => {
    const id = await failedSend();
    await prisma.fiscalDocument.update({
      where: { id },
      data: { lastAttemptAt: new Date(Date.now() - SEND_CLAIM_LEASE_MS - 1_000) },
    });
    expect(await claim(id)).toBe(true);
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id } });
    expect(row.sendAttempts).toBe(2);
  });
});
