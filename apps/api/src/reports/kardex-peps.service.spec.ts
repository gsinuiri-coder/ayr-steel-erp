import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { kardexPepsXlsx } from './kardex-peps-xlsx';
import { UNIT_TABLE_6, UNITS } from '@ayr/shared';
import {
  KardexPepsService,
  pepsCorrectedCosts,
  reportUnit,
  unitTable6,
} from './kardex-peps.service';

/**
 * D-279. El cálculo PEPS se prueba en `kardex-peps.spec.ts`; acá, lo que el servicio agrega:
 * de dónde sale el comprobante de cada fila (tabla 10), el tipo de operación (tabla 12), que
 * el saldo inicial usa lo anterior al rango y que el xlsx lleva números, no texto.
 */

const COIL_ID = '11111111-1111-1111-1111-111111111111';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dec = (s: string) => new Prisma.Decimal(s);

function movement(
  id: number,
  type: 'IN' | 'OUT' | 'ADJUST',
  qty: string,
  totalCost: string,
  date: string,
  refType: string,
  refId: string | null,
) {
  return {
    id: BigInt(id),
    type,
    qty: dec(qty),
    unit: 'KGM',
    totalCost: dec(totalCost),
    refType,
    refId,
    notes: null,
    reversalOfId: null,
    recostOfId: null,
    operationDate: d(date),
  };
}

function build() {
  const prisma = {
    coil: {
      findUnique: jest.fn().mockResolvedValue({ code: 'BOB-001', typeKey: 'GALV-0.50' }),
    },
    product: { findUnique: jest.fn() },
    inventoryMovement: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          movement(1, 'IN', '100.000', '1000.0000', '2026-08-10', 'PURCHASE', 'p-1'),
          movement(2, 'IN', '50.000', '600.0000', '2026-09-02', 'PURCHASE', 'p-2'),
          movement(3, 'OUT', '120.000', '1333.3333', '2026-09-03', 'SALE', 'd-1'),
        ]),
    },
    dispatch: {
      findMany: jest.fn().mockResolvedValue([{ id: 'd-1', seq: 7, invoiceId: 'f-1' }]),
    },
    purchase: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'p-2', docType: 'FACTURA', series: 'E001', number: '55' }]),
    },
    productionReport: { findMany: jest.fn() },
    productionOrder: { findMany: jest.fn() },
    fiscalDocument: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'f-1', docType: 'FACTURA', number: 'F001-00000123' }]),
    },
  };
  const env = { COMPANY_RUC: '20123456789', COMPANY_LEGAL_NAME: 'AYR SAC' } as Env;
  return { prisma, service: new KardexPepsService(prisma as unknown as PrismaService, env) };
}

