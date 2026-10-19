import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditPageDto } from '@ayr/shared';
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
// Las paginaciones de abajo fijan `to` en el día de NOW: sin él, el rango por defecto son los
// últimos 31 días de hoy y desde el 2026-10-17 las filas de NOW quedaban fuera (vacío).

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

    const items = await drainAllPages(service, { pageSize: 4, to: '2026-09-16' });

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

    const items = await drainAllPages(service, {
      pageSize: 4,
      entityType: 'products',
      to: '2026-09-16',
    });

    expect(items).toHaveLength(25);
    expect(new Set(items.map((i) => i.id)).size).toBe(25);
  });

  // D-225/RF-S2-INTEGRA: una carga masiva y su reversa escriben, en la MISMA transacción, una
  // fila de lote en `audit_log` y una fila por SKU en `product_list_price_changes`. Las dos
  // toman `now()` de Postgres —la hora de inicio de la transacción—, así que empatan al
  // microsegundo entre fuentes distintas: el caso real del límite de D-220.
  it('carga masiva + su reversa (D-217): lote de audit_log y filas por SKU empatadas, las 52 aparecen en orden estable', async () => {
    const LATER = new Date(NOW.getTime() + 60_000);
    const batchRow = (id: bigint, at: Date, action: string): Row => ({
      ...auditLogRow(id, at),
      actorKind: 'USER',
      action,
      entity: 'products',
      entityId: `batch-${String(id)}`,
    });
    const auditLogRows = [
      batchRow(1n, NOW, 'catalog.price-list-import.confirm'),
      batchRow(2n, LATER, 'catalog.price-list-import.revert'),
    ];
    const productPriceRows = [
      ...Array.from({ length: 25 }, (_, i) =>
        productPriceRow(`imp-${String(i + 1).padStart(2, '0')}`, NOW),
      ),
      ...Array.from({ length: 25 }, (_, i) => ({
        ...productPriceRow(`rev-${String(i + 1).padStart(2, '0')}`, LATER),
        batchId: 'batch-2',
        revertsBatchId: 'batch-1',
      })),
    ];
    const service = new AuditQueryService(fakeQueryablePrisma({ auditLogRows, productPriceRows }));

    const items = await drainAllPages(service, {
      pageSize: 4,
      entityType: 'products',
      to: '2026-09-16',
    });

    expect(items).toHaveLength(52);
    expect(new Set(items.map((i) => `${i.source}:${i.id}`)).size).toBe(52);
    // Reversa (más nueva) primero: su fila de lote y después sus 25 SKUs; recién ahí la carga.
    expect(items[0]).toEqual({ source: 'audit_log', id: '2' });
    expect(items.slice(1, 26).every((i) => i.id.startsWith('rev-'))).toBe(true);
    expect(items[26]).toEqual({ source: 'audit_log', id: '1' });
    expect(items.slice(27).every((i) => i.id.startsWith('imp-'))).toBe(true);
  });

  it('edición inline de un precio de lista (D-217): catalog.update y el cambio de precio empatados, pageSize 1, los dos aparecen', async () => {
    const productId = 'p-inline';
    const auditLogRows: Row[] = [
      {
        ...auditLogRow(7n, NOW),
        actorKind: 'USER',
        action: 'catalog.update',
        entity: 'products',
        entityId: productId,
      },
    ];
    const productPriceRows: Row[] = [
      { ...productPriceRow('inline-1', NOW), productId, origin: 'INLINE', batchId: null },
    ];
    const service = new AuditQueryService(fakeQueryablePrisma({ auditLogRows, productPriceRows }));

    const items = await drainAllPages(service, {
      pageSize: 1,
      entityType: 'products',
      entityId: productId,
    });

    expect(items).toEqual([
      { source: 'audit_log', id: '7' },
      { source: 'product_list_price_change', id: 'inline-1' },
    ]);
  });

  it('descarte de borrador (D-223/D-225): el motivo llega al visor en `reason`, no escondido en before', async () => {
    const auditLogRows: Row[] = [
      {
        ...auditLogRow(9n, NOW),
        actorKind: 'USER',
        action: 'invoicing.document.discard-draft',
        entity: 'fiscal_documents',
        entityId: 'doc-1',
        before: { docType: 'FACTURA', totalPen: '118.0000' },
        reason: 'Borrador duplicado por doble click',
      },
    ];
    const service = new AuditQueryService(fakeQueryablePrisma({ auditLogRows }));

    const page = await service.findPage({
      pageSize: 10,
      entityType: 'fiscal_documents',
      entityId: 'doc-1',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.reason).toBe('Borrador duplicado por doble click');
    expect(page.items[0]!.before).toEqual({ docType: 'FACTURA', totalPen: '118.0000' });
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

describe('AuditQueryService — cc48 (D-633, D-634, D-635)', () => {
  /** Un fake con todo lo que la página nueva toca: las fuentes, el SQL del buscar y los códigos. */
  function fakeAll(rows: Record<string, unknown>[] = []) {
    const auditLogFindMany = jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue(rows);
    const queryRaw = jest.fn<Promise<unknown[]>, unknown[]>().mockResolvedValue(rows);
    const empty = () => ({ findMany: jest.fn().mockResolvedValue([]) });
    const salesOrderFindMany = jest
      .fn<Promise<unknown[]>, [unknown]>()
      .mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000031', seq: 31 }]);
    const prisma = {
      auditLog: { findMany: auditLogFindMany },
      $queryRaw: queryRaw,
      salesPriceChange: empty(),
      productListPriceChange: empty(),
      fiscalDocumentIssueDateChange: empty(),
      user: empty(),
      salesOrder: { findMany: salesOrderFindMany },
      coil: empty(),
      product: empty(),
      customer: empty(),
      supplier: empty(),
      fiscalDocument: empty(),
      purchase: empty(),
    };
    return { prisma, auditLogFindMany, queryRaw, salesOrderFindMany };
  }

  const orderRow = {
    id: 7n,
    at: NOW,
    actorId: null,
    actorKind: 'SYSTEM',
    action: 'sales.order.cancel',
    entity: 'sales_orders',
    entityId: '00000000-0000-4000-8000-000000000031',
    before: null,
    after: null,
    reason: null,
  };

  it('D-633: cada fila trae el código legible y su enlace, resueltos en una consulta por tipo', async () => {
    const f = fakeAll([orderRow]);
    const page = await new AuditQueryService(f.prisma as never).findPage({ pageSize: 50 });
    expect(page.items[0]).toMatchObject({
      entityCode: 'PED-000031',
      entityHref: '/pedidos/00000000-0000-4000-8000-000000000031',
      entityDeleted: false,
    });
    expect(f.salesOrderFindMany).toHaveBeenCalledTimes(1);
  });

  it('D-634: con buscar, audit_log va por una sola consulta SQL (no por Prisma) y el código se resuelve antes', async () => {
    const f = fakeAll([orderRow]);
    await new AuditQueryService(f.prisma as never).findPage({ pageSize: 50, search: 'PED-31' });
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.auditLogFindMany).not.toHaveBeenCalled();
    // El correlativo: una consulta a su tipo para el buscar, otra para el código de la fila.
    expect(f.salesOrderFindMany.mock.calls[0]![0]).toEqual({
      where: { seq: 31 },
      select: { id: true },
    });
    // El SQL lleva el texto como parámetro, nunca pegado en la consulta.
    // `$queryRaw` es una plantilla etiquetada: se rearma la consulta con sus partes.
    const [strings, ...values] = f.queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    expect(sql.values).toContain('%PED-31%');
    expect(sql.sql).not.toContain('PED-31');
  });

  it('D-634: una acción de audit_log deja fuera a los changelogs, sin consultarlos', async () => {
    const f = fakeAll();
    await new AuditQueryService(f.prisma as never).findPage({
      pageSize: 50,
      action: 'sales.order.cancel',
    });
    const args = f.auditLogFindMany.mock.calls[0]![0] as { where: { action?: string } };
    expect(args.where.action).toBe('sales.order.cancel');
    expect(f.prisma.salesPriceChange.findMany).not.toHaveBeenCalled();
    expect(f.prisma.productListPriceChange.findMany).not.toHaveBeenCalled();
    expect(f.prisma.fiscalDocumentIssueDateChange.findMany).not.toHaveBeenCalled();
  });

  it('D-635: abierta desde un documento (con su id) y sin fechas, el rango son los 12 meses', async () => {
    const f = fakeAll();
    await new AuditQueryService(f.prisma as never).findPage({
      pageSize: 50,
      entityType: 'sales_orders',
      entityId: '00000000-0000-4000-8000-000000000031',
    });
    interface RangeArgs {
      where: { at: { gte: Date; lt: Date } };
    }
    const { at } = (f.auditLogFindMany.mock.calls[0]![0] as RangeArgs).where;
    const days = (at.lt.getTime() - at.gte.getTime()) / 86_400_000;
    expect(days).toBe(360);
    const g = fakeAll();
    await new AuditQueryService(g.prisma as never).findPage({ pageSize: 50 });
    const other = (g.auditLogFindMany.mock.calls[0]![0] as RangeArgs).where;
    expect((other.at.lt.getTime() - other.at.gte.getTime()) / 86_400_000).toBe(32);
  });

  it('D-634: el Excel recorre todas las páginas con los mismos filtros y resuelve el buscar una vez', async () => {
    const f = fakeAll();
    const service = new AuditQueryService(f.prisma as never);
    const inner = service as unknown as {
      findPageWith: (q: unknown, m: unknown) => Promise<AuditPageDto>;
    };
    const findPageWith = jest
      .spyOn(inner, 'findPageWith')
      .mockResolvedValueOnce({
        items: [{ id: '1' } as never],
        nextCursor: 'c1',
        searchCapped: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: '2' } as never],
        nextCursor: null,
        searchCapped: false,
      });
    const rows = await service.exportAll({ action: 'sales.order.cancel', search: 'PED-31' });
    expect(rows).toHaveLength(2);
    expect(findPageWith.mock.calls[1]![0]).toMatchObject({
      action: 'sales.order.cancel',
      cursor: 'c1',
      pageSize: 200,
    });
    // Las dos páginas con el mismo buscar resuelto: una sola consulta del correlativo.
    expect(f.salesOrderFindMany).toHaveBeenCalledTimes(1);
    expect(findPageWith.mock.calls[0]![1]).toBe(findPageWith.mock.calls[1]![1]);
  });

  it('D-634: un correlativo que no existe da una lista vacía, no un error', async () => {
    const f = fakeAll();
    f.salesOrderFindMany.mockResolvedValue([]);
    const page = await new AuditQueryService(f.prisma as never).findPage({
      pageSize: 50,
      search: 'PED-999999',
    });
    expect(page.items).toEqual([]);
    expect(page.searchCapped).toBe(false);
  });

  it('D-634: un id pegado en el buscar se busca tal cual en la entidad', async () => {
    const f = fakeAll();
    const id = '00000000-0000-4000-8000-0000000000AA';
    await new AuditQueryService(f.prisma as never).findPage({ pageSize: 50, search: id });
    const [strings, ...values] = f.queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    expect(Prisma.sql(strings, ...(values as Prisma.Sql[])).values).toContain(id.toLowerCase());
    // Sin resolver códigos: un UUID no es un código legible.
    expect(f.salesOrderFindMany).not.toHaveBeenCalled();
  });
});

