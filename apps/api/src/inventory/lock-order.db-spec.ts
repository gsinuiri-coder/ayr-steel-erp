import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, Role } from '@prisma/client';
import {
  businessToday,
  cancelPurchaseSchema,
  cancelSalesOrderSchema,
  closeRoofingOrderSchema,
  updateSalesOrderItemQtySchema,
  commitRoofingDraftsSchema,
  commitReceivedPurchaseEditSchema,
  cancelCuttingOrderSchema,
  createCuttingOrderSchema,
  createCoilScrapSchema,
  createCoilSplitSchema,
  createCreditNoteSchema,
  createProductionOrderSchema,
  consumeStripSchema,
  reportPiecesSchema,
  createCustomerSchema,
  createDispatchSchema,
  createFinishSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSalesOrderSchema,
  createSupplierSchema,
  mountRoofingCoilSchema,
  receiveCuttingOrderCoilSchema,
  reportRoofingPiecesSchema,
  reverseMovementSchema,
  roofingReportDraftInputSchema,
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
import { FiscalImportService } from '../invoicing/fiscal-import.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { PrismaService } from '../prisma/prisma.service';
import { COMMIT_PREVIEW_TIMEOUT_MS } from '../production/close-preview';
import { ProductionService } from '../production/production.service';
import { RoofingDraftsService } from '../production/roofing-drafts.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { ReceivedPurchaseEditService } from '../purchases/purchase-received-edit.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrderEditsService } from '../sales/sales-order-edits.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { InventoryService } from './inventory.service';
import * as documentLocks from './document-locks';
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
  /** cc30: el pedido que dejó la confirmación, para los pares entre documentos. */
  salesOrder: SalesOrderDto;
}> {
  thicknessStep += 1;
  // cc29: paso de 0,03 mm (más que la tolerancia de ±0,02 de D-086, así los agregados no se
  // mezclan). Con 0,05 los ~240 agregados de la corrida pasaban de 9,99 mm, el tope del SKU.
  const thicknessMm = (0.3 + thicknessStep * 0.03).toFixed(2);
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
  return { coils: made, productionOrderId: raw.productionOrderId, salesOrder: order };
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

/**
 * cc29 (M3, D-466): la bobina queda terminada con el kardex en 0 (merma de todo su saldo, que la
 * termina sola, D-360) y después se monta declarando su peso físico: reabrir + sobrante nuevo.
 */
async function spendCoil(coilId: string) {
  const balance = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'COIL', itemId: coilId } },
  });
  await coilOps.registerScrap(
    admin,
    coilId,
    createCoilScrapSchema.parse({
      qtyKg: balance.qty.toFixed(3),
      reason: 'Prueba de concurrencia: se consume entera (cc29)',
    }),
  );
}

function mountWithSurplus(orderId: string, coilId: string) {
  return roofing.mountCoil(
    admin,
    orderId,
    mountRoofingCoilSchema.parse({
      coilId,
      reopenCoilIds: [coilId],
      reopenReason: 'Prueba de concurrencia: quedaba material (cc29)',
      physicalKg: '100.000',
    }),
  );
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
  /** cc30: los mensajes de rechazo de dominio, para leer en el log qué rechazó cada par. */
  rejections: Map<string, number>;
}

function newTally(): Tally {
  return { conflicts: [], unexpected: [], outcomes: new Map(), okByOp: [], rejections: new Map() };
}

