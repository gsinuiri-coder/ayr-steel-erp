import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import {
  businessToday,
  cancelPurchaseSchema,
  commitReceivedPurchaseEditSchema,
  cancelCuttingOrderSchema,
  createCuttingOrderSchema,
  createCustomerSchema,
  createDispatchSchema,
  createFinishSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  mountRoofingCoilSchema,
  receiveCuttingOrderCoilSchema,
  reportRoofingPiecesSchema,
  reverseMovementSchema,
  setCoilStatusSchema,
  type SalesOrderDto,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CoilOperationsService } from '../coils/coil-operations.service';
import { isLockConflict } from '../common/lock-conflict.filter';
import { CustomersService } from '../customers/customers.service';
import { CuttingService } from '../cutting/cutting.service';
import { FinishesService } from '../finishes/finishes.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { ReceivedPurchaseEditService } from '../purchases/purchase-received-edit.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { InventoryService } from './inventory.service';
import * as rowLocks from './row-locks';

/**
 * D-386 — **el orden único de bloqueos, contra una base real y con concurrencia de verdad.**
 *
 * Cada par corre `ITERATIONS` veces (20 por defecto, `LOCK_ORDER_ITERATIONS` para cambiarlo) con
 * las dos operaciones lanzadas a la vez sobre ítems compartidos, armados para cruzarse: líneas en
 * orden inverso, bobinas del mismo agregado con promesas vivas. Una operación puede ganar y la
 * otra salir con un rechazo de dominio (stock, «movimientos posteriores», ya anulado): eso es
 * correcto. Lo que **no** puede pasar es que Postgres aborte una por deadlock o que una toma
 * fuera de orden salga por `NOWAIT` (`isLockConflict`).
 *
 * Para que los cruces sean probables y no cuestión de suerte, cada toma de bobinas y de saldos
 * espera `PAUSE_MS` antes de seguir (espía sobre `lockCoilRows` y `lockBalance`). Prueba por
 * mutación (cc18): con `lockInOrder` sin ordenar, estos mismos pares fallan con 40P01 (resultado
 * en `docs/revision/cc18-segundo-modelo.md`).
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));

const ITERATIONS = Number(process.env.LOCK_ORDER_ITERATIONS ?? '20');
const PAUSE_MS = 15;
jest.setTimeout(30 * 60_000);

process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let suppliers: SuppliersService;
let catalog: CatalogService;
let purchases: PurchasesService;
let receivedEdit: ReceivedPurchaseEditService;
let customers: CustomersService;
let salesOrders: SalesOrdersService;
let quotations: QuotationsService;
let dispatches: DispatchesService;
let finishes: FinishesService;
let roofing: RoofingProductionService;
let coilOps: CoilOperationsService;
let admin: RequestUser;
let tradingLineId = '';
let roofingLineId = '';
let customerId = '';
let supplierId = '';
let roofingFinishId = '';
let redColorId = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  suppliers = moduleRef.get(SuppliersService);
  catalog = moduleRef.get(CatalogService);
  purchases = moduleRef.get(PurchasesService);
  receivedEdit = moduleRef.get(ReceivedPurchaseEditService);
  customers = moduleRef.get(CustomersService);
  salesOrders = moduleRef.get(SalesOrdersService);
  quotations = moduleRef.get(QuotationsService);
  dispatches = moduleRef.get(DispatchesService);
  finishes = moduleRef.get(FinishesService);
  roofing = moduleRef.get(RoofingProductionService);
  coilOps = moduleRef.get(CoilOperationsService);

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
  roofingLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'METALLIC_ROOFING' } })
  ).id;
  redColorId = (await prisma.color.findUniqueOrThrow({ where: { code: 'ROJO' } })).id;
  supplierId = (
    await suppliers.create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc18',
        creditDays: 0,
      }),
    )
  ).id;
  customerId = (
    await customers.create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc18',
        creditDays: 0,
      }),
    )
  ).id;
  roofingFinishId = (
    await finishes.create(
      admin,
      createFinishSchema.parse({
        code: `E${letters(5)}`,
        name: 'Acabado cc18',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId: redColorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;

  // Las pausas que vuelven probable el cruce: después de cada toma de bobinas y de cada saldo.
  const realLockCoilRows = rowLocks.lockCoilRows;
  jest.spyOn(rowLocks, 'lockCoilRows').mockImplementation(async (tx, ids) => {
    const locked = await realLockCoilRows(tx, ids);
    await sleep(PAUSE_MS);
    return locked;
  });
  const proto = InventoryService.prototype as unknown as {
    lockBalance: (...args: unknown[]) => Promise<unknown>;
  };
  const realLockBalance = proto.lockBalance;
  jest.spyOn(proto, 'lockBalance').mockImplementation(async function (this: unknown, ...args) {
    const row = await realLockBalance.apply(this, args);
    await sleep(PAUSE_MS);
    return row;
  });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await moduleRef?.close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function tradingProduct(): Promise<string> {
  const product = await catalog.create(
    admin,
    createProductSchema.parse({
      businessLineId: tradingLineId,
      sku: `T-CC18-${letters(8)}`,
      name: 'Producto cc18',
      unit: 'NIU',
      source: 'PURCHASED',
    }),
  );
  return product.id;
}

/** Una compra de producto terminado recibida, con las líneas en el orden dado. */
async function productPurchase(productIds: string[], qty = '100'): Promise<string> {
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
      items: productIds.map((productId) => ({
        productId,
        description: 'Producto cc18',
        qty,
        unit: 'NIU',
        unitPrice: '20',
      })),
    }),
  );
  await purchases.receive(admin, purchase.id);
  return purchase.id;
}

