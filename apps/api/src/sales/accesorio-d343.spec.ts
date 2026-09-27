import {
  InventoryItemType,
  InventoryStrategy,
  RoofingProductKind,
  type Prisma,
} from '@prisma/client';
import { Decimal, kgPerMeter, Unit } from '@ayr/shared';
import * as priceFloorModule from './price-floor';
import { orderedMeters, resolveSalesLines, theoreticalKgForMeters } from './sales-lines';

jest.mock('./price-floor', () => ({
  ...jest.requireActual<typeof priceFloorModule>('./price-floor'),
  assertPriceFloor: jest.fn(),
}));
const assertPriceFloorMock = jest.mocked(priceFloorModule.assertPriceFloor);

/**
 * **D-343 — el accesorio (`ACCESORIO`): metros lineales de bobina, sin detalle de largos.**
 *
 * `ACCES030ROJO`: espesor 0.30, color rojo. Se fabrica siempre contra pedido, así que reserva
 * **materia prima** del agregado espesor + color (kilos = metros × kg por metro, con el 1 % de
 * merma de D-165 ya dentro), su piso por metro sale del costo ponderado de ese agregado, y no
 * lleva subítems de largo. Las piezas que el usuario anota son **solo información**.
 */

const DENSITY = '8.0500';
const WIDTH = '1220.00';
const THICKNESS = '0.30';

function decimalOf(value: string): Prisma.Decimal {
  return new Decimal(value);
}

function product(kind: RoofingProductKind = RoofingProductKind.ACCESORIO) {
  const accessory = kind === RoofingProductKind.ACCESORIO;
  return {
    id: 'p-acc',
    sku: accessory ? 'ACCES030ROJO' : 'COB030ROJO',
    name: accessory ? 'Accesorio 0.30 rojo' : 'Cobertura 0.30 roja',
    unit: Unit.MTR,
    isActive: true,
    businessLineId: 'bl-roofing',
    listPricePen: null,
    roofingKind: kind,
    lengthMm: null,
    thicknessMm: decimalOf(THICKNESS),
    widthMm: decimalOf(WIDTH),
    colorId: 'color-rojo',
    color: { name: 'Rojo' },
    finish: { densityFactor: decimalOf(DENSITY) },
    businessLine: { inventoryStrategy: InventoryStrategy.STOCK, code: 'METALLIC_ROOFING' },
    source: 'MANUFACTURED',
    pieceWeightKg: null,
    bom: null,
  };
}

function txWith(p: ReturnType<typeof product>): Prisma.TransactionClient {
  return {
    product: { findMany: jest.fn().mockResolvedValue([p]) },
    rawMaterialSpec: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'spec-1',
        businessLineId: 'bl-roofing',
        colorId: 'color-rojo',
        thicknessMm: decimalOf(THICKNESS),
      }),
    },
  } as unknown as Prisma.TransactionClient;
}

const KG_PER_METER = kgPerMeter({
  widthMm: WIDTH,
  thicknessMm: THICKNESS,
  densityFactor: DENSITY,
});

