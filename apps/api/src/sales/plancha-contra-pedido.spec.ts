import {
  InventoryItemType,
  InventoryStrategy,
  RoofingProductKind,
  type Prisma,
} from '@prisma/client';
import { Decimal, kgPerMeter, Unit } from '@ayr/shared';
import { isMadeToOrder, orderedMeters, resolveSalesLines } from './sales-lines';

/**
 * **D-171 — la plancha de catálogo se produce contra el pedido.**
 *
 * Hasta acá una plancha reservaba **producto terminado** y el pedido exigía tenerlas en el
 * almacén: «0.000 NIU disponibles… necesita 10» sobre un producto que nunca vive en el
 * almacén, porque se rola contra el pedido igual que una cobertura a medida. D-171 mueve la
 * rama de la reserva a materia prima y deja la forma de la línea donde estaba: la plancha se
 * sigue contando en planchas y cotizando por metro contra el largo del SKU (D-161).
 *
 * La conversión que hace que las dos formas prometan con la misma aritmética es
 * `orderedMeters`: en una plancha, `cantidad × largo del SKU`.
 */

const DENSITY = '8.0500';
const WIDTH = '1000.00';
const THICKNESS = '0.45';
/** 6 m, el largo real de `PL045ROJO` en el catálogo del dueño. */
const LENGTH_MM = '6000.00';

/**
 * El `Decimal` de `@ayr/shared` **es** el de Prisma: la misma clase, reexportada. Por eso no
 * hace falta ningún `as` — el fixture puede construir los decimales del producto igual que los
 * construye Prisma al leerlos de la base.
 */
function decimalOf(value: string): Prisma.Decimal {
  return new Decimal(value);
}

function roofingProduct(kind: RoofingProductKind) {
  return {
    id: 'p-1',
    sku: kind === RoofingProductKind.PLANCHA ? 'PL045ROJO' : 'COB045ROJO',
    name: 'Cobertura 0.45 roja',
    unit: kind === RoofingProductKind.PLANCHA ? Unit.NIU : Unit.MTR,
    isActive: true,
    businessLineId: 'bl-roofing',
    listPricePen: null,
    roofingKind: kind,
    lengthMm: kind === RoofingProductKind.PLANCHA ? decimalOf(LENGTH_MM) : null,
    thicknessMm: decimalOf(THICKNESS),
    widthMm: decimalOf(WIDTH),
    colorId: 'color-rojo',
    color: { name: 'Rojo' },
    finish: { densityFactor: decimalOf(DENSITY) },
    businessLine: { inventoryStrategy: InventoryStrategy.STOCK },
  };
}

/**
 * `tx` mínimo: la consulta de productos y la resolución del agregado de materia prima, que
 * `resolveSalesLines` hace **antes** del `.map` porque crear la spec es asíncrono.
 */
