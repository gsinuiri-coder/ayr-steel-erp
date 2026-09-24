import { BusinessLineCode, FinishKind, Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { buildPlan, CoilSkuNormalizationService } from './coil-sku-normalization.service';

/**
 * D-253 — el plan de normalización y su execute, con una base falsa. Lo que se fija son las
 * paradas del dueño (D-230): color que no mapea, choque de base, empate, canónico tomado por un
 * inactivo y descuadre de kilos; y que el execute no atraviesa ninguna.
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));

// La unión y el renombre tienen su propio spec (`product-merge.spec.ts`); acá se comprueba solo
// que el execute las llama en el orden y con los ids que el plan dice.
const mockMerge = jest.fn();
const mockRename = jest.fn();
jest.mock('./product-merge', () => ({
  mergeProductInto: (...a: unknown[]) => mockMerge(...a) as unknown,
  renameProductSku: (...a: unknown[]) => mockRename(...a) as unknown,
}));

const D = (v: string) => new Prisma.Decimal(v);

interface ProductRow {
  id: string;
  sku: string;
  name?: string;
  uses?: number;
}
interface CoilRow {
  id: string;
  code: string;
  colorCode: string | null;
  finishCode?: string;
  finishId?: string;
  kind?: FinishKind;
  thickness?: string;
  kg: string;
}
interface Fake {
  products?: ProductRow[];
  coils?: CoilRow[];
  inactiveSkus?: string[];
  colors?: string[];
  finishDensity?: Record<string, string>;
  openQuotations?: { productId: string; seq: number }[];
  openOrders?: { productId: string; seq: number }[];
  /** Productos con kardex propio (revisión cruzada P2-3). */
  ownMovements?: { productId: string; count: number }[];
}

function fakeTx(f: Fake) {
  const initial = (f.products ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name ?? p.sku,
    businessLine: { code: BusinessLineCode.TRADING },
    _count: {
      quotationItems: p.uses ?? 0,
      salesOrderItems: 0,
      invoiceItems: 0,
      dispatchItems: 0,
    },
  }));
  const coils = (f.coils ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    finishId: c.finishId ?? `fin-${c.finishCode ?? 'ALZ-ROJO-3002'}`,
    thicknessMm: D(c.thickness ?? '0.38'),
    finish: {
      code: c.finishCode ?? 'ALZ-ROJO-3002',
      kind: c.kind ?? FinishKind.PREPINTADO,
      color: c.colorCode === null ? null : { code: c.colorCode },
    },
  }));
  // Los productos activos, mutables: el execute (mockeado) los une y renombra sobre esta lista.
  const state = { products: initial };
  return {
    state,
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    product: {
      findMany: jest.fn(({ where }: { where: { isActive?: boolean; sku?: { in: string[] } } }) =>
        Promise.resolve(
          where.isActive === false
            ? (f.inactiveSkus ?? [])
                .filter((s) => where.sku?.in.includes(s))
                .map((sku) => ({ sku }))
            : state.products,
        ),
      ),
    },
    color: {
      findMany: jest
        .fn()
        .mockResolvedValue((f.colors ?? ['ROJO', 'ROJO-3020', 'AZUL']).map((code) => ({ code }))),
    },
    coil: { findMany: jest.fn().mockResolvedValue(coils) },
    inventoryMovement: {
      groupBy: jest
        .fn()
        .mockResolvedValue(
          (f.ownMovements ?? []).map((m) => ({ itemId: m.productId, _count: { _all: m.count } })),
        ),
    },
    reservation: { groupBy: jest.fn().mockResolvedValue([]) },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue((f.coils ?? []).map((c) => ({ itemId: c.id, qty: D(c.kg) }))),
    },
    finish: {
      // El SKU viejo (`BOB{acabado}{espesor}`) se reconoce por el código del acabado.
      findUnique: jest.fn(({ where }: { where: { code: string } }) =>
        Promise.resolve(coils.map((c) => c.finish).find((fi) => fi.code === where.code) ?? null),
      ),
      findMany: jest.fn().mockResolvedValue(
        [...new Set(coils.map((c) => c.finish.code))].map((code) => ({
          id: `fin-${code}`,
          code,
          kind: FinishKind.PREPINTADO,
          densityFactor: D(f.finishDensity?.[code] ?? '7.85'),
        })),
      ),
    },
    quotationItem: {
      findMany: jest.fn().mockResolvedValue(
        (f.openQuotations ?? []).map((q) => ({
          productId: q.productId,
          quotation: { seq: q.seq, status: 'DRAFT' },
        })),
      ),
    },
    salesOrderItem: {
      findMany: jest.fn().mockResolvedValue(
        (f.openOrders ?? []).map((o) => ({
          productId: o.productId,
          salesOrder: { seq: o.seq, status: 'CONFIRMED' },
        })),
      ),
    },
  };
}

