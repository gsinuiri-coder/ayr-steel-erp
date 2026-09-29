import { Decimal } from '@ayr/shared';
import { ProductionService } from './production.service';

const D = (value: string) => new Decimal(value);

function order(kind: 'ROOFING' | 'DRYWALL', reports: unknown[]) {
  return {
    id: `${kind}-1`,
    seq: 1,
    kind,
    businessLine: { code: kind === 'ROOFING' ? 'METALLIC_ROOFING' : 'DRYWALL' },
    productId: 'product-1',
    product: {
      sku: 'SKU-1',
      name: 'Producto',
      unit: 'NIU',
      thicknessMm: null,
      widthMm: null,
      pieceWeightKg: null,
    },
    status: 'CLOSED',
    targetPieces: 2,
    reservationId: null,
    reservation: null,
    priorityAt: null,
    priorityReason: null,
    priorityById: null,
    notes: null,
    items: kind === 'ROOFING' ? [{ lengthMm: D('3000'), qty: 2 }] : [],
    consumptions: [],
    reports,
    scrapKg: null,
    consumedKg: null,
    materialCostPen: null,
    overheadCostPen: null,
    totalCostPen: null,
    unitCostPen: null,
    operationDate: new Date('2026-09-20T00:00:00Z'),
    closedOperationDate: null,
    createdAt: new Date('2026-09-20T00:00:00Z'),
    createdById: 'actor-1',
    closedAt: null,
    cancelledAt: null,
  };
}

describe('ProductionService.findAll — avance en metros de plancha', () => {
  it('lee largos de reportes vigentes sin cambiar los metros de kardex ni agregar consultas por OP', async () => {
    const findMany = jest.fn().mockResolvedValue([
      order('ROOFING', [
        {
          status: 'ACTIVE',
          pieces: 2,
          metersM: null,
          piecesDetail: [{ lengthMm: D('3000'), qty: 2 }],
        },
        {
          status: 'REVERSED',
          pieces: 1,
          metersM: null,
          piecesDetail: [{ lengthMm: D('3000'), qty: 1 }],
        },
      ]),
      order('DRYWALL', [{ status: 'ACTIVE', pieces: 2, metersM: null, piecesDetail: [] }]),
    ]);
    const userFindMany = jest.fn().mockResolvedValue([{ id: 'actor-1', name: 'Operador' }]);
    const service = new ProductionService(
      { productionOrder: { findMany }, user: { findMany: userFindMany } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const rows = await service.findAll({});

    expect(rows[0]).toMatchObject({
      piecesReported: 2,
      metersReported: null,
      planMetersReported: '6.000',
      planMeters: '6.000',
    });
    expect(rows[1]).toMatchObject({
      metersReported: null,
      planMetersReported: null,
      planMeters: null,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          reports: expect.objectContaining({
            select: expect.objectContaining({ piecesDetail: expect.any(Object) }),
          }),
        }),
      }),
    );
  });

  it('conserva metros registrados para MTR y muestra cero antes del primer reporte', async () => {
    const withMeters = order('ROOFING', [
      {
        status: 'ACTIVE',
        pieces: 2,
        metersM: D('5.999'),
        piecesDetail: [{ lengthMm: D('3000'), qty: 2 }],
      },
    ]);
    withMeters.product.unit = 'MTR';
    const findMany = jest.fn().mockResolvedValue([withMeters, order('ROOFING', [])]);
    const service = new ProductionService(
      {
        productionOrder: { findMany },
        user: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const rows = await service.findAll({});

    expect(rows[0]).toMatchObject({ metersReported: '5.999', planMetersReported: '5.999' });
    expect(rows[1]).toMatchObject({ metersReported: null, planMetersReported: '0.000' });
  });
});
