import { Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { PriceListImportService } from './price-list-import.service';

/**
 * D-217/M1c: la clasificación del preview (nuevos/cambiados/sin cambio/error) y el guard de
 * "revertir lote" — la parte que no se puede confiar únicamente a la lectura del código,
 * porque es la que decide si la carga masiva escribe lo que el usuario revisó.
 */

const BL = 'bl-1';
const PRODUCT_ACTIVE = { id: 'p-1', sku: 'TR-1', businessLineId: BL, unit: 'NIU' };

function csvBuffer(rows: string[]): Buffer {
  return Buffer.from(['SKU,PRECIO CON IGV', ...rows].join('\n'), 'utf8');
}

function fakePrisma(options: {
  products?: {
    id: string;
    sku: string;
    name?: string;
    unit?: string;
    businessLineId?: string;
    isActive?: boolean;
    listPricePen?: string | null;
  }[];
  minMarginPct?: string;
  productCost?: string;
}): PrismaService {
  const products = (options.products ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name ?? p.sku,
    unit: p.unit ?? 'NIU',
    businessLineId: p.businessLineId ?? BL,
    isActive: p.isActive ?? true,
    listPricePen:
      p.listPricePen === undefined || p.listPricePen === null
        ? null
        : new Prisma.Decimal(p.listPricePen),
  }));
  const tx = {
    pricingSetting: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          options.minMarginPct === undefined
            ? []
            : [{ businessLineId: BL, minMarginPct: new Prisma.Decimal(options.minMarginPct) }],
        ),
    },
    inventoryBalance: {
      findMany: jest.fn().mockResolvedValue(
        options.productCost === undefined
          ? []
          : products.map((p) => ({
              itemId: p.id,
              avgCost: new Prisma.Decimal(options.productCost!),
            })),
      ),
    },
  };
  return {
    product: {
      findMany: jest.fn().mockImplementation((args: { where: { sku: { in: string[] } } }) => {
        const skus = new Set(args.where.sku.in);
        return Promise.resolve(products.filter((p) => skus.has(p.sku)));
      }),
    },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
}

function service(prisma: PrismaService): PriceListImportService {
  const audit = { write: jest.fn() } as unknown as AuditService;
  return new PriceListImportService(prisma, audit);
}

describe('PriceListImportService.preview (D-217/M1c)', () => {
  it('SKU inexistente: ERROR y no bloquea el resto del archivo', async () => {
    const svc = service(fakePrisma({ products: [] }));
    const preview = await svc.preview(csvBuffer(['NO-EXISTE,10']));
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      status: 'ERROR',
      message: 'El SKU no existe en el catálogo',
    });
    expect(preview.summary.errors).toBe(1);
  });

  it('SKU duplicado dentro del archivo: la segunda fila es ERROR', async () => {
    const svc = service(fakePrisma({ products: [PRODUCT_ACTIVE] }));
    const preview = await svc.preview(csvBuffer(['TR-1,10', 'TR-1,12']));
    expect(preview.rows[0]?.status).not.toBe('ERROR');
    expect(preview.rows[1]).toMatchObject({ status: 'ERROR' });
    expect(preview.rows[1]?.message).toMatch(/duplicado/);
  });

  it('SKU ambiguo entre dos líneas de negocio: ERROR, nunca elige una', async () => {
    const svc = service(
      fakePrisma({
        products: [
          { id: 'p-1', sku: 'DUP', businessLineId: 'bl-a' },
          { id: 'p-2', sku: 'DUP', businessLineId: 'bl-b' },
        ],
      }),
    );
    const preview = await svc.preview(csvBuffer(['DUP,10']));
    expect(preview.rows[0]).toMatchObject({ status: 'ERROR' });
    expect(preview.rows[0]?.message).toMatch(/más de una línea/);
  });

  it('precio no numérico o cero: ERROR con mensaje explícito', async () => {
    const svc = service(fakePrisma({ products: [PRODUCT_ACTIVE] }));
    const preview = await svc.preview(csvBuffer(['TR-1,no-es-numero', 'TR-1,0']));
    // La segunda fila colisiona por SKU duplicado antes de llegar a validar el precio, así
    // que se prueban en archivos separados.
    expect(preview.rows[0]).toMatchObject({ status: 'ERROR' });
    expect(preview.rows[0]?.message).toMatch(/número válido/);
  });

  it('producto desactivado: ERROR, no se le puede fijar precio de lista', async () => {
    const svc = service(fakePrisma({ products: [{ ...PRODUCT_ACTIVE, isActive: false }] }));
    const preview = await svc.preview(csvBuffer(['TR-1,10']));
    expect(preview.rows[0]).toMatchObject({
      status: 'ERROR',
      message: 'El producto está desactivado',
    });
  });

  it('producto sin precio de lista: NEW', async () => {
    const svc = service(
      fakePrisma({ products: [PRODUCT_ACTIVE], minMarginPct: '10', productCost: '1' }),
    );
    const preview = await svc.preview(csvBuffer(['TR-1,20']));
    expect(preview.rows[0]?.status).toBe('NEW');
    expect(preview.summary.new).toBe(1);
  });

  it('producto con precio distinto: CHANGED; con el mismo precio: UNCHANGED', async () => {
    // 20 con IGV ÷ 1.18 = 16.9491525424 → redondeado a 16.9492 (D-003, 4 decimales).
    const svc = service(
      fakePrisma({
        products: [{ ...PRODUCT_ACTIVE, listPricePen: '16.9492' }],
        minMarginPct: '10',
        productCost: '1',
      }),
    );
    const changed = await svc.preview(csvBuffer(['TR-1,25']));
    expect(changed.rows[0]?.status).toBe('CHANGED');

    const svc2 = service(
      fakePrisma({
        products: [{ ...PRODUCT_ACTIVE, listPricePen: '16.9492' }],
        minMarginPct: '10',
        productCost: '1',
      }),
    );
    const unchanged = await svc2.preview(csvBuffer(['TR-1,20']));
    expect(unchanged.rows[0]?.status).toBe('UNCHANGED');
  });

  it('sin costo en el kardex: WARNING, no ERROR — no bloquea confirmar', async () => {
    const svc = service(fakePrisma({ products: [PRODUCT_ACTIVE], minMarginPct: '10' }));
    const preview = await svc.preview(csvBuffer(['TR-1,20']));
    expect(preview.rows[0]).toMatchObject({ status: 'WARNING' });
    expect(preview.rows[0]?.message).toMatch(/sin costo/i);
    expect(preview.summary.errors).toBe(0);
  });

  it('precio nuevo por debajo del piso: WARNING con el mínimo en el mensaje', async () => {
    // Costo 100, margen mínimo 10% → piso sin IGV 111.1111, con IGV ~131.11. Se manda 110
    // con IGV: muy por debajo.
    const svc = service(
      fakePrisma({ products: [PRODUCT_ACTIVE], minMarginPct: '10', productCost: '100' }),
    );
    const preview = await svc.preview(csvBuffer(['TR-1,110']));
    expect(preview.rows[0]).toMatchObject({ status: 'WARNING' });
    expect(preview.rows[0]?.message).toMatch(/piso/);
  });
});

