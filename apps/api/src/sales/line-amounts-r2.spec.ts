import { InventoryStrategy, type Prisma } from '@prisma/client';
import { derivedUnitValue, lineAmounts, toDecimal, Unit } from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

/**
 * **RF-S4b/M2 — R2: el importe de la línea es el dato guardado (D-255).**
 *
 * Se puede cargar el precio con IGV, el valor sin IGV o el importe de la línea; lo demás se
 * deriva con diez decimales (lo que acepta `valor_unitario` en Nubefact). Los cuatro
 * decimales guardados del unitario son solo para mostrar y **nunca** se recalcula desde
 * ellos. Los números son los de los comprobantes reales de agosto de 2026.
 */

function txWith(unit: string): Prisma.TransactionClient {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-1',
          sku: 'COB040BLANCO',
          name: 'Cobertura aluzinc 0.40 blanco',
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

describe('R2 — lineAmounts: el importe manda y el unitario se deriva', () => {
  it('FFA1-1350: 3.5 con IGV × 4194 kg → 12439.83 / 2239.17 / 14679.00', () => {
    const a = lineAmounts('4194.000', { unitPriceWithIgvPen: '3.5000' });
    expect(a.total.toFixed(2)).toBe('14679.00');
    expect(a.subtotal.toFixed(2)).toBe('12439.83');
    expect(a.igv.toFixed(2)).toBe('2239.17');
    // El total es exacto: 3.5 × 4194 no tiene cola, y recalcularlo desde el valor redondeado
    // (2.9661) daba 14678.99 — el síntoma de COT-000002.
    expect(a.total.toFixed(4)).toBe('14679.0000');
  });

  it('FFA1-1355: 3840 kg por 11715.254 → el importe se guarda tal cual', () => {
    const a = lineAmounts('3840.000', { netAmountPen: '11715.254' });
    expect(a.subtotal.toFixed(4)).toBe('11715.2540');
    expect(a.total.toFixed(2)).toBe('13824.00');
    // Ningún unitario de cuatro decimales lo reproduce; el de diez sí, al céntimo.
    expect(a.unitValue.decimalPlaces()).toBeLessThanOrEqual(10);
    expect(a.unitValue.times('3840').toFixed(4)).toBe('11715.2540');
  });

  it('FFA1-1405: 586.2 m por 7203.305 → el importe se guarda tal cual', () => {
    const a = lineAmounts('586.200', { netAmountPen: '7203.305' });
    expect(a.subtotal.toFixed(4)).toBe('7203.3050');
    expect(a.unitValue.times('586.2').toFixed(4)).toBe('7203.3050');
    // Con el unitario de cuatro decimales (12.2881) se iba −0.0208.
    expect(toDecimal('12.2881').times('586.2').minus('7203.305').toFixed(4)).toBe('-0.0208');
  });

  it('el valor sin IGV sigue funcionando como antes', () => {
    const a = lineAmounts('3.000', { unitValuePen: '33.3333' });
    expect(a.subtotal.toFixed(4)).toBe('99.9999');
  });

  it('el unitario derivado sale del importe, con diez decimales', () => {
    expect(derivedUnitValue('3840.000', '11715.2540').toFixed(10)).toBe('3.0508473958');
  });
});

describe('R2 — resolveSalesLines acepta las tres formas fuera del importador', () => {
  it('con precio con IGV guarda el importe exacto y muestra el unitario a cuatro decimales', async () => {
    const [line] = await resolveSalesLines(txWith(Unit.KGM), [
      { productId: 'p-1', qty: '4194.000', unitPriceWithIgvPen: '3.5000' },
    ]);
    expect(line?.totalPen).toBe('14679.0000');
    expect(line?.subtotalPen).toBe('12439.8305');
    expect(line?.igvPen).toBe('2239.1695');
    expect(line?.unitPricePen).toBe('2.9661');
  });

  it('con el importe de línea, sin ser el importador, ya no es un 400', async () => {
    const [line] = await resolveSalesLines(txWith(Unit.MTR), [
      {
        productId: 'p-1',
        qty: '586.200',
        netAmountPen: '7203.305',
        pieces: [{ lengthMm: '5862.00', qty: 100 }],
      },
    ]);
    expect(line?.subtotalPen).toBe('7203.3050');
    expect(line?.unitPricePen).toBe('12.2881');
  });
});
