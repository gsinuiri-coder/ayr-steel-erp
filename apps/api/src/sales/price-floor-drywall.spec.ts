import { Test } from '@nestjs/testing';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  Prisma,
  ProductBomKind,
  ProductSource,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { computePriceFloors, type PriceFloorCandidate } from './price-floor';
import { productFloorCost, staticNoFloorReason, type FloorCostProduct } from './price-floor-cost';

/**
 * D-342 — el piso de precio de un perfil de drywall sale de su receta: kilos de la pieza × costo
 * por kilo ponderado de los flejes compatibles, por la misma `computePriceFloors` (D-163) que ya
 * usa una cobertura. Aquí se prueba la regla —qué producto usa qué costo, qué flejes cuentan, cómo
 * se pondera— y que las coberturas de aluzinc siguen exactamente como estaban.
 */

const D = (v: string) => new Prisma.Decimal(v);
const BL = 'bl-drywall';
const FINISH = 'fin-1';

function profile(over: Partial<FloorCostProduct> = {}): FloorCostProduct {
  return {
    id: 'perfil-1',
    source: ProductSource.MANUFACTURED,
    pieceWeightKg: D('2.000'),
    businessLine: { code: BusinessLineCode.DRYWALL },
    businessLineId: BL,
    bom: {
      isActive: true,
      kind: ProductBomKind.DRYWALL,
      finishId: FINISH,
      inputThicknessMm: D('0.45'),
      inputWidthMm: D('120.00'),
    },
    ...over,
  };
}

describe('productFloorCost: de dónde sale el costo del piso', () => {
  it('perfil de drywall con receta activa y peso: costo de flejes, con el peso declarado tal cual', () => {
    const r = productFloorCost(profile());
    expect(r).toEqual({
      cost: {
        kind: 'STRIP_RECIPE',
        businessLineId: BL,
        finishId: FINISH,
        inputThicknessMm: '0.45',
        inputWidthMm: '120.00',
        kgPerUnit: expect.anything() as unknown,
      },
    });
    // El 1 % de merma ya está dentro del peso declarado (D-165): no se suma otra vez.
    const cost = (r as { cost: { kgPerUnit: { toFixed(n: number): string } } }).cost;
    expect(cost.kgPerUnit.toFixed(3)).toBe('2.000');
  });

  it.each([
    ['sin receta', { bom: null }],
    [
      'receta desactivada',
      {
        bom: {
          isActive: false,
          kind: ProductBomKind.DRYWALL,
          finishId: FINISH,
          inputThicknessMm: D('0.45'),
          inputWidthMm: D('120.00'),
        },
      },
    ],
    [
      'receta de otra clase',
      {
        bom: {
          isActive: true,
          kind: ProductBomKind.ROOFING,
          finishId: FINISH,
          inputThicknessMm: D('0.45'),
          inputWidthMm: null,
        },
      },
    ],
    [
      'receta sin ancho de fleje',
      {
        bom: {
          isActive: true,
          kind: ProductBomKind.DRYWALL,
          finishId: FINISH,
          inputThicknessMm: D('0.45'),
          inputWidthMm: null,
        },
      },
    ],
  ] as const)('%s: «Sin receta»', (_name, over) => {
    expect(productFloorCost(profile(over))).toEqual({ noFloorReason: 'NO_RECIPE' });
    expect(staticNoFloorReason(profile(over))).toBe('NO_RECIPE');
  });

  it('con receta pero sin peso por pieza: «Sin peso por pieza»', () => {
    expect(productFloorCost(profile({ pieceWeightKg: null }))).toEqual({
      noFloorReason: 'NO_PIECE_WEIGHT',
    });
    expect(productFloorCost(profile({ pieceWeightKg: D('0') }))).toEqual({
      noFloorReason: 'NO_PIECE_WEIGHT',
    });
  });

  it('un perfil completo no tiene motivo estático (el de flejes sin saldo depende de hoy)', () => {
    expect(staticNoFloorReason(profile())).toBeNull();
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
        { businessLine: { code: BusinessLineCode.METALLIC_ROOFING }, bom: null },
      ],
    ] as const)('%s', (_name, over) => {
      expect(productFloorCost(profile(over))).toEqual({
        cost: { kind: 'PRODUCT', productId: 'perfil-1' },
      });
      expect(staticNoFloorReason(profile(over))).toBeNull();
    });
  });
});

