import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessLineCode } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { OperationDateService } from '../common/operation-date.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { InitialInventoryProductImportService } from './initial-inventory-product-import.service';
import * as parseSpreadsheetModule from './parse-spreadsheet';
import type * as ParseSpreadsheetModule from './parse-spreadsheet';

/**
 * D-347 (hallazgo del segundo modelo, revisión de M6) — `inventory_movements.item_id` es
 * polimórfico, sin FK hacia `products`: el `FOR UPDATE` que toma `CatalogService.remove()` no
 * bloquea, por sí solo, un `INSERT` de esta herramienta contra el mismo producto. Este archivo
 * prueba el lock a mano y la revalidación de existencia que lo cierran, sin necesitar una
 * carrera real contra Postgres: el `tx.product.findMany` de la revalidación es el punto donde se
 * simula que `remove()` ganó la carrera.
 */

jest.mock('./parse-spreadsheet', () => ({
  ...jest.requireActual<typeof ParseSpreadsheetModule>('./parse-spreadsheet'),
  parseSpreadsheet: jest.fn(),
}));

const ACTOR = { id: 'admin-1' } as never;
const PRODUCT = {
  id: 'p-1',
  sku: 'UPVC01',
  unit: 'NIU',
  isActive: true,
  source: 'PURCHASED' as const,
  businessLineId: 'bl-roofing',
  businessLine: { code: BusinessLineCode.ROOFING },
};

const ROW = {
  'SKU PRODUCTO': PRODUCT.sku,
  UNIDADES: '10',
  'COSTO UNITARIO (SIN IGV)': '5',
  MONEDA: 'PEN',
  'TIPO DE CAMBIO': '',
  'FACTURA DE REFERENCIA': '',
  'FECHA DE REFERENCIA': '',
};

describe('InitialInventoryProductImportService — carrera con un borrado concurrente (D-347)', () => {
  let service: InitialInventoryProductImportService;
  const prisma = {
    product: {
      findMany: jest.fn(),
    },
    inventoryMovement: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  const inventory = { record: jest.fn().mockResolvedValue({ id: 'mov-1' }) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const operationDateService = { resolve: jest.fn().mockReturnValue('2026-09-27') };

  beforeEach(async () => {
    jest.clearAllMocks();
    (parseSpreadsheetModule.parseSpreadsheet as jest.Mock).mockReturnValue([ROW]);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    operationDateService.resolve.mockReturnValue('2026-09-27');
    const moduleRef = await Test.createTestingModule({
      providers: [
        InitialInventoryProductImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: AuditService, useValue: audit },
        { provide: OperationDateService, useValue: operationDateService },
      ],
    }).compile();
    service = moduleRef.get(InitialInventoryProductImportService);
  });

  function txWith(stillExists: boolean) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      product: {
        findMany: jest.fn().mockResolvedValue(stillExists ? [{ id: PRODUCT.id }] : []),
      },
    };
    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => unknown, _opts?: unknown) => cb(tx) as Promise<unknown>,
    );
    return tx;
  }

  it('el producto sigue existiendo al tomar el lock: registra el movimiento normal', async () => {
    // Fuera de la transacción (pre-validación): el producto existe.
    prisma.product.findMany.mockResolvedValueOnce([PRODUCT]);
    const tx = txWith(true);

    const report = await service.run(ACTOR, {
      buffer: Buffer.from(''),
      fileName: 'x.csv',
      execute: true,
      batchId: 'batch-1',
    });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(inventory.record).toHaveBeenCalledTimes(1);
    expect(report.executed).toBe(true);
    expect(report.rows[0]?.created).toBe(true);
  });

  it(
    'remove() ganó la carrera y borró el producto justo antes del lock: la carga entera se ' +
      'frena, sin dejar un movimiento huérfano',
    async () => {
      prisma.product.findMany.mockResolvedValueOnce([PRODUCT]);
      const tx = txWith(false);

      let error: unknown;
      try {
        await service.run(ACTOR, {
          buffer: Buffer.from(''),
          fileName: 'x.csv',
          execute: true,
          batchId: 'batch-1',
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(
        /UPVC01 se borró del catálogo justo antes de esta carga/,
      );

      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(inventory.record).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    },
  );
});