/** Corre las dos a la vez y clasifica: éxito, rechazo de dominio, conflicto de bloqueo u otro. */
async function race(tally: Tally, label: string, ops: (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(ops.map((op) => op()));
  results.forEach((r, i) => {
    tally.okByOp[i] = (tally.okByOp[i] ?? 0) + (r.status === 'fulfilled' ? 1 : 0);
  });
  const shape = results
    .map((r, i) => {
      if (r.status === 'fulfilled') return 'ok';
      const reason: unknown = r.reason;
      if (isLockConflict(reason)) {
        tally.conflicts.push(`${label}: ${(reason as Error).message.slice(0, 200)}`);
        return 'LOCK';
      }
      if (reason instanceof HttpException) {
        const message = `${String(i)}: ${reason.message.slice(0, 120)}`;
        tally.rejections.set(message, (tally.rejections.get(message) ?? 0) + 1);
        return `rechazo ${String(reason.getStatus())}`;
      }
      tally.unexpected.push(
        `${label}: ${reason instanceof Prisma.PrismaClientKnownRequestError ? reason.code : ''} ${(reason as Error).message?.slice(0, 300) ?? String(reason)}`,
      );
      return 'ERROR';
    })
    .join(' / ');
  tally.outcomes.set(shape, (tally.outcomes.get(shape) ?? 0) + 1);
}

function expectClean(
  tally: Tally,
  name: string,
  /**
   * cc30: las posiciones de operaciones que el dominio rechaza siempre en ese par, **después** de
   * tomar sus bloqueos (anular un pedido con una OP en curso: toma pedido y reservas, y recién ahí
   * ve la OP). El cruce de bloqueos ocurre igual; lo que se exige es que no haya deadlock.
   */
  alwaysRejected: number[] = [],
): void {
  // Visible en el log de la corrida: qué combinaciones de resultados salieron.
  console.warn(
    `[D-386] ${name}: ${JSON.stringify(Object.fromEntries(tally.outcomes))} ${JSON.stringify(Object.fromEntries(tally.rejections))}`,
  );
  expect(tally.unexpected).toEqual([]);
  expect(tally.conflicts).toEqual([]);
  // Autorrevisión P2-2: un par en el que una operación nunca terminó bien no probó nada (una
  // fixture rota que rechaza siempre con 400 daba verde). Cada operación, al menos una vez.
  expect(tally.okByOp.length).toBeGreaterThan(0);
  tally.okByOp.forEach((ok, i) => {
    if (!alwaysRejected.includes(i)) expect(ok).toBeGreaterThan(0);
  });
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
      // cc29 (D-466): el camino nuevo que mueve inventario: reabrir y dar de alta el sobrante.
      'montar con sobrante',
      (agg) => ({
        coilId: coilAt(agg, 0).coilId,
        prepare: () => spendCoil(coilAt(agg, 0).coilId),
        run: () => mountWithSurplus(agg.productionOrderId, coilAt(agg, 0).coilId),
      }),
    ],
    [
      // A-2 de la autorrevisión del corte 2: bajarla deshace el sobrante (reversa + invariante).
      'bajar con sobrante',
      (agg) => {
        let consumptionId = '';
        return {
          coilId: coilAt(agg, 0).coilId,
          prepare: async () => {
            await spendCoil(coilAt(agg, 0).coilId);
            const mounted = await mountWithSurplus(agg.productionOrderId, coilAt(agg, 0).coilId);
            const live = mounted.consumptions.find(
              (c) => c.coilId === coilAt(agg, 0).coilId && c.releasedAt === null,
            );
            if (!live) throw new Error('El montaje con sobrante no dejó la bobina montada');
            consumptionId = live.id;
          },
          run: () => roofing.releaseCoil(admin, agg.productionOrderId, consumptionId),
        };
      },
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

/**
 * cc28 (D-453; A-6, A-7 y SM-8 de cc27): la vista previa de «Ejecutar y cerrar» **no deja nada** y
 * **no retiene** los candados más allá de lo que dura.
 *
 * - Después de una vista previa no hay filas nuevas en kardex, auditoría, reportes, borradores ni
 *   claves de idempotencia; los correlativos de las series fiscales no se mueven; no se encola
 *   ningún job (si la tabla de pg-boss existe). Los contadores internos `autoincrement` sí pueden
 *   avanzar (D-453): no son correlativos de ningún documento.
 * - Un cierre real lanzado a la vez que una vista previa entra en cuanto esta termina y cierra.
 */
describe('cc28 — la vista previa de un cierre no deja nada ni retiene bloqueos (contra la base)', () => {
  let drafts: RoofingDraftsService;

  beforeAll(() => {
    drafts = moduleRef.get(RoofingDraftsService);
  });

  /** Una OP de coberturas con su bobina montada y una fila en el borrador. */
  async function orderWithDraft(): Promise<string> {
    const agg = await roofingAggregate(1);
    await mount(agg.productionOrderId, coilAt(agg, 0).coilId);
    await drafts.add(
      admin,
      agg.productionOrderId,
      roofingReportDraftInputSchema.parse({ pieces: [{ lengthMm: '3000.00', qty: 2 }] }),
    );
    return agg.productionOrderId;
  }

  async function footprint(orderId: string) {
    const [movements, audit, reports, draftRows, keys, series, jobsTable] = await Promise.all([
      prisma.inventoryMovement.count(),
      prisma.auditLog.count(),
      prisma.productionReport.count(),
      prisma.productionReportDraft.count({ where: { productionOrderId: orderId } }),
      prisma.idempotencyKey.count(),
      prisma.fiscalSeries.findMany({
        select: { series: true, correlative: true },
        orderBy: { series: 'asc' },
      }),
      prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('pgboss.job')::text AS "t"`,
    ]);
    const jobs =
      jobsTable[0]?.t === null || jobsTable[0]?.t === undefined
        ? null
        : Number(
            (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS "n" FROM pgboss.job`)[0]
              ?.n ?? 0,
          );
    const order = await prisma.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    return { movements, audit, reports, draftRows, keys, series, jobs, status: order.status };
  }

  it('después de la vista previa todo queda como estaba', async () => {
    const orderId = await orderWithDraft();
    const before = await footprint(orderId);
    const preview = await drafts.previewCommit(
      admin,
      orderId,
      commitRoofingDraftsSchema.parse({ close: true, idempotencyKey: randomUUID() }),
    );
    expect(preview.coils).toHaveLength(1);
    expect(Number(preview.coils[0]?.consumedKg ?? '0')).toBeGreaterThan(0);
    expect(await footprint(orderId)).toEqual(before);
    expect(before.status).toBe('IN_PROGRESS');
    expect(before.draftRows).toBe(1);
  });

  it('un cierre real a la vez que una vista previa entra en cuanto esta termina', async () => {
    const orderId = await orderWithDraft();
    const started = Date.now();
    const [preview, commit] = await Promise.allSettled([
      drafts.previewCommit(
        admin,
        orderId,
        commitRoofingDraftsSchema.parse({ close: true, idempotencyKey: randomUUID() }),
      ),
      drafts.commit(
        admin,
        orderId,
        commitRoofingDraftsSchema.parse({ close: true, idempotencyKey: randomUUID() }),
      ),
    ]);
    // El cierre real nunca pierde por la vista previa: ni por bloqueo ni por timeout.
    expect(commit.status).toBe('fulfilled');
    expect(Date.now() - started).toBeLessThan(COMMIT_PREVIEW_TIMEOUT_MS);
    // La vista previa, o vio la orden abierta (y se deshizo), o llegó tarde y la encontró cerrada.
    if (preview.status === 'rejected') {
      expect(preview.reason).toBeInstanceOf(HttpException);
      expect(isLockConflict(preview.reason)).toBe(false);
    }
    const closed = await prisma.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    expect(closed.status).toBe('CLOSED');
    expect(
      await prisma.productionReport.count({
        where: { productionOrderId: orderId, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });
});

/**
 * cc30 (grupo C de cc18): **el orden entre documentos** —cotización → pedido → OP → reserva →
 * inventario—, contra la base y con concurrencia de verdad. Los cruces que anotó cc18:
 *
 * - (b) revertir un reporte de coberturas restauraba la reserva de materia prima al final, con
 *   los saldos en mano; anular el pedido toma sus reservas por id al inicio;
 * - (c) cambiar la cantidad de una línea iba pedido → reservas → OP, y reportar coberturas iba
 *   OP → pedido;
 * - (d) cerrar coberturas sin despunte liberaba la reserva después de los saldos.
 *
 * Anular un pedido con la OP en curso lo rechaza el dominio siempre, pero **después** de tomar
 * pedido y reservas: el cruce ocurre igual, y es lo que se mide (`alwaysRejected`).
 */
describe('cc30 — grupo C: pedido, OP y reserva (contra la base)', () => {
  let edits: SalesOrderEditsService;

  beforeAll(() => {
    edits = moduleRef.get(SalesOrderEditsService);
    // Las pausas también después de cada toma de documentos: con la puerta nueva, el cruce entre
    // documentos deja de depender de la suerte igual que el de inventario.
    const realLockDocuments = documentLocks.lockDocuments;
    jest.spyOn(documentLocks, 'lockDocuments').mockImplementation(async (tx, set) => {
      const locked = await realLockDocuments(tx, set);
      await sleep(PAUSE_MS);
      return locked;
    });
  });

  const cancelOrder = (orderId: string) =>
    salesOrders.cancel(
      admin,
      orderId,
      cancelSalesOrderSchema.parse({ reason: 'cc30 anular', acknowledgeFabricated: true }),
    );

  async function reportedAggregate() {
    const agg = await roofingAggregate(1);
    await mount(agg.productionOrderId, coilAt(agg, 0).coilId);
    await report(agg.productionOrderId);
    const reportRow = await prisma.productionReport.findFirstOrThrow({
      where: { productionOrderId: agg.productionOrderId },
      orderBy: { seq: 'desc' },
    });
    return { ...agg, reportId: reportRow.id };
  }

  it('(b) revertir un reporte de coberturas × anular el pedido', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await reportedAggregate();
      await race(tally, `iteración ${i}`, [
        () =>
          roofing.reverseReport(
            admin,
            agg.productionOrderId,
            agg.reportId,
            reverseMovementSchema.parse({ reason: 'cc30 revertir reporte' }),
          ),
        // Anular es más corto: arranca escalonado para barrer la ventana en que el otro ya tomó
        // su primera fila y todavía no la segunda.
        async () => {
          await sleep((i % 10) * 12);
          return cancelOrder(agg.salesOrder.id);
        },
      ]);
    }
    expectClean(tally, '(b) revertir reporte de coberturas × anular pedido', [1]);
  });

  it('(c) cambiar la cantidad de la línea × reportar coberturas', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await roofingAggregate(1);
      await mount(agg.productionOrderId, coilAt(agg, 0).coilId);
      const item = agg.salesOrder.items[0];
      if (!item) throw new Error('El pedido de la fixture no tiene líneas');
      const ops = [
        () => report(agg.productionOrderId),
        () =>
          edits.updateItemQty(
            admin,
            agg.salesOrder.id,
            item.id,
            updateSalesOrderItemQtySchema.parse({
              qty: '9.000',
              pieces: [{ lengthMm: '3000.00', qty: 3 }],
            }),
          ),
      ];
      await race(tally, `iteración ${i}`, i % 2 === 0 ? ops : [...ops].reverse());
    }
    expectClean(tally, '(c) cambiar cantidad × reportar coberturas');
  });

  it('(d) cerrar coberturas sin despunte × anular el pedido (sin ciclo: regresión)', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await reportedAggregate();
      await race(tally, `iteración ${i}`, [
        () => roofing.close(admin, agg.productionOrderId, closeRoofingOrderSchema.parse({})),
        // Anular es más corto: arranca escalonado para barrer la ventana en que el otro ya tomó
        // su primera fila y todavía no la segunda.
        async () => {
          await sleep((i % 10) * 12);
          return cancelOrder(agg.salesOrder.id);
        },
      ]);
    }
    expectClean(tally, '(d) cerrar coberturas × anular pedido', [1]);
  });

  /**
   * La pareja real de (d) según la matriz (C5): completar la reserva de un pedido confirmado con
   * faltante (D-341) va pedido → reservas → bobinas del agregado, y el cierre sin despunte liberaba
   * la reserva de materia prima con las bobinas y el saldo ya en mano.
   */
  async function shortfallAggregate() {
    thicknessStep += 1;
    const thicknessMm = (0.3 + thicknessStep * 0.03).toFixed(2);
    const product = await catalog.create(
      admin,
      createProductSchema.parse({
        businessLineId: roofingLineId,
        sku: `E-CC30${letters(6)}`,
        name: 'Cobertura cc30',
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
    const first = await roofingCoil(thicknessMm);
    // 900 m de un metro de ancho pasan los 2000 kg de la bobina: se confirma con faltante.
    const quotation = await quotations.create(
      admin,
      createQuotationSchema.parse({
        customerId,
        issueDate: businessToday(),
        items: [
          {
            productId: product.id,
            qty: '900.000',
            unitPricePen: (100 + 200 * Number(thicknessMm)).toFixed(2),
            pieces: [{ lengthMm: '3000.00', qty: 300 }],
          },
        ],
      }),
    );
    const order = await salesOrders.confirm(admin, quotation.id, {
      confirmShortfall: true,
      shortfallReason: 'cc30: faltante de prueba',
    });
    const raw = order.reservations.find((r) => r.itemType === 'RAW_MATERIAL');
    if (!raw?.productionOrderId) throw new Error('La confirmación no dejó la OP de coberturas');
    await mount(raw.productionOrderId, first.coilId);
    await report(raw.productionOrderId);
    // Material nuevo del mismo agregado: completar la reserva tiene de dónde tomar.
    await roofingCoil(thicknessMm);
    return { productionOrderId: raw.productionOrderId, salesOrder: order };
  }

  it('(d) cerrar coberturas sin despunte × completar la reserva', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const agg = await shortfallAggregate();
      // Una de las dos arranca escalonada, por turnos: si el cierre entra primero libera la reserva
      // y completar ya no tiene faltante (rechazo de dominio). Con un solo sentido de escalón,
      // completar no ganaba nunca en el runner y el par no probaba nada (CI del corte 2).
      const delay = (i % 10) * 12;
      const close = async () => {
        if (i % 2 === 1) await sleep(delay);
        return roofing.close(admin, agg.productionOrderId, closeRoofingOrderSchema.parse({}));
      };
      const complete = async () => {
        if (i % 2 === 0) await sleep(delay);
        return salesOrders.completeReservation(admin, agg.salesOrder.id, 'cc30 completar');
      };
      await race(tally, `iteración ${i}`, [close, complete]);
    }
    expectClean(tally, '(d) cerrar coberturas × completar reserva');
  });
});

/**
 * cc30 (grupo C, cruce a): revertir un reporte de drywall restauraba la reserva y escribía el
 * pedido **después** de los saldos (`restoreReservationIfIdle`: reserva → pedido), mientras anular
 * el pedido va pedido → reservas y el despacho del mismo pedido va pedido → reservas → saldos.
 *
 * Fixture por iteración: una bobina de drywall cortada en dos flejes, un perfil fabricado, stock del
 * perfil hecho por una OP sin pedido (primer fleje), un pedido directo que lo reserva y la OP de ese
 * pedido con un reporte (segundo fleje): la reserva queda consumida y el pedido «en producción».
 */
describe('cc30 — grupo C: drywall (contra la base)', () => {
  let production: ProductionService;
  let cutting: CuttingService;
  let drywallLineId = '';
  let cutterId = '';
  let galvanizedId = '';

  beforeAll(async () => {
    production = moduleRef.get(ProductionService);
    cutting = moduleRef.get(CuttingService);
    drywallLineId = (await prisma.businessLine.findUniqueOrThrow({ where: { code: 'DRYWALL' } }))
      .id;
    cutterId = (
      await suppliers.create(
        admin,
        createSupplierSchema.parse({
          code: letters(6),
          docType: 'RUC',
          docNumber: `20${digits(9)}`,
          name: 'Proveedor de corte cc30',
          creditDays: 0,
          providesCuttingService: true,
        }),
      )
    ).id;
    galvanizedId = (
      await finishes.create(
        admin,
        createFinishSchema.parse({
          code: `G${letters(5)}`,
          name: 'Galvanizado cc30',
          densityFactor: '7.85',
          kind: 'GALVANIZADO',
          businessLine: 'drywall',
        }),
      )
    ).id;
  });

  async function twoStrips(): Promise<[string, string]> {
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
            description: 'Bobina cc30',
            qty: '2400',
            unit: 'KGM',
            unitPrice: '4',
            finishId: galvanizedId,
            widthMm: '1200',
            thicknessMm: '0.50',
            coilStatus: 'OPEN',
          },
        ],
      }),
    );
    await purchases.receive(admin, purchase.id);
    const mother = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    const order = await cutting.send(
      admin,
      createCuttingOrderSchema.parse({
        supplierId: cutterId,
        coils: [{ coilId: mother.id, widthPlanMm: [{ widthMm: '600.00', stripsCount: 2 }] }],
      }),
    );
    await cutting.receive(
      admin,
      order.id,
      mother.id,
      receiveCuttingOrderCoilSchema.parse({
        receivedWidthsMm: [{ widthMm: '600.00', stripsCount: 2 }],
        receivedWeightKg: '2400',
      }),
    );
    const strips = await prisma.coil.findMany({
      where: { parentCoilId: mother.id },
      orderBy: { code: 'asc' },
    });
    const [a, b] = strips;
    if (!a || !b) throw new Error('El corte no dejó dos flejes');
    return [a.id, b.id];
  }

  /** El pedido «en producción» con su OP reportada y lo necesario para revertirla. */
  async function reportedDrywallOrder() {
    const [stockStrip, orderStrip] = await twoStrips();
    const product = await catalog.create(
      admin,
      createProductSchema.parse({
        businessLineId: drywallLineId,
        sku: `D-CC30${letters(6)}`,
        name: 'Perfil cc30',
        unit: 'NIU',
        source: 'MANUFACTURED',
        listPricePen: '30',
        thicknessMm: '0.50',
        widthMm: '600',
        lengthMm: '3000',
        pieceWeightKg: '2.000',
      }),
    );
    // Stock del perfil: una OP sin pedido.
    const stockOp = await production.create(
      admin,
      createProductionOrderSchema.parse({ productId: product.id }),
    );
    await production.consume(admin, stockOp.id, consumeStripSchema.parse({ coilId: stockStrip }));
    await production.report(admin, stockOp.id, reportPiecesSchema.parse({ pieces: 50 }));
    // El pedido reserva 10 piezas; su OP reporta 5 y consume la reserva.
    const order = await directOrder([{ productId: product.id, qty: '10' }]);
    const reservation = order.reservations.find((r) => r.itemType === 'PRODUCT');
    if (!reservation) throw new Error('El pedido no reservó el perfil');
    const op = await production.create(
      admin,
      createProductionOrderSchema.parse({ productId: product.id, reservationId: reservation.id }),
    );
    await production.consume(admin, op.id, consumeStripSchema.parse({ coilId: orderStrip }));
    await production.report(admin, op.id, reportPiecesSchema.parse({ pieces: 5 }));
    const reportRow = await prisma.productionReport.findFirstOrThrow({
      where: { productionOrderId: op.id },
    });
    return { order, opId: op.id, reportId: reportRow.id };
  }

  const reverseDrywall = (opId: string, reportId: string) =>
    production.reverseReport(
      admin,
      opId,
      reportId,
      reverseMovementSchema.parse({ reason: 'cc30 revertir reporte de drywall' }),
    );

  it('(a) revertir un reporte de drywall × anular el pedido', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const f = await reportedDrywallOrder();
      await race(tally, `iteración ${i}`, [
        () => reverseDrywall(f.opId, f.reportId),
        async () => {
          await sleep((i % 10) * 12);
          return salesOrders.cancel(
            admin,
            f.order.id,
            cancelSalesOrderSchema.parse({ reason: 'cc30 anular', acknowledgeFabricated: true }),
          );
        },
      ]);
    }
    expectClean(tally, '(a) revertir reporte de drywall × anular pedido', [1]);
  });

  it('(a) revertir un reporte de drywall × despachar el pedido', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const f = await reportedDrywallOrder();
      // El despacho arranca escalonado: la reversa escribe el pedido al final, con los saldos en
      // mano, y el cruce pide que el despacho tome el pedido justo antes.
      await race(tally, `iteración ${i}`, [
        () => reverseDrywall(f.opId, f.reportId),
        async () => {
          await sleep((i % 10) * 15);
          return dispatchAll(f.order);
        },
      ]);
    }
    expectClean(tally, '(a) revertir reporte de drywall × despacho');
  });
});

