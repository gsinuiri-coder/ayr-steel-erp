import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, ProductionOrderStatus, ProductionReportStatus, Role } from '@prisma/client';
import {
  businessToday,
  canonicalAccessorySku,
  commitRoofingDraftsSchema,
  createCustomerSchema,
  createFinishSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSupplierSchema,
  mountRoofingCoilSchema,
  reportRoofingPiecesSchema,
  roofingReportDraftInputSchema,
  type RoofingReportDraftInput,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { RoofingDraftsService } from './roofing-drafts.service';
import { RoofingProductionService } from './roofing-production.service';

/**
 * cc41 (D-591) — **el borrador del accesorio en el servidor, contra una base real.**
 *
 * Una orden de accesorio (D-343) de 10 m con tres bobinas montadas. Lo que se prueba es lo que un
 * mock no puede probar: que el commit es todo o nada en una transacción de verdad (una fila 2 que
 * no pasa no deja registrada la fila 1), el cierre exacto de D-573, el exceso de D-574 contra lo
 * registrado más el borrador, la idempotencia de agregar y de ejecutar, y los dos CHECK de la
 * migración `20261010140000_cc41_borrador_accesorio_metros`, que Prisma no ve.
 *
 * Geometría: acabado de densidad 8, 1 000 mm × 0,50 mm ⇒ 4 kg/m (4,04 con la merma de D-165).
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
let roofing: RoofingProductionService;
let drafts: RoofingDraftsService;
let admin: RequestUser;
let roofingLineId = '';
let supplierId = '';
let customerId = '';
let finishId = '';
let colorId = '';
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
  catalog = moduleRef.get(CatalogService);
  purchases = moduleRef.get(PurchasesService);
  quotations = moduleRef.get(QuotationsService);
  salesOrders = moduleRef.get(SalesOrdersService);
  roofing = moduleRef.get(RoofingProductionService);
  drafts = moduleRef.get(RoofingDraftsService);

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
  // Un color que las otras pruebas de base no usan: su agregado no se mezcla con el de ellas.
  const color = await prisma.color.findUniqueOrThrow({ where: { code: 'GRIS' } });
  colorId = color.id;
  supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc41',
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
        name: 'Cliente cc41',
        creditDays: 0,
      }),
    )
  ).id;
  finishId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `E${letters(5)}`,
        name: 'Acabado cc41',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;
  // El SKU del accesorio es canónico (espesor y color): en una base sin resetear ya existe.
  const sku = canonicalAccessorySku('0.50', color.code);
  const existing = await prisma.product.findFirst({ where: { sku }, select: { id: true } });
  productId =
    existing?.id ??
    (
      await catalog.create(
        admin,
        createProductSchema.parse({
          businessLineId: roofingLineId,
          sku,
          name: 'Accesorio cc41',
          unit: 'MTR',
          source: 'MANUFACTURED',
          listPricePen: '30',
          finishId,
          colorId,
          thicknessMm: '0.50',
          widthMm: '1000',
          roofingKind: 'ACCESORIO',
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

async function coil(): Promise<string> {
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
          description: 'Bobina cc41',
          qty: '500',
          unit: 'KGM',
          unitPrice: '5',
          finishId,
          widthMm: '1000',
          thicknessMm: '0.50',
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return (await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } })).id;
}

/** Una OP de accesorio de `meters` m, con tres bobinas montadas en ese orden. */
async function accessoryOrder(meters = '10.000'): Promise<{ orderId: string; coils: string[] }> {
  const coils = [await coil(), await coil(), await coil()];
  const quotation = await quotations.create(
    admin,
    createQuotationSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: [{ productId, qty: meters, unitPricePen: '60' }],
    }),
  );
  const order = await salesOrders.confirm(admin, quotation.id, {});
  const raw = order.reservations.find((r) => r.itemType === 'RAW_MATERIAL');
  if (!raw?.productionOrderId) throw new Error('La confirmación no dejó la OP del accesorio');
  for (const coilId of coils) {
    await roofing.mountCoil(admin, raw.productionOrderId, mountRoofingCoilSchema.parse({ coilId }));
  }
  return { orderId: raw.productionOrderId, coils };
}

