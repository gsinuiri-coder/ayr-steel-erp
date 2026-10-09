import { Test } from '@nestjs/testing';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  FinishKind,
  Prisma,
  ProductSource,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  computePriceFloorOutcomes,
  computePriceFloors,
  type PriceFloorCandidate,
} from './price-floor';
import {
  productFloorCost,
  staticNoFloorReason,
  stripSkuNoFloorReason,
  type FloorCostProduct,
} from './price-floor-cost';

/**
 * D-342/D-344 — el piso de precio de un perfil de drywall sale de su **SKU**: kilos de la pieza ×
 * costo por kilo ponderado de los flejes galvanizados de su espesor y su ancho, por la misma
 * `computePriceFloors` (D-163) que ya usa una cobertura. Aquí se prueba la regla —qué producto usa
 * qué costo, qué flejes cuentan, cómo se pondera, por qué falta el piso— y que las coberturas de
 * aluzinc siguen exactamente como estaban.
 */

const D = (v: string) => new Prisma.Decimal(v);
const BL = 'bl-drywall';

function profile(over: Partial<FloorCostProduct> = {}): FloorCostProduct {
  return {
    id: 'perfil-1',
    source: ProductSource.MANUFACTURED,
    pieceWeightKg: D('2.000'),
    thicknessMm: D('0.45'),
    widthMm: D('120.00'),
    businessLine: { code: BusinessLineCode.DRYWALL },
    businessLineId: BL,
    ...over,
  };
}

describe('productFloorCost: de dónde sale el costo del piso', () => {
  it('perfil de drywall con espesor, ancho y peso en el SKU: costo de flejes, con el peso declarado tal cual', () => {
    const r = productFloorCost(profile());
    expect(r).toEqual({
      cost: {
        kind: 'STRIP_SKU',
        businessLineId: BL,
        thicknessMm: '0.45',
        widthMm: '120.00',
        kgPerUnit: expect.anything() as unknown,
      },
    });
    // El 1 % de merma ya está dentro del peso declarado (D-165): no se suma otra vez.
    const cost = (r as { cost: { kgPerUnit: { toFixed(n: number): string } } }).cost;
    expect(cost.kgPerUnit.toFixed(3)).toBe('2.000');
  });

  it.each([
    ['sin espesor', { thicknessMm: null }, 'NO_THICKNESS'],
    ['espesor en cero', { thicknessMm: D('0') }, 'NO_THICKNESS'],
    ['sin ancho del fleje', { widthMm: null }, 'NO_WIDTH'],
    ['ancho en cero', { widthMm: D('0') }, 'NO_WIDTH'],
    ['sin peso por pieza', { pieceWeightKg: null }, 'NO_PIECE_WEIGHT'],
    ['peso en cero', { pieceWeightKg: D('0') }, 'NO_PIECE_WEIGHT'],
  ] as const)('%s: motivo %s', (_name, over, reason) => {
    expect(productFloorCost(profile(over))).toEqual({ noFloorReason: reason });
    expect(staticNoFloorReason(profile(over))).toBe(reason);
  });

  it('el espesor se dice primero: es lo que el dueño tiene que cargar', () => {
    expect(
      productFloorCost(profile({ thicknessMm: null, widthMm: null, pieceWeightKg: null })),
    ).toEqual({ noFloorReason: 'NO_THICKNESS' });
    expect(productFloorCost(profile({ widthMm: null, pieceWeightKg: null }))).toEqual({
      noFloorReason: 'NO_WIDTH',
    });
  });

  it('un perfil completo no tiene motivo estático (el de flejes y margen depende de hoy)', () => {
    expect(staticNoFloorReason(profile())).toBeNull();
  });

  it('el motivo de un candidato sin piso distingue falta de costo de falta de margen', () => {
    expect(stripSkuNoFloorReason('NO_COST')).toBe('NO_COMPATIBLE_STRIPS');
    expect(stripSkuNoFloorReason('NO_MARGIN')).toBe('NO_MARGIN');
  });

  describe('lo que NO es un perfil de drywall queda exactamente como estaba (costo del kardex)', () => {
    it.each([
      ['drywall comprado', { source: ProductSource.PURCHASED }],
      ['trading', { businessLine: { code: BusinessLineCode.TRADING } }],
      ['servicios', { businessLine: { code: BusinessLineCode.SERVICES } }],
      // Cobertura de aluzinc (fabricada, línea Metallic Roofing): su costo sale de la bobina en
      // cotización y del kardex donde nunca hubo receta; esta función no la toca.
      [
        'cobertura de aluzinc',
        {
          businessLine: { code: BusinessLineCode.METALLIC_ROOFING },
          thicknessMm: null,
          widthMm: null,
        },
      ],
    ] as const)('%s', (_name, over) => {
      expect(productFloorCost(profile(over))).toEqual({
        cost: { kind: 'PRODUCT', productId: 'perfil-1' },
      });
      expect(staticNoFloorReason(profile(over))).toBeNull();
    });
  });
});