/**
 * cc30 (corte 2): cruces nuevos de la matriz (`docs/analisis/cc30-matriz-bloqueos.md`).
 *
 * - C7: reasignar el vendedor de una cotización iba cotización → pedidos, y anular el pedido iba
 *   pedido → … → cotización.
 * - C8: crear un borrador de comprobante que declara un despacho iba pedido → despacho, y revertir
 *   ese despacho iba despacho → pedido.
 */
describe('cc30 — corte 2: cotización, comprobante y despacho (contra la base)', () => {
  let invoicing: InvoicingService;
  let sellerId = '';

  beforeAll(async () => {
    invoicing = moduleRef.get(InvoicingService);
    sellerId = (
      await prisma.user.create({
        data: {
          email: `vendedor-cc30-${letters(8).toLowerCase()}@example.test`,
          name: 'Vendedor cc30',
          passwordHash: 'x',
          role: Role.VENDEDOR,
        },
      })
    ).id;
  });

  /** Un pedido confirmado desde una cotización, sobre un producto con stock. */
  async function orderFromQuotation() {
    const product = await tradingProduct();
    await productPurchase([product]);
    const quotation = await quotations.create(
      admin,
      createQuotationSchema.parse({
        customerId,
        issueDate: businessToday(),
        items: [{ productId: product, qty: '5', unitPricePen: '50' }],
      }),
    );
    const order = await salesOrders.confirm(admin, quotation.id, {});
    return { quotationId: quotation.id, order };
  }

  it('C7: reasignar el vendedor de la cotización × anular su pedido', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const f = await orderFromQuotation();
      const ops = [
        () => quotations.reassign(admin, f.quotationId, sellerId, 'cc30 reasignar'),
        () =>
          salesOrders.cancel(
            admin,
            f.order.id,
            cancelSalesOrderSchema.parse({ reason: 'cc30 anular', acknowledgeFabricated: true }),
          ),
      ];
      await race(tally, `iteración ${i}`, i % 2 === 0 ? ops : [...ops].reverse());
    }
    expectClean(tally, 'C7 reasignar × anular pedido');
  });

  it('C8: borrador de comprobante con el despacho × revertir ese despacho', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await tradingProduct();
      await productPurchase([p]);
      const order = await directOrder([{ productId: p, qty: '5' }]);
      const dispatch = await dispatchAll(order);
      const ops = [
        () =>
          invoicing.create(
            admin,
            createInvoiceSchema.parse({
              docType: 'FACTURA',
              customerId,
              salesOrderId: order.id,
              dispatchId: dispatch.id,
              issueDate: businessToday(),
              items: order.items.map((it) => ({ salesOrderItemId: it.id, qty: it.qty })),
            }),
          ),
        () => reverseDispatch(dispatch.id),
      ];
      await race(tally, `iteración ${i}`, i % 2 === 0 ? ops : [...ops].reverse());
    }
    expectClean(tally, 'C8 borrador con despacho × revertir despacho');
  });
});