describe('AuditQueryService — buscar con periodo largo (cc48, D-634)', () => {
  function fakeSearch() {
    const empty = () => ({ findMany: jest.fn().mockResolvedValue([]) });
    const queryRaw = jest.fn<Promise<unknown[]>, unknown[]>().mockResolvedValue([]);
    const prisma = {
      auditLog: empty(),
      $queryRaw: queryRaw,
      salesPriceChange: empty(),
      productListPriceChange: empty(),
      fiscalDocumentIssueDateChange: empty(),
      user: empty(),
      coil: {
        findMany: jest.fn().mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000001' }]),
      },
      product: empty(),
      customer: empty(),
      supplier: empty(),
      fiscalDocument: empty(),
      purchase: empty(),
    };
    return { prisma, queryRaw };
  }
  const sqlOf = (call: unknown[]) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    return Prisma.sql(strings, ...(values as Prisma.Sql[]));
  };

  it('con 31 días o menos busca el texto del detalle; con más, solo el código', async () => {
    const short = fakeSearch();
    await new AuditQueryService(short.prisma as never).findPage({ pageSize: 50, search: 'galv' });
    expect(sqlOf(short.queryRaw.mock.calls[0]!).values).toContain('%galv%');

    const long = fakeSearch();
    await new AuditQueryService(long.prisma as never).findPage({
      pageSize: 50,
      search: 'galv',
      from: '2026-01-01',
      to: '2026-10-12',
    });
    const sql = sqlOf(long.queryRaw.mock.calls[0]!);
    expect(sql.values).not.toContain('%galv%');
    expect(sql.sql).not.toContain('ILIKE');
    expect(sql.values).toContain('00000000-0000-4000-8000-000000000001');
  });

  it('con periodo largo y ningún código que coincida, ni siquiera consulta audit_log', async () => {
    const f = fakeSearch();
    f.prisma.coil.findMany.mockResolvedValue([]);
    const page = await new AuditQueryService(f.prisma as never).findPage({
      pageSize: 50,
      search: 'nada',
      from: '2026-01-01',
      to: '2026-10-12',
    });
    expect(f.queryRaw).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
  });
});