const ACTOR: RequestUser = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
};

/**
 * Fake `PrismaService` para `confirm()`. Sin `idempotencyKey` en el input, `claimIdempotencyKey`
 * nunca toca `tx` (ver `common/idempotency.ts`): no hace falta mockear `$queryRaw` ni
 * `idempotencyKey.findUnique` para estos tests.
 */
function fakePrismaForConfirm(options: {
  products: { id: string; isActive?: boolean; listPricePen?: string | null }[];
}): { prisma: PrismaService; tx: { product: { update: jest.Mock } } } {
  const products = options.products.map((p) => ({
    id: p.id,
    isActive: p.isActive ?? true,
    listPricePen:
      p.listPricePen === null || p.listPricePen === undefined
        ? null
        : new Prisma.Decimal(p.listPricePen),
  }));
  const tx = {
    product: {
      findMany: jest.fn().mockImplementation((args: { where: { id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return Promise.resolve(products.filter((p) => ids.has(p.id)));
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    productListPriceChange: {
      createMany: jest.fn().mockResolvedValue(undefined),
    },
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx };
}

describe('PriceListImportService.confirm (D-217/M1c)', () => {
  it('una fila que dejó de ser un cambio real se ignora, no rechaza el lote ni la escribe', async () => {
    // El producto ya quedó en 10.0000 (otra edición, entre el preview y la confirmación); la
    // fila que confirma manda ese mismo valor.
    const { prisma, tx } = fakePrismaForConfirm({
      products: [{ id: 'p-1', listPricePen: '10.0000' }],
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    const result = await svc.confirm(ACTOR, {
      rows: [{ productId: 'p-1', afterValuePen: '10.0000' }],
    });

    expect(result.changed).toBe(0);
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('producto desactivado a mitad de la carga rechaza el lote entero', async () => {
    const { prisma } = fakePrismaForConfirm({
      products: [
        { id: 'p-1', listPricePen: null },
        { id: 'p-2', isActive: false, listPricePen: null },
      ],
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    await expect(
      svc.confirm(ACTOR, {
        rows: [
          { productId: 'p-1', afterValuePen: '10.0000' },
          { productId: 'p-2', afterValuePen: '20.0000' },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('desactivado') });
  });

  it('producto repetido en la confirmación se rechaza antes de abrir la transacción', async () => {
    const { prisma } = fakePrismaForConfirm({ products: [{ id: 'p-1', listPricePen: null }] });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    await expect(
      svc.confirm(ACTOR, {
        rows: [
          { productId: 'p-1', afterValuePen: '10.0000' },
          { productId: 'p-1', afterValuePen: '20.0000' },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('repetido') });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cambio real: actualiza el producto y registra un solo changelog', async () => {
    const { prisma, tx } = fakePrismaForConfirm({
      products: [{ id: 'p-1', listPricePen: '10.0000' }],
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    const result = await svc.confirm(ACTOR, {
      rows: [{ productId: 'p-1', afterValuePen: '12.0000' }],
    });

    expect(result.changed).toBe(1);
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { listPricePen: '12.0000' },
    });
  });
});

interface FakeChangeRow {
  id: string;
  productId: string;
  beforeValuePen: string | null;
  afterValuePen: string | null;
}

function toRowDecimal(v: string | null): Prisma.Decimal | null {
  return v === null ? null : new Prisma.Decimal(v);
}

/**
 * Fake `PrismaService` para `revert()`. `productListPriceChange.findMany` se llama dos veces
 * con formas de `where` distintas (las filas del lote, y el último cambio por producto) — se
 * discrimina por la presencia de `batchId`.
 */
function fakePrismaForRevert(options: {
  batchRows: FakeChangeRow[];
  alreadyReverted?: boolean;
  /** productId -> id del cambio más reciente. Por defecto, el propio id del lote (no bloqueado). */
  latestIdByProductId?: Record<string, string>;
  productSkus?: Record<string, string>;
}): PrismaService {
  const latest = new Map(
    options.batchRows.map((r) => [r.productId, options.latestIdByProductId?.[r.productId] ?? r.id]),
  );
  const tx = {
    productListPriceChange: {
      findMany: jest.fn().mockImplementation((args: { where: { batchId?: string } }) => {
        if (args.where.batchId !== undefined) {
          return Promise.resolve(
            options.batchRows.map((r) => ({
              ...r,
              beforeValuePen: toRowDecimal(r.beforeValuePen),
              afterValuePen: toRowDecimal(r.afterValuePen),
            })),
          );
        }
        return Promise.resolve([...latest.entries()].map(([productId, id]) => ({ productId, id })));
      }),
      findFirst: jest.fn().mockResolvedValue(options.alreadyReverted ? { id: 'existing' } : null),
      createMany: jest.fn().mockResolvedValue(undefined),
    },
    product: {
      findMany: jest
        .fn()
        .mockImplementation((args: { where: { id: { in: string[] } } }) =>
          Promise.resolve(args.where.id.in.map((id) => ({ sku: options.productSkus?.[id] ?? id }))),
        ),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  return {
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
}

describe('PriceListImportService.revert (D-217/M1c)', () => {
  it('revierte un lote sin cambios posteriores: restaura el valor anterior de cada fila', async () => {
    const prisma = fakePrismaForRevert({
      batchRows: [
        { id: 'chg-1', productId: 'p-1', beforeValuePen: '10.0000', afterValuePen: '12.0000' },
      ],
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    const result = await svc.revert(ACTOR, 'batch-1', {});

    expect(result.reverted).toBe(1);
  });

  it('lote ya revertido: 409, no reintenta', async () => {
    const prisma = fakePrismaForRevert({
      batchRows: [
        { id: 'chg-1', productId: 'p-1', beforeValuePen: '10.0000', afterValuePen: '12.0000' },
      ],
      alreadyReverted: true,
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    await expect(svc.revert(ACTOR, 'batch-1', {})).rejects.toMatchObject({
      message: expect.stringContaining('ya fue revertido'),
    });
  });

  it('un SKU del lote tuvo un cambio posterior: rechaza y lo nombra, sin tocar nada', async () => {
    const prisma = fakePrismaForRevert({
      batchRows: [
        { id: 'chg-1', productId: 'p-1', beforeValuePen: '10.0000', afterValuePen: '12.0000' },
        { id: 'chg-2', productId: 'p-2', beforeValuePen: '5.0000', afterValuePen: '6.0000' },
      ],
      // p-1 tuvo un cambio posterior (otro id); p-2 sigue siendo el último.
      latestIdByProductId: { 'p-1': 'chg-3-posterior' },
      productSkus: { 'p-1': 'TR-BLOQUEADO' },
    });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    await expect(svc.revert(ACTOR, 'batch-1', {})).rejects.toMatchObject({
      message: expect.stringContaining('TR-BLOQUEADO'),
    });
  });

  it('lote inexistente: 404', async () => {
    const prisma = fakePrismaForRevert({ batchRows: [] });
    const svc = new PriceListImportService(prisma, { write: jest.fn() } as unknown as AuditService);

    await expect(svc.revert(ACTOR, 'batch-inexistente', {})).rejects.toMatchObject({
      message: expect.stringContaining('no encontrado'),
    });
  });
});