/**
 * cc33 N3: registrar una nota de crédito manual ahora bloquea la nota **y su afectado** en una sola
 * llamada a la puerta; anular el afectado bloquea el afectado. La anulación sale siempre rechazada
 * (o hay un borrador o ya hay una nota viva): lo que se exige es que nunca haya deadlock y que la
 * factura no quede anulada con una nota viva encima.
 */
describe('cc33 — N3: registrar una NC manual × anular su factura (contra la base)', () => {
  let invoicing: InvoicingService;
  let fiscalImport: FiscalImportService;
  let correlative = Math.floor(Math.random() * 50_000) + 10_000;

  beforeAll(() => {
    invoicing = moduleRef.get(InvoicingService);
    fiscalImport = moduleRef.get(FiscalImportService);
  });

  it('C10: sin deadlock y sin nota viva sobre una factura anulada', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const p = await tradingProduct();
      await productPurchase([p]);
      const order = await directOrder([{ productId: p, qty: '5' }]);
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
        series: 'F933',
        correlative: (correlative += 1),
      });
      const note = await invoicing.createCreditNote(
        admin,
        invoice.id,
        createCreditNoteSchema.parse({
          reason: 'ANULACION_OPERACION',
          issueDate: businessToday(),
        }),
      );
      const ops = [
        () =>
          invoicing.registerManual(admin, note.id, {
            series: 'F934',
            correlative: (correlative += 1),
          }),
        () => fiscalImport.annulExternal(admin, invoice.id, 'cc33 anular'),
      ];
      // Sin invertir el orden: `alwaysRejected` cuenta por posición, y la anulación es la 1.
      await race(tally, `iteración ${i}`, ops);
      const after = await prisma.fiscalDocument.findUniqueOrThrow({
        where: { id: invoice.id },
        select: { status: true },
      });
      expect(after.status).toBe('ACCEPTED');
    }
    expectClean(tally, 'C10 registrar NC × anular factura', [1]);
  });

  it('C10b: con la factura ya anulada, registrar su NC en borrador da 409 (parte b, contra la base)', async () => {
    const p = await tradingProduct();
    await productPurchase([p]);
    const order = await directOrder([{ productId: p, qty: '5' }]);
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
      series: 'F933',
      correlative: (correlative += 1),
    });
    const note = await invoicing.createCreditNote(
      admin,
      invoice.id,
      createCreditNoteSchema.parse({ reason: 'ANULACION_OPERACION', issueDate: businessToday() }),
    );
    // Fixture: la factura anulada con el borrador ya creado, el estado que dejaba un borrador
    // anterior a cc33 (la anulación ya no lo permite). Solo estado, como la anulación real.
    await prisma.fiscalDocument.update({
      where: { id: invoice.id },
      data: {
        status: 'ANNULLED',
        annulledAt: new Date(),
        annulledById: admin.id,
        annulReason: 'cc33 fixture',
      },
    });
    await expect(
      invoicing.registerManual(admin, note.id, { series: 'F934', correlative: (correlative += 1) }),
    ).rejects.toThrow('anulado: esta nota de crédito ya no se registra ni se emite');
    const after = await prisma.fiscalDocument.findUniqueOrThrow({
      where: { id: note.id },
      select: { status: true },
    });
    expect(after.status).toBe('DRAFT');
  });
});

