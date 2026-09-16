import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditQueryService } from './audit-query.service';
import { encodeCursor } from './audit-cursor';

/**
 * D-218/RF-S2/M3: el presupuesto de consultas (una por fuente + una de actores, fijo) y el
 * filtrado por `entityType` (una fuente que no aplica ni se consulta) son las dos piezas que
 * no se pueden confiar solo a la lectura del código — si alguien agrega una quinta fuente sin
 * tocar el merge, o rompe el filtro de relevancia, esto se cae.
 */
function fakePrisma(options: {
  auditLogRows?: unknown[];
  salesPriceRows?: unknown[];
  productPriceRows?: unknown[];
  issueDateRows?: unknown[];
  users?: { id: string; name: string }[];
}) {
  const auditLogFindMany = jest.fn().mockResolvedValue(options.auditLogRows ?? []);
  const salesPriceFindMany = jest.fn().mockResolvedValue(options.salesPriceRows ?? []);
  const productPriceFindMany = jest.fn().mockResolvedValue(options.productPriceRows ?? []);
  const issueDateFindMany = jest.fn().mockResolvedValue(options.issueDateRows ?? []);
  const userFindMany = jest.fn().mockResolvedValue(options.users ?? []);
  const prisma = {
    auditLog: { findMany: auditLogFindMany },
    salesPriceChange: { findMany: salesPriceFindMany },
    productListPriceChange: { findMany: productPriceFindMany },
    fiscalDocumentIssueDateChange: { findMany: issueDateFindMany },
    user: { findMany: userFindMany },
  };
  return {
    prisma: prisma as never,
    calls: {
      auditLogFindMany,
      salesPriceFindMany,
      productPriceFindMany,
      issueDateFindMany,
      userFindMany,
    },
  };
}

const NOW = new Date('2026-09-16T12:00:00.000Z');

// -----------------------------------------------------------------------------------------
// RF-S2-CIERRE/M2 (D-220): a diferencia de `fakePrisma` (arriba), que siempre devuelve el
// array entero sin mirar `where`/`orderBy`/`take`, este fake SÍ los respeta — es lo único que
// permite probar la paginación real (varias páginas, cursor a cursor) en vez de una sola
// llamada con `pageSize` grande. Reimplementa el único subconjunto de semántica de Prisma que
// `AuditQueryService` usa: igualdad, `gte`/`lt`/`lte`, `OR`, orden por `(fecha, id)` DESC con
// `id` comparado en su tipo nativo (BigInt para audit_log, texto para las otras tres — mismo
// criterio que `audit-query.service.ts`).
// -----------------------------------------------------------------------------------------
type Row = Record<string, unknown>;
type WhereClause = Record<string, unknown>;

function compareVal(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const ba = typeof a === 'bigint' ? a : BigInt(a as string);
    const bb = typeof b === 'bigint' ? b : BigInt(b as string);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  if (a === b) return 0;
  return (a as string) < (b as string) ? -1 : 1;
}

function matchesCondition(rowValue: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as { gte?: unknown; lt?: unknown; lte?: unknown };
    if ('gte' in c && compareVal(rowValue, c.gte) < 0) return false;
    if ('lt' in c && compareVal(rowValue, c.lt) >= 0) return false;
    if ('lte' in c && compareVal(rowValue, c.lte) > 0) return false;
    return true;
  }
  return compareVal(rowValue, cond) === 0;
}

function matchesWhere(row: Row, where: WhereClause): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as WhereClause[]).some((b) => matchesWhere(row, b))) return false;
      continue;
    }
    if (!matchesCondition(row[key], cond)) return false;
  }
  return true;
}

function fakeFindMany(rows: Row[], dateField: string) {
  return (args: { where?: WhereClause; take: number }) => {
    const filtered = args.where ? rows.filter((r) => matchesWhere(r, args.where!)) : rows.slice();
    filtered.sort((a, b) => {
      const byDate = compareVal(b[dateField], a[dateField]);
      return byDate !== 0 ? byDate : compareVal(b.id, a.id);
    });
    return Promise.resolve(filtered.slice(0, args.take));
  };
}

