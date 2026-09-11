import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  fixedLengthUnitValue,
  minAllowedPrice,
  minAllowedValue,
  money,
  saleValueFromPrice,
  toFixedString,
} from '@ayr/shared';
import { assertPriceFloor, computePriceFloors, type PriceFloorCandidate } from './price-floor';

/**
 * El piso duro de precio (D-163). El costo sale del kardex y el margen mínimo de
 * `pricing_settings`; lo que se comprueba acá es la regla, no las consultas.
 */

const BL = 'bl-1';
const PRODUCT = 'p-1';
const SPEC = { id: 'spec-1', businessLineId: BL, colorId: 'c-1', thicknessMm: '0.45' };

/** El costo promedio del SKU en el ejemplo: S/ 17.50 por plancha. */
const COST = '17.5000';
/** Margen mínimo del 10%: piso = 17.50 ÷ 0.90 = 19.4444 sin IGV, 22.9444 con IGV. */
const MIN_MARGIN = '10.0000';

function fakeTx(options: {
  minMarginPct?: string | null;
  productCost?: string;
  coils?: { id: string; qty: string; avgCost: string }[];
}) {
  const balances = [
    ...(options.productCost === undefined
      ? []
      : [
          {
            itemId: PRODUCT,
            qty: new Prisma.Decimal('10'),
            avgCost: new Prisma.Decimal(options.productCost),
          },
        ]),
    ...(options.coils ?? []).map((c) => ({
      itemId: c.id,
      qty: new Prisma.Decimal(c.qty),
      avgCost: new Prisma.Decimal(c.avgCost),
    })),
  ];
  return {
    pricingSetting: {
      findMany: jest.fn().mockResolvedValue(
        options.minMarginPct === null
          ? []
          : [
              {
                businessLineId: BL,
                minMarginPct: new Prisma.Decimal(options.minMarginPct ?? MIN_MARGIN),
                businessLine: { code: 'DRYWALL' },
              },
            ],
      ),
    },
    inventoryBalance: {
      findMany: jest.fn().mockImplementation((args: { where: { itemId: { in: string[] } } }) => {
        const ids = new Set(args.where.itemId.in);
        return Promise.resolve(balances.filter((b) => ids.has(b.itemId)));
      }),
    },
    coil: {
      findMany: jest.fn().mockResolvedValue((options.coils ?? []).map((c) => ({ id: c.id }))),
    },
  } as unknown as Prisma.TransactionClient;
}

function candidate(unitValuePen: string, over: Partial<PriceFloorCandidate> = {}) {
  return {
    at: 'Línea 1',
    sku: 'TR-CAL-3.6',
    businessLineId: BL,
    basis: { kind: 'UNIT' as const, unitLabel: 'NIU' },
    unitValuePen,
    cost: { kind: 'PRODUCT' as const, productId: PRODUCT },
    ...over,
  } satisfies PriceFloorCandidate;
}