const asTx = (t: ReturnType<typeof fakeTx>) => t as never;

describe('buildPlan', () => {
  it('un producto con SKU viejo se renombra; el canónico no cambia', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [{ id: 'p1', sku: 'BOBALZ-ROJO-30020.38', uses: 2 }],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '4194' }],
        }),
      ),
    );
    expect(plan.stops).toEqual([]);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0]).toMatchObject({ canonicalSku: 'BOB038ROJO', renamePrincipal: true });
    expect(plan.kg).toMatchObject({ total: '4194.000', after: '4194.000' });
  });

  it('ya canónico: sin cambios', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [{ id: 'p1', sku: 'BOB038ROJO' }],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
        }),
      ),
    );
    expect(plan).toMatchObject({ renames: [], merges: [], unchanged: 1, stops: [] });
  });

  it('el suelto se une al viejo con más movimientos, que es el principal', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [
            { id: 'old', sku: 'BOBALZ-ROJO-30020.38', uses: 5 },
            { id: 'loose', sku: 'BOB38ROJO', uses: 1 },
          ],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
        }),
      ),
    );
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]?.principal.id).toBe('old');
    expect(plan.merges[0]?.merged.map((m) => m.sku)).toEqual(['BOB38ROJO']);
    expect(plan.stops).toEqual([]);
  });

  it('el que ya tiene el código canónico es el principal aunque tenga menos movimientos', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [
            { id: 'canon', sku: 'BOB038ROJO', uses: 0 },
            { id: 'loose', sku: 'BOB38ROJO', uses: 9 },
          ],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
        }),
      ),
    );
    expect(plan.merges[0]?.principal.id).toBe('canon');
    expect(plan.merges[0]?.renamePrincipal).toBe(false);
  });

  it('un producto a unir con kardex propio es una parada ya en el dry-run (P2-3)', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [
            { id: 'a', sku: 'BOB38ROJO', uses: 5 },
            { id: 'b', sku: 'BOB0.38ROJO', uses: 1 },
          ],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
          ownMovements: [{ productId: 'b', count: 2 }],
        }),
      ),
    );
    expect(plan.stops.join(' ')).toMatch(/BOB0\.38ROJO tiene saldo propio \(2 movimientos/);
  });

  it('un empate al elegir el principal es una parada', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [
            { id: 'a', sku: 'BOB38ROJO', uses: 2 },
            { id: 'b', sku: 'BOB0.38ROJO', uses: 2 },
          ],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
        }),
      ),
    );
    expect(plan.stops.join(' ')).toMatch(/empate/);
  });

  it('un color que el catálogo no tiene queda como no interpretable y para el dueño', async () => {
    const plan = await buildPlan(
      asTx(fakeTx({ products: [{ id: 'p1', sku: 'BOB38MORADO' }], coils: [] })),
    );
    expect(plan.uninterpretable).toHaveLength(1);
    expect(plan.stops.join(' ')).toMatch(/no mapea al catálogo/);
  });

  it('un canónico tomado por un producto inactivo es una parada', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [{ id: 'p1', sku: 'BOB38ROJO' }],
          inactiveSkus: ['BOB038ROJO'],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
        }),
      ),
    );
    expect(plan.stops.join(' ')).toMatch(/ya existe como producto inactivo/);
  });

  it('dos prepintados del mismo color con distinta densidad son un choque de base', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [{ id: 'p1', sku: 'BOB38ROJO' }],
          coils: [
            { id: 'c1', code: 'B-1', colorCode: 'ROJO', finishCode: 'ALZ-ROJO-3002', kg: '10' },
            {
              id: 'c2',
              code: 'B-2',
              colorCode: 'ROJO-3020',
              finishCode: 'GALV-ROJO-3020',
              kg: '10',
            },
          ],
          finishDensity: { 'ALZ-ROJO-3002': '7.85', 'GALV-ROJO-3020': '7.20' },
        }),
      ),
    );
    expect(plan.stops.join(' ')).toMatch(/no la base/);
  });

  it('una bobina con saldo que no resolvería a ningún producto es una parada de kilos', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [{ id: 'p1', sku: 'BOB038ROJO' }],
          coils: [
            { id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' },
            { id: 'c2', code: 'B-2', colorCode: 'AZUL', kg: '50' },
          ],
        }),
      ),
    );
    expect(plan.kg.total).toBe('150.000');
    expect(plan.kg.after).toBe('100.000');
    expect(plan.stops.join(' ')).toMatch(/Descuadre de kilos/);
    expect(plan.stops.join(' ')).toMatch(/B-2/);
  });

  it('lista los documentos abiertos de un producto a unir', async () => {
    const plan = await buildPlan(
      asTx(
        fakeTx({
          products: [
            { id: 'old', sku: 'BOBALZ-ROJO-30020.38', uses: 5 },
            { id: 'loose', sku: 'BOB38ROJO', uses: 1 },
          ],
          coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
          openQuotations: [{ productId: 'loose', seq: 2 }],
          openOrders: [{ productId: 'loose', seq: 7 }],
        }),
      ),
    );
    expect(plan.openDocuments.map((d) => `${d.kind} ${d.code}`)).toEqual([
      'COTIZACION COT-000002',
      'PEDIDO PED-000007',
    ]);
  });

  it('sin línea de reventa, no hay plan', async () => {
    const tx = fakeTx({});
    tx.businessLine.findUnique.mockResolvedValue(null);
    await expect(buildPlan(asTx(tx))).rejects.toThrow(/línea de reventa/);
  });
});

