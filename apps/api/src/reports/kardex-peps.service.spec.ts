import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { kardexPepsXlsx } from './kardex-peps-xlsx';
import { KardexPepsService } from './kardex-peps.service';

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
    expect(report.unitCode).toBe('01 - KILOGRAMOS');
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