describe('assertPriceFloor (D-163)', () => {
  it('exactamente en el mínimo pasa', async () => {
    const tx = fakeTx({ productCost: COST });
    const min = minAllowedValue(COST, MIN_MARGIN);
    expect(min).toBe('19.4444');
    await expect(assertPriceFloor(tx, [candidate(min)], '0.05')).resolves.toBeUndefined();
  });

  it('un céntimo abajo bloquea', async () => {
    const tx = fakeTx({ productCost: COST });
    // Un céntimo del **precio** con IGV: 22.9444 − 0.01 = 22.9344, que en valor es 19.4359.
    const belowPrice = new Decimal(minAllowedPrice(COST, MIN_MARGIN)).minus('0.01');
    const belowValue = saleValueFromPrice(belowPrice).toDecimalPlaces(4).toFixed(4);
    await expect(assertPriceFloor(tx, [candidate(belowValue)], '0.05')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('el mensaje dice el mínimo con IGV, el costo y el margen', async () => {
    const tx = fakeTx({ productCost: COST });
    await expect(assertPriceFloor(tx, [candidate('1.0000')], '0.05')).rejects.toThrow(
      /precio mínimo es S\/ 22\.95 por NIU.*costo promedio S\/ 17\.50.*margen mínimo 10\.00%/s,
    );
  });

  /**
   * **El caso que la revisión encontró y que este archivo no cazaba.**
   *
   * El mínimo que se muestra tiene dos decimales —es lo que una persona tipea— y el piso vive
   * con cuatro. Recortándolo hacia abajo, tipear exactamente el número de la pantalla daba un
   * valor por debajo del piso y el sistema respondía «sube el precio» sobre el precio que él
   * mismo acababa de pedir. Medido: pasaba en cerca de la mitad de las combinaciones.
   *
   * El test anterior no lo cazaba porque partía del precio con **cuatro** decimales, que es lo
   * que ningún vendedor tipea.
   */
  describe('el mínimo que se muestra es tipeable (D-163)', () => {
    const combos = [
      { cost: '17.5000', margin: '10.0000' },
      { cost: '23.4500', margin: '15.0000' },
      { cost: '4.2000', margin: '10.0000' },
      { cost: '0.3300', margin: '33.3300' },
      { cost: '199.9900', margin: '7.5000' },
    ];

    it.each(combos)('costo $cost, margen $margin: tipear el mínimo mostrado pasa', async (c) => {
      const tx = fakeTx({ productCost: c.cost, minMarginPct: c.margin });
      const floor = (await computePriceFloors(tx, [candidate('0.0000')], '0.05')).get('Línea 1');
      if (floor === undefined) throw new Error('sin piso');
      // Dos decimales: si tuviera más, no sería un precio que alguien pueda tipear.
      expect(floor.minPricePen).toMatch(/^\d+\.\d{2}$/);
      // Y la cadena de vuelta —dividir por 1.18 y redondear— tiene que seguir alcanzando.
      const typed = toFixedString(money(saleValueFromPrice(floor.minPricePen)), 'MONEY');
      await expect(
        assertPriceFloor(
          fakeTx({ productCost: c.cost, minMarginPct: c.margin }),
          [candidate(typed)],
          '0.05',
        ),
      ).resolves.toBeUndefined();
    });

    it('un céntimo por debajo del mínimo mostrado sí bloquea', async () => {
      const tx = fakeTx({ productCost: COST });
      const floor = (await computePriceFloors(tx, [candidate('0.0000')], '0.05')).get('Línea 1');
      if (floor === undefined) throw new Error('sin piso');
      const typed = toFixedString(
        money(saleValueFromPrice(new Decimal(floor.minPricePen).minus('0.01'))),
        'MONEY',
      );
      await expect(
        assertPriceFloor(fakeTx({ productCost: COST }), [candidate(typed)], '0.05'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('en una plancha el mínimo se muestra y se rechaza POR METRO, no por plancha', async () => {
      // D-161: el vendedor tipea por metro. Mostrarle el mínimo por plancha era reintroducir
      // en el cartel de error el mismo factor ×largo que D-161 vino a corregir.
      const basis = { kind: 'PER_METER' as const, lengthMm: '3600.00' };
      const floor = (
        await computePriceFloors(
          fakeTx({ productCost: COST }),
          [candidate('0.0000', { basis })],
          '0.05',
        )
      ).get('Línea 1');
      if (floor === undefined) throw new Error('sin piso');
      expect(floor.priceUnitLabel).toBe('metro');
      // El piso por plancha es 19.4444; repartido en 3.60 m son ~6.38 el metro con IGV.
      expect(floor.minValuePen).toBe('19.4444');
      expect(Number(floor.minPricePen)).toBeCloseTo(6.38, 2);
      // Y tipear ese mínimo por metro alcanza el piso por plancha: es la cadena completa.
      const valuePerMeter = toFixedString(money(saleValueFromPrice(floor.minPricePen)), 'MONEY');
      const unitValue = toFixedString(
        money(fixedLengthUnitValue('3600.00', valuePerMeter)),
        'MONEY',
      );
      await expect(
        assertPriceFloor(fakeTx({ productCost: COST }), [candidate(unitValue, { basis })], '0.05'),
      ).resolves.toBeUndefined();
    });
  });

  it('el redondeo con residuo no corre el piso: precio 10.00 → valor 8.4746', async () => {
    // El caso del enunciado. 10 ÷ 1.18 = 8.474576…, que a la escala de dinero es 8.4746.
    expect(saleValueFromPrice('10.00').toDecimalPlaces(4).toFixed(4)).toBe('8.4746');
    // Con un costo de 7.6271 y un 10%, el piso en valor es 8.4746 clavado: tipear S/ 10.00
    // tiene que pasar, y es justo el caso que rebotaba comparando precios en vez de valores.
    const tx = fakeTx({ productCost: '7.6271' });
    expect(minAllowedValue('7.6271', MIN_MARGIN)).toBe('8.4746');
    await expect(assertPriceFloor(tx, [candidate('8.4746')], '0.05')).resolves.toBeUndefined();
    await expect(assertPriceFloor(tx, [candidate('8.4745')], '0.05')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sin costo en el kardex no hay piso: un SKU nuevo se puede cotizar', async () => {
    const tx = fakeTx({});
    await expect(assertPriceFloor(tx, [candidate('0.0100')], '0.05')).resolves.toBeUndefined();
  });

  it('sin márgenes configurados para la línea de negocio tampoco hay piso', async () => {
    const tx = fakeTx({ minMarginPct: null, productCost: COST });
    await expect(assertPriceFloor(tx, [candidate('0.0100')], '0.05')).resolves.toBeUndefined();
  });

  it('un margen mínimo de 100% rebota con un mensaje legible, no con un 500', async () => {
    const tx = fakeTx({ minMarginPct: '100.0000', productCost: COST });
    await expect(assertPriceFloor(tx, [candidate('50.0000')], '0.05')).rejects.toThrow(
      /Administración → Márgenes y tipo de cambio/,
    );
  });

  it('el bloqueo no distingue rol: el piso lo comprueba la línea, no quién la escribe', () => {
    // `assertPriceFloor` no recibe actor **a propósito** (D-163 cierra la excepción de
    // ADMINISTRADOR que D-032 dejaba abierta). Se comprueba contra el **texto de la función**
    // y no contra `Function.length`, que no cuenta los parámetros opcionales ni los que tienen
    // valor por defecto: agregar `actor?: RequestUser` habría dejado verde ese centinela.
    expect(assertPriceFloor.toString()).not.toMatch(/actor|role|Role/);
  });

  it('una cobertura a medida usa el costo por metro de la bobina, ponderado por kilos', async () => {
    // Dos bobinas: 900 kg a S/ 4.00 y 100 kg a S/ 8.00 → promedio ponderado S/ 4.40 por kg.
    // El promedio simple habría dado 6.00 y un piso un 36% más alto.
    const tx = fakeTx({
      coils: [
        { id: 'coil-a', qty: '900', avgCost: '4.0000' },
        { id: 'coil-b', qty: '100', avgCost: '8.0000' },
      ],
    });
    const floors = await computePriceFloors(
      tx,
      [
        candidate('0.0000', {
          basis: { kind: 'UNIT', unitLabel: 'MTR' },
          cost: { kind: 'RAW_MATERIAL', spec: SPEC, kgPerUnit: new Decimal('3.5325') },
        }),
      ],
      '0.05',
    );
    const floor = floors.get('Línea 1');
    // 4.40 × 3.5325 = 15.5430 de costo por metro; ÷ 0.90 = 17.2700 de valor mínimo.
    expect(floor?.costPen).toBe('15.5430');
    expect(floor?.minValuePen).toBe('17.2700');
  });

  it('un agregado sin bobinas no tiene costo y por lo tanto no tiene piso', async () => {
    const tx = fakeTx({ coils: [] });
    const floors = await computePriceFloors(
      tx,
      [
        candidate('0.0000', {
          cost: { kind: 'RAW_MATERIAL', spec: SPEC, kgPerUnit: new Decimal('3.5325') },
        }),
      ],
      '0.05',
    );
    expect(floors.get('Línea 1')).toBeUndefined();
  });
});
