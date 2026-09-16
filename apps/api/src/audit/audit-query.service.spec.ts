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
