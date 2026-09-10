import { InventoryStrategy, type Prisma } from '@prisma/client';
import {
  IMPORT_ROUNDING_TOLERANCE_PEN,
  importRoundingTolerance,
  roundingAdjustment,
  salesLineTotals,
  Unit,
} from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

/**
 * **D-169 — el importe de un comprobante importado es el del papel.**
 *
 * El defecto no era un error de cuenta: la cuenta estaba bien. Es que había **dos** números
 * para el mismo hecho y el ERP se quedaba con el derivado. El archivo trae `VALOR DE VENTA`
 * por línea; el importador deriva el unitario dividiéndolo entre la cantidad y lo redondea a
 * cuatro decimales (que es la escala de dinero, D-003); volver a multiplicar por la cantidad
 * no devuelve el importe. La diferencia es de a lo sumo `cantidad × 0.00005`, o sea invisible
 * en una línea de tres unidades y de más de diez céntimos en una de miles de kilos — que es
 * como se vende el acero.
 *
 * Los casos de abajo son la aritmética exacta, escrita con los números que la producen, para
 * que se vea de dónde sale cada céntimo.
 */

function txWith(unit: string = Unit.KGM): Prisma.TransactionClient {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-1',
          sku: 'BOBGALV0.50',
          name: 'Bobina galvanizada 0.50 mm',
          unit,
          isActive: true,
          businessLineId: 'bl-1',
          listPricePen: null,
          roofingKind: null,
          lengthMm: null,
          thicknessMm: null,
          widthMm: null,
          colorId: null,
          color: null,
          finish: null,
          businessLine: { inventoryStrategy: InventoryStrategy.STOCK },
        },
      ]),
    },
  } as unknown as Prisma.TransactionClient;
}

const EXACT = { tolerancePen: IMPORT_ROUNDING_TOLERANCE_PEN, documentLabel: 'F001-1349' };