function row(coilId: string, meters: string, extra: Partial<RoofingReportDraftInput> = {}) {
  return roofingReportDraftInputSchema.parse({ coilId, meters, ...extra });
}

async function liveReports(orderId: string) {
  return prisma.productionReport.findMany({
    where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
    select: { metersM: true, pieces: true, consumedKg: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Lo que salió de una bobina: su saldo de kardex. */
async function coilBalance(coilId: string): Promise<string> {
  const balance = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'COIL', itemId: coilId } },
  });
  return balance.qty.toFixed(3);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const response = (err as { getResponse?: () => unknown }).getResponse?.();
    const message =
      typeof response === 'object' && response !== null && 'message' in response
        ? response.message
        : (err as Error).message;
    return Array.isArray(message) ? message.join(' ') : String(message);
  }
  throw new Error('Se esperaba un rechazo');
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

describe('cc41 (D-591) — borrador del accesorio en el servidor', () => {
  it('guarda metros, piezas y kg por bobina; rechaza largos y se lee igual en la orden', async () => {
    const { orderId, coils } = await accessoryOrder();
    const [c1, c2, c3] = coils as [string, string, string];

    await drafts.add(admin, orderId, row(c1, '3.500', { piecesCount: 7, consumedKg: '14.200' }));
    await drafts.add(admin, orderId, row(c2, '4.000'));
    const list = await drafts.add(admin, orderId, row(c3, '2.500'));

    expect(list.map((d) => [d.coilId, d.meters, d.piecesCount, d.pieces.length])).toEqual([
      [c1, '3.500', 7, 0],
      [c2, '4.000', null, 0],
      [c3, '2.500', null, 0],
    ]);
    // 3,5 m × 4,04 kg/m.
    expect(list[0]?.theoreticalKg).toBe('14.140');
    expect(list[0]?.consumedKg).toBe('14.200');

    // Un accesorio no lleva largos (D-343): el mismo texto que su parte.
    expect(
      await rejection(
        drafts.add(
          admin,
          orderId,
          roofingReportDraftInputSchema.parse({
            coilId: c1,
            pieces: [{ lengthMm: '1000.00', qty: 1 }],
          }),
        ),
      ),
    ).toMatch(/es un accesorio: reporta los metros lineales de bobina/);

    // Lo que ve otra pestaña (o otro equipo): el lote de /planta trae el mismo borrador.
    const batch = (await roofing.batchOrders()).find((o) => o.orderId === orderId);
    expect(batch?.drafts.map((d) => d.meters)).toEqual(['3.500', '4.000', '2.500']);
    expect(batch?.draftMeters).toBe('10.000');

    // Corregir una fila (PUT) reescribe sus metros y sus piezas.
    const fixed = await drafts.update(
      orderId,
      list[1]?.id ?? '',
      row(c2, '3.000', { piecesCount: 2 }),
    );
    expect(fixed[1]).toMatchObject({ meters: '3.000', piecesCount: 2 });
  });

  it('D-574: una fila que deja lo registrado más el borrador por encima del pedido se rechaza', async () => {
    const { orderId, coils } = await accessoryOrder();
    const [c1, c2] = coils as [string, string, string];
    await roofing.report(
      admin,
      orderId,
      reportRoofingPiecesSchema.parse({ coilId: c1, meters: '4.000' }),
    );
    await drafts.add(admin, orderId, row(c1, '5.000'));
    // 4 registrados + 5 en borrador + 2 = 11 > 10.
    expect(await rejection(drafts.add(admin, orderId, row(c2, '2.000')))).toBe(
      'Excede el plan en 1.000 m · ajusta el plan',
    );
    expect(
      await prisma.productionReportDraft.count({ where: { productionOrderId: orderId } }),
    ).toBe(1);
  });

  it('agregar con la misma clave de idempotencia no duplica la fila', async () => {
    const { orderId, coils } = await accessoryOrder();
    const key = randomUUID();
    await drafts.add(admin, orderId, row(coils[0] ?? '', '2.000', { idempotencyKey: key }));
    const again = await drafts.add(
      admin,
      orderId,
      row(coils[0] ?? '', '2.000', { idempotencyKey: key }),
    );
    expect(again).toHaveLength(1);
  });

  it('el commit es todo o nada: si la fila 2 no pasa, la fila 1 no queda registrada', async () => {
    const { orderId, coils } = await accessoryOrder();
    const [c1, c2, c3] = coils as [string, string, string];
    await drafts.add(admin, orderId, row(c1, '3.000'));
    await drafts.add(admin, orderId, row(c2, '4.000'));
    await drafts.add(admin, orderId, row(c3, '3.000'));
    // Un parte directo por debajo (el API lo deja: lo detecta la revalidación del commit, D-191):
    // 4 + 3 = 7 entra; + 4 = 11 ya no.
    await roofing.report(
      admin,
      orderId,
      reportRoofingPiecesSchema.parse({ coilId: c3, meters: '4.000' }),
    );
    const before = await Promise.all([c1, c2].map(coilBalance));

    expect(
      await rejection(
        drafts.commit(
          admin,
          orderId,
          commitRoofingDraftsSchema.parse({ close: true, idempotencyKey: randomUUID() }),
        ),
      ),
    ).toBe('Fila 2: Excede el plan en 1.000 m · ajusta el plan');

    expect((await liveReports(orderId)).map((r) => r.metersM?.toFixed(3))).toEqual(['4.000']);
    expect(await Promise.all([c1, c2].map(coilBalance))).toEqual(before);
    expect(
      await prisma.productionReportDraft.count({ where: { productionOrderId: orderId } }),
    ).toBe(3);
    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(ProductionOrderStatus.IN_PROGRESS);
  });

  it('todo o nada también cuando la fila 1 ya se registró adentro y la fila 2 falla en su parte', async () => {
    // 200 m: la fila 2 (126 m ⇒ 509,04 kg teóricos contra 500 montados, +1,8 %) pasa la validación
    // del borrador, que admite la franja autorizable (D-388), y se rechaza adentro de `reportInTx`
    // porque no trae la casilla. La fila 1 ya movió kardex en la misma transacción.
    const { orderId, coils } = await accessoryOrder('200.000');
    const [c1, c2] = coils as [string, string, string];
    await drafts.add(admin, orderId, row(c1, '10.000'));
    const list = await drafts.add(admin, orderId, row(c2, '126.000'));
    expect(list[1]?.outOfTolerance).not.toBeNull();
    const before = await Promise.all([c1, c2].map(coilBalance));

    const failure = await drafts.commit(admin, orderId, commitRoofingDraftsSchema.parse({})).then(
      () => null,
      (err: unknown) =>
        (err as { getResponse: () => { code?: string; message?: string } }).getResponse(),
    );
    // El código lo pone `reportInTx` (la validación del borrador no lo pone): falló adentro del parte.
    expect(failure).toMatchObject({
      code: 'TOLERANCE_OVERRIDE_REQUIRED',
      message: expect.stringMatching(/^Fila 2: /) as unknown,
    });
    expect(await liveReports(orderId)).toEqual([]);
    expect(await Promise.all([c1, c2].map(coilBalance))).toEqual(before);
    expect(
      await prisma.productionReportDraft.count({ where: { productionOrderId: orderId } }),
    ).toBe(2);
  });

  it('commit con cierre: registra las tres filas en orden de montaje y cierra con los metros exactos', async () => {
    const { orderId, coils } = await accessoryOrder();
    const [c1, c2, c3] = coils as [string, string, string];
    await drafts.add(admin, orderId, row(c1, '3.500', { piecesCount: 7 }));
    await drafts.add(admin, orderId, row(c2, '4.000', { consumedKg: '16.300' }));
    await drafts.add(admin, orderId, row(c3, '2.500'));

    const body = commitRoofingDraftsSchema.parse({ close: true, idempotencyKey: randomUUID() });
    // La vista previa («Qué va a pasar») no deja nada.
    const preview = await drafts.previewCommit(admin, orderId, body);
    expect(preview).toBeDefined();
    expect(await liveReports(orderId)).toEqual([]);

    await drafts.commit(admin, orderId, body);
    const reports = await liveReports(orderId);
    expect(reports.map((r) => [r.metersM?.toFixed(3), r.pieces, r.consumedKg?.toFixed(3)])).toEqual(
      [
        ['3.500', 7, undefined],
        ['4.000', 0, '16.300'],
        ['2.500', 0, undefined],
      ],
    );
    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(ProductionOrderStatus.CLOSED);
    expect(
      await prisma.productionReportDraft.count({ where: { productionOrderId: orderId } }),
    ).toBe(0);

    // El reintento de la misma ejecución (D-182) no registra nada de nuevo.
    await drafts.commit(admin, orderId, body);
    expect(await liveReports(orderId)).toHaveLength(3);
  });

  it('D-573: con el borrador por debajo del pedido, cerrar se rechaza y no registra nada', async () => {
    const { orderId, coils } = await accessoryOrder();
    await drafts.add(admin, orderId, row(coils[0] ?? '', '9.000'));
    expect(
      await rejection(
        drafts.commit(admin, orderId, commitRoofingDraftsSchema.parse({ close: true })),
      ),
    ).toBe('Para cerrar falta registrar 1.000 m del plan');
    expect(await liveReports(orderId)).toEqual([]);

    // Sin cerrar, el mismo borrador se registra (producción parcial).
    await drafts.commit(admin, orderId, commitRoofingDraftsSchema.parse({}));
    expect((await liveReports(orderId)).map((r) => r.metersM?.toFixed(3))).toEqual(['9.000']);
  });

  describe('los CHECK de la migración', () => {
    async function insert(meters: string | null, piecesCount: number | null): Promise<void> {
      const { orderId, coils } = await fixtureForCheck();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "production_report_drafts"
            ("id", "production_order_id", "coil_id", "created_by_id", "updated_at", "meters", "pieces_count")
          VALUES (${randomUUID()}::uuid, ${orderId}::uuid, ${coils[0]}::uuid, ${admin.id}::uuid, now(),
                  ${meters}::numeric, ${piecesCount}::integer)`;
        // Nada queda: solo interesa si la base lo acepta.
        throw new Rollback();
      });
    }
    class Rollback extends Error {}
    let shared: { orderId: string; coils: string[] } | null = null;
    async function fixtureForCheck() {
      shared ??= await accessoryOrder();
      return shared;
    }
    async function outcome(meters: string | null, piecesCount: number | null) {
      try {
        await insert(meters, piecesCount);
      } catch (err) {
        if (err instanceof Rollback) return 'acepta';
        const constraint =
          err instanceof Prisma.PrismaClientKnownRequestError
            ? ((err.meta as { message?: string } | undefined)?.message ?? err.message)
            : String(err);
        const match = /production_report_drafts_\w+_check/.exec(constraint);
        return match ? match[0] : constraint;
      }
      return 'acepta';
    }

    it('meters = 0, pieces_count sin meters y pieces_count = -1 fallan', async () => {
      expect(await outcome('0', null)).toBe('production_report_drafts_meters_check');
      expect(await outcome(null, 3)).toBe('production_report_drafts_pieces_count_check');
      expect(await outcome('5.500', -1)).toBe('production_report_drafts_pieces_count_check');
    });

    it('meters > 0 con pieces_count nulo o ≥ 0 pasa, y una fila de coberturas (los dos nulos) también', async () => {
      expect(await outcome('5.500', null)).toBe('acepta');
      expect(await outcome('5.500', 0)).toBe('acepta');
      expect(await outcome('5.500', 4)).toBe('acepta');
      expect(await outcome(null, null)).toBe('acepta');
    });
  });
});