/**
 * cc30 (corte 2, C9): editar una compra recibida tomaba la compra con `FOR UPDATE` y después sus
 * bobinas; partir una bobina de esa compra toma la bobina y después, al insertar las hijas con la
 * compra heredada, `KEY SHARE` sobre la compra (FK). Con `FOR NO KEY UPDATE` en la edición los dos
 * modos conviven y el cruce desaparece. Depende de que el único índice único de `purchases` sea
 * parcial: un `UNIQUE` total sobre columnas que la edición cambia subiría su `UPDATE` a
 * `FOR UPDATE` y este par volvería a fallar.
 */
describe('cc30 — corte 2: editar compra recibida × partir su bobina (contra la base)', () => {
  it('C9: sin deadlock entre la FK de las hijas y el bloqueo de la compra', async () => {
    const tally = newTally();
    for (let i = 0; i < ITERATIONS; i++) {
      const { coilId, purchaseId } = await roofingCoil('2.50');
      const items = await prisma.purchaseItem.findMany({
        where: { purchaseId },
        select: { id: true },
      });
      const ops = [
        () =>
          receivedEdit.commit(
            admin,
            purchaseId,
            commitReceivedPurchaseEditSchema.parse({
              items: items.map((it) => ({ itemId: it.id, unitPrice: '6' })),
              reason: 'cc30 corregir precio',
            }),
          ),
        () =>
          coilOps.split(
            admin,
            coilId,
            createCoilSplitSchema.parse({ children: [{ widthMm: '500.00', count: 2 }] }),
          ),
      ];
      await race(tally, `iteración ${i}`, i % 2 === 0 ? ops : [...ops].reverse());
    }
    expectClean(tally, 'C9 editar compra × partir bobina');
  });
});