/** Una bobina de coberturas (ROJO, espesor dado) comprada y recibida en su propia compra. */
async function roofingCoil(thicknessMm: string): Promise<{ coilId: string; purchaseId: string }> {
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
          description: 'Bobina cc18',
          qty: '2000',
          unit: 'KGM',
          unitPrice: '5',
          finishId: roofingFinishId,
          widthMm: '1000',
          thicknessMm,
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  const coil = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
  return { coilId: coil.id, purchaseId: purchase.id };
}

/** Pedido directo confirmado (reserva) con las líneas en el orden dado. */
async function directOrder(
  lines: ({ productId: string; qty: string } | { saleCoilId: string })[],
): Promise<SalesOrderDto> {
  return salesOrders.createDirect(
    admin,
    createSalesOrderSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: lines.map((l) =>
        'saleCoilId' in l
          ? { saleCoilId: l.saleCoilId, qty: '1', unitPricePen: '50' }
          : { productId: l.productId, qty: l.qty, unitPricePen: '50' },
      ),
    }),
  );
}

/** Despacha todas las líneas del pedido, en el orden de sus líneas. */
function dispatchAll(order: SalesOrderDto) {
  return dispatches.create(
    admin,
    createDispatchSchema.parse({
      salesOrderId: order.id,
      dispatchDate: businessToday(),
      originAddress: 'Almacén cc18',
      destinationAddress: 'Cliente cc18',
      originUbigeo: '150101',
      destinationUbigeo: '150101',
      transferMode: 'PICKUP',
      items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
    }),
  );
}

function reverseDispatch(dispatchId: string) {
  return dispatches.reverse(
    admin,
    dispatchId,
    reverseMovementSchema.parse({ reason: 'cc18 reversa' }),
  );
}

function cancelPurchase(purchaseId: string) {
  return purchases.cancel(admin, purchaseId, cancelPurchaseSchema.parse({ reason: 'cc18 anular' }));
}

/**
 * Un agregado de coberturas con promesa viva: un producto a medida de ese espesor, una cotización
 * confirmada (reserva genérica y OP en borrador) y las bobinas que lo cumplen. Cada llamada usa un
 * espesor propio para que los agregados de iteraciones distintas no se mezclen.
 */
