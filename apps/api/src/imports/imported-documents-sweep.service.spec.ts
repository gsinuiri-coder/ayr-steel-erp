import { BadRequestException } from '@nestjs/common';
import { FinishKind, InventoryItemType, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QuotationsService } from '../sales/quotations.service';
import type { SalesOrderEditsService } from '../sales/sales-order-edits.service';
import {
  deliberatelyEditedProducts,
  ImportedDocumentsSweepService,
} from './imported-documents-sweep.service';
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
  /** Valor unitario vigente de la línea (D-264 lo compara con el cambio registrado). */
  price?: string;
  productId?: string;
}
const line = (n: number, o: LineOpts = {}) => ({
  id: `l-${String(n)}`,
  lineNumber: n,
  productId: o.productId ?? 'p-loose',
  description: 'BOBINA ALUZINC AZUL 0.38 X 1200 RAL 5002',
  qty: D(o.qty ?? '4194'),
  unitPricePen: D(o.price ?? '2.9661'),
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
  /** Ediciones de precio registradas (D-187): producto y valor unitario que dejaron. */
  priceEdits?: {
    quotationId?: string;
    salesOrderId?: string;
    productId?: string;
    /** Precio antes del cambio; por defecto, uno que no coincide con nada. */
    before?: string;
    after: string;
    /** Hora del cambio; por defecto, fija. */
    at?: string;
  }[];
  /** Auditorías del barrido (D-264): documento y hora. */
  sweepAudits?: { entityId: string; at: string }[];
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
    salesPriceChange: {
      findMany: jest.fn().mockResolvedValue(
        (o.priceEdits ?? []).map((e) => ({
          quotationId: e.quotationId ?? null,
          salesOrderId: e.salesOrderId ?? null,
          productId: e.productId ?? 'p-loose',
          beforeUnitValuePen: D(e.before ?? '1.0000'),
          afterUnitValuePen: D(e.after),
          changedAt: new Date(e.at ?? '2026-09-24T05:46:00.000Z'),
        })),
      ),
    },
    auditLog: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (o.sweepAudits ?? []).map((a) => ({ entityId: a.entityId, at: new Date(a.at) })),
        ),
    },
    salesOrderItem: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'oi-1' }) },
    coil: {
      // La identidad de la bobina que ya vende una línea: de ella sale su pool (D-254).
      findUnique: jest.fn().mockResolvedValue({
        thicknessMm: D('0.38'),
        finish: {
          code: 'ALZ-AZUL-5002',
          kind: FinishKind.PREPINTADO,
          color: { code: 'AZUL' },
        },
      }),
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
    expect(finding?.unpaired).toBeNull();
    // El dry-run dice qué SKU tiene la línea, cuál tendría y con qué fila del papel se emparejó.
    expect(finding).toMatchObject({
      productSku: 'BOB38AZUL',
      newSku: 'BOB038AZUL',
      paperSku: 'BOB38AZUL',
    });
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
    expect(finding?.unpaired).toMatch(/ninguna línea del papel tiene su producto .* y su cantidad/);
    expect(finding?.amounts).toBeNull();
    expect(documents[0]?.unpairedPaperRows).toEqual([1]);
  });

  it('sin candidatas en el pool no hay bobina a la que atarla', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])], coils: [] }));
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.product).toMatchObject({ autoCoilId: null, candidates: 0 });
  });

  it('un código del papel que no se interpreta no se empareja con la bobina: queda sin tocar', async () => {
    const { service } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    const { documents } = await service.report([
      paperLine({ rawSku: 'BOB38MORADO', productName: '' }),
    ]);
    const [finding] = documents[0]?.findings ?? [];
    expect(finding?.unpaired).toMatch(/ninguna línea del papel/);
    expect(finding?.product).toBeNull();
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

  it('un documento que no está en el archivo no se compara; dos líneas para una fila no se emparejan', async () => {
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
    expect(documents[1]?.unmatched).toBeNull();
    expect(documents[1]?.findings.map((f) => f.unpaired)).toEqual([
      expect.stringMatching(/misma línea del papel/),
      expect.stringMatching(/misma línea del papel/),
    ]);
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

/**
 * Revisión cruzada RF-S4b, P1-1: el papel se empareja con la línea por producto normalizado y
 * cantidad —el importe desempata—, **nunca por posición**. Los dos escenarios del informe.
 */
const common = (n: number, sku: string, subtotal: string) => ({
  ...line(n, {
    qty: '100',
    sku,
    subtotal,
    igv: D(subtotal).times('0.18').toFixed(4),
    total: D(subtotal).times('1.18').toFixed(4),
  }),
  productId: `p-${sku}`,
  description: `Producto ${sku}`,
  product: {
    sku,
    name: `Producto ${sku}`,
    isActive: true,
    mergedIntoId: null,
    businessLine: { code: 'ROOFING' },
  },
});
const commonPaper = (sku: string, net: string, rowNumber: number) =>
  paperLine({
    rowNumber,
    rawSku: sku,
    productName: `PLANCHA ${sku}`,
    qty: '100.000',
    netAmountPen: net,
    igvAmountPen: null,
    totalAmountPen: null,
  });

describe('ImportedDocumentsSweepService — emparejamiento con el papel (P1-1)', () => {
  it('dos líneas con la misma cantidad en otro orden reciben cada una el importe de su producto', async () => {
    const order = orderRow([common(1, 'PLA-X', '4999.9900'), common(2, 'PLA-Y', '299.9900')]);
    const prisma = fakePrisma({ orders: [order] });
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        salesOrderItem: {
          findFirstOrThrow: jest.fn(({ where }: { where: { lineNumber: number } }) =>
            Promise.resolve({ id: `oi-${String(where.lineNumber)}` }),
          ),
        },
      }),
    );
    const { service, edits } = build(prisma);
    // El papel trae el mismo comprobante con las filas en el orden inverso.
    const paper = [commonPaper('PLA-Y', '300.0000', 1), commonPaper('PLA-X', '5000.0000', 2)];

    const { documents } = await service.report(paper);
    expect(
      documents[0]?.findings.map((f) => [f.productSku, f.paperSku, f.amounts?.paper.net]),
    ).toEqual([
      ['PLA-X', 'PLA-X', '5000.0000'],
      ['PLA-Y', 'PLA-Y', '300.0000'],
    ]);

    await service.execute(ACTOR, paper);
    const calls = edits.restorePaperAmountsInTx.mock.calls as unknown[][];
    expect(calls.map((c) => [c[3], (c[4] as { netAmountPen: string }).netAmountPen])).toEqual([
      ['oi-1', '5000.0000'],
      ['oi-2', '300.0000'],
    ]);
    // D-264 (P2-3): la corrección del pedido tampoco queda como cambio de precio.
    expect(calls.map((c) => c[6])).toEqual([
      { recordPriceChange: false },
      { recordPriceChange: false },
    ]);
  });

  it('una línea común frente a un BOB… del papel nunca se convierte en venta de bobina', async () => {
    const q = quotationRow([common(1, 'PLA-X', '5000.0000')]);
    const prisma = fakePrisma({ quotations: [q] });
    const { service, quotations } = build(prisma);
    const paper = [paperLine({ qty: '100.000', netAmountPen: '5000.0000' })];

    const { documents } = await service.report(paper);
    const [finding] = documents[0]?.findings ?? [];
    expect(finding?.product).toBeNull();
    expect(finding?.unpaired).toMatch(/ninguna línea del papel tiene su producto \(PLA-X\)/);

    const result = await service.execute(ACTOR, paper);
    expect(quotations.update).not.toHaveBeenCalled();
    expect(result.fixed).toEqual([]);
    expect(result.pending.map((d) => d.id)).toEqual(['q-1']);
  });

  it('con dos filas del mismo producto y cantidad, el importe desempata', async () => {
    const q = quotationRow([common(1, 'PLA-X', '300.0000')]);
    const { service } = build(fakePrisma({ quotations: [q] }));
    const { documents } = await service.report([
      commonPaper('PLA-X', '5000.0000', 1),
      commonPaper('PLA-X', '300.0000', 2),
    ]);
    // Emparejada con la fila 2 (mismo importe): no hay nada que corregir y la 1 queda sin línea.
    expect(documents[0]?.findings).toEqual([]);
    expect(documents[0]?.unpairedPaperRows).toEqual([1]);
  });

  it('si el importe tampoco distingue, la línea queda en (c) y el execute no la toca', async () => {
    const q = quotationRow([common(1, 'PLA-X', '299.0000')]);
    const { service, quotations } = build(fakePrisma({ quotations: [q] }));
    const paper = [commonPaper('PLA-X', '5000.0000', 1), commonPaper('PLA-X', '300.0000', 2)];
    const { documents } = await service.report(paper);
    expect(documents[0]?.findings[0]?.unpaired).toMatch(/no se elige por posición/);
    await service.execute(ACTOR, paper);
    expect(quotations.update).not.toHaveBeenCalled();
  });

  it('el execute de una cotización lleva el motivo del barrido a la auditoría', async () => {
    const { service, quotations } = build(fakePrisma({ quotations: [quotationRow([line(1)])] }));
    await service.execute(ACTOR, [paperLine()]);
    expect((quotations.update.mock.calls as unknown[][])[0]?.[3]).toEqual({
      auditReason: expect.stringMatching(/Barrido de lo importado/),
      // D-264 (P2-3): la corrección no queda como cambio de precio del ADMINISTRADOR.
      recordPriceChanges: false,
    });
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

describe('ImportedDocumentsSweepService — lo cerrado no compite por la bobina (ensayo en demo)', () => {
  it('una cotización anulada del mismo comprobante no le quita la bobina única a la abierta', async () => {
    const { service } = build(
      fakePrisma({
        quotations: [
          quotationRow([line(1)], { id: 'q-open' }),
          quotationRow([line(1)], { id: 'q-cancelled', seq: 74, status: 'CANCELLED' }),
        ],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    const byId = new Map(documents.map((d) => [d.id, d.findings[0]?.product]));
    expect(byId.get('q-open')).toMatchObject({ autoCoilId: 'c-1' });
    expect(byId.get('q-cancelled')?.autoCoilId).toBeNull();
    expect(byId.get('q-cancelled')?.reason).toMatch(/documento cerrado: solo se reporta/);
  });
});

describe('ImportedDocumentsSweepService — un precio cambiado a propósito no se pisa (repaso P2-1)', () => {
  it('una diferencia mayor que el redondeo va a (c) y el execute no toca el documento', async () => {
    // El papel dice 12439.8310; alguien la bajó a 11000 a propósito (misma bobina, misma cantidad).
    const repriced = line(1, {
      reserve: InventoryItemType.COIL,
      subtotal: '11000.0000',
      igv: '1980.0000',
      total: '12980.0000',
    });
    const { service, quotations } = build(fakePrisma({ quotations: [quotationRow([repriced])] }));
    const { documents } = await service.report([paperLine()]);
    const [finding] = documents[0]?.findings ?? [];
    expect(finding?.unpaired).toMatch(/más de lo que explica el redondeo/);
    expect(finding?.amounts?.paper.net).toBe('12439.8310');
    await service.execute(ACTOR, [paperLine()]);
    expect(quotations.update).not.toHaveBeenCalled();
  });
});

describe('ImportedDocumentsSweepService — editada a propósito, por contenido (D-264)', () => {
  const coilLine = (n: number, o: LineOpts = {}) =>
    line(n, { reserve: InventoryItemType.COIL, ...o });

  it('línea editada: un cambio registrado cuyo precio sigue vigente la manda a (c), sin tocarla', async () => {
    const { service, quotations } = build(
      fakePrisma({
        quotations: [quotationRow([coilLine(1)])],
        priceEdits: [{ quotationId: 'q-1', after: '2.9661' }],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toMatch(/editada a propósito/);
    await service.execute(ACTOR, [paperLine()]);
    expect(quotations.update).not.toHaveBeenCalled();
  });

  it('el número de línea no importa: la edición se reconoce aunque la línea se haya movido', async () => {
    // El registro se hizo cuando era la línea 3; después se quitaron dos líneas de arriba.
    const { service } = build(
      fakePrisma({
        quotations: [quotationRow([coilLine(1)])],
        priceEdits: [{ quotationId: 'q-1', after: '2.9661' }],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toMatch(/editada a propósito/);
  });

  it('línea sin editar: un cambio que ya no está vigente, o de otro producto, no la marca', async () => {
    const { service } = build(
      fakePrisma({
        quotations: [quotationRow([coilLine(1)])],
        priceEdits: [
          { quotationId: 'q-1', after: '3.1000' },
          { quotationId: 'q-1', productId: 'p-otro', after: '2.9661' },
        ],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toBeNull();
  });

  it('dos líneas del mismo producto y solo una coincide: las dos cuentan como editadas', () => {
    const edited = deliberatelyEditedProducts(
      [
        {
          productId: 'p-1',
          beforeUnitValuePen: D('9.0000'),
          afterUnitValuePen: D('10.0000'),
          changedAt: new Date(),
        },
      ],
      [
        { productId: 'p-1', unitPricePen: D('10.0000') },
        { productId: 'p-1', unitPricePen: D('12.5000') },
        { productId: 'p-2', unitPricePen: D('10.0000') },
      ],
    );
    // Todo el producto p-1 (sus dos líneas) y nada de p-2.
    expect([...edited]).toEqual(['p-1']);
  });

  // P2-C (autorrevisión del PR #16): Y → X → Y no es una edición vigente.
  it('volver al precio con que se importó no cuenta como edición', () => {
    const change = (before: string, after: string, at: string) => ({
      productId: 'p-1',
      beforeUnitValuePen: D(before),
      afterUnitValuePen: D(after),
      changedAt: new Date(at),
    });
    const roundTrip = [
      change('2.9661', '3.1000', '2026-09-24T10:00:00Z'),
      change('3.1000', '2.9661', '2026-09-24T11:00:00Z'),
    ];
    const back = [{ productId: 'p-1', unitPricePen: D('2.9661') }];
    expect([...deliberatelyEditedProducts(roundTrip, back)]).toEqual([]);
    // El orden de llegada no importa: el origen es el «antes» del primer cambio.
    expect([...deliberatelyEditedProducts([...roundTrip].reverse(), back)]).toEqual([]);
    // Y → X → Z sí es una edición vigente.
    const further = [...roundTrip, change('2.9661', '3.5000', '2026-09-24T12:00:00Z')];
    expect([
      ...deliberatelyEditedProducts(further, [{ productId: 'p-1', unitPricePen: D('3.5000') }]),
    ]).toEqual(['p-1']);
  });

  it('un cambio que dejó el execute de un barrido anterior no cuenta como edición', async () => {
    // El de la ventana de RF-S4b: misma transacción que su auditoría del barrido.
    const { service } = build(
      fakePrisma({
        quotations: [quotationRow([coilLine(1)])],
        priceEdits: [{ quotationId: 'q-1', after: '2.9661', at: '2026-09-24T05:46:00.120Z' }],
        sweepAudits: [{ entityId: 'q-1', at: '2026-09-24T05:46:00.118Z' }],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toBeNull();
  });

  it('una edición humana horas después de la auditoría del barrido sí cuenta', async () => {
    const { service } = build(
      fakePrisma({
        quotations: [quotationRow([coilLine(1)])],
        priceEdits: [{ quotationId: 'q-1', after: '2.9661', at: '2026-09-24T15:00:00.000Z' }],
        sweepAudits: [{ entityId: 'q-1', at: '2026-09-24T05:46:00.118Z' }],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toMatch(/editada a propósito/);
  });

  it('un pedido hereda la edición hecha en su cotización antes de confirmarla', async () => {
    const { service, edits } = build(
      fakePrisma({
        orders: [orderRow([coilLine(1)], { quotationId: 'q-src' })],
        priceEdits: [{ quotationId: 'q-src', after: '2.9661' }],
      }),
    );
    const { documents } = await service.report([paperLine()]);
    expect(documents[0]?.findings[0]?.unpaired).toMatch(/editada a propósito/);
    await service.execute(ACTOR, [paperLine()]);
    expect(edits.restorePaperAmountsInTx).not.toHaveBeenCalled();
  });
});
