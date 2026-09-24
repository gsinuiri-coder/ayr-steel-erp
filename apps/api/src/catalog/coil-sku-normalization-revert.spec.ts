import { BadRequestException } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildRevertPlan,
  CoilSkuNormalizationService,
  NORMALIZATION_REVERT_ACTION,
  NORMALIZATION_RUN_ACTION,
} from './coil-sku-normalization.service';

/**
 * Revisión cruzada RF-S4b (P1-4): `normalize:coil-skus --revert` deshace la última corrida a
 * partir de **su** auditoría —agrupada por el `requestId` de la corrida—, en orden inverso, y
 * se detiene si algo cambió desde entonces. El ida y vuelta contra una base real (estado y
 * reportes iguales) está en `normalizacion-bobinas-rf-s4b.spec.ts`.
 */

interface Product {
  id: string;
  sku: string;
  isActive: boolean;
  mergedIntoId: string | null;
  businessLineId: string;
}
interface AuditRow {
  id: number;
  action: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  at: Date;
}

const RUN = '11111111-1111-4111-8111-111111111111';

/** Una base en memoria: productos y auditoría, lo único que la reversa lee y escribe. */
function fakeDb(products: Product[], audit: AuditRow[]) {
  const byId = new Map(products.map((p) => [p.id, { ...p }]));
  const tx = {
    auditLog: {
      findMany: jest.fn(
        ({ where }: { where: { action?: string | { in: string[] }; requestId?: string } }) => {
          const actions =
            typeof where.action === 'string' ? [where.action] : (where.action?.in ?? null);
          return Promise.resolve(
            audit
              .filter(
                (a) =>
                  (actions === null || actions.includes(a.action)) &&
                  (where.requestId === undefined || a.requestId === where.requestId),
              )
              .sort((a, b) => b.id - a.id),
          );
        },
      ),
    },
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id)),
      ),
      findFirst: jest.fn(
        ({ where }: { where: { sku: string; id: { not: string }; businessLineId: string } }) =>
          Promise.resolve(
            [...byId.values()].find(
              (p) =>
                p.sku === where.sku &&
                p.id !== where.id.not &&
                p.businessLineId === where.businessLineId,
            ) ?? null,
          ),
      ),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Product> }) => {
        const p = byId.get(where.id);
        if (p) Object.assign(p, data);
        return Promise.resolve(p);
      }),
    },
  };
  const written: { action: string; after?: unknown }[] = [];
  const auditService = {
    write: jest.fn((_tx: unknown, entry: { action: string; after?: unknown }) => {
      written.push(entry);
      return Promise.resolve();
    }),
  };
  const prisma = {
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const service = new CoilSkuNormalizationService(
    prisma as unknown as PrismaService,
    auditService as unknown as AuditService,
  );
  return { tx, byId, service, written };
}

/** Lo que dejó una corrida: el vendido renombrado al canónico y el suelto unido a él. */
function afterRun(): { products: Product[]; audit: AuditRow[] } {
  const at = new Date('2026-09-24T03:00:00Z');
  return {
    products: [
      { id: 'p-main', sku: 'BOB038AZUL', isActive: true, mergedIntoId: null, businessLineId: 't' },
      {
        id: 'p-loose',
        sku: 'BOB38AZUL',
        isActive: false,
        mergedIntoId: 'p-main',
        businessLineId: 't',
      },
    ],
    audit: [
      {
        id: 1,
        action: 'catalog.product-merge',
        entityId: 'p-loose',
        before: { sku: 'BOB38AZUL', isActive: true, mergedIntoId: null },
        after: { isActive: false, mergedIntoId: 'p-main', mergedIntoSku: 'BOBALZ-AZUL0.38' },
        requestId: RUN,
        at,
      },
      {
        id: 2,
        action: 'catalog.product-rename-sku',
        entityId: 'p-main',
        before: { sku: 'BOBALZ-AZUL0.38' },
        after: { sku: 'BOB038AZUL' },
        requestId: RUN,
        at,
      },
      {
        id: 3,
        action: NORMALIZATION_RUN_ACTION,
        entityId: null,
        before: null,
        after: { renames: 0, merges: 1 },
        requestId: RUN,
        at,
      },
    ],
  };
}

describe('normalize:coil-skus --revert', () => {
  it('el dry-run lista los pasos en orden inverso al de la corrida, sin escribir', async () => {
    const { products, audit } = afterRun();
    const { tx } = fakeDb(products, audit);
    const plan = await buildRevertPlan(tx as never);
    expect(plan.runId).toBe(RUN);
    expect(plan.stops).toEqual([]);
    expect(plan.steps).toEqual([
      { kind: 'RENAME', productId: 'p-main', fromSku: 'BOB038AZUL', toSku: 'BOBALZ-AZUL0.38' },
      { kind: 'UNMERGE', productId: 'p-loose', sku: 'BOB38AZUL', mergedIntoId: 'p-main' },
    ]);
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('el execute deja cada producto como estaba antes de la corrida, auditado', async () => {
    const { products, audit } = afterRun();
    const { byId, service, written } = fakeDb(products, audit);
    await service.executeRevert({ id: 'u-1' });
    expect(byId.get('p-main')).toMatchObject({ sku: 'BOBALZ-AZUL0.38', isActive: true });
    expect(byId.get('p-loose')).toMatchObject({
      sku: 'BOB38AZUL',
      isActive: true,
      mergedIntoId: null,
    });
    expect(written.map((w) => w.action)).toEqual([
      'catalog.product-rename-sku',
      'catalog.product-merge-revert',
      NORMALIZATION_REVERT_ACTION,
    ]);
    expect(written[2]?.after).toEqual({ runId: RUN, steps: 2 });
  });

  it('una corrida ya deshecha no se vuelve a deshacer', async () => {
    const { products, audit } = afterRun();
    audit.push({
      id: 4,
      action: NORMALIZATION_REVERT_ACTION,
      entityId: null,
      before: null,
      after: { runId: RUN, steps: 2 },
      requestId: null,
      at: new Date(),
    });
    const { tx, service } = fakeDb(products, audit);
    expect((await buildRevertPlan(tx as never)).runId).toBeNull();
    await expect(service.executeRevert({ id: 'u-1' })).rejects.toThrow(
      /ninguna normalización sin deshacer/,
    );
  });

  it('si algo cambió desde la corrida, se detiene y no aplica nada', async () => {
    const { products, audit } = afterRun();
    // Alguien reactivó el suelto a mano (no se puede por el API, pero la reversa no lo asume).
    const loose = products.find((p) => p.id === 'p-loose');
    if (loose) Object.assign(loose, { isActive: true, mergedIntoId: null });
    const { byId, service } = fakeDb(products, audit);
    await expect(service.executeRevert({ id: 'u-1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(byId.get('p-main')?.sku).toBe('BOB038AZUL');
  });

  it('si el SKU viejo ya lo tiene otro producto, se detiene', async () => {
    const { products, audit } = afterRun();
    products.push({
      id: 'p-new',
      sku: 'BOBALZ-AZUL0.38',
      isActive: true,
      mergedIntoId: null,
      businessLineId: 't',
    });
    const { tx } = fakeDb(products, audit);
    const plan = await buildRevertPlan(tx as never);
    expect(plan.stops).toEqual([expect.stringMatching(/ese SKU ya lo tiene otro producto/)]);
  });
});