describe('KardexPepsService', () => {
  const query = {
    itemType: 'COIL' as const,
    itemId: COIL_ID,
    from: '2026-09-01',
    to: '2026-09-30',
  };

  it('cc58 (D-685, E-11): las capas toman el costo corregido de sus entradas; el recosteo de una salida no entra', async () => {
    const { prisma, service } = build();
    prisma.inventoryMovement.findMany.mockResolvedValue([
      movement(1, 'IN', '100.000', '1000.0000', '2026-08-10', 'PURCHASE', 'p-1'),
      movement(2, 'IN', '50.000', '600.0000', '2026-09-02', 'PURCHASE', 'p-2'),
      movement(3, 'OUT', '120.000', '1333.3333', '2026-09-03', 'SALE', 'd-1'),
      // El flete de la primera compra llegó tarde: +100 a su entrada, y la salida se recosteó.
      {
        ...movement(4, 'ADJUST', '100.000', '100.0000', '2026-08-10', 'PURCHASE', 'p-1'),
        recostOfId: 1n,
      },
      {
        ...movement(5, 'ADJUST', '120.000', '-80.0000', '2026-09-03', 'SALE', 'd-1'),
        recostOfId: 3n,
      },
    ]);
    const report = await service.report(query);
    // La capa de la primera compra vale 1100 (no 1000): el saldo inicial y la salida lo llevan.
    expect(report.peps.opening.total).toBe('1100.0000');
    // 100 kg a 11 + 20 kg a 12 = 1340.
    expect(report.peps.rows.map((r) => r.movementId)).toEqual(['2', '3']);
    expect(report.peps.rows[1]?.outTotal).toBe('1340.0000');
  });

  it('pepsCorrectedCosts suma los recosteos de entradas y ajustes, no los de salidas', () => {
    const rows = [
      { id: 1n, type: 'IN' as const, totalCost: '10.0000', recostOfId: null },
      { id: 2n, type: 'OUT' as const, totalCost: '4.0000', recostOfId: null },
      { id: 3n, type: 'ADJUST' as const, totalCost: '2.5000', recostOfId: 1n },
      { id: 4n, type: 'ADJUST' as const, totalCost: '-1.0000', recostOfId: 2n },
      { id: 5n, type: 'ADJUST' as const, totalCost: '-0.5000', recostOfId: 1n },
    ];
    expect([...pepsCorrectedCosts(rows)]).toEqual([[1n, '12.0000']]);
  });

  it('arma el saldo inicial con lo anterior y resuelve comprobantes solo del rango', async () => {
    const { prisma, service } = build();
    const report = await service.report(query);

    expect(report.peps.opening.total).toBe('1000.0000');
    expect(report.peps.rows.map((r) => r.movementId)).toEqual(['2', '3']);
    expect(report.peps.rows[1]?.outTotal).toBe('1240.0000');
    // La compra anterior al rango no se consulta: su documento no se imprime.
    expect(prisma.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['p-2'] } } }),
    );
    expect(report.documents.get('2')).toMatchObject({
      docTypeCode: '01',
      series: 'E001',
      number: '55',
      operationCode: '02',
    });
    expect(report.documents.get('3')).toMatchObject({
      docTypeCode: '01',
      series: 'F001',
      number: '00000123',
      operationCode: '01',
    });
    expect(report.existenceType).toBe('03 - MATERIAS PRIMAS');
    expect(report.unitCode).toBe('KGM - KILOGRAMO');
  });

  it('el xlsx sigue el formato 13.1 con montos numéricos', async () => {
    const { service } = build();
    const file = kardexPepsXlsx(await service.report(query));
    const sheet = XLSX.read(file.buffer, { type: 'buffer' }).Sheets['Formato 13.1'];
    if (!sheet) throw new Error('falta la hoja');
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: null,
    });
    expect(rows[0]?.[0]).toMatch(/^FORMATO 13\.1/);
    expect(rows[2]).toEqual(expect.arrayContaining(['RUC:', '20123456789']));
    expect(rows[9]).toEqual(expect.arrayContaining(['MÉTODO DE VALUACIÓN:', 'PEPS']));
    const opening = rows.find((r) => r[4] === '16 - SALDO INICIAL');
    expect(opening?.[13]).toBe(1000);
    const sale = rows.find((r) => r[4] === '01 - VENTA');
    expect(sale?.slice(0, 4)).toEqual(['03/09/2026', '01', 'F001', '00000123']);
    expect(sale?.[10]).toBe(1240);
    expect(sale?.[13]).toBe(360);
    const totals = rows.find((r) => r[0] === 'TOTALES');
    expect(totals?.[7]).toBe(600);
    expect(totals?.[10]).toBe(1240);
    expect((sheet.N15 as XLSX.CellObject | undefined)?.t).toBe('n');
  });
});

describe('tabla 6 del formato 13.1 (cc68, D-725)', () => {
  it('cada unidad de la lista tiene su código de la tabla 6 vigente (R.S. 169-2015)', () => {
    for (const unit of UNITS) expect(UNIT_TABLE_6[unit]).toMatch(new RegExp(`^${unit} - `));
    expect(unitTable6('BX')).toBe('BX - CAJA');
    expect(unitTable6('NIU')).toBe('NIU - UNIDAD (BIENES)');
    expect(unitTable6('und')).toBe('99 - OTROS (und)');
  });

  it('la unidad es la del último movimiento del rango, no la del primero de la historia', () => {
    const moves = [
      { unit: 'NIU', operationDate: '2026-08-01' },
      { unit: 'NIU', operationDate: '2026-08-01' },
      { unit: 'BX', operationDate: '2026-11-03' },
    ];
    expect(reportUnit(moves, '2026-11-01', 'BX')).toBe('BX');
    // Agosto (el rango termina antes del primer movimiento en BX): NIU.
    expect(reportUnit(moves.slice(0, 2), '2026-08-01', 'BX')).toBe('NIU');
    // Sin movimientos en el rango, la del último anterior; sin ninguno, la del ítem.
    expect(reportUnit(moves.slice(0, 2), '2026-10-01', 'BX')).toBe('NIU');
    expect(reportUnit([], '2026-10-01', 'BX')).toBe('BX');
  });
});
