import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createPosSaleSchema,
  createProductSchema,
  createPurchaseSchema,
  createSupplierSchema,
  type PosSaleItemInput,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { CashSessionsService } from './cash-sessions.service';
import { PosService } from './pos.service';

/**
 * cc52 (D-643) — **el mostrador con piso, contra una base real.** Un producto de reventa comprado
 * a S/ 20.00 (sin IGV): con el margen mínimo de la semilla (10 %) el piso es S/ 26.23 con IGV; a
 * costo, S/ 23.60. Es el mismo `assertPriceFloor` de la cotización, para todos los roles, y el
 * ADMINISTRADOR puede marcar la línea «A costo» (D-641).
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let pos: PosService;
let admin: RequestUser;
let seller: RequestUser;
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
  pos = moduleRef.get(PosService);

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
  // El mismo usuario con rol VENDEDOR: la caja es del usuario, así que lo único que cambia es el rol.
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
        name: 'Proveedor cc52',
        creditDays: 0,
      }),
    )
  ).id;
  productId = (
    await moduleRef.get(CatalogService).create(
      admin,
      createProductSchema.parse({
        businessLineId: tradingLineId,
        sku: `T-CC52-${letters(8)}`,
        name: 'Producto cc52',
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
        { productId, description: 'Producto cc52', qty: '100', unit: 'NIU', unitPrice: '20' },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);

  // La caja del usuario: la abre si no la tiene abierta (otra prueba pudo dejarla abierta).
  const open = await prisma.cashSession.findFirst({
    where: { userId: admin.id, status: 'OPEN' },
    select: { id: true },
  });
  if (!open) {
    await moduleRef.get(CashSessionsService).open(admin, { openingAmountPen: '0.00' });
  }
});

afterAll(async () => {
  await moduleRef?.close();
});

function sell(actor: RequestUser, item: Omit<PosSaleItemInput, 'productId' | 'qty'>) {
  return pos.sell(
    actor,
    createPosSaleSchema.parse({
      method: 'CASH',
      items: [{ productId, qty: '1.000', ...item }],
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

describe('cc52 (D-643): el mostrador con el piso de la cotización', () => {
  it('un céntimo bajo el piso rebota para el vendedor y para el administrador, sin venta', async () => {
    const before = await prisma.posSale.count();
    for (const actor of [seller, admin]) {
      const r = await rejection(sell(actor, { unitPriceWithIgvPen: '26.22' }));
      expect(r.status).toBe(400);
      expect(r.message).toContain('26.23');
    }
    expect(await prisma.posSale.count()).toBe(before);
  });

  it('en el piso el vendedor vende', async () => {
    const sale = await sell(seller, { unitPriceWithIgvPen: '26.23' });
    expect(sale.status).toBe('ACTIVE');
  });

  it('el vendedor no marca «A costo»: 403 sin pasar por el piso (no ve el costo)', async () => {
    const r = await rejection(
      sell(seller, { unitPriceWithIgvPen: '23.60', atCost: { reason: 'LIQUIDACION' } }),
    );
    expect(r.status).toBe(403);
    expect(r.message).not.toContain('23.60');
  });

  it('el administrador vende a costo con motivo: marca en el pedido y registro en su historial', async () => {
    const sale = await sell(admin, {
      unitPriceWithIgvPen: '23.60',
      atCost: { reason: 'LIQUIDACION' },
    });
    const item = await prisma.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: sale.salesOrderId },
    });
    expect(item.atCostReason).toBe('LIQUIDACION');
    const audits = await prisma.auditLog.findMany({
      where: {
        entity: 'sales_orders',
        entityId: sale.salesOrderId,
        action: 'pos.order.line-at-cost',
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({ costPen: '20.0000', atCostReason: 'LIQUIDACION' });
  });

  it('a costo tampoco se vende por debajo del costo', async () => {
    const r = await rejection(
      sell(admin, { unitPriceWithIgvPen: '23.59', atCost: { reason: 'LIQUIDACION' } }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain('costo');
  });
});