let thicknessStep = 0;
async function roofingAggregate(coils: number): Promise<{
  coils: { coilId: string; purchaseId: string }[];
  productionOrderId: string;
}> {
  thicknessStep += 1;
  const thicknessMm = (0.3 + thicknessStep * 0.05).toFixed(2);
  const product = await catalog.create(
    admin,
    createProductSchema.parse({
      businessLineId: roofingLineId,
      sku: `E-CC18${letters(6)}`,
      name: 'Cobertura cc18',
      unit: 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '30',
      finishId: roofingFinishId,
      colorId: redColorId,
      thicknessMm,
      widthMm: '1000',
      roofingKind: 'A_MEDIDA',
    }),
  );
  const made: { coilId: string; purchaseId: string }[] = [];
  for (let i = 0; i < coils; i++) made.push(await roofingCoil(thicknessMm));
  const quotation = await quotations.create(
    admin,
    createQuotationSchema.parse({
      customerId,
      issueDate: businessToday(),
      items: [
        {
          productId: product.id,
          qty: '6.000',
          // El piso de precio crece con el espesor: el precio también.
          unitPricePen: (100 + 200 * Number(thicknessMm)).toFixed(2),
          pieces: [{ lengthMm: '3000.00', qty: 2 }],
        },
      ],
    }),
  );
  const order = await salesOrders.confirm(admin, quotation.id, {});
  const raw = order.reservations.find((r) => r.itemType === 'RAW_MATERIAL');
  if (!raw?.productionOrderId) throw new Error('La confirmación no dejó la OP de coberturas');
  return { coils: made, productionOrderId: raw.productionOrderId };
}

/** La bobina `i` del agregado, o un error claro si la fixture no la creó. */
function coilAt(
  agg: { coils: { coilId: string; purchaseId?: string }[] },
  i: number,
): { coilId: string; purchaseId: string } {
  const coil = agg.coils[i];
  if (!coil?.purchaseId) throw new Error(`La fixture no tiene la bobina ${String(i)}`);
  return { coilId: coil.coilId, purchaseId: coil.purchaseId };
}

function mount(orderId: string, coilId: string) {
  return roofing.mountCoil(admin, orderId, mountRoofingCoilSchema.parse({ coilIds: [coilId] }));
}

function report(orderId: string) {
  return roofing.report(
    admin,
    orderId,
    reportRoofingPiecesSchema.parse({ pieces: [{ lengthMm: '3000.00', qty: 2 }] }),
  );
}

async function closeCoil(coilId: string) {
  const balance = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'COIL', itemId: coilId } },
  });
  return coilOps.setStatus(
    admin,
    coilId,
    setCoilStatusSchema.parse({ status: 'CLOSED', physicalKg: balance.qty.toFixed(3) }),
  );
}

// ---------------------------------------------------------------------------
// El juez
// ---------------------------------------------------------------------------

interface Tally {
  conflicts: string[];
  unexpected: string[];
  outcomes: Map<string, number>;
  /** Cuántas veces terminó bien cada operación del par, por posición. */
  okByOp: number[];
}

function newTally(): Tally {
  return { conflicts: [], unexpected: [], outcomes: new Map(), okByOp: [] };
}