function fakeQueryablePrisma(seed: {
  auditLogRows?: Row[];
  salesPriceRows?: Row[];
  productPriceRows?: Row[];
  issueDateRows?: Row[];
}) {
  return {
    auditLog: { findMany: fakeFindMany(seed.auditLogRows ?? [], 'at') },
    salesPriceChange: { findMany: fakeFindMany(seed.salesPriceRows ?? [], 'changedAt') },
    productListPriceChange: { findMany: fakeFindMany(seed.productPriceRows ?? [], 'changedAt') },
    fiscalDocumentIssueDateChange: {
      findMany: fakeFindMany(seed.issueDateRows ?? [], 'changedAt'),
    },
    user: { findMany: () => Promise.resolve([]) },
  } as never;
}

function auditLogRow(id: bigint, at: Date): Row {
  return {
    id,
    at,
    actorId: null,
    actorKind: 'SYSTEM',
    action: 'job.sweep',
    entity: 'sessions',
    entityId: null,
    before: null,
    after: null,
    reason: null,
  };
}

function salesPriceRow(id: string, changedAt: Date): Row {
  return {
    id,
    changedAt,
    changedById: null,
    salesOrderId: 'so-fixed',
    quotationId: null,
    lineNumber: 1,
    beforeUnitValuePen: new Prisma.Decimal('10.0000'),
    afterUnitValuePen: new Prisma.Decimal('11.0000'),
    beforeValuePerMeterPen: null,
    afterValuePerMeterPen: null,
  };
}

function productPriceRow(id: string, changedAt: Date): Row {
  return {
    id,
    changedAt,
    changedById: null,
    productId: `p-${id}`,
    beforeValuePen: new Prisma.Decimal('10.0000'),
    afterValuePen: new Prisma.Decimal('12.0000'),
    origin: 'IMPORT',
    batchId: 'batch-1',
    revertsBatchId: null,
  };
}

