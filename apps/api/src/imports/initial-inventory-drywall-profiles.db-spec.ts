import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { businessToday, createProductSchema } from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { InitialInventoryProductImportService } from './initial-inventory-product-import.service';

/**
 * D-712 (dw-03) — la carga inicial de perfiles de Drywall **contra una base real**: el perfil
 * fabricado por unidades con su ficha completa entra al kardex como producto terminado (`IN`,
 * `IMPORT`, costo por pieza en soles), todo o nada; el perfil sin peso por pieza y la cobertura
 * fabricada se rechazan sin escribir nada.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let service: InitialInventoryProductImportService;
let admin: RequestUser;
let drywallLineId = '';
let roofingMetalLineId = '';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );

const HEADER =
  'SKU PRODUCTO,UNIDADES,COSTO UNITARIO (SIN IGV),MONEDA,TIPO DE CAMBIO,FACTURA DE REFERENCIA,FECHA DE REFERENCIA';

function csv(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

async function run(rows: string[], execute: boolean) {
  return service.run(admin, {
    fileName: 'perfiles-dw03.csv',
    buffer: csv(rows),
    execute,
    operationDate: businessToday(),
    batchId: randomUUID(),
  });
}

async function profile(): Promise<string> {
  const sku = `P-DW03${letters(8)}`;
  await moduleRef.get(CatalogService).create(
    admin,
    createProductSchema.parse({
      businessLineId: drywallLineId,
      sku,
      name: 'Parante dw-03',
      unit: 'NIU',
      source: 'MANUFACTURED',
      thicknessMm: '0.43',
      widthMm: '124',
      lengthMm: '3000',
      pieceWeightKg: '1.32',
    }),
  );
  return sku;
}

/**
 * Un SKU de Drywall cargado antes de que el catálogo exigiera la ficha completa (D-118/D-344): el
 * alta de hoy ya no deja crearlo sin peso por pieza, así que se le borra el dato a mano.
 */
async function legacyProfileWithoutWeight(): Promise<string> {
  const sku = await profile();
  await prisma.product.updateMany({ where: { sku }, data: { pieceWeightKg: null } });
  return sku;
}

async function kardexOf(sku: string) {
  const p = await prisma.product.findFirstOrThrow({ where: { sku }, select: { id: true } });
  return prisma.inventoryMovement.findMany({
    where: { itemType: 'PRODUCT', itemId: p.id },
    select: { type: true, refType: true, qty: true, unitCost: true, totalCost: true },
  });
}

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  service = moduleRef.get(InitialInventoryProductImportService);
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
  drywallLineId = (await prisma.businessLine.findUniqueOrThrow({ where: { code: 'DRYWALL' } })).id;
  roofingMetalLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'METALLIC_ROOFING' } })
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

describe('carga inicial de perfiles de Drywall (D-712)', () => {
  it('el dry-run valida sin escribir; --execute deja una entrada IMPORT al costo cargado', async () => {
    const sku = await profile();

    const dry = await run([`${sku},120,3.11,PEN,,,`], false);
    expect(dry).toMatchObject({ ok: true, executed: false });
    expect(await kardexOf(sku)).toEqual([]);

    const done = await run([`${sku},120,3.11,PEN,,,`], true);
    expect(done).toMatchObject({ ok: true, executed: true });
    const moves = await kardexOf(sku);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.type).toBe('IN');
    expect(moves[0]?.refType).toBe('IMPORT');
    expect(moves[0]?.qty.toFixed(3)).toBe('120.000');
    expect(moves[0]?.unitCost.toFixed(4)).toBe('3.1100');
    expect(moves[0]?.totalCost.toFixed(2)).toBe('373.20');

    // D-207: el mismo SKU ya tiene kardex; una segunda carga se rechaza.
    const again = await run([`${sku},1,3.11,PEN,,,`], false);
    expect(again.ok).toBe(false);
    expect(again.rows[0]?.errors.join(' ')).toMatch(/ya tiene movimientos de kardex/);
  });

  it('todo o nada: un perfil sin peso por pieza frena el archivo entero y lo nombra', async () => {
    const complete = await profile();
    const incomplete = await legacyProfileWithoutWeight();

    const report = await run([`${complete},10,3.11,PEN,,,`, `${incomplete},10,3.11,PEN,,,`], true);
    expect(report).toMatchObject({ ok: false, executed: false });
    expect(report.rows[1]?.errors.join(' ')).toMatch(/le falta en el catálogo el peso por pieza/);
    expect(await kardexOf(complete)).toEqual([]);
    expect(await kardexOf(incomplete)).toEqual([]);
  });

  it('una cobertura fabricada sigue rechazada', async () => {
    const sku = `E-DW03${letters(8)}`;
    await prisma.product.create({
      data: {
        businessLineId: roofingMetalLineId,
        sku,
        name: 'Cobertura dw-03',
        unit: 'NIU',
        source: 'MANUFACTURED',
      },
    });
    const report = await run([`${sku},10,5,PEN,,,`], false);
    expect(report.ok).toBe(false);
    expect(report.rows[0]?.errors.join(' ')).toMatch(/ni un perfil de Drywall/);
  });
});