describe('CoilSkuNormalizationService', () => {
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const serviceFor = (tx: ReturnType<typeof fakeTx> & Record<string, unknown>) =>
    new CoilSkuNormalizationService(
      {
        $transaction: (fn: (t: never) => Promise<unknown>) => fn(tx as never),
      } as unknown as PrismaService,
      audit,
    );

  it('plan() es de solo lectura', async () => {
    const tx = fakeTx({
      products: [{ id: 'p1', sku: 'BOBALZ-ROJO-30020.38' }],
      coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '10' }],
    });
    const plan = await serviceFor(tx).plan();
    expect(plan.renames).toHaveLength(1);
    expect(audit.write).not.toHaveBeenCalled();
    expect(mockMerge).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('execute une y renombra, en ese orden, y la segunda pasada queda limpia', async () => {
    const fake = fakeTx({
      products: [
        { id: 'old', sku: 'BOBALZ-ROJO-30020.38', uses: 5 },
        { id: 'loose', sku: 'BOB38ROJO', uses: 1 },
      ],
      coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '4194' }],
    });
    // La unión y el renombre reales mutan la base; acá mutan la lista de activos del fake.
    mockMerge.mockImplementation(
      (_tx: unknown, _a: unknown, _u: unknown, i: { sourceId: string }) => {
        fake.state.products = fake.state.products.filter((p) => p.id !== i.sourceId);
        return Promise.resolve();
      },
    );
    mockRename.mockImplementation(
      (_tx: unknown, _a: unknown, _u: unknown, i: { productId: string; newSku: string }) => {
        const p = fake.state.products.find((x) => x.id === i.productId);
        if (p) p.sku = i.newSku;
        return Promise.resolve();
      },
    );
    const { before, after } = await serviceFor(fake).execute(
      { id: 'u1' },
      { acknowledgeOpenDocuments: false },
    );
    expect(before.merges).toHaveLength(1);
    expect(mockMerge).toHaveBeenCalledWith(
      expect.anything(),
      audit,
      { id: 'u1' },
      expect.objectContaining({ sourceId: 'loose', targetId: 'old' }),
    );
    expect(mockRename).toHaveBeenCalledWith(
      expect.anything(),
      audit,
      { id: 'u1' },
      expect.objectContaining({ productId: 'old', newSku: 'BOB038ROJO' }),
    );
    expect(mockMerge.mock.invocationCallOrder[0]).toBeLessThan(
      mockRename.mock.invocationCallOrder[0] ?? 0,
    );
    expect(after.merges).toEqual([]);
    expect(after.renames).toEqual([]);
    expect(after.kg.total).toBe(before.kg.total);
  });

  it('execute se niega a dar por hecho un catálogo que no quedó limpio', async () => {
    const fake = fakeTx({
      products: [{ id: 'old', sku: 'BOBALZ-ROJO-30020.38', uses: 5 }],
      coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '10' }],
    });
    // El renombre «no hace nada»: la segunda pasada todavía tiene algo por hacer.
    mockRename.mockResolvedValue(undefined);
    await expect(
      serviceFor(fake as never).execute({ id: 'u1' }, { acknowledgeOpenDocuments: false }),
    ).rejects.toThrow(/no dejó el catálogo como debía/);
  });

  it('execute se niega si hay paradas', async () => {
    const tx = fakeTx({ products: [{ id: 'p1', sku: 'BOB38MORADO' }], coils: [] });
    await expect(
      serviceFor(tx as never).execute({ id: 'u1' }, { acknowledgeOpenDocuments: true }),
    ).rejects.toThrow(/se detiene/);
  });

  it('execute exige reconocer los documentos abiertos', async () => {
    const tx = fakeTx({
      products: [
        { id: 'old', sku: 'BOBALZ-ROJO-30020.38', uses: 5 },
        { id: 'loose', sku: 'BOB38ROJO', uses: 1 },
      ],
      coils: [{ id: 'c1', code: 'B-1', colorCode: 'ROJO', kg: '100' }],
      openQuotations: [{ productId: 'loose', seq: 2 }],
    });
    await expect(
      serviceFor(tx as never).execute({ id: 'u1' }, { acknowledgeOpenDocuments: false }),
    ).rejects.toThrow(/ack-open-documents/);
  });
});