/** Corre las dos a la vez y clasifica: éxito, rechazo de dominio, conflicto de bloqueo u otro. */
async function race(tally: Tally, label: string, ops: (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(ops.map((op) => op()));
  results.forEach((r, i) => {
    tally.okByOp[i] = (tally.okByOp[i] ?? 0) + (r.status === 'fulfilled' ? 1 : 0);
  });
  const shape = results
    .map((r) => {
      if (r.status === 'fulfilled') return 'ok';
      const reason: unknown = r.reason;
      if (isLockConflict(reason)) {
        tally.conflicts.push(`${label}: ${(reason as Error).message.slice(0, 200)}`);
        return 'LOCK';
      }
      if (reason instanceof HttpException) return `rechazo ${String(reason.getStatus())}`;
      tally.unexpected.push(
        `${label}: ${reason instanceof Prisma.PrismaClientKnownRequestError ? reason.code : ''} ${(reason as Error).message?.slice(0, 300) ?? String(reason)}`,
      );
      return 'ERROR';
    })
    .join(' / ');
  tally.outcomes.set(shape, (tally.outcomes.get(shape) ?? 0) + 1);
}

function expectClean(tally: Tally, name: string): void {
  // Visible en el log de la corrida: qué combinaciones de resultados salieron.
  console.warn(`[D-386] ${name}: ${JSON.stringify(Object.fromEntries(tally.outcomes))}`);
  expect(tally.unexpected).toEqual([]);
  expect(tally.conflicts).toEqual([]);
  // Autorrevisión P2-2: un par en el que una operación nunca terminó bien no probó nada (una
  // fixture rota que rechaza siempre con 400 daba verde). Cada operación, al menos una vez.
  expect(tally.okByOp.length).toBeGreaterThan(0);
  for (const ok of tally.okByOp) expect(ok).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Pares
// ---------------------------------------------------------------------------

describe('D-386 — ningún 40P01 entre operaciones que cruzan inventario (contra la base)', () => {
  it('despacho × anulación de compra (P2-1)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      const toCancel = await productPurchase([p1, p2]);
      await productPurchase([p1, p2]);
      const order = await directOrder([
        { productId: p2, qty: '10' },
        { productId: p1, qty: '10' },
      ]);
      await race(tally, `iteración ${i}`, [
        () => dispatchAll(order),
        () => cancelPurchase(toCancel),
      ]);
    }
    expectClean(tally, 'despacho × anulación de compra');
  });

  it('despacho × confirmación de pedido (P2-1)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      await productPurchase([p1, p2]);
      const order = await directOrder([
        { productId: p2, qty: '10' },
        { productId: p1, qty: '10' },
      ]);
      await race(tally, `iteración ${i}`, [
        () => dispatchAll(order),
        () =>
          directOrder([
            { productId: p1, qty: '10' },
            { productId: p2, qty: '10' },
          ]),
      ]);
    }
    expectClean(tally, 'despacho × confirmación de pedido');
  });

  it('despacho × «Editar compra» (replaceEntry de dos líneas)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      const edited = await productPurchase([p1, p2]);
      await productPurchase([p1, p2]);
      const items = await prisma.purchaseItem.findMany({
        where: { purchaseId: edited },
        select: { id: true },
      });
      const order = await directOrder([
        { productId: p2, qty: '10' },
        { productId: p1, qty: '10' },
      ]);
      await race(tally, `iteración ${i}`, [
        () => dispatchAll(order),
        () =>
          receivedEdit.commit(
            admin,
            edited,
            commitReceivedPurchaseEditSchema.parse({
              items: items.map((it) => ({ itemId: it.id, unitPrice: '21' })),
              reason: 'cc18 corregir precio',
            }),
          ),
      ]);
    }
    expectClean(tally, 'despacho × «Editar compra»');
  });

  it('reversa × reversa con los mismos ítems en orden inverso (P2-2)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      await productPurchase([p1, p2]);
      const one = await directOrder([
        { productId: p1, qty: '10' },
        { productId: p2, qty: '10' },
      ]);
      const two = await directOrder([
        { productId: p2, qty: '10' },
        { productId: p1, qty: '10' },
      ]);
      const [d1, d2] = [await dispatchAll(one), await dispatchAll(two)];
      await race(tally, `iteración ${i}`, [
        () => reverseDispatch(d1.id),
        () => reverseDispatch(d2.id),
      ]);
    }
    expectClean(tally, 'reversa × reversa');
  });

  it('reversa × despacho (P2-2)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      await productPurchase([p1, p2]);
      const dispatched = await dispatchAll(
        await directOrder([
          { productId: p1, qty: '10' },
          { productId: p2, qty: '10' },
        ]),
      );
      const pending = await directOrder([
        { productId: p2, qty: '10' },
        { productId: p1, qty: '10' },
      ]);
      await race(tally, `iteración ${i}`, [
        () => reverseDispatch(dispatched.id),
        () => dispatchAll(pending),
      ]);
    }
    expectClean(tally, 'reversa × despacho');
  });

  it('dos anulaciones concurrentes: la misma compra, y dos compras de los mismos ítems en orden inverso', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const [p1, p2] = [await tradingProduct(), await tradingProduct()];
      const same = await productPurchase([p1, p2]);
      await race(tally, `misma compra ${i}`, [
        () => cancelPurchase(same),
        () => cancelPurchase(same),
      ]);
      const [a, b] = [await productPurchase([p1, p2]), await productPurchase([p2, p1])];
      await race(tally, `dos compras ${i}`, [() => cancelPurchase(a), () => cancelPurchase(b)]);
    }
    expectClean(tally, 'dos anulaciones');
    // La misma compra dos veces: gana una, la otra sale con el rechazo de siempre.
    const sameShapes = [...tally.outcomes.keys()];
    expect(sameShapes.every((s) => !s.includes('ERROR'))).toBe(true);
  });
});

