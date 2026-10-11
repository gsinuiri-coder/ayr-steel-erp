import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ProductionOrderStatus, ReservationStatus, Role } from '@prisma/client';
import {
  businessToday,
  canonicalAccessorySku,
  closeRoofingOrderSchema,
  createCustomerSchema,
  createFinishSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSupplierSchema,
  mountRoofingCoilSchema,
  productionOrderQuerySchema,
  reportRoofingPiecesSchema,
  updateSalesOrderItemQtySchema,
  type UpdateSalesOrderItemQtyInput,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionService } from '../production/production.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { QuotationsService } from './quotations.service';
import { SalesOrderEditsService } from './sales-order-edits.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * cc45 (D-603, D-604, D-605) — **cambiar la cantidad de una línea con producción, contra una base
 * real.** Lo que un mock no prueba: que todo pasa en una transacción con los locks de verdad, que
 * la reserva queda en lo que falta fabricar, que el plan de la OP sigue a la cantidad nueva y que
 * la OP queda lista para cerrar con D-573.
 *
 * Geometría: acabado de densidad 8, 1 000 mm de ancho. A 0,75 mm son 6 kg/m (6,06 con la merma
 * de D-165); a 0,85 mm, 6,8 kg/m. Color VERDE: ninguna otra prueba de base lo usa, así que los
 * agregados (espesor + color) no se mezclan con los de ellas.
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let catalog: CatalogService;
let purchases: PurchasesService;
let quotations: QuotationsService;
let salesOrders: SalesOrdersService;
let edits: SalesOrderEditsService;
let roofing: RoofingProductionService;
let production: ProductionService;
let admin: RequestUser;
let roofingLineId = '';
let supplierId = '';
let customerId = '';
let finishId = '';
let colorId = '';
let colorCode = '';

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
  catalog = moduleRef.get(CatalogService);
  purchases = moduleRef.get(PurchasesService);
  quotations = moduleRef.get(QuotationsService);
  salesOrders = moduleRef.get(SalesOrdersService);
  edits = moduleRef.get(SalesOrderEditsService);
  roofing = moduleRef.get(RoofingProductionService);
  production = moduleRef.get(ProductionService);

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
  roofingLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'METALLIC_ROOFING' } })
  ).id;
  const color = await prisma.color.findUniqueOrThrow({ where: { code: 'VERDE' } });
  colorId = color.id;
  colorCode = color.code;
  supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc45',
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
        name: 'Cliente cc45',
        creditDays: 0,
      }),
    )
  ).id;
  finishId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `E${letters(5)}`,
        name: 'Acabado cc45',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Kind = 'A_MEDIDA' | 'PLANCHA' | 'ACCESORIO';

async function product(kind: Kind, thicknessMm: string): Promise<string> {
  if (kind === 'ACCESORIO') {
    // El SKU del accesorio es canónico (espesor y color): en una base sin resetear ya existe.
    const sku = canonicalAccessorySku(thicknessMm, colorCode);
    const existing = await prisma.product.findFirst({ where: { sku }, select: { id: true } });
    if (existing) return existing.id;
  }
  const created = await catalog.create(
    admin,
    createProductSchema.parse({
      businessLineId: roofingLineId,
      sku:
        kind === 'ACCESORIO'
          ? canonicalAccessorySku(thicknessMm, colorCode)
          : `E-CC45${letters(6)}`,
      name: `Cobertura cc45 ${kind}`,
      unit: kind === 'PLANCHA' ? 'NIU' : 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '30',
      finishId,
      colorId,
      thicknessMm,
      widthMm: '1000',
      roofingKind: kind,
      ...(kind === 'PLANCHA' ? { lengthMm: '2000' } : {}),
    }),
  );
  return created.id;
}

async function coil(thicknessMm: string, kg = '500'): Promise<string> {
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
          description: 'Bobina cc45',
          qty: kg,
          unit: 'KGM',
          unitPrice: '5',
          finishId,
          widthMm: '1000',
          thicknessMm,
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return (await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } })).id;
}

const m = (meters: number, qty: number) => ({ lengthMm: (meters * 1000).toFixed(2), qty });

interface Scenario {
  salesOrderId: string;
  itemId: string;
  opId: string;
  coilId: string;
}

/** Un pedido de una línea confirmado, con su OP y una bobina montada. */
async function scenario(
  productId: string,
  thicknessMm: string,
  line: { qty: string; pieces?: { lengthMm: string; qty: number }[] },
  coilKg = '500',
  unitPricePen = '60',
): Promise<Scenario> {
  const coilId = await coil(thicknessMm, coilKg);
  const quotation = await quotations.create(
    admin,
    createQuotationSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: [{ productId, unitPricePen, ...line }],
    }),
  );
  const order = await salesOrders.confirm(admin, quotation.id, {});
  const raw = order.reservations.find((r) => r.itemType === 'RAW_MATERIAL');
  if (!raw?.productionOrderId) throw new Error('La confirmación no dejó la OP de la línea');
  await roofing.mountCoil(admin, raw.productionOrderId, mountRoofingCoilSchema.parse({ coilId }));
  return {
    salesOrderId: order.id,
    itemId: order.items[0]?.id ?? '',
    opId: raw.productionOrderId,
    coilId,
  };
}