describe('computePriceFloors con STRIP_SKU', () => {
  interface Strip {
    id: string;
    status?: CoilStatus;
    thicknessMm?: string;
    widthMm?: string;
    finishKind?: FinishKind;
    qty: string;
    avgCost: string;
  }

  interface StripWhere {
    kind: CoilKind;
    status: CoilStatus;
    businessLineId: string;
    finish: { kind: FinishKind };
    thicknessMm: string;
    widthMm: string;
  }

  /**
   * Una base falsa que **filtra como la real**: `coil.findMany` respeta cada término del `OR`
   * (`kind`, `status`, línea, tipo de acabado, espesor y ancho); así un fleje anulado, cerrado, de
   * otro ancho o de un acabado que no es galvanizado queda fuera por la misma razón por la que
   * quedaría fuera de la base.
   */
  function fakeTx(strips: Strip[], minMarginPct: string | null = '10.0000') {
    const coilFindMany = jest.fn().mockImplementation((args: { where: { OR: StripWhere[] } }) =>
      Promise.resolve(
        strips
          .filter((s) =>
            args.where.OR.some(
              (o) =>
                o.kind === CoilKind.STRIP &&
                o.status === (s.status ?? CoilStatus.OPEN) &&
                o.businessLineId === BL &&
                o.finish.kind === (s.finishKind ?? FinishKind.GALVANIZADO) &&
                o.thicknessMm === (s.thicknessMm ?? '0.45') &&
                o.widthMm === (s.widthMm ?? '120.00'),
            ),
          )
          .map((s) => ({
            id: s.id,
            businessLineId: BL,
            thicknessMm: D(s.thicknessMm ?? '0.45'),
            widthMm: D(s.widthMm ?? '120.00'),
          })),
      ),
    );
    const tx = {
      pricingSetting: {
        findMany: jest.fn().mockResolvedValue(
          minMarginPct === null
            ? []
            : [
                {
                  businessLineId: BL,
                  minMarginPct: D(minMarginPct),
                  businessLine: { code: 'DRYWALL' },
                },
              ],
        ),
      },
      coil: { findMany: coilFindMany },
      inventoryBalance: {
        findMany: jest.fn().mockImplementation((args: { where: { itemId: { in: string[] } } }) => {
          const ids = new Set(args.where.itemId.in);
          return Promise.resolve(
            strips
              .filter((s) => ids.has(s.id))
              .map((s) => ({ itemId: s.id, qty: D(s.qty), avgCost: D(s.avgCost) })),
          );
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, coilFindMany };
  }

  const skuCost = (kg = '2.000') => {
    const r = productFloorCost(profile({ pieceWeightKg: D(kg) }));
    if (!('cost' in r)) throw new Error('el SKU de prueba debe dar costo');
    return r.cost;
  };
  const candidate = (over: Partial<PriceFloorCandidate> = {}): PriceFloorCandidate => ({
    at: 'Línea 1',
    sku: 'PERFIL-1',
    businessLineId: BL,
    basis: { kind: 'UNIT', unitLabel: 'NIU' },
    unitValuePen: '0',
    cost: skuCost(),
    ...over,
  });

  it('el costo es peso × costo por kilo ponderado por los kilos que hay (no el promedio simple)', async () => {
    // 100 kg a S/ 5 y 300 kg a S/ 7: ponderado 6.50, no 6.00. × 2 kg por pieza = S/ 13.00.
    const { tx } = fakeTx([
      { id: 's1', qty: '100', avgCost: '5' },
      { id: 's2', qty: '300', avgCost: '7' },
    ]);
    const floors = await computePriceFloors(tx, [candidate()], '0.05');
    const floor = floors.get('Línea 1');
    expect(floor?.costPen).toBe('13.0000');
    // Margen mínimo del 10 % sobre la venta: 13 ÷ 0.90 = 14.4444 sin IGV.
    expect(floor?.minValuePen).toBe('14.4444');
  });

  it('un fleje con saldo cero o negativo no pesa', async () => {
    const { tx } = fakeTx([
      { id: 's1', qty: '100', avgCost: '5' },
      { id: 's2', qty: '0', avgCost: '99' },
      { id: 's3', qty: '-40', avgCost: '99' },
    ]);
    const floors = await computePriceFloors(tx, [candidate()], '0.05');
    expect(floors.get('Línea 1')?.costPen).toBe('10.0000');
  });

  it('solo cuentan los flejes abiertos, galvanizados y del espesor y ancho exactos del SKU', async () => {
    const { tx, coilFindMany } = fakeTx([
      { id: 'ok', qty: '100', avgCost: '5' },
      { id: 'cerrado', status: CoilStatus.CLOSED, qty: '100', avgCost: '50' },
      { id: 'anulado', status: CoilStatus.CANCELLED, qty: '100', avgCost: '50' },
      { id: 'tercero', status: CoilStatus.IN_THIRD_PARTY, qty: '100', avgCost: '50' },
      { id: 'otro-ancho', widthMm: '150.00', qty: '100', avgCost: '50' },
      { id: 'otro-espesor', thicknessMm: '0.60', qty: '100', avgCost: '50' },
      // Sin tolerancia: 0.46 no es 0.45 (drywall compara el espesor exacto).
      { id: 'espesor-cercano', thicknessMm: '0.46', qty: '100', avgCost: '50' },
      { id: 'no-galvanizado', finishKind: FinishKind.NATURAL, qty: '100', avgCost: '50' },
    ]);
    const floors = await computePriceFloors(tx, [candidate()], '0.05');
    expect(floors.get('Línea 1')?.costPen).toBe('10.0000');
    // La consulta es la de `drywallStripWhere`: lo mismo que el selector de `/planta`, no una
    // definición paralela.
    expect(coilFindMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            kind: CoilKind.STRIP,
            status: CoilStatus.OPEN,
            businessLineId: BL,
            finish: { kind: FinishKind.GALVANIZADO },
            thicknessMm: '0.45',
            widthMm: '120.00',
          },
        ],
      },
      select: { id: true, businessLineId: true, thicknessMm: true, widthMm: true },
    });
  });

  it('sin flejes con saldo no hay costo y por tanto no hay piso (D-163)', async () => {
    const empty = fakeTx([]);
    expect((await computePriceFloors(empty.tx, [candidate()], '0.05')).size).toBe(0);
    const zeroed = fakeTx([{ id: 's1', qty: '0', avgCost: '5' }]);
    expect((await computePriceFloors(zeroed.tx, [candidate()], '0.05')).size).toBe(0);
  });

  it('sin margen mínimo configurado tampoco hay piso, como con cualquier otro costo', async () => {
    const { tx } = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }], null);
    expect((await computePriceFloors(tx, [candidate()], '0.05')).size).toBe(0);
  });

  it('los resultados dicen por qué falta el piso: sin costo (flejes) o sin margen', async () => {
    const noCost = fakeTx([]);
    const a = await computePriceFloorOutcomes(noCost.tx, [candidate()], '0.05');
    expect(a.get('Línea 1')).toEqual({ missing: 'NO_COST' });

    const noMargin = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }], null);
    const b = await computePriceFloorOutcomes(noMargin.tx, [candidate()], '0.05');
    expect(b.get('Línea 1')).toEqual({ missing: 'NO_MARGIN' });

    const ok = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }]);
    const c = await computePriceFloorOutcomes(ok.tx, [candidate()], '0.05');
    expect(c.get('Línea 1')).toMatchObject({ costPen: '10.0000' });
  });

  it('dos perfiles con el mismo fleje y distinto peso comparten la lectura de flejes', async () => {
    const { tx, coilFindMany } = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }]);
    const floors = await computePriceFloors(
      tx,
      [
        candidate({ at: 'A', cost: skuCost('2.000') }),
        candidate({ at: 'B', cost: skuCost('3.000') }),
      ],
      '0.05',
    );
    expect(floors.get('A')?.costPen).toBe('10.0000');
    expect(floors.get('B')?.costPen).toBe('15.0000');
    // Una sola consulta de flejes para todo el lote, no una por perfil.
    expect(coilFindMany).toHaveBeenCalledTimes(1);
  });

  it('sin candidatos STRIP_SKU no consulta flejes (las coberturas y el kardex no pagan nada nuevo)', async () => {
    const { tx, coilFindMany } = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }]);
    await computePriceFloors(
      tx,
      [candidate({ cost: { kind: 'PRODUCT', productId: 'x' } })],
      '0.05',
    );
    expect(coilFindMany).not.toHaveBeenCalled();
  });

  it('equivalencia con el agregado de una cobertura: mismos saldos, mismo costo por kilo', async () => {
    const balances = [
      { id: 'r1', qty: '100', avgCost: '5' },
      { id: 'r2', qty: '300', avgCost: '7' },
    ];
    const strip = fakeTx(balances);
    const viaStrips = await computePriceFloors(strip.tx, [candidate()], '0.05');

    // La misma cuenta por el camino de la cobertura: bobinas de una spec, mismos kilos y costos.
    const spec = { id: 'spec-1', businessLineId: BL, colorId: 'c-1', thicknessMm: '0.45' };
    const rawTx = {
      pricingSetting: strip.tx.pricingSetting,
      coil: {
        findMany: jest.fn().mockResolvedValue(
          balances.map((b) => ({
            id: b.id,
            businessLineId: BL,
            colorId: 'c-1',
            thicknessMm: D('0.45'),
          })),
        ),
      },
      inventoryBalance: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            balances.map((b) => ({ itemId: b.id, qty: D(b.qty), avgCost: D(b.avgCost) })),
          ),
      },
    } as unknown as Prisma.TransactionClient;
    const viaRaw = await computePriceFloors(
      rawTx,
      [candidate({ cost: { kind: 'RAW_MATERIAL', spec, kgPerUnit: D('2.000') } as never })],
      '0.05',
    );
    expect(viaRaw.get('Línea 1')?.costPen).toBe('13.0000');
    expect(viaStrips.get('Línea 1')).toEqual(viaRaw.get('Línea 1'));
  });
});