/**
 * A6 (commit propio): los caminos de una bobina más usados, cruzados con despacho y con anulación
 * de compra, sobre bobinas del **mismo agregado con promesas vivas**. Antes de A6, `lockCoil`
 * tomaba la bobina sola y la salida de kardex pedía después el resto del agregado.
 */
describe('D-386 (A6) — una bobina del agregado frente a despacho y anulación (contra la base)', () => {
  type Single = (agg: {
    coils: { coilId: string; purchaseId: string }[];
    productionOrderId: string;
  }) => {
    coilId: string;
    prepare: () => Promise<unknown>;
    run: () => Promise<unknown>;
  };
  const singles: [string, Single][] = [
    [
      'montar',
      (agg) => ({
        coilId: coilAt(agg, 0).coilId,
        prepare: () => Promise.resolve(),
        run: () => mount(agg.productionOrderId, coilAt(agg, 0).coilId),
      }),
    ],
    [
      'reportar',
      (agg) => ({
        coilId: coilAt(agg, 0).coilId,
        prepare: () => mount(agg.productionOrderId, coilAt(agg, 0).coilId),
        run: () => report(agg.productionOrderId),
      }),
    ],
    [
      'cerrar bobina',
      (agg) => ({
        coilId: coilAt(agg, 2).coilId,
        prepare: () => Promise.resolve(),
        run: () => closeCoil(coilAt(agg, 2).coilId),
      }),
    ],
  ];

  it.each(singles)('%s × despacho de otra bobina del agregado', async (name, single) => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await roofingAggregate(3);
      const op = single(agg);
      await op.prepare();
      const sold = coilAt(agg, 1).coilId;
      const order = await directOrder([{ saleCoilId: sold }]);
      await race(tally, `iteración ${i}`, [() => op.run(), () => dispatchAll(order)]);
    }
    expectClean(tally, `${name} × despacho`);
  });

  it.each(singles)(
    '%s × anulación de la compra de otra bobina del agregado',
    async (name, single) => {
      const tally = newTally();
      for (let i = 0; i < ITERATIONS; i++) {
        const agg = await roofingAggregate(3);
        const op = single(agg);
        await op.prepare();
        await race(tally, `iteración ${i}`, [
          () => op.run(),
          () => cancelPurchase(coilAt(agg, 1).purchaseId),
        ]);
      }
      expectClean(tally, `${name} × anulación de compra`);
    },
  );
});

/**
 * Autorrevisión P2-3: los dos cambios más grandes de M3 con bobinas del agregado — la reversa de
 * un reporte de coberturas (antes: saldo del producto, después la bobina) y confirmar la venta de
 * una bobina entera (las nombradas entran ahora con su agregado).
 */
describe('D-386 (M3) — coberturas y venta de bobina contra el agregado (contra la base)', () => {
  it('revertir un reporte de coberturas × despacho de otra bobina del agregado', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await roofingAggregate(3);
      await mount(agg.productionOrderId, coilAt(agg, 0).coilId);
      await report(agg.productionOrderId);
      const reportRow = await prisma.productionReport.findFirstOrThrow({
        where: { productionOrderId: agg.productionOrderId },
        orderBy: { seq: 'desc' },
      });
      const order = await directOrder([{ saleCoilId: coilAt(agg, 1).coilId }]);
      await race(tally, `iteración ${i}`, [
        () =>
          roofing.reverseReport(
            admin,
            agg.productionOrderId,
            reportRow.id,
            reverseMovementSchema.parse({ reason: 'cc18 revertir reporte' }),
          ),
        () => dispatchAll(order),
      ]);
    }
    expectClean(tally, 'revertir reporte de coberturas × despacho');
  });

  it('confirmar la venta de una bobina entera × anulación de la compra de otra del agregado', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await roofingAggregate(3);
      await race(tally, `iteración ${i}`, [
        () => directOrder([{ saleCoilId: coilAt(agg, 2).coilId }]),
        () => cancelPurchase(coilAt(agg, 1).purchaseId),
      ]);
    }
    expectClean(tally, 'venta de bobina × anulación de compra');
  });
});