function qty(input: Partial<UpdateSalesOrderItemQtyInput> & { qty: string }) {
  return updateSalesOrderItemQtySchema.parse({ reason: 'El cliente cambió el pedido', ...input });
}

const metersOf = (pieces: { lengthMm: string; qty: number }[]) =>
  pieces
    .reduce((acc, p) => acc + Number(p.lengthMm) * p.qty, 0)
    .toFixed(0)
    .replace(/(\d{3})$/, '.$1');

async function rawReservation(itemId: string) {
  return prisma.reservation.findFirstOrThrow({
    where: { salesOrderItemId: itemId, itemType: 'RAW_MATERIAL' },
    select: { status: true, qty: true, shortfallQty: true },
  });
}

async function plan(opId: string): Promise<string[]> {
  const items = await prisma.productionOrderItem.findMany({
    where: { productionOrderId: opId },
    orderBy: { lineNumber: 'asc' },
  });
  return items.map((i) => `${i.qty} × ${i.lengthMm.toFixed(2)}`);
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { getStatus?: () => number; getResponse?: () => unknown; message: string };
    const response = e.getResponse?.();
    const message =
      typeof response === 'object' && response !== null && 'message' in response
        ? response.message
        : e.message;
    return {
      status: e.getStatus?.() ?? 500,
      message: Array.isArray(message) ? message.join(' ') : String(message),
    };
  }
  throw new Error('Se esperaba un rechazo');
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

