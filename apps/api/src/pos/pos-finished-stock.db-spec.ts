import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  canonicalAccessorySku,
  createCustomerSchema,
  createFinishSchema,
  createPosSaleSchema,
  createProductSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesMarginService } from '../reports/sales-margin.service';
import { SalesOrderEditsService } from '../sales/sales-order-edits.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { CashSessionsService } from './cash-sessions.service';
import { PosService } from './pos.service';

/**
 * cc65 (D-697) — **el mostrador vende la cobertura terminada que quedó en stock**, contra una base
 * real. Un sobrante de OP (accesorio, a medida o plancha) se vende de su saldo, sin fabricar: la
 * línea reserva el propio producto, la salida va por `InventoryService.record` al costo del kardex
 * y la anulación de la venta lo devuelve al mismo costo. Lo reservado a un pedido no se ofrece.
 *
 * El saldo de cada producto se arma con una entrada de producción por la puerta `record()`, que
 * es como entra un sobrante de OP (regla 8). Corre en `pnpm --filter @ayr/api test:db`.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let pos: PosService;
let inventory: InventoryService;
let admin: RequestUser;
let seller: RequestUser;
let roofingLineId = '';
let finishId = '';
let colorId = '';
let customerId = '';

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
  inventory = moduleRef.get(InventoryService);

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
  seller = { ...admin, role: Role.VENDEDOR };
  roofingLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'METALLIC_ROOFING' } })
  ).id;
  colorId = (await prisma.color.findUniqueOrThrow({ where: { code: 'GRIS' } })).id;
  finishId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `E${letters(5)}`,
        name: 'Acabado cc65',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;
  customerId = (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc65',
        creditDays: 0,
      }),
    )
  ).id;
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Kind = 'ACCESORIO' | 'A_MEDIDA' | 'PLANCHA';

/** Una cobertura con un saldo terminado de `qty` a `unitCost` (sin IGV), como lo deja una OP. */
async function leftover(
  kind: Kind,
  qty: string,
  unitCost: string,
  thicknessMm = '0.40',
): Promise<string> {
  // El SKU de un accesorio es canónico (espesor y color): cada prueba usa un espesor propio.
  const sku =
    kind === 'ACCESORIO'
      ? canonicalAccessorySku(thicknessMm, 'GRIS')
      : `CC65-${kind.replace('_', '')}-${letters(6)}`;
  const existing = await prisma.product.findFirst({ where: { sku }, select: { id: true } });
  const productId =
    existing?.id ??
    (
      await moduleRef.get(CatalogService).create(
        admin,
        createProductSchema.parse({
          businessLineId: roofingLineId,
          sku,
          name: `Cobertura cc65 ${kind}`,
          unit: kind === 'PLANCHA' ? 'NIU' : 'MTR',
          source: 'MANUFACTURED',
          listPricePen: '30',
          finishId,
          colorId,
          thicknessMm,
          widthMm: '1000',
          roofingKind: kind,
          ...(kind === 'PLANCHA' ? { lengthMm: '3000' } : {}),
        }),
      )
    ).id;
  await prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId: roofingLineId,
      itemType: 'PRODUCT',
      itemId: productId,
      type: 'IN',
      qty,
      unit: kind === 'PLANCHA' ? 'NIU' : 'MTR',
      unitCost,
      refType: 'PRODUCTION',
      actorId: admin.id,
      operationDate: businessToday(),
    }),
  );
  return productId;
}

function sell(actor: RequestUser, productId: string, qty: string, priceWithIgv = '20.00') {
  return pos.sell(
    actor,
    createPosSaleSchema.parse({
      method: 'CASH',
      customerId,
      idempotencyKey: randomUUID(),
      items: [{ productId, qty, unitPriceWithIgvPen: priceWithIgv }],
    }),
  );
}

