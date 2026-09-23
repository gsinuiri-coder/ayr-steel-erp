import type { Prisma } from '@prisma/client';
import { mergeProductInto, renameProductSku } from './product-merge';

/**
 * **D-253 — la unión de productos no arma cadenas.** Pedido explícito del dueño: el principal
 * tiene que estar activo y sin `mergedIntoId`, y un producto que ya tiene otros unidos a él no se
 * une a un tercero. Los dos casos rebotan antes de escribir nada.
 */

interface Row {
  id: string;
  sku: string;
  businessLineId: string;
  isActive: boolean;
  mergedIntoId: string | null;
  mergedFromCount: number;
}

function fakeTx(rows: Row[], counts: { movements?: number; reservations?: number } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const audits: unknown[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const r = byId.get(where.id);
        return Promise.resolve(r ? { ...r, _count: { mergedFrom: r.mergedFromCount } } : null);
      }),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return Promise.resolve({});
      }),
    },
    inventoryMovement: { count: jest.fn().mockResolvedValue(counts.movements ?? 0) },
    reservation: { count: jest.fn().mockResolvedValue(counts.reservations ?? 0) },
  };
  const audit = {
    write: jest.fn((_tx: unknown, entry: unknown) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, audit, updates, audits };
}

const ACTOR = { id: 'actor-1' };
const LINE = 'bl-trading';

function product(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    sku: id.toUpperCase(),
    businessLineId: LINE,
    isActive: true,
    mergedIntoId: null,
    mergedFromCount: 0,
    ...over,
  };
}

describe('D-253 — mergeProductInto', () => {
  it('une: el sobrante queda inactivo, apunta al principal y se audita', async () => {
    const fake = fakeTx([product('bob38azul'), product('bob038azul')]);
    await mergeProductInto(fake.tx, fake.audit, ACTOR, {
      sourceId: 'bob38azul',
      targetId: 'bob038azul',
      reason: 'normalización',
    });
    expect(fake.updates).toEqual([
      { where: { id: 'bob38azul' }, data: { isActive: false, mergedIntoId: 'bob038azul' } },
    ]);
    expect(fake.audits).toHaveLength(1);
  });

  it('sin cadenas (1): el principal no puede estar unido a otro', async () => {
    const fake = fakeTx([
      product('a'),
      product('b', { isActive: false, mergedIntoId: 'c' }),
      product('c'),
    ]);
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'b', reason: 'x' }),
    ).rejects.toThrow(/no se arman cadenas/);
    expect(fake.updates).toEqual([]);
  });

  it('sin cadenas (1b): el principal tiene que estar activo', async () => {
    const fake = fakeTx([product('a'), product('b', { isActive: false })]);
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'b', reason: 'x' }),
    ).rejects.toThrow(/activo y sin unir/);
  });

  it('sin cadenas (2): un producto con otros unidos a él no se une a un tercero', async () => {
    const fake = fakeTx([product('a', { mergedFromCount: 2 }), product('b')]);
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'b', reason: 'x' }),
    ).rejects.toThrow(/no se une a un tercero/);
    expect(fake.updates).toEqual([]);
  });

  it('no une un producto a sí mismo', async () => {
    const fake = fakeTx([product('a')]);
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'a', reason: 'x' }),
    ).rejects.toThrow(/a sí mismo/);
  });

  it('se detiene si el producto a unir tiene saldo propio (parada del dueño)', async () => {
    const fake = fakeTx([product('a'), product('b')], { movements: 1 });
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'b', reason: 'x' }),
    ).rejects.toThrow(/saldo propio/);
    expect(fake.updates).toEqual([]);
  });

  it('no une productos de líneas distintas', async () => {
    const fake = fakeTx([product('a'), product('b', { businessLineId: 'otra' })]);
    await expect(
      mergeProductInto(fake.tx, fake.audit, ACTOR, { sourceId: 'a', targetId: 'b', reason: 'x' }),
    ).rejects.toThrow(/líneas distintas/);
  });
});

describe('D-253 — renameProductSku', () => {
  it('renombra el SKU conservando el id, con auditoría', async () => {
    const fake = fakeTx([product('p', { sku: 'BOBALZ-AZUL-50020.38' })]);
    await renameProductSku(fake.tx, fake.audit, ACTOR, {
      productId: 'p',
      newSku: 'BOB038AZUL',
      reason: 'normalización',
    });
    expect(fake.updates).toEqual([{ where: { id: 'p' }, data: { sku: 'BOB038AZUL' } }]);
    expect(fake.audits).toHaveLength(1);
  });

  it('no renombra un producto unido', async () => {
    const fake = fakeTx([product('p', { isActive: false, mergedIntoId: 'q' })]);
    await expect(
      renameProductSku(fake.tx, fake.audit, ACTOR, { productId: 'p', newSku: 'X', reason: 'x' }),
    ).rejects.toThrow(/inactivo o unido/);
  });
});
