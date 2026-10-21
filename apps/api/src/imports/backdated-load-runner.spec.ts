import { BadRequestException, HttpException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as XLSX from 'xlsx';
import { Decimal } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { idempotencyKeyOf, type LoadOp, type LoadStep } from './backdated-load-ops';
import {
  BackdatedLoadRunner,
  LOAD_ENTITY,
  LOAD_OP_ACTION,
  LOAD_PICKUP,
  LOAD_REVERTED_ACTION,
  LOAD_START_ACTION,
  LOAD_STARTED_ACTION,
  loadReference,
  readManifest,
  type LoadDeps,
  type LoadManifest,
  type OpIds,
} from './backdated-load-runner';

/**
 * cc64 (D-705, D-706) — **el cargador de la carga atrasada, sin base**: cada paso con una base y
 * servicios falsos, para ver qué llama, con qué clave de idempotencia, fecha y motivo. El recorrido
 * real contra la base vive en `backdated-load-runner.db-spec.ts`.
 */

const BATCH = 'lote-cc64';
const REASON = `Reversa de la carga atrasada ${BATCH}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR: RequestUser = {
  id: uuid(900),
  email: 'admin@ayr.pe',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: uuid(901),
};
const ids = {
  purchase: uuid(1),
  quotation: uuid(2),
  order: uuid(3),
  item1: uuid(4),
  item2: uuid(5),
  po: uuid(6),
  report: uuid(7),
  coil: uuid(8),
  customer: uuid(9),
  product: uuid(10),
  dispatch: uuid(11),
  invoice: uuid(12),
  draft: uuid(13),
  payment: uuid(14),
  saleCoil: uuid(15),
};

type Op<S extends LoadStep> = Extract<LoadOp, { step: S }>;
const keyOf = (op: { key: string }, part = '') => idempotencyKeyOf(BATCH, op.key, part);

function fakeDb() {
  return {
    auditLog: { findMany: jest.fn() },
    purchase: { findFirst: jest.fn(), findUnique: jest.fn() },
    quotation: { findFirst: jest.fn(), findUnique: jest.fn() },
    salesOrder: { findFirst: jest.fn(), findUnique: jest.fn() },
    productionOrder: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn() },
    productionReport: { findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    idempotencyKey: { findUnique: jest.fn() },
    coil: { findFirst: jest.fn() },
    fiscalDocument: { findFirst: jest.fn(), findUnique: jest.fn() },
    customer: { findUniqueOrThrow: jest.fn() },
    dispatch: { findMany: jest.fn(), findUnique: jest.fn() },
    customerPayment: { findUnique: jest.fn() },
    supplierPayment: { findFirst: jest.fn(), findUnique: jest.fn() },
  };
}

function fakeDeps() {
  return {
    prisma: fakeDb(),
    audit: { write: jest.fn(), log: jest.fn().mockResolvedValue(undefined) },
    purchaseImport: { confirm: jest.fn().mockResolvedValue({}) },
    purchases: {
      receive: jest.fn().mockResolvedValue({}),
      cancel: jest.fn().mockResolvedValue({}),
      addPayment: jest.fn().mockResolvedValue({}),
      reversePayment: jest.fn().mockResolvedValue({}),
    },
    quotationImport: { preview: jest.fn(), confirm: jest.fn().mockResolvedValue({}) },
    quotations: { cancel: jest.fn().mockResolvedValue({}) },
    salesOrders: {
      confirm: jest.fn().mockResolvedValue({ id: ids.order }),
      cancel: jest.fn().mockResolvedValue({}),
    },
    roofing: {
      mountCoil: jest.fn().mockResolvedValue({}),
      report: jest.fn().mockResolvedValue({}),
      reportAndClose: jest.fn().mockResolvedValue({}),
      reopen: jest.fn().mockResolvedValue({}),
      reverseReport: jest.fn().mockResolvedValue({}),
      cancel: jest.fn().mockResolvedValue({}),
    },
    dispatches: {
      create: jest.fn().mockResolvedValue({ id: ids.dispatch }),
      reverse: jest.fn().mockResolvedValue({}),
    },
    invoicing: {
      create: jest.fn().mockResolvedValue({ id: ids.draft }),
      registerManual: jest.fn().mockResolvedValue({ id: ids.invoice }),
    },
    fiscalImport: { annulExternal: jest.fn().mockResolvedValue({}) },
    receivables: {
      addPayment: jest.fn().mockResolvedValue({}),
      reversePayment: jest.fn().mockResolvedValue({}),
    },
  };
}
type Deps = ReturnType<typeof fakeDeps>;

const emptyManifest = (): LoadManifest => ({
  start: null,
  done: new Map(),
  reverted: new Set(),
  started: new Set(),
});

function setup() {
  const deps = fakeDeps();
  const runner = new BackdatedLoadRunner(deps as unknown as LoadDeps, ACTOR, BATCH);
  return { deps, db: deps.prisma, runner };
}

/** Ejecuta una sola operación y devuelve lo que anotó o la falla. */
async function runOne(
  runner: BackdatedLoadRunner,
  op: LoadOp,
  manifest: LoadManifest = emptyManifest(),
) {
  const result = await runner.execute([op], manifest);
  return { result, ids: manifest.done.get(op.key)?.ids, manifest };
}

/** Lo que el lote anotó como hecho (la anotación `op`). */
function recorded(deps: Deps): unknown[] {
  return deps.audit.log.mock.calls
    .map(([entry]) => entry as { action: string; after: unknown })
    .filter((e) => e.action === LOAD_OP_ACTION)
    .map((e) => e.after);
}

// --- operaciones -------------------------------------------------------------------------------

const purchaseRaw = {
  'TIPO DE COMPRA': 'PRODUCTO TERMINADO',
  'LÍNEA DE NEGOCIO': 'REVENTA',
  'TIPO DE COMPROBANTE': 'FACTURA',
  'SERIE-NÚMERO': 'F001-0001234',
  'FECHA DE EMISIÓN': '2026-09-05',
  'RUC PROVEEDOR': '20100000001',
  MONEDA: 'PEN',
  'CONDICIÓN DE PAGO': 'CONTADO',
  SKU: 'T-CC64',
  DESCRIPCIÓN: 'Producto cc64',
  CANTIDAD: '10',
  UNIDAD: 'NIU',
  'PRECIO UNITARIO SIN IGV': '20',
  'FECHA DE RECEPCIÓN': '2026-09-06',
};
const purchaseOp = (over: Partial<Op<'purchases'>> = {}): Op<'purchases'> => ({
  step: 'purchases',
  key: 'compra|20100000001|F001-0001234',
  date: '2026-09-06',
  supplierRuc: '20100000001',
  document: 'F001-0001234',
  receivedDate: '2026-09-06',
  raws: [purchaseRaw],
  rows: [{ sheet: 'Compras', row: 2 }],
  ...over,
});
const saleOp = (raws: Record<string, unknown>[] = [{ 'CÓDIGO PRODUCTO': 'T-CC64' }]) =>
  ({
    step: 'sales',
    key: 'venta|F964-123',
    date: '2026-09-10',
    document: 'F964-123',
    raws,
    rows: [{ sheet: 'Ventas', row: 2 }],
  }) satisfies Op<'sales'>;
const orderOp = (): Op<'orders'> => ({
  step: 'orders',
  key: 'pedido|F964-123',
  date: '2026-09-10',
  document: 'F964-123',
  rows: [{ sheet: 'Ventas', row: 2 }],
});
const productionOp = (over: Partial<Op<'production'>> = {}): Op<'production'> => ({
  step: 'production',
  key: 'parte|F964-123|COB-1|1',
  date: '2026-09-11',
  document: 'F964-123',
  sku: 'COB-1',
  qty: '4',
  coil: '',
  coilKg: '',
  rows: [{ sheet: 'Producción', row: 2 }],
  ...over,
});
const dispatchOp = (over: Partial<Op<'dispatches'>> = {}): Op<'dispatches'> => ({
  step: 'dispatches',
  key: 'despacho|F964-123|2026-09-12|1',
  date: '2026-09-12',
  document: 'F964-123',
  items: [{ sku: 'T-CC64', qty: '5' }],
  mode: 'PICKUP',
  destination: '',
  ubigeo: '',
  rows: [{ sheet: 'Despachos', row: 2 }],
  ...over,
});
const invoiceOp = (over: Partial<Op<'invoices'>> = {}): Op<'invoices'> => ({
  step: 'invoices',
  key: 'comprobante|F964-123',
  date: '2026-09-10',
  document: 'F964-123',
  docType: 'FACTURA',
  paymentTerms: null,
  dueDate: '2026-10-10',
  rows: [{ sheet: 'Ventas', row: 2 }],
  ...over,
});
const collectionOp = (over: Partial<Op<'collections'>> = {}): Op<'collections'> => ({
  step: 'collections',
  key: 'cobro|F964-123|1',
  date: '2026-09-15',
  document: 'F964-123',
  amount: '1.234,50',
  method: 'Transferencia',
  reference: ' op 77 ',
  rows: [{ sheet: 'Cobros', row: 2 }],
  ...over,
});
const supplierPaymentOp = (over: Partial<Op<'supplierPayments'>> = {}): Op<'supplierPayments'> => ({
  step: 'supplierPayments',
  key: 'pago|20100000001|F001-0001234|2',
  date: '2026-09-07',
  supplierRuc: '20100000001',
  document: 'F001-0001234',
  amount: '236',
  method: 'yape',
  reference: 'dep 1',
  rows: [{ sheet: 'Pagos', row: 3 }],
  ...over,
});

/** Un pedido con sus líneas, como lo lee `orderOf`. */
const orderRow = (
  items: { id: string; qty: string; sku: string; dispatched?: string[] }[] = [
    { id: ids.item1, qty: '10', sku: 'T-CC64' },
  ],
) => ({
  id: ids.order,
  customerId: ids.customer,
  items: items.map((i) => ({
    id: i.id,
    qty: new Decimal(i.qty),
    product: { sku: i.sku },
    dispatchItems: (i.dispatched ?? []).map((q) => ({ qty: new Decimal(q) })),
  })),
});

// -----------------------------------------------------------------------------------------------

describe('readManifest (cc64)', () => {
  it('arma el manifiesto: la primera anotación manda, una reversa saca la operación de lo hecho', async () => {
    const { db } = setup();
    db.auditLog.findMany.mockResolvedValue([
      { action: LOAD_START_ACTION, after: { fileName: 'plan.xlsx', sha256: 'abc', ops: 3 } },
      { action: LOAD_START_ACTION, after: { fileName: 'otro.xlsx', sha256: 'zzz' } },
      { action: LOAD_STARTED_ACTION, after: { key: 'a' } },
      { action: LOAD_OP_ACTION, after: { key: 'a', step: 'purchases', ids: { purchaseId: 'p' } } },
      { action: LOAD_OP_ACTION, after: { key: 'a', step: 'purchases', ids: { adopted: true } } },
      { action: LOAD_OP_ACTION, after: { key: 'b', step: 'sales' } },
      { action: LOAD_REVERTED_ACTION, after: { key: 'b', step: 'sales' } },
      { action: LOAD_STARTED_ACTION, after: { key: 'c' } },
      { action: 'otra.accion', after: null },
    ]);
    const m = await readManifest(db as never, BATCH);
    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: { entity: LOAD_ENTITY, entityId: BATCH },
      orderBy: { id: 'asc' },
      select: { action: true, after: true },
    });
    expect(m.start).toEqual({ fileName: 'plan.xlsx', sha256: 'abc' });
    expect([...m.done]).toEqual([['a', { step: 'purchases', ids: { purchaseId: 'p' } }]]);
    expect([...m.reverted]).toEqual(['b']);
    expect([...m.started]).toEqual(['a', 'c']);
  });

  it('una operación vuelta a hacer después de revertida sale de las revertidas; inicio sin datos', async () => {
    const { db } = setup();
    db.auditLog.findMany.mockResolvedValue([
      { action: LOAD_START_ACTION, after: null },
      { action: LOAD_OP_ACTION, after: { key: 'b', step: 'sales', ids: {} } },
      { action: LOAD_REVERTED_ACTION, after: { key: 'b' } },
      { action: LOAD_OP_ACTION, after: { key: 'b', step: 'sales', ids: { quotationId: 'q' } } },
    ]);
    const m = await readManifest(db as never, BATCH);
    expect(m.start).toEqual({ fileName: '', sha256: '' });
    expect(m.reverted.size).toBe(0);
    expect(m.done.get('b')).toEqual({ step: 'sales', ids: { quotationId: 'q' } });
  });
});

describe('BackdatedLoadRunner: start y execute (cc64)', () => {
  it('start anota el inicio del lote con el archivo, su huella y cuántas operaciones trae', async () => {
    const { deps, runner } = setup();
    await runner.start('plan.xlsx', 'huella', 7);
    expect(deps.audit.log).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      action: LOAD_START_ACTION,
      entity: LOAD_ENTITY,
      entityId: BATCH,
      after: { fileName: 'plan.xlsx', sha256: 'huella', ops: 7 },
    });
  });

  it('un lote ya revertido no se vuelve a cargar (R-07)', async () => {
    const { deps, runner } = setup();
    const manifest = emptyManifest();
    manifest.reverted.add('x');
    const r = await runner.execute([orderOp()], manifest);
    expect(r).toEqual({
      executed: [],
      skipped: [],
      failure: {
        key: '',
        step: 'purchases',
        rows: [],
        message: 'este lote ya se revirtió: carga el plan con otro --lote',
      },
      ms: 0,
    });
    expect(deps.audit.log).not.toHaveBeenCalled();
  });

  it('salta lo hecho, anota la intención solo la primera vez y la operación al terminar', async () => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue({ id: ids.quotation, status: 'APPROVED' });
    db.salesOrder.findFirst.mockResolvedValue(null);
    const manifest = emptyManifest();
    manifest.done.set('venta|F964-123', { step: 'sales', ids: { quotationId: ids.quotation } });
    const r = await runner.execute([saleOp(), orderOp()], manifest);
    expect(r.failure).toBeNull();
    expect(r.skipped).toEqual(['venta|F964-123']);
    expect(r.executed).toEqual(['pedido|F964-123']);
    expect(deps.audit.log.mock.calls.map(([e]) => (e as { action: string }).action)).toEqual([
      LOAD_STARTED_ACTION,
      LOAD_OP_ACTION,
    ]);
    expect(deps.audit.log).toHaveBeenNthCalledWith(1, {
      actorId: ACTOR.id,
      action: LOAD_STARTED_ACTION,
      entity: LOAD_ENTITY,
      entityId: BATCH,
      after: { key: 'pedido|F964-123', step: 'orders' },
    });
    expect(recorded(deps)).toEqual([
      { key: 'pedido|F964-123', step: 'orders', ids: { orderId: ids.order, adopted: false } },
    ]);
    expect(manifest.started.has('pedido|F964-123')).toBe(true);
  });

  it.each([
    ['HttpException con varios mensajes', new BadRequestException(['uno', 'dos']), 'uno · dos'],
    ['HttpException con un mensaje', new BadRequestException('sin stock'), 'sin stock'],
    ['HttpException con cuerpo de texto', new HttpException('texto plano', 409), 'texto plano'],
    [
      'HttpException con objeto sin mensaje',
      new HttpException({ error: 'x' }, 400),
      'Http Exception',
    ],
    ['Error', new Error('falló'), 'falló'],
    ['un valor cualquiera', 'cadena lanzada', 'cadena lanzada'],
  ])('para en la primera falla y dice cuál y por qué: %s', async (_label, thrown, message) => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue({ id: ids.quotation, status: 'APPROVED' });
    db.salesOrder.findFirst.mockResolvedValue(null);
    deps.salesOrders.confirm.mockRejectedValue(thrown);
    const next = dispatchOp();
    const r = await runner.execute([orderOp(), next], emptyManifest());
    expect(r.failure).toEqual({
      key: 'pedido|F964-123',
      step: 'orders',
      rows: [{ sheet: 'Ventas', row: 2 }],
      message,
    });
    expect(r.executed).toEqual([]);
    expect(recorded(deps)).toEqual([]);
    expect(deps.dispatches.create).not.toHaveBeenCalled();
  });
});

describe('BackdatedLoadRunner: compras (cc64)', () => {
  it('importa la compra con su clave, la busca por proveedor, serie y número y la recibe en su fecha', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ids.purchase, status: 'DRAFT' });
    const op = purchaseOp();
    const { result, ids: out } = await runOne(runner, op);
    expect(result.failure).toBeNull();
    expect(db.purchase.findFirst).toHaveBeenCalledWith({
      where: {
        supplier: { docNumber: '20100000001' },
        series: 'F001',
        number: '1234',
        status: { not: 'CANCELLED' },
      },
      select: { id: true, status: true, currency: true, exchangeRate: true },
    });
    const [actor, input] = deps.purchaseImport.confirm.mock.calls[0] as [
      RequestUser,
      { documents: unknown[]; fileName: string; idempotencyKey: string },
    ];
    expect(actor).toBe(ACTOR);
    expect(input.fileName).toBe(`carga ${BATCH}`);
    expect(input.idempotencyKey).toBe(keyOf(op));
    expect(input.documents).toHaveLength(1);
    expect(deps.purchases.receive).toHaveBeenCalledWith(ACTOR, ids.purchase, {
      operationDate: '2026-09-06',
      confirmBackdate: true,
    });
    expect(out).toEqual({ purchaseId: ids.purchase, adopted: false });
  });

  it('una compra que ya existía (y ya recibida) se adopta sin importar ni recibir', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue({ id: ids.purchase, status: 'RECEIVED' });
    const { ids: out } = await runOne(runner, purchaseOp());
    expect(out).toEqual({ purchaseId: ids.purchase, adopted: true });
    expect(deps.purchaseImport.confirm).not.toHaveBeenCalled();
    expect(deps.purchases.receive).not.toHaveBeenCalled();
  });

  it('al reanudar una compra intentada por este lote, lo que existe no es «adoptado» (R-02)', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue({ id: ids.purchase, status: 'DRAFT' });
    const manifest = emptyManifest();
    const op = purchaseOp();
    manifest.started.add(op.key);
    const { ids: out } = await runOne(runner, op, manifest);
    expect(out).toEqual({ purchaseId: ids.purchase, adopted: false });
    // Ya estaba intentada: no se vuelve a anotar la intención.
    expect(
      deps.audit.log.mock.calls.filter(
        ([e]) => (e as { action: string }).action === LOAD_STARTED_ACTION,
      ),
    ).toEqual([]);
    expect(deps.purchases.receive).toHaveBeenCalled();
  });

  it('un comprobante sin guion se busca sin serie; si la importación no lo deja, falla', async () => {
    const { db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue(null);
    const { result } = await runOne(runner, purchaseOp({ document: '000777' }));
    expect(db.purchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ series: '', number: '777' }) }),
    );
    expect(result.failure?.message).toBe('la compra 000777 no quedó registrada');
  });
});

describe('BackdatedLoadRunner: ventas (cc64)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    rowNumber: 1,
    documentKey: 'F964-123',
    issueDate: '2026-09-10',
    customerId: ids.customer,
    padron: null,
    rawCustomer: '20100000002 - Cliente',
    rawSku: 'T-CC64',
    rawProductName: '',
    productId: ids.product,
    qty: '5',
    unitPricePen: '50',
    netAmountPen: null,
    igvAmountPen: null,
    totalAmountPen: null,
    needsPieces: false,
    pieces: null,
    coilLine: false,
    saleCoilId: null,
    issues: [],
    excludedReason: null,
    ...over,
  });

  it('una cotización ya importada se adopta', async () => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue({ id: ids.quotation, status: 'APPROVED' });
    const { ids: out } = await runOne(runner, saleOp());
    expect(out).toEqual({ quotationId: ids.quotation, adopted: true });
    expect(db.quotation.findFirst).toHaveBeenCalledWith({
      where: {
        status: { not: 'CANCELLED' },
        OR: [
          { notes: 'Factura externa: F964-123' },
          { notes: { startsWith: 'Factura externa: F964-123\n' } },
        ],
      },
      select: { id: true, status: true },
    });
    expect(deps.quotationImport.preview).not.toHaveBeenCalled();
  });

  it('arma un Excel con las filas de la venta y confirma las filas del preview como la pantalla', async () => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: ids.quotation, status: 'APPROVED' });
    const raws = [
      { 'CÓDIGO PRODUCTO': 'T-CC64', CANTIDAD: '5' },
      { 'CÓDIGO PRODUCTO': 'COB-1', CANTIDAD: '9', LARGOS: '4,5x1; 1.5 x 3' },
      { 'CÓDIGO PRODUCTO': 'BOB', CANTIDAD: '100' },
      { 'CÓDIGO PRODUCTO': 'NC' },
    ];
    deps.quotationImport.preview.mockResolvedValue({
      rows: [
        row({
          rowNumber: 1,
          netAmountPen: '250.00',
          igvAmountPen: '45.00',
          totalAmountPen: '295.00',
          rawProductName: 'Producto cc64',
          issues: [{ field: 'qty', severity: 'warning', message: 'solo aviso' }],
        }),
        row({
          rowNumber: 2,
          customerId: null,
          padron: { docType: 'RUC', docNumber: '20100000002', name: 'X', address: null },
          rawSku: 'COB-1',
          qty: '9',
          needsPieces: true,
          netAmountPen: '90.00',
        }),
        row({ rowNumber: 3, coilLine: true, saleCoilId: ids.saleCoil, qty: '100' }),
        row({ rowNumber: 4, excludedReason: 'nota de crédito' }),
      ],
    });
    const { result, ids: out } = await runOne(runner, saleOp(raws));
    expect(result.failure).toBeNull();
    const [fileName, buffer] = deps.quotationImport.preview.mock.calls[0] as [string, Buffer];
    expect(fileName).toBe('carga-F964-123.xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    expect(book.SheetNames).toEqual(['Ventas']);
    const sheet = book.Sheets.Ventas;
    expect(sheet && XLSX.utils.sheet_to_json(sheet, { defval: '' })).toHaveLength(4);
    const [actor, input] = deps.quotationImport.confirm.mock.calls[0] as [
      RequestUser,
      { rows: Record<string, unknown>[] },
    ];
    expect(actor).toBe(ACTOR);
    expect(input.rows).toEqual([
      {
        rowNumber: 1,
        documentKey: 'F964-123',
        issueDate: '2026-09-10',
        customerId: ids.customer,
        productId: ids.product,
        // El schema normaliza las escalas (kg 3, dinero 4).
        qty: '5.000',
        unitPricePen: '50.0000',
        netAmountPen: '250.0000',
        igvAmountPen: '45.0000',
        totalAmountPen: '295.0000',
        description: 'Producto cc64',
      },
      {
        rowNumber: 2,
        documentKey: 'F964-123',
        issueDate: '2026-09-10',
        customerId: null,
        newCustomer: { docType: 'RUC', docNumber: '20100000002' },
        productId: ids.product,
        qty: '9.000',
        unitPricePen: '50.0000',
        netAmountPen: '90.0000',
        pieces: [
          { lengthMm: '4500.00', qty: 1 },
          { lengthMm: '1500.00', qty: 3 },
        ],
      },
      {
        rowNumber: 3,
        documentKey: 'F964-123',
        issueDate: '2026-09-10',
        customerId: ids.customer,
        productId: ids.product,
        qty: '100.000',
        unitPricePen: '50.0000',
        saleCoilId: ids.saleCoil,
      },
    ]);
    expect(out).toEqual({ quotationId: ids.quotation, adopted: false });
  });

  it.each([
    [
      'errores del preview',
      [
        row({ issues: [{ field: 'qty', severity: 'error', message: 'cantidad vacía' }] }),
        row({ issues: [{ field: 'row', severity: 'error', message: 'otra' }] }),
      ],
      'cantidad vacía · otra',
    ],
    [
      'ninguna línea que importar',
      [row({ excludedReason: 'nota' })],
      'F964-123 no tiene líneas que importar',
    ],
    [
      'un cliente que no está en el maestro ni en el padrón',
      [row({ customerId: null })],
      'F964-123: el cliente «20100000002 - Cliente» no está en el maestro ni en el padrón',
    ],
    [
      'una línea a medida sin LARGOS',
      [row({ needsPieces: true })],
      'F964-123: la línea a medida T-CC64 no trae LARGOS válidos',
    ],
    [
      'una línea a medida sin su fila cruda',
      [row({ rowNumber: 9, needsPieces: true })],
      'F964-123: la línea a medida T-CC64 no trae LARGOS válidos',
    ],
    [
      'LARGOS que no suman la cantidad',
      [row({ rowNumber: 2, needsPieces: true })],
      'F964-123: LARGOS de T-CC64 no suman la cantidad',
    ],
  ])('rechaza la venta: %s', async (_label, rows, message) => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue(null);
    deps.quotationImport.preview.mockResolvedValue({ rows });
    const raws = [{ 'CÓDIGO PRODUCTO': 'T-CC64' }, { LARGOS: '2x1' }];
    const { result } = await runOne(runner, saleOp(raws));
    expect(result.failure?.message).toBe(message);
    expect(deps.quotationImport.confirm).not.toHaveBeenCalled();
  });

  it('si la cotización no quedó registrada, falla', async () => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue(null);
    deps.quotationImport.preview.mockResolvedValue({ rows: [row()] });
    const { result } = await runOne(runner, saleOp());
    expect(deps.quotationImport.confirm).toHaveBeenCalled();
    expect(result.failure?.message).toBe('la cotización de F964-123 no quedó registrada');
  });
});

describe('BackdatedLoadRunner: pedidos (cc64)', () => {
  it('confirma el pedido de la cotización importada', async () => {
    const { deps, db, runner } = setup();
    db.quotation.findFirst.mockResolvedValue({ id: ids.quotation, status: 'APPROVED' });
    db.salesOrder.findFirst.mockResolvedValue(null);
    const { ids: out } = await runOne(runner, orderOp());
    expect(db.salesOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { quotationId: ids.quotation, status: { not: 'CANCELLED' } },
      }),
    );
    expect(deps.salesOrders.confirm).toHaveBeenCalledWith(ACTOR, ids.quotation, {});
    expect(out).toEqual({ orderId: ids.order, adopted: false });
  });

  it('un pedido que ya existía se adopta; sin cotización importada, falla', async () => {
    const a = setup();
    a.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    a.db.salesOrder.findFirst.mockResolvedValue(orderRow());
    expect((await runOne(a.runner, orderOp())).ids).toEqual({ orderId: ids.order, adopted: true });
    expect(a.deps.salesOrders.confirm).not.toHaveBeenCalled();

    const b = setup();
    b.db.quotation.findFirst.mockResolvedValue(null);
    const { result } = await runOne(b.runner, orderOp());
    expect(result.failure?.message).toBe('F964-123: no hay cotización importada');
  });
});

describe('BackdatedLoadRunner: producción (cc64)', () => {
  /** La OP como la lee el cargador. */
  const po = (over: Record<string, unknown> = {}) => ({
    id: ids.po,
    status: 'IN_PROGRESS',
    product: { unit: 'MTR', roofingKind: 'ACCESORIO', lengthMm: null },
    items: [],
    reports: [],
    consumptions: [],
    ...over,
  });

  function production(
    poRow: Record<string, unknown> | null,
    lines = [{ id: ids.item1, qty: '10', sku: 'COB-1' }],
  ) {
    const s = setup();
    s.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    s.db.salesOrder.findFirst.mockResolvedValue(orderRow(lines));
    s.db.productionOrder.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(poRow);
    s.db.productionReport.findFirst.mockResolvedValue({ id: ids.report });
    return s;
  }

  it('accesorio: reporta metros de bobina, en su fecha y con su clave, sin cerrar', async () => {
    const { deps, db, runner } = production(po());
    const op = productionOp();
    const { result, ids: out } = await runOne(runner, op);
    expect(result.failure).toBeNull();
    expect(db.productionOrder.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { reservation: { salesOrderItemId: ids.item1 }, status: { not: 'CANCELLED' } },
      }),
    );
    expect(deps.roofing.report).toHaveBeenCalledWith(ACTOR, ids.po, {
      meters: '4.000',
      operationDate: '2026-09-11',
      confirmBackdate: true,
      idempotencyKey: keyOf(op),
    });
    expect(deps.roofing.reportAndClose).not.toHaveBeenCalled();
    expect(deps.roofing.mountCoil).not.toHaveBeenCalled();
    expect(db.productionReport.findFirst).toHaveBeenCalledWith({
      where: { productionOrderId: ids.po, status: 'ACTIVE' },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    expect(out).toEqual({
      productionOrderId: ids.po,
      reportId: ids.report,
      closed: false,
      orderOwned: false,
    });
  });

  it('largo fijo: planchas del largo del SKU; monta la bobina por código externo y cierra la OP', async () => {
    const { deps, db, runner } = production(
      po({
        product: { unit: 'NIU', roofingKind: 'ESTANDAR', lengthMm: new Decimal('3600') },
        items: [{ lineNumber: 1, lengthMm: new Decimal('3600'), qty: 10 }],
        reports: [
          { metersM: null, pieces: 5, piecesDetail: [{ lengthMm: new Decimal('3600'), qty: 5 }] },
        ],
      }),
    );
    db.coil.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ids.coil });
    const op = productionOp({ qty: '5', coil: 'EXT-9', coilKg: '12,5' });
    const { result, ids: out } = await runOne(runner, op);
    expect(result.failure).toBeNull();
    expect(db.coil.findFirst).toHaveBeenNthCalledWith(1, {
      where: { status: { not: 'CANCELLED' }, code: 'EXT-9' },
      select: { id: true },
    });
    expect(db.coil.findFirst).toHaveBeenNthCalledWith(2, {
      where: { status: { not: 'CANCELLED' }, externalCode: 'EXT-9' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(deps.roofing.mountCoil).toHaveBeenCalledWith(ACTOR, ids.po, { coilId: ids.coil });
    expect(deps.roofing.reportAndClose).toHaveBeenCalledWith(ACTOR, ids.po, {
      pieces: [{ lengthMm: '3600.00', qty: 5 }],
      coilId: ids.coil,
      consumedKg: '12.500',
      operationDate: '2026-09-11',
      confirmBackdate: true,
      idempotencyKey: keyOf(op),
    });
    expect(deps.roofing.report).not.toHaveBeenCalled();
    expect(out).toMatchObject({ closed: true, reportId: ids.report });
  });

  it('largo fijo sin líneas de plan: la cantidad del pedido son planchas, no metros', async () => {
    const { deps, runner } = production(
      po({ product: { unit: 'NIU', roofingKind: 'ESTANDAR', lengthMm: new Decimal('3600') } }),
    );
    // 5 planchas de 3,6 m son 18 m de un plan de 10 planchas (36 m): la OP sigue abierta.
    const { result } = await runOne(runner, productionOp({ qty: '5', coil: '' }));
    expect(result.failure).toBeNull();
    expect(deps.roofing.report).toHaveBeenCalled();
    expect(deps.roofing.reportAndClose).not.toHaveBeenCalled();

    // Las 10 planchas del pedido sí completan el plan y cierran la OP.
    const all = production(
      po({ product: { unit: 'NIU', roofingKind: 'ESTANDAR', lengthMm: new Decimal('3600') } }),
    );
    const done = await runOne(all.runner, productionOp({ qty: '10', coil: '' }));
    expect(done.result.failure).toBeNull();
    expect(all.deps.roofing.reportAndClose).toHaveBeenCalled();
  });

  it('a medida: toma del plan los largos que quedan; la bobina ya montada no se vuelve a montar', async () => {
    const { deps, db, runner } = production(
      po({
        product: { unit: 'MTR', roofingKind: 'A_MEDIDA', lengthMm: null },
        items: [
          { lineNumber: 1, lengthMm: new Decimal('4500'), qty: 2 },
          { lineNumber: 2, lengthMm: new Decimal('3000'), qty: 2 },
        ],
        reports: [
          {
            metersM: new Decimal('4.5'),
            pieces: 1,
            piecesDetail: [{ lengthMm: new Decimal('4500'), qty: 1 }],
          },
        ],
        consumptions: [{ coilId: ids.coil }],
      }),
    );
    db.coil.findFirst.mockResolvedValueOnce({ id: ids.coil });
    const { ids: out } = await runOne(runner, productionOp({ qty: '6', coil: 'BOB-1' }));
    expect(db.coil.findFirst).toHaveBeenCalledTimes(1);
    expect(deps.roofing.mountCoil).not.toHaveBeenCalled();
    expect(deps.roofing.report).toHaveBeenCalledWith(
      ACTOR,
      ids.po,
      expect.objectContaining({ pieces: [{ lengthMm: '3000.00', qty: 2 }], coilId: ids.coil }),
    );
    expect(out).toMatchObject({ closed: false });
  });

  it('con dos líneas del mismo SKU, reporta contra la que tiene la OP abierta', async () => {
    const s = setup();
    s.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    s.db.salesOrder.findFirst.mockResolvedValue(
      orderRow([
        { id: ids.item1, qty: '10', sku: 'COB-1' },
        { id: ids.item2, qty: '10', sku: 'COB-1' },
      ]),
    );
    s.db.productionOrder.findFirst
      .mockResolvedValueOnce({ reservation: { salesOrderItemId: ids.item2 } })
      .mockResolvedValueOnce(po());
    s.db.productionReport.findFirst.mockResolvedValue({ id: ids.report });
    await runOne(s.runner, productionOp());
    expect(s.db.productionOrder.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          reservation: { salesOrderItemId: { in: [ids.item1, ids.item2] } },
          status: { notIn: ['CANCELLED', 'CLOSED'] },
        },
      }),
    );
    expect(s.db.productionOrder.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { reservation: { salesOrderItemId: ids.item2 }, status: { not: 'CANCELLED' } },
      }),
    );
  });

  it('el pedido que creó el lote queda marcado como propio (R-04)', async () => {
    const { runner } = production(po());
    const manifest = emptyManifest();
    manifest.done.set('pedido|F964-123', {
      step: 'orders',
      ids: { orderId: ids.order, adopted: false },
    });
    manifest.done.set('pedido|OTRO', { step: 'orders', ids: { orderId: uuid(77), adopted: true } });
    const { ids: out } = await runOne(runner, productionOp(), manifest);
    expect(out).toMatchObject({ orderOwned: true });
  });

  it('el pedido confirmado en la misma corrida también es propio', async () => {
    const s = setup();
    s.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    s.db.salesOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(orderRow([{ id: ids.item1, qty: '10', sku: 'COB-1' }]));
    s.db.productionOrder.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(po());
    s.db.productionReport.findFirst.mockResolvedValue({ id: ids.report });
    const manifest = emptyManifest();
    const r = await s.runner.execute([orderOp(), productionOp()], manifest);
    expect(r.failure).toBeNull();
    expect(manifest.done.get(productionOp().key)?.ids).toMatchObject({ orderOwned: true });
  });

  describe('al reanudar (R-03)', () => {
    const resumed = () => {
      const m = emptyManifest();
      m.started.add(productionOp().key);
      return m;
    };

    it('un parte ya hecho se reconoce por su clave de idempotencia y no se repite', async () => {
      const { deps, db, runner } = production(po({ status: 'CLOSED' }));
      db.idempotencyKey.findUnique.mockResolvedValue({ key: 'x' });
      const op = productionOp();
      const { ids: out } = await runOne(runner, op, resumed());
      expect(db.idempotencyKey.findUnique).toHaveBeenCalledWith({ where: { key: keyOf(op) } });
      expect(deps.roofing.report).not.toHaveBeenCalled();
      expect(deps.roofing.reportAndClose).not.toHaveBeenCalled();
      expect(out).toEqual({
        productionOrderId: ids.po,
        reportId: ids.report,
        closed: true,
        orderOwned: false,
      });
    });

    it('la clave está pero el parte no aparece: falla', async () => {
      const { db, runner } = production(po());
      db.idempotencyKey.findUnique.mockResolvedValue({ key: 'x' });
      db.productionReport.findFirst.mockResolvedValue(null);
      const { result } = await runOne(runner, productionOp(), resumed());
      expect(result.failure?.message).toBe('F964-123: el parte ya se hizo, pero no se encuentra');
    });

    it('sin la clave, el parte se hace', async () => {
      const { deps, db, runner } = production(po());
      db.idempotencyKey.findUnique.mockResolvedValue(null);
      await runOne(runner, productionOp(), resumed());
      expect(deps.roofing.report).toHaveBeenCalled();
    });
  });

  it('el plan sin líneas se mide con la cantidad de la línea del pedido', async () => {
    const { deps, runner } = production(po(), [{ id: ids.item1, qty: '4', sku: 'COB-1' }]);
    await runOne(runner, productionOp({ qty: '4' }));
    expect(deps.roofing.reportAndClose).toHaveBeenCalled();
  });

  it.each([
    ['sin pedido', 'no-order', 'F964-123: el pedido no está confirmado'],
    ['el pedido no vende el SKU', 'no-sku', 'F964-123: el pedido no vende COB-1'],
    ['sin OP', 'no-po', 'F964-123: el pedido no tiene OP para COB-1'],
    ['cantidad ilegible', 'bad-qty', 'F964-123: cantidad inválido: «abc»'],
    ['cantidad cero', 'zero-qty', 'F964-123: cantidad inválido: «0»'],
    ['bobina que no existe', 'no-coil', 'la bobina BOB-X no existe'],
    ['KG ilegibles', 'bad-kg', 'F964-123: KG CONSUMIDOS inválido: «x»'],
    ['el parte no quedó', 'no-report', 'F964-123: el parte no quedó registrado'],
    [
      'largos que no son piezas enteras del plan',
      'not-whole',
      'F964-123: 1.000 m de COB-1 no son piezas enteras de lo que queda del plan',
    ],
  ])('falla: %s', async (_label, kind, message) => {
    const medida = po({
      product: { unit: 'MTR', roofingKind: 'A_MEDIDA', lengthMm: null },
      items: [{ lineNumber: 1, lengthMm: new Decimal('3000'), qty: 2 }],
    });
    const s = production(kind === 'no-po' ? null : kind === 'not-whole' ? medida : po());
    if (kind === 'no-order') s.db.salesOrder.findFirst.mockResolvedValue(null);
    if (kind === 'no-sku') {
      s.db.salesOrder.findFirst.mockResolvedValue(
        orderRow([{ id: ids.item1, qty: '1', sku: 'X' }]),
      );
    }
    if (kind === 'no-coil') s.db.coil.findFirst.mockResolvedValue(null);
    if (kind === 'no-report') s.db.productionReport.findFirst.mockResolvedValue(null);
    const op = productionOp({
      qty:
        kind === 'bad-qty' ? 'abc' : kind === 'zero-qty' ? '0' : kind === 'not-whole' ? '1' : '4',
      coil: kind === 'no-coil' ? 'BOB-X' : '',
      coilKg: kind === 'bad-kg' ? 'x' : '',
    });
    const { result } = await runOne(s.runner, op);
    expect(result.failure).toMatchObject({ key: op.key, step: 'production', message });
  });
});

describe('BackdatedLoadRunner: despachos (cc64)', () => {
  function dispatchSetup() {
    const s = setup();
    s.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    s.db.salesOrder.findFirst.mockResolvedValue(
      orderRow([
        { id: ids.item1, qty: '3', sku: 'T-CC64', dispatched: ['1'] },
        { id: ids.item2, qty: '10', sku: 'T-CC64' },
      ]),
    );
    return s;
  }

  it('recojo: reparte lo despachado entre las líneas por lo que les falta y despacha desde el mostrador', async () => {
    const { deps, runner } = dispatchSetup();
    const op = dispatchOp({
      items: [
        { sku: 'T-CC64', qty: '3' },
        { sku: 'T-CC64', qty: '1,5' },
      ],
    });
    const { ids: out } = await runOne(runner, op);
    expect(deps.dispatches.create).toHaveBeenCalledWith(ACTOR, {
      salesOrderId: ids.order,
      dispatchDate: '2026-09-12',
      confirmBackdate: true,
      originAddress: LOAD_PICKUP.address,
      originUbigeo: LOAD_PICKUP.ubigeo,
      destinationAddress: LOAD_PICKUP.address,
      destinationUbigeo: LOAD_PICKUP.ubigeo,
      transferMode: 'PICKUP',
      notes: `Carga atrasada ${BATCH}`,
      items: [
        { salesOrderItemId: ids.item1, qty: '2.000' },
        { salesOrderItemId: ids.item2, qty: '2.500' },
      ],
      idempotencyKey: keyOf(op),
    });
    expect(out).toEqual({ dispatchId: ids.dispatch });
  });

  it('entrega: el destino real, sin datos de transporte (D-707)', async () => {
    const { deps, runner } = dispatchSetup();
    await runOne(
      runner,
      dispatchOp({ mode: 'DELIVERY', destination: 'Av. Industrial 123', ubigeo: '150103' }),
    );
    expect(deps.dispatches.create).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        destinationAddress: 'Av. Industrial 123',
        destinationUbigeo: '150103',
        transferMode: 'PICKUP',
        notes: `Carga atrasada ${BATCH} · entrega (guía del otro sistema)`,
      }),
    );
  });

  it('falla sin pedido confirmado o con una cantidad ilegible', async () => {
    const a = setup();
    a.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    a.db.salesOrder.findFirst.mockResolvedValue(null);
    expect((await runOne(a.runner, dispatchOp())).result.failure?.message).toBe(
      'F964-123: el pedido no está confirmado',
    );
    const b = dispatchSetup();
    const { result } = await runOne(b.runner, dispatchOp({ items: [{ sku: 'T-CC64', qty: '' }] }));
    expect(result.failure?.message).toBe('F964-123: cantidad inválido: «»');
  });
});

describe('BackdatedLoadRunner: comprobantes (cc64)', () => {
  function invoiceSetup(creditDays = 30) {
    const s = setup();
    s.db.fiscalDocument.findFirst.mockResolvedValue(null);
    s.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    s.db.salesOrder.findFirst.mockResolvedValue(
      orderRow([
        { id: ids.item1, qty: '5', sku: 'T-CC64' },
        { id: ids.item2, qty: '2', sku: 'B' },
      ]),
    );
    s.db.customer.findUniqueOrThrow.mockResolvedValue({ creditDays });
    s.db.dispatch.findMany.mockResolvedValue([]);
    return s;
  }

  it('crédito por el plazo del cliente, con su vencimiento y el despacho único que lleva todo', async () => {
    const { deps, db, runner } = invoiceSetup(30);
    db.dispatch.findMany.mockResolvedValue([
      {
        id: ids.dispatch,
        items: [
          { salesOrderItemId: ids.item1, qty: new Decimal('3') },
          { salesOrderItemId: ids.item1, qty: new Decimal('2') },
          { salesOrderItemId: ids.item2, qty: new Decimal('2') },
        ],
      },
    ]);
    const op = invoiceOp();
    const { ids: out } = await runOne(runner, op);
    expect(db.fiscalDocument.findFirst).toHaveBeenCalledWith({
      where: { number: 'F964-00000123', archivedAt: null },
      select: { id: true, status: true, salesOrderId: true },
    });
    expect(db.customer.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: ids.customer },
      select: { creditDays: true },
    });
    expect(db.dispatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { salesOrderId: ids.order, reversedAt: null, invoiceId: null },
      }),
    );
    expect(deps.invoicing.create).toHaveBeenCalledWith(ACTOR, {
      docType: 'FACTURA',
      customerId: ids.customer,
      salesOrderId: ids.order,
      issueDate: '2026-09-10',
      paymentTerms: 'CREDITO',
      dueDate: '2026-10-10',
      dispatchId: ids.dispatch,
      forceGenericCustomer: false,
      items: [
        { salesOrderItemId: ids.item1, qty: '5.000' },
        { salesOrderItemId: ids.item2, qty: '2.000' },
      ],
      idempotencyKey: keyOf(op),
    });
    expect(deps.invoicing.registerManual).toHaveBeenCalledWith(ACTOR, ids.draft, {
      series: 'F964',
      correlative: 123,
    });
    expect(out).toEqual({ invoiceId: ids.invoice, adopted: false });
  });

  it('contado: sin vencimiento; un despacho parcial o varios despachos no se enlazan', async () => {
    const partial = invoiceSetup(0);
    partial.db.dispatch.findMany.mockResolvedValue([
      { id: ids.dispatch, items: [{ salesOrderItemId: ids.item1, qty: new Decimal('5') }] },
    ]);
    await runOne(partial.runner, invoiceOp({ docType: 'BOLETA' }));
    const [, input] = partial.deps.invoicing.create.mock.calls[0] as [unknown, object];
    expect(input).toMatchObject({ docType: 'BOLETA', paymentTerms: 'CONTADO' });
    expect(input).not.toHaveProperty('dueDate');
    expect(input).not.toHaveProperty('dispatchId');

    const two = invoiceSetup(30);
    two.db.dispatch.findMany.mockResolvedValue([
      { id: ids.dispatch, items: [] },
      { id: uuid(55), items: [] },
    ]);
    await runOne(two.runner, invoiceOp({ paymentTerms: 'CONTADO' }));
    const [, input2] = two.deps.invoicing.create.mock.calls[0] as [unknown, object];
    expect(input2).toMatchObject({ paymentTerms: 'CONTADO' });
    expect(input2).not.toHaveProperty('dispatchId');
    expect(input2).not.toHaveProperty('dueDate');
  });

  it('un comprobante aceptado del mismo pedido se adopta; de otro pedido, se rechaza', async () => {
    const mine = setup();
    mine.db.fiscalDocument.findFirst.mockResolvedValue({
      id: ids.invoice,
      status: 'ACCEPTED',
      salesOrderId: ids.order,
    });
    mine.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    mine.db.salesOrder.findFirst.mockResolvedValue(orderRow());
    expect((await runOne(mine.runner, invoiceOp())).ids).toEqual({
      invoiceId: ids.invoice,
      adopted: true,
    });
    expect(mine.deps.invoicing.create).not.toHaveBeenCalled();

    const other = setup();
    other.db.fiscalDocument.findFirst.mockResolvedValue({
      id: ids.invoice,
      status: 'ACCEPTED',
      salesOrderId: uuid(99),
    });
    other.db.quotation.findFirst.mockResolvedValue({ id: ids.quotation });
    other.db.salesOrder.findFirst.mockResolvedValue(null);
    expect((await runOne(other.runner, invoiceOp())).result.failure?.message).toBe(
      'F964-00000123 ya está registrado y no es del pedido de esta venta',
    );
  });

  it.each([
    ['un comprobante anulado', 'annulled', 'F964-00000123 existe con estado ANNULLED'],
    ['sin guion', 'F964123', 'F964123: la serie y el número no se entienden (SERIE-NÚMERO)'],
    ['correlativo cero', 'F964-0', 'F964-0: la serie y el número no se entienden (SERIE-NÚMERO)'],
    ['correlativo con letras', 'F964-1A', 'F964-1A: la serie y el número no se entienden'],
    ['sin pedido confirmado', 'no-order', 'F964-123: el pedido no está confirmado'],
  ])('rechaza: %s', async (_label, kind, message) => {
    const s = invoiceSetup();
    if (kind === 'annulled') {
      s.db.fiscalDocument.findFirst.mockResolvedValue({ id: ids.invoice, status: 'ANNULLED' });
    }
    if (kind === 'no-order') s.db.salesOrder.findFirst.mockResolvedValue(null);
    const document = kind.startsWith('F964') ? kind : 'F964-123';
    const { result } = await runOne(s.runner, invoiceOp({ document }));
    expect(result.failure?.message).toContain(message);
    expect(s.deps.invoicing.create).not.toHaveBeenCalled();
  });
});

describe('BackdatedLoadRunner: cobros (cc64)', () => {
  it('registra el cobro con el monto del Excel, el medio, la referencia del lote y su clave', async () => {
    const { deps, db, runner } = setup();
    db.fiscalDocument.findFirst.mockResolvedValue({ id: ids.invoice });
    db.idempotencyKey.findUnique.mockResolvedValue({ resourceId: ids.payment });
    const op = collectionOp();
    const { ids: out } = await runOne(runner, op);
    expect(db.fiscalDocument.findFirst).toHaveBeenCalledWith({
      where: { number: 'F964-00000123', archivedAt: null, status: 'ACCEPTED' },
      select: { id: true },
    });
    expect(deps.receivables.addPayment).toHaveBeenCalledWith(ACTOR, ids.invoice, {
      date: '2026-09-15',
      amountPen: '1234.5000',
      method: 'TRANSFER',
      reference: loadReference(BATCH, ' op 77 ', 120),
      idempotencyKey: keyOf(op),
    });
    expect(loadReference(BATCH, ' op 77 ', 120)).toBe('CA lote-cc64 · op 77');
    expect(db.idempotencyKey.findUnique).toHaveBeenCalledWith({ where: { key: keyOf(op) } });
    expect(out).toEqual({ invoiceId: ids.invoice, paymentId: ids.payment });
  });

  it('un medio desconocido va como OTHER; sin la clave anotada, el pago queda sin id', async () => {
    const { deps, db, runner } = setup();
    db.fiscalDocument.findFirst.mockResolvedValue({ id: ids.invoice });
    db.idempotencyKey.findUnique.mockResolvedValue(null);
    const { ids: out } = await runOne(runner, collectionOp({ method: 'trueque', reference: '' }));
    expect(deps.receivables.addPayment).toHaveBeenCalledWith(
      ACTOR,
      ids.invoice,
      expect.objectContaining({ method: 'OTHER', reference: 'CA lote-cc64' }),
    );
    expect(out).toEqual({ invoiceId: ids.invoice, paymentId: null });
  });

  it('sin el comprobante registrado, falla', async () => {
    const { db, runner } = setup();
    db.fiscalDocument.findFirst.mockResolvedValue(null);
    const { result } = await runOne(runner, collectionOp());
    expect(result.failure?.message).toBe('F964-00000123: el comprobante no está registrado');
  });
});

describe('BackdatedLoadRunner: pagos a proveedores (cc64)', () => {
  it('en soles: sin tipo de cambio; la referencia lleva el número del pago (P3-19)', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue({
      id: ids.purchase,
      status: 'RECEIVED',
      currency: 'PEN',
      exchangeRate: new Decimal('1'),
    });
    db.supplierPayment.findFirst.mockResolvedValue({ id: ids.payment });
    const op = supplierPaymentOp();
    const { ids: out } = await runOne(runner, op);
    const reference = loadReference(BATCH, '#2 dep 1', 80);
    expect(reference).toBe('CA lote-cc64 · #2 dep 1');
    expect(deps.purchases.addPayment).toHaveBeenCalledWith(ACTOR, ids.purchase, {
      date: '2026-09-07',
      amount: '236.0000',
      currency: 'PEN',
      method: 'WALLET',
      reference,
      idempotencyKey: keyOf(op),
    });
    expect(db.supplierPayment.findFirst).toHaveBeenCalledWith({
      where: { purchaseId: ids.purchase, reference, reversedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(out).toEqual({ purchaseId: ids.purchase, paymentId: ids.payment });
  });

  it('en dólares: con el tipo de cambio de la compra; sin el pago encontrado, sin id', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue({
      id: ids.purchase,
      status: 'RECEIVED',
      currency: 'USD',
      exchangeRate: new Decimal('3.75'),
    });
    db.supplierPayment.findFirst.mockResolvedValue(null);
    const { ids: out } = await runOne(
      runner,
      supplierPaymentOp({ key: 'pago|20100000001|F001-0001234|1', method: '', reference: '' }),
    );
    expect(deps.purchases.addPayment).toHaveBeenCalledWith(
      ACTOR,
      ids.purchase,
      expect.objectContaining({
        currency: 'USD',
        exchangeRate: '3.7500',
        method: 'OTHER',
        reference: 'CA lote-cc64 · #1',
      }),
    );
    expect(out).toEqual({ purchaseId: ids.purchase, paymentId: null });
  });

  it('sin la compra registrada, falla', async () => {
    const { db, runner } = setup();
    db.purchase.findFirst.mockResolvedValue(null);
    const { result } = await runOne(runner, supplierPaymentOp());
    expect(result.failure?.message).toBe('F001-0001234: la compra no está registrada');
  });
});

describe('BackdatedLoadRunner: revert (cc64, D-706)', () => {
  const manifestOf = (entries: [string, LoadStep, OpIds][]): LoadManifest => {
    const m = emptyManifest();
    for (const [key, step, opIds] of entries) m.done.set(key, { step, ids: opIds });
    return m;
  };

  it('revierte de la última operación a la primera, con el motivo del lote, y anota cada reversa', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findUnique.mockResolvedValue({ status: 'RECEIVED' });
    db.quotation.findUnique.mockResolvedValue({ status: 'APPROVED' });
    db.salesOrder.findUnique.mockResolvedValue({ status: 'CONFIRMED' });
    db.dispatch.findUnique.mockResolvedValue({ reversedAt: null });
    db.fiscalDocument.findUnique.mockResolvedValue({ status: 'ACCEPTED' });
    db.customerPayment.findUnique.mockResolvedValue({ reversedAt: null });
    db.supplierPayment.findUnique.mockResolvedValue(null);
    const manifest = manifestOf([
      ['compra', 'purchases', { purchaseId: ids.purchase, adopted: false }],
      ['venta', 'sales', { quotationId: ids.quotation, adopted: false }],
      ['pedido', 'orders', { orderId: ids.order, adopted: false }],
      ['despacho', 'dispatches', { dispatchId: ids.dispatch }],
      ['comprobante', 'invoices', { invoiceId: ids.invoice, adopted: false }],
      ['cobro', 'collections', { invoiceId: ids.invoice, paymentId: ids.payment }],
      ['pago', 'supplierPayments', { purchaseId: ids.purchase, paymentId: uuid(66) }],
    ]);
    const r = await runner.revert(manifest);
    expect(r.failure).toBeNull();
    expect(r.executed).toEqual([
      'pago',
      'cobro',
      'comprobante',
      'despacho',
      'pedido',
      'venta',
      'compra',
    ]);
    expect(deps.purchases.reversePayment).toHaveBeenCalledWith(ACTOR, ids.purchase, uuid(66), {
      reason: REASON,
    });
    expect(deps.receivables.reversePayment).toHaveBeenCalledWith(
      ACTOR,
      ids.invoice,
      ids.payment,
      REASON,
    );
    expect(deps.fiscalImport.annulExternal).toHaveBeenCalledWith(ACTOR, ids.invoice, REASON);
    expect(deps.dispatches.reverse).toHaveBeenCalledWith(ACTOR, ids.dispatch, { reason: REASON });
    expect(deps.salesOrders.cancel).toHaveBeenCalledWith(ACTOR, ids.order, {
      reason: REASON,
      acknowledgeFabricated: true,
    });
    expect(deps.quotations.cancel).toHaveBeenCalledWith(ACTOR, ids.quotation, REASON);
    expect(deps.purchases.cancel).toHaveBeenCalledWith(ACTOR, ids.purchase, { reason: REASON });
    expect(deps.audit.log).toHaveBeenLastCalledWith({
      actorId: ACTOR.id,
      action: LOAD_REVERTED_ACTION,
      entity: LOAD_ENTITY,
      entityId: BATCH,
      after: { key: 'compra', step: 'purchases' },
    });
    expect(manifest.done.size).toBe(0);
    expect([...manifest.reverted]).toHaveLength(7);
  });

  it('salta lo adoptado y lo que ya estaba revertido o anulado', async () => {
    const { deps, db, runner } = setup();
    db.purchase.findUnique.mockResolvedValue({ status: 'CANCELLED' });
    db.quotation.findUnique.mockResolvedValue({ status: 'CANCELLED' });
    db.salesOrder.findUnique.mockResolvedValue({ status: 'CANCELLED' });
    db.dispatch.findUnique.mockResolvedValue({ reversedAt: new Date() });
    db.fiscalDocument.findUnique.mockResolvedValue({ status: 'ANNULLED' });
    db.customerPayment.findUnique.mockResolvedValue({ reversedAt: new Date() });
    db.supplierPayment.findUnique.mockResolvedValue({ reversedAt: new Date() });
    const manifest = manifestOf([
      ['compra-a', 'purchases', { purchaseId: ids.purchase, adopted: true }],
      ['compra', 'purchases', { purchaseId: ids.purchase, adopted: false }],
      ['venta-a', 'sales', { quotationId: ids.quotation, adopted: true }],
      ['venta', 'sales', { quotationId: ids.quotation }],
      ['pedido-a', 'orders', { orderId: ids.order, adopted: true }],
      ['pedido', 'orders', { orderId: ids.order }],
      ['despacho', 'dispatches', { dispatchId: ids.dispatch }],
      ['comprobante-a', 'invoices', { invoiceId: ids.invoice, adopted: true }],
      ['comprobante', 'invoices', { invoiceId: ids.invoice }],
      ['cobro', 'collections', { invoiceId: ids.invoice, paymentId: ids.payment }],
      ['pago', 'supplierPayments', { purchaseId: ids.purchase, paymentId: ids.payment }],
    ]);
    const r = await runner.revert(manifest);
    expect(r.failure).toBeNull();
    expect(r.executed).toHaveLength(11);
    for (const fn of [
      deps.purchases.cancel,
      deps.quotations.cancel,
      deps.salesOrders.cancel,
      deps.dispatches.reverse,
      deps.fiscalImport.annulExternal,
      deps.receivables.reversePayment,
      deps.purchases.reversePayment,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    // Lo adoptado ni se lee.
    expect(db.purchase.findUnique).toHaveBeenCalledTimes(1);
    expect(db.fiscalDocument.findUnique).toHaveBeenCalledTimes(1);
  });

  it('para en la primera reversa que falla y conserva lo que falta en el manifiesto', async () => {
    const { deps, db, runner } = setup();
    db.customerPayment.findUnique.mockResolvedValue({ reversedAt: null });
    deps.receivables.reversePayment.mockRejectedValue(new BadRequestException('cobro conciliado'));
    const manifest = manifestOf([
      ['venta', 'sales', { quotationId: ids.quotation, adopted: true }],
      ['cobro', 'collections', { invoiceId: ids.invoice, paymentId: ids.payment }],
      ['otro', 'invoices', { invoiceId: ids.invoice, adopted: true }],
    ]);
    const r = await runner.revert(manifest);
    expect(r.executed).toEqual(['otro']);
    expect(r.skipped).toEqual([]);
    expect(r.failure).toEqual({
      key: 'cobro',
      step: 'collections',
      rows: [],
      message: 'cobro conciliado',
    });
    expect([...manifest.done.keys()]).toEqual(['venta', 'cobro']);
  });

  it('un id que falta en el manifiesto detiene la reversa', async () => {
    const { runner } = setup();
    const r = await runner.revert(manifestOf([['pago', 'supplierPayments', { purchaseId: 'p' }]]));
    expect(r.failure?.message).toBe('Pagos a proveedores: falta paymentId en el manifiesto');
  });

  describe('producción (excepción a D-578)', () => {
    function prodSetup(status: string, after: string, live = 0) {
      const s = setup();
      s.db.productionOrder.findUniqueOrThrow
        .mockResolvedValueOnce({ status })
        .mockResolvedValueOnce({ status: after });
      s.db.productionReport.count.mockResolvedValue(live);
      s.db.productionReport.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      return s;
    }
    const prodIds = (over: OpIds = {}): OpIds => ({
      productionOrderId: ids.po,
      reportId: ids.report,
      closed: true,
      orderOwned: true,
      ...over,
    });

    it('reabre la OP que cerró el lote, revierte el parte y, sin partes vivos, anula la OP', async () => {
      const { deps, db, runner } = prodSetup('CLOSED', 'IN_PROGRESS');
      const r = await runner.revert(manifestOf([['parte', 'production', prodIds()]]));
      expect(r.failure).toBeNull();
      expect(deps.roofing.reopen).toHaveBeenCalledWith(ACTOR, ids.po, { reason: REASON });
      expect(db.productionReport.findUnique).toHaveBeenCalledWith({
        where: { id: ids.report },
        select: { status: true },
      });
      expect(deps.roofing.reverseReport).toHaveBeenCalledWith(ACTOR, ids.po, ids.report, {
        reason: REASON,
      });
      expect(db.productionReport.count).toHaveBeenCalledWith({
        where: { productionOrderId: ids.po, status: 'ACTIVE' },
      });
      expect(deps.roofing.cancel).toHaveBeenCalledWith(ACTOR, ids.po, { reason: REASON });
      const order = [
        deps.roofing.reopen.mock.invocationCallOrder[0],
        deps.roofing.reverseReport.mock.invocationCallOrder[0],
        deps.roofing.cancel.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a = 0, b = 0) => a - b));
    });

    it('una OP cerrada que no cerró este lote no se reabre (D-578)', async () => {
      const { deps, runner } = prodSetup('CLOSED', 'CLOSED');
      const r = await runner.revert(
        manifestOf([['parte', 'production', prodIds({ closed: false })]]),
      );
      expect(r.failure?.message).toBe(
        'la OP está cerrada y no la cerró este lote: no se reabre (D-578)',
      );
      expect(deps.roofing.reopen).not.toHaveBeenCalled();
      expect(deps.roofing.reverseReport).not.toHaveBeenCalled();
    });

    it('un parte ya revertido no se toca; con partes vivos la OP sigue', async () => {
      const { deps, db, runner } = prodSetup('IN_PROGRESS', 'IN_PROGRESS', 2);
      db.productionReport.findUnique.mockResolvedValue({ status: 'REVERSED' });
      await runner.revert(manifestOf([['parte', 'production', prodIds()]]));
      expect(deps.roofing.reopen).not.toHaveBeenCalled();
      expect(deps.roofing.reverseReport).not.toHaveBeenCalled();
      expect(deps.roofing.cancel).not.toHaveBeenCalled();
    });

    it('la OP de un pedido que el lote no creó no se anula (R-04)', async () => {
      const { deps, runner } = prodSetup('IN_PROGRESS', 'IN_PROGRESS');
      await runner.revert(manifestOf([['parte', 'production', prodIds({ orderOwned: false })]]));
      expect(deps.roofing.reverseReport).toHaveBeenCalled();
      expect(deps.roofing.cancel).not.toHaveBeenCalled();
    });

    it('sin parte en el manifiesto ni OP viva, no hace nada más que leer', async () => {
      const { deps, db, runner } = prodSetup('CANCELLED', 'CANCELLED');
      const r = await runner.revert(
        manifestOf([['parte', 'production', { productionOrderId: ids.po }]]),
      );
      expect(r.failure).toBeNull();
      expect(db.productionReport.findUnique).not.toHaveBeenCalled();
      expect(deps.roofing.cancel).not.toHaveBeenCalled();
    });
  });
});
