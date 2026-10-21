import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCustomerSchema,
  createProductSchema,
  createSupplierSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { FiscalImportService } from '../invoicing/fiscal-import.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { ReceivablesService } from '../invoicing/receivables.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import type { Sheets } from './backdated-load';
import { planLoadOps } from './backdated-load-ops';
import { BackdatedLoadRunner, readManifest } from './backdated-load-runner';
import { PurchaseImportService } from './purchase-import.service';
import { QuotationImportService } from './quotation-import.service';

/**
 * cc64 (D-705, D-706) — **el cargador de la carga atrasada, contra la base**: un lote chico de
 * reventa (compra, venta, pedido, despacho, comprobante, cobro y pago) que se corta a la mitad y se
 * reanuda, se vuelve a correr sin duplicar nada, sobrevive a un corte entre la operación y su
 * anotación, y se revierte entero. La producción de coberturas la prueba el ensayo en demo.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let admin: RequestUser;

const TODAY = businessToday();
const [ty, tm] = TODAY.split('-').map(Number) as [number, number];
const prevMonth =
  tm === 1 ? `${String(ty - 1)}-12` : `${String(ty)}-${String(tm - 1).padStart(2, '0')}`;
const PREV = (day: number) => `${prevMonth}-${String(day).padStart(2, '0')}`;
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');
const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

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
});

afterAll(async () => {
  await moduleRef?.close();
});

function runner(batchId: string): BackdatedLoadRunner {
  return new BackdatedLoadRunner(
    {
      prisma,
      audit: moduleRef.get(AuditService),
      purchaseImport: moduleRef.get(PurchaseImportService),
      purchases: moduleRef.get(PurchasesService),
      quotationImport: moduleRef.get(QuotationImportService),
      quotations: moduleRef.get(QuotationsService),
      salesOrders: moduleRef.get(SalesOrdersService),
      roofing: moduleRef.get(RoofingProductionService),
      dispatches: moduleRef.get(DispatchesService),
      invoicing: moduleRef.get(InvoicingService),
      fiscalImport: moduleRef.get(FiscalImportService),
      receivables: moduleRef.get(ReceivablesService),
    },
    admin,
    batchId,
  );
}

/** Un lote de reventa: 10 u compradas a S/ 20, 5 vendidas a S/ 50 + IGV, despachadas y cobradas. */
async function resaleLot(): Promise<{
  sheets: Sheets;
  sku: string;
  sale: string;
  purchase: string;
}> {
  const line = await prisma.businessLine.findUniqueOrThrow({ where: { code: 'TRADING' } });
  const sku = `T-CC64-${letters(8)}`;
  await moduleRef.get(CatalogService).create(
    admin,
    createProductSchema.parse({
      businessLineId: line.id,
      sku,
      name: 'Producto cc64',
      unit: 'NIU',
      source: 'PURCHASED',
      listPricePen: '50',
    }),
  );
  const supplierRuc = `20${digits(9)}`;
  await moduleRef.get(SuppliersService).create(
    admin,
    createSupplierSchema.parse({
      code: letters(6),
      docType: 'RUC',
      docNumber: supplierRuc,
      name: 'Proveedor cc64',
      creditDays: 0,
    }),
  );
  const customerRuc = `20${digits(9)}`;
  await moduleRef.get(CustomersService).create(
    admin,
    createCustomerSchema.parse({
      docType: 'RUC',
      docNumber: customerRuc,
      name: 'Cliente cc64',
      creditDays: 0,
    }),
  );
  const purchase = `F001-${digits(7)}`;
  const sale = `F964-${String(Number(digits(6)) + 1)}`;
  return {
    sku,
    sale,
    purchase,
    sheets: {
      purchases: [
        {
          'TIPO DE COMPRA': 'PRODUCTO TERMINADO',
          'LÍNEA DE NEGOCIO': 'REVENTA',
          'TIPO DE COMPROBANTE': 'FACTURA',
          'SERIE-NÚMERO': purchase,
          'FECHA DE EMISIÓN': PREV(5),
          'RUC PROVEEDOR': supplierRuc,
          MONEDA: 'PEN',
          'CONDICIÓN DE PAGO': 'CONTADO',
          SKU: sku,
          DESCRIPCIÓN: 'Producto cc64',
          CANTIDAD: '10',
          UNIDAD: 'NIU',
          'PRECIO UNITARIO SIN IGV': '20',
          'FECHA DE RECEPCIÓN': PREV(5),
        },
      ],
      sales: [
        {
          'F. EMISIÓN': PREV(10),
          'TIPO COMPROBANTE': 'FACTURA',
          'SERIE - NÚMERO': sale,
          CLIENTE: `${customerRuc} - Cliente cc64`,
          MONEDA: 'PEN',
          'CÓDIGO PRODUCTO': sku,
          'NOMBRE PRODUCTO': 'Producto cc64',
          'UNIDAD MEDIDA': 'UNIDAD',
          CANTIDAD: '5',
          'VALOR DE VENTA': '250.00',
          IGV: '45.00',
          'PRECIO DE VENTA': '295.00',
        },
      ],
      production: [],
      dispatches: [
        {
          'SERIE - NÚMERO': sale,
          FECHA: PREV(10),
          'CÓDIGO PRODUCTO': sku,
          CANTIDAD: '5',
          MODALIDAD: 'RECOJO',
        },
      ],
      collections: [
        {
          'SERIE - NÚMERO': sale,
          FECHA: PREV(12),
          MONTO: '295.00',
          'MEDIO DE PAGO': 'Transferencia',
        },
      ],
      supplierPayments: [
        {
          'RUC PROVEEDOR': supplierRuc,
          'SERIE-NÚMERO': purchase,
          FECHA: PREV(6),
          MONTO: '236.00',
          'MEDIO DE PAGO': 'Transferencia',
        },
      ],
    },
  };
}