describe('D-343 — una línea de accesorio', () => {
  beforeEach(() => {
    assertPriceFloorMock.mockReset();
  });

  it('reserva materia prima: kilos = metros × kg por metro, con la merma normal adentro', async () => {
    const [line] = await resolveSalesLines(txWith(product()), [
      { productId: 'p-acc', qty: '25.000', unitPricePen: '10.0000' },
    ]);
    expect(line?.reserveItemType).toBe(InventoryItemType.RAW_MATERIAL);
    expect(line?.reserveItemId).toBe('spec-1');
    expect(line?.reserveUnit).toBe(Unit.KGM);
    // 25 m × kg/m de una bobina de 1 220 mm × 0.30 mm (D-165: el 1 % ya va en `kgPerMeter`).
    expect(line?.reserveQty).toBe(KG_PER_METER.times(25).toFixed(3));
    // La cantidad de la línea son los metros de bobina, tal cual: el accesorio no convierte nada.
    expect(line?.qty).toBe('25.000');
    expect(line?.unit).toBe(Unit.MTR);
    expect(orderedMeters(product(), '25.000')).toBe('25.000');
  });

  it('no lleva detalle de largos: ni lo exige ni lo admite', async () => {
    const tx = txWith(product());
    await expect(
      resolveSalesLines(tx, [{ productId: 'p-acc', qty: '25.000', unitPricePen: '10.0000' }]),
    ).resolves.toHaveLength(1);
    await expect(
      resolveSalesLines(tx, [
        {
          productId: 'p-acc',
          qty: '25.000',
          unitPricePen: '10.0000',
          pieces: [{ lengthMm: '25000', qty: 1 }],
        },
      ]),
    ).rejects.toThrow(/accesorio: no lleva detalle de largos/);
  });

  it('una cobertura a medida sigue exigiendo su detalle de largos (D-131 no se mueve)', async () => {
    await expect(
      resolveSalesLines(txWith(product(RoofingProductKind.A_MEDIDA)), [
        { productId: 'p-acc', qty: '25.000', unitPricePen: '10.0000' },
      ]),
    ).rejects.toThrow(/se vende por metro lineal: detalla/);
  });

  it('la descripción es la que escribe el usuario; sin ella, el nombre del producto', async () => {
    const tx = txWith(product());
    const [typed] = await resolveSalesLines(tx, [
      {
        productId: 'p-acc',
        qty: '25.000',
        unitPricePen: '10.0000',
        description: 'Cumbrera 30 cm, 4 piezas de 6.25 m',
      },
    ]);
    expect(typed?.description).toBe('Cumbrera 30 cm, 4 piezas de 6.25 m');
    const [plain] = await resolveSalesLines(tx, [
      { productId: 'p-acc', qty: '25.000', unitPricePen: '10.0000' },
    ]);
    expect(plain?.description).toBe('Accesorio 0.30 rojo');
  });

  it('su piso es el de una cobertura por metro: costo del agregado × kg por metro, base por metro lineal', async () => {
    await resolveSalesLines(
      txWith(product()),
      [{ productId: 'p-acc', qty: '25.000', unitPricePen: '10.0000' }],
      { priceFloor: { toleranceMm: '0.02' } },
    );
    expect(assertPriceFloorMock).toHaveBeenCalledTimes(1);
    const [, candidates] = assertPriceFloorMock.mock.calls[0] ?? [];
    expect(candidates).toHaveLength(1);
    const c = candidates?.[0];
    expect(c?.basis).toEqual({ kind: 'UNIT', unitLabel: Unit.MTR });
    expect(c?.cost.kind).toBe('RAW_MATERIAL');
    if (c?.cost.kind !== 'RAW_MATERIAL') throw new Error('debe ser materia prima');
    expect(c.cost.spec.thicknessMm).toBe(THICKNESS);
    // El kilo de UN metro: el mismo número que `theoreticalKgForMeters` da para 1 m.
    expect(c.cost.kgPerUnit.toFixed(6)).toBe(
      theoreticalKgForMeters(product(), '1', 'Línea 1').toFixed(6),
    );
  });
});

describe('D-343 — las piezas informativas no entran en ningún cálculo', () => {
  beforeEach(() => {
    assertPriceFloorMock.mockReset();
  });

  const input = (piecesHint?: number) => ({
    productId: 'p-acc',
    qty: '25.000',
    unitPricePen: '10.0000',
    ...(piecesHint === undefined ? {} : { piecesHint }),
  });

  it('cambiar la cantidad de piezas no mueve kilos, importe, reserva ni piso', async () => {
    const results = [] as Awaited<ReturnType<typeof resolveSalesLines>>[number][];
    const floors: unknown[] = [];
    for (const hint of [undefined, 1, 4, 10, 500, 999_999]) {
      assertPriceFloorMock.mockReset();
      const [line] = await resolveSalesLines(txWith(product()), [input(hint)], {
        priceFloor: { toleranceMm: '0.02' },
      });
      if (!line) throw new Error('debe haber una línea');
      results.push(line);
      floors.push(assertPriceFloorMock.mock.calls[0]?.[1]);
    }
    const [base, ...rest] = results;
    if (!base) throw new Error('sin resultados');
    for (const other of rest) {
      // Todo lo que calcula la línea es idéntico; lo único distinto es el propio campo.
      const { piecesHint: _a, ...baseRest } = base;
      const { piecesHint: _b, ...otherRest } = other;
      expect(otherRest).toEqual(baseRest);
      // En particular, los cinco números que el dueño nombró:
      expect(other.reserveQty).toBe(base.reserveQty); // kilos (y reserva)
      expect(other.subtotalPen).toBe(base.subtotalPen); // importe
      expect(other.igvPen).toBe(base.igvPen);
      expect(other.totalPen).toBe(base.totalPen);
      expect(other.unitPricePen).toBe(base.unitPricePen);
      expect(other.reserveItemId).toBe(base.reserveItemId);
    }
    // El piso: los candidatos que llegan a `assertPriceFloor` son iguales con cualquier valor.
    const [firstFloor, ...otherFloors] = floors;
    for (const f of otherFloors) expect(JSON.stringify(f)).toBe(JSON.stringify(firstFloor));
    // Y el campo, sí, viaja tal cual (o null si no se dio).
    expect(results.map((r) => r.piecesHint)).toEqual([null, 1, 4, 10, 500, 999_999]);
  });

  it('solo un accesorio las lleva: en cualquier otro producto es un 400', async () => {
    await expect(
      resolveSalesLines(txWith(product(RoofingProductKind.A_MEDIDA)), [
        {
          productId: 'p-acc',
          qty: '25.000',
          unitPricePen: '10.0000',
          piecesHint: 4,
          pieces: [{ lengthMm: '25000', qty: 1 }],
        },
      ]),
    ).rejects.toThrow(/no es un accesorio/);
  });
});