/** Pagina hasta agotar el cursor, acumulando todos los items — para afirmar sobre el total. */
async function drainAllPages(
  service: AuditQueryService,
  baseQuery: Omit<Parameters<AuditQueryService['findPage']>[0], 'cursor'>,
): Promise<{ id: string; source: string }[]> {
  const items: { id: string; source: string }[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await service.findPage({ ...baseQuery, cursor });
    items.push(...page.items.map((i) => ({ id: i.id, source: i.source })));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return items;
}

describe('AuditQueryService.findPage (D-218)', () => {
  it('presupuesto de consultas: 4 fuentes + 1 lookup de actores, sin importar cuántas filas devuelva cada una', async () => {
    const { prisma, calls } = fakePrisma({
      auditLogRows: [
        {
          id: 1n,
          at: NOW,
          actorId: 'u-1',
          actorKind: 'USER',
          action: 'sales.order.cancel',
          entity: 'sales_orders',
          entityId: 'so-1',
          before: null,
          after: null,
          reason: null,
        },
      ],
    });
    const service = new AuditQueryService(prisma);
    await service.findPage({ pageSize: 50 });

    expect(calls.auditLogFindMany).toHaveBeenCalledTimes(1);
    expect(calls.salesPriceFindMany).toHaveBeenCalledTimes(1);
    expect(calls.productPriceFindMany).toHaveBeenCalledTimes(1);
    expect(calls.issueDateFindMany).toHaveBeenCalledTimes(1);
    expect(calls.userFindMany).toHaveBeenCalledTimes(1);
  });

  it('sin actores que resolver, ni siquiera consulta a users', async () => {
    const { prisma, calls } = fakePrisma({});
    const service = new AuditQueryService(prisma);
    await service.findPage({ pageSize: 50 });
    expect(calls.userFindMany).not.toHaveBeenCalled();
  });

  it('entityType que no aplica a una fuente: esa fuente ni se consulta', async () => {
    const { prisma, calls } = fakePrisma({});
    const service = new AuditQueryService(prisma);
    await service.findPage({ entityType: 'products', pageSize: 50 });

    expect(calls.auditLogFindMany).toHaveBeenCalledTimes(1);
    expect(calls.productPriceFindMany).toHaveBeenCalledTimes(1);
    // "products" no es ni sales_orders/quotations ni fiscal_documents: esas dos fuentes se
    // saltan sin consultar la base.
    expect(calls.salesPriceFindMany).not.toHaveBeenCalled();
    expect(calls.issueDateFindMany).not.toHaveBeenCalled();
  });

  it('mezcla y ordena por fecha descendente entre las cuatro fuentes', async () => {
    const older = new Date('2026-09-15T10:00:00.000Z');
    const newer = new Date('2026-09-16T10:00:00.000Z');
    const { prisma } = fakePrisma({
      auditLogRows: [
        {
          id: 1n,
          at: older,
          actorId: null,
          actorKind: 'SYSTEM',
          action: 'job.sweep',
          entity: 'sessions',
          entityId: null,
          before: null,
          after: null,
          reason: null,
        },
      ],
      productPriceRows: [
        {
          id: 'plpc-1',
          productId: 'p-1',
          beforeValuePen: null,
          afterValuePen: new Prisma.Decimal('10.0000'),
          changedById: 'u-1',
          changedAt: newer,
          origin: 'INLINE',
          batchId: null,
          revertsBatchId: null,
        },
      ],
    });
    const service = new AuditQueryService(prisma);
    const page = await service.findPage({ pageSize: 50 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.source).toBe('product_list_price_change');
    expect(page.items[1]!.source).toBe('audit_log');
  });

  it('desempata dos filas de audit_log con el mismo instante por id numérico, no por texto', async () => {
    // Regresión: comparar `id` como texto pone "10" antes que "9" (falso: 9n es menor). Dos
    // filas de `audit_log` con el mismo `at` (mismo milisegundo, plausible dentro de una misma
    // transacción) tienen que quedar en el mismo orden que el `ORDER BY id DESC` de la
    // consulta real — el mayor primero — o el corte de página puede perder la fila de id
    // mayor para siempre.
    const sameInstant = NOW;
    const { prisma } = fakePrisma({
      auditLogRows: [
        {
          id: 10n,
          at: sameInstant,
          actorId: null,
          actorKind: 'SYSTEM',
          action: 'job.sweep',
          entity: 'sessions',
          entityId: null,
          before: null,
          after: null,
          reason: null,
        },
        {
          id: 9n,
          at: sameInstant,
          actorId: null,
          actorKind: 'SYSTEM',
          action: 'job.sweep',
          entity: 'sessions',
          entityId: null,
          before: null,
          after: null,
          reason: null,
        },
      ],
    });
    const service = new AuditQueryService(prisma);
    const page = await service.findPage({ pageSize: 50 });

    expect(page.items.map((i) => i.id)).toEqual(['10', '9']);
  });

  it('hasMore: si una fuente devolvió exactamente pageSize filas, arma un cursor', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: BigInt(i + 1),
      at: new Date(NOW.getTime() - i * 1000),
      actorId: null,
      actorKind: 'SYSTEM' as const,
      action: 'job.sweep',
      entity: 'sessions',
      entityId: null,
      before: null,
      after: null,
      reason: null,
    }));
    const { prisma } = fakePrisma({ auditLogRows: rows });
    const service = new AuditQueryService(prisma);
    const page = await service.findPage({ pageSize: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('sin ninguna fuente al tope del pageSize, no hay página siguiente', async () => {
    const { prisma } = fakePrisma({
      auditLogRows: [
        {
          id: 1n,
          at: NOW,
          actorId: null,
          actorKind: 'SYSTEM',
          action: 'job.sweep',
          entity: 'sessions',
          entityId: null,
          before: null,
          after: null,
          reason: null,
        },
      ],
    });
    const service = new AuditQueryService(prisma);
    const page = await service.findPage({ pageSize: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it('un cursor válido se decodifica y se usa para acotar (no revienta)', async () => {
    const { prisma } = fakePrisma({});
    const service = new AuditQueryService(prisma);
    const cursor = encodeCursor({
      occurredAt: '2026-09-16T10:00:00.000Z',
      source: 'audit_log',
      id: '5',
    });
    await expect(service.findPage({ cursor, pageSize: 50 })).resolves.toBeDefined();
  });

  it('rango de más de 12 meses se rechaza con 400', async () => {
    const { prisma } = fakePrisma({});
    const service = new AuditQueryService(prisma);
    await expect(
      service.findPage({ from: '2020-01-01', to: '2026-09-16', pageSize: 50 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * RF-S2-CIERRE/M2 (D-220): los tres escenarios que el cierre exige para dar por resuelto —y
 * no solo documentado— el límite de la paginación entre fuentes. Usan `fakeQueryablePrisma`
 * (arriba), que sí respeta `where`/`orderBy`/`take`, porque el `fakePrisma` de los tests de
 * arriba no alcanza para probar más de una página.
 */
describe('AuditQueryService.findPage — paginación completa sin pérdidas (D-220)', () => {
  it('3 fuentes empatadas al mismo instante, 10 filas cada una, pageSize 4: las 30 aparecen, sin duplicados ni huecos, en orden estable', async () => {
    const auditLogRows = Array.from({ length: 10 }, (_, i) => auditLogRow(BigInt(i + 1), NOW));
    const salesPriceRows = Array.from({ length: 10 }, (_, i) =>
      salesPriceRow(`spc-${String(i + 1).padStart(2, '0')}`, NOW),
    );
    const productPriceRows = Array.from({ length: 10 }, (_, i) =>
      productPriceRow(`plpc-${String(i + 1).padStart(2, '0')}`, NOW),
    );
    const prisma = fakeQueryablePrisma({ auditLogRows, salesPriceRows, productPriceRows });
    const service = new AuditQueryService(prisma);

    const items = await drainAllPages(service, { pageSize: 4 });

    expect(items).toHaveLength(30);
    const keys = items.map((i) => `${i.source}:${i.id}`);
    expect(new Set(keys).size).toBe(30); // sin duplicados

    // Orden estable: dentro de un mismo instante, rank fijo entre fuentes (audit_log primero,
    // sales_price_change después, product_list_price_change al final — mismo orden que
    // `AUDIT_SOURCES`) y, dentro de cada fuente, id descendente en su tipo nativo.
    expect(items.slice(0, 10).every((i) => i.source === 'audit_log')).toBe(true);
    expect(items.slice(0, 10).map((i) => i.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(10 - i)),
    );
    expect(items.slice(10, 20).every((i) => i.source === 'sales_price_change')).toBe(true);
    expect(items.slice(20, 30).every((i) => i.source === 'product_list_price_change')).toBe(true);
  });

  it('carga masiva de 25 SKUs de precios de lista en el mismo instante (D-217): las 25 aparecen paginando', async () => {
    const productPriceRows = Array.from({ length: 25 }, (_, i) =>
      productPriceRow(`plpc-${String(i + 1).padStart(2, '0')}`, NOW),
    );
    const prisma = fakeQueryablePrisma({ productPriceRows });
    const service = new AuditQueryService(prisma);

    const items = await drainAllPages(service, { pageSize: 4, entityType: 'products' });

    expect(items).toHaveLength(25);
    expect(new Set(items.map((i) => i.id)).size).toBe(25);
  });

  it('un cursor manipulado a mano (fuente inexistente) se rechaza con 400, no revienta la paginación', async () => {
    const prisma = fakeQueryablePrisma({});
    const service = new AuditQueryService(prisma);
    const manipulated = Buffer.from(
      JSON.stringify({ occurredAt: NOW.toISOString(), source: 'algo_inventado', id: '1' }),
    ).toString('base64url');

    await expect(service.findPage({ cursor: manipulated, pageSize: 4 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
