import { Prisma } from '@prisma/client';
import { Decimal, equivalentMeters } from '@ayr/shared';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { inventoryCoilTypesXlsx } from './inventory-summary-xlsx';
import * as XLSX from 'xlsx';

/**
 * D-356 — Inventario → «Bobinas por tipo» lleva el metro lineal teórico del **disponible**,
 * sumado bobina por bobina con su propia geometría; la lista de bobinas lleva el del **peso
 * inicial**. Las dos columnas salen de la misma conversión (`equivalentMeters`): solo cambia el
 * peso que recibe.
 */

const d = (v: string) => new Prisma.Decimal(v);

function service(): InventoryService {
  const prisma = {
    inventoryBalance: {
      findMany: jest.fn().mockResolvedValue([
        { itemType: 'COIL', itemId: 'c1', qty: d('1000'), avgCost: d('2.5'), unit: 'KGM' },
        { itemType: 'COIL', itemId: 'c2', qty: d('500'), avgCost: d('2.5'), unit: 'KGM' },
        { itemType: 'PRODUCT', itemId: 'p1', qty: d('10'), avgCost: d('3'), unit: 'NIU' },
      ]),
    },
    coil: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'c1',
          widthMm: d('1000'),
          thicknessMm: d('0.30'),
          finish: { densityFactor: d('7.85') },
        },
        // Mismo tipo (acabado + espesor), otro ancho: RF-14 los agrupa igual.
        {
          id: 'c2',
          widthMm: d('1200'),
          thicknessMm: d('0.30'),
          finish: { densityFactor: d('7.85') },
        },
      ]),
    },
  } as unknown as PrismaService;
  const svc = new InventoryService(prisma, { ROOFING_THICKNESS_TOLERANCE_MM: '' } as Env);
  const internals = svc as unknown as {
    resolveItemLabels: () => Promise<Map<string, { name: string; code: string }>>;
    reservedByItem: () => Promise<Map<string, Decimal>>;
  };
  jest.spyOn(internals, 'resolveItemLabels').mockResolvedValue(
    new Map([
      ['COIL:c1', { name: 'ALZ-ROJO-0.30', code: 'B-1' }],
      ['COIL:c2', { name: 'ALZ-ROJO-0.30', code: 'B-2' }],
      ['PRODUCT:p1', { name: 'Tornillo', code: 'TOR' }],
    ]),
  );
  // 200 kg de c1 están reservados: su disponible es 800.
  jest
    .spyOn(internals, 'reservedByItem')
    .mockResolvedValue(new Map([['COIL:c1', new Decimal(200)]]));
  return svc;
}

describe('InventoryService.summary — ML teórico del disponible (D-356)', () => {
  it('suma bobina por bobina el ML de su disponible, con su propio ancho', async () => {
    const summary = await service().summary('metallic-roofing', true);
    const row = summary.coils[0]!;
    const g = (w: string) => ({ widthMm: w, thicknessMm: '0.30', densityFactor: '7.85' });
    const expected = equivalentMeters(g('1000'), '800')!.plus(equivalentMeters(g('1200'), '500')!);
    expect(row.theoreticalMeters).toBe(expected.toFixed(3));
    expect(row.availableQty).toBe('1300.000');
    // Un producto de catálogo no tiene metro lineal.
    expect(summary.products[0]!.theoreticalMeters).toBeNull();
  });

  it('el Excel de «Bobinas por tipo» lleva la columna y enmascara costos como la pantalla', async () => {
    const withCosts = inventoryCoilTypesXlsx(await service().summary('metallic-roofing', true));
    expect(withCosts.filename).toBe('bobinas-por-tipo-coberturas-aluzinc.xlsx');
    const read = (buffer: Buffer) =>
      XLSX.utils.sheet_to_json<unknown[]>(
        XLSX.read(buffer, { type: 'buffer' }).Sheets['Bobinas por tipo']!,
        { header: 1 },
      );
    const rows = read(withCosts.buffer);
    const at = rows[0]!.indexOf('ML teórico (disponible)');
    expect(at).toBeGreaterThan(0);
    expect(rows[1]![0]).toBe('ALZ-ROJO-0.30');
    expect(typeof rows[1]![at]).toBe('number');
    expect(rows[0]).toContain('Valorizado (S/)');

    const masked = read(
      inventoryCoilTypesXlsx(await service().summary('metallic-roofing', false)).buffer,
    );
    expect(masked[0]).not.toContain('Valorizado (S/)');
    expect(masked[0]).toContain('ML teórico (disponible)');
  });
});