describe('CatalogService.priceFloor y el marcador «sin piso» (D-342/D-344)', () => {
  let service: CatalogService;
  let prisma: {
    product: { findUnique: jest.Mock };
    pricingSetting: { findMany: jest.Mock };
    coil: { findMany: jest.Mock };
    inventoryBalance: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const productRow = (over: Record<string, unknown> = {}) => ({
    sku: 'PERFIL-1',
    unit: 'NIU',
    ...profile(),
    ...over,
  });
  const margin = () => [
    { businessLineId: BL, minMarginPct: D('10.0000'), businessLine: { code: 'DRYWALL' } },
  ];

  beforeEach(async () => {
    prisma = {
      product: { findUnique: jest.fn() },
      pricingSetting: { findMany: jest.fn().mockResolvedValue(margin()) },
      coil: { findMany: jest.fn().mockResolvedValue([]) },
      inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ColorsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  it('perfil sin espesor: sin piso y dice por qué, sin tocar flejes ni saldos', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow({ thicknessMm: null }));
    await expect(service.priceFloor('perfil-1')).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_THICKNESS',
    });
    expect(prisma.coil.findMany).not.toHaveBeenCalled();
  });

  it('perfil con el SKU completo pero sin flejes con saldo: «Sin flejes compatibles»', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    await expect(service.priceFloor('perfil-1')).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_COMPATIBLE_STRIPS',
    });
  });

  it('con flejes con saldo pero sin margen configurado: «Sin margen», no «sin flejes» (P2 de 03b)', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    prisma.pricingSetting.findMany.mockResolvedValue([]);
    prisma.coil.findMany.mockResolvedValue([
      { id: 's1', businessLineId: BL, thicknessMm: D('0.45'), widthMm: D('120.00') },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 's1', qty: D('100'), avgCost: D('5') },
    ]);
    await expect(service.priceFloor('perfil-1')).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_MARGIN',
    });
  });

  it('perfil con el SKU completo y flejes con saldo: el piso sale del SKU y no hay motivo', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    prisma.coil.findMany.mockResolvedValue([
      { id: 's1', businessLineId: BL, thicknessMm: D('0.45'), widthMm: D('120.00') },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 's1', qty: D('100'), avgCost: D('5') },
    ]);
    const floor = await service.priceFloor('perfil-1');
    // 2 kg × S/ 5 = 10.00 → ÷ 0.90 × 1.18 = 13.1111, y el mínimo tipeable sube al 13.12 que sí llega al piso (D-163).
    expect(floor).toEqual({ minPricePen: '13.12', priceUnitLabel: 'und', noFloorReason: null });
  });

  it('un producto que no es perfil de drywall no cambia: costo del kardex y sin motivo', async () => {
    prisma.product.findUnique.mockResolvedValue(
      productRow({ businessLine: { code: BusinessLineCode.TRADING } }),
    );
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 'perfil-1', qty: D('10'), avgCost: D('9') },
    ]);
    const floor = await service.priceFloor('perfil-1');
    expect(floor.noFloorReason).toBeNull();
    expect(floor.minPricePen).not.toBeNull();
    expect(prisma.coil.findMany).not.toHaveBeenCalled();
  });
});
