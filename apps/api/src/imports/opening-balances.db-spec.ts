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
  registerCreditNoteSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { OperationDateService } from '../common/operation-date.service';
import { CustomersService } from '../customers/customers.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { ReceivablesService } from '../invoicing/receivables.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import type { OpeningRow } from './opening-balances-plan';
import { supplierKey } from './opening-balances-sheets';
import {
  OPENING_BATCH_ACTION,
  OpeningBalancesImporter,
  OpeningBatchRejected,
} from './opening-balances.service';

/**
 * cc56 (D-668) — el importador de saldos iniciales **contra una base real**: registra por las
 * puertas de cobranzas y compras, todo o nada, con su lote en la auditoría, y se deshace entero.
 *
 * Escenario: dos facturas de S/ 295 (5 u × S/ 50 + IGV, emitidas el día 10 del mes anterior) y una
 * compra de S/ 236 (200 + IGV, día 5). Corte: el día 28 del mes anterior.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let importer: OpeningBalancesImporter;
let admin: RequestUser;
let supplierId = '';
let supplierDoc = '';
let customerId = '';
let tradingLineId = '';
let correlative = Math.floor(Math.random() * 50_000) + 120_000;

const TODAY = businessToday();
const [ty, tm] = TODAY.split('-').map(Number) as [number, number];
const prevMonth =
  tm === 1 ? `${String(ty - 1)}-12` : `${String(ty)}-${String(tm - 1).padStart(2, '0')}`;
const PREV = (day: number) => `${prevMonth}-${String(day).padStart(2, '0')}`;
const CUTOFF = PREV(28);

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
  importer = new OpeningBalancesImporter(
    moduleRef.get(ReceivablesService),
    moduleRef.get(PurchasesService),
    moduleRef.get(AuditService),
    moduleRef.get(OperationDateService).historicalLoadStart,
  );
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
  supplierDoc = `20${digits(9)}`;
  supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: supplierDoc,
        name: 'Proveedor cc56 saldos',
        creditDays: 30,
      }),
    )
  ).id;
  customerId = (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc56 saldos',
        creditDays: 30,
      }),
    )
  ).id;
  // Un lote vivo que dejó otra corrida contra esta base bloquearía los de acá.
  const tx = prisma as unknown as Parameters<OpeningBalancesImporter['liveBatches']>[0];
  for (const b of await importer.liveBatches(tx)) {
    await prisma.$transaction((t) => importer.undo(t, admin, b.batchId, 'limpieza db-spec cc56'));
  }
});

afterAll(async () => {
  await moduleRef?.close();
});

interface Fixture {
  invoiceA: { id: string; number: string };
  invoiceB: { id: string; number: string };
  purchase: { id: string; key: string };
}

async function product(): Promise<string> {
  return (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC56SI-${letters(8)}`,
        name: 'Producto cc56 saldos',
        unit: 'NIU',
        source: 'PURCHASED',
      }),
    )
  ).id;
}

async function invoice(productId: string): Promise<{ id: string; number: string }> {
  const order = await moduleRef.get(SalesOrdersService).createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: PREV(10),
      items: [{ productId, qty: '5', unitPricePen: '50' }],
    }),
  );
  const invoicing = moduleRef.get(InvoicingService);
  const draft = await invoicing.create(
    admin,
    createInvoiceSchema.parse({
      docType: 'FACTURA',
      customerId,
      salesOrderId: order.id,
      issueDate: PREV(10),
      paymentTerms: 'CREDITO',
      dueDate: PREV(25),
      items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
    }),
  );
  const doc = await invoicing.registerManual(admin, draft.id, {
    series: 'F956',
    correlative: (correlative += 1),
  });
  return { id: doc.id, number: doc.number ?? '' };
}

async function fixture(): Promise<Fixture> {
  const productId = await product();
  const purchases = moduleRef.get(PurchasesService);
  const number = digits(8);
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number,
      issueDate: PREV(5),
      currency: 'PEN',
      paymentTerms: 'CREDITO',
      creditDays: 30,
      businessLine: 'trading',
      type: 'FINISHED_GOOD',
      items: [{ productId, description: 'Producto cc56', qty: '10', unit: 'NIU', unitPrice: '20' }],
    }),
  );
  await purchases.receive(admin, purchase.id, { operationDate: PREV(5), confirmBackdate: true });
  const received = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
  return {
    invoiceA: await invoice(productId),
    invoiceB: await invoice(productId),
    purchase: {
      id: purchase.id,
      key: supplierKey(supplierDoc, `${received.series}-${received.number}`),
    },
  };
}

let n = 1;
const row = (key: string, over: Partial<OpeningRow> = {}): OpeningRow => ({
  rowNumber: ++n,
  key,
  date: '',
  amount: '',
  method: '',
  reference: '',
  balance: '',
  ...over,
});

async function liveCustomerPaid(id: string): Promise<string[]> {
  return (
    await prisma.customerPayment.findMany({
      where: { documentId: id, reversedAt: null },
      orderBy: { date: 'asc' },
    })
  ).map(
    (p) =>
      `${p.date.toISOString().slice(0, 10)} ${p.amountPen.toFixed(2)} ${p.method} ${p.reference ?? ''}`,
  );
}

async function livePurchasePaid(id: string): Promise<string[]> {
  return (
    await prisma.supplierPayment.findMany({ where: { purchaseId: id, reversedAt: null } })
  ).map((p) => `${p.date.toISOString().slice(0, 10)} ${p.amount.toFixed(2)} ${p.method}`);
}

describe('saldos iniciales (D-668)', () => {
  it('registra cobros y pagos por la puerta de siempre, con lote auditado, y lo deshace entero', async () => {
    const f = await fixture();
    const input = {
      cutoff: CUTOFF,
      missing: 'PENDING' as const,
      customers: [
        row(f.invoiceA.number, {
          date: PREV(15),
          amount: '100',
          method: 'Transferencia',
          reference: 'OP 1',
        }),
        row(f.invoiceA.number, { date: PREV(20), amount: '50', method: 'Efectivo' }),
        row(f.invoiceB.number, { balance: '0' }),
      ],
      suppliers: [row(f.purchase.key, { balance: '50', method: 'Transferencia' })],
    };

    const result = await prisma.$transaction((tx) => importer.run(tx, admin, input), {
      timeout: 120_000,
    });
    const tag = `SI ${result.batchId.slice(0, 8)}`;
    expect(await liveCustomerPaid(f.invoiceA.id)).toEqual([
      `${PREV(15)} 100.00 TRANSFER ${tag} · OP 1`,
      `${PREV(20)} 50.00 CASH ${tag}`,
    ]);
    expect(await liveCustomerPaid(f.invoiceB.id)).toEqual([`${CUTOFF} 295.00 OTHER ${tag}`]);
    expect(await livePurchasePaid(f.purchase.id)).toEqual([`${CUTOFF} 186.00 TRANSFER`]); // 236 − 50

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: OPENING_BATCH_ACTION, entityId: result.batchId },
    });
    const after = audit.after as { customerPaymentIds: string[]; supplierPaymentIds: string[] };
    expect(after.customerPaymentIds).toHaveLength(3);
    expect(after.supplierPaymentIds).toHaveLength(1);
    // Cada cobro también quedó con su propia auditoría de siempre.
    expect(
      await prisma.auditLog.count({
        where: { action: 'invoicing.payment', entityId: { in: after.customerPaymentIds } },
      }),
    ).toBe(3);

    // Un segundo lote del mismo lado no corre mientras el primero siga vivo.
    await expect(
      prisma.$transaction((tx) => importer.run(tx, admin, input), { timeout: 120_000 }),
    ).rejects.toThrow(/Ya hay un lote de saldos iniciales vivo/);

    const undone = await prisma.$transaction(
      (tx) => importer.undo(tx, admin, result.batchId, 'prueba de deshacer cc56'),
      { timeout: 120_000 },
    );
    expect(undone).toEqual({ reversed: 4, alreadyReversed: 0 });
    expect(await liveCustomerPaid(f.invoiceA.id)).toEqual([]);
    expect(await liveCustomerPaid(f.invoiceB.id)).toEqual([]);
    expect(await livePurchasePaid(f.purchase.id)).toEqual([]);
    await expect(
      prisma.$transaction((tx) => importer.undo(tx, admin, result.batchId, 'otra vez')),
    ).rejects.toThrow(/No hay un lote vivo/);

    // Deshecho, el mismo lote vuelve a entrar (y se deja limpio).
    const again = await prisma.$transaction((tx) => importer.run(tx, admin, input), {
      timeout: 120_000,
    });
    expect(again.customers?.paymentIds).toHaveLength(3);
    await prisma.$transaction((tx) => importer.undo(tx, admin, again.batchId, 'limpieza'), {
      timeout: 120_000,
    });
  });

  it('con un error no registra nada', async () => {
    const f = await fixture();
    const before = await prisma.customerPayment.count();
    await expect(
      prisma.$transaction(
        (tx) =>
          importer.run(tx, admin, {
            cutoff: CUTOFF,
            missing: 'PENDING',
            customers: [
              row(f.invoiceA.number, { balance: '0' }),
              row(f.invoiceB.number, { amount: '999', date: PREV(15) }),
            ],
            suppliers: null,
          }),
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(OpeningBatchRejected);
    expect(await prisma.customerPayment.count()).toBe(before);
  });

  it('una NC posterior al corte bajó el saldo: el saldo al corte declarado no cabe y es error', async () => {
    const f = await fixture();
    await moduleRef.get(InvoicingService).registerCreditNote(
      admin,
      f.invoiceA.id,
      registerCreditNoteSchema.parse({
        issueDate: TODAY,
        series: 'FC56',
        correlative: (correlative += 1),
        reason: 'DESCUENTO_GLOBAL',
        amountPen: '59.00',
      }),
    );
    const result = await prisma.$transaction(
      (tx) =>
        importer.plan(tx, {
          cutoff: CUTOFF,
          missing: 'PENDING',
          customers: [row(f.invoiceA.number, { balance: '0' })],
          suppliers: null,
        }),
      { timeout: 120_000 },
    );
    expect(result.customers?.plan.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/habría que registrar 295.00 y hoy solo se puede 236.00/),
    ]);
  });
});
