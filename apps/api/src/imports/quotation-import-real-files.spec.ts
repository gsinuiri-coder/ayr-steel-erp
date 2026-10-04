import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { importPaperUnit } from '@ayr/shared';
import type { CustomersService } from '../customers/customers.service';
import type { DocumentLookupService } from '../customers/document-lookup.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { QuotationsService } from '../sales/quotations.service';
import { parseSpreadsheet } from './parse-spreadsheet';
import { QuotationImportService } from './quotation-import.service';

/**
 * D-385 — no regresión contra los archivos **reales** del dueño, que viven en `local-data/` y
 * nunca entran a git (§3.3). En la CI no están y estos tests se saltan; se corren en local:
 * desde el checkout principal tal cual, o desde un worktree con `AYR_LOCAL_DATA` apuntando a la
 * `local-data/` del checkout principal.
 *
 * La base es falsa: el catálogo devuelve, para cada SKU del archivo, un producto en la unidad que
 * el papel dice (lo que hoy tiene el maestro: el conformado en TNE, el resto como viene). Lo que
 * se mide es la lectura de la cantidad, no la resolución contra el maestro.
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('../sales/reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
}));

const LOCAL_DATA = process.env.AYR_LOCAL_DATA ?? resolve(__dirname, '../../../../local-data');
const AUGUST = join(LOCAL_DATA, 'ventas-agosto-2026.xlsx');
const SEPTEMBER = join(LOCAL_DATA, 'VENTAS SETIEMBRE.xlsx');

function field(row: Record<string, unknown>, header: string): string {
  const key = Object.keys(row).find((k) => k.trim().toUpperCase() === header);
  const value = key === undefined ? undefined : row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function serviceFor(buffer: Buffer): QuotationImportService {
  const raw = parseSpreadsheet(buffer);
  // El maestro: un producto por SKU, en la unidad del papel; las bobinas sin stock.
  const unitBySku = new Map(
    raw.map((r) => [
      field(r, 'CÓDIGO PRODUCTO'),
      importPaperUnit(field(r, 'UNIDAD MEDIDA')) ?? 'NIU',
    ]),
  );
  const prisma = {
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    product: {
      findMany: jest.fn(({ where }: { where: { sku: { in: string[] } } }) =>
        Promise.resolve(
          where.sku.in.map((sku) => ({
            id: `p-${sku}`,
            sku,
            name: sku,
            unit: unitBySku.get(sku) ?? 'NIU',
            roofingKind: null,
          })),
        ),
      ),
      findFirst: jest.fn(({ where }: { where: { sku: string } }) =>
        Promise.resolve({
          id: `p-${where.sku}`,
          sku: where.sku,
          name: where.sku,
          businessLineId: 'bl-t',
        }),
      ),
    },
    quotation: { findMany: jest.fn().mockResolvedValue([]) },
    color: {
      findMany: jest
        .fn()
        .mockResolvedValue(['AZUL', 'ROJO', 'VERDE', 'BLANCO', 'GRIS'].map((code) => ({ code }))),
    },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    coil: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
    quotationItem: { findMany: jest.fn().mockResolvedValue([]) },
    finish: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return new QuotationImportService(
    prisma as unknown as PrismaService,
    {} as QuotationsService,
    {} as CustomersService,
    { lookup: jest.fn().mockResolvedValue({ found: false }) } as unknown as DocumentLookupService,
    { ROOFING_THICKNESS_TOLERANCE_MM: '' },
  );
}

(existsSync(AUGUST) ? describe : describe.skip)('D-385 — agosto real (kg) se importa igual', () => {
  it('ninguna fila se convierte ni pierde su unidad; el conformado sigue en toneladas', async () => {
    const buffer = readFileSync(AUGUST);
    const raw = parseSpreadsheet(buffer);
    const { rows } = await serviceFor(buffer).preview('ventas-agosto-2026.xlsx', buffer);
    expect(rows).toHaveLength(raw.length);
    for (const [i, row] of rows.entries()) {
      const paperQty = new Prisma.Decimal(field(raw[i] ?? {}, 'CANTIDAD'));
      expect(row.unitConversion).toBeNull();
      expect(row.qty).toBe(paperQty.toFixed(3));
      expect(row.issues.some((x) => x.message.includes('no se reconoce'))).toBe(false);
    }
    const conformado = rows.find((r) => r.rawSku === 'CONFORMADO');
    expect(conformado?.qty).toBe('30.260');
  });
});

(existsSync(SEPTEMBER) ? describe : describe.skip)('D-385 — setiembre real (FFA1-1419)', () => {
  it('BOB030AZUL 4.192 TONELADA → 4192 kg, importe del papel, sin bobina asignada', async () => {
    const buffer = readFileSync(SEPTEMBER);
    const { rows } = await serviceFor(buffer).preview('VENTAS SETIEMBRE.xlsx', buffer);
    const row = rows.find((r) => r.documentKey === 'FFA1-1419' && r.rawSku === 'BOB030AZUL');
    expect(row).toMatchObject({
      issueDate: '2026-09-08',
      coilLine: true,
      productSku: 'BOB030AZUL',
      qty: '4192.000',
      netAmountPen: '12789.1500',
      unitConversion: { paperQty: '4.192', paperUnit: 'TONELADA' },
      saleCoilId: null,
    });
    // Sin bobina libre la fila no se bloquea por la bobina: entra marcada.
    expect(row?.issues.filter((i) => i.field === 'product' && i.severity === 'error')).toEqual([]);
    expect(row?.issues.some((i) => i.message.includes('sin bobina asignada'))).toBe(true);
  });
});