async function counts(sku: string, sale: string) {
  const product = await prisma.product.findFirstOrThrow({ where: { sku } });
  const [series, corr] = sale.split('-') as [string, string];
  const number = `${series}-${corr.padStart(8, '0')}`;
  return {
    purchases: await prisma.purchase.count({
      where: { items: { some: { productId: product.id } }, status: { not: 'CANCELLED' } },
    }),
    quotations: await prisma.quotation.count({
      where: { notes: { contains: sale }, status: { not: 'CANCELLED' } },
    }),
    invoices: await prisma.fiscalDocument.count({ where: { number, status: 'ACCEPTED' } }),
    payments: await prisma.customerPayment.count({
      where: { document: { number }, reversedAt: null },
    }),
    dispatches: await prisma.dispatch.count({
      where: { items: { some: { salesOrderItem: { productId: product.id } } }, reversedAt: null },
    }),
    stock: (
      await prisma.inventoryBalance.findFirst({ where: { itemId: product.id } })
    )?.qty.toString(),
  };
}

describe('cc64 (D-705, D-706): carga:ejecutar y carga:revertir contra la base', () => {
  it('corta y reanuda, no duplica al volver a correr ni tras un corte sin anotar, y revierte entero', async () => {
    const { sheets, sku, sale } = await resaleLot();
    const batch = `cc64-test-${letters(6)}`;
    const { ops } = planLoadOps(sheets);
    expect(ops.map((o) => o.step)).toEqual([
      'purchases',
      'sales',
      'orders',
      'dispatches',
      'invoices',
      'collections',
      'supplierPayments',
    ]);

    // 1. Se corta después del pedido.
    await runner(batch).start('prueba.xlsx', 'huella', ops.length);
    const first = await runner(batch).execute(ops.slice(0, 3), await readManifest(prisma, batch));
    expect(first.failure).toBeNull();
    expect(first.executed).toHaveLength(3);

    // 2. Se reanuda: lo hecho se salta.
    const second = await runner(batch).execute(ops, await readManifest(prisma, batch));
    expect(second.failure).toBeNull();
    expect(second.skipped).toHaveLength(3);
    expect(second.executed).toHaveLength(4);
    const loaded = await counts(sku, sale);
    expect(loaded).toEqual({
      purchases: 1,
      quotations: 1,
      invoices: 1,
      payments: 1,
      dispatches: 1,
      stock: '5',
    });

    // 3. Volver a correr el lote completo no duplica nada.
    const third = await runner(batch).execute(ops, await readManifest(prisma, batch));
    expect(third.executed).toHaveLength(0);
    expect(await counts(sku, sale)).toEqual(loaded);

    // 4. Un corte entre la operación y su anotación: el manifiesto no la tiene, pero se reconoce
    //    (clave natural o idempotencia del lote) y no se crea otra vez.
    const manifest = await readManifest(prisma, batch);
    for (const op of ops) manifest.done.delete(op.key);
    const fourth = await runner(batch).execute(ops, manifest);
    expect(fourth.failure).toBeNull();
    expect(await counts(sku, sale)).toEqual(loaded);

    // 5. La reversa deja todo como antes de la carga.
    const back = await runner(batch).revert(await readManifest(prisma, batch));
    expect(back.failure).toBeNull();
    expect(await counts(sku, sale)).toEqual({
      purchases: 0,
      quotations: 0,
      invoices: 0,
      payments: 0,
      dispatches: 0,
      stock: '0',
    });
    expect((await readManifest(prisma, batch)).done.size).toBe(0);
  });

  it('se detiene en la primera fila que falla y dice cuál y por qué', async () => {
    const { sheets } = await resaleLot();
    // El despacho saca más de lo vendido: el servicio lo rechaza.
    const dispatch = sheets.dispatches[0];
    if (dispatch) dispatch.CANTIDAD = '50';
    const batch = `cc64-test-${letters(6)}`;
    const { ops } = planLoadOps(sheets);
    const result = await runner(batch).execute(ops, await readManifest(prisma, batch));
    expect(result.failure?.step).toBe('dispatches');
    expect(result.failure?.rows).toEqual([{ sheet: 'Despachos', row: 2 }]);
    expect(result.failure?.message).toBeTruthy();
    expect(result.executed).toHaveLength(3);
    await runner(batch).revert(await readManifest(prisma, batch));
  });
});