describe('D-169 — el importe del archivo se copia, no se recalcula', () => {
  it('el redondeo del unitario existe y es de a cuatro decimales', () => {
    // El caso más chico que se separa: S/ 100.00 entre 3 no cabe en cuatro decimales.
    // 100 ÷ 3 = 33.333333… → 33.3333 → × 3 = 99.9999. Un diezmilésimo de sol, pero es real.
    expect(salesLineTotals({ qty: '3.000', unitPricePen: '33.3333' }).subtotal.toFixed(4)).toBe(
      '99.9999',
    );
    expect(
      roundingAdjustment({
        qty: '3.000',
        unitPricePen: '33.3333',
        subtotalPen: '100.0000',
      }).toFixed(4),
    ).toBe('0.0001');
  });

  it('la diferencia crece con la cantidad: una línea de miles de kilos se va céntimos', () => {
    // 4 375.13 ÷ 1 250 = 3.500104 → 3.5001 → × 1 250 = 4 375.125. Medio céntimo.
    expect(
      roundingAdjustment({
        qty: '1250.000',
        unitPricePen: '3.5001',
        subtotalPen: '4375.1300',
      }).toFixed(4),
    ).toBe('0.0050');
    // 87 500.35 ÷ 25 000 = 3.500014 → 3.5000 → × 25 000 = 87 500. Treinta y cinco céntimos,
    // y **sigue siendo redondeo**: es el tamaño de línea del cliente.
    expect(
      roundingAdjustment({
        qty: '25000.000',
        unitPricePen: '3.5000',
        subtotalPen: '87500.3500',
      }).toFixed(4),
    ).toBe('0.3500');
  });

  /**
   * **La tolerancia no puede ser un número fijo**, y este es el bloque que lo fija.
   *
   * Con el techo plano de S/ 0.10 que se escribió primero, toda línea de más de dos mil kilos
   * se caía acusando al archivo de un desvío que el ERP había producido al dividir. La cota
   * correcta es la que el redondeo **puede** explicar: `Σ (cantidad + 1) × 0.00005`, con el
   * colchón del dueño de piso.
   */
  describe('la tolerancia escala con la cantidad', () => {
    it('en un documento chico el piso es el colchón del dueño', () => {
      expect(importRoundingTolerance(['3.000', '10.000']).toFixed(2)).toBe('0.10');
    });

    it('una línea de 2 500 kg sube la cota por encima del colchón', () => {
      // (2500 + 1) × 0.00005 = 0.12505 → S/ 0.1251, más que los diez céntimos del piso.
      expect(importRoundingTolerance(['2500.000']).toFixed(4)).toBe('0.1251');
    });

    it('el desvío real de una línea de 2 500 kg cabe en su propia cota', async () => {
      // 8 750.13 ÷ 2 500 = 3.500052 → 3.5001 → × 2 500 = 8 750.25. Doce céntimos de redondeo
      // puro: con el techo plano, este documento —normal— no entraba.
      const adjustment = roundingAdjustment({
        qty: '2500.000',
        unitPricePen: '3.5001',
        subtotalPen: '8750.1300',
      });
      expect(adjustment.toFixed(4)).toBe('-0.1200');
      expect(adjustment.abs().lte(importRoundingTolerance(['2500.000']))).toBe(true);

      const [line] = await resolveSalesLines(
        txWith(),
        [{ productId: 'p-1', qty: '2500.000', unitPricePen: '3.5001', netAmountPen: '8750.1300' }],
        { exactAmounts: EXACT },
      );
      expect(line?.subtotalPen).toBe('8750.1300');
    });
  });

  it('la línea importada persiste el importe del archivo y el IGV sale de ahí', async () => {
    const [line] = await resolveSalesLines(
      txWith(),
      [{ productId: 'p-1', qty: '3.000', unitPricePen: '33.3333', netAmountPen: '100.0000' }],
      { exactAmounts: EXACT },
    );

    expect(line?.subtotalPen).toBe('100.0000');
    expect(line?.igvPen).toBe('18.0000');
    expect(line?.totalPen).toBe('118.0000');
    // El unitario **no** se toca: es lo que el comprobante electrónico declara como
    // `valorUnitario`, y reescribirlo para que la multiplicación cerrara habría cambiado el
    // otro número del papel para salvar este.
    expect(line?.unitPricePen).toBe('33.3333');
  });

  it('sin importe del archivo, la línea se calcula como siempre', async () => {
    const [line] = await resolveSalesLines(
      txWith(),
      [{ productId: 'p-1', qty: '3.000', unitPricePen: '33.3333' }],
      { exactAmounts: EXACT },
    );

    // La misma opción puesta: lo que decide es que **esta fila** no trajo importe, porque
    // alguien le editó la cantidad o el precio en el preview.
    expect(line?.subtotalPen).toBe('99.9999');
  });

  it('un documento de varias líneas se aguanta unos céntimos y los suma', async () => {
    const lines = await resolveSalesLines(
      txWith(),
      [
        { productId: 'p-1', qty: '1250.000', unitPricePen: '3.5001', netAmountPen: '4375.1300' },
        { productId: 'p-1', qty: '3.000', unitPricePen: '33.3333', netAmountPen: '100.0000' },
        { productId: 'p-1', qty: '820.500', unitPricePen: '2.7418', netAmountPen: '2249.6600' },
      ],
      { exactAmounts: EXACT },
    );

    expect(lines.map((l) => l.subtotalPen)).toEqual(['4375.1300', '100.0000', '2249.6600']);
  });

  it('por encima de la tolerancia rechaza, y nombra el documento y la peor línea', async () => {
    await expect(
      resolveSalesLines(
        txWith(),
        [
          { productId: 'p-1', qty: '3.000', unitPricePen: '33.3333', netAmountPen: '100.0000' },
          // La columna equivocada: el archivo trae el precio CON IGV donde va el valor.
          { productId: 'p-1', qty: '10.000', unitPricePen: '100.0000', netAmountPen: '1180.0000' },
        ],
        { exactAmounts: EXACT },
      ),
    ).rejects.toThrow(/F001-1349/);

    await expect(
      resolveSalesLines(
        txWith(),
        [{ productId: 'p-1', qty: '10.000', unitPricePen: '100.0000', netAmountPen: '1180.0000' }],
        { exactAmounts: EXACT },
      ),
      // El mensaje tiene que traer las dos cifras: la corrección es del archivo, y quien lo
      // abre necesita saber qué celda mirar.
    ).rejects.toThrow(/1180\.00.*1000\.00|1000\.00.*1180\.00/s);
  });

  it('la tolerancia se mide sobre valores absolutos: dos desvíos opuestos no se cancelan', async () => {
    // +S/ 40 y −S/ 40 dan un neto de cero y son justo el archivo que hay que rechazar.
    await expect(
      resolveSalesLines(
        txWith(),
        [
          { productId: 'p-1', qty: '10.000', unitPricePen: '10.0000', netAmountPen: '140.0000' },
          { productId: 'p-1', qty: '10.000', unitPricePen: '10.0000', netAmountPen: '60.0000' },
        ],
        { exactAmounts: EXACT },
      ),
    ).rejects.toThrow(/se separan S\/ 80\.00/);
  });

  it('fuera del importador, mandar el importe exacto es un 400', async () => {
    // La cotización manual y el pedido directo no pasan la opción: sin este corte, cualquier
    // cliente HTTP podría fijar el importe de una línea a mano y el precio unitario quedaría
    // de adorno.
    await expect(
      resolveSalesLines(txWith(), [
        { productId: 'p-1', qty: '3.000', unitPricePen: '33.3333', netAmountPen: '999.0000' },
      ]),
    ).rejects.toThrow(/solo lo trae el importador/);
  });
});