describe('AuditQueryService — el buscar en cada fuente y con cursor (cc48, D-634)', () => {
  const ORDER = '00000000-0000-4000-8000-000000000031';
  function fakeAllSources() {
    const findMany = () => jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]);
    const queryRaw = jest.fn<Promise<unknown[]>, unknown[]>().mockResolvedValue([]);
    const prisma = {
      auditLog: { findMany: findMany() },
      $queryRaw: queryRaw,
      salesPriceChange: { findMany: findMany() },
      productListPriceChange: { findMany: findMany() },
      fiscalDocumentIssueDateChange: { findMany: findMany() },
      user: { findMany: findMany() },
      salesOrder: {
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([{ id: ORDER }]),
      },
    };
    return { prisma, queryRaw };
  }
  /** El texto del SQL con sus marcadores `$n`, como lo ve Postgres. */
  const sqlText = (call: unknown[]) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    return Prisma.sql(strings, ...(values as Prisma.Sql[])).text;
  };

  it.each([
    // Un cursor de la misma fuente: misma fecha y desempate por id.
    ['audit_log', '41', /\(at < \$\d+ OR \(at = \$\d+ AND id < \$\d+\)\)/],
    // Un cursor de otra fuente (de rango mayor): estrictamente antes de su fecha.
    ['fiscal_document_issue_date_change', 'x', /at < \$\d+ AND/],
  ] as const)(
    'cursor de %s: el SQL corta como la consulta de Prisma',
    async (source, id, expected) => {
      const f = fakeAllSources();
      const cursor = encodeCursor({ occurredAt: NOW.toISOString(), source, id });
      await new AuditQueryService(f.prisma as never).findPage({
        pageSize: 50,
        search: 'PED-31',
        cursor,
      });
      const text = sqlText(f.queryRaw.mock.calls[0]!);
      expect(text).toMatch(expected);
      expect(text).toMatch(/ORDER BY at DESC, id DESC/);
    },
  );

  it('los cambios de precio: con buscar, solo los del pedido encontrado; con tipo «cotizaciones», ninguno', async () => {
    const f = fakeAllSources();
    await new AuditQueryService(f.prisma as never).findPage({ pageSize: 50, search: 'PED-31' });
    const args = f.prisma.salesPriceChange.findMany.mock.calls[0]![0] as {
      where: { AND: { OR: Record<string, { in: string[] }>[] }[] };
    };
    expect(args.where.AND[0]!.OR[0]).toEqual({ salesOrderId: { in: [ORDER] } });
    expect(f.prisma.productListPriceChange.findMany).not.toHaveBeenCalled();

    const g = fakeAllSources();
    await new AuditQueryService(g.prisma as never).findPage({
      pageSize: 50,
      search: 'PED-31',
      entityType: 'quotations',
    });
    expect(g.prisma.salesPriceChange.findMany).not.toHaveBeenCalled();
  });

  it('un id pegado llega a las cuatro fuentes; el motivo de la fecha, con periodo corto', async () => {
    const f = fakeAllSources();
    await new AuditQueryService(f.prisma as never).findPage({ pageSize: 50, search: ORDER });
    expect(f.prisma.salesPriceChange.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.productListPriceChange.findMany).toHaveBeenCalledTimes(1);
    const issue = f.prisma.fiscalDocumentIssueDateChange.findMany.mock.calls[0]![0] as {
      where: { AND: { OR: Record<string, unknown>[] }[] };
    };
    expect(issue.where.AND[0]!.OR).toEqual([
      { documentId: { in: [ORDER] } },
      { reason: { contains: ORDER, mode: 'insensitive' } },
    ]);
  });
});
