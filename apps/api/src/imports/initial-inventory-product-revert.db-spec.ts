import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { businessToday, createProductSchema } from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { InitialInventoryProductImportService } from './initial-inventory-product-import.service';
import { InitialInventoryProductRevertService } from './initial-inventory-product-revert.service';

/**
 * cc68 (D-722) — la reversa de un lote de la carga inicial de productos **contra una base real**:
 * dry-run sin escribir, la reversa por `InventoryService.reverse` con la fecha pedida (saldo en
 * cero, una salida que apunta a cada entrada), auditoría del lote, todo o nada cuando una entrada
 * ya se usó, y una segunda reversa rechazada.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let importer: InitialInventoryProductImportService;
let reverter: InitialInventoryProductRevertService;
let admin: RequestUser;
let tradingLineId = '';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

const HEADER =
  'SKU PRODUCTO,UNIDADES,COSTO UNITARIO (SIN IGV),MONEDA,TIPO DE CAMBIO,FACTURA DE REFERENCIA,FECHA DE REFERENCIA';
const DAY = '2026-08-01';
const REASON = 'Inventario inicial anulado (prueba cc68)';

async function tradingProduct(): Promise<{ id: string; sku: string }> {
  const sku = `ESQ-CC68${letters(8)}`;
  const created = await moduleRef.get(CatalogService).create(
    admin,
    createProductSchema.parse({
      businessLineId: tradingLineId,
      sku,
      name: 'Esquinero cc68',
      unit: 'NIU',
      source: 'PURCHASED',
    }),
  );
  return { id: created.id, sku };
}

/** Carga el lote y devuelve su id. */
async function load(rows: string[]): Promise<string> {
  const batchId = randomUUID();
  const report = await importer.run(admin, {
    fileName: 'carga-cc68.csv',
    buffer: Buffer.from([HEADER, ...rows].join('\n'), 'utf8'),
    execute: true,
    operationDate: DAY,
    batchId,
  });
  expect(report).toMatchObject({ ok: true, executed: true });
  return batchId;
}

async function kardexOf(id: string) {
  return prisma.inventoryMovement.findMany({
    where: { itemType: 'PRODUCT', itemId: id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      type: true,
      qty: true,
      totalCost: true,
      reversalOfId: true,
      operationDate: true,
      notes: true,
    },
  });
}

async function balanceOf(id: string) {
  return prisma.inventoryBalance.findUnique({
    where: { itemType_itemId: { itemType: 'PRODUCT', itemId: id } },
  });
}

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  importer = moduleRef.get(InitialInventoryProductImportService);
  reverter = moduleRef.get(InitialInventoryProductRevertService);
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  admin = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };
  tradingLineId = (await prisma.businessLine.findUniqueOrThrow({ where: { code: 'TRADING' } })).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

describe('reversa de la carga inicial de productos (D-722)', () => {
  it('dry-run no escribe; --execute revierte cada entrada con la fecha pedida y audita el lote', async () => {
    const a = await tradingProduct();
    const b = await tradingProduct();
    const batchId = await load([`${a.sku},229,79.50,PEN,,,`, `${b.sku},10,12.3456,PEN,,,`]);

    const dry = await reverter.revert(admin, {
      batchId,
      execute: false,
      operationDate: DAY,
      reason: REASON,
    });
    expect(dry).toMatchObject({ ok: true, executed: false, operationDate: DAY });
    expect(dry.rows.map((r) => r.sku).sort()).toEqual([a.sku, b.sku].sort());
    expect(await kardexOf(a.id)).toHaveLength(1);

    const done = await reverter.revert(admin, {
      batchId,
      execute: true,
      operationDate: DAY,
      reason: REASON,
    });
    expect(done).toMatchObject({ ok: true, executed: true });
    for (const p of [a, b]) {
      const moves = await kardexOf(p.id);
      expect(moves).toHaveLength(2);
      const [entry, reversal] = moves;
      expect(reversal?.type).toBe('OUT');
      expect(reversal?.reversalOfId).toBe(entry?.id);
      expect(reversal?.qty.toFixed(3)).toBe(entry?.qty.toFixed(3));
      expect(reversal?.totalCost.toFixed(4)).toBe(entry?.totalCost.toFixed(4));
      expect(reversal?.operationDate.toISOString().slice(0, 10)).toBe(DAY);
      expect(reversal?.notes).toBe(REASON);
      const balance = await balanceOf(p.id);
      expect(balance?.qty.toFixed(3)).toBe('0.000');
      expect(balance?.avgCost.toFixed(4)).toBe('0.0000');
    }
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'imports.initial-inventory-products.revert' },
      orderBy: { at: 'desc' },
    });
    expect(audit?.after).toMatchObject({ batchId, operationDate: DAY, reason: REASON, count: 2 });

    // Una segunda reversa del mismo lote se rechaza y nombra el SKU.
    const again = await reverter.revert(admin, {
      batchId,
      execute: true,
      operationDate: DAY,
      reason: REASON,
    });
    expect(again).toMatchObject({ ok: false, executed: false });
    expect(again.rows.flatMap((r) => r.errors).join(' ')).toContain(
      `${a.sku}: esta entrada ya se revirtió`,
    );
  });

  it('todo o nada: una entrada con un movimiento posterior frena el lote y nadie se revierte', async () => {
    const used = await tradingProduct();
    const intact = await tradingProduct();
    const batchId = await load([`${used.sku},50,10,PEN,,,`, `${intact.sku},20,5,PEN,,,`]);
    // Una salida posterior a la carga (un ajuste manual de inventario).
    await prisma.$transaction((tx) =>
      moduleRef.get(InventoryService).record(tx, {
        businessLineId: tradingLineId,
        itemType: 'PRODUCT',
        itemId: used.id,
        type: 'OUT',
        qty: '3',
        unit: 'NIU',
        refType: 'ADJUSTMENT',
        refId: 'cc68-db-spec',
        actorId: admin.id,
        operationDate: businessToday(),
      }),
    );

    const report = await reverter.revert(admin, {
      batchId,
      execute: true,
      operationDate: DAY,
      reason: REASON,
    });
    expect(report).toMatchObject({ ok: false, executed: false });
    const usedRow = report.rows.find((r) => r.sku === used.sku);
    expect(usedRow?.errors.join(' ')).toMatch(/movimiento\(s\) de kardex además de la carga/);
    expect(report.rows.find((r) => r.sku === intact.sku)?.ok).toBe(true);
    expect(await kardexOf(intact.id)).toHaveLength(1);
    expect(await kardexOf(used.id)).toHaveLength(2);
  });

  it('un lote que no existe se rechaza', async () => {
    await expect(
      reverter.revert(admin, {
        batchId: randomUUID(),
        execute: false,
        operationDate: DAY,
        reason: REASON,
      }),
    ).rejects.toThrow(/No hay entradas de carga inicial/);
  });
});