async function balanceOf(productId: string) {
  const b = await prisma.inventoryBalance.findFirstOrThrow({
    where: { itemType: 'PRODUCT', itemId: productId },
  });
  return { qty: b.qty.toFixed(3), value: b.qty.times(b.avgCost).toFixed(2) };
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

// ---------------------------------------------------------------------------

describe('cc65 (D-697): venta por mostrador de la cobertura terminada en stock', () => {
  it('el sobrante completo de un accesorio sale entero, al costo de su OP, sin abrir otra OP', async () => {
    const productId = await leftover('ACCESORIO', '1.000', '7.94', '0.33');
    const listed = await pos.findProducts({ search: (await skuOf(productId)) ?? '' });
    expect(listed.map((p) => [p.productId, p.availableQty])).toEqual([[productId, '1.000']]);

    const opsBefore = await prisma.productionOrder.count();
    const sale = await sell(seller, productId, '1.000');
    expect(sale.status).toBe('ACTIVE');
    expect(await prisma.productionOrder.count()).toBe(opsBefore);

    // La línea la sirve su propio producto, no la bobina.
    const item = await prisma.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: sale.salesOrderId },
    });
    expect([item.reserveItemType, item.reserveItemId]).toEqual(['PRODUCT', productId]);
    const out = await prisma.inventoryMovement.findFirstOrThrow({
      where: { itemId: productId, type: 'OUT' },
    });
    expect(out.totalCost.toFixed(2)).toBe('7.94');
    expect(await balanceOf(productId)).toEqual({ qty: '0.000', value: '0.00' });

    // Ventas y margen: lo vendido sin IGV contra el costo de la salida.
    const margin = await moduleRef
      .get(SalesMarginService)
      .salesMargin({ from: businessToday(), to: businessToday() });
    const row = margin.orders.find((o) => o.salesOrderId === sale.salesOrderId);
    expect(row?.salesPen).toBe('16.9500');
    expect(row?.costPen).toBe('7.9400');
  });

  it('un sobrante a medida se vende en parte, en metros y sin largos; anular devuelve el stock al mismo costo', async () => {
    const productId = await leftover('A_MEDIDA', '5.000', '10.00');
    const sale = await sell(admin, productId, '2.000');
    expect(await balanceOf(productId)).toEqual({ qty: '3.000', value: '30.00' });

    // Fixture: el PSE está apagado en la base de pruebas, así que la baja de la boleta no se
    // puede comunicar. Se simula la baja ya aceptada (solo estado); la anulación sigue con el
    // cobro, el despacho y el pedido, que es lo que esta prueba mira.
    await prisma.fiscalDocument.updateMany({
      where: { salesOrderId: sale.salesOrderId },
      data: { status: 'VOIDED' },
    });
    const back = await pos.voidSale(admin, sale.id, 'Prueba cc65: anulación');
    expect(back.status).toBe('VOIDED');
    expect(await balanceOf(productId)).toEqual({ qty: '5.000', value: '50.00' });
    const reversal = await prisma.inventoryMovement.findFirstOrThrow({
      where: { itemId: productId, type: 'IN', refType: { not: 'PRODUCTION' } },
    });
    expect(reversal.totalCost.toFixed(2)).toBe('20.00');
  });

  it('la plancha que sobró se vende por unidad', async () => {
    const productId = await leftover('PLANCHA', '3.000', '30.00');
    await sell(admin, productId, '3.000', '45.00');
    expect(await balanceOf(productId)).toEqual({ qty: '0.000', value: '0.00' });
  });

  it('más que el saldo se rechaza, sin venta ni salida', async () => {
    const productId = await leftover('ACCESORIO', '1.000', '7.94', '0.37');
    const before = await prisma.posSale.count();
    const r = await rejection(sell(admin, productId, '1.500'));
    expect(r.status).toBe(400);
    expect(await prisma.posSale.count()).toBe(before);
    expect(await balanceOf(productId)).toEqual({ qty: '1.000', value: '7.94' });
  });

  it('lo reservado a un pedido no se ofrece ni se vende', async () => {
    const productId = await leftover('A_MEDIDA', '2.000', '10.00');
    // Un pedido que ya tiene prometido todo el saldo de ese producto.
    await prisma.$transaction((tx) =>
      moduleRef.get(SalesOrdersService).createDirectInTx(
        tx,
        admin,
        {
          customerId,
          issueDate: businessToday(),
          items: [{ productId, qty: '2.000', unitPriceWithIgvPen: '20.00' }],
        },
        { counterSale: true },
      ),
    );
    const listed = await pos.findProducts({ search: (await skuOf(productId)) ?? '' });
    expect(listed).toEqual([]);
    const r = await rejection(sell(admin, productId, '1.000'));
    expect(r.status).toBe(400);
  });

  it('un pedido del mostrador no se edita: se anula la venta', async () => {
    const productId = await leftover('ACCESORIO', '2.000', '7.94', '0.43');
    const sale = await sell(admin, productId, '1.000');
    const item = await prisma.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: sale.salesOrderId },
    });
    const r = await rejection(
      moduleRef
        .get(SalesOrderEditsService)
        .updateItemQty(admin, sale.salesOrderId, item.id, { qty: '2.000' }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/mostrador|comprobante/);
  });
});

async function skuOf(productId: string): Promise<string | null> {
  return (
    (await prisma.product.findUnique({ where: { id: productId }, select: { sku: true } }))?.sku ??
    null
  );
}