describe('cc45 (D-603, D-604) — cambiar la cantidad con producción', () => {
  it('a medida: bajar a lo registrado deja la OP lista para cerrar y libera la reserva', async () => {
    const productId = await product('A_MEDIDA', '0.75');
    const pieces = [m(6, 2), m(4, 2)];
    const s = await scenario(productId, '0.75', { qty: '20.000', pieces });
    expect((await rawReservation(s.itemId)).qty.toFixed(3)).toBe('121.200');
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, pieces: [m(6, 2)] }),
    );

    // Por debajo de lo registrado en un largo: 400, sin tocar nada.
    const below = await rejection(
      edits.updateItemQty(
        admin,
        s.salesOrderId,
        s.itemId,
        qty({ qty: '14.000', pieces: [m(6, 1), m(4, 2)] }),
      ),
    );
    expect(below.status).toBe(400);
    expect(below.message).toBe(
      'Línea 1: El largo 6.00 m no puede bajar de 2 planchas: ya están registradas',
    );

    // La vista previa dice lo mismo que va a pasar, y no escribe.
    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {
      qty: '12.000',
      pieces: [m(6, 2)],
    });
    expect(preview.kind).toBe('PIECES');
    expect(preview.rows).toEqual([
      { lengthMm: '6000.00', ordered: 2, registered: 2 },
      { lengthMm: '4000.00', ordered: 2, registered: 0 },
    ]);
    expect(preview.minQty).toBe('12.000');
    expect(preview.outcome?.ok).toBe(true);
    expect(preview.outcome?.effects.join(' ')).toContain('lista para «Registrar y cerrar»');
    expect(await plan(s.opId)).toEqual(['2 × 6000.00', '2 × 4000.00']);

    // Sin motivo no se guarda.
    const noReason = await rejection(
      edits.updateItemQty(admin, s.salesOrderId, s.itemId, {
        qty: '12.000',
        pieces: [m(6, 2)],
      }),
    );
    expect(noReason.message).toContain('el motivo es obligatorio');

    const order = await edits.updateItemQty(
      admin,
      s.salesOrderId,
      s.itemId,
      qty({ qty: '12.000', pieces: [m(6, 2)] }),
    );
    expect(order.items[0]).toMatchObject({ qty: '12.000' });
    expect(await plan(s.opId)).toEqual(['2 × 6000.00']);
    // Lo que faltaba fabricar era cero: la reserva de materia prima se libera entera.
    const raw = await rawReservation(s.itemId);
    expect(raw.status).toBe(ReservationStatus.RELEASED);
    expect(raw.qty.toFixed(3)).toBe('0.000');

    // D-573: la orden cierra con lo registrado igual a su plan.
    await roofing.close(admin, s.opId, closeRoofingOrderSchema.parse({}));
    const closed = await prisma.productionOrder.findUniqueOrThrow({ where: { id: s.opId } });
    expect(closed.status).toBe(ProductionOrderStatus.CLOSED);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'sales.order.item-qty', entityId: s.salesOrderId },
      orderBy: { at: 'desc' },
    });
    expect(audit.reason).toBe('El cliente cambió el pedido');
    expect(audit.before).toMatchObject({ qty: '20', pieces: '2 × 6.00 m, 2 × 4.00 m' });
  });

  it('a medida: subir con material reserva lo nuevo y el plan crece con el largo nuevo', async () => {
    const productId = await product('A_MEDIDA', '0.75');
    const s = await scenario(productId, '0.75', { qty: '12.000', pieces: [m(6, 2)] });
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, pieces: [m(6, 1)] }),
    );
    // Una bobina libre del mismo agregado: la montada no cuenta como disponible (D-134).
    await coil('0.75');
    const next = [m(6, 2), m(3, 2)];
    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {
      qty: metersOf(next),
      pieces: next,
    });
    expect(preview.outcome?.ok).toBe(true);
    expect(preview.outcome?.shortfallQty).toBeNull();
    expect(preview.outcome?.effects.join(' ')).toMatch(/Se reserva .* kg más de .*hay disponible/);

    await edits.updateItemQty(
      admin,
      s.salesOrderId,
      s.itemId,
      qty({ qty: '18.000', pieces: next }),
    );
    expect(await plan(s.opId)).toEqual(['2 × 6000.00', '2 × 3000.00']);
    // La reserva queda en lo que falta fabricar: 18 − 6 = 12 m × 6,06 kg/m.
    const raw = await rawReservation(s.itemId);
    expect(raw.status).toBe(ReservationStatus.ACTIVE);
    expect(raw.qty.toFixed(3)).toBe('72.720');
  });

  it('subir sin material: el administrador confirma con faltante; el vendedor no puede', async () => {
    const productId = await product('A_MEDIDA', '0.85');
    // 100 kg alcanzan para 14 m (6,868 kg/m con la merma).
    const s = await scenario(productId, '0.85', { qty: '10.000', pieces: [m(5, 2)] }, '100');
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, pieces: [m(5, 1)] }),
    );
    const next = [m(5, 4)];

    const seller = { ...admin, role: Role.VENDEDOR };
    const forbidden = await rejection(
      edits.updateItemQty(seller, s.salesOrderId, s.itemId, qty({ qty: '20.000', pieces: next })),
    );
    expect(forbidden.status).toBe(403);

    const short = await rejection(
      edits.updateItemQty(admin, s.salesOrderId, s.itemId, qty({ qty: '20.000', pieces: next })),
    );
    expect(short.status).toBe(400);
    expect(short.message).toContain('disponibles');

    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {
      qty: '20.000',
      pieces: next,
    });
    expect(preview.outcome?.shortfallQty).not.toBeNull();

    await edits.updateItemQty(
      admin,
      s.salesOrderId,
      s.itemId,
      qty({ qty: '20.000', pieces: next, confirmShortfall: true }),
    );
    const raw = await rawReservation(s.itemId);
    expect(raw.status).toBe(ReservationStatus.ACTIVE);
    expect(raw.shortfallQty.greaterThan(0)).toBe(true);
    // Reservado más faltante = lo que falta fabricar: 15 m × 6,868 kg/m.
    expect(raw.qty.plus(raw.shortfallQty).toFixed(3)).toBe('103.020');
    expect(await plan(s.opId)).toEqual(['4 × 5000.00']);
  });

  it('subir con la OP cerrada crea una OP nueva por la diferencia', async () => {
    const productId = await product('A_MEDIDA', '0.75');
    const s = await scenario(productId, '0.75', { qty: '10.000', pieces: [m(5, 2)] });
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, pieces: [m(5, 2)] }),
    );
    await roofing.close(admin, s.opId, closeRoofingOrderSchema.parse({}));

    const next = [m(5, 2), m(2, 3)];
    // La vista previa dice que nace una orden, sin crearla (el correlativo no vuelve con el
    // rollback).
    const opsBefore = await prisma.productionOrder.count();
    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {
      qty: '16.000',
      pieces: next,
    });
    expect(preview.outcome?.effects.join(' ')).toContain(
      'Nace una orden nueva por la diferencia: 3 planchas, 6.000 m.',
    );
    expect(await prisma.productionOrder.count()).toBe(opsBefore);
    await edits.updateItemQty(
      admin,
      s.salesOrderId,
      s.itemId,
      qty({ qty: '16.000', pieces: next }),
    );
    const orders = await prisma.productionOrder.findMany({
      where: { reservation: { salesOrderItemId: s.itemId } },
      orderBy: { seq: 'asc' },
      select: { id: true, status: true },
    });
    expect(orders.map((o) => o.status)).toEqual([
      ProductionOrderStatus.CLOSED,
      ProductionOrderStatus.DRAFT,
    ]);
    expect(await plan(orders[1]?.id ?? '')).toEqual(['3 × 2000.00']);
    const raw = await rawReservation(s.itemId);
    expect(raw.status).toBe(ReservationStatus.ACTIVE);
    // 6 m nuevos × 6,06 kg/m.
    expect(raw.qty.toFixed(3)).toBe('36.360');
  });

  it('accesorio (D-605): el avance se mide contra los metros de la línea; subir con la OP cerrada', async () => {
    const productId = await product('ACCESORIO', '0.75');
    const s = await scenario(productId, '0.75', { qty: '5.000' });
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, meters: '5.000' }),
    );
    // D-605: la lista de órdenes del pedido dice «5 m de 5 m», no «de 0 m».
    const listed = await production.findAll(
      productionOrderQuerySchema.parse({ salesOrderId: s.salesOrderId }),
    );
    expect(listed.find((o) => o.id === s.opId)?.planMeters).toBe('5.000');
    await roofing.close(admin, s.opId, closeRoofingOrderSchema.parse({}));

    // Por debajo de lo registrado: 400.
    const below = await rejection(
      edits.updateItemQty(admin, s.salesOrderId, s.itemId, qty({ qty: '4.000' })),
    );
    expect(below.message).toContain('no puede bajar de 5.000 m');

    await edits.updateItemQty(admin, s.salesOrderId, s.itemId, qty({ qty: '6.500' }));
    const orders = await production.findAll(
      productionOrderQuerySchema.parse({ salesOrderId: s.salesOrderId }),
    );
    const fresh = orders.find((o) => o.id !== s.opId);
    expect(fresh?.status).toBe(ProductionOrderStatus.DRAFT);
    // La orden nueva fabrica solo la diferencia; la cerrada sigue midiéndose contra sus 5 m.
    expect(fresh?.planMeters).toBe('1.500');
    expect(orders.find((o) => o.id === s.opId)?.planMeters).toBe('5.000');

    // Y su tope (D-574) es la diferencia: 2 m se pasan, 1,5 m cierran exacto.
    await roofing.mountCoil(
      admin,
      fresh?.id ?? '',
      mountRoofingCoilSchema.parse({ coilId: s.coilId }),
    );
    const excess = await rejection(
      roofing.report(
        admin,
        fresh?.id ?? '',
        reportRoofingPiecesSchema.parse({ coilId: s.coilId, meters: '2.000' }),
      ),
    );
    expect(excess.message).toBe('Excede el plan en 0.500 m · ajusta el plan');
    await roofing.report(
      admin,
      fresh?.id ?? '',
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, meters: '1.500' }),
    );
    await roofing.close(admin, fresh?.id ?? '', closeRoofingOrderSchema.parse({}));
  });

  it('plancha de catálogo: el piso son las planchas registradas', async () => {
    const productId = await product('PLANCHA', '0.75');
    // Una plancha de 2 m cuesta unos S/ 60: el precio va por encima del piso (D-163).
    const s = await scenario(productId, '0.75', { qty: '10' }, '500', '150');
    await roofing.report(
      admin,
      s.opId,
      reportRoofingPiecesSchema.parse({ coilId: s.coilId, pieces: [m(2, 4)] }),
    );
    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {});
    expect(preview).toMatchObject({ kind: 'UNITS', registeredQty: '4.000', minQty: '4.000' });

    const below = await rejection(
      edits.updateItemQty(admin, s.salesOrderId, s.itemId, qty({ qty: '3' })),
    );
    expect(below.message).toContain('no puede bajar de 4.000 und');

    await edits.updateItemQty(admin, s.salesOrderId, s.itemId, qty({ qty: '4' }));
    expect(await plan(s.opId)).toEqual(['4 × 2000.00']);
    expect((await rawReservation(s.itemId)).status).toBe(ReservationStatus.RELEASED);
  });

  it('con comprobante no se cambia: 400 y el diálogo no se abre', async () => {
    const productId = await product('A_MEDIDA', '0.75');
    const s = await scenario(productId, '0.75', { qty: '6.000', pieces: [m(6, 1)] });
    await moduleRef.get(InvoicingService).create(
      admin,
      createInvoiceSchema.parse({
        docType: 'FACTURA',
        customerId,
        salesOrderId: s.salesOrderId,
        issueDate: businessToday(),
        items: [{ salesOrderItemId: s.itemId, qty: '6.000' }],
      }),
    );
    const preview = await edits.previewItemQty(admin, s.salesOrderId, s.itemId, {});
    expect(preview.blocked).toContain('comprobante');
    const rejected = await rejection(
      edits.updateItemQty(
        admin,
        s.salesOrderId,
        s.itemId,
        qty({ qty: '12.000', pieces: [m(6, 2)] }),
      ),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.message).toContain('comprobante');
  });
});