function txWith(product: ReturnType<typeof roofingProduct>): Prisma.TransactionClient {
  return {
    product: { findMany: jest.fn().mockResolvedValue([product]) },
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

describe('D-171 — la plancha promete materia prima, no stock terminado', () => {
  describe('orderedMeters', () => {
    const plancha = {
      roofingKind: RoofingProductKind.PLANCHA,
      unit: Unit.NIU,
      lengthMm: decimalOf(LENGTH_MM),
    };

    it('una plancha convierte su cantidad a metros con el largo del SKU', () => {
      // 10 planchas de 6 m son 60 metros lineales de bobina.
      expect(orderedMeters(plancha, '10.000')).toBe('60.000');
    });

    it('una cobertura a medida ya viene en metros y no se convierte', () => {
      // El detalle de largos suma exactamente la cantidad (D-083): multiplicar otra vez la
      // contaría dos veces, que es el error que separa las dos ramas.
      expect(
        orderedMeters(
          { roofingKind: RoofingProductKind.A_MEDIDA, unit: Unit.MTR, lengthMm: null },
          '81.900',
        ),
      ).toBe('81.900');
    });

    /**
     * **El defecto que la revisión encontró en la primera versión de D-171.** La rama se
     * decidía por la unidad («si no es `MTR`, la cantidad son piezas»), y el `CHECK` de la base
     * es más laxo que la app: admite una `PLANCHA` en `KGM` —hay SKU legados— y una sin largo.
     * En las dos, la cantidad no son planchas de un largo conocido.
     */
    it('un SKU legado en KGM no convierte kilos en metros', () => {
      // Mil kilos leídos como mil planchas de 6 m daban 6 000 m y una reserva de catorce
      // toneladas de bobina por una venta de una.
      expect(orderedMeters({ ...plancha, unit: Unit.KGM }, '1000.000')).toBe('1000.000');
    });

    it('una plancha sin largo tampoco convierte nada', () => {
      expect(orderedMeters({ ...plancha, lengthMm: null }, '10.000')).toBe('10.000');
    });
  });

  /**
   * La otra mitad del mismo defecto: esas dos formas **no se producen**, se siguen atendiendo
   * con saldo de producto terminado exactamente como antes de D-171. Que `orderedMeters`
   * devuelva la cantidad sin tocar es el cinturón; el corte real es este.
   */
  describe('isMadeToOrder', () => {
    it('la plancha con largo usable se produce', () => {
      expect(
        isMadeToOrder({
          roofingKind: RoofingProductKind.PLANCHA,
          unit: Unit.NIU,
          lengthMm: decimalOf(LENGTH_MM),
        }),
      ).toBe(true);
    });

    it('la cobertura a medida se produce, en la unidad que sea', () => {
      for (const unit of [Unit.MTR, Unit.KGM]) {
        expect(
          isMadeToOrder({ roofingKind: RoofingProductKind.A_MEDIDA, unit, lengthMm: null }),
        ).toBe(true);
      }
    });

    it('una plancha en KGM o sin largo NO se produce: sale de stock, como antes de D-171', () => {
      expect(
        isMadeToOrder({
          roofingKind: RoofingProductKind.PLANCHA,
          unit: Unit.KGM,
          lengthMm: decimalOf(LENGTH_MM),
        }),
      ).toBe(false);
      expect(
        isMadeToOrder({
          roofingKind: RoofingProductKind.PLANCHA,
          unit: Unit.NIU,
          lengthMm: null,
        }),
      ).toBe(false);
    });

    it('fuera de coberturas nada se produce en la roladora', () => {
      expect(
        isMadeToOrder({ roofingKind: null, unit: Unit.NIU, lengthMm: decimalOf(LENGTH_MM) }),
      ).toBe(false);
    });
  });

  it('la línea de plancha reserva kilos del agregado, no unidades del producto', async () => {
    const product = roofingProduct(RoofingProductKind.PLANCHA);
    const [line] = await resolveSalesLines(txWith(product), [
      { productId: 'p-1', qty: '10.000', valuePerMeterPen: '9.3220' },
    ]);

    expect(line?.reserveItemType).toBe(InventoryItemType.RAW_MATERIAL);
    expect(line?.reserveItemId).toBe('spec-1');
    expect(line?.reserveUnit).toBe(Unit.KGM);

    // 10 planchas × 6 m = 60 m; cada metro pesa `ancho × espesor × densidad`. El 1 % de merma
    // normal ya vive dentro de la densidad estándar desde D-165: **no** se suma aparte.
    const perMeter = kgPerMeter({
      widthMm: WIDTH,
      thicknessMm: THICKNESS,
      densityFactor: DENSITY,
    });
    expect(line?.reserveQty).toBe(perMeter.times(60).toFixed(3));
  });

  it('la cantidad y la unidad de venta no cambian: se sigue facturando en planchas', async () => {
    const product = roofingProduct(RoofingProductKind.PLANCHA);
    const [line] = await resolveSalesLines(txWith(product), [
      { productId: 'p-1', qty: '10.000', valuePerMeterPen: '9.3220' },
    ]);

    expect(line?.qty).toBe('10.000');
    expect(line?.unit).toBe(Unit.NIU);
    // D-161 intacto: el unitario sale de `largo × valor por metro` = 6 × 9.3220.
    expect(line?.unitPricePen).toBe('55.9320');
    expect(line?.valuePerMeterPen).toBe('9.3220');
    expect(line?.subtotalPen).toBe('559.3200');
  });

  it('una plancha no lleva detalle de largos: su largo lo pone el SKU', async () => {
    const product = roofingProduct(RoofingProductKind.PLANCHA);
    const [line] = await resolveSalesLines(txWith(product), [
      { productId: 'p-1', qty: '10.000', valuePerMeterPen: '9.3220' },
    ]);
    expect(line?.pieces).toEqual([]);
  });

  it('la cobertura a medida sigue exactamente igual', async () => {
    const product = roofingProduct(RoofingProductKind.A_MEDIDA);
    const [line] = await resolveSalesLines(txWith(product), [
      {
        productId: 'p-1',
        qty: '12.000',
        unitPricePen: '20.0000',
        pieces: [{ lengthMm: '6000.00', qty: 2 }],
      },
    ]);

    expect(line?.reserveItemType).toBe(InventoryItemType.RAW_MATERIAL);
    const perMeter = kgPerMeter({
      widthMm: WIDTH,
      thicknessMm: THICKNESS,
      densityFactor: DENSITY,
    });
    // Sus metros son su cantidad: 12, no 12 × ningún largo.
    expect(line?.reserveQty).toBe(perMeter.times(12).toFixed(3));
    expect(line?.pieces).toHaveLength(1);
  });
});