describe('computePriceFloors con STRIP_RECIPE', () => {
  interface Strip {
    id: string;
    status?: CoilStatus;
    thicknessMm?: string;
    widthMm?: string;
    finishId?: string;
    qty: string;
    avgCost: string;
  }

  /**
   * Una base falsa que **filtra como la real**: `coil.findMany` respeta `kind`, `status` y el
   * `OR` de combinaciones; así un fleje anulado, cerrado o de otro ancho queda fuera por la misma
   * razón por la que quedaría fuera de la base.
   */
  function fakeTx(strips: Strip[], minMarginPct: string | null = '10.0000') {
    const coilFindMany = jest.fn().mockImplementation(
      (args: {
        where: {
          kind: CoilKind;
          status: CoilStatus;
          OR: {
            businessLineId: string;
            finishId: string;
            thicknessMm: string;
            widthMm: string;
          }[];
        };
      }) =>
        Promise.resolve(
          strips
            .filter(
              (s) =>
                args.where.kind === CoilKind.STRIP &&
                (s.status ?? CoilStatus.OPEN) === args.where.status &&
                args.where.OR.some(
                  (o) =>
                    o.businessLineId === BL &&
                    o.finishId === (s.finishId ?? FINISH) &&
                    o.thicknessMm === (s.thicknessMm ?? '0.45') &&
                    o.widthMm === (s.widthMm ?? '120.00'),
                ),
            )
            .map((s) => ({
              id: s.id,
              businessLineId: BL,
              finishId: s.finishId ?? FINISH,
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

  const recipeCost = (kg = '2.000') => {
    const r = productFloorCost(profile({ pieceWeightKg: D(kg) }));
    if (!('cost' in r)) throw new Error('la receta de prueba debe dar costo');
    return r.cost;
  };
  const candidate = (over: Partial<PriceFloorCandidate> = {}): PriceFloorCandidate => ({
    at: 'Línea 1',
    sku: 'PERFIL-1',
    businessLineId: BL,
    basis: { kind: 'UNIT', unitLabel: 'NIU' },
    unitValuePen: '0',
    cost: recipeCost(),
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

  it('solo cuentan los flejes abiertos y de la combinación exacta de la receta', async () => {
    const { tx, coilFindMany } = fakeTx([
      { id: 'ok', qty: '100', avgCost: '5' },
      { id: 'cerrado', status: CoilStatus.CLOSED, qty: '100', avgCost: '50' },
      { id: 'anulado', status: CoilStatus.CANCELLED, qty: '100', avgCost: '50' },
      { id: 'tercero', status: CoilStatus.IN_THIRD_PARTY, qty: '100', avgCost: '50' },
      { id: 'otro-ancho', widthMm: '150.00', qty: '100', avgCost: '50' },
      { id: 'otro-espesor', thicknessMm: '0.60', qty: '100', avgCost: '50' },
      { id: 'otro-acabado', finishId: 'fin-2', qty: '100', avgCost: '50' },
    ]);
    const floors = await computePriceFloors(tx, [candidate()], '0.05');
    expect(floors.get('Línea 1')?.costPen).toBe('10.0000');
    // La consulta pide flejes ABIERTOS y de la combinación de la receta: lo mismo que el
    // selector de `/planta`, no una definición paralela.
    expect(coilFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: CoilKind.STRIP,
          status: CoilStatus.OPEN,
          OR: [
            {
              businessLineId: BL,
              finishId: FINISH,
              thicknessMm: '0.45',
              widthMm: '120.00',
            },
          ],
        }) as unknown,
      }),
    );
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

  it('dos perfiles con la misma receta y distinto peso comparten la lectura de flejes', async () => {
    const { tx, coilFindMany } = fakeTx([{ id: 's1', qty: '100', avgCost: '5' }]);
    const floors = await computePriceFloors(
      tx,
      [
        candidate({ at: 'A', cost: recipeCost('2.000') }),
        candidate({ at: 'B', cost: recipeCost('3.000') }),
      ],
      '0.05',
    );
    expect(floors.get('A')?.costPen).toBe('10.0000');
    expect(floors.get('B')?.costPen).toBe('15.0000');
    // Una sola consulta de flejes para todo el lote, no una por perfil.
    expect(coilFindMany).toHaveBeenCalledTimes(1);
  });

  it('sin candidatos STRIP_RECIPE no consulta flejes (las coberturas y el kardex no pagan nada nuevo)', async () => {
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

describe('CatalogService.priceFloor y el marcador «sin piso» (D-342)', () => {
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

  beforeEach(async () => {
    prisma = {
      product: { findUnique: jest.fn() },
      pricingSetting: {
        findMany: jest.fn().mockResolvedValue([
          {
            businessLineId: BL,
            minMarginPct: D('10.0000'),
            businessLine: { code: 'DRYWALL' },
          },
        ]),
      },
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

  it('perfil sin receta: sin piso y dice por qué, sin tocar flejes ni saldos', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow({ bom: null }));
    await expect(service.priceFloor('perfil-1')).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_RECIPE',
    });
    expect(prisma.coil.findMany).not.toHaveBeenCalled();
  });

  it('perfil con receta y peso pero sin flejes con saldo: «Sin costo de flejes»', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    await expect(service.priceFloor('perfil-1')).resolves.toEqual({
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason: 'NO_STRIP_COST',
    });
  });

  it('perfil con receta y flejes con saldo: el piso sale de la receta y no hay motivo', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    prisma.coil.findMany.mockResolvedValue([
      {
        id: 's1',
        businessLineId: BL,
        finishId: FINISH,
        thicknessMm: D('0.45'),
        widthMm: D('120.00'),
      },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([
      { itemId: 's1', qty: D('100'), avgCost: D('5') },
    ]);
    const floor = await service.priceFloor('perfil-1');
    // 2 kg × S/ 5 = 10.00 → ÷ 0.90 × 1.18 = 13.1111, y el mínimo tipeable sube al 13.12 que sí llega al piso (D-163).
    expect(floor).toEqual({ minPricePen: '13.12', priceUnitLabel: 'NIU', noFloorReason: null });
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
