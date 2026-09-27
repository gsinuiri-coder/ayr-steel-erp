import { Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import { duplicateShapeChange } from './duplicate-shape';
import { QuotationsService } from './quotations.service';
import * as salesLines from './sales-lines';

jest.mock('./sales-lines', () => ({
  resolveSalesLines: jest.fn().mockResolvedValue([]),
  documentTotals: () => ({ subtotalPen: '0', igvPen: '0', totalPen: '0' }),
  toSalesItemDto: jest.fn(),
}));

/**
 * D-348 — el subtipo de un producto sin uso real puede cambiar, así que duplicar una cotización
 * anulada cuyo producto cambió de forma tiene que fallar **diciendo qué cambió**, nunca en
 * silencio ni con un «escribe los metros» que en un duplicado nadie puede escribir.
 */

const ACCESORIO = { unit: 'MTR', roofingKind: 'ACCESORIO' };
const A_MEDIDA = { unit: 'MTR', roofingKind: 'A_MEDIDA' };
const PLANCHA = { unit: 'NIU', roofingKind: 'PLANCHA' };

describe('duplicateShapeChange (D-348)', () => {
  it('la misma forma se copia tal cual', () => {
    expect(
      duplicateShapeChange({ unit: 'MTR', hasPieces: true, hasPiecesHint: false }, A_MEDIDA),
    ).toBeNull();
    expect(
      duplicateShapeChange({ unit: 'MTR', hasPieces: false, hasPiecesHint: true }, ACCESORIO),
    ).toBeNull();
    expect(
      duplicateShapeChange({ unit: 'NIU', hasPieces: false, hasPiecesHint: false }, PLANCHA),
    ).toBeNull();
  });

  it('a medida → accesorio: la línea traía largos', () => {
    expect(
      duplicateShapeChange({ unit: 'MTR', hasPieces: true, hasPiecesHint: false }, ACCESORIO),
    ).toMatch(/pasó a ser un accesorio/);
  });

  it('accesorio → a medida: faltan los largos', () => {
    expect(
      duplicateShapeChange({ unit: 'MTR', hasPieces: false, hasPiecesHint: true }, A_MEDIDA),
    ).toMatch(/pasó a llevar detalle de largos/);
  });

  it('accesorio → plancha: cambió la unidad', () => {
    expect(
      duplicateShapeChange({ unit: 'MTR', hasPieces: false, hasPiecesHint: false }, PLANCHA),
    ).toMatch(/cambió de unidad \(se cotizó en MTR, hoy se vende en NIU\)/);
  });

  it('piezas informativas en algo que dejó de ser accesorio', () => {
    expect(
      duplicateShapeChange(
        { unit: 'MTR', hasPieces: false, hasPiecesHint: true },
        { unit: 'MTR', roofingKind: null },
      ),
    ).toMatch(/pasó a llevar detalle de largos/);
  });
});

describe('QuotationsService.duplicate — producto que cambió de subtipo (D-348)', () => {
  it('rechaza con la cotización, la línea, el SKU y qué cambió; no crea nada', async () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const create = jest.fn();
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, {
      env: {},
      prisma: {
        quotation: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'q-1',
            seq: 3,
            status: 'CANCELLED',
            customerId: 'c-1',
            sellerId: 'u-1',
            notes: null,
            items: [
              {
                lineNumber: 1,
                productId: 'p-1',
                unit: 'MTR',
                qty: D('12'),
                subtotalPen: D('120'),
                valuePerMeterPen: null,
                piecesHint: null,
                pieces: [{ lengthMm: D('6000'), qty: 2 }],
                reserveItemType: 'RAW_MATERIAL',
                reserveItemId: 'spec-1',
                reserveQty: D('50'),
              },
            ],
          }),
        },
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p-1', sku: 'ACCES030ROJO', ...ACCESORIO }]),
        },
        $transaction: jest.fn(() => ({ quotation: { create } })),
      },
      audit: { write: jest.fn() },
    });

    await expect(
      svc.duplicate({ id: 'u-1', role: Role.ADMINISTRADOR } as never, 'q-1'),
    ).rejects.toThrow(
      /No se puede duplicar COT-000003: en la línea 1, ACCES030ROJO pasó a ser un accesorio .* desde que se cotizó/,
    );
    expect(salesLines.resolveSalesLines).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
