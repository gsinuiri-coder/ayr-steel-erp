import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { PurchasesService } from './purchases.service';

// La guarda de flejes montados (D-060) se prueba aparte: acá no hay OPs.
jest.mock('../production/production-assignments', () => ({
  ...jest.requireActual<object>('../production/production-assignments'),
  assertStripsNotAssigned: jest.fn().mockResolvedValue(undefined),
}));

/**
 * cc58 (D-686, D-10 de audit-01): el flete que llega tarde se suma a la entrada de cada bobina por
 * `recostEntries` y su anulación lo resta por la misma puerta. El recorrido completo, contra la
 * base, está en `purchase-audit.db-spec.ts`; acá, las ramas.
 */
const D = (v: string) => new Prisma.Decimal(v);
const ACTOR = { id: 'u-admin', role: 'ADMINISTRADOR' } as RequestUser;

interface Private {
  applyLandedCost(
    tx: unknown,
    purchase: unknown,
    actor: RequestUser,
    date: string,
  ): Promise<{ amountPen: string; coils: number; imputed: boolean } | null>;
  reverseLandedCost(
    tx: unknown,
    purchase: unknown,
    actor: RequestUser,
  ): Promise<{ coils: number; amountPen: Prisma.Decimal }>;
  assertNoLiveLandedCost(tx: unknown, purchase: unknown): Promise<void>;
}

function build(o: { pending?: boolean; entries?: unknown[]; adjusts?: unknown[] } = {}) {
  const recostEntries = jest
    .fn()
    .mockResolvedValue(o.pending ? { pending: true } : { pending: false, adjusted: [] });
  const audit = { write: jest.fn() };
  const service = Object.create(PurchasesService.prototype) as PurchasesService;
  const bump = jest.fn().mockResolvedValue({ from: '4.0000', to: '4.1000' });
  Object.assign(service, { inventory: { recostEntries }, audit, bumpCoilDocumentCost: bump });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    purchase: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'p-coils', status: 'RECEIVED', series: 'F001', number: '7' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ series: 'F002', number: '9', serviceKind: 'FREIGHT' }]),
    },
    coil: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'c-1', code: 'BOB-1', businessLineId: 'l-1' },
        { id: 'c-2', code: 'BOB-2', businessLineId: 'l-1' },
      ]),
      findUnique: jest.fn().mockResolvedValue({ code: 'BOB-1' }),
    },
    productionOrderCoil: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryMovement: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { type: string } }) =>
        Promise.resolve(
          where.type === 'IN'
            ? (o.entries ?? [
                { id: 1n, itemId: 'c-1', qty: D('600') },
                { id: 2n, itemId: 'c-2', qty: D('400') },
              ])
            : (o.adjusts ?? []),
        ),
      ),
    },
  };
  return { service: service as unknown as Private, tx, recostEntries, bump, audit };
}

const freight = {
  id: 'p-svc',
  type: 'SERVICE',
  serviceKind: 'FREIGHT',
  relatedPurchaseId: 'p-coils',
  series: 'F002',
  number: '9',
  subtotal: D('100'),
  exchangeRate: D('1'),
};

describe('PurchasesService — flete por recosteo de entradas (cc58, D-686)', () => {
  it('reparte por los kilos recibidos y lo suma a cada entrada en un solo recosteo', async () => {
    const { service, tx, recostEntries, bump } = build();
    const out = await service.applyLandedCost(tx, freight, ACTOR, '2026-10-19');
    expect(out).toMatchObject({ amountPen: '100.0000', coils: 2, imputed: true });
    expect(recostEntries).toHaveBeenCalledTimes(1);
    const [, entries, ctx] = recostEntries.mock.calls[0] as [
      unknown,
      { movementId: bigint; addPen: Prisma.Decimal }[],
      { note: string },
    ];
    expect(entries.map((e) => [e.movementId, e.addPen.toFixed(2)])).toEqual([
      [1n, '60.00'],
      [2n, '40.00'],
    ]);
    expect(ctx.note).toBe('Flete F002-9 (D-686)');
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('sin entradas vivas no imputa nada; si el recosteo pasa el tope, rechaza', async () => {
    const empty = build({ entries: [] });
    expect(
      await empty.service.applyLandedCost(empty.tx, freight, ACTOR, '2026-10-19'),
    ).toMatchObject({ imputed: false, coils: 0 });
    expect(empty.recostEntries).not.toHaveBeenCalled();
    const over = build({ pending: true });
    await expect(
      over.service.applyLandedCost(over.tx, freight, ACTOR, '2026-10-19'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('anular resta de cada entrada lo que el servicio le sumó', async () => {
    const entry = { itemId: 'c-1', qty: D('600'), reversalOfId: null, reversals: [] };
    const { service, tx, recostEntries, bump } = build({
      adjusts: [{ totalCost: D('60'), recostOf: { id: 1n, ...entry } }],
    });
    const out = await service.reverseLandedCost(tx, freight, ACTOR);
    expect([out.coils, out.amountPen.toString()]).toEqual([1, '60']);
    const [, entries, ctx] = recostEntries.mock.calls[0] as [
      unknown,
      { movementId: bigint; addPen: Prisma.Decimal }[],
      { note: string },
    ];
    expect(entries.map((e) => e.addPen.toString())).toEqual(['-60']);
    expect(ctx.note).toBe('Anulación: Flete F002-9 (D-686)');
    expect(bump.mock.calls.map((c: unknown[]) => [c[1], String(c[2]), String(c[3])])).toEqual([
      ['c-1', '-60', '600'],
    ]);
  });

  it('anular sin nada sumado no recostea; un servicio sin compra vinculada tampoco', async () => {
    const none = build({ adjusts: [] });
    expect((await none.service.reverseLandedCost(none.tx, freight, ACTOR)).coils).toBe(0);
    expect(none.recostEntries).not.toHaveBeenCalled();
    const loose = build();
    expect(
      (
        await loose.service.reverseLandedCost(
          loose.tx,
          { ...freight, relatedPurchaseId: null },
          ACTOR,
        )
      ).coils,
    ).toBe(0);
  });

  it('anular por encima del tope del recosteo rechaza', async () => {
    const entry = { itemId: 'c-1', qty: D('600'), reversalOfId: null, reversals: [] };
    const { service, tx } = build({
      pending: true,
      adjusts: [{ totalCost: D('60'), recostOf: { id: 1n, ...entry } }],
    });
    await expect(service.reverseLandedCost(tx, freight, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('la compra de bobinas no se anula con un flete vivo sumado; sin él, sí', async () => {
    const entry = { itemId: 'c-1', qty: D('600'), reversalOfId: null, reversals: [] };
    const live = build({ adjusts: [{ totalCost: D('60'), recostOf: { id: 1n, ...entry } }] });
    await expect(
      live.service.assertNoLiveLandedCost(live.tx, { id: 'p-coils', type: 'COIL' }),
    ).rejects.toThrow('flete vivo (F002-9)');
    const clean = build({ adjusts: [] });
    await expect(
      clean.service.assertNoLiveLandedCost(clean.tx, { id: 'p-coils', type: 'COIL' }),
    ).resolves.toBeUndefined();
    await expect(
      clean.service.assertNoLiveLandedCost(clean.tx, { id: 'p-svc', type: 'SERVICE' }),
    ).resolves.toBeUndefined();
  });
});