/** M3b: la forma real del error de Prisma ante un deadlock es la que `isLockConflict` reconoce. */
describe('D-386 (M3b) — un deadlock real de Postgres', () => {
  it('se reconoce como conflicto de bloqueo (el 409 en español)', async () => {
    const [a, b] = [(await roofingCoil('3.00')).coilId, (await roofingCoil('3.00')).coilId];
    const crossed = (first: string, second: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "coils" WHERE "id" = ${first}::uuid FOR UPDATE`;
        await sleep(300);
        await tx.$queryRaw`SELECT "id" FROM "coils" WHERE "id" = ${second}::uuid FOR UPDATE`;
      });
    const results = await Promise.allSettled([crossed(a, b), crossed(b, a)]);
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(failed).toHaveLength(1);
    expect(isLockConflict(failed[0])).toBe(true);
  });
});

/**
 * cc28 (P2-1 y P3-6 de cc18): anular una orden de corte × recibir su única bobina pendiente.
 *
 * Antes, recibir tomaba la fila y después la orden (al recalcular su estado), y anular, la orden y
 * después la fila: los dos se esperaban en cruz y Postgres abortaba uno (40P01). Además anular no
 * releía la fila bajo su lock. Ahora los dos toman la orden primero y anular relee: gana uno, el
 * otro sale con un rechazo de dominio, y la fila termina como dice el que ganó.
 */
describe('cc28 — corte tercerizado: anular × recibir (contra la base)', () => {
  let cutting: CuttingService;
  let cuttingSupplierId = '';
  let drywallFinishId = '';

  beforeAll(async () => {
    cutting = moduleRef.get(CuttingService);
    cuttingSupplierId = (
      await suppliers.create(
        admin,
        createSupplierSchema.parse({
          code: letters(6),
          docType: 'RUC',
          docNumber: `20${digits(9)}`,
          name: 'Proveedor de corte cc28',
          creditDays: 0,
          providesCuttingService: true,
        }),
      )
    ).id;
    drywallFinishId = (
      await finishes.create(
        admin,
        createFinishSchema.parse({
          code: `G${letters(5)}`,
          name: 'Galvanizado cc28',
          densityFactor: '7.85',
          kind: 'GALVANIZADO',
          businessLine: 'drywall',
        }),
      )
    ).id;
  });

  /** Una bobina de drywall comprada, recibida y enviada a corte: la orden y su bobina. */
  async function sentToCutting(): Promise<{ orderId: string; coilId: string }> {
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
        businessLine: 'drywall',
        type: 'COIL',
        items: [
          {
            description: 'Bobina cc28',
            qty: '1000',
            unit: 'KGM',
            unitPrice: '4',
            finishId: drywallFinishId,
            widthMm: '1000',
            thicknessMm: '0.45',
            coilStatus: 'OPEN',
          },
        ],
      }),
    );
    await purchases.receive(admin, purchase.id);
    const coil = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    const order = await cutting.send(
      admin,
      createCuttingOrderSchema.parse({
        supplierId: cuttingSupplierId,
        coils: [{ coilId: coil.id, widthPlanMm: [{ widthMm: '250.00', stripsCount: 4 }] }],
      }),
    );
    return { orderId: order.id, coilId: coil.id };
  }

  it('gana una, la otra sale con un rechazo de dominio, sin deadlock ni fila pisada', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const { orderId, coilId } = await sentToCutting();
      const ops = [
        () =>
          cutting.receive(
            admin,
            orderId,
            coilId,
            receiveCuttingOrderCoilSchema.parse({
              receivedWidthsMm: [{ widthMm: '250.00', stripsCount: 4 }],
              receivedWeightKg: '1000',
            }),
          ),
        () => cutting.cancel(admin, orderId, cancelCuttingOrderSchema.parse({ reason: 'cc28' })),
      ];
      // Alterna quién sale primero: cada operación tiene que ganar alguna vez.
      await race(tally, `iteración ${i}`, i % 2 === 0 ? ops : [...ops].reverse());
      const row = await prisma.cuttingOrderCoil.findFirstOrThrow({
        where: { cuttingOrderId: orderId },
      });
      const strips = await prisma.coil.count({ where: { parentCoilId: coilId } });
      // La fila dice lo que pasó de verdad: recibida con sus flejes, o anulada sin ninguno.
      expect(['RECEIVED', 'CANCELLED']).toContain(row.status);
      expect(strips).toBe(row.status === 'RECEIVED' ? 4 : 0);
    }
    expectClean(tally, 'corte: anular × recibir');
  });
});
