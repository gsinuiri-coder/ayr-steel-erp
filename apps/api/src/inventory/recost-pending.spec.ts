import { Reflector } from '@nestjs/core';
import { Decimal, Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { InventoryController } from './inventory.controller';
import {
  completePendingRecosts,
  listPendingRecosts,
  pendingItems,
  RECOST_RESOLVED_ACTION,
  unresolvedPending,
} from './recost-pending';

/** cc63 (RC-01 de audit-02): marcas de recosteo pendiente y su cierre, con una base falsa. */
type Tx = Parameters<typeof listPendingRecosts>[0];

const mark = (id: number, items: string[], rows = 600) => ({
  id: BigInt(id),
  at: new Date('2026-10-20T15:00:00.000Z'),
  after: { recostItems: items, rowsReplayed: rows, maxRows: 500 },
});

function fakeDb(pending: ReturnType<typeof mark>[], resolved: { after: unknown }[] = []) {
  return {
    auditLog: {
      findMany: jest.fn(({ where }: { where: { action: string } }) =>
        Promise.resolve(where.action === RECOST_RESOLVED_ACTION ? resolved : pending),
      ),
    },
    coil: { findMany: jest.fn(() => Promise.resolve([{ id: 'c1', code: 'BOB-001' }])) },
    product: { findMany: jest.fn(() => Promise.resolve([{ id: 'p1', sku: 'SKU-1' }])) },
  };
}

describe('pendingItems', () => {
  it('lee los ítems de la marca sin repetir y descarta lo que no es un ítem de kardex', () => {
    expect(
      pendingItems({
        recostItems: ['COIL:c1', 'COIL:c1', 'PRODUCT:p1', 'RAW_MATERIAL:x', 7, 'COIL:'],
      }),
    ).toEqual([
      { itemType: 'COIL', itemId: 'c1' },
      { itemType: 'PRODUCT', itemId: 'p1' },
    ]);
    expect(pendingItems(null)).toEqual([]);
    expect(pendingItems({ recostItems: 'COIL:c1' })).toEqual([]);
  });
});

describe('unresolvedPending', () => {
  it('lo pendiente es lo que ningún «resuelto» nombró', () => {
    const open = unresolvedPending(
      [mark(1, ['COIL:c1']), mark(2, ['PRODUCT:p1'])],
      [{ after: { pendingAuditIds: ['1'] } }, { after: null }, { after: { pendingAuditIds: 'x' } }],
    );
    expect(open.map((p) => p.id)).toEqual([2n]);
  });
});

describe('listPendingRecosts', () => {
  it('nada pendiente: no busca etiquetas', async () => {
    const db = fakeDb([mark(1, ['COIL:c1'])], [{ after: { pendingAuditIds: ['1'] } }]);
    await expect(listPendingRecosts(db as unknown as Tx)).resolves.toEqual([]);
    expect(db.coil.findMany).not.toHaveBeenCalled();
  });

  it('con pendientes, los devuelve con el código o el SKU', async () => {
    const db = fakeDb([mark(3, ['COIL:c1', 'PRODUCT:p1', 'PRODUCT:p9'])]);
    await expect(listPendingRecosts(db as unknown as Tx)).resolves.toEqual([
      {
        auditId: '3',
        at: '2026-10-20T15:00:00.000Z',
        rowsReplayed: 600,
        items: [
          { itemType: 'COIL', itemId: 'c1', label: 'BOB-001' },
          { itemType: 'PRODUCT', itemId: 'p1', label: 'SKU-1' },
          { itemType: 'PRODUCT', itemId: 'p9', label: 'p9' },
        ],
      },
    ]);
  });
});

describe('completePendingRecosts', () => {
  it('sin pendientes no recostea ni escribe', async () => {
    const deps = { recostForward: jest.fn(), write: jest.fn() };
    const r = await completePendingRecosts(fakeDb([]) as unknown as Tx, deps, 'admin');
    expect(r).toEqual({ pendingAuditIds: [], items: [], adjusts: 0, deltaPen: '0.0000' });
    expect(deps.recostForward).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('recostea cada ítem una vez desde su primera fila y deja el «resuelto»', async () => {
    const db = fakeDb([mark(1, ['COIL:c1', 'PRODUCT:p1']), mark(2, ['PRODUCT:p1'])]);
    const deps = {
      recostForward: jest.fn(() =>
        Promise.resolve({
          adjusted: [
            { item: { itemType: 'PRODUCT', itemId: 'p1' }, delta: new Decimal('50') },
            { item: { itemType: 'PRODUCT', itemId: 'p1' }, delta: new Decimal('-0.5') },
            { item: { itemType: 'COIL', itemId: 'c1' }, delta: new Decimal('12.25') },
          ],
        }),
      ),
      write: jest.fn(() => Promise.resolve()),
    };
    const r = await completePendingRecosts(db as unknown as Tx, deps, 'admin');
    expect(deps.recostForward).toHaveBeenCalledWith(
      db,
      [
        { itemType: 'COIL', itemId: 'c1', fromStart: true },
        { itemType: 'PRODUCT', itemId: 'p1', fromStart: true },
      ],
      { actorId: 'admin', historic: { label: 'Recosteo pendiente completado' } },
    );
    expect(r).toEqual({
      pendingAuditIds: ['1', '2'],
      items: [
        { itemType: 'COIL', itemId: 'c1', label: 'BOB-001', adjusts: 1 },
        { itemType: 'PRODUCT', itemId: 'p1', label: 'SKU-1', adjusts: 2 },
      ],
      adjusts: 3,
      deltaPen: '61.7500',
    });
    expect(deps.write).toHaveBeenCalledWith(db, {
      actorId: 'admin',
      action: RECOST_RESOLVED_ACTION,
      entity: 'inventory_movements',
      entityId: '1,2',
      after: {
        pendingAuditIds: ['1', '2'],
        items: ['COIL:c1', 'PRODUCT:p1'],
        adjusts: 3,
        deltaPen: '61.7500',
      },
    });
  });
});

describe('GET /inventory/recost-pending', () => {
  it('es solo de ADMINISTRADOR', () => {
    const roles = new Reflector().get<Role[]>(
      ROLES_KEY,
      InventoryController.prototype.findPendingRecosts,
    );
    expect(roles).toEqual([Role.ADMINISTRADOR]);
  });
});
