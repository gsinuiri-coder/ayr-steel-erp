import { BadRequestException } from '@nestjs/common';
import { FinishKind, InventoryItemType, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QuotationsService } from '../sales/quotations.service';
import type { SalesOrderEditsService } from '../sales/sales-order-edits.service';
import { ImportedDocumentsSweepService } from './imported-documents-sweep.service';
import type { PaperLine } from './quotation-import.service';

/**
 * RF-S4b — el barrido de lo ya importado, con una base falsa. Lo que se fija: encuentra
 * COT-000002 como quedó en producción, no le pega el importe del papel a una cantidad editada,
 * solo toca documentos abiertos, no elige la misma bobina para dos líneas, y un rechazo del
 * dominio se reporta sin tumbar el resto.
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('../sales/reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

const D = (v: string) => new Prisma.Decimal(v);
const KEY = 'FFA1-1350';

interface LineOpts {
  qty?: string;
  reserve?: InventoryItemType;
  sku?: string;
  subtotal?: string;
  igv?: string;
  total?: string;
  mergedIntoId?: string | null;
  isActive?: boolean;
}
const line = (n: number, o: LineOpts = {}) => ({
  id: `l-${String(n)}`,
  lineNumber: n,
  productId: 'p-loose',
  description: 'BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002',
  qty: D(o.qty ?? '4194'),
  subtotalPen: D(o.subtotal ?? '12439.8234'),
  igvPen: D(o.igv ?? '2239.1682'),
  totalPen: D(o.total ?? '14678.9916'),
  reserveItemType: o.reserve ?? InventoryItemType.PRODUCT,
  reserveItemId: 'p-loose',
  pieces: [],
  product: {
    sku: o.sku ?? 'BOB38AZUL',
    name: 'Bobina suelta',
    isActive: o.isActive ?? true,
    mergedIntoId: o.mergedIntoId ?? null,
    businessLine: { code: 'TRADING' },
  },
});

const paperLine = (o: Partial<PaperLine> = {}): PaperLine => ({
  rowNumber: 1,
  documentKey: KEY,
  rawSku: 'BOB38AZUL',
  productName: 'BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002',
  qty: '4194.000',
  netAmountPen: '12439.8310',
  igvAmountPen: '2239.1690',
  totalAmountPen: '14679.0000',
  excluded: false,
  ...o,
});

interface FakeOpts {
  quotations?: unknown[];
  orders?: unknown[];
  coils?: { id: string; code: string; balance: string }[];
}
function fakePrisma(o: FakeOpts = {}) {
  const coils = o.coils ?? [{ id: 'c-1', code: 'SALDO-AZUL-4194', balance: '4194' }];
  return {
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }, { code: 'ROJO' }]) },
    quotation: {
      findMany: jest.fn().mockResolvedValue(o.quotations ?? []),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        customerId: 'cus-1',
        issueDate: new Date('2026-08-07T00:00:00Z'),
        notes: `Factura externa: ${KEY}`,
        items: [line(1)],
      }),
    },
    salesOrder: { findMany: jest.fn().mockResolvedValue(o.orders ?? []) },
    salesOrderItem: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'oi-1' }) },
    coil: {
      findMany: jest.fn().mockResolvedValue(
        coils.map((c) => ({
          id: c.id,
          code: c.code,
          widthMm: D('1200'),
          finish: { kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } },
        })),
      ),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(coils.map((c) => ({ itemId: c.id, qty: D(c.balance) }))),
    },
    quotationItem: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        salesOrderItem: {
          findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'oi-1' }),
        },
      }),
    ),
  };
}

const quotationRow = (items: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'q-1',
  seq: 2,
  status: 'DRAFT',
  notes: `Factura externa: ${KEY}`,
  items,
  ...over,
});
const orderRow = (items: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'o-1',
  seq: 5,
  status: 'CONFIRMED',
  notes: `Factura externa: ${KEY}`,
  items,
  fiscalDocuments: [],
  ...over,
});

function build(prisma: ReturnType<typeof fakePrisma>) {
  const quotations = { update: jest.fn().mockResolvedValue({}) };
  const edits = {
    updateItemCoilInTx: jest.fn().mockResolvedValue(undefined),
    restorePaperAmountsInTx: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ImportedDocumentsSweepService(
    prisma as unknown as PrismaService,
    quotations as unknown as QuotationsService,
    edits as unknown as SalesOrderEditsService,
  );
  return { service, quotations, edits };
}
const ACTOR = { id: 'u-1' } as never;

describe('ImportedDocumentsSweepService.report', () => {
  it('COT-000002 como quedó en producción: (a) al pool con su única bobina y (b) importes del papel', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    const { documents, reviewed } = await service.report([paperLine()]);
    expect(reviewed).toBe(1);
    const [doc] = documents;
    expect(doc).toMatchObject({
      kind: 'COTIZACION',
      code: 'COT-000002',
      open: true,
      unmatched: null,
    });
    const [finding] = doc?.findings ?? [];
    expect(finding?.product).toMatchObject({ autoCoilId: 'c-1', autoCoilCode: 'SALDO-AZUL-4194' });
    expect(finding?.amounts?.paper).toEqual({
      net: '12439.8310',
      igv: '2239.1690',
      total: '14679.0000',
    });
    expect(finding?.qtyMismatch).toBeNull();
  });

  it('una línea que ya vende su bobina con los importes del papel no tiene hallazgos', async () => {
    const clean = line(1, {
      reserve: InventoryItemType.COIL,
      subtotal: '12439.8310',
      igv: '2239.1690',
      total: '14679.0000',
    });
    const { service } = build(fakePrisma({ quotations: [quotationRow([clean])] }));
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings).toEqual([]);
  });

  it('con la cantidad editada no propone el importe del papel: la deja para el dueño', async () => {
    const edited = line(1, { reserve: InventoryItemType.COIL, qty: '50' });
    const { service } = build(fakePrisma({ quotations: [quotationRow([edited])] }));
    const { documents } = await service.report([paperLine()]);
    const [finding] = documents[0]?.findings ?? [];
    expect(finding?.qtyMismatch).toEqual({ paper: '4194.000', stored: '50.000' });
    expect(finding?.amounts).toBeNull();
  });

  it('sin candidatas en el pool no hay bobina a la que atarla', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])], coils: [] }));
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.product).toMatchObject({ autoCoilId: null, candidates: 0 });
  });

  it('un código de bobina que no se interpreta queda sin bobina', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    const { documents } = await service.report([
      paperLine({ rawSku: 'BOB38MORADO', productName: '' }),
    ]);
    expect(documents[0]?.findings[0]?.product).toMatchObject({ autoCoilId: null, candidates: 0 });
  });

  it('un producto unido a otro se marca aunque no sea de bobina', async () => {
    const merged = line(1, {
      sku: 'COB040ROJO',
      isActive: false,
      mergedIntoId: 'p-main',
      reserve: InventoryItemType.PRODUCT,
    });
    const { service } = build(fakePrisma({ quotations: [quotationRow([merged])] }));
    const { documents } = await service.report([
      paperLine({ rawSku: 'COB040ROJO', productName: 'COBERTURA', netAmountPen: null }),
    ]);
    expect(documents[0]?.findings[0]?.product?.reason).toMatch(/unido a otro producto/);
  });

  it('un documento que no está en el archivo, o con otra cantidad de líneas, no se compara', async () => {
    const { service } = build(
      fakePrisma({
        quotations: [
          quotationRow([line(1)], { id: 'q-a', notes: 'Factura externa: FFA1-9999' }),
          quotationRow([line(1), line(2)], { id: 'q-b' }),
        ],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.unmatched).toMatch(/no está en el archivo/);
    expect(documents[1]?.unmatched).toMatch(/2/);
  });

  it('las filas excluidas del archivo (notas de crédito) no cuentan', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    const { documents } = await service.report([paperLine({ excluded: true })]);
    expect(documents[0]?.unmatched).toMatch(/no está en el archivo/);
  });

  it('un pedido con comprobante vivo o ya atendido no está abierto', async () => {
    const { service } = build(
      fakePrisma({
        orders: [
          orderRow([line(1)], { id: 'o-a', fiscalDocuments: [{ id: 'f-1' }] }),
          orderRow([line(1)], { id: 'o-b', status: 'FULFILLED' }),
          orderRow([line(1)], { id: 'o-c' }),
        ],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents.map((d) => d.open)).toEqual([false, false, true]);
  });

  it('dos líneas que caen en la misma bobina única no se atan solas', async () => {
    const { service } = build(
      fakePrisma({
        quotations: [
          quotationRow([line(1)], { id: 'q-1' }),
          quotationRow([line(1)], { id: 'q-2', seq: 3 }),
        ],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    const products = documents.flatMap((d) => d.findings.map((f) => f.product));
    expect(products.map((p) => p?.autoCoilId)).toEqual([null, null]);
    expect(products[0]?.reason).toMatch(/elige a mano/);
  });
});

describe('ImportedDocumentsSweepService.execute', () => {
  it('corrige una cotización abierta con la bobina y los importes del papel', async () => {
    const { service, quotations } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    const result = await service.execute(ACTOR, [paperLine()]);
    expect(result.fixed).toEqual([{ kind: 'COTIZACION', code: 'COT-000002', lines: [1] }]);
    const [, id, body] = quotations.update.mock.calls[0] as [unknown, string, { items: unknown[] }];
    expect(id).toBe('q-1');
    expect(body.items[0]).toMatchObject({
      saleCoilId: 'c-1',
      qty: '4194',
      netAmountPen: '12439.8310',
      igvAmountPen: '2239.1690',
      totalAmountPen: '14679.0000',
    });
  });

  it('corrige un pedido abierto en una sola transacción, bobina primero e importes después', async () => {
    const prisma = fakePrisma({ orders: [orderRow([line(1)])] });
    const { service, edits } = build(prisma);
    const result = await service.execute(ACTOR, [paperLine()]);
    expect(result.fixed[0]).toMatchObject({ kind: 'PEDIDO', code: 'PED-000005' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(edits.updateItemCoilInTx.mock.invocationCallOrder[0]).toBeLessThan(
      edits.restorePaperAmountsInTx.mock.invocationCallOrder[0] ?? 0,
    );
    const restoreCalls = edits.restorePaperAmountsInTx.mock.calls as unknown[][];
    expect(restoreCalls[0]?.[4]).toEqual({
      netAmountPen: '12439.8310',
      igvAmountPen: '2239.1690',
      totalAmountPen: '14679.0000',
    });
  });

  it('no toca lo cerrado, lo que tiene la cantidad editada ni lo que no tiene bobina única', async () => {
    const prisma = fakePrisma({
      quotations: [
        quotationRow([line(1)], { id: 'q-closed', status: 'CONFIRMED' }),
        quotationRow([line(1, { reserve: InventoryItemType.COIL, qty: '50' })], {
          id: 'q-qty',
          seq: 3,
        }),
      ],
      orders: [orderRow([line(1)], { id: 'o-closed', fiscalDocuments: [{ id: 'f-1' }] })],
    });
    const { service, quotations, edits } = build(prisma);
    const result = await service.execute(ACTOR, [paperLine()]);
    expect(result.fixed).toEqual([]);
    expect(quotations.update).not.toHaveBeenCalled();
    expect(edits.updateItemCoilInTx).not.toHaveBeenCalled();
    expect(result.pending.map((d) => d.id)).toEqual(['q-qty']);
  });

  it('no toca un documento sin bobina candidata', async () => {
    const { service, quotations } = build(
      fakePrisma({ quotations: [quotationRow([line(1)])], coils: [] }),
    );
    const result = await service.execute(ACTOR, [paperLine()]);
    expect(result.fixed).toEqual([]);
    expect(quotations.update).not.toHaveBeenCalled();
  });

  it('un rechazo del dominio se reporta y no tumba el resto', async () => {
    const { service, quotations } = build(
      fakePrisma({
        quotations: [quotationRow([line(1)])],
        // El pedido ya vende su bobina: solo necesita los importes, así que no compite por ella.
        orders: [orderRow([line(1, { reserve: InventoryItemType.COIL })], { id: 'o-2', seq: 6 })],
      }),
    );
    quotations.update.mockRejectedValue(new BadRequestException('la bobina ya no alcanza'));
    const result = await service.execute(ACTOR, [paperLine()]);
    expect(result.failed).toEqual([
      { kind: 'COTIZACION', code: 'COT-000002', reason: 'la bobina ya no alcanza' },
    ]);
    // El pedido siguiente sí se corrigió.
    expect(result.fixed.map((f) => f.code)).toEqual(['PED-000006']);
  });

  it('un error que no es del dominio corta en el acto', async () => {
    const { service, quotations } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    quotations.update.mockRejectedValue(new Error('deadlock'));
    await expect(service.execute(ACTOR, [paperLine()])).rejects.toThrow('deadlock');
  });
});
